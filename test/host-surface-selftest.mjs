/**
 * 宿主面自测（不需要真的宿主）：node test/host-surface-selftest.mjs
 *
 * 用一个假的 ctx（tools.register / commands.register / on）把 session 与 checkpoint 两段
 * apply() 跑一遍，断言：
 *   - 注册的工具/命令/钩子清单与预期一致（不多不少）
 *   - fs 写意图钩子是"直通"语义：next() 必须被调用，且留底不抛
 *   - 通过注册得到的 checkpoint 工具对象能真的执行（create → diff → restore 预览）
 *   - 信标写出的行包含各段 ok
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const sandbox = join(process.env.DSH_TOOLKIT_TEST_DIR ?? join(tmpdir(), 'dsh-toolkit-selftest'), '_toolkit-host-surface')
process.env.DSH_TOOLKIT_CHECKPOINTS = sandbox.replace(/\\/g, '/')
process.env.DSH_SESSION_ID = 'selftest'

const session = await import('../lib/session/index.js')
const checkpoint = await import('../lib/checkpoint/index.js')

if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
const WS = join(sandbox, 'ws')
mkdirSync(join(WS, 'sub'), { recursive: true })
writeFileSync(join(WS, 'a.txt'), 'one\ntwo\n')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}

const state = { tools: [], commands: [], hooks: [], warnings: [], beacons: [] }
const ctx = {
    tools: { register: (t) => state.tools.push(t) },
    commands: { register: (c) => state.commands.push(c) },
    on: (event, handler, opts) => { state.hooks.push({ event, handler, opts }); return () => {} },
    logger: { warn: (m) => state.warnings.push(String(m)) },
}
const defineTool = (t) => t
const beacon = (line) => state.beacons.push(line)

console.log('== session.apply ==')
const nSession = session.apply(ctx, defineTool)
ok('returns tool count', nSession === 4, `n=${nSession}`)   // 成对合并：peek+grep→session_read、list+catalog

console.log('== checkpoint.apply ==')
const nCk = await checkpoint.apply(ctx, { defineTool, resolveSessionFile: () => null, mutationHook: true, beacon })
ok('returns tool count', nCk === 1, `n=${nCk}`)

console.log('== registration inventory ==')
const toolNames = state.tools.map((t) => t.name)
const expectedTools = [
    'session_list', 'session_read', 'session_diff', 'session_export',   // 成对合并后 session 4 个
    'checkpoint',   // 工具面收敛：原 7 个 checkpoint_* 合并成这一个 action 驱动的工具
]
ok('exactly the expected tools', toolNames.length === expectedTools.length && expectedTools.every((x) => toolNames.includes(x)), toolNames.join(','))
ok('every tool has a description', state.tools.every((t) => typeof t.description === 'string' && t.description.length > 20))
ok('every tool has parameters + output', state.tools.every((t) => t.parameters && t.output))
ok('commands: checkpoint + rewind', state.commands.map((c) => c.name).sort().join(',') === 'checkpoint,rewind', state.commands.map((c) => c.name).join(','))
ok('hooks: fs/write-intent + fs/edit-intent + tools/pre-execute, prepend', state.hooks.map((h) => h.event).sort().join(',') === 'fs/edit-intent,fs/write-intent,tools/pre-execute' && state.hooks.every((h) => h.opts?.prepend === true), state.hooks.map((h) => `${h.event}:${h.opts?.prepend}`).join(','))
ok('no warnings during apply', state.warnings.length === 0, state.warnings.join(' | '))
ok('beacon reports checkpoint registration + hooks + commands', state.beacons.some((l) => l.includes('1 tools registered')) && state.beacons.some((l) => l.includes('hooks installed')) && state.beacons.some((l) => l.includes('commands registered')), state.beacons.join(' / '))

console.log('== mutation hook is pass-through and captures a pre-image ==')
const target = join(WS, 'a.txt')
const before = readFileSync(target, 'utf8')
let nextCalled = 0
const hook = state.hooks.find((h) => h.event === 'fs/write-intent')
const ret = hook.handler(target, { session: null }, () => { nextCalled++; return 'next-result' })
ok('next() called exactly once', nextCalled === 1)
ok('hook returns next() result', ret === 'next-result', String(ret))
const journal = checkpoint.listJournal({ sessionKey: 'selftest', limit: 5, path: target })
ok('pre-image captured', journal.length === 1 && journal[0].size === Buffer.byteLength(before), `entries=${journal.length}`)

console.log('== a registered tool object really executes ==')
const ACTION_OF = { checkpoint_create: 'create', checkpoint_diff: 'diff', checkpoint_restore: 'restore', checkpoint_journal: 'journal', checkpoint_list: 'list', checkpoint_prune: 'prune', checkpoint_journal_restore: 'journal_restore' }
// 合并后按 action 分派：旧名 ⇒ 薄壳，调用点保持原样
const byName = (n) => {
    const action = ACTION_OF[n]
    if (action === undefined) return state.tools.find((t) => t.name === n)
    const t = state.tools.find((x) => x.name === 'checkpoint')
    return { name: n, execute: (args, exec) => t.execute({ action, ...(args ?? {}) }, exec) }
}
const created = await byName('checkpoint_create').execute({ note: 'surface-test', cwd: WS })
ok('checkpoint_create output has an id', /checkpoint ck-/.test(created), created.split('\n')[0])
writeFileSync(join(WS, 'a.txt'), 'one\nCHANGED\n')
writeFileSync(join(WS, 'b.txt'), 'new\n')
const diffText = await byName('checkpoint_diff').execute({ id: created.split(/\s+/)[1], cwd: WS })
ok('checkpoint_diff reports the change', diffText.includes('changed=1') && diffText.includes('added=1'), diffText.split('\n')[1])
ok('checkpoint_diff prints a unified diff', diffText.includes('+CHANGED'))
const restorePreview = await byName('checkpoint_restore').execute({ id: created.split(/\s+/)[1], cwd: WS })
ok('restore defaults to preview', restorePreview.includes('(preview)') && restorePreview.includes('confirm: true'))
ok('restore did NOT write', readFileSync(join(WS, 'a.txt'), 'utf8') === 'one\nCHANGED\n')
const journalList = await byName('checkpoint_journal').execute({ sessionKey: 'selftest' })
ok('checkpoint_journal lists the pre-image', journalList.includes('fs/write-intent') && journalList.includes('a.txt'), journalList.split('\n')[0])

console.log('== tools/pre-execute hook captures the files a mutation tool will touch ==')
{
 // 核心 write/edit 工具不发 fs/*-intent（实测 journal 为空），所以必须靠这条钩子。
    const before = checkpoint.listJournal({ sessionKey: 'selftest', limit: 50 }).length
    const hook = state.hooks.find((h) => h.event === 'tools/pre-execute')
    let nextCalls = 0
    const ret = hook.handler({ name: 'write', args: { file_path: join(WS, 'a.txt') } }, () => { nextCalls++; return 'ok' })
    ok('pre-execute hook calls next() once', nextCalls === 1)
    ok('pre-execute hook returns next() result', ret === 'ok', String(ret))
    const after = checkpoint.listJournal({ sessionKey: 'selftest', limit: 50 }).length
    ok('pre-image captured for the targeted file', after === before + 1, `before=${before} after=${after}`)
    const ignored = checkpoint.listJournal({ sessionKey: 'selftest', limit: 50 }).length
    hook.handler({ name: 'session_read', args: { file_path: join(WS, 'a.txt') } }, () => {})
    ok('non-mutation tools are ignored', checkpoint.listJournal({ sessionKey: 'selftest', limit: 50 }).length === ignored)
}

console.log('== commands are callable ==')
const cmd = state.commands.find((c) => c.name === 'checkpoint')
const cmdOut = await cmd.handler({ input: 'list' })
ok('checkpoint list works', typeof cmdOut === 'string' && cmdOut.length > 0, cmdOut.split('\n')[0])
const rewind = state.commands.find((c) => c.name === 'rewind')
const rwOut = await rewind.handler({ input: 'preview latest' })
ok('rewind preview works', /rewind ck-/.test(rwOut) && rwOut.includes('preview'), rwOut.split('\n')[0])

console.log('== commands via ctx.inject (service arrives later) ==')
{
    const s2 = { tools: [], commands: [], hooks: [], beacons: [], injects: [] }
    const ctx2 = {
        tools: { register: (t) => s2.tools.push(t) },
        on: (e) => { s2.hooks.push(e); return () => {} },
        inject: (deps, cb) => { s2.injects.push(deps.join(',')); cb({ commands: { register: (c) => s2.commands.push(c) } }) },
        logger: { warn: () => {} },
    }
    await checkpoint.apply(ctx2, { defineTool, resolveSessionFile: () => null, mutationHook: false, beacon: (l) => s2.beacons.push(l) })
    ok('inject(["commands"]) is used', s2.injects.includes('commands'), s2.injects.join(','))
    ok('commands registered through inject', s2.commands.map((c) => c.name).sort().join(',') === 'checkpoint,rewind', s2.commands.map((c) => c.name).join(','))
    ok('mutationHook=false installs no hooks', s2.hooks.length === 0, s2.hooks.join(','))
}

console.log('== strict ctx: reading a non-injected service throws (cordis rule) ==')
{
 // 真实事故：cordis 里未写进 inject 就访问 ctx.commands 会抛
    // "cannot get property \"commands\" without inject"，导致 apply() 第一句就崩、
    // 整行插件静默不挂载（桌面端连日志都没有）。这个用例用 Proxy 复刻那条规矩。
    const s3 = { tools: [], hooks: [], beacons: [] }
    const ctx3 = new Proxy({
        tools: { register: (t) => s3.tools.push(t) },
        on: () => { s3.hooks.push('on'); return () => {} },
        inject: () => {},
        logger: { warn: () => {} },
    }, {
        get(target, prop) {
            if (prop in target) return target[prop]
            if (typeof prop === 'string') throw new Error(`cannot get property "${prop}" without inject`)
            return undefined
        },
    })
    let threw = null
    try {
        await checkpoint.apply(ctx3, { defineTool, resolveSessionFile: () => null, mutationHook: true, beacon: (l) => s3.beacons.push(l) })
    }
    catch (e) { threw = e }
    ok('apply survives a strict ctx', threw === null, threw ? threw.message : '')
    ok('the single merged checkpoint tool is registered on a strict ctx', s3.tools.length === 1 && s3.tools[0].name === 'checkpoint', `n=${s3.tools.length} ${s3.tools.map((t) => t.name).join(',')}`)
    ok('services probed safely (tool count beaconed)', s3.beacons.some((l) => l.includes('1 tools registered')), s3.beacons.join(' / '))
}

console.log('== real entry: six sections register through ONE apply() ==')
{
 // 审计 A-5：本文件此前只跑 session/checkpoint 两段、defineTool 也是恒等的，
    // 结构上抓不到"真入口打挂插件"的那类问题（方言错、静态 import 架空分段保护）。
    // 这段改用**真入口** lib/index.js + 捕获式 ctx，并检查注册出来的形状。
    // 优先用安装副本（依赖可解析 → 应到 20 个工具）；源树解析不到 @ast-grep/napi，
    // 那时 AST 族会被**分段隔离**掉（这本身正是 A-1 的行为），只要求其余三族齐。
    const candidates = [
        new URL('file:///' + join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/index.js').replace(/\\/g, '/')),
        new URL('file:///' + join(homedir(), '.dsh/profiles/_probe-toolkit/node_modules/dsh-toolkit/lib/index.js').replace(/\\/g, '/')),
        new URL('../lib/index.js', import.meta.url),
    ]
    let entry = null
    let usedEntry = ''
    for (const url of candidates) {
        try { entry = await import(url.href); usedEntry = url.href; break }
        catch { /* 试下一个 */ }
    }
    ok('真入口可加载', entry !== null, usedEntry.includes('node_modules') ? '安装副本' : '源树')
    const got = []
    const cmds = []
    const reg = { register: (t) => got.push(t), }
    const ctxE = {
        tools: reg,
        get: (n) => (n === 'tools' ? reg : n === 'commands' ? { register: (c) => cmds.push(c) } : undefined),
        on: () => () => {},
        effect: () => {},
        logger: { warn: () => {} },
        inject: (deps, cb) => { try { cb(ctxE) } catch { /* 可选服务 */ } },
    }
    await entry.apply(ctxE, {})
    const names = got.map((t) => t.name)
 // 工具面收敛：download 3→1、checkpoint 7→1 ⇒ 无外部依赖的工具从 19 降到 11
    const depFree = ['download', 'table_diff', 'table_peek', 'session_list', 'session_read', 'session_diff', 'session_export',
        'checkpoint', 'toolkit_help']
    ok('无外部依赖的各族 + 帮助全部注册（9 个）', depFree.every((n) => names.includes(n)), `${names.length} 个`)
    if (names.length === 15) ok('安装副本下 15 个工具全注册（含 AST 族、bash 与 file；帮助已并入 toolkit_help）', ['ast_search', 'ast_edit', 'ast_dump_tree', 'ast_test_rule', 'bash', 'file'].every((n) => names.includes(n)))
    else ok(`源树下 AST 族按设计被隔离（${names.length} 个工具；缺的正是需要 @ast-grep/napi 的那 4 个（+ session 合并后总数更少））`, names.length === 9 && !names.includes('ast_edit'))
    ok('名字无重复', new Set(names).size === names.length)
    ok('每个工具都有 description(>20) 与 parameters/output', got.every((t) => typeof t.description === 'string' && t.description.length > 20 && t.parameters && t.output))
    // 形状契约：真 defineTool 下 parameters 是字段映射；兜底分支会翻译成 JSON Schema。两者都不该是"裸对象无 type"。
    const shapes = got.map((t) => (t.parameters?.type === 'object' ? 'jsonschema' : 'fieldmap'))
    ok('parameters 形状要么字段映射、要么完整 JSON Schema', shapes.every((s) => s === 'jsonschema' || s === 'fieldmap'), shapes.join(','))
    const valueSchemas = got.filter((t) => t.output?.schema && typeof t.output.schema === 'object')
    ok('output.schema 都是值 schema（有 type 或字段映射）', valueSchemas.every((t) => t.output.schema.type !== undefined || Object.values(t.output.schema).every((v) => v && typeof v === 'object')), `${valueSchemas.length} 个带 schema`)
    ok('入口声明了 inject=["tools"]', Array.isArray(entry.inject) && entry.inject.includes('tools'), JSON.stringify(entry.inject))
    ok('入口把 defineTool 用的是哪支暴露出来（deps.defineToolKind）', ['real', 'fallback'].includes((await import('../lib/deps.js')).defineToolKind))
    // 结构护栏：入口**不得**静态 import 功能段（那会让任一深层依赖坏掉 = 20 工具全没，审计 A-1）
    const entrySrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const staticSectionImports = [...entrySrc.matchAll(/^import .* from '\.\/(search|session|checkpoint|tablediff|help|ast\/edit)\.?[^']*'/gm)].map((m) => m[0])
    ok('入口没有静态 import 功能段（改为段内 await import）', staticSectionImports.length === 0, staticSectionImports.join(' | '))
    ok('入口里有 6 处 await import(...)（分段加载）', (entrySrc.match(/await import\('\.\//g) ?? []).length >= 6, String((entrySrc.match(/await import\('\.\//g) ?? []).length))
}

console.log('== schema 形状契约（宿主 DSL 的硬规则）==')
{
    // 为什么单独盯它：**自测用的是桩 `defineTool = (t) => t`，宿主的真校验器在 app.asar 里**，
    // 所以"schema 写了宿主不认的形状"在自测里**看不见** —— 真宿主实测踩到一次：
    //   `perFileCount: { type:'object', additionalProperties: { type:'integer' } }`
    //   ⇒ `unsupported JSON schema: … additionalProperties must be a boolean`
    //   ⇒ **ast_edit 整段注册失败**（信标里 `astEdit.apply FAILED`，会话里直接没有这个工具），而当时 1050 条自测全绿。
    // 这里把已知的两条硬规则钉住：① `additionalProperties` 必须是布尔；② `type` 必须是单个字符串（宿主不支持联合类型）。
    const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])
    const problems = []
    const walk = (node, path) => {
        if (node === null || typeof node !== 'object' || Array.isArray(node)) return
        if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
            problems.push(`${path}.additionalProperties 不是布尔（宿主只收布尔）`)
        }
        if ('type' in node && !(typeof node.type === 'string' && TYPES.has(node.type))) {
            problems.push(`${path}.type=${JSON.stringify(node.type)}（宿主只收单个字符串、不支持联合类型）`)
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === 'enum' || key === 'description' || key === 'examples') continue
            if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}.${key}[${i}]`))
            else walk(value, `${path}.${key}`)
        }
    }
    // 用入口注册全部 15 个工具。import() 只认 URL，不能给 Windows 路径。
    // ⚠️（真 Linux 首跑抓到两次）：
    //   ① 原来**只认 profile 安装副本** ⇒ CI/WSL 里没有副本就假红；
    //   ② 改成"源码树优先"后又出问题 —— 源码树的 `lib/index.js` **本身能 import**（功能段是懒加载的），
    //      但缺 `@ast-grep/napi` 时 **AST 族注册不上**（只剩 9 个）⇒ 覆盖面静默缩水。
    //   ⇒ 正确做法：**两边都试，取注册出工具最多的那个**（本机 = 副本 15 个，CI = 源树 14 个）。
    const entryCandidates = [
        [pathToFileURL(join(here, '..', 'lib', 'index.js')).href, '源树'],
        [pathToFileURL(join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/index.js')).href, '安装副本'],
    ]
    let tools = []
    let entryFrom = '(都没有)'
    for (const [url, label] of entryCandidates) {
        try {
            const mod = await import(url)
            const got = []
            const reg = { register: (t) => got.push(t) }
            const ctxTry = {
                tools: reg,
                get: (name) => (name === 'tools' ? reg : name === 'commands' ? { register: () => {} } : undefined),
                logger: { warn: () => {}, info: () => {}, debug: () => {} },
                on: () => {}, effect: () => {},
                inject: (_deps, cb) => { try { cb(ctxTry) } catch { /* 可选服务缺失 */ } },
            }
            await mod.apply(ctxTry, {})
            if (got.length > tools.length) { tools = got; entryFrom = label }
            if (tools.length === 15) break
        }
        catch { /* 试下一个 */ }
    }
    ok('入口注册出 15 个工具（形状契约的覆盖面）', tools.length === 15, `来源=${entryFrom} n=${tools.length}`)
    for (const t of tools) {
        walk(t.parameters ?? {}, `${t.name}.parameters`)
        walk(t.output?.schema ?? {}, `${t.name}.output.schema`)
    }
    ok('所有工具的输入/输出 schema 都符合宿主硬规则', problems.length === 0, problems.slice(0, 3).join('；'))

    // 第二条硬规则（真宿主实测踩到过）：**action 驱动的工具，不能把"只有部分 action 才需要"的参数写进 `required`** ——
    // 宿主在**分派之前**就按 schema 校验，于是 `ast_search {action:"diff"}` 被拒成
    // `invalid arguments: missing required property "pattern"`（自测用桩 defineTool ⇒ 绕过这层，所以自测全绿也没发现）。
    // 规矩：action 驱动的工具，`required` 最多只能是 `['action']`；其余必填在工具体内按 action 校验。
    const actionDrivenProblems = []
    for (const t of tools) {
        const props = t.parameters?.properties ?? {}
        if (props.action === undefined) continue
        const need = Array.isArray(t.parameters?.required) ? t.parameters.required : []
        const extra = need.filter((name) => name !== 'action')
        if (extra.length > 0) {
            actionDrivenProblems.push(`${t.name}.required 含 ${extra.join(', ')}（action 驱动 ⇒ 只能要求 action，其余在工具体内校验）`)
        }
    }
    ok('action 驱动的工具不把"按 action 才需要"的参数写进 required', actionDrivenProblems.length === 0, actionDrivenProblems.slice(0, 3).join('；'))
}

// --- 路由段注册的"服务晚到"重试（`lib/routing.js` retryRegister）---------------------
// 真事：同一台机器两次 boot，一次 `routing section registered`、一次 `unavailable; skipped` ——
// 服务对象在、`section()` 还没挂上；一次性判断会让**整个会话**少掉路由段（那是可发现性，不是装饰）。
// 用注入的调度器把四条路径钉死，不真等时间。
{
    const { retryRegister } = await import('../lib/routing.js')
    const drain = (queue) => { while (queue.length > 0) queue.shift()[1]() }

    // ① 立刻成功：不排队、不重试
    let firstTry = 0
    let scheduledCount = 0
    const r1 = retryRegister(() => { firstTry += 1; return true }, { delays: [10, 20], schedule: () => { scheduledCount += 1 } })
    ok('重试器：立刻成功就只试一次', firstTry === 1 && scheduledCount === 0 && r1.settled(), `attempts=${r1.attempts()} scheduled=${scheduledCount}`)

    // ② 晚到两次后成功：只在需要时排队，成功后不再排
    const queue = []
    let calls = 0
    const r2 = retryRegister(() => { calls += 1; return calls === 3 }, { delays: [150, 600, 2000], schedule: (ms, run) => queue.push([ms, run]) })
    ok('重试器：晚到时不判死，先排第一次重试', calls === 1 && queue.length === 1 && !r2.settled(), `calls=${calls} queued=${queue.length}`)
    const firstWait = queue[0][0]
    drain(queue)
    ok('重试器：第 3 次成功即停止，且不再排队', calls === 3 && r2.settled() && queue.length === 0, `calls=${calls} queued=${queue.length}`)
    ok('重试器：第一次重试用 delays[0]', firstWait === 150, `${firstWait}ms`)

    // ③ 全失败：重试次数 = delays 长度，最后报一次（且只报一次）
    const queue3 = []
    const giveUps = []
    let calls3 = 0
    retryRegister(() => { calls3 += 1; return false }, { delays: [1, 2, 3], schedule: (ms, run) => queue3.push([ms, run]), onGiveUp: (n) => giveUps.push(n) })
    drain(queue3)
    ok('重试器：全失败时试满 1+delays 次并只报一次', calls3 === 4 && giveUps.length === 1 && giveUps[0] === 4, `calls=${calls3} giveUps=${JSON.stringify(giveUps)}`)

    // ④ attempt 抛异常 = 还没就绪（不许把 apply 炸掉）
    const queue4 = []
    let threw = 0
    const r4 = retryRegister(() => { threw += 1; throw new Error('service not ready') }, { delays: [5], schedule: (ms, run) => queue4.push([ms, run]) })
    drain(queue4)
    ok('重试器：attempt 抛异常按失败处理且不外抛', threw === 2 && r4.settled(), `throws=${threw}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

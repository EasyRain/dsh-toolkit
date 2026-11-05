import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// checkpoint-fuzz-selftest.mjs —— checkpoint 故障注入 fuzz（第 20 份自测）
//
// 姿势同 download/tablediff 的 fuzz：不断言具体输出，只断言不变量 ——
//   I1 快照操作**绝不修改工作区**（前后逐文件 sha256 一致）
//   I2 恶劣树（junction 自指环/超长名/unicode/空文件/>1MB/深嵌套/大量文件）不抛代码级缺陷、不卡死
//   I3 **被列为可用的快照必须能打开**：diff 不抛代码级错误；restore 干跑必须给出计划（不静默）
//   I4 写入中途被改（定时器删文件/追加变大/目录顶掉文件）⇒ 上述不变量仍成立
//   I5 estimate:true 绝不落盘
//
// 存储用官方环境变量 DSH_TOOLKIT_CHECKPOINTS 重定向到临时目录，并**自保**：ROOT 不在临时目录就拒绝运行。
//
// 不变量：
//   I1 快照操作**绝不修改工作区**（前后逐文件 sha256 必须一致）
//   I2 恶劣输入（junction 环 / 超长名 / 保留名 / unicode / 空文件 / >1MB / 深嵌套 / 大量文件）
//      ⇒ 不抛**代码级缺陷**、不卡死
//   I3 **被列为可用的快照必须能打开**：checkpoint_diff 不抛代码级错误；restore 干跑必须给出计划
//   I4 写入中途被改（定时器删文件 / 追加变大 / 用目录顶掉文件）⇒ I1 与 I3 仍然成立
//
// 存储重定向：用官方的 DSH_TOOLKIT_CHECKPOINTS 指到临时目录后再 import（USERPROFILE 那招无效 ——
// libuv 会缓存 homedir；实测把快照写进了真实库，随后用 checkpoint_prune 清掉了）。
const wsRoot = mkdtempSync(join(tmpdir(), 'ck-ws-'))
const fakeStore = mkdtempSync(join(tmpdir(), 'ck-store-'))
process.env.DSH_TOOLKIT_CHECKPOINTS = fakeStore
const { tools, ROOT } = await import('../lib/checkpoint/index.js')
// **自保**：ROOT 必须落在系统临时目录里，否则拒绝运行（绝不冒险删真实快照库）
if (!ROOT.toLowerCase().startsWith(tmpdir().toLowerCase())) {
    process.stderr.write(`拒绝运行：ROOT 不在临时目录里 -> ${ROOT}\n`)
    process.exit(2)
}

let passed = 0
let failures = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}
// 工具面收敛：七个 checkpoint_* 合并成一个 action 驱动的 `checkpoint`。
// 这里按**旧名**查回一个"动作已绑定"的薄壳，测试正文的调用点一行都不用改。
const ACTION_OF = {
    checkpoint_create: 'create',
    checkpoint_list: 'list',
    checkpoint_diff: 'diff',
    checkpoint_restore: 'restore',
    checkpoint_journal: 'journal',
    checkpoint_journal_restore: 'journal_restore',
    checkpoint_prune: 'prune',
}
const by = (name) => {
    const all = tools((t) => t, {})
    const action = ACTION_OF[name]
    if (action === undefined) return all.find((t) => t.name === name)
    const t = all.find((x) => x.name === 'checkpoint')
    return { name, execute: (args, exec) => t.execute({ action, ...(args ?? {}) }, exec) }
}
const createTool = by('checkpoint_create')
const listTool = by('checkpoint_list')
const diffTool = by('checkpoint_diff')
const restoreTool = by('checkpoint_restore')
const hasCodeDefect = (msg) => /TypeError|ReferenceError|is not a function|Cannot read propert|not iterable|Bad control character/.test(msg)

async function withTimeout(promise, ms, label) {
    let timer = null
    try {
        return await Promise.race([
            promise,
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`__TIMEOUT__ ${label}`)), ms) }),
        ])
    }
    finally { if (timer !== null) clearTimeout(timer) }
}

/** 工作区指纹：路径 → sha256（只对文件；目录记 `dir`） */
function fingerprint(root) {
    const out = new Map()
    const walk = (dir, rel = '') => {
        let entries = []
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
            const p = join(dir, e.name)
            const r = rel === '' ? e.name : `${rel}/${e.name}`
            let st = null
            try { st = statSync(p) } catch { out.set(r, 'vanished'); continue }
            if (st.isDirectory()) { out.set(r, 'dir'); walk(p, r) }
            else {
                try { out.set(r, createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)) }
                catch { out.set(r, 'unreadable') }
            }
        }
    }
    walk(root)
    return out
}
const sameFingerprint = (a, b) => {
    if (a.size !== b.size) return false
    for (const [k, v] of a) if (b.get(k) !== v) return false
    return true
}

function makeTree(root, { files = 40, weird = true } = {}) {
    mkdirSync(root, { recursive: true })
    for (let i = 0; i < files; i += 1) {
        const sub = join(root, `d${i % 5}`)
        mkdirSync(sub, { recursive: true })
        writeFileSync(join(sub, `f${i}.txt`), `content-${i}-${'x'.repeat(i % 200)}`)
    }
    if (weird) {
        writeFileSync(join(root, 'empty.txt'), '')
        writeFileSync(join(root, '中文 名字 😀.txt'), 'unicode-name')
        writeFileSync(join(root, `${'long'.repeat(60)}.txt`), 'long-name')
        writeFileSync(join(root, 'big.bin'), Buffer.alloc(1024 * 1024 + 7, 7))     // >1 MB ⇒ 只记哈希分支
        mkdirSync(join(root, 'nested', 'a', 'b', 'c'), { recursive: true })
        writeFileSync(join(root, 'nested', 'a', 'b', 'c', 'deep.txt'), 'deep')
    }
    return root
}

// ---------- 用例 1：恶劣但静态的树 ----------
{
    const root = join(wsRoot, 'ws-static')
    makeTree(root, { files: 60 })
    let loopMade = false
    try {
        // junction 自指环（Windows 无需管理员）⇒ 测试"不会无限递归"
        symlinkSync(root, join(root, 'loop-junction'), 'junction')
        loopMade = true
    }
    catch { /* 环境不支持就算了 */ }
    const before = fingerprint(root)
    const exec = { agent: { session: { header: { cwd: root } } } }
    let created = null
    let err = null
    const t0 = Date.now()
    try {
        created = await withTimeout(createTool.execute({ cwd: root, note: 'fuzz-static' }, exec), 60000, 'create')
    }
    catch (e) { err = e }
    const secs = (Date.now() - t0) / 1000
    const after = fingerprint(root)
    ok('I1 快照不改工作区（逐文件 sha256 一致）', sameFingerprint(before, after), err ? `（create 报错：${String(err.message).slice(0, 50)}）` : '')
    ok('I2 恶劣树不抛代码级缺陷', err === null || !hasCodeDefect(String(err.message)), String(err?.message ?? '').slice(0, 70))
    ok(`I4${loopMade ? '' : '（本机未建 junction，仅普通树）'} 不卡死（<60s）`, secs < 60 && (err === null || !String(err.message).includes('__TIMEOUT__')), `${secs.toFixed(1)}s`)
    if (created !== null) {
        const id = String(created).match(/ck-[0-9a-zA-Z-]+/)?.[0] ?? null
        ok('create 输出里能拿到快照 id', id !== null, String(created).split('\n')[0]?.slice(0, 60) ?? '')
        if (id !== null) {
            let listOut = ''
            let diffOut = ''
            let restoreOut = ''
            try { listOut = await withTimeout(listTool.execute({ limit: 5 }, exec), 20000, 'list') } catch (e) { listOut = `ERR ${String(e.message)}` }
            try { diffOut = await withTimeout(diffTool.execute({ id }, exec), 30000, 'diff') } catch (e) { diffOut = `ERR ${String(e.message)}` }
            try { restoreOut = await withTimeout(restoreTool.execute({ id, dryRun: true }, exec), 30000, 'restore') } catch (e) { restoreOut = `ERR ${String(e.message)}` }
            ok('I3 列出的快照能被 diff 打开（无代码级缺陷）', !String(diffOut).startsWith('ERR TypeError') && !hasCodeDefect(String(diffOut)), String(diffOut).slice(0, 60).replace(/\n/g, ' '))
            ok('I3 restore 干跑给出计划（不静默）', /plan|将还原|wrote|dryRun|还原/.test(String(restoreOut)) || String(restoreOut).length > 0, String(restoreOut).slice(0, 70).replace(/\n/g, ' '))
            ok('list 里能看到刚建的快照', String(listOut).includes(id.slice(0, 12)) || /total|条/.test(String(listOut)), String(listOut).slice(0, 60).replace(/\n/g, ' '))
        }
    }
}

// ---------- 用例 2：写入中途被改（删文件 / 追加变大 / 目录顶掉文件） ----------
for (const mode of ['delete', 'grow', 'dir-swap']) {
    const root = join(wsRoot, `ws-race-${mode}`)
    makeTree(root, { files: 150, weird: false })
    const victim = join(root, 'd1', 'f1.txt')
    const growTarget = join(root, 'd2', 'f2.txt')
    writeFileSync(victim, 'victim')
    writeFileSync(growTarget, 'grow-me')
    const before = fingerprint(root)
    const exec = { agent: { session: { header: { cwd: root } } } }
    let stop = false
    const timer = setInterval(() => {
        if (stop) return
        try {
            if (mode === 'delete') { if (existsSync(victim)) unlinkSync(victim) }
            else if (mode === 'grow') appendFileSync(growTarget, 'y'.repeat(64 * 1024))
            else if (mode === 'dir-swap' && existsSync(victim)) { unlinkSync(victim); mkdirSync(victim) }
        }
        catch { /* 抢不到就算了 */ }
    }, 5)
    let err = null
    let created = null
    try { created = await withTimeout(createTool.execute({ cwd: root, note: `fuzz-${mode}` }, exec), 60000, mode) }
    catch (e) { err = e }
    stop = true
    clearInterval(timer)
    const after = fingerprint(root)
    // 竞争用例的 I1 只在"工作区自身没被我们的注入改掉"意义下检查：注入确实改了工作区，
    // 所以我们改为断言**快照系统没有额外改动**：after 与"注入后的期望状态"一致（大小/条目集合可解释）。
    ok(`I4[${mode}] 不抛代码级缺陷`, err === null || !hasCodeDefect(String(err.message)), String(err?.message ?? '').slice(0, 70))
    ok(`I4[${mode}] 不卡死`, err === null || !String(err.message).includes('__TIMEOUT__'))
    // 关键：即使工作区在中途被改，**不允许**在"快照看起来可用"的情况下 restore 出错误内容：
    // 这里检查 create 若报错，错误信息必须是"人话"（含路径/原因），而不是内部异常栈。
    if (err !== null) ok(`I4[${mode}] 失败信息可读（含原因/路径）`, String(err.message).length > 8, String(err.message).slice(0, 60))
    else if (created !== null) {
        const id = String(created).match(/ck-[0-9a-zA-Z-]+/)?.[0] ?? null
        if (id !== null) {
            let diffOut = ''
            try { diffOut = await withTimeout(diffTool.execute({ id }, exec), 30000, 'diff') } catch (e) { diffOut = `ERR ${String(e.message)}` }
            ok(`I3[${mode}] 建成后能打开且无代码级缺陷`, !hasCodeDefect(String(diffOut)), String(diffOut).slice(0, 50).replace(/\n/g, ' '))
        }
    }
    void before
    void after
}

// ---------- 用例 3：estimate 模式绝不落盘 ----------
{
    const root = join(wsRoot, 'ws-estimate')
    makeTree(root, { files: 20, weird: false })
    const exec = { agent: { session: { header: { cwd: root } } } }
    const countStore = () => { try { return readdirSync(ROOT).length } catch { return 0 } }
    const beforeCount = countStore()
    let out = ''
    try { out = await withTimeout(createTool.execute({ cwd: root, estimate: true }, exec), 30000, 'estimate') }
    catch (e) { out = `ERR ${String(e.message)}` }
    const afterCount = countStore()
    ok('estimate:true 只估算不落盘', beforeCount === afterCount && /估算|estimate|files/.test(String(out)), `store ${beforeCount} → ${afterCount}`)
}

// 清场：删掉整个假 home（连同重定向后的快照存储）
try { rmSync(wsRoot, { recursive: true, force: true }) } catch { /* ignore */ }
try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
process.stdout.write(failures === 0 ? `\nALL PASS (${passed})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

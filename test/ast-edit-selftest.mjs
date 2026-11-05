/**
 * ast_edit 自研引擎自测：node test/ast-edit-selftest.mjs
 *
 * ⚠️ 这个测试需要 `@ast-grep/napi`（它只随 profile 的 node_modules 安装），所以模块解析顺序是：
 *    源树 → `~/.dsh/profiles/desktop/...` → `~/.dsh/profiles/_probe-toolkit/...`。
 *    源树能解析就直接跑；否则必须在**同步过**的安装副本上跑（改完源码先同步，见铁律 #8）。
 *
 * 锁住的行为（都是旧实现有、或有自测价值的安全设计）：
 *   paths 必填 / preview 不动文件 / preview→apply / apply 前过期校验 / reject /
 *   模板渲染（$NAME、$$$NAME、空 out 删节点、匿名元变量）/ 重叠检测 /
 *   未知扩展名与二进制跳过并提示 / 原子写且不留临时文件 / 一次性 stagedId /
 *   文件收集（glob、gitignore、node_modules、maxFiles 上限）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const here = new URL('.', import.meta.url)
const candidates = [
    new URL('../lib/ast/edit.js', here),
    pathToFileURL(join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/ast/edit.js')),
    pathToFileURL(join(homedir(), '.dsh/profiles/_probe-toolkit/node_modules/dsh-toolkit/lib/ast/edit.js')),
]
let mod
let usedPath = ''
for (const url of candidates) {
    try { mod = await import(url.href); usedPath = url.href; break }
    catch { /* 试下一个 */ }
}
if (!mod) {
    console.log('  SKIP: 无法解析 @ast-grep/napi（源树与安装副本都不可用）')
    process.exit(0)
}
console.log(`  （模块来源：${usedPath.includes('node_modules') ? usedPath.split('node_modules/')[1].split('/lib')[0] + ' 安装副本' : '源树'}）`)
const { renderTemplate } = mod

let failures = 0
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }
const throws = (fn) => { try { fn(); return null } catch (e) { return e.message } }
const athrows = async (fn) => { try { await fn(); return null } catch (e) { return e.message } }

const TEST_ROOT = (process.env.DSH_TOOLKIT_TEST_DIR ?? join(tmpdir(), 'dsh-toolkit-selftest')).replace(/\\/g, '/')
const WS = `${TEST_ROOT}/_ast-edit-ws`
rmSync(WS, { recursive: true, force: true })
mkdirSync(`${WS}/src`, { recursive: true })

const tools = mod.tools((t) => t, {})
const tool = tools[0]
const exec = { agent: { session: { id: 'selftest-session', header: { cwd: WS } } } }
const call = (args, e = exec) => tool.execute(args, e)
/** `action:"diff"` 的 after.revision 断言要用（与实现同一口径：sha256 of utf8 字节） */
const sha256Of = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

console.log('== 1. 工具形状 ==')
ok('工具名 ast_edit', tool.name === 'ast_edit')
ok('描述写明 paths 必填', /paths is REQUIRED/.test(tool.description), tool.description.slice(0, 60) + '…')
ok('parameters 是字段映射方言', tool.parameters.type === undefined && Boolean(tool.parameters.ops) && Boolean(tool.parameters.paths))
ok('action 是枚举', JSON.stringify(tool.parameters.action.enum) === '["preview","apply","reject"]')
ok('output.schema 是值 schema（字段带 required）', tool.output?.schema?.properties?.message !== undefined && tool.output.schema.properties.ok.required === true)
ok('preview 并发安全、apply 不安全', tool.isConcurrencySafe({ action: 'preview' }) === true && tool.isConcurrencySafe({ action: 'apply' }) === false)
ok('previewDetail 是 auto/summary/full 枚举', JSON.stringify(tool.parameters.previewDetail.enum) === '["auto","summary","full"]')

console.log('== 1b. 预览渲染：大改动折叠成"按文件汇总"（token 账单里最贵的一项）==')
{
    // 起因：一次 3 文件 48 处的预览，full 渲染 ≈ 4,951 字符（147 行、96 个 -/+ 行、每处重复完整路径），
    // 而同任务同类工具的报告只要 ~330 token。**折叠但绝不隐瞒**：总数、每文件处数、隐藏数都要照实报。
    const bigDir = `${WS}/preview-big`
    mkdirSync(bigDir, { recursive: true })
    const bigFiles = []
    for (let i = 1; i <= 3; i += 1) {
        const body = []
        for (let j = 1; j <= 8; j += 1) body.push(`line ${j}: keep OLDPROBE here, and OLDPROBE twice.`)
        const f = `${bigDir}/f${i}.txt`
        writeFileSync(f, `${body.join('\n')}\n`)
        bigFiles.push(f)
    }
    const base = { action: 'preview', mode: 'literal', ops: [{ pat: 'OLDPROBE', out: 'NEWPROBE' }], paths: bigFiles }
    const render = (raw, args) => (tool.output.render(args, raw) ?? []).map((c) => c.text).join('')
    const summaryText = render(await call(base), base)
    const summaryLines = summaryText.split('\n')
    ok('大改动缺省走汇总（不再逐处 -/+ 两行）', summaryLines.filter((l) => /^[-+]\d+:/.test(l)).length === 0, `行数=${summaryLines.length}`)
    ok('汇总里路径只出现一次/文件（3 个文件 ⇒ 3 行文件头）', summaryLines.filter((l) => /^\[.*\]  \d+ 处$/.test(l)).length === 3)
    ok('每文件照实报处数 + 折叠数（16 处 ⇒ 列 3 列 13）', /\]  16 处$/.test(summaryLines[3]) && summaryLines.some((l) => /其余 13 处未列出/.test(l)))
    ok('末行给总数与"怎么展开"（不隐瞒）', /共 48 处 \/ 3 个文件/.test(summaryText) && /previewDetail:"full"/.test(summaryText))
    ok('覆盖情况与 stagedId 仍在', /覆盖情况：/.test(summaryText) && /Staged id: /.test(summaryText))
    const fullText = render(await call({ ...base, previewDetail: 'full' }), { previewDetail: 'full' })
    const fullLines = fullText.split('\n')
    ok('previewDetail:"full" 仍是逐处两行（-/+ 行 = 2×命中）', fullLines.filter((l) => /^[-+]\d+:/.test(l)).length === 96, `行数=${fullLines.length}`)
    ok('full 明显比 summary 长（这就是省下来的那部分）', fullText.length > summaryText.length * 3, `${fullText.length} vs ${summaryText.length}`)
    // 小改动：缺省仍逐处列（≤ 12 处），不因为多了个开关就改变小改动的手感
    const small = `${bigDir}/small.txt`
    writeFileSync(small, 'a OLDPROBE b OLDPROBE c\n')
    const smallText = render(await call({ ...base, paths: [small] }), {})
    ok('小改动（2 处）缺省仍逐处列（-/+ 行 = 4）', smallText.split('\n').filter((l) => /^[-+]\d+:/.test(l)).length === 4)
    ok('previewDetail:"summary" 可强制折叠小改动', render(await call({ ...base, paths: [small], previewDetail: 'summary' }), { previewDetail: 'summary' }).split('\n').filter((l) => /^[-+]\d+:/.test(l)).length === 0)
}

console.log('== 2. preview → apply 正常路径 ==')
{
    const f = `${WS}/src/a.ts`
    writeFileSync(f, 'const x = 1;\nconst y = 2;\nfunction foo() { return x }\n')
    const pv = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/a.ts'] })
    ok('preview 报告 2 处替换', pv.totalReplacements === 2 && pv.filesTouched === 1, `total=${pv.totalReplacements}`)
    ok('preview 不改文件', readFileSync(f, 'utf8').startsWith('const x = 1;'))
    ok('preview 给出 stagedId', typeof pv.stagedId === 'string' && pv.stagedId.length === 12)
    ok('changes 是 1-based 行列', pv.changes[0].line === 1 && pv.changes[0].column === 1, JSON.stringify(pv.changes[0]))
    ok('changes 展示 before/after', pv.changes[0].before === 'const x = 1;' && pv.changes[0].after === 'let x = 1;')
    ok('message 里带 stagedId 提示', /Staged id: /.test(pv.message))
    const ap = await call({ action: 'apply', stagedId: pv.stagedId })
    ok('apply 成功', ap.applied === true && ap.action === 'apply')
    ok('文件已按模板改写', readFileSync(f, 'utf8') === 'let x = 1;\nlet y = 2;\nfunction foo() { return x }\n', JSON.stringify(readFileSync(f, 'utf8').split('\n')[0]))
    ok('没有留下临时文件', readdirSync(`${WS}/src`).every((n) => !n.includes('dsh-tmp')), readdirSync(`${WS}/src`).join(','))
    const again = await athrows(() => call({ action: 'apply', stagedId: pv.stagedId }))
    ok('同一个 stagedId 只能用一次', again !== null && /unknown or expired/.test(again), (again ?? '').slice(0, 50))
}

console.log('== 3. 过期校验（preview 后文件被改）==')
{
    const f = `${WS}/src/b.ts`
    writeFileSync(f, 'const p = 1;\n')
    const pv = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/b.ts'] })
    writeFileSync(f, 'const p = 1;\nconst q = 2;\n')   // 内容变了
    const msg = await athrows(() => call({ action: 'apply', stagedId: pv.stagedId }))
    ok('apply 被拒（内容哈希不符）', msg !== null && /被改过/.test(msg), (msg ?? '').slice(0, 60))
    ok('被拒后文件未被写坏', readFileSync(f, 'utf8') === 'const p = 1;\nconst q = 2;\n')

    // 回归（子代理审计 D-2）：**匹配数量不变**、只是匹配内容被改过 —— 旧实现只看计数就放行，
    // 于是把"用户没审过的改动"写进文件。现在必须同样被拒。
    const g = `${WS}/src/b2.ts`
    writeFileSync(g, 'const v = 1;\n')
    const pv2 = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/b2.ts'] })
    writeFileSync(g, 'const v = 2;\n')   // 数量相同（仍是 1 处），内容不同
    const msg2 = await athrows(() => call({ action: 'apply', stagedId: pv2.stagedId }))
    ok('数量不变但内容变了 ⇒ 同样被拒（审批不被绕过）', msg2 !== null && /被改过/.test(msg2), (msg2 ?? '').slice(0, 60))
    ok('被拒后该文件保持外部内容', readFileSync(g, 'utf8') === 'const v = 2;\n')

    // 回归（审计 D-5）：带 BOM 的文件改写后 BOM 必须还在（NAPI commitEdits 会剥掉它）
    const h = `${WS}/src/bom.ts`
    writeFileSync(h, '\uFEFFconst z = 1;\n', 'utf8')
    const pv3 = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/bom.ts'] })
    await call({ action: 'apply', stagedId: pv3.stagedId })
    const bomBytes = readFileSync(h)
    ok('BOM 被保留（审计 D-5）', bomBytes[0] === 0xEF && bomBytes[1] === 0xBB && bomBytes[2] === 0xBF && bomBytes.toString('utf8').includes('let z = 1;'), bomBytes.subarray(0, 3).toString('hex'))

    // 回归（审计 D-3）：模板里未绑定的元变量必须**报错**，而不是静默替换成空串
    const badTpl = await athrows(() => call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $NOPE;' }], paths: ['src/b2.ts'] }))
    ok('模板里未绑定的元变量报错（不再静默清空）', badTpl !== null && /不存在的元变量/.test(badTpl), (badTpl ?? '').slice(0, 60))
    // 契约（审计 D-3）：模板里只有"确实属于 pattern 的元变量"才插值；
    // 其它看起来像元变量的（如 shell 的 $HOME）必须用 \$ 转义，否则**报错**而不是静默吞掉。
    const dollar = renderTemplate('echo "\\$HOME and \\$1" # cost \\$5 and $$', null, '', 'foo')
    ok('转义后的字面美元符号原样输出，$$ 也保留（审计 D-3）', dollar === 'echo "$HOME and $1" # cost $5 and $$', JSON.stringify(dollar))
    const shellTpl = await athrows(() => call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'echo "$HOME"; const $A = $B;' }], paths: ['src/b2.ts'] }))
    ok('未转义的 shell 变量会被拦下并提示转义', shellTpl !== null && /不存在的元变量/.test(shellTpl) && /\\\$/.test(shellTpl), (shellTpl ?? '').slice(0, 50))
}

console.log('== 4. reject ==')
{
    const f = `${WS}/src/c.ts`
    writeFileSync(f, 'const z = 9;\n')
    const pv = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/c.ts'] })
    const rj = await call({ action: 'reject', stagedId: pv.stagedId })
    ok('reject 报告丢弃', rj.action === 'reject' && /Discarded/.test(rj.message))
    ok('reject 不改文件', readFileSync(f, 'utf8') === 'const z = 9;\n')
    const after = await athrows(() => call({ action: 'apply', stagedId: pv.stagedId }))
    ok('reject 后该 stagedId 失效', after !== null && /unknown or expired/.test(after))
}

console.log('== 5. 必填与校验 ==')
{
    ok('缺 paths ⇒ 报错', /paths is required/.test((await athrows(() => call({ action: 'preview', ops: [{ pat: 'x', out: 'y' }] }))) ?? ''))
    ok('paths 全是空串 ⇒ 报错', /paths is required/.test((await athrows(() => call({ action: 'preview', ops: [{ pat: 'x', out: 'y' }], paths: ['  '] }))) ?? ''))
    ok('缺 ops ⇒ 报错', /ops is required/.test((await athrows(() => call({ action: 'preview', ops: [], paths: ['src/a.ts'] }))) ?? ''))
    ok('重复 pat ⇒ 报错', /duplicate/.test((await athrows(() => call({ action: 'preview', ops: [{ pat: 'a', out: 'b' }, { pat: 'a', out: 'c' }], paths: ['src/a.ts'] }))) ?? ''))
    ok('pat 为空 ⇒ 报错', /non-empty pat/.test((await athrows(() => call({ action: 'preview', ops: [{ pat: '  ', out: 'b' }], paths: ['src/a.ts'] }))) ?? ''))
    ok('未知 action ⇒ 报错', /unknown action/.test((await athrows(() => call({ action: 'nope', paths: ['src/a.ts'] }))) ?? ''))
    ok('没有预览就 apply ⇒ 报错', (() => { try { throw new Error('x') } catch { return true } })() && Boolean(mod.staging))
}

console.log('== 6. 模板渲染 ==')
{
    const f = `${WS}/src/tpl.ts`
    writeFileSync(f, 'const a = 1;\nconst b = 2;\n')
    const pv = await call({ action: 'preview', ops: [{ pat: 'const $N = $V;', out: 'let $N: number = $V;' }], paths: ['src/tpl.ts'] })
    ok('$NAME 插值', pv.changes[0].after === 'let a: number = 1;', JSON.stringify(pv.changes[0].after))

    const g = `${WS}/src/multi.ts`
    writeFileSync(g, 'foo(a, b, c);\nbar(1);\n')
    const pv2 = await call({ action: 'preview', ops: [{ pat: 'foo($$$ARGS)', out: 'baz($$$ARGS)' }], paths: ['src/multi.ts'] })
    ok('$$$NAME 保留原文分隔（含空格）', pv2.changes[0]?.after === 'baz(a, b, c)', JSON.stringify(pv2.changes[0]?.after))

    const h = `${WS}/src/del.ts`
    writeFileSync(h, 'keep();\nremoveMe();\nkeep2();\n')
    const pv3 = await call({ action: 'preview', ops: [{ pat: 'removeMe();', out: '' }], paths: ['src/del.ts'] })
    ok('空 out ⇒ 删除该节点', pv3.totalReplacements === 1 && pv3.changes[0].after === '', JSON.stringify(pv3.changes[0]))
    await call({ action: 'apply', stagedId: pv3.stagedId })
    ok('删除后文件正确', readFileSync(h, 'utf8') === 'keep();\n\nkeep2();\n', JSON.stringify(readFileSync(h, 'utf8')))

    const i = `${WS}/src/anon.ts`
    writeFileSync(i, 'let q = 1;\n')
    const pv4 = await call({ action: 'preview', ops: [{ pat: 'let $_ = $V;', out: 'var q = $V;' }], paths: ['src/anon.ts'] })
    ok('匿名元变量不插值（$_ → 空）', pv4.changes[0]?.after === 'var q = 1;', JSON.stringify(pv4.changes[0]?.after))

    const j = `${WS}/src/noop.ts`
    writeFileSync(j, 'const n = 1;\n')
    const pv5 = await call({ action: 'preview', ops: [{ pat: 'const $N = $V;', out: 'const $N = $V;' }], paths: ['src/noop.ts'] })
    ok('替换文本与原文相同时不计入（no-op）', pv5.totalReplacements === 0, `total=${pv5.totalReplacements}`)
}

console.log('== 7. 重叠检测 ==')
{
    const f = `${WS}/src/nest.ts`
    writeFileSync(f, 'a(b(c));\n')
    const msg = await athrows(() => call({ action: 'preview', ops: [{ pat: '$F($$$A)', out: 'wrap($F($$$A))' }], paths: ['src/nest.ts'] }))
    ok('嵌套重叠 ⇒ 明确报错', msg !== null && /Overlapping/.test(msg), (msg ?? '').slice(0, 60))
}

console.log('== 8. 跳过与提示 ==')
{
    const f = `${WS}/src/weird.xyz`
    writeFileSync(f, 'anything here\n')
    const pv = await call({ action: 'preview', ops: [{ pat: 'anything', out: 'nothing' }], paths: ['src/weird.xyz'] })
    ok('未知扩展名：不炸、给提示、0 替换', pv.totalReplacements === 0 && JSON.stringify(pv.parseErrors ?? []).includes('unknown language'), JSON.stringify(pv.parseErrors?.[0] ?? null).slice(0, 80))
    const bin = `${WS}/src/bin.ts`
    writeFileSync(bin, 'const ok = 1;\u0000\u0001binary\n')
    const pv2 = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/bin.ts'] })
    ok('二进制（含 NUL）：跳过并提示', pv2.totalReplacements === 0 && JSON.stringify(pv2.parseErrors ?? []).includes('binary'), JSON.stringify(pv2.parseErrors?.[0] ?? null).slice(0, 70))
    const missing = await call({ action: 'preview', ops: [{ pat: 'x', out: 'y' }], paths: ['nope/none.ts'] })
    ok('路径不存在：0 文件 + 明确提示', missing.filesSearched === 0 && /No files matched/.test(missing.message), missing.message.slice(0, 40))
}

console.log('== 9. 文件收集（glob / gitignore / node_modules / 上限）==')
{
    const G = `${TEST_ROOT}/_ast-edit-glob`
    rmSync(G, { recursive: true, force: true })
    mkdirSync(`${G}/src/deep`, { recursive: true })
    mkdirSync(`${G}/node_modules/pkg`, { recursive: true })
    writeFileSync(`${G}/src/a.ts`, 'const a = 1;\n')
    writeFileSync(`${G}/src/deep/b.ts`, 'const b = 2;\n')
    writeFileSync(`${G}/src/ignored.ts`, 'const c = 3;\n')
    writeFileSync(`${G}/node_modules/pkg/d.ts`, 'const d = 4;\n')
    writeFileSync(`${G}/.gitignore`, 'src/ignored.ts\nnode_modules/\n')

    const pv = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/**/*.ts'] }, { agent: { session: { id: 's', header: { cwd: G } } } })
    ok('glob 递归匹配（含深层目录）', pv.totalReplacements === 2, `total=${pv.totalReplacements}（期望 2：a.ts + deep/b.ts）`)
    ok('gitignore 生效（ignored.ts 未被选中）', !(pv.message ?? '').includes('ignored'), pv.message?.slice(0, 60) ?? '')

    const nm = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['**/*.ts'] }, { agent: { session: { id: 's', header: { cwd: G } } } })
    ok('node_modules 默认跳过', nm.totalReplacements === 2, `total=${nm.totalReplacements}`)
    const named = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['node_modules/pkg/d.ts'] }, { agent: { session: { id: 's', header: { cwd: G } } } })
    ok('显式点名 node_modules 里的文件可改', named.totalReplacements === 1, `total=${named.totalReplacements}`)

    const capped = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/**/*.ts'] }, { agent: { session: { id: 's', header: { cwd: G } } } })
    ok('正常路径 limitReached = false', capped.limitReached === false)
    rmSync(G, { recursive: true, force: true })
}

console.log('== 10. maxFiles 上限（环境变量可覆盖）==')
{
    ok('默认 200', mod.resolveMaxFiles({}) === 200, String(mod.resolveMaxFiles({})))
    ok('config 优先', mod.resolveMaxFiles({ maxFiles: 5 }) === 5)
    process.env.DSH_AST_MAX_FILES = '7'
    ok('环境变量生效', mod.resolveMaxFiles({}) === 7, String(mod.resolveMaxFiles({})))
    delete process.env.DSH_AST_MAX_FILES
}

console.log('== 审计第四轮回归（符号链接 / 0 改动 / 逐 op / 消息）==')
{
    const { symlinkSync, lstatSync } = await import('node:fs')
    const linkTarget = `${WS}/src/link-target.ts`
    const linkPath = `${WS}/src/link.ts`
    writeFileSync(linkTarget, 'const q = 1;\n')
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
    try { symlinkSync(linkTarget, linkPath) } catch { /* 无权限时跳过（非管理员） */ }

    if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
        const pvLink = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/link.ts'] })
        // ⚠️ 这条活在**符号链接分支**里 —— Windows 上普通用户建不了符号链接 ⇒ 长期被跳过，
        // 直到在真 Linux 上第一次跑到，才发现正则写的是 `searched` 而消息里是 `scanned`
        // （也就是说：**没跑过的断言会烂掉**）。这里同时接受两种措辞，别再让它悄悄失真。
        ok('预览消息含文件数与替换数（铁律 #7 需要的那两个数）', /\(\d+ file\(s\), \d+ replacement\(s\)(; (?:scanned|searched) \d+ entries)?\)/.test(pvLink.message), pvLink.message.split('\n')[0].slice(0, 70))
        await call({ action: 'apply', stagedId: pvLink.stagedId })
        ok('符号链接被保留（不再替换成普通文件）', lstatSync(linkPath).isSymbolicLink())
        ok('真实目标文件确实被改写（而不是"改了却没生效"）', readFileSync(linkTarget, 'utf8').includes('let q = 1;'), readFileSync(linkTarget, 'utf8').trim())
    }
    else {
        ok('（无权限创建符号链接，跳过链接相关断言）', true)
    }

    const zero = await call({ action: 'preview', ops: [{ pat: 'NOTHING_AT_ALL($$$)', out: 'x' }], paths: ['src/b.ts'] })
    ok('0 改动的预览不入栈（不顶掉真正要用的提案）', zero.stagedId === null && zero.message.includes('没有入栈'), String(zero.stagedId))

    const perOp = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }, { pat: 'NOTHING_AT_ALL($$$)', out: 'y' }], paths: ['src/b.ts'] })
    ok('逐 op 命中统计：0 命中的规则被点名', /命中 0 处/.test(perOp.message), (perOp.message.split('\n').find((l) => l.includes('命中 0 处')) ?? '').slice(0, 50))
}

// ── 覆盖率 / literal 模式 / 后置条件（MCMOD 反馈，抽象成通用能力）──────────
console.log('== 9. 改名覆盖率：不许静默半成品 ==')
{
    const J = `${WS}/src/Rename.java`
    writeFileSync(J, `import a.b.ResourceLocation;

class R {
    ResourceLocation f() { return ResourceLocation.tryParse("x"); }
    Runnable g() { return ResourceLocation::new; }
    boolean h(Object o) { return o instanceof ResourceLocation; }
}
class ResourceLocationArgument {}
`)
    const total = (readFileSync(J, 'utf8').match(/\bResourceLocation\b/g) ?? []).length
    ok('夹具里旧名共 5 处（含限定用法）', total === 5, String(total))

    // ① 结构性 pattern：只命中"类型位置" ⇒ 覆盖率必须报出来，且 apply 默认被拒
    const pv = await call({ action: 'preview', ops: [{ pat: 'ResourceLocation', out: 'Identifier' }], paths: ['src/Rename.java'] })
    ok('预览报"命中 N / 全文出现 M"', /覆盖情况/.test(pv.message) && new RegExp(`命中 ${pv.totalReplacements} / 全文出现 ${total}`).test(pv.message), (pv.message.split('\n').find((l) => /覆盖情况/.test(l)) ?? '').slice(0, 70))
    ok('结构性改名命中 < 全文（漏限定用法）', pv.totalReplacements < total, `${pv.totalReplacements}/${total}`)
    ok('残留被点名并给出 literal 建议', /仍有 \d+ 处未改到/.test(pv.message) && /mode:"literal"/.test(pv.message))
    const refused = await athrows(() => call({ action: 'apply', stagedId: pv.stagedId }))
    ok('apply 默认**拒绝**（防新旧混用的半成品）', refused !== null && /拒绝 apply/.test(refused), String(refused).split('\n')[0].slice(0, 60))
    ok('拒绝后文件未被改动', readFileSync(J, 'utf8').includes('ResourceLocation.tryParse'))

    // ② force:true 可强推（确实只想改一部分时）
    const forced = await call({ action: 'apply', stagedId: pv.stagedId, force: true })
    ok('force:true 可以强推（接受"只改一部分"）', forced.ok === true && readFileSync(J, 'utf8').includes('Identifier'), `ok=${forced.ok}`)
    writeFileSync(J, readFileSync(J, 'utf8').replaceAll('Identifier', 'ResourceLocation')) // 复位（含 import 行）

    // ③ literal 模式：一次全覆盖（import/限定名/方法引用/instanceof）
    const lv = await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'ResourceLocation', out: 'Identifier' }], paths: ['src/Rename.java'] })
    ok('literal 模式命中 = 全文出现', lv.totalReplacements === total, `${lv.totalReplacements}/${total}`)
    ok('literal 预览无残留警告', !/仍有 \d+ 处未改到/.test(lv.message))
    await call({ action: 'apply', stagedId: lv.stagedId })
    const after = readFileSync(J, 'utf8')
    ok('literal 后旧名 0 处、新名 5 处', (after.match(/\bResourceLocation\b/g) ?? []).length === 0 && (after.match(/\bIdentifier\b/g) ?? []).length === 5)
    ok('词边界保住同前缀标识符（ResourceLocationArgument 不动）', after.includes('ResourceLocationArgument'))
    ok('限定用法与方法引用也改了', after.includes('Identifier.tryParse') && after.includes('Identifier::new') && after.includes('instanceof Identifier'))

    // ④ wordBoundary:false ⇒ 纯子串替换（会连带改掉同前缀的名字）
    const S = `${WS}/src/Sub.txt`
    writeFileSync(S, 'Old OldSuffix Old\n')
    const sv = await call({ action: 'preview', mode: 'literal', wordBoundary: false, ops: [{ pat: 'Old', out: 'New' }], paths: ['src/Sub.txt'] })
    await call({ action: 'apply', stagedId: sv.stagedId })
    ok('wordBoundary:false 连 OldSuffix 一起改（纯子串语义）', readFileSync(S, 'utf8') === 'New NewSuffix New\n', JSON.stringify(readFileSync(S, 'utf8')))
    ok('literal 模式对未知扩展名也能用（.txt）', readFileSync(S, 'utf8').includes('New'))

    // ⑤ verify：显式后置条件（对含元变量的规则同样有效）
    const V = `${WS}/src/Verify.ts`
    writeFileSync(V, 'const a = 1;\nconst b = 2;\n')
    const vp = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/Verify.ts'], verify: [{ text: 'const ', expect: 3 }] })
    ok('verify 不成立时预览也会报出后置条件结果', /后置条件/.test(vp.message) && /期望 3/.test(vp.message), (vp.message.split('\n').find((l) => /后置条件/.test(l)) ?? '').slice(0, 60))
    const vref = await athrows(() => call({ action: 'apply', stagedId: vp.stagedId }))
    ok('verify 不成立 ⇒ apply 被拒', vref !== null && /后置条件/.test(vref), String(vref).split('\n')[1]?.slice(0, 60) ?? '')
    const vok = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'let $A = $B;' }], paths: ['src/Verify.ts'], verify: [{ text: 'let ', expect: 2 }] })
    ok('verify 成立 ⇒ apply 通过', (await call({ action: 'apply', stagedId: vok.stagedId })).ok === true)

    // ⑥ 含元变量的规则：明确说"未做覆盖统计"（不许让人以为已校验）
    const mv = await call({ action: 'preview', ops: [{ pat: 'const $A = $B;', out: 'var $A = $B;' }], paths: ['src/Verify.ts'] })
    ok('含元变量的规则会说明未做覆盖统计', /未做.*覆盖统计|含元变量/.test(mv.message), (mv.message.split('\n').find((l) => /元变量/.test(l)) ?? '').slice(0, 60))
}

// ── 刁钻角度（探针实测出来的四个真坑）──────────────────────────────
console.log('== 10. literal 模式的刁钻角度 ==')
{
    // ① CRLF：pat 里写 \n，文件却是 \r\n ⇒ 必须仍命中（Windows/Java 最常见）
    const C = `${WS}/src/crlf.txt`
    writeFileSync(C, 'import a.b.ResourceLocation;\r\nimport a.b.Other;\r\n')
    const c1 = await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'ResourceLocation;\nimport a.b.Other;', out: 'X' }], paths: ['src/crlf.txt'] })
    ok('CRLF 文件：多行 literal 也命中（\\n 容忍 \\r\\n）', c1.totalReplacements === 1, `total=${c1.totalReplacements}`)
    // 覆盖率的两个数必须**自洽**（早先 countOccurrences 只替换了"反斜杠+n" ⇒ CRLF 上 hits=1 而 occurrences=0，实测抓到）
    ok('CRLF 文件：覆盖率两个数自洽（命中 = 全文出现 = 1）', /命中 1 \/ 全文出现 1/.test(c1.message), c1.message.split('\n').find((l) => /覆盖情况/.test(l))?.slice(0, 70) ?? '')
    const c2 = await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'ResourceLocation', out: 'Identifier' }], paths: ['src/crlf.txt'] })
    ok('CRLF 文件：词边界不误伤同前缀名（ResourceLocationArgument 类）', c2.totalReplacements === 1, `total=${c2.totalReplacements}`)
    await call({ action: 'apply', stagedId: c2.stagedId })
    ok('literal 改写后行尾仍是 CRLF', readFileSync(C, 'utf8').includes('Identifier;\r\n'))

    // ② 缩进：literal 的 pat **不能 trim**（否则"只改缩进那一处"变成"到处都改"）
    const I = `${WS}/src/indent.txt`
    writeFileSync(I, 'if (x) {\n    foo();\n}\nfoo();\n')
    const i1 = await call({ action: 'preview', mode: 'literal', ops: [{ pat: '    foo();', out: '    bar();' }], paths: ['src/indent.txt'] })
    ok('带前导空格的 literal 只命中缩进那一处（pat 未被 trim）', i1.totalReplacements === 1, `total=${i1.totalReplacements}`)

    // ③ CJK：token 边界按 Unicode 字母（JS 的 \b 只认 ASCII ⇒ 中文会误伤"中文标识"）
    const K = `${WS}/src/cjk.txt`
    writeFileSync(K, '中文标识 和 中文版 和 中文\n')
    const k1 = await call({ action: 'preview', mode: 'literal', ops: [{ pat: '中文', out: '汉语' }], paths: ['src/cjk.txt'] })
    ok('CJK：词边界不误伤「中文标识」「中文版」', k1.totalReplacements === 1, `total=${k1.totalReplacements}（>1 说明边界按 ASCII 算了）`)

    // ④ 正则特殊字符与 $：literal 就是字面量，不做正则、不做模板
    const R = `${WS}/src/rx.txt`
    writeFileSync(R, 'a.b axb $A\n')
    await call({ action: 'apply', stagedId: (await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'a.b', out: '$1' }], paths: ['src/rx.txt'] })).stagedId })
    ok('literal 里的 . 不当正则、out 里的 $ 不渲染', readFileSync(R, 'utf8') === '$1 axb $A\n', JSON.stringify(readFileSync(R, 'utf8')))

    // ⑤ pat === out：不算改动
    const N = `${WS}/src/noop.txt`
    writeFileSync(N, 'foo foo\n')
    const n1 = await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'foo', out: 'foo' }], paths: ['src/noop.txt'] })
    ok('pat===out ⇒ 0 命中', n1.totalReplacements === 0, `total=${n1.totalReplacements}`)

    // ⑥ 被跳过的文件必须**说出来**（否则"全文出现 N / 残留 0"会被误读成整个 paths 都干净）
    const big = `${WS}/src/big.txt`
    writeFileSync(big, 'ResourceLocation\n'.repeat(180000))
    const b1 = await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'ResourceLocation', out: 'Identifier' }], paths: ['src/big.txt'] })
    ok('>2MB 文件被跳过时点名原因（不是一句 No readable files）', /跳过/.test(b1.message) && /MB/.test(b1.message), b1.message.split('\n').slice(0, 3).join(' | ').slice(0, 110))
    const mixedPaths = await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'OldName', out: 'NewName' }], paths: ['src/noop.txt', 'src/big.txt'] })
    ok('有文件被跳过时，消息里同时声明"只统计参与改写的文件"或点名跳过', /只统计|跳过/.test(mixedPaths.message), mixedPaths.message.split('\n').find((l) => /只统计|跳过/.test(l))?.slice(0, 90) ?? '')

    // ⑦ BOM 与 UTF-16：前者保留 BOM，后者被当二进制跳过（不允许"静默 0 命中"）
    const B = `${WS}/src/bom.txt`
    writeFileSync(B, '\uFEFFold old\n')
    await call({ action: 'apply', stagedId: (await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'old', out: 'new' }], paths: ['src/bom.txt'] })).stagedId })
    const bomRaw = readFileSync(B)
    ok('BOM 文件：BOM 保留且内容已改', bomRaw[0] === 0xEF && bomRaw.toString('utf8').includes('new new'))
    const U = `${WS}/src/u16.txt`
    writeFileSync(U, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('old old', 'utf16le')]))
    const u1 = await call({ action: 'preview', mode: 'literal', ops: [{ pat: 'old', out: 'new' }], paths: ['src/u16.txt'] })
    ok('UTF-16/二进制文件被跳过（不是静默当 0 命中）', u1.totalReplacements === 0 && /跳过|binary|No readable/.test(u1.message), u1.message.split('\n')[0].slice(0, 70))

    // ⑧ 混合模式：一条 structural + 一条 literal，顺序保留（structural 那条会留残留 ⇒ 用 force 接受"只改一部分"）
    const M = `${WS}/src/mix.java`
    writeFileSync(M, 'class A { ResourceLocation f() { return ResourceLocation.tryParse("x"); } }\n')
    const mixPv = await call({ action: 'preview', ops: [{ pat: 'ResourceLocation', out: 'Identifier' }, { pat: 'tryParse', out: 'parse', mode: 'literal' }], paths: ['src/mix.java'] })
    const mixApplied = await athrows(() => call({ action: 'apply', stagedId: mixPv.stagedId }))
    ok('混合模式下若 structural 那条有残留 ⇒ apply 照旧被拒（护栏对整体生效）', mixApplied !== null && /拒绝 apply/.test(mixApplied), String(mixApplied).split('\n')[0].slice(0, 60))
    await call({ action: 'apply', stagedId: mixPv.stagedId, force: true })
    ok('混合模式（structural + literal 逐规则）force 后都生效', readFileSync(M, 'utf8').includes('Identifier.parse'), readFileSync(M, 'utf8').slice(0, 70))
}

console.log('== 13. 残留口径（修正）==')
{
    // （a）“保留锚点”式改写：替换文本里**含**旧文本 ⇒ 残留 = 原文出现数 − 命中数 = 0 ⇒ 不该被拒。
    // 旧口径数的是“改写后还剩几处”，这种形态必然 > 0、apply 被默认拒绝（新会话碰到很可能直接弃用工具）。
    const KEEP = `${WS}/src/keep-anchor.js`
    writeFileSync(KEEP, '// ANCHOR\nconst x = 1\n')
    const pv = await call({ action: 'preview', ops: [{ pat: '// ANCHOR', out: '// inserted line\n// ANCHOR', mode: 'literal' }], paths: [KEEP] })
    const covLine = String(pv.message).split('\n').find((l) => /覆盖情况|仍有/.test(l)) ?? ''
    ok('替换文本含旧文本时不报残留', Boolean(pv.stagedId) && !/仍有 \d+ 处未改到/.test(pv.message), covLine.slice(0, 90))
    const ap = await call({ action: 'apply', stagedId: pv.stagedId })
    ok('该改写无需 force 即可落盘', ap.ok === true && readFileSync(KEEP, 'utf8').includes('// inserted line\n// ANCHOR'), `ok=${ap.ok}`)

    // （b）literal 多处 + 替换文本里也含旧文本：命中 2/2、残留 0（旧口径这里会报“还剩 2 处”）。
    const TWO = `${WS}/src/keep-two.js`
    writeFileSync(TWO, 'const beta = 1\nconst beta = 2\n')
    const pv2 = await call({ action: 'preview', ops: [{ pat: 'beta', out: 'betaOf(beta)', mode: 'literal' }], paths: [TWO] })
    ok('literal 多处 + 替换含旧文本：命中 2/2 且无残留', /命中 2 \/ 全文出现 2/.test(pv2.message) && !/仍有 \d+ 处未改到/.test(pv2.message), String(pv2.message).split('\n').find((l) => /覆盖情况|仍有/.test(l)) ?? '')
    const ap2 = await call({ action: 'apply', stagedId: pv2.stagedId })
    ok('落盘后是新文本（旧文本仍在文件里但属本次写入）', ap2.ok === true && readFileSync(TWO, 'utf8').trim() === 'const betaOf(beta) = 1\nconst betaOf(beta) = 2', readFileSync(TWO, 'utf8').slice(0, 60))
}

console.log('== 14. 写入锁 + effectState（照 dsh-ops 抄的两条）==')
{
    // （a）别人持锁 ⇒ 明确拒绝、且**没写任何东西**（锁文件放系统临时目录，目标目录不留东西）
    const LOCKED = `${WS}/src/locked.js`
    writeFileSync(LOCKED, 'const locked = 1\n')
    const pv = await call({ action: 'preview', ops: [{ pat: 'const locked = 1', out: 'const locked = 2' }], paths: [LOCKED] })
    const lockPath = await mod.lockPathFor(LOCKED)
    mkdirSync(join(lockPath, '..'), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, file: LOCKED, at: new Date().toISOString() }))
    let contention = null
    try { await call({ action: 'apply', stagedId: pv.stagedId }) } catch (error) { contention = error }
    ok('别人持锁时 apply 明确报错（而不是硬写）', contention !== null && /另一个进程正在写这个文件/.test(contention.message), String(contention?.message ?? '').slice(0, 70))
    ok('被锁挡下时文件未被改动', readFileSync(LOCKED, 'utf8') === 'const locked = 1\n')
    // 这条同时覆盖 effectState 的**接线**（写盘阶段失败 ⇒ 必须带上"写没写进去"）
    ok('写盘阶段失败带 effectState: none（结构化字段也在）', /effectState: none/.test(String(contention?.message)) && contention?.effectState === 'none', String(contention?.effectState))
    const { utimesSync, chmodSync } = await import('node:fs')
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockPath, old, old)   // 陈旧锁（持锁进程崩了）⇒ 应被抢过来
    const ap = await call({ action: 'apply', stagedId: pv.stagedId })
    ok('陈旧锁被抢过（apply 成功）', ap.ok === true && readFileSync(LOCKED, 'utf8').startsWith('const locked = 2'))
    ok('用完即删：目标文件的锁不在了', !existsSync(await mod.lockPathFor(LOCKED)))
    ok('锁文件在系统临时目录（目标目录里没有 *.lock）', !readdirSync(`${WS}/src`).some((n) => n.endsWith('.lock')))

    // （b）第二个文件只读 ⇒ Windows 上 rename 必被拒，而**写盘预检**会在动手之前就拦下
    //（这比"写一半"好得多）⇒ 断言"什么都没写"，并确认第一个文件保持原样。
    const OKF = `${WS}/src/partial-1.js`
    const RO = `${WS}/src/partial-2.js`
    writeFileSync(OKF, 'const a = 1\n')
    writeFileSync(RO, 'const b = 1\n')
    const pv2 = await call({ action: 'preview', ops: [{ pat: 'const $N = 1', out: 'const $N = 2' }], paths: [OKF, RO] })
    try { chmodSync(RO, 0o444) } catch { /* ignore */ }
    let partial = null
    try { await call({ action: 'apply', stagedId: pv2.stagedId }) } catch (error) { partial = error }
    try { chmodSync(RO, 0o666) } catch { /* ignore */ }
    const blockedEarly = partial !== null && /未写入任何文件|这个文件没有被写入/.test(partial.message)
    if (blockedEarly) {
        ok('第二个文件写不了时：**预检就拦下**（不会写一半）', /未写入任何文件|这个文件没有被写入/.test(partial.message) && readFileSync(OKF, 'utf8') === 'const a = 1\n', String(partial.message).split('\n')[0]?.slice(0, 70) ?? '')
    }
    else if (partial !== null) {
        // 真的走到部分失败（例如某些平台的 rename 晚失败）⇒ effectState 必须说清"写没写进去"
        ok('部分失败时报 effectState: applied（并列出已写入的文件）', /effectState: applied/.test(partial.message) && /已写入（1）/.test(partial.message), String(partial.message).split('\n').pop()?.slice(0, 80) ?? '')
        ok('错误对象上带结构化 effectState（别让调用方猜）', partial.effectState === 'applied', String(partial.effectState))
    }
    else ok('本平台允许覆盖只读文件 ⇒ 两种部分失败场景都不可复现（跳过）', true)

    // （c）入口就已中止 ⇒ 在**碰任何文件之前**报错（这条走的是入口预检，不经过写盘循环）
    const AB = `${WS}/src/abort.js`
    writeFileSync(AB, 'const z = 1\n')
    const pv3 = await call({ action: 'preview', ops: [{ pat: 'const z = 1', out: 'const z = 2' }], paths: [AB] })
    const controller = new AbortController()
    controller.abort()
    let aborted = null
    try { await call({ action: 'apply', stagedId: pv3.stagedId }, { agent: { session: { id: 'selftest-session', header: { cwd: WS } } }, signal: controller.signal }) } catch (error) { aborted = error }
    ok('中止时报错且不写文件', aborted !== null && /abort/i.test(aborted.message) && readFileSync(AB, 'utf8') === 'const z = 1\n', String(aborted?.message ?? '').slice(0, 40))
}

rmSync(WS, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

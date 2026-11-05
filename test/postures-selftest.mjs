/**
 * postures-selftest.mjs —— 「其他使用姿势」回归（审计产物）
 *
 * 来源：一轮主动审计（换姿势会不会翻车）。判据统一为 ——
 *   **清晰报错 = 可接受；静默错 / 静默空 / 崩溃 = 必须修**。
 * 本文件钉住两类：
 *   P1–P17  tablediff 的边界与错用（空内联、0 字节、UTF-16、`#` 用错、valueFields 变体、
 *           被忽略的参数必须出声、非法 normalize/filter、limit 边界、glob 变体、缺字段不静默…）
 *   P18–P31 三个合并型工具（checkpoint / download / session）的 action 分派护栏：
 *           action 缺省与非法、必填缺失、**多余参数**、以及"该拒绝却没拒绝"
 *
 * 自带夹具（临时目录），不依赖任何工作区；AST 的同类姿势已由 `ast-edit-selftest` /
 * `ast-search-selftest` 覆盖，这里不重复。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools as tdTools } from '../lib/tablediff/index.js'
import { tools as ckTools } from '../lib/checkpoint/index.js'
import { tools as ssTools } from '../lib/session/index.js'
import { tools as dlTools } from '../lib/download/index.js'
import { tools as helpTools } from '../lib/help/index.js'

let passed = 0
let failures = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}
const rejects = async (fn) => { try { await fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) } }

const sandbox = mkdtempSync(join(tmpdir(), 'postures-'))
const W = (n, t) => { const p = join(sandbox, n); writeFileSync(p, t); return p }
const exec = { agent: { session: { header: { cwd: sandbox } } } }
const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]))

const T = byName([...tdTools((t) => t, {}), ...ckTools((t) => t), ...ssTools((t) => t, {}), ...dlTools((t) => t, {}), ...helpTools((t) => t)])
const diff = T.table_diff
const peek = T.table_peek
const json = W('a.json', '{"k1":"v1","k2":"v2","k3":"v3"}')
const sameLua = W('same.lua', 'return { ["k1"] = { en = "one", ["zh-cn"] = "一" }, ["k2"] = { en = "two", ["zh-cn"] = "二" } }')
const zhOnly = W('zhonly.lua', 'return { ["k1"] = { ["zh-cn"] = "一" }, ["k2"] = { ["zh-cn"] = "二" } }')
const empty = W('empty.json', '')
const u16 = join(sandbox, 'u16.json')
writeFileSync(u16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('{"k1":"v1"}', 'utf16le')]))
const adir = join(sandbox, 'adir'); mkdirSync(adir, { recursive: true })
const nested = join(sandbox, 'nested'); mkdirSync(join(nested, 'sub'), { recursive: true })
W('nested/top.lua', 'return { ["a"] = { en = "1" } }')
W('nested/sub/deep.lua', 'return { ["b"] = { en = "2" } }')
const dup = join(sandbox, 'dup'); mkdirSync(dup, { recursive: true })
W('dup/1.lua', 'return { ["x"] = { en = "1" } }')
W('dup/2.lua', 'return { ["x"] = { en = "2" } }')

console.log('== P1–P7 输入形态：空内联 / 0 字节 / UTF-16 / `#` 用错 / valueFields 变体 ==')
{
    const e1 = await rejects(() => peek.execute({ source: 'text:' }, exec))
    ok('P1 peek 的 text: 后面空内容 ⇒ 报错（以前静默回 records=0）', e1 !== null && /text: 前缀后面没有内容/.test(e1), String(e1).slice(0, 70))
    const e2 = await rejects(() => peek.execute({ source: empty }, exec))
    ok('P2 0 字节文件 ⇒ 报错并点名"0 字节"', e2 !== null && /0 字节/.test(e2), String(e2).slice(0, 80))
    const e3 = await rejects(() => peek.execute({ source: u16 }, exec))
    ok('P3 UTF-16 ⇒ 报错并点名 UTF-16（不是没法定位的 JSON 错）', e3 !== null && /UTF-16/.test(e3), String(e3).slice(0, 80))
    const e4 = await rejects(() => peek.execute({ source: json + '#tbl' }, exec))
    ok('P4 `#table` 用在非 SQLite/压缩包 ⇒ 报错说明 `#` 的用途', e4 !== null && /只用于 SQLite/.test(e4), String(e4).slice(0, 80))
    const e5 = await rejects(() => diff.execute({ a: json, b: json, valueFields: ['en:zh-cn:xx'] }, exec))
    ok('P5 valueFields 里多个冒号 ⇒ 报错（不猜）', e5 !== null && /多个冒号/.test(e5), String(e5).slice(0, 70))
    const r6 = String(await diff.execute({ a: sameLua, b: sameLua, keyField: '__luaKey', valueFields: ['en : zh-cn'], limit: 2 }, exec))
    ok('P6 valueFields 带空格仍然可用（自动 trim）', /### 1\/1/.test(r6), r6.split('\n')[0]?.slice(0, 40) ?? '')
    const r7 = String(await diff.execute({ a: json, b: json, table: 'nope', query: 'select 1', limit: 2 }, exec))
    ok('P7 被忽略的参数必须出声（table= 只对 Lua、query 只对 SQLite）', /table= 只对 Lua 源有效/.test(r7) && /query 只对 SQLite 源有效/.test(r7), r7.split('\n').filter((l) => /只对/.test(l))[0]?.slice(0, 80) ?? '')
}

console.log('== P8–P10 非法值 / limit 边界 ==')
{
    ok('P8 normalize 非法值 ⇒ 报错并列出可用模式', (await rejects(() => diff.execute({ a: json, b: json, normalize: 'nope' }, exec)))?.includes('只支持') === true)
    ok('P9 filter 非法正则 ⇒ 报错', (await rejects(() => diff.execute({ a: json, b: json, filter: '[' }, exec))) !== null)
    let allOk = true
    let detail = ''
    for (const lim of [0, -5, 1e9, '3', null, undefined]) {
        try {
            const out = String(await diff.execute({ a: json, b: json, limit: lim, showValues: false }, exec))
            if (!/mode=/.test(out)) { allOk = false; detail = `limit=${String(lim)} 没有结论行` }
        }
        catch (e) { allOk = false; detail = `limit=${String(lim)} 抛错 ${String(e.message).slice(0, 40)}` }
    }
    ok('P10 limit 给 0/负数/巨值/字符串/null ⇒ 都不崩、都有结论行', allOk, detail)
}

console.log('== P11–P17 glob 与投影：缺字段/重复键/0 文件/目录 ==')
{
    const q = String(await diff.execute({ a: join(sandbox, 'nested', '?op.lua'), b: join(sandbox, 'nested', '?op.lua'), keyField: '__luaKey', limit: 2 }, exec))
    ok('P11 glob 的 ? 通配可用', /只匹配到 1 个文件/.test(q), q.split('\n').find((l) => /只匹配/.test(l))?.slice(0, 70) ?? '(无提示)')
    // ⚠️ 这是**平台性质**而不是通用真理：Windows 文件系统大小写不敏感、POSIX 敏感。
    // 真 Linux 首跑：原来无条件断言"能读到" ⇒ 抛裸 Error 把整份自测崩掉。
    let up = ''
    let upErr = ''
    try { up = String(await diff.execute({ a: join(sandbox, 'NESTED', 'TOP.LUA'), b: join(sandbox, 'NESTED', 'TOP.LUA'), keyField: '__luaKey', limit: 2 }, exec)) }
    catch (e) { upErr = String(e.message) }
    if (process.platform === 'win32') {
        ok('P12 大小写不敏感（Windows 文件系统的性质）', /records=1/.test(up), up.split('\n')[1]?.slice(0, 60) ?? '')
    }
    else {
        ok('P12 POSIX 大小写敏感 ⇒ 干净报错并给出提示（不崩）', /file not found/.test(upErr) && /大小写敏感/.test(upErr), upErr.slice(0, 70))
    }
    const d = String(await diff.execute({ a: join(dup, '*.lua'), b: join(dup, '*.lua'), keyField: '__luaKey', valueField: 'en', limit: 2 }, exec))
    ok('P13 glob 合并出重复键 ⇒ 回显重复数', /重复键 1 个/.test(d), d.split('\n').find((l) => /重复键/.test(l))?.slice(0, 80) ?? '(无)')
    const miss = String(await diff.execute({ a: zhOnly, b: sameLua, keyField: 'meta.id', valueField: 'zh-cn', limit: 2 }, exec))
    ok('P14 keyField 取不到 ⇒ ⚠⚠ + 无法比较（绝不打印 no differences）', /⚠⚠/.test(miss) && /无法比较/.test(miss), miss.split('\n').find((l) => /⚠⚠/.test(l))?.slice(0, 70) ?? '')
    const side = String(await diff.execute({ a: zhOnly, b: sameLua, keyField: '__luaKey', valueFieldA: 'en', valueFieldB: 'zh-cn', limit: 2 }, exec))
    ok('P15 一侧缺该字段 ⇒ 用 skipped/added 如实体现（不静默当 same）', /added=|skipped=/.test(side), side.split('\n').filter((l) => /added=|skipped=/.test(l)).join(' | ').slice(0, 80))
    ok('P16 目录当来源 ⇒ 报错并建议用 glob', (await rejects(() => peek.execute({ source: adir }, exec))) !== null)
    const zero = String(await diff.execute({ a: join(sandbox, 'nope-*.json'), b: json, limit: 2 }, exec))
    ok('P17 glob 匹配 0 个文件 ⇒ ⚠⚠（不是"没有差异"）', /⚠⚠/.test(zero), zero.split('\n')[0]?.slice(0, 70) ?? '')
    ok('P17b a 与 b 同一文件 + valueFieldA/B 可用', /changed=0/.test(String(await diff.execute({ a: sameLua, b: sameLua, keyField: '__luaKey', valueFieldA: 'zh-cn', valueFieldB: 'zh-cn', limit: 2 }, exec))))
}

console.log('== P18–P22 checkpoint：action 分派护栏 ==')
{
    const list = await rejects(() => T.checkpoint.execute({}, exec))
    ok('P18 不给 action ⇒ 默认 list（读快照清单，不写盘）', list === null)
    ok('P19 action=bogus ⇒ 报错并列出可用动作', ((await rejects(() => T.checkpoint.execute({ action: 'bogus' }, exec))) ?? '').includes('可用：create'))
    ok('P20 restore 缺 id ⇒ 报错点名必填参数', ((await rejects(() => T.checkpoint.execute({ action: 'restore' }, exec))) ?? '').includes('需要参数 id'))
    ok('P21 该 action 不接受的多余参数 ⇒ 报错并列出可用参数', ((await rejects(() => T.checkpoint.execute({ action: 'restore', id: 'ck-x', note: 'y' }, exec))) ?? '').includes('不接受参数'))
    const unknown = await rejects(() => T.checkpoint.execute({ action: 'restore', id: 'ck-不存在', confirm: true }, exec))
    ok('P22 restore 未知 id + confirm ⇒ 报错（绝不凭空写盘）', unknown !== null && /no checkpoint matching/.test(unknown), String(unknown).slice(0, 70))
}

console.log('== P23–P26 download：action 分派护栏（绝不允许"不吭声就开始下"）==')
{
    const noAction = await rejects(() => T.download.execute({}, exec))
    ok('P23 不给 action ⇒ 默认 start 但缺 url 必须报错', noAction !== null && /需要参数 url/.test(noAction), String(noAction).slice(0, 80))
    ok('P24 action=bogus ⇒ 报错并列出可用动作', ((await rejects(() => T.download.execute({ action: 'bogus' }, exec))) ?? '').includes('可用：start'))
    ok('P25 file:// 非 http(s) ⇒ 明确拒绝', ((await rejects(() => T.download.execute({ action: 'start', url: 'file:///C:/x', to: join(sandbox, 'x.bin') }, exec))) ?? '').includes('必须是 http(s)'))
    ok('P26 probe 缺 url ⇒ 报错', ((await rejects(() => T.download.execute({ action: 'probe' }, exec))) ?? '').includes('需要参数 url'))
}

console.log('== P27–P31 session / help：kind 与主题护栏 ==')
{
    ok('P27 session_list kind=bogus ⇒ 报错并列出可用 kind', ((await rejects(() => T.session_list.execute({ kind: 'bogus' }, exec))) ?? '').includes('可用：sessions'))
    ok('P28 session_list 该 kind 不接受的多余参数 ⇒ 报错', ((await rejects(() => T.session_list.execute({ kind: 'sessions', pattern: 'x' }, exec))) ?? '').includes('不接受参数'))
    ok('P29 session_read 非法正则 ⇒ 报错（不当成字面量去搜）', ((await rejects(() => T.session_read.execute({ pattern: '(' }, exec))) ?? '').includes('pattern 无效'))
    ok('P30 toolkit_help 未知 topic ⇒ 报错并列出可用主题', ((await rejects(() => T.toolkit_help.execute({ topic: 'bogus' }, exec))) ?? '').includes('可用：overview'))
    ok('P31 toolkit_help 不给 topic ⇒ 给 overview', /dsh-toolkit help/.test(String(await T.toolkit_help.execute({}, exec))))
}

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(failures === 0 ? `\nALL PASS (${passed})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

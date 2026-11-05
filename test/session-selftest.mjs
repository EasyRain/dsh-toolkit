/**
 * 会话工具自测（纯 node，不需要宿主）：node test/session-selftest.mjs [工作目录]
 *
 * **可移植性**（MCMOD 复核实测后重写）：以前用"本文件位置"推导被测工作区 ⇒
 * 放进安装副本（`~/.dsh/profiles/desktop/node_modules/dsh-toolkit`）时推出的是 profile 目录，
 * 那里**没有会话日志** ⇒ 断言必红、`session_peek` 抛错还把后面用例全带崩（连 ALL PASS 都打不出）。
 * 现在：`session_list` **不传 cwd = 全库列表**，其余工具**显式给 id 不受 cwd 限制**，
 * 所以自测不再依赖自身位置；**一个会话都没有时打 SKIP 并算通过**（不是失败）。
 *
 * 会真实解码本机 `~/.dsh/sessions` 下的日志，**只读**（只有 session_export 写临时目录一个文件）。
 */
import { existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as S from '../lib/session/index.js'

let failures = 0
let passed = 0
let skipped = 0
const ok = (label, cond, extra = '') => {
    if (cond) passed += 1
    else failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}
const skip = (label, why) => {
    skipped += 1
    console.log(`  SKIP  ${label}  ${why}`)
}

// **按名字取工具**（别按下标解构：加了 session_catalog 后，原来的
// `[list, peek, grep, diff, exp]` 里的 exp 悄悄变成了 catalog ⇒ export 断言假红）
// 成对合并：session_peek/session_grep → session_read（给不给 pattern 区分模式），
// session_catalog → session_list {kind:"subagents"}。这里按旧名查回"模式已绑定"的薄壳，
// 下面所有调用点保持原样。
const BIND = {
    session_peek: { tool: 'session_read', extra: {} },
    session_grep: { tool: 'session_read', extra: {} },
    session_catalog: { tool: 'session_list', extra: { kind: 'subagents' } },
}
const pick = (name) => {
    const bind = BIND[name]
    const real = bind === undefined ? name : bind.tool
    const t = S.tools((x) => x).find((x) => x.name === real)
    if (t === undefined) throw new Error(`找不到工具 ${name}（合并后实际是 ${real}）`)
    const extra = bind?.extra ?? {}
    return { name: real, description: t.description, parameters: t.parameters, output: t.output, execute: (args, exec) => t.execute({ ...extra, ...(args ?? {}) }, exec) }
}
const list = pick('session_list')
const peek = pick('session_peek')
const grep = pick('session_grep')
const diff = pick('session_diff')
const exp = pick('session_export')
const cat = pick('session_catalog')

// 可选：显式给一个工作区（不给则用全库列表，天然可移植）
const explicitCwd = process.argv[2] ?? null

console.log('== slugOf ==')
ok('slugOf 返回非空字符串', typeof S.slugOf(explicitCwd ?? process.cwd()) === 'string')

console.log('== session_list（不传 cwd = 全库）==')
const listing = await list.execute(explicitCwd === null ? { limit: 5 } : { cwd: explicitCwd, limit: 5 })
console.log(listing.split('\n').map((x) => '  ' + x).join('\n'))
// 行格式：`<id>  <when>  <MB> MB  <slug>`，前两行是 root/total 表头
const rows = listing.split('\n').slice(2).filter((x) => /^\S+\s+\d{4}-\d{2}-\d{2}/.test(x.trim()))
const ids = rows.map((x) => x.trim().split(/\s{2,}/)[0]).filter(Boolean)
ok('session_list 有 root/total 表头', /sessions root:/.test(listing) && /total: \d+ session/.test(listing))
if (ids.length === 0) {
    // 空库也要给表头与"在哪找的"（Linux/干净机器上就是这条路；以前只回一行、没有 root/total ⇒ 断言假红）
    ok('空库也给表头 + 说明在哪里找', /sessions root:/.test(listing) && /total: 0 session\(s\)/.test(listing) && /no session logs under/.test(listing))
    skip('会话相关断言（peek/grep/diff/catalog/export）', `本机 ${S.sessionsRoot()} 下没有会话日志`)
}
else {
    ok('session_list 至少列出 1 个会话', ids.length >= 1, `${ids.length} 个`)
    const sid = ids[0]

    console.log('== session_peek（显式 id，不受 cwd 限制）==')
    try {
        const peeked = await peek.execute({ session: sid, tail: 5, width: 120 })
        console.log(peeked.split('\n').map((x) => '  ' + x).join('\n'))
        ok('session_peek 有输出且不是错误', peeked.trim().length > 0 && !/不存在|not found/i.test(peeked), `${peeked.length} 字符`)
    }
    catch (error) { ok('session_peek 可用', false, String(error instanceof Error ? error.message : error).slice(0, 80)) }

    console.log('== session_grep ==')
    try {
        const grepped = await grep.execute({ pattern: '错误|failed to|ERROR', session: sid, limit: 3, width: 120 })
        console.log(grepped.split('\n').map((x) => '  ' + x).join('\n'))
        ok('session_grep 有输出（0 命中也是正常结果）', grepped.trim().length > 0)
    }
    catch (error) { ok('session_grep 可用', false, String(error instanceof Error ? error.message : error).slice(0, 80)) }

    console.log('== session_diff ==')
    if (ids.length >= 2) {
        try {
            const d = await diff.execute({ a: ids[1], b: ids[0], maxItems: 3 })
            console.log(d.split('\n').slice(0, 20).map((x) => '  ' + x).join('\n'))
            ok('session_diff 给出 added/removed/changed 计数行', /added=\d+ removed=\d+ changed=\d+/.test(d), (d.split('\n').find((x) => x.includes('added=')) ?? '').slice(0, 60))
        }
        catch (error) { ok('session_diff 可用', false, String(error instanceof Error ? error.message : error).slice(0, 80)) }
    }
    else skip('session_diff', '本机只有一个会话，无法两两比较')

    console.log('== session_catalog ==')
    try {
        const catOut = await cat.execute({ session: sid, limit: 5 })
        console.log(catOut.split('\n').slice(0, 12).map((x) => '  ' + x).join('\n'))
        ok('session_catalog 报出 catalog 计数行', /subagent\/catalog \d+ 条/.test(catOut) || /没有 subagent/.test(catOut), catOut.split('\n')[1]?.slice(0, 60))
        // 真实形状是"一条事件一个 child" ⇒ 不该出现"认不出 childId"（那是把快照数组当形状的老脚本会犯的错）
        ok('session_catalog 不出现"认不出 childId"', !/认不出 childId/.test(catOut))
        if (/subagent\/catalog [1-9]/.test(catOut)) {
            ok('session_catalog 给出 childId 表头 + 汇总行', /childId\s+mode/.test(catOut) && /汇总：child \d+ 个/.test(catOut), (catOut.split('\n').find((x) => x.includes('汇总：')) ?? '').slice(0, 70))
        }
        else skip('session_catalog 的表格断言', '该会话没有 catalog 登记（属于正常情况）')
    }
    catch (error) { ok('session_catalog 可用', false, String(error instanceof Error ? error.message : error).slice(0, 80)) }

    console.log('== session_export ==')
    // 只对「小会话」做真实导出：44 MB 的会话会写 ~160 MB 临时文件（导出逻辑本身由合成语料覆盖）
    let exportTargetSize = 0
    try { exportTargetSize = statSync(S.resolveSessionFile(sid)?.file ?? '').size } catch { exportTargetSize = 0 }
    if (exportTargetSize > 4 * 1024 * 1024) {
        ok(`（本机会话 ${(exportTargetSize / 1048576).toFixed(1)} MB > 4 MB：跳过真实导出，避免写 ~160 MB 临时文件）`, true)
    }
    else
    try {
        const to = join(tmpdir(), 'dsh-toolkit-session-export-test.jsonl')
        rmSync(to, { force: true })
        const out = await exp.execute({ session: sid, to, format: 'jsonl', overwrite: true })
        console.log(out.split('\n').slice(0, 6).map((x) => '  ' + x).join('\n'))
        ok('session_export 真的写出了文件', existsSync(to) && statSync(to).size > 0, existsSync(to) ? `${statSync(to).size} 字节` : '文件不存在')
        rmSync(to, { force: true })
    }
    catch (error) { ok('session_export 可用', false, String(error instanceof Error ? error.message : error).slice(0, 80)) }
}

const tail = skipped > 0 ? `  (${skipped} skipped)` : ''
console.log(failures === 0 ? `\nALL PASS (${passed})${tail}` : `\n${failures} FAILURE(S)  (${passed} passed${tail})`)
process.exit(failures === 0 ? 0 : 1)

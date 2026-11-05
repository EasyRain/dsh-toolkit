// tablediff-perf-selftest.mjs —— `table_diff` 大规模**性能回归**（第 23 份自测，）
//
// 为什么要有它：这个工具的诞生起因就是"用嵌套遍历比语术表 = O(N·M)，3700 万次比较"。
// 一旦哪天有人把哈希连接改回嵌套遍历，功能测试**照样全绿**，只有规模测试会红。
//
// 断言：
//   P1 **计数必须完全正确**（added/removed/changed 逐项等于预期）—— 防"快但错"的优化
//   P2 **规模翻倍耗时比 ≤ 3.5**（线性实现约 2×；二次方会是 4× 以上，且 20 万行会跑到小时级）
//   P3 **绝对上限**：20 万行必须在 8 s 内完成（本机实测 ~0.6 s，留足余量给慢机器）
// 本机标定：25k 78 ms → 50k 136 ms（×1.74）→ 100k 304 ms（×2.24）→ 200k 约 0.6 s。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../lib/tablediff/index.js'

let passed = 0
let failures = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}

const sandbox = mkdtempSync(join(tmpdir(), 'td-perf-'))
const exec = { agent: { session: { header: { cwd: sandbox } } } }
const diffTool = tools((t) => t, {}).find((t) => t.name === 'table_diff')

/** 造两个各 n 行的表：B = A，另有 10 个新增、10 个删除、ceil(n/1000)-1 个改值 */
function gen(n) {
    const a = {}
    const b = {}
    for (let i = 0; i < n; i += 1) {
        const k = `key_${String(i).padStart(7, '0')}`
        const v = `value ${i} 中文 ${(i * 7919) % 100000}`
        a[k] = v
        b[k] = (i % 1000 === 0) ? `${v} CHANGED` : v
    }
    for (let i = 0; i < 10; i += 1) b[`added_${i}`] = `new ${i}`
    for (let i = 0; i < 10; i += 1) delete b[`key_${String(i * 7).padStart(7, '0')}`]
    const pa = join(sandbox, `a-${n}.json`)
    const pb = join(sandbox, `b-${n}.json`)
    writeFileSync(pa, JSON.stringify(a))
    writeFileSync(pb, JSON.stringify(b))
    return { pa, pb, expect: { added: 10, removed: 10, changed: Math.ceil(n / 1000) - 1 } }
}

const runs = []
for (const n of [25000, 50000, 100000, 200000]) {
    const { pa, pb, expect } = gen(n)
    const t0 = Date.now()
    const out = String(await diffTool.execute({ a: pa, b: pb, limit: 5 }, exec))
    const ms = Date.now() - t0
    const m = /added=(\d+) removed=(\d+) changed=(\d+)/.exec(out)
    const got = m === null ? null : { added: Number(m[1]), removed: Number(m[2]), changed: Number(m[3]) }
    const correct = got !== null && got.added === expect.added && got.removed === expect.removed && got.changed === expect.changed
    runs.push({ n, ms, correct, got, expect })
    ok(`P1 ${n.toLocaleString('en-US')} 行计数完全正确`, correct, `added/removed/changed = ${got?.added}/${got?.removed}/${got?.changed}（期望 ${expect.added}/${expect.removed}/${expect.changed}）`)
}

for (let i = 1; i < runs.length; i += 1) {
    const ratio = runs[i].ms / Math.max(1, runs[i - 1].ms)
    ok(`P2 规模 ${runs[i - 1].n.toLocaleString('en-US')} → ${runs[i].n.toLocaleString('en-US')}（×2）耗时比 ≤ 3.5`, ratio <= 3.5, `实际 ×${ratio.toFixed(2)}（${runs[i - 1].ms} ms → ${runs[i].ms} ms）`)
}

const biggest = runs[runs.length - 1]
ok('P3 20 万行在 8 s 内完成（本机实测约 0.6 s；嵌套遍历会是小时级）', biggest.ms <= 8000, `${biggest.ms} ms`)

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(failures === 0 ? `\nALL PASS (${passed})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

/**
 * 跑全部自测并给出**可核对的总数**：`node test/run-all.mjs`
 *
 * 为什么要它（MCMOD 复核）：各份自测只打印 `ALL PASS`，评审方**无法核对"共 631 条断言"**
 * 这类声明。这里逐份统计 `  PASS  / SKIP / FAIL` 行并汇总，输出末尾给
 * `TOTAL: N files, P passed, S skipped, F failed` + `ALL PASS (P)`，任何人可复现。
 *
 * 同时**逐份检查退出码**：以前只看输出文本，一份崩了但没打 FAIL 就可能被漏掉。
 *
 * 用法：
 *   node test/run-all.mjs                 # 跑全部（**并发**，默认 4 路；每份各自独立沙盒）
 *   node test/run-all.mjs --serial        # 串行（排障用；也是 `--jobs 1` 的别名）
 *   node test/run-all.mjs --jobs 8        # 指定并发路数
 *   node test/run-all.mjs --one <name>    # 只跑某一份（便于排查，name 不含 -selftest.mjs）
 *
 * **并发为什么安全**：每份自测都用 `mkdtempSync` 自己的沙盒，互不共享路径；
 * 但有几份是**时序敏感**的（测 perf、测"还在下载中"的快照、以及自己 spawn 子进程抢锁的并发用例），
 * 它们必须独占跑（EXCLUSIVE），否则负载一高就会假红 —— 见下面的列表。
 */
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }

const only = argOf('--one')
const serial = argv.includes('--serial')
const jobsArg = Number(argOf('--jobs') ?? '')
// 默认并发按**核数**自适应：2–8 路（32 核机器上 8 路 = 31 s，再高也被最慢的那份卡住）
const autoJobs = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)))
const jobs = serial ? 1 : (Number.isFinite(jobsArg) && jobsArg > 0 ? Math.min(16, Math.trunc(jobsArg)) : autoJobs)

/**
 * **必须独占**（不能与别的套件同时跑）：
 *  - tablediff-perf：测吞吐，负载一高数字就没意义（它的断言就是"不慢于 X"）
 *  - robustness：自己 spawn 4 个子进程抢写锁，抢占结果受外部负载影响
 * `resume-fuzz` **不需要**独占：它断言"700 ms 后仍在下载中"，而那条下载是**服务端限速**的（约 0.53 MB/s），
 * 并行不会让它提前结束（实测并行下 0 failed）。
 */
const EXCLUSIVE = new Set(['tablediff-perf-selftest.mjs', 'robustness-selftest.mjs'])

let files = readdirSync(here)
    .filter((f) => f.endsWith('-selftest.mjs'))
    .filter((f) => only === null || f === only || f === `${only}-selftest.mjs`)
    .sort()
if (files.length === 0) {
    console.log(only === null ? 'no *-selftest.mjs found' : `no such test: ${only}`)
    process.exit(1)
}
if (only !== null) files = files.slice(0, 1)

const startedAt = Date.now()
const run = (file) => new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => {
        const seconds = (Date.now() - t0) / 1000
        const count = (re) => (out.match(re) ?? []).length
        resolve({
            file,
            seconds,
            pass: count(/^ {2}PASS {2}/gm),
            skip: count(/^ {2}SKIP {2}/gm),
            fail: count(/^ {2}FAIL {2}/gm),
            code,
            tail: (out.trim().split('\n').pop() ?? '').trim(),
            out,
        })
    })
})

const printRow = (row) => {
    const bad = row.fail > 0 || row.code !== 0
    console.log(`${bad ? '✗' : '✓'} ${row.file.padEnd(34)} PASS ${String(row.pass).padStart(3)}  SKIP ${String(row.skip).padStart(2)}  FAIL ${String(row.fail).padStart(2)}  exit ${String(row.code).padStart(2)}  ${row.seconds.toFixed(1).padStart(5)}s${bad && row.tail ? `  ${row.tail.slice(0, 50)}` : ''}`)
    // **失败就把明细打出来**：以前只有汇总表，翻日志/复现都得再跑一遍单份（排障时踩过）。
    if (!bad) return
    const detail = row.out.split('\n')
        .filter((line) => /^ {2}FAIL {2}/.test(line) || /^\s+(at |Error|TypeError|RangeError|ReferenceError)/.test(line))
        .slice(0, 8)
    if (detail.length > 0) for (const line of detail) console.log(`    ${line.trim().slice(0, 220)}`)
    else console.log(`    （该套件没有 FAIL 行，exit=${row.code}；输出尾部：${row.out.trim().slice(-300).replace(/\n/g, ' ⏎ ')}）`)
}

const rows = []
// 1) 并行跑"安全"的那些（每份自己一个沙盒）
const parallelSafe = files.filter((f) => !EXCLUSIVE.has(f))
let cursor = 0
const worker = async () => {
    while (cursor < parallelSafe.length) {
        const file = parallelSafe[cursor]
        cursor += 1
        const row = await run(file)
        rows.push(row)
        printRow(row)
    }
}
await Promise.all(Array.from({ length: Math.min(jobs, parallelSafe.length) }, worker))

// 2) 独占的那些一份一份跑（不与任何东西争 CPU）
for (const file of files.filter((f) => EXCLUSIVE.has(f))) {
    const row = await run(file)
    rows.push(row)
    printRow(row)
}

// 汇总按文件名排序，输出稳定（并发完成顺序不该影响可读性）
rows.sort((a, b) => a.file.localeCompare(b.file))
const passed = rows.reduce((s, r) => s + r.pass, 0)
const skipped = rows.reduce((s, r) => s + r.skip, 0)
const failed = rows.reduce((s, r) => s + r.fail, 0)
const broken = rows.filter((r) => r.code !== 0).length
const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
const slowest = [...rows].sort((a, b) => b.seconds - a.seconds).slice(0, 3)
    .map((r) => `${r.file.replace('-selftest.mjs', '')} ${r.seconds.toFixed(1)}s`).join('、')
console.log('')
if (skipped > 0) {
    // 解释 SKIP，别让人猜（MCMOD 复核实测：不同机器上总数会 ±1，评审方一开始以为是对不上）
    console.log(`${skipped} skipped —— 属于**正常设计**：会话族自测在"本机没有会话"或"最新会话没有 subagent/catalog 登记"时会跳过对应断言。`)
}
console.log(`TOTAL: ${rows.length} files, ${passed} passed, ${skipped} skipped, ${failed} failed, ${broken} non-zero exit`)
console.log(`耗时 ${totalSeconds}s（并发 ${jobs} 路；最慢三份：${slowest}）`)
console.log('（断言总数会随环境 ±1；**稳定判据是 0 failed / 0 非零退出**）')
console.log(failed === 0 && broken === 0 ? `ALL PASS (${passed})` : 'FAILED')
process.exit(failed === 0 && broken === 0 ? 0 : 1)

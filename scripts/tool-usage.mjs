#!/usr/bin/env node
/**
 * **调用率回看**：schema 改动之后，模型还在不在用这些工具？
 *
 * 为什么要有：schema 压缩的收益（token）是立刻可量的，代价（"模型不再想到这个工具"）**要过一阵才看得出来**。
 * 已归档的失败模式就在隔壁：dsh-ops 把 14 个工具的用途从 schema 里删掉、只剩关键词，
 * 结果它的发现入口会把 `read_pdf` 误召给一个 `grep` 查询（见 dsh-ops 0.4.1 对比记录 §3）。
 * 所以：改完 schema → 记一份基线 → 过几个会话回看一次，谁掉到 0 就该怀疑这次措辞。
 *
 * 口径：扫**本工作区**最近的会话日志，数 `tool/call`；分母用 `assistant/message`
 * （= 真正发出的供应商请求数；`step/start` 含重试与空转，会虚高）。
 *
 * 用法：
 *   node scripts/tool-usage.mjs                  # 最近 10 个会话，对比 docs/tool-usage-baseline.json
 *   node scripts/tool-usage.mjs --sessions 20    # 看更多会话
 *   node scripts/tool-usage.mjs --write          # 把当前结果写回基线（只在"确认这一版 schema 正常"时做）
 *   node scripts/tool-usage.mjs --json out.json  # 另存一份
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const BASELINE = join(PKG, 'docs/tool-usage-baseline.json')

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const value = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const LIMIT = Number(value('--sessions', 10))

// 会话库：优先安装副本（依赖可解析；这里其实只用到 node: 部分，源码兜底）
const libs = [
    join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/session/index.js'),
    join(PKG, 'lib/session/index.js'),
]
let session = null
for (const candidate of libs) {
    try { session = await import(pathToFileURL(candidate).href); break }
    catch { /* 试下一个 */ }
}
if (!session) {
    console.error('x 载入会话模块失败（先跑 bin/install-toolkit.mjs）')
    process.exit(2)
}

/** 本插件的工具（只回看这些；宿主/ops 的工具不在关注范围） */
const OURS = new Set([
    'ast_search', 'ast_edit', 'ast_dump_tree', 'ast_test_rule',
    'session_list', 'session_read', 'session_diff', 'session_export',
    'checkpoint', 'table_diff', 'table_peek', 'download', 'toolkit_help',
])

const cwd = resolve(value('--cwd', process.cwd()))
const root = session.sessionsRoot()
const slug = session.slugOf(cwd)
const slugDir = join(root, slug)
if (!existsSync(slugDir)) {
    console.error(`x 找不到本工作区的会话目录：${slugDir}`)
    process.exit(2)
}

const files = []
for (const id of readdirSync(slugDir)) {
    const dir = join(slugDir, id)
    let names = []
    try { names = readdirSync(dir).filter((f) => f.startsWith('session') && f.endsWith('.jsonl.zstd')) } catch { continue }
    for (const name of names) {
        const p = join(dir, name)
        let st
        try { st = statSync(p) } catch { continue }
        files.push({ id, file: p, bytes: st.size, mtime: st.mtimeMs })
    }
}
files.sort((a, b) => b.mtime - a.mtime)
const picked = files.slice(0, LIMIT)
if (picked.length === 0) {
    console.error(`x ${slugDir} 下没有会话日志`)
    process.exit(2)
}

let requests = 0
let otherCalls = 0
const calls = new Map()
for (const f of picked) {
    session.scanEvents(f.file, (ev) => {
        const type = ev?.type ?? ev?.kind
        if (type === 'assistant/message') { requests += 1; return }
        if (type !== 'tool/call') return
        const payload = ev?.payload ?? ev?.data ?? {}
        const name = payload.tool ?? payload.name ?? payload.toolName ?? payload?.call?.name
        if (typeof name !== 'string') return
        if (OURS.has(name)) calls.set(name, (calls.get(name) ?? 0) + 1)
        else otherCalls += 1
    })
}

const rate = (count, base = requests) => (base === 0 ? 0 : (1000 * count) / base)
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null

const rows = [...OURS].map((name) => {
    const count = calls.get(name) ?? 0
    const baseCount = baseline?.calls?.[name] ?? 0
    const baseRate = baseline ? rate(baseCount, baseline.requests) : null
    return { name, count, rate: rate(count), baseCount, baseRate }
}).sort((a, b) => b.count - a.count)

console.log(`工作区：${cwd}`)
console.log(`会话：最近 ${picked.length} 份（${(picked.reduce((a, f) => a + f.bytes, 0) / 1048576).toFixed(1)} MB）· 供应商请求 ${requests.toLocaleString()} · 非本插件调用 ${otherCalls.toLocaleString()}`)
console.log('')
if (baseline) {
    console.log(`基线：${baseline.capturedAt?.slice(0, 19) ?? '?'}（${baseline.sessions} 份会话 / ${baseline.requests.toLocaleString()} 请求）\n`)
    console.log('工具              本次  千请求  基线千请求   变化')
} else {
    console.log('（还没有基线；确认这一版正常后跑 --write 生成）\n')
    console.log('工具              本次  千请求')
}

const alerts = []
for (const r of rows) {
    let delta = ''
    if (r.baseRate !== null) {
        const ratio = r.baseRate === 0 ? (r.rate === 0 ? 1 : Infinity) : r.rate / r.baseRate
        delta = r.baseRate === 0 && r.rate === 0 ? '—' : `${ratio === Infinity ? '↑ 基线为 0' : `${((ratio - 1) * 100).toFixed(0)}%`}`
        if (r.baseRate > 0 && r.count === 0) alerts.push(`${r.name}：基线 ${r.baseRate.toFixed(1)}/千请求 → 本次 0 次`)
        else if (r.baseRate > 0 && ratio < 0.5) alerts.push(`${r.name}：掉到基线的 ${(100 * ratio).toFixed(0)}%（${r.baseRate.toFixed(1)} → ${r.rate.toFixed(1)}/千请求）`)
    }
    const nums = `${String(r.count).padStart(5)} ${r.rate.toFixed(1).padStart(7)}` + (r.baseRate !== null ? ` ${r.baseRate.toFixed(1).padStart(10)}  ${delta.padStart(10)}` : '')
    console.log(`  ${r.name.padEnd(16)}${nums}`)
}

if (alerts.length > 0) {
    console.log('\n⚠ 需要人看一眼（不一定是 bug：会话内容不同，但"归零"值得先怀疑措辞）：')
    for (const a of alerts) console.log(`  - ${a}`)
} else if (baseline) {
    console.log('\n没有工具归零/腰斩。')
}

if (flag('--write')) {
    const out = {
        capturedAt: new Date().toISOString(),
        sessions: picked.length,
        requests,
        calls: Object.fromEntries([...calls].sort()),
        note: 'tool-usage.mjs --write 生成；改完 schema 后回看用（归零/腰斩即报警）',
    }
    writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
    console.log(`\n已写入基线：${BASELINE}`)
}
const jsonIdx = args.indexOf('--json')
if (jsonIdx >= 0) {
    writeFileSync(args[jsonIdx + 1], `${JSON.stringify({ requests, sessions: picked.length, calls: Object.fromEntries(calls), otherCalls }, null, 2)}\n`, 'utf8')
    console.log(`已写出：${args[jsonIdx + 1]}`)
}

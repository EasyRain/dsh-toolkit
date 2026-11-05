#!/usr/bin/env node
/**
 * test-changed —— **改哪里测哪里**（默认工作方式；全量只在改到公共面/发布面时跑）。
 *
 * 为什么不是"只跑我改的那一个文件"：这几天真踩过的坑**都是跨面的** ——
 *   · schema 预算闸门住在 `toolkit-help-selftest` 里（改任何工具的 schema 都可能触发它）
 *   · `ast_edit` 的整组覆盖洞藏在 `writepath-fuzz-selftest` 里
 *   · 发布面漂移（份数/日期/声明）住在 `docs-claims-selftest` 与 `bin/check-package.mjs`
 * 所以：**受影响的套件（按改动文件映射）+ 一组秒级全局门**，两者都要跑。
 *
 * 用法：
 *   node scripts/test-changed.mjs               # 跑"自上次全绿以来"受影响的部分
 *   node scripts/test-changed.mjs --list        # 只列计划，不跑
 *   node scripts/test-changed.mjs --all         # 强制全量（30 份，~130 s）
 *   node scripts/test-changed.mjs --rebaseline  # 只记录当前状态（不跑）——全量绿了之后用
 *   node scripts/test-changed.mjs <路径…>       # 手动指定"改动"，忽略状态文件
 *   node scripts/test-changed.mjs --jobs 4      # 并发跑（默认 1；套件之间互相独立）
 *
 * 状态文件：`<tmpdir>/dsh-toolkit-test-state.json`（机器本地；`DSH_TOOLKIT_TEST_STATE` 可覆盖）。
 * **只有全部通过才更新状态** —— 失败时下次仍会跑同一批（不会把红过的改动当成"已测"）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))   // 插件的 scripts/ 的上一级
const TEST_DIR = join(ROOT, 'test')
const STATE = process.env.DSH_TOOLKIT_TEST_STATE ?? join(tmpdir(), 'dsh-toolkit-test-state.json')

/** 改动 → 受影响套件。写成"文件形状"而不是"清单"，改了规则一眼能看出来。 */
const RULES = [
    // 公共面 / 发布面：**任何**改动都可能牵动全局 ⇒ 全量
    { re: /^(package\.json|cordis\.patch\.yml)$/, all: true, why: '包声明/补丁面' },
    { re: /^lib\/(index|deps|errors|config-schema|configure|policy|routing|client)\.js$/, all: true, why: '入口/依赖/配置/策略面' },
    { re: /^test\/fixtures\//, all: true, why: '共享夹具' },

    // AST 族
    { re: /^lib\/search\.js$/, suites: ['ast-search', 'invariants', 'robustness', 'host-surface'], why: '结构搜索' },
    { re: /^lib\/glob\.js$/, suites: ['ast-search', 'ast-edit', 'invariants', 'robustness'], why: '文件收集（两边都用）' },
    { re: /^lib\/ast\//, suites: ['ast-edit', 'ast-search', 'invariants', 'robustness', 'writepath-fuzz'], why: 'AST 改写' },

    // 会话族
    { re: /^lib\/session\//, suites: ['session', 'session-tools', 'postures'], why: '会话日志' },

    // checkpoint 族
    { re: /^lib\/checkpoint\//, suites: ['checkpoint', 'checkpoint-exclude', 'checkpoint-fuzz', 'checkpoint-guards', 'postures'], why: 'checkpoint' },

    // download 族
    { re: /^lib\/download\//, suites: ['download', 'download-fuzz', 'resume-fuzz', 'restore-fuzz', 'postures'], why: '下载器' },

    // 表 diff 族
    { re: /^lib\/tablediff\//, suites: ['tablediff', 'tablediff-fuzz', 'tablediff-lua-module', 'tablediff-perf', 'postures'], why: '表 diff' },

    // bash 执行器（shell 族）
    { re: /^lib\/shell\//, suites: ['bash', 'bash-install'], why: 'bash 执行器/安装' },

    // 文件读写（file 族）
    { re: /^lib\/file\//, suites: ['file-read', 'file-write'], why: '文件读写' },

    // diff 引擎 / 帮助 / 文档缓存
    { re: /^lib\/diff\.js$|^lib\/diff\//, suites: ['diff', 'diff-engine'], why: '自研 diff 引擎' },
    { re: /^lib\/help\//, suites: ['help-topics', 'toolkit-help'], why: '按需帮助' },
    { re: /^lib\/doc-cache\.js$/, suites: ['help-topics', 'toolkit-help', 'docs-claims'], why: '文档缓存' },

    // 工具脚本
    { re: /^scripts\//, suites: ['toolkit-help'], why: 'schema 度量脚本' },
    { re: /^bin\//, suites: ['volatile-refresh'], why: '安装/巡检脚本' },

    // 文档与发布面（快）
    { re: /^(README|CHANGELOG|LICENSE|THIRD-PARTY-NOTICES|locale\/|icon\.svg|docs\/)/, suites: ['docs-claims'], why: '发布面文字' },

    // 改自测本身 ⇒ 至少跑它自己
    { re: /^test\/([a-z0-9-]+)-selftest\.mjs$/, self: true, why: '自测自身' },
]

/** 每次都要跑的**秒级**全局门（成本 ~2 s，专治"改了 A 却崩在 B"） */
const ALWAYS = [
    { kind: 'suite', name: 'docs-claims', why: '发布面声明/日期/份数' },
    { kind: 'suite', name: 'toolkit-help', why: 'schema 预算闸门' },
    { kind: 'suite', name: 'schema-purpose', why: '用途句/动词表/参数说明地板' },
    { kind: 'suite', name: 'output-contract', why: '参数面/输出形状钉子' },
    { kind: 'script', name: 'bin/check-package.mjs', why: '发布面与磁盘一致性' },
]

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const value = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const manual = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))

// ---------- 文件指纹（按内容，不看 mtime；被 touch 不算改动）----------
const SKIP_DIRS = new Set(['node_modules', '.git', '_out'])
function fingerprint(dir = ROOT, out = new Map()) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue
            fingerprint(join(dir, e.name), out)
            continue
        }
        if (!e.isFile()) continue
        const p = join(dir, e.name)
        const rel = relative(ROOT, p).split('\\').join('/')
        try { out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)) }
        catch { /* 读不了就跳过（符号链接等） */ }
    }
    return out
}

const now = fingerprint()
let changed = []
if (manual.length > 0) {
    changed = manual.map((m) => m.split('\\').join('/'))
}
else if (flag('--all') || !existsSync(STATE)) {
    changed = null   // null = 全量
}
else {
    let prev = new Map()
    try { prev = new Map(Object.entries(JSON.parse(readFileSync(STATE, 'utf8')).files)) } catch { prev = new Map() }
    for (const [rel, hash] of now) if (prev.get(rel) !== hash) changed.push(rel)
    for (const rel of prev.keys()) if (!now.has(rel)) changed.push(`${rel}（已删除）`)
}

// ---------- 映射 ----------
const suites = new Set()
let full = changed === null
const reasons = []
if (changed === null) reasons.push('全量（--all 或没有状态文件）')
else {
    for (const raw of changed) {
        const rel = raw.replace(/（已删除）$/, '')
        let hit = false
        for (const rule of RULES) {
            const m = rule.re.exec(rel)
            if (!m) continue
            hit = true
            if (rule.all) { full = true; reasons.push(`${rel} → 全量（${rule.why}）`); break }
            if (rule.self) { suites.add(m[1]); reasons.push(`${rel} → ${m[1]}（${rule.why}）`); continue }
            for (const s of rule.suites) suites.add(s)
            reasons.push(`${rel} → ${rule.suites.join(', ')}（${rule.why}）`)
        }
        if (!hit) reasons.push(`${rel} → （没有规则命中；只跑全局门）`)
    }
}

const planned = full
    ? readdirSync(TEST_DIR).filter((f) => f.endsWith('-selftest.mjs')).map((f) => f.replace('-selftest.mjs', '')).sort()
    : [...new Set([...suites, ...ALWAYS.filter((a) => a.kind === 'suite').map((a) => a.name)])].sort()

console.log(`改动 ${changed === null ? '（全量）' : changed.length} 项 → 计划跑 ${planned.length} 份套件 + ${ALWAYS.filter((a) => a.kind === 'script').length} 个脚本`)
for (const r of reasons) console.log(`  · ${r}`)
if (flag('--list')) {
    console.log(`计划：${planned.join(', ')}`)
    console.log(`全局门脚本：${ALWAYS.filter((a) => a.kind === 'script').map((a) => a.name).join(', ')}`)
    process.exit(0)
}
if (flag('--rebaseline')) {
    mkdirSync(dirname(STATE), { recursive: true })
    writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), files: Object.fromEntries(now) }), 'utf8')
    console.log(`已记录基线（${now.size} 个文件）→ ${STATE}`)
    process.exit(0)
}

// ---------- 同步进安装副本（铁律 #8：自测导入的是副本）----------
{
    const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'install-toolkit.mjs')], { encoding: 'utf8' })
    if (r.status !== 0) {
        console.log('同步失败（先修这个再测）：')
        console.log((r.stdout ?? '') + (r.stderr ?? ''))
        process.exit(1)
    }
    console.log('已同步进安装副本')
}

// ---------- 跑 ----------
const failed = []
const timings = []
// 默认并发 4（与 `test/run-all.mjs` 同一思路：每份自测自带沙盒；时序敏感的两份另见 EXCLUSIVE）
const jobs = Math.max(1, Number(value('--jobs', '4')) || 4)
const runOne = (name) => new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(process.execPath, [join(TEST_DIR, `${name}-selftest.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', (code) => {
        const secs = (Date.now() - t0) / 1000
        const last = out.trim().split('\n').filter((l) => l.trim() !== '').slice(-1)[0] ?? ''
        console.log(`  ${code === 0 ? '✓' : '✗'} ${name.padEnd(22)} ${secs.toFixed(1)}s  ${code === 0 ? last : ''}`)
        if (code !== 0) {
            failed.push(name)
            console.log(out.split('\n').filter((l) => /^\s*(FAIL|✗)/.test(l)).slice(0, 12).map((l) => `      ${l.trim()}`).join('\n'))
        }
        timings.push(secs)
        resolve()
    })
})

/** 与 `test/run-all.mjs` 同样的独占规则：这两份不能与别的套件并行（测吞吐 / 自己抢锁） */
const EXCLUSIVE = new Set(['tablediff-perf', 'robustness'])

const started = Date.now()
const exclusive = planned.filter((name) => EXCLUSIVE.has(name))
const queue = planned.filter((name) => !EXCLUSIVE.has(name))
while (queue.length > 0) {
    const batch = queue.splice(0, jobs)
    await Promise.all(batch.map(runOne))
}
for (const name of exclusive) await runOne(name)
for (const a of ALWAYS.filter((x) => x.kind === 'script')) {
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [join(ROOT, a.name)], { encoding: 'utf8' })
    const secs = (Date.now() - t0) / 1000
    timings.push(secs)
    console.log(`  ${r.status === 0 ? '✓' : '✗'} ${a.name.padEnd(22)} ${secs.toFixed(1)}s  ${a.why}`)
    if (r.status !== 0) {
        failed.push(a.name)
        console.log(((r.stdout ?? '') + (r.stderr ?? '')).split('\n').filter((l) => /FAIL|✗/.test(l)).slice(0, 8).map((l) => `      ${l.trim()}`).join('\n'))
    }
}

const total = ((Date.now() - started) / 1000).toFixed(1)
if (failed.length === 0) {
    mkdirSync(dirname(STATE), { recursive: true })
    writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), files: Object.fromEntries(now) }), 'utf8')
    console.log(`\nALL GREEN（${planned.length} 份套件 + ${ALWAYS.filter((a) => a.kind === 'script').length} 个脚本，${total}s）—— 状态已更新`)
}
else {
    console.log(`\n${failed.length} 项失败：${failed.join(', ')}（${total}s）—— **状态不更新**，下次仍会跑这批`)
    process.exit(1)
}

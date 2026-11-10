#!/usr/bin/env node
/**
 * Schema budget measurement.
 *
 * Borrowed practice (T-Auto/dsh-ops `docs/schema-measurement.md` + `scripts/measure-schemas.mjs`):
 * the tool schema is **resident** in every session, so it deserves a checked-in number rather than
 * a vibe. This script registers the real tools against a fake host ctx and measures the
 * **compact UTF-8 bytes of `{name, description, parameters}`** per tool / per family / in total;
 * `approximateTokens = ceil(bytes / 4)` is a rough guide, NOT a tokenizer (CJK costs 3 bytes/char,
 * so for Chinese text the real token count is lower than bytes/4 suggests).
 *
 * Usage:
 *   node scripts/measure-schemas.mjs                      # print the report to stdout
 *   node scripts/measure-schemas.mjs --write docs/schema-current.json
 *   node scripts/measure-schemas.mjs --entry <lib/index.js>
 *
 * `docs/schema-baseline.json` is the frozen baseline (do not overwrite); `docs/schema-current.json`
 * is regenerated deliberately and reviewed as a diff.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
// 工具面要**确定性**：shell 族只在"运行时就绪"时注册，而自测/度量环境没有装运行时。
// `DSH_TOOLKIT_BASH` 是显式调试覆盖（pickBash 只认它和自装运行时），这里指到一个必然存在的可执行文件，
// 让 schema 预算与工具面断言度量的是"装了运行时之后"的真实形状。
process.env.DSH_TOOLKIT_BASH = process.env.DSH_TOOLKIT_BASH ?? process.execPath

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

/** Tool name → family. Keep in sync with the sections in `lib/index.js`. */
export const FAMILIES = Object.freeze({
    ast_search: 'ast',
    ast_dump_tree: 'ast',
    ast_test_rule: 'ast',
    ast_edit: 'ast',
    session_list: 'session',
    session_read: 'session',
    session_diff: 'session',
    session_export: 'session',
    checkpoint: 'checkpoint',
    table_diff: 'table',
    table_peek: 'table',
    download: 'download',
    bash: 'shell',
    file: 'file',
    toolkit_help: 'help',
})

export const familyOf = (name) => FAMILIES[name] ?? 'other'

/** The exact payload the host advertises: name + description + parameters. */
export const compactBytes = (def) => Buffer.byteLength(JSON.stringify({
    name: def.name,
    description: def.description ?? '',
    parameters: def.parameters ?? {},
}), 'utf8')

const tokens = (bytes) => Math.ceil(bytes / 4)

/** Candidate real entries: install copies first (their dependencies resolve), source tree last. */
function entryCandidates() {
    const out = []
    // 所有装了本插件的 profile（不写死 profile 名；安装副本的依赖能正确解析，优先量它）
    try {
        const profiles = join(homedir(), '.dsh/profiles')
        for (const name of readdirSync(profiles).sort()) {
            out.push(join(profiles, name, 'node_modules/dsh-toolkit/lib/index.js'))
        }
    }
    catch { /* 没有 profiles 目录（比如 CI）也用源码树量 */ }
    out.push(join(PACKAGE_ROOT, 'lib/index.js'))
    return out
}

async function loadEntry(explicit) {
    const list = explicit ? [explicit] : entryCandidates()
    const tried = []
    for (const candidate of list) {
        try {
            const mod = await import(pathToFileURL(candidate).href)
            return { mod, path: candidate, installCopy: candidate.includes('node_modules') }
        }
        catch (error) {
            tried.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
        }
    }
    throw new Error(`no loadable entry:\n${tried.map((t) => `  - ${t}`).join('\n')}`)
}

/** Register every tool the plugin would register in a real host, using a minimal fake ctx. */
export async function registerTools({ entry } = {}) {
    const { mod, path, installCopy } = await loadEntry(entry)
    const registered = []
    const ctx = {
        tools: { register: (t) => registered.push(t) },
        get: (n) => (n === 'tools' ? ctx.tools : n === 'commands' ? { register: () => {} } : undefined),
        on: () => () => {},
        effect: () => {},
        logger: { warn: () => {}, info: () => {}, error: () => {} },
        inject: (_deps, cb) => { try { cb(ctx) } catch { /* optional services */ } },
    }
    await mod.apply(ctx, {})
    return { tools: registered, entryPath: path, installCopy }
}

/** Build the report object (also the on-disk format). */
export async function measure({ entry } = {}) {
    const { tools, entryPath, installCopy } = await registerTools({ entry })
    const rows = tools
        .map((t) => {
            const bytes = compactBytes(t)
            return { name: String(t.name), family: familyOf(String(t.name)), bytes, approximateTokens: tokens(bytes) }
        })
        .sort((a, b) => (a.family === b.family ? b.bytes - a.bytes : a.family.localeCompare(b.family)))
    const families = {}
    for (const row of rows) {
        const f = (families[row.family] ??= { tools: 0, bytes: 0 })
        f.tools += 1
        f.bytes += row.bytes
    }
    for (const f of Object.values(families)) f.approximateTokens = tokens(f.bytes)
    const totalBytes = rows.reduce((s, r) => s + r.bytes, 0)
    let toolkitDoc = null
    try {
        toolkitDoc = { path: 'docs/TOOLKIT.md', bytes: readFileSync(join(PACKAGE_ROOT, 'docs/TOOLKIT.md')).length }
    }
    catch { /* docs absent in a bare install copy */ }
 // 常驻的**第二块**：注入的 prompt 路由段（加）。它跟工具 schema 一样每轮都付钱，
    // 所以必须一起记账（dsh-ops 也是分别记 fileOnlyPrompt / shellPrompt / toolingPrompt 的）。
    let routingSection = null
    try {
        const { renderRouting } = await import(pathToFileURL(join(PACKAGE_ROOT, 'lib/routing.js')).href)
        const text = renderRouting(rows.map((r) => r.name))
        const bytes = Buffer.byteLength(text, 'utf8')
        routingSection = { bytes, approximateTokens: tokens(bytes), lines: text === '' ? 0 : text.split('\n').length }
    }
    catch { /* routing.js 不在（裸安装副本）⇒ 记 null，不猜 */ }
    return {
        format: 'dsh-toolkit-schema-measurement-v1',
        metric: 'UTF-8 bytes of compact JSON {name,description,parameters}; approximateTokens = ceil(bytes/4) (rough: CJK is 3 bytes/char, so Chinese text costs fewer tokens than this suggests)',
        entry: installCopy ? 'install copy' : 'source tree',
        tools: rows,
        families,
        total: { tools: rows.length, bytes: totalBytes, approximateTokens: tokens(totalBytes) },
        // 常驻总量 = 工具 schema + 注入的 prompt 路由段
        resident: {
            toolSchemas: totalBytes,
            routingSection: routingSection?.bytes ?? 0,
            bytes: totalBytes + (routingSection?.bytes ?? 0),
            approximateTokens: tokens(totalBytes + (routingSection?.bytes ?? 0)),
        },
        routingSection,
        // On-demand cost (only paid when a session asks for help) — the other half of the trade-off.
        onDemand: toolkitDoc,
    }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
    const args = process.argv.slice(2)
    const entryIdx = args.indexOf('--entry')
    const entry = entryIdx >= 0 ? args[entryIdx + 1] : undefined
    const writeIdx = args.indexOf('--write')
    const out = writeIdx >= 0 ? args[writeIdx + 1] : undefined
    const report = await measure({ entry })
    const text = `${JSON.stringify(report, null, 2)}\n`
    if (out) {
        const abs = join(PACKAGE_ROOT, out)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, text)
        process.stdout.write(`wrote ${abs}\n`)
    }
    process.stdout.write(text)
}

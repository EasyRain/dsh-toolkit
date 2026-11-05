/**
 * lib/tablediff/adapters.js —— 通用"表/记录集合"适配器
 *
 * 每个适配器只做一件事：把某个格式读成**记录数组**（记录 = 普通对象）。之后由 index.js 做投影
 * （挑 key / 挑 value 或整行对比）与哈希 diff —— 所以新增格式只要往这里加一个函数，
 * diff 逻辑一行都不用改。这也是"通用 diff"的关键：格式 ≠ 算法。
 *
 * 支持：.lua / .json / .jsonl / .csv / .tsv / .po / .properties(.env/.ini/.conf) / .yaml / .sqlite
 * 兜底：未知扩展名先按 JSON 试，再按 key=value 试，最后按 CSV 试（stats.format 会写明猜的是什么）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { ToolError } from '../errors.js'
import { asText, getPath, parseLuaValue } from './lua.js'
import { listZipEntries, looksBinary, readZipEntry, formatOfEntry } from './zip.js'
import { tomlRecords } from './toml.js'
import { looksLikeMappings, mappingsRecords } from './mappings.js'

const stats0 = (format) => ({ format, records: 0, skipped: 0, note: null, source: null })

// --- Lua ---------------------------------------------------------------------

export function luaRecords(text, opts = {}) {
    const stats = stats0('lua')
    const parsed = parseLuaValue(text, { table: opts?.table })
    stats.skipped = parsed.stats.skipped
    stats.nodes = parsed.stats.nodes
    let value = parsed.value
 // （Darktide 提案 P1 + §4）：**不许静默降级**。
    // 旧行为：模块化 Lua（`local data = {…}` + 运行时 return）读不出表 ⇒ 只回 1 条 `__expr`，
    // 看起来像"这文件就一条数据"而不是"我读不懂这个文件" ⇒ 整类任务被挡在门外。
    if (parsed.reason !== null && parsed.reason !== undefined) {
        const cands = (parsed.candidates ?? []).slice(0, 5).map((c) => `${c.name}(${c.keys} 键)`).join('、')
        throw new Error(
            `Lua 读不出数据表：${parsed.reason}` +
            (cands ? `。文件里的候选字面量表：${cands} ⇒ 用 table="<名字>" 显式指定` : '。若这个文件确实不是 Lua 数据表，用 format= 指定它真正的格式（例如 format=csv）'),
        )
    }
    if (value === null || value === undefined) {
        stats.note = 'no table or return value found'
        return { records: [], stats }
    }
    // 回退选表要**说清选了什么**（透明优先：用户才知道自己拿到的是哪张表）
    if (parsed.picked !== null && parsed.picked !== undefined) {
        const others = (parsed.candidates ?? []).filter((c) => c.name !== parsed.picked.name).slice(0, 4).map((c) => `${c.name}(${c.keys})`).join('、')
        stats.note = parsed.picked.explicit
            ? `按 table=${JSON.stringify(parsed.picked.name)} 读取（${parsed.picked.keys} 键）`
            : `顶层 return 不是字面量表 ⇒ 已选用文件内最大的字面量表 \`${parsed.picked.name}\`（${parsed.picked.keys} 键）`
                + (others ? `；其它候选：${others}` : '')
                + `（要指定别的表就传 table="名字"）`
    }
    const records = []
    const push = (v, k) => {
        if (v === null || v === undefined) { stats.skipped++; return }
        // 数组：保留外层 key（映射表常见 `["term"] = { "locA", "locB" }`），一个元素一行
        if (Array.isArray(v)) {
            if (k === undefined) v.forEach((x) => push(x, undefined))
            else v.forEach((x) => push(x, k))
            return
        }
        if (typeof v === 'object' && v.__array !== undefined && Object.keys(v).length === 1) {
            if (k === undefined) v.__array.forEach((x) => push(x, undefined))
            else v.__array.forEach((x) => push(x, k))
            return
        }
        // 单键包装（真实 glossary.lua 的形状：{ terms = { …记录… } }）⇒ 拆开
        if (typeof v === 'object' && k !== undefined) {
            const keys = Object.keys(v).filter((x) => x !== '__array')
            if (keys.length === 1 && Array.isArray(v[keys[0]])) { v[keys[0]].forEach((x) => push(x, undefined)); return }
        }
        if (typeof v === 'object') records.push(k !== undefined ? { __luaKey: k, ...v } : v)
        else records.push(k !== undefined ? { key: k, value: asText(v) } : { value: asText(v) })
    }
    if (Array.isArray(value)) value.forEach((v) => push(v, undefined))
    else if (value.__array !== undefined && Object.keys(value).filter((x) => x !== '__array').length === 0) value.__array.forEach((v) => push(v, undefined))
    else for (const [k, v] of Object.entries(value)) if (k !== '__array') push(v, k)
    stats.records = records.length
 // （Darktide 复测 #1）：连"选中了 1 键配置表 / 表达式"这种兜底也堵上 ——
    // 若每条记录**只有哨兵字段**（`__expr`/`__fn`，没有任何真实字段），那就不是数据表 ⇒ 报错，
    // 而不是给用户"1 条记录"让他以为这文件就这么大。
    if (records.length > 0 && records.every((r) => {
        const fields = Object.keys(r).filter((k) => k !== '__luaKey')
        return fields.length === 0 || fields.every((k) => k === '__expr' || k === '__fn')
    })) {
        const cands = (parsed.candidates ?? []).slice(0, 5).map((c) => `${c.name}(${c.keys} 键)`).join('、')
        throw new Error(
            'Lua 读出的内容不是数据表（每条记录只有运行时表达式字段，没有任何真实字段）'
            + (parsed.picked !== null && parsed.picked !== undefined ? `；自动选用的是 \`${parsed.picked.name}\`` : '')
            + (cands ? `。候选字面量表：${cands} ⇒ 用 table="<名字>" 指定真正的那张` : ''),
        )
    }
    return { records, stats }
}

// --- JSON / JSONL ------------------------------------------------------------

function objectToRecords(data, stats) {
    const records = []
    if (Array.isArray(data)) {
        for (const row of data) {
            if (row !== null && typeof row === 'object') records.push(row)
            else if (row !== null && row !== undefined) records.push({ value: asText(row) })
            else stats.skipped++
        }
        return records
    }
    if (data !== null && typeof data === 'object') {
        // 对象一律"一个条目一条记录"（扁平与非扁平一致）：{"k1":"v1"} 是最常见的键值表写法，
        // 以前扁平对象会被当成**一条**记录（__whole），导致 table_diff 对它毫无意义。
        for (const [k, v] of Object.entries(data)) {
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) records.push({ __luaKey: k, ...v })
            else records.push({ key: k, value: asText(v) })
        }
        return records
    }
    stats.skipped++
    return records
}

export function jsonRecords(text) {
    const stats = stats0('json')
    const data = JSON.parse(text)
    const records = objectToRecords(data, stats)
    stats.records = records.length
    return { records, stats }
}

export function jsonlRecords(text) {
    const stats = stats0('jsonl')
    const records = []
    for (const line of text.split('\n')) {
        const t = line.trim()
        if (t === '') continue
        try {
            const row = JSON.parse(t)
            if (row !== null && typeof row === 'object') records.push(row)
            else records.push({ value: asText(row) })
        }
        catch { stats.skipped++ }
    }
    stats.records = records.length
    return { records, stats }
}

// --- CSV / TSV ---------------------------------------------------------------

export function delimitedRecords(text, delim = ',') {
    const stats = stats0(delim === '\t' ? 'tsv' : 'csv')
    const rows = []
    let row = []
    let field = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++ }
                else quoted = false
            }
            else field += c
        }
        else if (c === '"') quoted = true
        else if (c === delim) { row.push(field); field = '' }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
        else if (c !== '\r') field += c
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
    if (rows.length === 0) return { records: [], stats }
    const header = rows[0].map((h) => h.trim())
    const looksHeader = header.length > 0 && header.every((h) => h !== '' && !/^-?\d+(\.\d+)?$/.test(h))
    // **单列文本一律不吞首行**（审计 F12）：术语表/词表常常就是"每行一个词"，旧启发式（非数字即表头）
    // 会把第一个词当列名吃掉 ⇒ 实测 3 行变 2 行、第一个词静默丢失。单列时列名无关紧要（叫 value），
    // 而且"少一行数据"比"多一行当数据的列名"严重得多 ⇒ 单列永远按数据处理，并在 stats.note 里说明。
    if (header.length === 1 && looksHeader) {
        const records = []
        for (const r of rows) {
            if (r.length === 0) { stats.skipped++; continue }
            records.push({ value: r[0] ?? '' })
        }
        stats.records = records.length
        stats.note = `单列文件：首行 "${rows[0][0]}" 当**数据**保留（列名用 value）。若首行确实是列名，请自己删掉它或用两列格式`
        return { records, stats }
    }
    const body = looksHeader ? rows.slice(1) : rows
    const cols = looksHeader ? header : header.map((_, i) => `col${i + 1}`)
    if (!looksHeader) stats.note = 'no header row detected; columns named col1..colN'
    const records = []
    for (const r of body) {
        if (r.length === 0) { stats.skipped++; continue }
        const rec = {}
        for (let i = 0; i < cols.length; i++) rec[cols[i]] = r[i] ?? ''
        records.push(rec)
    }
    stats.records = records.length
    return { records, stats }
}

// --- PO (gettext) ------------------------------------------------------------

export function poRecords(text) {
    const stats = stats0('po')
    const records = []
    const un = (s) => s.replace(/\\(n|t|r|"|\\)/g, (m, g) => (g === 'n' ? '\n' : g === 't' ? '\t' : g === 'r' ? '\r' : g))
    const lines = text.split('\n')
    let msgid = null
    let msgstr = null
    let plural = null
    let ctxt = null // 审计 F14：`msgctxt` 以前被完全忽略 ⇒ 同 msgid 不同上下文的条目会互相顶掉
    let plurals = [] // msgstr[0]/[1] 分别收（以前直接相连 ⇒ 复数被拼成一串）
    const flush = () => {
        if (msgid !== null) {
            // **键带上上下文**（gettext 的语义就是 msgctxt+msgid 才唯一）
            const key = ctxt === null ? msgid : `${ctxt}\u0004${msgid}`
            const rec = { msgid: key, msgstr: msgstr ?? '' }
            if (plural !== null) rec.msgid_plural = plural
            if (ctxt !== null) rec.msgctxt = ctxt
            if (plurals.length > 0) rec.msgstr_plural = plurals.join('\u0001')
            records.push(rec)
            msgid = null
            msgstr = null
            plural = null
            ctxt = null
            plurals = []
        }
    }
    for (const raw of lines) {
        const line = raw.trim()
        const grab = (s) => {
            const m = /^"((?:\\.|[^"\\])*)"/.exec(s)
            return m === null ? null : un(m[1])
        }
        if (line.startsWith('msgctxt ')) { flush(); ctxt = grab(line.slice(8)) ?? ''; continue }
        if (line.startsWith('msgid_plural ')) { plural = grab(line.slice(13)) ?? ''; continue }
        if (line.startsWith('msgid ')) { flush(); msgid = grab(line.slice(6)) ?? ''; continue }
        if (line.startsWith('msgstr')) {
            const key = /^msgstr(\[(\d+)\])? /.exec(line)
            const v = grab(line.slice(key ? key[0].length : 7))
            const index = key && key[2] !== undefined ? Number(key[2]) : null
            if (index !== null) {
                // `msgstr[0] "…"` / `msgstr[1] "…"`：分开存
                while (plurals.length <= index) plurals.push('')
                plurals[index] += v ?? ''
            }
            else if (msgstr === null) msgstr = v ?? ''
            else if (v !== null) msgstr += v
            continue
        }
        if (line.startsWith('"')) {
            const v = grab(line)
            if (v === null) continue
            // 续行归属：紧跟 msgstr[N] 的续行归该复数槽，其次是 msgstr、msgid_plural、msgid
            if (plurals.length > 0 && msgstr !== null) plurals[plurals.length - 1] += v
            else if (msgstr !== null) msgstr += v
            else if (plural !== null) plural += v
            else if (msgid !== null) msgid += v
        }
    }
    flush()
    if (records.some((r) => r.msgctxt !== undefined)) stats.note = 'msgctxt 已并入 msgid（键为 `上下文\\x04原文`，这是 gettext 的唯一键语义）'
    stats.records = records.length
    return { records, stats }
}

// --- properties / .env / .ini ------------------------------------------------

export function propsRecords(text) {
    const stats = stats0('properties')
    const records = []
    let section = ''
    /** Java .properties 风格的转义（审计 F13：以前原样保留 ⇒ `\u4e2d` 与真中文被当成不同值） */
    const unescape = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, g) => {
        if (g[0] === 'u' || g[0] === 'U') return String.fromCharCode(parseInt(g.slice(1), 16))
        if (g === 'n') return '\n'
        if (g === 't') return '\t'
        if (g === 'r') return '\r'
        return g
    })
    /** 剥外层引号（`.env` 里常见 `KEY="a b"`；审计 F13 指出以前引号被留在值里） */
    const stripQuotes = (v) => {
        const t = v.trim()
        if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1)
        return t
    }
    const rawLines = text.split('\n')
    // **续行**：行尾反斜杠表示与下一行相接（Java properties 标准；审计 F13 以前完全没实现）
    const logical = []
    for (let i = 0; i < rawLines.length; i += 1) {
        let line = rawLines[i]
        while (/\\\s*$/.test(line) && i + 1 < rawLines.length) {
            line = line.replace(/\\\s*$/, '') + rawLines[i + 1].trimStart()
            i += 1
        }
        logical.push(line)
    }
    for (const raw of logical) {
        const line = raw.trim()
        if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue
        const sec = /^\[(.+)\]$/.exec(line)
        if (sec !== null) { section = sec[1].trim(); continue }
        // `.env` 允许 `export KEY=value`
        const cleaned = line.replace(/^export\s+/, '')
        const m = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(cleaned)
        if (m === null) { stats.skipped++; continue }
        records.push({ key: section === '' ? m[1].trim() : `${section}.${m[1].trim()}`, value: unescape(stripQuotes(m[2])) })
    }
    stats.records = records.length
    if (records.length === 0) stats.note = 'no key=value lines found'
    return { records, stats }
}

// --- YAML --------------------------------------------------------------------

export async function yamlRecords(text) {
    const stats = stats0('yaml')
    let parse
    try {
        ({ parse } = await import('yaml'))
    }
    catch {
        stats.note = 'yaml module unavailable'
        return { records: [], stats }
    }
    const data = parse(text)
    const records = objectToRecords(data, stats)
    stats.records = records.length
    return { records, stats }
}

// --- SQLite ------------------------------------------------------------------

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`

export async function sqliteRecords(spec, opts = {}) {
    const stats = stats0('sqlite')
    const hash = spec.indexOf('#')
    const path = hash < 0 ? spec : spec.slice(0, hash)
    const frag = hash < 0 ? '' : spec.slice(hash + 1)
    let table = ''
    let fragKey = null
    let fragValue = null
    if (frag !== '') {
        // 支持 `path#table(keyCol,valueCol)`（审计 F9：以前括号部分被正则吃掉、静默忽略 ⇒
        // 用户以为指定了键/值列，实际仍在自动猜列）
        const m = /^([^(]*)(?:\(([^)]*)\))?/.exec(frag)
        table = (m?.[1] ?? '').trim()
        const cols = (m?.[2] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
        if (cols.length >= 1) fragKey = cols[0]
        if (cols.length >= 2) fragValue = cols[1]
    }
    const hasQuery = typeof opts.query === 'string' && opts.query.trim() !== ''
    if (!existsSync(path)) throw new Error(`sqlite file not found: ${path}`)
    let DatabaseSync
    try {
        ({ DatabaseSync } = await import('node:sqlite'))
    }
    catch {
        throw new Error('node:sqlite 不可用：需要 Node ≥23.4（内置且无需 flag），或 22.5–23.3 加 --experimental-sqlite 启动宿主')
    }
    const db = new DatabaseSync(path, { readOnly: true })
    try {
        let allTables = []
        try {
            allTables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name)
        }
        catch (e) {
            throw new Error(`${path}: ${e.message} — 若这是 SQLCipher 加密库、损坏文件，或缺少 -wal 伴随文件的 WAL 库，请先导出成普通 SQLite/CSV 再喂给我`)
        }
        const tableInfo = (name) => {
            let rows = null
            let columns = []
            try { rows = db.prepare(`select count(*) as c from ${q(name)}`).get().c }
            catch { /* 读不了就留 null */ }
            try { columns = db.prepare(`pragma table_info(${q(name)})`).all().map((c) => c.name) }
            catch { /* ignore */ }
            return { name, rows, columns }
        }
        // **只查目标表**（审计 F6）：以前无论有没有指定 `#table`，都对**库内每张表**跑一次
        // `count(*)` + `pragma table_info` —— 实测 800 万行的库读一张 1000 行的表要 202 ms
        // （2 万行的库只要 50 ms），纯属白付。指定了表或给了 `query` 就完全不需要这份清单。
        const tables = []
        if (hasQuery) {
            // query 自己决定读什么，连表名都可以不解析
            if (table !== '') tables.push(tableInfo(table))
        }
        else if (table !== '') {
            if (!allTables.includes(table)) throw new Error(`${path} 里没有表 "${table}"；库内表：${allTables.slice(0, 20).join(', ')}${allTables.length > 20 ? ' …' : ''}`)
            tables.push(tableInfo(table))
        }
        else {
            for (const name of allTables) tables.push(tableInfo(name))
        }
        stats.tables = tables
        stats.tablesTotal = allTables.length
        if (table === '' && !hasQuery) {
            const byRows = tables.slice().sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1))
            const best = byRows[0]
            if (best === undefined) throw new Error(`no tables in ${path}`)
            table = best.name
            // 表多的库（几十上百张）不要全列出来刷屏：按行数取前 25 张
            stats.tablesShown = byRows.slice(0, 25)
            stats.note = `未指定 #table，自动选了行数最多的 "${table}"（${best.rows ?? '?'} 行）；库内 ${tables.length} 张表${tables.length > stats.tablesShown.length ? `（列出前 ${stats.tablesShown.length} 张）` : ''}：${stats.tablesShown.map((t) => `${t.name}=${t.rows ?? '?'}`).join(', ')}`
        }
        // `query` 与 `#table` 同时给：**说清楚谁生效**（审计 F7：以前 query 生效、但 source 仍写 `#table`，
        // 用户看到的是"A 侧 …#loc"，实际跑的是自己的 SQL）
        if (hasQuery && table !== '') {
            stats.note = `${stats.note ? `${stats.note}；` : ''}已给了 query，#table "${table}" **被忽略**（实际执行：${String(opts.query).trim().slice(0, 120)}）`
        }
        const sql = hasQuery ? opts.query : `select * from ${q(table)}`
        // F23：db.prepare 对多语句只执行**第一条**（SQLite 语义）⇒ 用户写了两句却只跑一句、且毫无提示。
        // 明确拒绝（并说明怎么改），而不是静默跑一半。
        if (hasQuery && /;\s*\S/.test(String(opts.query).replace(/;\s*$/, ''))) {
            throw new Error('query 只能是**单条**语句（node:sqlite 对多语句只执行第一条，静默跑一半更危险）。请拆成多次调用，或把逻辑写成一条带 CTE 的查询')
        }
        const records = db.prepare(sql).all().map((r) => ({ ...r }))
        stats.records = records.length
        stats.source = hasQuery ? `${path}#query(${String(opts.query).trim().slice(0, 60)}${String(opts.query).trim().length > 60 ? '…' : ''})` : `${path}#${table}`
        // `#table(k,v)` 的列名交给上层当默认键/值列（args 显式给了就优先 args）
        if (fragKey !== null) stats.keyHint = fragKey
        if (fragValue !== null) stats.valueHint = fragValue
        return { records, stats }
    }
    finally {
        db.close()
    }
}

// --- zip / jar（MC 模组跟版对比）---------------------------------------------

/**
 * zip/jar 来源：
 *  - `path/to/mod.jar` → 条目清单记录 `{path,size,compressed,crc32,method}`（两个版本 ⇒ 差异条目）
 *  - `path/to/mod.jar#entry:META-INF/mods.toml` → 取单个条目当**文本**解析（按条目扩展名选格式）
 */
export async function zipRecords(spec, opts = {}) {
    const marker = spec.indexOf('#entry:')
    if (marker < 0) {
        const { entries, stats } = listZipEntries(spec)
        return {
            records: entries.map((e) => ({ path: e.path, size: e.size, compressed: e.compressed, crc32: e.crc32, method: e.method })),
            stats,
        }
    }
    const jar = spec.slice(0, marker)
    const entry = spec.slice(marker + 7).replace(/^[/\\]/, '')
    const buf = readZipEntry(jar, entry)
    if (buf === null) {
        throw new Error(`${jar} 里没有条目 "${entry}"。想看有哪些条目就直接传 jar 路径（会列清单）`)
    }
    if (looksBinary(entry)) {
        throw new Error(`条目 ${entry} 是二进制（按扩展名判断）—— table_diff 不能直接比它；.class 请先反编译，图片请比清单里的 crc32/size`)
    }
 // ⚠️ 与 safeRead **同等对待**（回归探针发现）：jar 条目也要"编码提示 + 优雅失败"。
    // 以前这里直接 parseAs ⇒ 一个 GBK 编码的 JSON 条目会抛出裸 SyntaxError（老修复点在新 zip 路径上漏了）。
    const warning = encodingWarning(buf)
    let text = buf.toString('utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // BOM：JSON.parse 见到 \uFEFF 会抛
    const ext = (formatOfEntry(entry) ?? '').toLowerCase()
    const inner = BY_EXT[`.${ext}`]
    let res
    try {
        res = (inner !== undefined && inner !== 'zip' && inner !== 'sqlite')
            ? await parseAs(inner, text, spec, opts)
            : await guessText(text, spec, opts)
    }
    catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`jar 条目 ${entry} 按 ${inner ?? '自动猜测'} 解析失败：${why}${warning ? `；${warning}` : ''}（可先用 table_peek 看该条目，或用 format 指定它的真实格式）`)
    }
    if (warning !== null) res.stats.note = `${res.stats.note ? `${res.stats.note}；` : ''}${warning}`
    res.stats.source = `${jar}#entry:${entry}`
    res.stats.note = `${res.stats.note ? `${res.stats.note}；` : ''}来自 jar 条目 ${entry}（${buf.length} 字节，按 ${res.stats.format} 解析）`
    return res
}

// --- dispatcher --------------------------------------------------------------

const BY_EXT = {
    '.lua': 'lua', '.luau': 'lua',
    '.json': 'json', '.jsonl': 'jsonl', '.ndjson': 'jsonl',
    '.csv': 'csv', '.tsv': 'tsv',
    '.po': 'po', '.pot': 'po',
    '.properties': 'properties', '.props': 'properties', '.env': 'properties', '.ini': 'properties', '.conf': 'properties', '.cfg': 'properties',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml',
    '.sqlite': 'sqlite', '.sqlite3': 'sqlite', '.db': 'sqlite',
    '.jar': 'zip', '.zip': 'zip', '.war': 'zip', '.mrpack': 'zip',
    '.srg': 'mappings', '.tsrg': 'mappings', '.tsrg2': 'mappings', '.tiny': 'mappings',
}

export const KNOWN_FORMATS = ['auto', 'lua', 'json', 'jsonl', 'csv', 'tsv', 'po', 'properties', 'yaml', 'toml', 'zip', 'mappings', 'sqlite']

async function parseAs(format, text, spec, opts) {
    switch (format) {
        case 'lua': return luaRecords(text, opts)
        case 'json': return jsonRecords(text)
        case 'jsonl': return jsonlRecords(text)
        case 'csv': return delimitedRecords(text, ',')
        case 'tsv': return delimitedRecords(text, '\t')
        case 'po': return poRecords(text)
        case 'properties': return propsRecords(text)
        case 'yaml': return yamlRecords(text)
        case 'toml': return tomlRecords(text)
        case 'zip': return zipRecords(spec, opts)
        case 'mappings': return mappingsRecords(text, opts)
        case 'sqlite': return sqliteRecords(spec, opts)
        default: throw new Error(`unsupported format: ${format}`)
    }
}

/**
 * 扩展名未知时按**判别性检查**依次试（重写）。
 *
 * 旧实现只试 `json → properties → csv` ⇒ **TOML/YAML/JSONL 会被静默当成 properties**，
 * 给出"看着正常、其实错"的 diff（实测：`[t]\ny = 2` 被解析成键 `[t]`）。新顺序与判据：
 *  1. `jsonl`：≥2 个非空行且**每行**都能 `JSON.parse`（强信号，必须排在 json/properties 之前）
 *  2. `json`：整体能解析
 *  3. `toml`：有 `[table]` / `[[array]]` 头，或 `key = value`（properties 的 `a: 1` 不是合法 TOML ⇒ 会落到 properties）
 *  4. `yaml`：嵌套键（`key:` 后无值）/ `- ` 列表项 / `---` 文档头
 *  5. `lua`：`return {` 或 `x = {` 这类表构造
 *  6. `mappings`：内容像混淆映射
 *  7. `properties`（最宽松，放最后）
 *  8. `csv`
 * 命中后在 note 里**回显胜出者**；若还有别的候选也能解析，一并点名（避免"猜中了但没告诉你"）。
 */
async function guessText(text, spec, opts) {
    const head = text.slice(0, 4096)
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    const looksJsonl = lines.length >= 2 && lines.every((l) => {
        const t = l.trim()
        if (!(t.startsWith('{') || t.startsWith('['))) return false
        try { JSON.parse(t); return true }
        catch { return false }
    })
    const trimmed = text.trimStart()
    const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[')
    const looksToml = /^\s*\[\[?[^\]]+\]\]?\s*$/m.test(head) || /^\s*[\w."'-]+\s*=/m.test(head)
    const looksYaml = /^[A-Za-z_][\w.$-]*:\s*(#.*)?$/m.test(head) || /^\s*-\s+\S/m.test(head) || /^---\s*$/m.test(head)
 // Lua：`return {…}` / `return{…}` / 裸 `{…}`（行长不限 —— 修：以前要求 `{` 独占一行，
    // 于是**单行内联**的 `return { ["k"]={…} }` 会被判成 properties ✗），以及 `local X = {` / `X = {`。
    const looksLua = /^\s*(return\s*)?\{\s*$/m.test(head)
        || /^\s*return\s*\{/m.test(head)
        || /^\s*(local\s+)?[A-Za-z_]\w*\s*=\s*\{/m.test(head)
        || /^\s*[A-Za-z_]\w*\.[A-Za-z_]\w*\s*=\s*\{/m.test(head)
    const looksMappings = (() => { try { return looksLikeMappings(head) } catch { return false } })()

    const candidates = []
    if (looksJsonl) candidates.push('jsonl')
    if (looksJson) candidates.push('json')
    if (looksToml) candidates.push('toml')
    if (looksYaml) candidates.push('yaml')
    if (looksLua) candidates.push('lua')
    if (looksMappings) candidates.push('mappings')
    candidates.push('json', 'properties', 'csv')

    const tried = []
    const parsed = []
    const missing = []
    let order_ = 0
    for (const guess of [...new Set(candidates)]) {
        const rank = order_
        order_ += 1
        let r
        try {
            r = await parseAs(guess, text, spec, opts)
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            // 依赖缺失（源码树没装 `yaml` 之类）要**点名**：否则用户会以为"这份文件就是 properties"
            if (/Cannot find package|unavailable|ERR_MODULE_NOT_FOUND/i.test(msg)) missing.push(guess)
            tried.push(`${guess}(failed: ${msg.slice(0, 40)})`)
            continue
        }
        const skipped = r.stats.skipped ?? 0
        // 依赖缺失的**优雅降级**（`yamlRecords` 在模块缺失时返回 0 条 + note='yaml module unavailable'）
        // 也要点名：否则用户会以为"这份文件就是 properties"。
        if (/unavailable|module not found/i.test(r.stats.note ?? '')) {
            missing.push(guess)
            tried.push(`${guess}(module unavailable)`)
            continue
        }
        // **坏行占比 ≥ 一半就不认**：TOML/YAML 这类解析器会"跳过坏行后仍给出部分记录"，
        // 半成品正是静默错的来源（properties 文件被 TOML 半解析就是典型）。
        if (r.stats.records > 0 && skipped < r.stats.records) parsed.push({ guess, r, skipped, rank })
        else tried.push(r.stats.records > 0 || skipped > 0 ? `${guess}(skipped ${skipped}/${r.stats.records})` : guess)
    }
    if (parsed.length > 0) {
        // **选谁**：先按判别顺序（具体 → 宽松）。
        // 注：不能按"跳过最少"排 —— YAML 解析嵌套键时会计 skipped，反而输给解释力更弱的 properties（实测踩到）。
        parsed.sort((x, y) => x.rank - y.rank)
        const [winner, ...others] = parsed
        const alt = others.length > 0 ? `（${others.map((o) => o.guess).join('/')} 也能解析 —— 不确定就用 format 明确指定）` : ''
        const miss = missing.length > 0 ? `（${missing.join('/')} 模块不可用已跳过 —— 在安装副本/宿主里可用）` : ''
        winner.r.stats.note = `${winner.r.stats.note ? `${winner.r.stats.note}；` : ''}format guessed as ${winner.guess}${alt}${miss}`
        return winner.r
    }
    const empty = stats0('unknown')
    empty.note = `could not parse as ${tried.join('/')}`
    return { records: [], stats: empty }
}

/** 读一个来源 → 记录数组。format 为 auto 时按扩展名，猜不中则按判别性检查嗅探。
 *  `opts.inlineText` 为字符串时**不读文件**，直接解析这段内容（`table_diff` 的 `text:` 侧）。 */
async function recordsFromInner(spec, opts = {}) {
    const want = String(opts.format ?? 'auto').toLowerCase()
    const inline = typeof opts.inlineText === 'string'
    const ext = inline ? '' : extname(String(spec).split('#')[0]).toLowerCase()   // SQLite 的 #table 片段不算扩展名
    // 「其他姿势」审计：`#` 是 SQLite/zip 的语法，用在 JSON/CSV 上以前会变成"file not found: a.json#t"（找不到北）
    if (!inline && String(spec).includes('#')) {
        const isSqliteish = want === 'sqlite' || ext === '.db' || ext === '.sqlite' || ext === '.sqlite3' || ext === '.db3'
        const isZipish = want === 'zip' || ext === '.jar' || ext === '.zip'
        if (!isSqliteish && !isZipish) {
            throw new Error(`${spec}: \`#\` 只用于 SQLite（path#table）与压缩包（x.jar#entry:路径）；这个来源是 ${ext === '' ? '未知格式' : ext} ⇒ 去掉 \`#...\` 再试`)
        }
    }
    const withWarning = (res, warning) => {
        if (warning) res.stats.note = res.stats.note ? `${res.stats.note}；${warning}` : warning
        return res
    }
    if (inline) {
        // 内联内容**必须**走嗅探或显式 format（没有扩展名可依）；来源回显成 `<inline: N 字符>`
        const text = opts.inlineText
        const res = want === 'auto'
            ? (looksLikeMappings(text) ? mappingsRecords(text, opts) : await guessText(text, '<inline>', opts))
            : await parseAs(want, text, '<inline>', opts)
        res.stats.source = `<inline: ${text.length} 字符>`
        return res
    }
    if (want === 'sqlite') return parseAs('sqlite', '', spec, opts)
    if (want === 'zip') return parseAs('zip', '', spec, opts)
    if (want !== 'auto') {
        const { text, warning } = safeRead(spec)
        return withWarning(await parseAs(want, text, spec, opts), warning)
    }
    const byExt = BY_EXT[ext]
    if (byExt === 'sqlite') return parseAs('sqlite', '', spec, opts)
    if (byExt === 'zip') return parseAs('zip', '', spec, opts)
    if (byExt !== undefined) {
        const { text, warning } = safeRead(spec)
        return withWarning(await parseAs(byExt, text, spec, opts), warning)
    }
    const { text, warning } = safeRead(spec)
    // 内容嗅探：Mojang 的 client-<ver>-mappings.txt 之类扩展名是 .txt，靠内容认出来（否则会按 properties/csv 乱解）
    if (looksLikeMappings(text)) return withWarning(mappingsRecords(text, opts), warning)
    return withWarning(await guessText(text, spec, opts), warning)
}

const MAX_TEXT_BYTES = 300 * 1024 * 1024

/**
 * 对外入口：包一层"**被你忽略的参数要说出来**"（「其他姿势」审计）。
 * `query` 只对 SQLite 有效、`table=` 只对 Lua 有效 —— 以前静默忽略 ⇒ 用户以为生效了。
 */
export async function recordsFrom(spec, opts = {}) {
    const res = await recordsFromInner(spec, opts)
    const fmt = String(res?.stats?.format ?? '')
    const add = (msg) => { res.stats.note = res.stats.note ? `${res.stats.note}；${msg}` : msg }
    if (opts.query !== undefined && opts.query !== null && opts.query !== '' && fmt !== 'sqlite') {
        add(`query 只对 SQLite 源有效，本次已忽略（format=${fmt || 'unknown'}）`)
    }
    if (opts.table !== undefined && opts.table !== null && opts.table !== '' && fmt !== 'lua') {
        add(`table= 只对 Lua 源有效，本次已忽略（format=${fmt || 'unknown'}）`)
    }
    return res
}

function safeRead(spec) {
    // 不能只说"文件不存在"：**大小写**是跨平台最容易踩的坑（Windows 路径大小写不敏感 ⇒
    // Windows 上能读的 `NESTED/TOP.LUA` 在 Linux 上读不到）。真 Linux 首跑时，
    // 这里抛的是**裸 Error**（把整次调用崩掉）；现在换成带指引的 ToolError。
    if (!existsSync(spec)) {
        const hint = process.platform === 'win32'
            ? ''
            : '（注意：本平台路径**大小写敏感** —— 在 Windows 上能读的大写路径在这里读不到）'
        throw new ToolError(`file not found: ${spec}${hint}`)
    }
    let st = null
    try { st = statSync(spec) }
    catch { st = null }
    if (st !== null && st.isDirectory()) {
        const dir = String(spec).replace(/[\\/]+$/, '')
        throw new Error(`${spec} 是目录 —— 请给具体文件，或写 glob 让它自己合并，例如 "${dir}/**/*.ext"（ext 用你实际的扩展名）`)
    }
    if (st !== null && st.size > MAX_TEXT_BYTES) {
        throw new Error(`${spec} 有 ${(st.size / 1024 / 1024 / 1024).toFixed(1)} GB —— 作为文本解析太大；请先切分/过滤（glob 只取需要的文件），或走 SQLite 通道（path#table）`)
    }
    const buf = readFileSync(spec)
    // 「其他姿势」审计：UTF-16 先判掉（否则是没法定位的 parser 错），空文件也要有名字明确的结论
    const u16 = utf16Error(buf)
    if (u16 !== null) throw new Error(`${spec}: ${u16}`)
    if (buf.length === 0) throw new Error(`${spec} 是 0 字节（空文件）—— 没有内容可解析；如果本意是"这一侧没有数据"，请直接对比非空的那一侧，或用 text: 给一段占位内容`)
    const warning = encodingWarning(buf)
    const text = buf.toString('utf8')
    // BOM：Windows 上很常见，JSON.parse 见到 \uFEFF 会直接抛，所以统一剥掉
    return { text: text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text, warning }
}

/** 非 UTF-8（如 GBK）文本解出来会带大量替换字符 —— 这是本机踩过的坑，主动提示而不是静默给乱码 */
function encodingWarning(buf) {
    const text = buf.toString('utf8')
    const bad = (text.match(/\uFFFD/g) ?? []).length
    if (bad === 0) return null
    const ratio = bad / Math.max(text.length, 1)
    if (ratio < 0.0005 && bad < 5) return null
    return `文件可能不是 UTF-8（解出 ${bad} 个替换字符 U+FFFD）—— 请转成 UTF-8 再解析，否则 key/值会带乱码`
}

/**
 * （「其他姿势」审计）：UTF-16 直接**报错**而不是交给各解析器炸出 `Unexpected token`。
 * Windows 上很常见（PowerShell 5.1 的 `Out-File`/`>` 默认 UTF-16LE），以前表现为一句没法定位的 JSON 解析错。
 */
function utf16Error(buf) {
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return '文件是 UTF-16LE 编码（BOM FF FE）—— 本工具按 UTF-8 读，请先转成 UTF-8：编辑器里另存为 UTF-8；或 `iconv -f UTF-16LE -t UTF-8 in > out`；Windows PowerShell 5.1 的 `Out-File`/`>` 默认写 UTF-16LE，改加 `-Encoding utf8`'
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        return '文件是 UTF-16BE 编码（BOM FE FF）—— 本工具按 UTF-8 读，请先转成 UTF-8'
    }
    return null
}

export { asText, getPath }

/**
 * lib/tablediff —— **通用**两表 diff（哈希连接 O(N+M)，绝不 O(N·M)）
 *
 * 设计：格式 ≠ 算法。adapters.js 负责把任意来源读成"记录数组"，本文件负责
 *   ① 投影：挑出 key（可多字段组合）与 value（单字段）——或不挑 value，直接整行对比
 *   ② 键映射（可选）：先经一张查找表把 A/B 的 key 重命名（term → loc key 这类跨表对照）
 *   ③ 哈希连接 diff：值模式（key→value）或记录模式（逐字段列出变化）
 * 所以以后接新场景只要加适配器 + 传字段路径，不用碰 diff 逻辑。
 *
 * 实战背景：当年手写 Python 用"我们每条 × 社区每条"的嵌套遍历 = O(N·M)
 * （自有 3.7k 条 × 社区上万条 ≈ 3,700 万次比较，分钟级），最后靠 SQLite 才解决。
 * 这里 3.7k×12k 是毫秒级；两侧都是 SQLite 且行数巨大时才落回 SQL join（见 diffSqliteLarge）。
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPath } from './lua.js'
import { assertNormalizeMode, normalizeAny, NORMALIZE_MODES } from './normalize.js'
import { recordsFrom } from './adapters.js'

/** 走 SQL join 的行数阈值（两侧都低于它就照常哈希连接）；可用环境变量下调，便于测试 */
const LARGE_SQLITE_THRESHOLD = Number(process.env.DSH_TOOLKIT_SQLITE_LARGE_THRESHOLD ?? 2_000_000)

/** mapMode:all 展开后的键数上限（审计 F17）：防止一个键展开成千上万行把内存与结果都撑爆 */
const MAX_EXPANDED_KEYS = 200_000

const clip = (v, n) => (String(v).length > n ? `${String(v).slice(0, n)}…` : String(v))

/**
 * 类型敏感的相等判断（审计 F10）：`1 !== "1"`、`true !== "true"`、`null !== ""`。
 * 对象/数组先按 JSON 比（records 模式收敛后的值）。
 */
export function sameValue(a, b) {
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b
    if (ta !== tb) return false
    if (ta === 'object' || ta === 'array') return JSON.stringify(a) === JSON.stringify(b)
    return a === b
}

/**
 * glob 里"第一个通配符之前"的基目录（含尾分隔符）；没有通配符就返回整串。
 * 相对 glob 必须先拿它去逐个候选基目录做 existsSync —— 对整串做 existsSync 永远为假。
 */
export function globBaseOf(pattern) {
    const s = String(pattern)
    const i = s.search(/[*?]/)
    if (i < 0) return s
    const cut = Math.max(s.lastIndexOf('/', i), s.lastIndexOf('\\', i))
    return cut < 0 ? '.' : s.slice(0, cut + 1)
}

/** 极简 glob（零依赖）：支持 `**`、`*`、`?`，用于把"整包"多个文件合并成一个键空间。
 *  返回值是文件数组，并附带 `.base`（展开时用的基目录，便于报错时显示）。 */
export function expandGlob(spec) {
    const s = String(spec)
    if (!/[*?]/.test(s)) {
        const single = [s]
        single.base = null
        return single
    }
    const norm = s.replace(/\\/g, '/')
    const firstMeta = norm.search(/[*?]/)
    const cut = norm.lastIndexOf('/', firstMeta)
    const base = cut < 0 ? '.' : (cut === 0 ? '/' : norm.slice(0, cut))
    const pattern = norm.slice(cut + 1)
    const segs = pattern.split('/')
 // ⚠️ （Darktide 复测 #3）：`**/` 以前按 `.*/` 翻译 ⇒ **那个斜杠要求至少一层目录** ✗
    // ⇒ `Main_Modules/**/*.lua` 会漏掉直接位于 `Main_Modules/` 下的文件（静默少文件，最阴的一类）。
    // 现在按"路径段"展开：`**` 段 ⇒ 零个或多个目录段 `(?:[^/]+/)*`（仅当它是末段时才是 `.*`）。
    const segRx = (seg) => seg.split(/(\*\*|\*|\?)/).map((part) => {
        if (part === '**') return '.*'
        if (part === '*') return '[^/]*'
        if (part === '?') return '[^/]'
        return part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }).join('')
    const body = segs.map((seg, i) => {
        const last = i === segs.length - 1
        if (seg === '**') return last ? '.*' : '(?:[^/]+/)*'
        return segRx(seg) + (last ? '' : '/')
    }).join('')
    // Windows 路径大小写不敏感 ⇒ 正则也放宽（其它平台保持严格）
    const rx = new RegExp(`^${body}$`, process.platform === 'win32' ? 'i' : '')
    const out = []
    const walk = (dir, rel) => {
        let entries = []
        try { entries = readdirSync(dir, { withFileTypes: true }) }
        catch { return }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue
            const r = rel === '' ? e.name : `${rel}/${e.name}`
            const abs = join(dir, e.name)
            if (e.isDirectory()) {
                if (pattern.includes('**') || r.split('/').length < segs.length) walk(abs, r)
                continue
            }
            if (e.isFile() && rx.test(r)) out.push(abs)
        }
    }
    walk(base, '')
    out.sort()
    out.base = base
    return out
}

/**
 * 诊断用：把工具执行的第二个参数 `exec` 的形状 dump 到 %TEMP%\_toolkit-exec-dump.json。
 * 只在 DSH_TOOLKIT_DUMP_EXEC=1 时启用（收集键名 + 标量，深度 3，防循环）——
 * 目的是搞清宿主是否把"调用方会话"传进来（决定相对路径该按谁解析）。
 */
function dumpExec(exec) {
    if (process.env.DSH_TOOLKIT_DUMP_EXEC !== '1') return
    const seen = new WeakSet()
    const walk = (o, depth) => {
        if (o === null || o === undefined) return null
        if (typeof o !== 'object') return typeof o === 'string' ? clip(o, 120) : o
        if (depth > 3) return '[depth]'
        if (seen.has(o)) return '[circular]'
        seen.add(o)
        const out = {}
        for (const k of Object.keys(o).slice(0, 40)) {
            try {
                out[k] = walk(o[k], depth + 1)
            }
            catch {
                out[k] = '[throw]'
            }
        }
        return out
    }
    try {
        writeFileSync(join(tmpdir(), '_toolkit-exec-dump.json'), JSON.stringify({ at: new Date().toISOString(), exec: walk(exec, 0) }, null, 2), 'utf8')
    }
    catch { /* 诊断失败不影响工具 */ }
}

/**
 * 自动识别 key/value 时的**启发式候选**（通用命名，不含任何领域或项目专属字段）。
 * - 显式传 `keyField` / `valueField` 时这些完全不参与；
 * - 想扩展某个领域的惯用名（`en`、`loc_keys`、`sku`、`article_no`…），传 `keyHints` / `valueHints`
 *   —— 会追加在默认表**之前**（优先命中），不必改代码。
 */
export const DEFAULT_KEY_FIELDS = ['__luaKey', 'key', 'id', 'name', 'term', 'msgid', 'source', 'label', 'title', 'path']

/** value 侧常见命名（记录模式里只剩一个这类字段时，直接取字符串而不是再包一层 record） */
export const VALUE_HINTS = ['value', 'text', 'msgstr', 'translation', 'target', 'trans', 'title', 'content', 'description']

/**
 * 把记录数组投影成 `Map<key, value> | Map<key, record>`。
 * keyField 支持 `+` 组合多字段（如 `id+locale`）与 `[n]` 索引（如 `tags[0]`）。
 * valueField 为空 ⇒ 记录模式（value = 去掉 key 字段后的记录）。
 * opts.keyHints / opts.valueHints 用于扩展自动识别的候选名。
 */
export function project(records, opts = {}) {
    const keyField = opts.keyField
    const valueField = opts.valueField
 // （Darktide 提案 P2）：值归一化 —— 在投影处一次性施加，所有格式/两个工具都受益
    const normMode = assertNormalizeMode(opts.normalize)
    const normOrdered = opts?.ordered === true
    const norm = (v) => (normMode === 'raw' ? v : normalizeAny(v, normMode, { ordered: normOrdered }))
    const keyCandidates = [...(Array.isArray(opts.keyHints) ? opts.keyHints : []), ...DEFAULT_KEY_FIELDS]
    const valueCandidates = [...(Array.isArray(opts.valueHints) ? opts.valueHints : []), ...VALUE_HINTS]
    const map = new Map()
    // **重复键必须在单文件内也暴露**：以前只在 glob 合并时报重复键，单文件里 1000 行塌成 3 个键
 // 却毫无提示 —— 用户看到"无差异"就下结论了（子代理审计 F3）。
    const dupes = new Map()
    let keyFieldsUsed = []
    let valueFieldUsed = valueField ?? null
    const keyPaths = keyField === undefined || keyField === null || keyField === 'auto' || keyField === ''
        ? null
        : String(keyField).split('+').map((s) => s.trim()).filter(Boolean)
    let skipped = 0
    let i = 0
    let scalarField
    let scalarCount = 0
    for (const rec of records) {
        i++
        let key
        if (keyPaths !== null) {
            key = keyPaths.map((p) => {
                const v = getPath(rec, p)
                return v === null || v === undefined ? '' : String(typeof v === 'object' ? (Array.isArray(v) ? v[0] : '') : v)
            }).map((c) => c.replace(/\\/g, '\\\\').replace(/\+/g, '\\+')).join('+') // 转义后拼接：值里含 `+` 也不会撞键（审计 F11）
            keyFieldsUsed = keyPaths
        }
        else {
            const hit = keyCandidates.find((f) => rec[f] !== undefined)
            if (hit !== undefined) {
                key = String(typeof rec[hit] === 'object' ? (Array.isArray(rec[hit]) ? rec[hit][0] : JSON.stringify(rec[hit])) : rec[hit])
                keyFieldsUsed = [hit]
            }
            else key = `#${i}`
        }
        if (key === '' || key === 'undefined') { skipped++; continue }
        if (valueFieldUsed !== null) {
            const v = getPath(rec, valueFieldUsed)
            // 明确指定了 valueField 但该记录没有这个字段 ⇒ 跳过（算 skipped），不要伪造成空字符串
            if (v === undefined) { skipped++; continue }
            if (map.has(key)) dupes.set(key, (dupes.get(key) ?? 1) + 1)
            map.set(key, norm(v === null ? null : (typeof v === 'object' ? textOfAny(v) : v))) // 保留类型（审计 F10）+ 归一化
        }
        else {
            const rest = { ...rec }
            for (const f of keyFieldsUsed)
                if (Object.prototype.hasOwnProperty.call(rest, f)) delete rest[f]
            const restKeys = Object.keys(rest)
            // 记录模式：若只剩一个"值字段"（value/text/msgstr/…），直接取字符串，省得用 record 包一层
            const lone = restKeys.length === 1 ? restKeys[0] : null
            const scalar = lone !== null && (lone === 'value' || valueCandidates.includes(lone.toLowerCase()))
            if (scalar) {
                // 记下"自动收敛到哪个字段"：整批记录都收敛到同一个字段时，把它回传成 valueField，
                // 否则调用方（table_diff）仍以为在整行模式，会对**字符串**做 Object.keys ⇒ 按字符比较
                if (scalarField === undefined) scalarField = lone
                else if (scalarField !== lone) scalarField = null
                if (scalarField === null && scalarCount > 0) scalarField = false
                scalarCount++
                if (map.has(key)) dupes.set(key, (dupes.get(key) ?? 1) + 1)
                map.set(key, norm(typeof rest[lone] === 'object' ? textOfAny(rest[lone]) : rest[lone])) // 保留类型（审计 F10）
            }
            else {
                scalarField = false
                if (map.has(key)) dupes.set(key, (dupes.get(key) ?? 1) + 1)
                map.set(key, norm(rest))
            }
        }
    }
    const effectiveValueField = valueFieldUsed !== null ? valueFieldUsed : (typeof scalarField === 'string' ? scalarField : null)
    const duplicateKeys = dupes.size
    const duplicateRows = [...dupes.values()].reduce((s, n) => s + (n - 1), 0)
    return {
        map,
        stats: {
            rows: map.size,
            skipped,
            keyFields: keyFieldsUsed,
            valueField: effectiveValueField,
            normalize: normMode,
            ordered: normOrdered,
            scalarAuto: typeof scalarField === 'string',
            duplicateKeys,
            duplicateRows,
            duplicateSamples: [...dupes.entries()].slice(0, 5).map(([k, n]) => `${k}×${n}`),
        },
    }
}

function textOfAny(v) {
    if (v === null || v === undefined) return ''
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.length > 0 ? textOfAny(v[0]) : ''
    if (typeof v === 'object') {
        if (v.__fn !== undefined) return v.__fn.returns.length > 0 ? v.__fn.returns[0] : ''
        if (v.__array !== undefined) return textOfAny(v.__array)
        for (const k of ['value', 'text', 'msgstr', 'translation', 'target', 'handle_func']) {
            if (v[k] !== undefined) return textOfAny(v[k])
        }
        const first = Object.values(v).find((x) => typeof x === 'string')
        return first ?? ''
    }
    return String(v)
}

/**
 * 用一张查找表给 A/B 重命名 key（跨表对照：term → loc key）。
 * `mode` 决定**同一个 from 出现多行**时怎么办（术语↔loc key 天然一对多）：
 *   last（默认，保持旧行为）/ first / all（一个键展开成多个）。
 * 返回 { map, multiCount, rows }，调用方要把 multiCount 报给用户 —— 否则命中率低时无从判断原因。
 */
export function buildKeyMap(records, fromField, toField, mode = 'last') {
    const want = ['first', 'last', 'all'].includes(mode) ? mode : 'last'
    const map = new Map()
    const multi = new Set()
    let rows = 0
    for (const rec of records) {
        const from = fromField ? textOfAny(getPath(rec, fromField)) : textOfAny(getPath(rec, 'key') ?? getPath(rec, DEFAULT_KEY_FIELDS[1]))
        const to = toField ? textOfAny(getPath(rec, toField)) : textOfAny(getPath(rec, 'value'))
        if (from === '' || to === '') continue
        rows++
        if (want === 'all') {
            const cur = map.get(from)
            if (cur === undefined) map.set(from, [to])
            else { cur.push(to); multi.add(from) }
        }
        else {
            if (map.has(from)) multi.add(from)
            if (want === 'last' || !map.has(from)) map.set(from, to)
        }
    }
    return { map, multiCount: multi.size, rows, mode: want }
}

/** 值模式 diff：Map<key, value> vs Map<key, value>（值可以是任意标量——比较时保留类型） */
export function diffTables(A, B, { limit = 50, showValues = false, only = 'all', filter = null, ci = false, trim = false } = {}) {
    const norm = (s) => {
        let v = s
        if (trim) v = String(v).trim()
        return ci ? String(v).toLowerCase() : v
    }
    let am = A
    let bm = B
    if (ci || trim) {
        am = new Map()
        for (const [k, v] of A) am.set(norm(k), v)
        bm = new Map()
        for (const [k, v] of B) bm.set(norm(k), v)
    }
    const re = filter ? new RegExp(filter, 'i') : null
    const allAdded = []
    const allRemoved = []
    const allChanged = []
    for (const [k, v] of bm) {
        if (re && !re.test(k)) continue
        if (!am.has(k)) allAdded.push({ key: k, b: v })
        else {
            const a = am.get(k)
            // ⚠️ **保留类型**地比较（审计 F10）：以前投影阶段就把值 `String()` 化 ⇒ `1` 与 `"1"`、
            // `true` 与 `"true"`、`null` 与 `""` 被判为相同，diff 会漏报真实差异。
            // 词级 diff 只在**要展示的行**上算（以前对全部 changed 都算：13.9 万行时纯属浪费）
            if (!sameValue(a, v)) allChanged.push({ key: k, a, b: v, diff: null })
        }
    }
    for (const [k, v] of am) {
        if (re && !re.test(k)) continue
        if (!bm.has(k)) allRemoved.push({ key: k, a: v })
    }
    const byKey = (x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
    allAdded.sort(byKey)
    allRemoved.sort(byKey)
    allChanged.sort(byKey)
 // **`only=same`**（MCMOD 评审建议 1）：列出"两侧键相同、值也相同"的条目 —— 多语言词表
    // 最常问的就是"哪些已经是翻好的/哪些还没翻"（旧做法要自己手搓）。此时 added/removed/changed 计数照旧。
    const allSame = []
    for (const [k, v] of bm) {
        if (re && !re.test(k)) continue
        if (am.has(k) && sameValue(am.get(k), v)) allSame.push({ key: k, value: v })
    }
    allSame.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    // 计数永远是**真实总数**；`only` 只影响展示哪一段（否则 only=added 时三个计数全 0，看起来像"没有差异"）
    const shown = (list, name) => (only === 'all' || only === name ? list.slice(0, limit) : [])
    const shownChanged = shown(allChanged, 'changed')
    if (showValues) for (const r of shownChanged) r.diff = wordDiff(r.a, r.b) // 只给要展示的行算词级 diff
    return {
        mode: 'values',
        only,
        hidden: only === 'all' ? null : `（只展示了 ${only} 段；计数是真实总数）`,
        counts: { a: am.size, b: bm.size, added: allAdded.length, removed: allRemoved.length, changed: allChanged.length, same: allSame.length },
        added: shown(allAdded, 'added'),
        removed: shown(allRemoved, 'removed'),
        changed: shownChanged,
        same: shown(allSame, 'same'),
        truncated: allAdded.length > limit || allRemoved.length > limit || allChanged.length > limit || allSame.length > limit,
    }
}

/** 把任意字段值规范化成可比较、可显示的字符串（函数节点取 return 文本、数组拼接、对象 JSON） */
export function canonicalValue(v) {
    if (v === null || v === undefined) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (Array.isArray(v)) return v.map(canonicalValue).join(' | ')
    if (typeof v === 'object') {
        if (v.__fn !== undefined) return v.__fn.returns.length > 0 ? v.__fn.returns[0] : '(function)'
        if (v.__array !== undefined) return canonicalValue(v.__array)
        return JSON.stringify(v)
    }
    return String(v)
}

/** 记录模式 diff：Map<key,record> vs Map<key,record>，逐字段列出变化 */
export function diffRecords(A, B, { limit = 50, showValues = true, only = 'all', filter = null } = {}) {
    const re = filter ? new RegExp(filter, 'i') : null
    const allAdded = []
    const allRemoved = []
    const allChanged = []
    for (const [k, b] of B) {
        if (re && !re.test(k)) continue
        if (!A.has(k)) { allAdded.push({ key: k, b }); continue }
        const a = A.get(k)
        // 值不是对象（字符串/数字）时不要对字符串做 Object.keys（那会变成按**字符**比较、字段名是 0/1）
        const aIsObj = a !== null && typeof a === 'object'
        const bIsObj = b !== null && typeof b === 'object'
        if (!aIsObj || !bIsObj) {
            const av = canonicalValue(a)
            const bv = canonicalValue(b)
            if (av !== bv) allChanged.push({ key: k, fields: [{ field: '(value)', a: av, b: bv, diff: null }] })
            continue
        }
        const fields = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
        const deltas = []
        for (const f of fields) {
            // 结构值（函数节点/数组/嵌套表）也参与比较：以前用引用比较，导致每一条都"changed"
            const av = canonicalValue(a?.[f])
            const bv = canonicalValue(b?.[f])
            if (av === bv) continue
            deltas.push({ field: f, a: av, b: bv, diff: null })
        }
        if (deltas.length > 0) allChanged.push({ key: k, fields: deltas })
    }
    for (const [k, a] of A) {
        if (re && !re.test(k)) continue
        if (!B.has(k)) allRemoved.push({ key: k, a })
    }
    const byKey = (x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
    allAdded.sort(byKey)
    allRemoved.sort(byKey)
    allChanged.sort(byKey)
    const shown = (list, name) => (only === 'all' || only === name ? list.slice(0, limit) : [])
    const shownChanged = shown(allChanged, 'changed')
    if (showValues) for (const r of shownChanged) for (const f of r.fields) f.diff = wordDiff(f.a, f.b) // 只给展示行算
    return {
        mode: 'records',
        only,
        hidden: only === 'all' ? null : `（只展示了 ${only} 段；计数是真实总数）`,
        counts: { a: A.size, b: B.size, added: allAdded.length, removed: allRemoved.length, changed: allChanged.length },
        added: shown(allAdded, 'added'),
        removed: shown(allRemoved, 'removed'),
        changed: shownChanged,
        truncated: allAdded.length > limit || allRemoved.length > limit || allChanged.length > limit,
    }
}

/** 词级 +/- 摘要 */
export function wordDiff(a, b, maxWords = 40) {
    const A = String(a ?? '').split(/\s+/).filter(Boolean)
    const B = String(b ?? '').split(/\s+/).filter(Boolean)
    const setB = new Set(B)
    const setA = new Set(A)
    return {
        minus: A.filter((w) => !setB.has(w)).slice(0, maxWords).join(' '),
        plus: B.filter((w) => !setA.has(w)).slice(0, maxWords).join(' '),
    }
}

/** 两侧都是 SQLite 且行数巨大时：ATTACH + SQL FULL OUTER JOIN（兜底，不把百万行塞进 JS） */
export async function diffSqliteLarge(specA, specB, { limit = 50, threshold = 2_000_000, keyColA = null, valueColA = null, keyColB = null, valueColB = null } = {}) {
    const { DatabaseSync } = await import('node:sqlite')
    const tableOf = (spec) => {
        const hash = spec.indexOf('#')
        const frag = hash < 0 ? '' : spec.slice(hash + 1)
        const m = /^([^(]*)(?:\(([^)]*)\))?/.exec(frag)
        const cols = (m?.[2] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
        return { path: hash < 0 ? spec : spec.slice(0, hash), table: (m?.[1] ?? '').trim(), key: cols[0] ?? null, value: cols[1] ?? null }
    }
    const ta = tableOf(specA)
    const tb = tableOf(specB)
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`
    /**
     * **轻量探测**（审计 F8）：以前这里调 `recordsFrom()` 把两侧**整表读进 JS** 只为数行数 ——
     * 那正是这条路径本要避免的开销（200 万行实测 8.7 s / 1.7 GB）。现在只跑 `select count(*)`
     * 与列名，顺便把 `#table(k,v)` 里的列名带出来。
     */
    const probe = (info) => {
        let db = null
        try {
            db = new DatabaseSync(info.path, { readOnly: true })
            let table = info.table
            if (table === '' || table === undefined) {
                const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name)
                if (tables.length === 0) return null
                table = tables[0]
            }
            const rows = db.prepare(`select count(*) as c from ${q(table)}`).get().c
            const columns = db.prepare(`pragma table_info(${q(table)})`).all().map((c) => c.name)
            return { path: info.path, table, rows, columns }
        }
        catch {
            return null
        }
        finally {
            if (db !== null) db.close()
        }
    }
    const a = probe(ta)
    const b = probe(tb)
    if (a === null || b === null) return null
    if (a.rows < threshold && b.rows < threshold) return null
    const pick = (side, info) => {
        const cols = side.columns
        const key = (info.key !== null && cols.includes(info.key) ? info.key : null) ?? cols.find((c) => /key|id|msgid|term/i.test(c)) ?? cols[0]
        const value = (info.value !== null && cols.includes(info.value) ? info.value : null) ?? cols.find((c) => /value|text|msgstr|trans/i.test(c)) ?? cols[1]
        return { key, value }
    }
    const ca = pick(a, ta)
    const cb = pick(b, tb)
    const ka = keyColA ?? ca.key
    const va = valueColA ?? ca.value
    const kb = keyColB ?? cb.key
    const vb = valueColB ?? cb.value
    const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`
    const db = new DatabaseSync(':memory:')
    try {
        db.exec(`attach database ${sqlStr(ta.path)} as A`)
        db.exec(`attach database ${sqlStr(tb.path)} as B`)
 // ⚠️ **必须建索引**（实测血的教训）：直接对两侧子查询做 FULL OUTER JOIN，
        // 因为键列没有索引，SQLite 退化成嵌套扫描 —— 20 万 × 20 万 = 4×10^10 次比较，我的探针
        // 跑了 9 分钟还没结束（而且 node:sqlite 是**同步**调用，JS 定时器插不进去，宿主会被冻住）。
        // 所以先把两侧各物化进带索引的临时表，再让 SQLite 走索引连接：O(N log M) 且可预测。
        // 临时表用文件后端（temp_store=FILE），避免两百万行把内存吃光。
        db.exec('pragma temp_store = 1') // 1 = FILE
        db.exec(`create temp table ak as select ${q(ka)} as k, ${q(va)} as v from A.${q(a.table)}`)
        db.exec(`create temp table bk as select ${q(kb)} as k, ${q(vb)} as v from B.${q(b.table)}`)
        db.exec('create index temp.idx_ak on ak(k)')
        db.exec('create index temp.idx_bk on bk(k)')
        const count = (where) => db.prepare(`select count(*) as c from ak join bk on bk.k = ak.k ${where}`).get().c
        const changedTotal = count('where bk.v is not ak.v')
        const removedTotal = db.prepare('select count(*) as c from ak where not exists (select 1 from bk where bk.k = ak.k)').get().c
        const addedTotal = db.prepare('select count(*) as c from bk where not exists (select 1 from ak where ak.k = bk.k)').get().c
        const added = addedTotal === 0 ? [] : db.prepare(`select bk.k as key, bk.v as b from bk where not exists (select 1 from ak where ak.k = bk.k) limit ${Math.max(0, Math.trunc(limit))}`).all()
        const removed = removedTotal === 0 ? [] : db.prepare(`select ak.k as key, ak.v as a from ak where not exists (select 1 from bk where bk.k = ak.k) limit ${Math.max(0, Math.trunc(limit))}`).all()
        const changed = changedTotal === 0 ? [] : db.prepare(`select ak.k as key, ak.v as a, bk.v as b from ak join bk on bk.k = ak.k where bk.v is not ak.v limit ${Math.max(0, Math.trunc(limit))}`).all()
        return {
            mode: 'values',
            via: 'sqlite-indexed-join',
            counts: { a: a.rows, b: b.rows, added: addedTotal, removed: removedTotal, changed: changedTotal },
            added,
            removed,
            changed,
            truncated: addedTotal > limit || removedTotal > limit || changedTotal > limit,
            keyCols: { a: ka, b: kb },
            valueCols: { a: va, b: vb },
        }
    }
    finally {
        db.close()
    }
}

// --- 工具注册 ----------------------------------------------------------------

const textOutput = () => ({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
})

function toValueSchema(jsonSchema) {
    const out = {}
    const required = new Set(jsonSchema?.required ?? [])
    for (const [key, value] of Object.entries(jsonSchema?.properties ?? {})) {
        out[key] = { ...value }
        if (required.has(key)) out[key].required = true
    }
    return out
}

/** records 模式下 added/removed 的值是"整条记录"，直接插进模板串会变成 `[object Object]`
 * （Darktide 实测报的）。改成紧凑字段摘要：`{f1=v1, f2=v2 …+N}`。 */
function recordSummary(rec, maxFields = 4) {
    if (rec === null || rec === undefined) return ''
    if (typeof rec !== 'object') return clip(canonicalValue(rec), 120)
    const keys = Object.keys(rec)
    const parts = keys.slice(0, maxFields).map((k) => `${k}=${clip(canonicalValue(rec[k]), 40)}`)
    const more = keys.length > maxFields ? ` …+${keys.length - maxFields}` : ''
    return `{${parts.join(', ')}${more}}`
}

function renderResult(head, d, { showValues, limit, notComparable = null }) {
    // 一侧没读到数据（0 文件 / 0 记录 / 0 个键）时，计数与 "no differences" 都是假的 —— 必须置顶告警并**替换**结论行。
    // ⚠️ 判定必须用**结构化标志**（notComparable），不能靠"head 里有没有 ⚠⚠"：
    //     ① 别的告警（例如投影丢行、两侧模式不一致）也带 ⚠⚠，会被误判成"无法比较"；
 // ② 文件名里出现 ⚠⚠ 也会触发（子代理审计 F19）。
    const warnings = head.filter((l) => String(l).includes('⚠⚠'))
    const others = head.filter((l) => !String(l).includes('⚠⚠'))
    const inconclusive = notComparable !== null
    const lines = [
        ...warnings,
        ...others,
        `mode=${d.mode}${d.via ? ` via=${d.via}` : ''}  added=${d.counts.added} removed=${d.counts.removed} changed=${d.counts.changed}${d.hidden ? `  ${d.hidden}` : ''}${d.truncated ? ` (每段最多显示 ${limit} 条)` : ''}`,
    ]
    if (inconclusive) lines.push('', `无法比较：${notComparable}（不是"没有差异"）`)
    else if (d.counts.added + d.counts.removed + d.counts.changed === 0) lines.push('', 'no differences')
    if (d.added.length > 0) {
        lines.push('', '--- only in B (added) ---')
        for (const r of d.added) lines.push(`+ ${r.key}${showValues ? ` = ${d.mode === 'records' ? recordSummary(r.b) : clip(String(r.b ?? ''), 120)}` : ''}`)
    }
    if (d.removed.length > 0) {
        lines.push('', '--- only in A (removed) ---')
        for (const r of d.removed) lines.push(`- ${r.key}${showValues ? ` = ${d.mode === 'records' ? recordSummary(r.a) : clip(String(r.a ?? ''), 120)}` : ''}`)
    }
    if (d.changed.length > 0) {
        lines.push('', '--- changed ---')
        for (const r of d.changed) {
            if (d.mode === 'values') {
                lines.push(`~ ${r.key}`)
                if (showValues) {
                    lines.push(`    A: ${clip(r.a, 140)}`)
                    lines.push(`    B: ${clip(r.b, 140)}`)
                    if (r.diff && (r.diff.minus || r.diff.plus)) lines.push(`    - ${clip(r.diff.minus, 100)}   |   + ${clip(r.diff.plus, 100)}`)
                }
            }
            else {
                lines.push(`~ ${r.key}  (${r.fields.length} field(s))`)
                for (const f of r.fields) {
                    lines.push(`    ${f.field}: ${clip(f.a, 70)}  ->  ${clip(f.b, 70)}`)
                    if (showValues && f.diff && (f.diff.minus || f.diff.plus)) lines.push(`        - ${clip(f.diff.minus, 80)}  |  + ${clip(f.diff.plus, 80)}`)
                }
            }
        }
    }
    if (d.same && d.same.length > 0) {
        // `only=same`：两侧键与值都相同 —— 词表工作流里就是"这些已经是翻好的/两边一致"
        lines.push('', '--- same on both sides (identical values) ---')
        for (const r of d.same) lines.push(`= ${r.key}${showValues ? ` = ${clip(r.value, 140)}` : ''}`)
    }
    return lines.join('\n')
}

export function tools(defineTool, options = {}) {
    const tool = (def) => defineTool({ ...def, parameters: toValueSchema(def.parameters) })
 // （提案 P3）：多列一次比对的实现方式 —— 工具**自引用**递归，避免搬动 execute 里那一大段 pipeline
    let selfDiff = null
    /**
     * 解析 `valueFields`（P3）：接受数组或逗号分隔字符串，每项 `A:B`（省略 `:` 表示两侧同字段）。
     * 返回 null 表示没给（走单列路径，行为不变）；给空数组 ⇒ 报错（避免"以为比了其实没比"）。
     */
    function parseValueFields(spec) {
        if (spec === undefined || spec === null || spec === '') return null
        const list = Array.isArray(spec) ? spec : String(spec).split(',')
        const out = []
        for (const raw of list) {
            const s = String(raw ?? '').trim()
            if (s === '') continue
            const idx = s.indexOf(':')
            if (idx < 0) out.push({ a: s, b: s })
            else {
                const b = s.slice(idx + 1)
                // 「其他姿势」审计：`en:zh-cn:xx` 这种多半是写错了（字段名本身含冒号的场景我们不支持）⇒ 直接报错，别猜
                if (b.includes(':')) throw new Error(`valueFields 的 "${s}" 里有多个冒号 —— 每项只能是 A:B 形式`)
                out.push({ a: s.slice(0, idx).trim(), b: b.trim() })
            }
        }
        if (out.length === 0) throw new Error('valueFields 是空的：写成 ["en:zh-cn","en:ru"] 这样（A:B = 两侧各自的 valueField）')
        return out
    }
    // 宿主插件进程的 cwd 是 **profile 目录**，不是会话工作区 —— 相对路径必须显式解析。
 // 首选**调用方会话**的 cwd（实测路径：exec.agent.session.header.cwd，用 DSH_TOOLKIT_DUMP_EXEC=1 dump 出来的），
    // 其次回退到"最新会话的工作区"，最后才是 process.cwd()。
    const resolvePath = (p, exec) => {
        if (typeof p !== 'string' || p === '') return p
        if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(p)) return p
        const hash = p.indexOf('#')
        const head = hash < 0 ? p : p.slice(0, hash)
        const frag = hash < 0 ? '' : p.slice(hash)
        const candidates = []
        try {
            const cwd = exec?.agent?.session?.header?.cwd
            if (typeof cwd === 'string' && cwd !== '') candidates.push(cwd)
        }
        catch { /* ignore */ }
        try {
            const cwd = options.resolveWorkspaceCwd?.()
            if (typeof cwd === 'string' && cwd !== '') candidates.push(cwd)
        }
        catch { /* ignore */ }
        candidates.push(process.cwd())
        // glob 不能对整串 existsSync（带 * 永远为假）—— 改测"第一个通配符之前的基目录"，
        // 否则相对 glob 会被原样返回，再由 expandGlob 按 process.cwd()（profile 目录）去列目录 ⇒ 0 文件。
        const isGlob = /[*?]/.test(head)
        const probe = isGlob ? globBaseOf(head) : head
        for (const base of candidates) {
            const cand = join(base, probe)
            if (existsSync(cand)) return `${isGlob ? join(base, head) : cand}${frag}`
        }
        return p
    }
    const srcProps = (side) => ({
        type: 'string',
        description: `Side ${side}: file path, or path#table for SQLite. Supported: .lua .json .jsonl .csv .tsv .po .properties/.env/.ini .yaml .sqlite (unknown extension is auto-guessed).`,
    })
    const list = [
        tool({
            name: 'table_diff',
            description: 'Generic two-table diff using a hash join (O(N+M), never N*M) — for glossaries, localizations, configs, CSV/SQLite exports. Auto-detects Lua / JSON / JSONL / CSV / TSV / PO / properties / YAML / SQLite. Project a key and optionally a value per side, or omit the value to compare whole records. If either side reads 0 files or 0 records the output STARTS with ⚠⚠ and the summary says 无法比较 — that is NOT "no differences"; fix the input first. Call toolkit_help (topic table-diff) for examples, mapA/mapB recipes and pitfalls.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    a: { type: 'string', description: 'Left source: file, glob (matched files merge into ONE key space; duplicates reported), path#table(k,v) for SQLite, .jar/.zip, or mod.jar#entry:NAME. Relative paths resolve against the CALLING SESSION workspace.' },
                    b: { type: 'string', description: 'Right source (same syntax as a).' },
                    format: { type: 'string', description: 'Force one format for both sides (default: auto by extension). .jar/.zip = entry list; mod.jar#entry:NAME = parse that entry.' },
                    formatA: { type: 'string', description: 'Force the format of side A only.' },
                    formatB: { type: 'string', description: 'Force the format of side B only.' },
                    keyField: { type: 'string', description: 'Key projection for BOTH sides; dotted paths, "+" joins several (e.g. "id+locale", "tags[0]"). Default: auto-detect.' },
                    valueField: { type: 'string', description: 'Value projection for BOTH sides (e.g. "value", "text"). Default: none -> compare whole records.' },
                    keyFieldA: { type: 'string', description: 'Key projection for A only.' },
                    valueFieldA: { type: 'string', description: 'Value projection for A only.' },
                    keyFieldB: { type: 'string', description: 'Key projection for B only.' },
                    valueFieldB: { type: 'string', description: 'Value projection for B only.' },
                    keyHints: { type: 'array', items: { type: 'string' }, description: 'Extra field names to try FIRST when auto-detecting the key.' },
                    valueHints: { type: 'array', items: { type: 'string' }, description: 'Extra field names to try FIRST when auto-detecting the value.' },
                    mapA: { type: 'string', description: 'Lookup table that renames A keys into B\'s namespace (e.g. term -> loc key); glob allowed.' },
                    mapB: { type: 'string', description: 'Lookup table that renames B keys into A\'s namespace.' },
                    mapAFrom: { type: 'string', description: 'Field in mapA holding the old key (default column "key").' },
                    mapATo: { type: 'string', description: 'Field in mapA holding the new key (default column "value").' },
                    mapBFrom: { type: 'string', description: 'Field in mapB holding the old key (default column "key").' },
                    mapBTo: { type: 'string', description: 'Field in mapB holding the new key (default column "value").' },
                    mapMode: { type: 'string', enum: ['first', 'last', 'all'], description: 'When one key maps to several rows: first/last picks one (default last), all expands to every target. Hit rate is always reported.' },
                    query: { type: 'string', description: 'Custom SQL for SQLite sources (select * from ...).' },
                    filter: { type: 'string', description: 'JavaScript regex; only keys matching are compared.' },
                    ci: { type: 'boolean', description: 'Case-insensitive keys (values mode).' },
                    trim: { type: 'boolean', description: 'Trim keys before comparing (values mode).' },
                    only: { type: 'string', enum: ['all', 'added', 'removed', 'changed', 'same'], description: 'Which section to DISPLAY (same = identical on both sides). Counts are always real totals.' },
                    limit: { type: 'number', description: 'Max rows per section (default 50).' },
                    showValues: { type: 'boolean', description: 'Print values / word-level +/- (default true).' },
                    normalize: { type: 'string', enum: [...NORMALIZE_MODES], description: 'Compare STRUCTURE instead of raw text (default raw) — e.g. two language columns of one glossary, where raw text is always "100% changed". Set-based, duplicates kept. Details: toolkit_help {topic:"table-diff"}.' },
                    ordered: { type: 'boolean', description: 'With normalize: position-sensitive instead of set-based (default false).' },
                    table: { type: 'string', description: 'Lua only: which literal table to read (e.g. "entries"). Needed only when the automatic "biggest literal table" pick is wrong.' },
                    valueFields: { type: 'array', items: { type: 'string' }, description: 'Compare several column pairs in one call: ["en:zh-cn","en:ru"]. "A:B" = valueFieldA:valueFieldB; "A" = both sides. Do not combine with valueField*.' },
                },
                required: ['a', 'b'],
            },
            output: textOutput(),
            async execute(args, exec) {
                dumpExec(exec)
                // 多列一次比（P3）：valueFields=["en:zh-cn","en:ru"] ⇒ 逐对跑同一个工具并把结果分段拼起来
                const pairSpecs = parseValueFields(args?.valueFields)
                if (pairSpecs !== null) {
                    if (args?.valueField !== undefined || args?.valueFieldA !== undefined || args?.valueFieldB !== undefined) {
                        throw new Error('valueFields 与 valueField/valueFieldA/valueFieldB 不能同时给（会互相覆盖）：用 valueFields 一次比多列，或只用其中一种')
                    }
                    const parts = []
                    for (let i = 0; i < pairSpecs.length; i += 1) {
                        const spec = pairSpecs[i]
                        const sub = { ...args, valueFieldA: spec.a, valueFieldB: spec.b }
                        delete sub.valueFields
                        const text = String(await selfDiff.execute(sub, exec))
                        parts.push(`### ${i + 1}/${pairSpecs.length}  ${spec.a} → ${spec.b}\n${text}`)
                    }
                    return parts.join('\n\n')
                }
                // F21：limit 以前没有上下界（0 或负数会输出空表却仍报计数、巨值会刷屏）
                const rawLimit = Number(args?.limit ?? 50)
                const limit = Number.isFinite(rawLimit) ? Math.min(10_000, Math.max(1, Math.trunc(rawLimit))) : 50
                const showValues = args?.showValues !== false
                const notes = []
                // ── F8：两侧都是**普通 SQLite 表**且行数巨大时，走 ATTACH + SQL FULL OUTER JOIN ──
                // 以前 `diffSqliteLarge` 是**死代码**（只有自测直接调它，`table_diff` 永不触发）⇒
                // 文档承诺的"超大结果走 SQL join"从来没生效，200 万行会全部塞进 JS。
                // 只在"没有 glob、没有投影/映射/过滤"的直白场景接管，其余仍走哈希连接（行为不变）。
                const plainSqlite = (spec) => typeof spec === 'string' && spec !== '' && !/[*?[]/.test(spec) && /\.(sqlite3?|db)(#|$)/i.test(spec)
                const noProjection = !args?.keyField && !args?.valueField && !args?.mapA && !args?.mapB && !args?.filter && args?.ci !== true && args?.trim !== true
                if (plainSqlite(args?.a) && plainSqlite(args?.b) && noProjection) {
                    try {
                        const big = await diffSqliteLarge(resolvePath(args.a, exec), resolvePath(args.b, exec), { limit, threshold: LARGE_SQLITE_THRESHOLD })
                        if (big !== null) {
                            const head = [
                                `A  ${args.a}#${big.keyCols.a}/${big.valueCols.a}`,
                                `B  ${args.b}#${big.keyCols.b}/${big.valueCols.b}`,
                                `algorithm: SQL FULL OUTER JOIN（两侧都 ≥ 200 万行，走 ATTACH 而不是把行读进 JS）${big.truncated ? ' (rows truncated)' : ''}`,
                            ]
                            return renderResult(head, big, { showValues, limit, notComparable: null })
                        }
                    }
                    catch (error) {
                        // SQL join 路径失败（缺表/列名不对/WAL 等）不能让整个工具挂掉：记一条提示，继续走哈希连接
                        notes.push(`note: SQL join 路径不可用（${error instanceof Error ? error.message : String(error)}），已回退到哈希连接`)
                    }
                }
                // 投影阶段的"少数据"信号：skipped（键/值字段取不到而被丢的行）与**单文件内**的重复键。
                // 这两类以前从不外显 ⇒ valueField 写错时 3 条记录变 0 个键，工具照样打印 "no differences"
 // （子代理审计 F1/F3：最容易被当成"确实没差异"的假结论）。
                let skippedTotal = 0
                const dupSamples = []
                // glob ⇒ 把匹配到的多个文件按同一 key 空间合并（"整包"对比：49 文件 × 2 那种）
                const load = async (spec, format, keyField, valueField, label) => {
 // **`text:` 前缀 = 内联内容**（新增，评审建议 5）：便于"新写的一段
                    // JSON/TOML/CSV vs 现网文件"直接对比，不用先落临时文件。必须在 `resolvePath`
                    // **之前**拦截，否则会被当相对路径拼进会话工作区；Windows 文件名不能含 `:` ⇒ 零冲突。
                    const inline = typeof spec === 'string' && spec.startsWith('text:')
                    const inlineText = inline ? spec.slice(5) : null
                    if (inline && inlineText.trim() === '') {
                        throw new Error(`${label} 的 text: 前缀后面没有内容 —— 写成 a:"text:{...}" 这样把要对比的内容直接接在后面`)
                    }
                    const resolved = inline ? '<inline>' : resolvePath(spec, exec)
                    const files = inline ? ['<inline>'] : expandGlob(resolved)
                    const map = new Map()
                    const skippedFiles = []
                    let records = 0
                    let duplicateKeys = 0
                    let fmt = format ?? args?.format ?? 'auto'
                    let keyFields = []
                    let valueFieldUsed = null
                    for (const file of files) {
 // （Darktide 复测 #3 连带）：**glob 里个别文件读不出不该打断整个比对** ——
                        // 例如 `Main_Modules/**/*.lua` 会带上运行时加载器 `TALENTS_Modular.lua`（没有数据表）。
                        // 策略：多文件/glob ⇒ 跳过该文件并**大声报出**（进 notes）；单个显式文件 ⇒ 照旧抛错（那是明确要求）。
                        let r
                        try {
                            r = await recordsFrom(file, { format: fmt, query: args?.query, table: args?.table, ...(inline ? { inlineText } : {}) })
                        }
                        catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            if (files.length === 1 && !/[*?]/.test(String(spec))) throw e
                            skippedFiles.push(`${file}（${msg.slice(0, 90)}）`)
                            continue
                        }
                        const p = project(r.records, {
                            // 适配器可以建议键/值列：SQLite 的 `path#table(k,v)` 用 keyHint/valueHint；
                            // 映射适配器宣告 valueField（映射对比最自然的是"名字对名字"⇒ 默认走值模式，
                            // 而不是逐字段的记录模式）。args 显式给了就优先 args。
                            keyField: keyField ?? args?.keyField ?? r.stats.keyHint,
                            valueField: valueField ?? args?.valueField ?? r.stats.valueHint ?? r.stats.valueField,
                            keyHints: args?.keyHints,
                            valueHints: args?.valueHints,
 // （Darktide 提案 P2）：值归一化投影（raw 默认，行为不变）
                            normalize: args?.normalize,
                            ordered: args?.ordered === true,
                        })
                        records += r.stats.records
                        fmt = r.stats.format
                        keyFields = p.stats.keyFields
                        valueFieldUsed = p.stats.valueField
                        skippedTotal += p.stats.skipped ?? 0
                        for (const s of p.stats.duplicateSamples ?? []) if (dupSamples.length < 5) dupSamples.push(`${label}: ${s}`)
                        if (r.stats.note) notes.push(`${label}: ${r.stats.note}`)
                        for (const [k, v] of p.map) {
                            if (map.has(k)) duplicateKeys++
                            map.set(k, v)
                        }
                    }
                    let emptyDetail = null
                    if (files.length === 0) {
                        const where = files.base !== null && files.base !== undefined ? `，基目录 ${files.base}` : ''
                        let sessionCwd = null
                        try { sessionCwd = exec?.agent?.session?.header?.cwd ?? null } catch { sessionCwd = null }
                        const who = sessionCwd !== null ? `（调用方会话工作区：${sessionCwd}）` : ''
                        // 细节并进置顶的 ⚠⚠ 里，避免同一件事报两条（0 文件时 ⚠⚠ 已经说了"没读到"）
                        emptyDetail = `输入 ${spec}；解析后 ${resolved}${where}${who}`
                    }
 // （Darktide 复测 #3）：**用了 glob 就始终回显解析到几个文件**，哪怕只有 1 个 ——
                    // "glob 写窄了"表现为静默少文件，用户看到 `files=1` 也不会怀疑。
                    const usedGlob = !inline && /[*?]/.test(String(spec))
                    if (usedGlob && files.length === 1) {
                        // ⚠️ 别在这条模板里写内层反引号：`…` ** `…` 会被解析成**幂运算符** ⇒ 输出 NaN
 // （实测：语法合法、node --check 通过，运行时才现形）
                        notes.push(`${label}: glob 只匹配到 1 个文件（${files[0]}）—— 确认不是写窄了（**/ 现在能匹配 0 层目录）`)
                    }
                    if (files.length > 1) notes.push(`${label}: 合并 ${files.length} 个文件 → ${map.size} 个键${duplicateKeys ? `（重复键 ${duplicateKeys} 个，后出现的覆盖前面的）` : ''}`)
                    // 读不出的文件**必须点名**（多文件/glob 时跳过而不是打断，但静默跳过同样是坑）
                    if (skippedFiles.length > 0) {
                        const rest = skippedFiles.slice(1, 3).length > 0 ? `；还有 ${skippedFiles.slice(1, 3).join('；')}` : ''
                        notes.push(`⚠⚠ ${label}: 跳过了 ${skippedFiles.length} 个读不出的文件（其余已合并）—— ${skippedFiles[0]}${rest}`)
                    }
                    return { spec, resolved, files, map, emptyDetail, stats: { records, format: files.length > 1 ? `${fmt}×${files.length}` : fmt, keyFields, valueField: valueFieldUsed, duplicateKeys, skipped: skippedTotal, duplicateSamples: dupSamples } }
                }
                const A = await load(args.a, args?.formatA, args?.keyFieldA, args?.valueFieldA, 'A')
                const B = await load(args.b, args?.formatB, args?.keyFieldB, args?.valueFieldB, 'B')
                // 一侧 0 文件 / 0 记录 ⇒ 计数与结论都没有意义；放进 head 里由 renderResult 置顶，并替换掉 "no differences"
                for (const [side, s] of [['A', A], ['B', B]]) {
                    if (s.files.length === 0) {
                        notes.unshift(`⚠⚠ ${side} 侧一个文件都没读到 —— 下面的计数没有意义（${s.emptyDetail ?? s.spec}）`)
                    }
                    else if (s.stats.records === 0) {
                        notes.unshift(`⚠⚠ ${side} 侧读到了 ${s.files.length} 个文件但 0 条记录 —— 解析可能不对，先用 table_peek 看它被读成了什么（format=${s.stats.format}）`)
                    }
                }
                // 归一化必须**说出来**（透明优先）：数字是在"骨架"上比出来的，不说明就会被读成"原文一致"。
 // （提案 P2）：`changed` 在翻译场景里只有配上归一化才有信息量。
                if (args?.normalize !== undefined && args.normalize !== '' && args.normalize !== 'raw') {
                    notes.push(`已按 normalize=${args.normalize} 归一化后比较（${args?.ordered === true ? '位置敏感' : '集合语义：语序差异不算差异'}）—— 想看原文差异就别传 normalize`)
                }
 // 键映射：必须回显命中率 —— 命中 0 时"看起来正常"的统计是最坑的（Darktide 实测白跑两轮）
                const applyMap = async (mapSpec, from, to, map, label, mode) => {
                    if (!mapSpec) return map
                    // 与 a/b 一致：mapA/mapB 也支持 glob（多个映射文件按同一键空间合并）
                    const mapFiles = expandGlob(resolvePath(mapSpec, exec))
                    const mapRecords = []
                    for (const f of mapFiles) {
                        const mr = await recordsFrom(f, {})
                        // **不要用 spread push**：映射表 ≥13 万行时 `push(...arr)` 会因参数个数超限
 // 抛 RangeError（栈溢出），整条链路崩掉（子代理审计 F4 实测阈值
                        // 125000 ok / 130000 崩）。逐条 push 是 O(N) 且无参数上限。
                        for (const r of mr.records) mapRecords.push(r)
                    }
                    if (mapFiles.length === 0) notes.push(`${label} 的映射文件没匹配到任何文件（${mapSpec}）`)
                    const built = buildKeyMap(mapRecords, from, to, mode ?? args?.mapMode)
                    let hit = 0
                    let expanded = 0
                    let expandCapped = 0 // 展开上限（审计 F17）：`mapMode:all` 下一个键可能展开成上万行
                    const out = new Map()
                    for (const [k, v] of map) {
                        const t = built.map.get(k)
                        if (t === undefined) { out.set(k, v); continue }
                        hit++
                        if (Array.isArray(t)) {
                            for (const kk of t) {
                                if (out.size >= MAX_EXPANDED_KEYS && !out.has(kk)) { expandCapped++; continue }
                                if (out.has(kk)) expanded++
                                out.set(kk, v)
                            }
                        }
                        else out.set(t, v)
                    }
                    const pct = map.size === 0 ? 0 : Math.round((hit / map.size) * 100)
                    const modeText = built.mode === 'all' ? '全部' : built.mode === 'first' ? '首行' : '末行'
                    let line = `${label} ${mapSpec}: 解析 ${mapRecords.length} 行（${mapFiles.length} 个文件）→ ${built.map.size} 个映射键（多行键 ${built.multiCount} 个，取${modeText}）  命中 ${hit}/${map.size} (${pct}%)`
                    if (built.mode === 'all' && expanded > 0) line += `  展开后冲突 ${expanded} 个`
                    if (expandCapped > 0) line += `  ⚠⚠ 展开已达上限 ${MAX_EXPANDED_KEYS} 键，另有 ${expandCapped} 个映射结果**被丢弃**（结果不完整；改用 mapMode:first/last，或先收窄映射文件）`
                    if (hit === 0) line += '\n  ⚠ 一个键都没命中 —— 两侧键空间多半对不上：检查 mapAFrom/mapATo、CSV 引号转义、大小写（可加 ci:true）'
                    else if (pct < 5) line += '\n  ⚠ 命中率极低，映射文件很可能用错了字段或格式没解析对（用 table_peek 看它解析成什么）'
                    notes.push(line)
                    return out
                }
                A.map = await applyMap(args?.mapA, args?.mapAFrom, args?.mapATo, A.map, 'mapA', args?.mapMode)
                B.map = await applyMap(args?.mapB, args?.mapBFrom, args?.mapBTo, B.map, 'mapB', args?.mapMode)
                // ── 投影层的"少数据"必须外显（F1/F3）─────────────────────────────────────
                // 以前 skipped 与单文件重复键从不打印 ⇒ valueField 写错时 3 条记录变 0 个键，
 // 输出却是干净的 "no differences"，用户据此下结论（子代理审计）。
                if (skippedTotal > 0) {
                    notes.push(`⚠ 投影阶段丢掉了 ${skippedTotal} 行（key/value 字段取不到）—— 行数对不上时先看这里；可用 table_peek 确认字段名`)
                }
                if (dupSamples.length > 0) {
                    notes.push(`⚠ 单文件内出现重复键（后出现的覆盖前面的）：${dupSamples.join('、')}${dupSamples.length >= 5 ? ' …' : ''} —— 键投影可能选错了（例如该用 id+locale）`)
                }
                if (A.map.size === 0 || B.map.size === 0) {
                    notes.unshift(`⚠⚠ ${A.map.size === 0 ? 'A' : 'B'} 侧投影后 **0 个键** —— 下面的 added/removed/changed 与结论行都不可信（先修 keyField/valueField，用 table_peek 看实际字段）`)
                }
                const valuesMode = Boolean(A.stats.valueField ?? B.stats.valueField)
 // 内联侧（`text:`）**只回显长度**，不把全文喷进表头（MCMOD 复核建议；
                // 与 table_peek 的 `<inline: N 字符>` 保持一致）
                const specLabel = (spec) => (typeof spec === 'string' && spec.startsWith('text:') ? `<inline: ${spec.length - 5} 字符>` : spec)
                const describe = (side, s) => `${side}  ${specLabel(s.spec)}\n     records=${s.stats.records} files=${s.files.length} format=${s.stats.format} key=${s.stats.keyFields.join('+') || 'auto'}${s.stats.valueField ? ` value=${s.stats.valueField}` : ' (whole record)'}${s.stats.skipped ? ` skipped=${s.stats.skipped}` : ''}${s.stats.duplicateKeys ? ` dupKeys=${s.stats.duplicateKeys}` : ''}`
                // ── 两侧模式不一致（F2）──────────────────────────────────────────────────
                // 一侧是整条记录、另一侧是单个值时，旧实现拿**对象**和**字符串**比 ⇒ 所有共有键都报
                // changed，输出里还出现 `A: [object Object]`。这里不直接报错（可能是用户的合法用法），
                // 而是：① 大声告警 ② 把记录侧**按摘要文本**参与比较，保证输出可读、比较有意义。
                // ⚠️ 必须在构建 head **之前**做：告警要能进 head（否则被静默丢掉）。
                const aMode = A.stats.valueField ? 'values' : 'records'
                const bMode = B.stats.valueField ? 'values' : 'records'
                // 一侧根本没好数据时（0 文件/0 记录）不再叠加模式告警 —— 那只会盖住更重要的信息
                const bothHaveData = A.files.length > 0 && B.files.length > 0 && A.stats.records > 0 && B.stats.records > 0
                if (aMode !== bMode && bothHaveData) {
                    const coerce = (s) => {
                        const out = new Map()
                        for (const [k, v] of s.map) out.set(k, typeof v === 'object' && v !== null ? recordSummary(v) : v)
                        return out
                    }
                    notes.unshift(`⚠⚠ 两侧投影模式不一致：A=${aMode}${A.stats.valueField ? `(value=${A.stats.valueField})` : ''}，B=${bMode}${B.stats.valueField ? `(value=${B.stats.valueField})` : ''}。已把记录侧按**摘要文本**参与比较（否则会拿对象比字符串、所有键都报 changed）。要精确比较请两侧都给 valueField 或两侧都不给`)
                    if (aMode === 'records') A.map = coerce(A)
                    if (bMode === 'records') B.map = coerce(B)
                    A.stats.valueField = A.stats.valueField ?? '(记录摘要)'
                    B.stats.valueField = B.stats.valueField ?? '(记录摘要)'
                }
                const head = [
                    describe('A', A),
                    describe('B', B),
                    // [ci]/[trim] 只在**值模式**有意义（记录模式里它们被忽略）—— 审计 F15：以前无条件打印，
                    // 用户以为 K1/k1 被归一化了，实际报成 added+removed
                    `algorithm: hash join O(N+M)${valuesMode ? `${args?.ci ? ' [ci]' : ''}${args?.trim ? ' [trim]' : ''}` : ''}${args?.filter ? ` [filter=/${args.filter}/i]` : ''}`,
                    ...notes,
                ]
                const wholeRecord = !(A.stats.valueField ?? B.stats.valueField)
                const d = wholeRecord
                    ? diffRecords(A.map, B.map, { limit, showValues, only: args?.only ?? 'all', filter: args?.filter ?? null })
                    : diffTables(A.map, B.map, { limit, showValues, only: args?.only ?? 'all', filter: args?.filter ?? null, ci: args?.ci === true, trim: args?.trim === true })
                // 结构化"无法比较"：只有这几种情况才替换结论行（不再靠 ⚠⚠ 字样猜）
                let notComparable = null
                if (A.files.length === 0) notComparable = `A 侧一个文件都没读到（${A.emptyDetail ?? A.spec}）`
                else if (B.files.length === 0) notComparable = `B 侧一个文件都没读到（${B.emptyDetail ?? B.spec}）`
                else if (A.stats.records === 0) notComparable = `A 侧读到 ${A.files.length} 个文件但没有记录（format=${A.stats.format}）`
                else if (B.stats.records === 0) notComparable = `B 侧读到 ${B.files.length} 个文件但没有记录（format=${B.stats.format}）`
                else if (A.map.size === 0) notComparable = 'A 侧投影后 0 个键（keyField/valueField 选错了？）'
                else if (B.map.size === 0) notComparable = 'B 侧投影后 0 个键（keyField/valueField 选错了？）'
                return renderResult(head, d, { showValues, limit, notComparable })
            },
        }),

        tool({
            name: 'table_peek',
            description: 'Read ONE table/source and report how it was parsed: format, record count, detected key/value fields and sample records. Use it to discover the shape before table_diff. Read-only.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    source: { type: 'string', description: 'File path, or path#table for SQLite. Relative paths resolve against the calling session workspace.' },
                    format: { type: 'string', description: 'Force a format. Default: auto by extension.' },
                    keyField: { type: 'string', description: 'Key projection to preview (dotted paths, "+" joins several).' },
                    valueField: { type: 'string', description: 'Value projection to preview.' },
                    keyHints: { type: 'array', items: { type: 'string' }, description: 'Extra key candidates to try first.' },
                    valueHints: { type: 'array', items: { type: 'string' }, description: 'Extra value candidates to try first.' },
                    query: { type: 'string', description: 'Custom SQL for SQLite sources.' },
                    normalize: { type: 'string', enum: [...NORMALIZE_MODES], description: 'Preview the values under a normalization mode (raw default | numbers | placeholders | skeleton | tokens) — same option table_diff uses, so you can see what a diff will compare before running it.' },
                    ordered: { type: 'boolean', description: 'With normalize: position-sensitive instead of set-based (default false).' },
                    table: { type: 'string', description: 'Lua only: name of the literal table to read (when the file defines several; the automatic pick is echoed in note).' },
                    limit: { type: 'number', description: 'How many sample rows (default 10).' },
                },
                required: ['source'],
            },
            output: textOutput(),
            async execute(args, exec) {
                dumpExec(exec)
                // `text:` 前缀同样支持（便于先"看一眼"一段内容会被怎么解析）—— 与 table_diff 对称
                const peekInline = typeof args.source === 'string' && args.source.startsWith('text:')
                // 「其他姿势」审计：空的内联内容以前会静默回 `records=0 format=unknown`（table_diff 那边会报错）⇒ 对齐成报错
                if (peekInline && args.source.slice(5).trim() === '') {
                    throw new Error('source 的 text: 前缀后面没有内容 —— 写成 source:"text:{...}" 这样把要看的内容直接接在后面')
                }
                const r = await recordsFrom(peekInline ? '<inline>' : resolvePath(args.source, exec), { format: args?.format ?? 'auto', query: args?.query, table: args?.table, ...(peekInline ? { inlineText: args.source.slice(5) } : {}) })
                const p = project(r.records, { keyField: args?.keyField ?? r.stats.keyHint, valueField: args?.valueField ?? r.stats.valueHint ?? r.stats.valueField, keyHints: args?.keyHints, valueHints: args?.valueHints, normalize: args?.normalize, ordered: args?.ordered === true })
                const lines = [
                    `${args.source}`,
                    `format=${r.stats.format} records=${r.stats.records}${r.stats.skipped ? ` skipped=${r.stats.skipped}` : ''}${r.stats.source ? ` source=${r.stats.source}` : ''}`,
                    r.stats.note ? `note: ${r.stats.note}` : '',
                    `key projection: ${p.stats.keyFields.join('+') || 'auto'}${p.stats.valueField ? `   value projection: ${p.stats.valueField}` : '   (whole record)'}${p.stats.normalize && p.stats.normalize !== 'raw' ? `   normalize: ${p.stats.normalize}${p.stats.ordered ? ' (ordered)' : ''}` : ''}`,
                ].filter(Boolean)
                // SQLite 且调用方没给 #table：把库内表名列出来（行数 + 列 + 候选 key 字段），别让人猜
                if (Array.isArray(r.stats.tables) && r.stats.tables.length > 0) {
                    const shown = Array.isArray(r.stats.tablesShown) ? r.stats.tablesShown : r.stats.tables
                    lines.push(`tables in this database (${r.stats.tablesTotal ?? r.stats.tables.length}${r.stats.tables.length > shown.length ? `, showing ${shown.length}` : ''}):`)
                    for (const t of shown) {
                        const keyHint = (t.columns ?? []).find((c) => /^(hash|key|id|msgid|term|en|name)$/i.test(c)) ?? (t.columns ?? [])[0] ?? '?'
                        const valHint = (t.columns ?? []).find((c) => /^(value|text|msgstr|translation|uk|zh|en)$/i.test(c) && c !== keyHint) ?? '?'
                        lines.push(`  ${t.name}  rows=${t.rows ?? '?'}  key≈${keyHint} value≈${valHint}  cols=${(t.columns ?? []).slice(0, 12).join(',')}`)
                    }
                    lines.push('hint: 用 `path#table` 指定表，例如 `…sqlite#uk`')
                }
                if (r.records.length > 0) lines.push(`record fields: ${Object.keys(r.records[0]).slice(0, 24).join(', ')}`)
                let i = 0
                for (const [k, v] of p.map) {
                    if (i++ >= (args?.limit ?? 10)) break
                    lines.push(`  ${k} = ${clip(typeof v === 'string' ? v : JSON.stringify(v), 140)}`)
                }
                return lines.join('\n')
            },
        }),
    ]
    // P3 的自引用：多列循环里调用"同一个工具"的单列路径（sub 里已删掉 valueFields ⇒ 不会无限递归）
    selfDiff = list[0]
    return list
}

export function apply(ctx, defineTool, options = {}) {
    const list = tools(defineTool, options)
    for (const t of list) ctx.tools.register(t)
    return list.length
}

export { recordsFrom }

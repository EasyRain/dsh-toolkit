/**
 * lib/tablediff/toml.js —— **零依赖**的 TOML 读取（新增；起因：MC 模组元数据
 * `mods.toml` / `neoforge.mods.toml` 是 TOML，而 `table_diff` 此前支持 JSON/YAML/CSV/TSV/PO/
 * properties/Lua/SQLite **唯独缺 TOML**）。
 *
 * 覆盖范围（够 MC 元数据 + 常规配置用；**不追求完整 TOML 1.0 规范**，遇到不支持的语法会在
 * `stats.note` 里点名，而不是静默吞掉）：
 *   - `[table]` / `[[array of tables]]` / 点号键 `a.b = 1`
 *   - 基本字符串 `"…"`、多行 `"""…"""`、字面量 `'…'`、多行 `'''…'''`
 *   - 整数 / 浮点 / 布尔 / 下划线分隔数字 / 十六进制
 *   - 数组（含跨行）、内联表 `{ a = 1, b = "x" }`
 *   - 注释 `#`、行尾逗号
 * 输出**扁平化**成 `section.0.key = value` 的记录数组，便于 `table_diff` 逐键对比。
 */

/** 把 TOML 文本解析成记录数组 `[{ key, value }]`（扁平、路径式键名） */
export function tomlRecords(text) {
    const stats = { format: 'toml', records: 0, skipped: 0, note: null, source: null, keyFields: ['key'], valueField: 'value' }
    const records = []
    const problems = []
    const lines = String(text).split(/\r?\n/)
    /** 当前表路径（含数组表的下标） */
    let tablePath = []
    /** 同名数组表计数：'a.b' → 已出现次数 */
    const arrayCounters = new Map()

    const setValue = (keyPath, value) => {
        const full = [...tablePath, ...keyPath].join('.')
        records.push({ key: full, value: typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value) })
    }

    // --- 值解析 ---------------------------------------------------------------
    const parseString = (s, i) => {
        const q = s[i]
        const triple = s.startsWith(q.repeat(3), i)
        const quote = triple ? q.repeat(3) : q
        let j = i + quote.length
        let out = ''
        while (j < s.length) {
            if (triple && s.startsWith(quote, j)) return { value: out, next: j + 3 }
            if (!triple && s[j] === quote) return { value: out, next: j + 1 }
            const c = s[j]
            if (q === '"' && c === '\\') {
                const n = s[j + 1]
                const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }
                if (n === 'u' || n === 'U') {
                    const len = n === 'u' ? 4 : 8
                    out += String.fromCodePoint(parseInt(s.slice(j + 2, j + 2 + len), 16))
                    j += 2 + len
                    continue
                }
                out += simple[n] ?? n
                j += 2
                continue
            }
            out += c
            j += 1
        }
        problems.push('未闭合的字符串')
        return { value: out, next: s.length }
    }

    const parseValue = (s, i) => {
        while (s[i] === ' ' || s[i] === '\t') i += 1
        const c = s[i]
        if (c === '"' || c === "'") {
            const r = parseString(s, i)
            return { value: r.value, next: r.next }
        }
        if (c === '[') {
            const arr = []
            let j = i + 1
            for (;;) {
                while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === ',') j += 1
                if (j >= s.length) { problems.push('未闭合的数组'); break }
                if (s[j] === ']') { j += 1; break }
                const r = parseValue(s, j)
                arr.push(r.value)
                j = r.next
            }
            return { value: arr, next: j }
        }
        if (c === '{') {
            const obj = {}
            let j = i + 1
            for (;;) {
                while (s[j] === ' ' || s[j] === '\t' || s[j] === ',' ) j += 1
                if (j >= s.length) { problems.push('未闭合的内联表'); break }
                if (s[j] === '}') { j += 1; break }
                const eq = s.indexOf('=', j)
                if (eq < 0) { problems.push('内联表缺 ='); break }
                const k = s.slice(j, eq).trim().replace(/^["']|["']$/g, '')
                const r = parseValue(s, eq + 1)
                obj[k] = r.value
                j = r.next
            }
            return { value: obj, next: j }
        }
        // 标量：吃到行尾/逗号/右括号
        let j = i
        while (j < s.length && !',]}\n\r'.includes(s[j])) j += 1
        const rawTok = s.slice(i, j).trim()
        if (rawTok === 'true') return { value: true, next: j }
        if (rawTok === 'false') return { value: false, next: j }
        const numTok = rawTok.replace(/_/g, '')
        if (/^[+-]?0x[0-9a-fA-F]+$/.test(numTok)) return { value: parseInt(numTok, 16), next: j }
        if (/^[+-]?\d+$/.test(numTok)) return { value: Number(numTok), next: j }
        if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(numTok)) return { value: Number(numTok), next: j }
        // 日期时间等：原样保留成字符串（diff 仍可用）
        return { value: rawTok, next: j }
    }

    // --- 逐"逻辑行"处理（多行字符串/数组先合并）-------------------------------
    let i = 0
    while (i < lines.length) {
        let line = lines[i]
        i += 1
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue

        // 表头
        const header = /^\[\[?(.+?)\]\]?\s*(#.*)?$/.exec(trimmed)
        if (header !== null && !trimmed.startsWith('[[') === false) {
            const isArray = trimmed.startsWith('[[')
            const rawPath = header[1].split('.').map((p) => p.trim().replace(/^["']|["']$/g, '')).filter((p) => p !== '')
            if (isArray) {
                const key = rawPath.join('.')
                const n = arrayCounters.get(key) ?? 0
                arrayCounters.set(key, n + 1)
                tablePath = [...rawPath.slice(0, -1), `${rawPath[rawPath.length - 1]}.${n}`]
            }
            else {
                tablePath = rawPath
            }
            continue
        }
        if (trimmed.startsWith('[') && !trimmed.startsWith('[[') && /^\[.+\]\s*(#.*)?$/.test(trimmed)) {
            const rawPath = trimmed.slice(1, trimmed.lastIndexOf(']')).split('.').map((p) => p.trim().replace(/^["']|["']$/g, '')).filter((p) => p !== '')
            tablePath = rawPath
            continue
        }

        // 键 = 值（值可能跨多行：多行字符串 / 数组 / 内联表）
        const eq = findTopLevelEquals(line)
        if (eq < 0) { stats.skipped += 1; problems.push(`无法解析：${trimmed.slice(0, 40)}`); continue }
        const keyRaw = line.slice(0, eq).trim()
        let rest = line.slice(eq + 1)
        // 需要续行的情况：多行字符串或括号/方括号未闭合
        const tripleOpen = /=\s*("""|''')/.test(line)
        if (tripleOpen) {
            const marker = /("""|''')/.exec(line)[1]
            while (!rest.includes(marker, rest.indexOf(marker) + 3) && i < lines.length) { rest += `\n${lines[i]}`; i += 1 }
        }
        else {
            while (i < lines.length && countUnclosed(rest) > 0) { rest += ` ${lines[i]}`; i += 1 }
        }
        const parsed = parseValue(rest, 0)
        const keyPath = keyRaw.split('.').map((p) => p.trim().replace(/^["']|["']$/g, '')).filter((p) => p !== '')
        if (keyPath.length === 0) { stats.skipped += 1; continue }
        setValue(keyPath, parsed.value)
    }

    if (problems.length > 0) stats.note = `TOML 解析遇到 ${problems.length} 处未支持/异常语法：${[...new Set(problems)].slice(0, 3).join('；')}`
    stats.records = records.length
    return { records, stats }
}

function findTopLevelEquals(line) {
    let inStr = null
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i]
        if (inStr !== null) {
            if (c === '\\' && inStr === '"') { i += 1; continue }
            if (c === inStr) inStr = null
            continue
        }
        if (c === '"' || c === "'") { inStr = c; continue }
        if (c === '#') return -1
        if (c === '=') return i
    }
    return -1
}

/** 未闭合的 `[`/`{` 个数（用于判断值是否跨行） */
function countUnclosed(s) {
    let depth = 0
    let inStr = null
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i]
        if (inStr !== null) {
            if (c === '\\' && inStr === '"') { i += 1; continue }
            if (c === inStr) inStr = null
            continue
        }
        if (c === '"' || c === "'") { inStr = c; continue }
        if (c === '#' && depth === 0) break
        if (c === '[' || c === '{') depth += 1
        else if (c === ']' || c === '}') depth -= 1
    }
    return Math.max(0, depth)
}

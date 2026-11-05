/**
 * lib/tablediff/lua.js —— 够用的 Lua 子集解析器（零依赖）
 *
 * 为什么需要它：真实的本地化文件不是扁平键值表。在 Darktide 实况：
 *   - 自有 glossary.lua：`["Melee"] = { ["zh-cn"] = "近战", …, uk = "Ближній бій" }`（术语 → 各语言）
 *   - 社区 uk_term.lua ：`{ ["id"] = "loc_…", ["loc_keys"] = { … }, ["handle_func"] = function(locale, value) return "Штурм" end }`
 * 正则抓不动这两种结构，所以这里做 tokenizer + 递归下降，产出 JS 值树：
 *   table → 数组（纯数组部分）/ 普通对象；string/number/boolean/nil 直通；
 *   `function … end` → { __fn: { raw, returns: [函数体里的字符串字面量] } }（本地化文件把译文写在 return 里）。
 *
 * 容错优先：遇到解析不了的位置就跳到下一个 `,` / `}` / `end`，并计入 stats.skipped。
 */

const KEYWORDS = new Set(['true', 'false', 'nil', 'function', 'end', 'return', 'local', 'then', 'else', 'elseif', 'if', 'do', 'while', 'for', 'in', 'and', 'or', 'not', 'break'])

export function tokenize(src) {
    const toks = []
    let i = 0
    const n = src.length
    while (i < n) {
        const c = src[i]
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue }
        if (c === '-' && src[i + 1] === '-') {
            // 注释：`--[[ … ]]` 与 `--[==[ … ]==]`（等级要对齐，否则 `--[==[ ]==]` 里的 `]]` 会提前收尾）
            const lvl = /^\[(=*)\[/.exec(src.slice(i + 2, i + 14))
            if (lvl !== null) {
                const close = `]${lvl[1]}]`
                const end = src.indexOf(close, i + 2 + lvl[0].length)
                i = end < 0 ? n : end + close.length
            }
            else {
                const nl = src.indexOf('\n', i)
                i = nl < 0 ? n : nl + 1
            }
            continue
        }
        // **长字符串**（审计 F16）：`[[ … ]]` / `[=[ … ]=]` 以前完全没处理 ⇒ 里面的 `{`/`}`/引号
        // 会被当成 Lua 语法，整个文件解析失败，于是它在 diff 里显示成"一条被新增的记录"。
        if (c === '[') {
            const lvl = /^\[(=*)\[/.exec(src.slice(i, i + 12))
            if (lvl !== null) {
                const close = `]${lvl[1]}]`
                const start = i + lvl[0].length
                const end = src.indexOf(close, start)
                const content = end < 0 ? src.slice(start) : src.slice(start, end)
                toks.push({ t: 'str', v: content, rawString: true, raw: src.slice(i, end < 0 ? n : end + close.length) })
                i = end < 0 ? n : end + close.length
                continue
            }
        }
        if (c === '"' || c === "'") {
            const quote = c
            let j = i + 1
            let out = ''
            while (j < n) {
                const d = src[j]
                if (d === '\\') { out += src.slice(j, j + 2); j += 2; continue }
                if (d === quote) break
                out += d
                j++
            }
            toks.push({ t: 'str', v: out, raw: src.slice(i, Math.min(j + 1, n)) })
            i = j + 1
            continue
        }
        if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
            let j = i
            while (j < n && /[0-9a-fA-FxX._]/.test(src[j])) j++
            toks.push({ t: 'num', v: src.slice(i, j) })
            i = j
            continue
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i
            while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++
            const w = src.slice(i, j)
            toks.push({ t: KEYWORDS.has(w) ? 'kw' : 'name', v: w })
            i = j
            continue
        }
        if (c === '.' && src[i + 1] === '.') { toks.push({ t: 'op', v: '..' }); i += 2; continue }
        if ('{}[]=,;():.+-*/<>#~'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue }
        toks.push({ t: 'op', v: c })
        i++
    }
    return toks
}

const unescape = (s) => s.replace(/\\(x[0-9A-Fa-f]{2}|[0-7]{1,3}|.)/g, (m, g) => {
    if (g === 'n') return '\n'
    if (g === 't') return '\t'
    if (g === 'r') return '\r'
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16))
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8))
    return g
})

export function parseLuaValue(src, opts = {}) {
    const toks = tokenize(src)
    const stats = { nodes: 0, skipped: 0, functions: 0 }
    let p = 0
    const peek = () => toks[p]
    const next = () => toks[p++]
    const isOp = (v) => peek() !== undefined && peek().t === 'op' && peek().v === v
    const isKw = (v) => peek() !== undefined && peek().t === 'kw' && peek().v === v
    const skipTo = (...stops) => {
        stats.skipped++
        while (p < toks.length) {
            const t = peek()
            if (t.t === 'op' && stops.includes(t.v)) return
            if (t.t === 'kw' && stops.includes(t.v)) return
            p++
        }
    }

    function parseExpr(depth = 0) {
        if (depth > 60) { stats.skipped++; return null }
        const t = peek()
        if (t === undefined) return null
        if (t.t === 'str') { p++; return t.rawString === true ? t.v : unescape(t.v) } // 长字符串不处理转义（Lua 语义）
        if (t.t === 'num') { p++; return Number(t.v) }
        if (t.t === 'kw' && t.v === 'true') { p++; return true }
        if (t.t === 'kw' && t.v === 'false') { p++; return false }
        if (t.t === 'kw' && t.v === 'nil') { p++; return null }
        if (t.t === 'op' && t.v === '{') return parseTable(depth + 1)
        if (t.t === 'kw' && t.v === 'function') return parseFunction(depth + 1)
        if (t.t === 'name' || (t.t === 'op' && t.v === '(')) {
            // 引用/调用/拼接：尽量取值，取不到就当占位
            p++
            let v = { __expr: t.v }
 // ⚠️ （Darktide 复测指出的**最重要一条**）：调用实参以前被 `skipBalanced` 整段丢掉 ⇒
            // 本地化模板形如 `"…" .. CNumb("0","n_0_rgb") .. "|" .. CNumb("20","n_20_rgb")` 时，
            // 抽出来的文本变成 `"…||"`（数字全空）⇒ `normalize=numbers` 系统性漏报、真差异被判 same。
            // 现在**收集字面实参**：保留第一个字面量（它通常是内容，甚至就是一个单词如 "Bleed"），
            // 丢掉"键样子"的实参（纯标识符/下划线，如 `n_0_rgb` / `pc_rgb`）与空串。
            const lits = []
            while (isOp('(')) {
                const args = collectCallLiteralArgs()
                for (let i = 0; i < args.length; i += 1) {
                    const s = args[i]
                    if (s === '') continue
                    const keyLike = /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
                    if (i === 0 || !keyLike) lits.push(s)
                }
                v = { __expr: t.v }
            }
            if (lits.length > 0) v = lits.join(' ')
            while (isOp('.') || isOp('[')) {
                if (isOp('.')) { p++; if (peek() !== undefined) p++ }
                else skipBalanced('[', ']')
            }
            return v
        }
        p++
        return null
    }

    function parseConcat(depth) {
        let v = parseExpr(depth)
        while (isOp('..')) {
            p++
            const r = parseExpr(depth)
            if (typeof v === 'string' && typeof r === 'string') v = v + r
            else if (typeof v === 'string') v = v
            else if (typeof r === 'string') v = r
            else v = { __expr: 'concat' }
        }
        return v
    }

    /**
     * 消费一对 `( … )`，返回**顶层实参里"整体就是字面量"的那些**（字符串/数字，含实参内部的 `..` 拼接）。
     * 含嵌套结构 / 变量 / 调用的实参一律视为"非字面量"不进结果 —— 保守：宁可少取，不可乱取。
     * 用途见 parseExpr 里调用分支的注释（Darktide 的 `CNumb("0","n_0_rgb")` 形状）。
     */
    function collectCallLiteralArgs() {
        const out = []
        if (!isOp('(')) return out
        p++ // (
        let depth = 0
        let cur = null // 当前实参累积的字面量（null = 该实参含非字面量）
        const flush = () => { if (cur !== null) out.push(cur); cur = null }
        while (p < toks.length) {
            const t = peek()
            if (t.t === 'op' && (t.v === '(' || t.v === '{' || t.v === '[')) { depth += 1; if (depth === 1) cur = null; p++; continue }
            if (t.t === 'op' && (t.v === ')' || t.v === '}' || t.v === ']')) {
                if (depth === 0) { if (t.v === ')') p++; break }
                depth -= 1; p++; continue
            }
            if (depth > 0) { p++; continue }
            if (t.t === 'op' && t.v === ',') { flush(); p++; continue }
            if (t.t === 'op' && t.v === '..') { if (cur === null) cur = ''; p++; continue }
            if (t.t === 'str') { cur = (cur === null ? '' : cur) + unescape(t.v); p++; continue }
            if (t.t === 'num') { cur = (cur === null ? '' : cur) + String(Number(t.v)); p++; continue }
            cur = null; p++ // 变量 / 表达式 / 嵌套调用 ⇒ 该实参不算字面量
        }
        flush()
        return out
    }

    function skipBalanced(open, close) {        if (!isOp(open)) return
        let depth = 0
        while (p < toks.length) {
            const t = next()
            if (t.t === 'op' && t.v === open) depth++
            else if (t.t === 'op' && t.v === close) { depth--; if (depth === 0) return }
        }
    }

    function parseFunction(depth) {
        stats.functions++
        p++ // function
        // 参数表
        if (isOp('(')) skipBalanced('(', ')')
        const start = p
        let nesting = 0
        const returns = []
        while (p < toks.length) {
            const t = peek()
 // ⚠️ （Darktide 第三轮复测）：块计数必须**覆盖所有需要 `end` 的结构**，
            // 否则跳过区间会在内层 `if … end` 的 `end` 处提前结束 ⇒ 又扫进函数体 ⇒ 撞上 `return {}` 就 break
            // ⇒ 函数之后的数据表整片读不到（`probe-fn.lua` 的 `if…then return {} end` 就是这么挂的）。
            // Lua 的收尾配对：`function`/`if`/`do`（含 `for…do`、`while…do`）配 `end`；`repeat` 配 `until`。
            // 注意 `for`/`while` 本身不额外占一个 `end`（它们的 `do` 已经算了一个）。
            if (t.t === 'kw' && (t.v === 'function' || t.v === 'if' || t.v === 'do' || t.v === 'repeat')) nesting++
            if (t.t === 'kw' && t.v === 'until') { if (nesting > 0) nesting-- }
            if (t.t === 'kw' && t.v === 'end') {
                if (nesting === 0) break
                nesting--
            }
            if (t.t === 'kw' && t.v === 'return') {
                // return "a" .. "b" 这类：把相邻的字符串字面量接起来（跳过 .. 与括号）
                let acc = ''
                let sawStr = false
                let r = p + 1
                while (r < toks.length) {
                    const q2 = toks[r]
                    if (q2.t === 'str') { acc += unescape(q2.v); sawStr = true; r++; continue }
                    if (q2.t === 'op' && (q2.v === '..' || q2.v === '(' || q2.v === ')')) { r++; continue }
                    break
                }
                if (sawStr && acc !== '' && !returns.includes(acc)) returns.push(acc)
            }
            p++
        }
        const end = p
        if (p < toks.length) p++ // end
        return { __fn: { returns, raw: toks.slice(start, end).map((x) => x.raw ?? x.v).join(' ').slice(0, 400) } }
    }

    function parseTable(depth) {
        stats.nodes++
        p++ // {
        const obj = {}
        const arr = []
        while (p < toks.length && !isOp('}')) {
            if (isOp(',') || isOp(';')) { p++; continue }
            if (isOp('[')) {
                p++
                const key = parseConcat(depth)
                if (!isOp(']')) { skipTo(',', '}', ']'); continue }
                p++ // ]
                if (!isOp('=')) { skipTo(',', '}'); continue }
                p++ // =
                const val = parseConcat(depth)
                const k = key === null || key === undefined ? String(arr.length) : typeof key === 'object' ? (key.__expr ?? '?') : String(key)
                obj[k] = val
                continue
            }
            const t = peek()
            if (t.t === 'name' && toks[p + 1] !== undefined && toks[p + 1].t === 'op' && toks[p + 1].v === '=') {
                const key = t.v
                p += 2
                obj[key] = parseConcat(depth)
                continue
            }
            arr.push(parseConcat(depth))
        }
        if (p < toks.length) p++ // }
        const keys = Object.keys(obj)
        if (keys.length === 0) return arr
        if (arr.length > 0) obj.__array = arr
        return obj
    }

    // 驱动：支持 `return {…}`、`return <name>`（先扫 `name = {…}` 记进符号表）、以及裸表
    const symbols = new Map()
 // （Darktide 提案 P1）：**候选字面量表** —— 模块化 Lua 的典型形状是
    //   local data = { …很多条目… }        ← 数据在这里
    //   for … do table.insert(out, …) end  ← 运行时拼数组
    //   return out                          ← 不是字面量表（旧实现只认它 ⇒ 静默返回 __expr/空表）
    // 这类文件必须能读出来：这里把"顶层赋值里键最多"的那张表作为回退候选。
    const candidates = []
    const symLiteral = new Map()
    let valueLiteral = false
    let order = 0
    let value = null
    while (p < toks.length) {
        const t = peek()
        // `local X = {…}` / `X = {…}` / `X = function…`
        if ((t.t === 'name' || (t.t === 'kw' && t.v === 'local'))) {
            const isLocal = t.t === 'kw' && t.v === 'local'
            let save = p
            if (isLocal) { p++; save = p }
            const nameTok = peek()
            if (nameTok !== undefined && nameTok.t === 'name') {
                const after = toks[p + 1]
                if (after !== undefined && after.t === 'op' && after.v === '=') {
                    p += 2
                    const started = peek()
                    const v = parseConcat(0)
                    symbols.set(nameTok.v, v)
                    // 这个符号是不是"字面量表构造出来的"（`local X = {…}`）；`local Y = f()` 不是
                    symLiteral.set(nameTok.v, started !== undefined && started.t === 'op' && started.v === '{')
                    // 记录候选：普通对象且至少有一个顶层键（数组表按元素数计）
 // ⚠️ （Darktide 复测 #1）：这里的 size 必须与下面的 `sizeOf` **同一判据** ——
                    // 都要**排除 `__expr`/`__fn` 哨兵键**。否则 `local Dot_green = Utils.Dot_green`
                    // 这种"运行时表达式赋值"会被当成 1 键候选并胜出 ⇒ 又回到"静默返回 1 条 __expr"。
                    if (v !== null && typeof v === 'object') {
                        const keys = Object.keys(v).filter((k) => k !== '__array' && k !== '__expr' && k !== '__fn')
                        const size = keys.length > 0 ? keys.length : (Array.isArray(v.__array) ? v.__array.length : 0)
                        if (size > 0) candidates.push({ name: nameTok.v, value: v, keys: size, local: isLocal, order: order++ })
                    }
                    continue
                }
            }
 // ⚠️ （Darktide 第三轮复测）：`local function …` 的 `function` 不能被跳过 ——
            // 旧写法 `p = save + 1` 会越过 `function` 关键字、**扫进函数体**，而函数体里的 `return {}`
            // 会让整个扫描 `break` ⇒ **函数之后的数据表全都读不到**（"先写几个 helper 再写数据表"是极常见形状）。
            // 现在：名字位置是 `function` ⇒ 退回该位置，由下面的 `function` 分支整块跳过。
            if (nameTok !== undefined && nameTok.t === 'kw' && nameTok.v === 'function') { p = save; continue }
            p = save + 1
            continue
        }
        // `function … end`（含上一条退回来的 `local function`）：**整块跳过**，绝不扫进函数体
        if (isKw('function')) {
            parseFunction(0)
            continue
        }
        if (isKw('return')) {
            p++
            const started = peek()
            const v = parseConcat(0)
            const fromLiteralToken = started !== undefined && started.t === 'op' && started.v === '{'
            if (v !== null && typeof v === 'object' && v.__expr !== undefined && symbols.has(v.__expr)) {
                value = symbols.get(v.__expr)
                valueLiteral = symLiteral.get(v.__expr) === true
            }
            else {
                value = v
                valueLiteral = fromLiteralToken
            }
            break
        }
        // 裸表（不属于任何赋值）：也当成候选，但**不提前 break** —— 真实的模块文件里，
        // 顶层往往先出现"函数调用里的表参数"（如 `foo({loc_key})`），旧实现一遇到就停 ✗
        // ⇒ 只回 1 条哨兵记录（Darktide 那 13 个文件全是这个原因）。
        if (isOp('{')) {
            const tbl = parseTable(0)
            if (tbl !== null && typeof tbl === 'object') {
                const keys = Object.keys(tbl).filter((k) => k !== '__array')
                const size = keys.length > 0 ? keys.length : (Array.isArray(tbl.__array) ? tbl.__array.length : 0)
                if (size > 0) candidates.push({ name: `<裸表 #${order + 1}>`, value: tbl, keys: size, local: false, order: order++ })
            }
            continue
        }
        p++
    }

    // ── 选表（P1）────────────────────────────────────────────────────────────────
    // 判据：能被"当成一张表来读"= 普通对象且至少一个顶层键；数组表按元素算。
    // ⚠️ `{__expr:…}` / `{__fn:…}` 是**运行时表达式的哨兵**，不是数据表 —— 早期把它们当"可用表"，
    // 于是模块化 Lua 仍会静默返回 1 条 `__expr`（这正是 Darktide 提案要消灭的那条降级路径）。
    const usable = (v) => {
        if (v === null || v === undefined || typeof v !== 'object') return false
        const isSentinel = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
            && (Object.keys(x).filter((k) => k !== '__array').length === 0
                || Object.keys(x).filter((k) => k !== '__array').every((k) => k === '__expr' || k === '__fn'))
        // 数组：至少一个元素是**真值**（`{ loc_key }` 这种"全是运行时表达式"的表不算数据表）
        if (Array.isArray(v)) return v.length > 0 && v.some((el) => !isSentinel(el))
        const keys = Object.keys(v).filter((k) => k !== '__array')
        if (keys.length === 1 && (keys[0] === '__expr' || keys[0] === '__fn')) return false
        if (keys.length > 0) return true
        return Array.isArray(v.__array) && v.__array.length > 0
    }
    const sizeOf = (v) => {
        if (Array.isArray(v)) return v.length
        const keys = Object.keys(v).filter((k) => k !== '__array' && !(k === '__expr' || k === '__fn'))
        return keys.length > 0 ? keys.length : (Array.isArray(v.__array) ? v.__array.length : 0)
    }
    // 排序：顶层键多者优先 → local 优先 → 文件里靠后者优先（通常最终数据表在后面）
    const ranked = [...candidates].sort((a, b) => (b.keys - a.keys) || (Number(b.local) - Number(a.local)) || (b.order - a.order))
    const wanted = typeof opts?.table === 'string' && opts.table.trim() !== '' ? opts.table.trim() : null

    let picked = null
    let reason = null
    let emptyLiteral = false
    if (wanted !== null) {
        // 显式指定：先按符号名找，再按点路径在（已解析的）符号里找
        if (symbols.has(wanted)) picked = { name: wanted, value: symbols.get(wanted), keys: sizeOf(symbols.get(wanted)), local: false, order: -1, explicit: true }
        else {
            for (const [name, v] of symbols) {
                const sub = getPath(v, wanted)
                if (usable(sub)) { picked = { name: `${name}.${wanted}`, value: sub, keys: sizeOf(sub), local: false, order: -1, explicit: true }; break }
            }
        }
        if (picked === null) {
 // （Darktide 第三轮建议）：失败时要说清"到底扫到了什么" —— 否则用户无从修正。
            reason = ranked.length > 0
                ? `指定了 table=${JSON.stringify(wanted)}，但文件里没有这张字面量表`
                : `指定了 table=${JSON.stringify(wanted)}，但扫描后**没有找到任何字面量表**（这个 Lua 文件可能整份都是运行时表达式/函数，或数据由 require/io_dofile 在运行时加载）`
        }
    }
    else if (valueLiteral && usable(value)) picked = null // 顶层就是（非空的）字面量表 ⇒ 行为与以前完全一致
    else if (ranked.length > 0) {
        // 顶层 return 不是字面量表（或是空的）⇒ 用文件内最大的字面量表
        emptyLiteral = valueLiteral
        const best = ranked[0]
        picked = { ...best, value: best.value, explicit: false }
        reason = null
    }
    else if (valueLiteral) picked = null // 空字面量表且没有别的候选：保持原样（由 note 说明是空的）
    else reason = '文件里没有可读的字面量表（顶层 return 是运行时表达式，且没有 `local X = {…}` / `X = {…}` 这类表构造）'

    const chosen = picked !== null ? picked.value : value
    return {
        value: chosen,
        stats,
        /** 被选中的表（含来源与键数）；null = 用的就是顶层值 */
        picked: picked === null ? null : { name: picked.name, keys: picked.keys, explicit: picked.explicit === true, local: picked.local === true, emptyTopLevel: emptyLiteral },
        /** 所有候选（供"我选错了"时一眼看出可用名字） */
        candidates: ranked.map((c) => ({ name: c.name, keys: c.keys, local: c.local })),
        /** 选不出来时的原因（适配层据此**报错**，不再静默降级） */
        reason: picked === null && !(valueLiteral && usable(value)) ? reason : null,
    }
}

/** 取点路径：`a.b`、`a[0]`、`a.b[1].c`；同时支持直接命中带点的键名 */
export function getPath(obj, path) {
    if (obj === null || obj === undefined) return undefined
    if (path === undefined || path === null || path === '') return obj
    const direct = obj[path]
    if (direct !== undefined) return direct
    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x !== '')
    let cur = obj
    for (const part of parts) {
        if (cur === null || cur === undefined) return undefined
        cur = cur[part]
    }
    return cur
}

/** 把任意值取成"字符串值"：字符串直通；函数节点取 return 的第一个字符串 */
export function asText(v) {
    if (v === null || v === undefined) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (typeof v === 'object') {
        if (Array.isArray(v)) return v.length > 0 ? asText(v[0]) : ''
        if (v.__fn !== undefined) return v.__fn.returns.length > 0 ? v.__fn.returns[0] : ''
        if (v.__array !== undefined) return asText(v.__array)
    }
    return ''
}

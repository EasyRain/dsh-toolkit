/**
 * 文件收集（**自研**，零依赖）—— 供 `ast_edit` 用。
 *
 * 取代原先依赖 `fast-glob` + `ignore` 的实现（那是并入的上游代码；为了让插件全部自有，
 * 也为了一次性去掉这两个依赖）。**语义刻意与旧实现保持一致**（有自测锁住）：
 *  - 隐藏文件包含（仅跳过 `.git`）；
 *  - `node_modules` 默认跳过，除非**输入文本里提到过**它；
 *  - `.gitignore` 生效：**逐目录作用域**（每个 `.gitignore` 的模式相对**它所在的目录**匹配，后匹配者胜），
 *    并额外读取从目标目录逐级向上到工作目录的祖先 `.gitignore`。旧实现是"从入口向上收一遍、模式统一相对工作目录"的近似，
 * 且**读不到子目录里的 `.gitignore`** —— 审计时改为逐目录作用域（更接近 git 的真实语义）；
 *  - 硬上限 `maxFiles`，到顶就 `limitReached = true`（调用方必须报出来，不能静默截断）；
 *    ⚠️ 上限只统计**最终会被处理的文件**：glob 场景下先按模式过滤再计数（旧实现先计数后过滤，
 *    目录里 200 个 `.js` + `maxFiles=200` 时 `*.ts` 会**一个都收不到**）；
 *  - 路径不存在时不报错（尽力而为）。
 *
 * gitignore 子集：空行与 `#` 注释忽略；`!` 取反（后匹配者胜）；含 `/` 的模式锚定；结尾 `/` 只匹配目录；
 * `*` 不跨 `/`、`**` 跨。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 含 glob 元字符（`{}` 也算：会被展开） */
export function hasGlobMagic(p) {
    return /[*?[\]{}]/.test(String(p))
}

/** glob 片段 → 正则片段（支持 `**` `*` `?` `{a,b}` `[...]`） */
function globToRegexSource(pattern) {
    let out = ''
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i]
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                if (pattern[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2 }
                else { out += '.*'; i += 1 }
            }
            else out += '[^/]*'
        }
        else if (ch === '?') out += '[^/]'
        else if (ch === '{') {
            const close = pattern.indexOf('}', i)
            if (close < 0) out += '\\{'
            else {
                const alts = pattern.slice(i + 1, close).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&'))
                out += `(?:${alts.join('|')})`
                i = close
            }
        }
        else if (ch === '[') {
            const close = pattern.indexOf(']', i)
            if (close < 0) out += '\\['
            else { out += pattern.slice(i, close + 1); i = close }
        }
        else out += ch.replace(/[.+^$()|\\]/g, '\\$&')
    }
    return out
}

/** glob → 匹配"整条相对路径"的正则 */
export function globToRegex(pattern) {
    return new RegExp(`^${globToRegexSource(String(pattern).replace(/\\/g, '/'))}$`)
}

const posix = (p) => String(p).replace(/\\/g, '/')

/** 一条 gitignore 模式 → { rx, negate, dirOnly }；无效行返回 null */
export function compileIgnorePattern(rawLine) {
    let line = String(rawLine).trim()
    if (line === '' || line.startsWith('#')) return null
    let negate = false
    if (line.startsWith('!')) { negate = true; line = line.slice(1) }
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    if (line === '') return null
    const anchored = line.includes('/')
    const body = anchored ? line.replace(/^\//, '') : line
    const rx = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globToRegexSource(body)}(?:/.*)?$`)
    return { rx, negate, dirOnly }
}

/** 读一个目录下的 .gitignore（不存在/读不到 ⇒ 空数组） */
async function readIgnoreFile(dir) {
    try {
        const text = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8')
        return text.split(/\r?\n/).map(compileIgnorePattern).filter(Boolean)
    }
    catch { return [] }
}

/**
 * 从 fromDir 逐级向上读到 toDir，收集祖先的 .gitignore；
 * **每个文件各自成作用域**（`base` = 它所在目录，模式相对 base 匹配）。
 */
async function loadIgnore(fromDir, toDir) {
    const scopes = []
    const seen = new Set()
    let dir = fromDir
    while (dir && !seen.has(dir)) {
        seen.add(dir)
        const rules = await readIgnoreFile(dir)
        if (rules.length > 0) scopes.push({ base: dir, rules })
        if (path.resolve(dir) === path.resolve(toDir)) break
        const parent = path.dirname(dir)
        if (!parent || parent === dir) break
        dir = parent
    }
    return scopes
}

/**
 * gitignore 子集判定（多作用域叠加，后匹配者胜）。
 * @param {{base:string, rules:Array}[]} scopes 作用域栈（祖先 → 当前目录）
 * @param {string} absPath 待判定的**绝对**路径
 */
export function isIgnored(scopes, absPath, isDir = false) {
    let ignored = false
    for (const scope of scopes) {
        const rel = posix(path.relative(scope.base, absPath))
        if (rel === '' || rel.startsWith('..')) continue
        for (const rule of scope.rules) {
            if (rule.dirOnly && !isDir && !rel.includes('/')) continue
            if (rule.rx.test(rel)) ignored = !rule.negate
        }
    }
    return ignored
}

/**
 * 递归收集目录下的文件（绝对路径）。
 * @param {(abs:string)=>boolean|null} filter 可选谓词：**只有通过谓词的文件才计入 maxFiles**
 *   （目录始终继续遍历；null = 全收）。这修掉了"上限被不匹配文件吃光"的回归。
 */
async function walkDir(dirAbs, cwd, scopes, opts, out, state, filter = null) {
    if (state.limit) return
    let entries
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }) }
    catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    // 本目录若有 .gitignore，压入一个作用域（相对本目录匹配）
    const own = await readIgnoreFile(dirAbs)
    const nested = own.length > 0 ? [...scopes, { base: dirAbs, rules: own }] : scopes
    for (const entry of entries) {
        if (state.limit) return
        if (entry.name === '.git') continue
        if (!opts.allowNodeModules && entry.name === 'node_modules') { state.nodeModulesSkipped = (state.nodeModulesSkipped ?? 0) + 1; continue }
        const abs = path.join(dirAbs, entry.name)
        if (isIgnored(nested, abs, entry.isDirectory())) continue
        state.count += 1
        if (entry.isDirectory()) await walkDir(abs, cwd, nested, opts, out, state, filter)
        else if (entry.isFile()) {
            if (filter !== null && !filter(abs)) continue
            if (out.length >= opts.maxFiles) { state.limit = true; return }
            out.push(abs)
        }
    }
}

/**
 * 收集要改写的文件。
 * @param {string[]} input 用户给的 paths（文件/目录/glob）
 * @param {{cwd:string, maxFiles:number, allowNodeModules?:boolean}} options
 * @returns {Promise<{files:string[], searchedCount:number, limitReached:boolean}>}
 */
export async function collectFiles(input, options) {
    const files = new Set()
    let searchedCount = 0
    let limitReached = false
    let nodeModulesSkipped = 0
    // 默认跳过 `node_modules`（依赖目录，搜它多半是噪声）——**但你显式在 paths 里写了 node_modules 就允许**，
    // 也可以显式 `allowNodeModules:true`。跳过了多少个目录会被如实回报（见下面的返回值），
    // 因为"静默漏文件"比"搜得慢"危险得多。
    const allowNodeModules = options.allowNodeModules ?? input.some((p) => String(p).includes('node_modules'))
    const opts = { ...options, allowNodeModules }

    for (const raw of input) {
        const p = String(raw ?? '').trim()
        if (!p) continue
        if (hasGlobMagic(p)) {
            const norm = posix(p)
            const firstMeta = norm.search(/[*?[\]{}]/)
            const cut = norm.lastIndexOf('/', firstMeta)
            const baseRel = cut < 0 ? '.' : (cut === 0 ? '/' : norm.slice(0, cut))
            const baseAbs = path.isAbsolute(baseRel) ? baseRel : path.resolve(options.cwd, baseRel)
            const rx = globToRegex(norm)
            // 让 walker 直接按模式过滤：**只有匹配的文件才计入 maxFiles**（修掉"上限被不匹配文件吃光"）
            const match = (f) => rx.test(posix(path.relative(options.cwd, f))) || rx.test(posix(f))
            const scopes = await loadIgnore(baseAbs, options.cwd)
            const out = []
            const state = { count: 0, limit: false }
            await walkDir(baseAbs, options.cwd, scopes, opts, out, state, match)
            searchedCount += state.count
            nodeModulesSkipped += state.nodeModulesSkipped ?? 0
            limitReached ||= state.limit
            for (const f of out.sort()) {
                if (files.size < options.maxFiles) files.add(f)
                else { limitReached = true; break }
            }
            continue
        }
        const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(options.cwd, p)
        let stat
        try { stat = await fsp.stat(abs) }
        catch { continue }
        if (stat.isFile()) {
            searchedCount += 1
            if (files.size < options.maxFiles) files.add(abs)
            else limitReached = true
            continue
        }
        if (stat.isDirectory()) {
            const scopes = await loadIgnore(abs, options.cwd)
            const out = []
            const state = { count: 0, limit: false }
            await walkDir(abs, options.cwd, scopes, opts, out, state)
            searchedCount += state.count
            nodeModulesSkipped += state.nodeModulesSkipped ?? 0
            limitReached ||= state.limit
            for (const f of out) {
                if (files.size >= options.maxFiles) { limitReached = true; break }
                files.add(f)
            }
        }
    }
    return { files: [...files].sort(), searchedCount, limitReached, nodeModulesSkipped }
}

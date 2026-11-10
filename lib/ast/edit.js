/**
 * ast_edit —— 结构化（AST 感知）改写的**自研**实现。
 *
 * 背景：此前这一族是并入上游 `dsh-ast-edit-tool@0.1.6`（MIT）的实现，改写时把文件镜像到临时目录、
 * **外调 `ast-grep` 二进制**（`sg run -p … -r … --json=stream` / `-U`）。为了让插件全部自有代码、
 * 并去掉 `@ast-grep/cli`（外部二进制）/`fast-glob`/`ignore` 三个依赖，改为**进程内**：
 *   `parse(lang, text)` → `root().findAll(pattern)` → 自己渲染 `out` 模板 → `node.replace()` →
 *   `commitEdits()` 得到新文本 → 原子写回。
 *
 * 关键事实（用真 NAPI 实测确认，决定了实现方式）：
 *  1. `SgNode.replace(text)` **不做元变量插值** —— 模板必须由我们自己渲染（见 `renderTemplate`）；
 *  2. `range()` 的位置是 **0-based**（展示时 +1）；
 *  3. `$$$NAME` 用 `getMultipleMatches()` 会拿到**含分隔符**的节点序列，拼 `.text()` 会丢空格 ⇒
 *     改为按"首节点起点 → 末节点终点"从原文切片还原；
 *  4. 嵌套模式（如 `$F($$$A)` 匹配 `a(b(c))`）会返回**重叠**匹配 ⇒ 提交前必须做重叠检查；
 *  5. NAPI 对无效模式**不抛错**（会当成别的模式匹配到东西）⇒ 建议先用 `ast_test_rule` 验证。
 *
 * 安全设计（与旧实现一致，勿削弱）：
 *  - `paths` **必填**（缺省路径曾导致一次误改 200 个文件）；
 *  - preview → apply 两步，`stagedId` 可省略（回退本会话最近一次提案）；
 *  - apply 前**过期校验**：替换总数与逐文件计数必须与 preview 时完全一致，否则拒绝；
 *  - 落盘**原子写**（同目录临时文件 + rename），失败时列出已写入的文件；
 *  - 单次改写的文件数上限（默认 200，`DSH_AST_MAX_FILES` 或 config 可覆盖）并在输出里报告。
 */
import { promises as fs } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse } from '@ast-grep/napi'
import { collectFiles } from '../glob.js'
import { langForFile } from './lang.js'
import { ToolError } from '../errors.js'
import { assertWritableTargets } from '../guard.js'

/**
 * 写锁：**目标目录一个文件都不放**，锁文件按目标路径哈希命名，统一放系统临时目录。
 * 为什么需要它（照 dsh-ops 的 `ops_replace` 抄的最实在的一条）：没有锁时，"核对内容哈希"与
 * "rename 落盘"之间存在窗口 —— 别的进程正好在这时写入，就会被我们的 rename 静默盖掉。
 */
const LOCK_DIR = path.join(tmpdir(), 'dsh-toolkit-locks')
const LOCK_STALE_MS = 30_000
/** 某个目标文件的锁路径（导出供自测构造竞争/陈旧锁） */
export const lockPathFor = async (file) => {
    let key = file
    try { key = await fs.realpath(file) } catch { /* 文件可能还不存在 */ }
    return path.join(LOCK_DIR, `${sha256(String(key)).slice(0, 32)}.lock`)
}
/** 拿独占锁；成功返回锁路径（调用方**必须**在 finally 里删掉）。别人持锁 ⇒ 明确报错，陈旧锁（持锁进程崩了）⇒ 抢一次 */
export async function acquireWriteLock(file) {
    const lockPath = await lockPathFor(file)
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = await fs.open(lockPath, 'wx')   // O_EXCL：谁先建成谁持锁
            await handle.writeFile(JSON.stringify({ pid: process.pid, file, at: new Date().toISOString() }))
            await handle.close()
            return lockPath
        }
        catch (error) {
            if (error?.code !== 'EEXIST') throw error
            let ageMs = Infinity
            try { ageMs = Date.now() - (await fs.stat(lockPath)).mtimeMs } catch { continue } // 刚好被释放 ⇒ 重试
            if (ageMs > LOCK_STALE_MS) { try { await fs.rm(lockPath, { force: true }) } catch { /* ignore */ } ; continue }
            throw new ToolError(`另一个进程正在写这个文件（锁 ${lockPath}，${Math.round(ageMs / 1000)}s 前建立）。等它完成再重试；若确定没有并发写入（例如上次异常退出留下的陈旧锁），删掉该锁文件即可。`)
        }
    }
    throw new ToolError(`拿不到写锁（${lockPath}）—— 稍后重试，或删掉这个锁文件`)
}

const SNIPPET_LIMIT = 120
const PARSE_ERRORS_LIMIT = 20
const TTL_MS = 10 * 60_000
const MAX_ENTRIES = 200          // 全局兜底上限（审计 D-17：以前只有全局 50 条，会话之间会互相挤掉）
const MAX_ENTRIES_PER_SESSION = 20 // 每个会话各自的提案上限
const DEFAULT_MAX_FILES = 200
const MAX_RENDER_CHANGES = 50
// 逐处明细的渲染策略（见 resolvePreviewDetail）：这几处改动一行都不到 40 字节的常量，
// 换来的是**大改动的输出 token 降一个数量级**。
const AUTO_FULL_MAX = 12          // auto：命中数 ≤ 这个值就逐处列（小改动看得清）
const SUMMARY_PER_FILE = 3        // summary：每个文件最多列前 3 处，其余折叠成一行
const SUMMARY_SNIPPET = 60        // summary：单行预览的截断长度
// 资源上限（审计 D-7）：以前只限**文件个数**，没有单文件大小/总命中数上限 ⇒ 5 MB 文件 40 万处命中
// 预览要 5 s、堆 +68 MB，而 `limitReached` 仍是 false、也没有任何提示。
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_MATCHES = 20_000

const truncate = (s, limit = SNIPPET_LIMIT) => (String(s).length > limit ? `${String(s).slice(0, limit)}…` : String(s))
/** 摘要把多行片段压成一行（结构改写常整段替换，逐处明细会很占 token） */
const oneLine = (s, limit = SUMMARY_SNIPPET) => {
    const t = String(s).replace(/\s*\r?\n\s*/g, '⏎')
    return t.length > limit ? `${t.slice(0, limit)}…` : t
}
/**
 * 逐处明细还是按文件汇总？
 *  - `full`：每处两行 `-行:列 旧` / `+行:列 新`（要逐条核对时用）
 *  - `summary`：每文件一行头 + 前 `SUMMARY_PER_FILE` 处单行预览 + "其余 N 处未列出"（路径只出现一次）
 *  - 缺省 `auto`：≤ `AUTO_FULL_MAX` 处走 full（小改动看得清、也不贵），更多就走 summary
 * 起因：一次 3 文件 48 处的复制，full 渲染 ≈ 1,955 token（**随命中数线性增长**，500 处 ≈ 20k），
 * 而其中绝大多数是"路径重复 + 一眼就看得出"的行；实测同类工具的同任务报告只要 ≈ 330 token。
 */
function resolvePreviewDetail(requested, count) {
    const want = typeof requested === 'string' ? requested.toLowerCase() : 'auto'
    if (want === 'full' || want === 'summary') return want
    return count <= AUTO_FULL_MAX ? 'full' : 'summary'
}

/** 单次改写的文件数上限（优先级：**显式 config > 环境变量 > 默认**，与上面注释一致 —— 审计 D-21 指出以前注释与实现相反） */
export function resolveMaxFiles(options = {}) {
    const fromEnv = Number(process.env.DSH_AST_MAX_FILES)
    const fromConfig = Number(options.maxFiles)
    if (Number.isFinite(fromConfig) && fromConfig > 0) return Math.floor(fromConfig)
    if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
    return DEFAULT_MAX_FILES
}

// --- 规则校验 ---------------------------------------------------------------

/** 校验并规范化 ops（空/重复/超量都抛）；规则按 pat 排序，保证顺序确定。 */
export function resolveOps(ops, defaults = {}) {
    if (!Array.isArray(ops) || ops.length === 0) throw new ToolError('ops is required: at least one rewrite rule (pat + out)')
    if (ops.length > 50) throw new ToolError('too many rewrite rules (max 50)')
    const seen = new Set()
    const resolved = []
    for (const op of ops) {
 // ⚠️ （刁钻角度探针）：**literal 模式不能 trim pat** ——
        // `pat:"    foo();"` 想匹配"缩进后的那一处"，trim 之后会把任意缩进/不限位置的出现全改掉（实测 1 处变 2 处）。
        // structural 仍然 trim（AST pattern 里前后空白无意义）。
        const raw = String(op?.pat ?? '')
        const modeGiven = op?.mode === undefined ? String(defaults.mode ?? 'structural') : String(op.mode)
        const pat = modeGiven === 'literal' ? raw : raw.trim()
        const out = op?.out ?? ''
        if (pat.trim() === '') throw new ToolError('every rewrite rule needs a non-empty pat')
        if (seen.has(pat)) throw new ToolError(`duplicate rewrite pattern ${JSON.stringify(pat)}`)
        seen.add(pat)
 // （MCMOD 反馈）：**改名不能用 AST pattern 干** —— 裸标识符 pattern 只命中"类型位置"
        // （import/类型声明/泛型/参数），漏掉限定用法 `X.foo()` / `X::m` / `instanceof X` ⇒ 预览看起来"改完了"。
        // `mode:"literal"` 走**按 token 边界的字面替换**（等价 `\bOld\b → New`），一次覆盖所有出现位置。
        const mode = modeGiven
        if (mode !== 'structural' && mode !== 'literal') {
            throw new ToolError(`unknown mode ${JSON.stringify(mode)} for pattern ${JSON.stringify(pat)}; use "structural" (ast-grep pattern) or "literal" (token-boundary text replacement)`)
        }
        const wb = op?.wordBoundary === undefined ? defaults.wordBoundary : op.wordBoundary
        resolved.push({ pat, out: String(out), mode, wordBoundary: wb !== false })
    }
    // **保留用户给的顺序**：这是"后一条规则看到前一条结果"的语义前提。
 // （审计发现这里曾按 pat 字典序排序，把用户顺序丢掉 ⇒ 串式改写结果与预期不同）
    return resolved
}

// --- literal（字面/改名）模式 -------------------------------------------------

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * literal 模式的匹配：**逐字面量**查找，可选 token 边界（默认开）。
 * 三个刁钻角度都在这里处理（探针实测出来的）：
 *  ① **CRLF 容忍**：`pat` 里写 `\n` 时同时匹配 `\r\n` —— 否则 Windows/Java 的 CRLF 文件上多行片段**一处都命不中**；
 *  ② **Unicode 边界**：JS 的 `\b` 只认 ASCII 单词字符 ⇒ 中文词加不上边界，`中文` 会误伤 `中文标识`；
 *     改用 `\p{L}\p{N}_` 的 lookaround，中英文统一按"字母/数字/下划线"算 token 边界；
 *  ③ 边界只加在贴着 token 字符的那一侧 —— `import a.b.C;` 末尾是 `;`，两侧都加就永远匹配不到。
 */
export function literalMatches(text, pat, wordBoundary, out) {
    const escaped = escapeRx(pat).replace(/\n/g, '\\r?\\n')
    const pre = wordBoundary && /^[\p{L}\p{N}_]/u.test(pat) ? '(?<![\\p{L}\\p{N}_])' : ''
    const post = wordBoundary && /[\p{L}\p{N}_]$/u.test(pat) ? '(?![\\p{L}\\p{N}_])' : ''
    const rx = new RegExp(`${pre}${escaped}${post}`, 'gu')
    const hits = []
    for (const m of text.matchAll(rx)) {
        if (m[0] === out) continue // 与 structural 一致：无变化的匹配不计入、也不提交
        const before = text.slice(0, m.index)
        const line = (before.match(/\n/g) ?? []).length + 1
        const column = m.index - (before.lastIndexOf('\n') + 1)
        hits.push({ startIndex: m.index, endIndex: m.index + m[0].length, before: m[0], after: out, line, column })
    }
    return hits
}

/**
 * 「这条规则的字面文本能被全文计数吗」——覆盖率的通用判据（从"改名"抽象出来）。
 *
 * 一般化后的规则：**只要规则声明了一段固定的旧文本，就应该在改写后核查它是否真的消失了**。
 *   - `literal` 模式 ⇒ 按 `pat` 字面量计数（边界按 wordBoundary）；
 *   - `structural` 且 pat 是**单个标识符** ⇒ 按 `\bpat\b` 计数；
 *   - `structural` 且**无元变量** ⇒ 按 `pat` 原文字面计数（`import a.b.C;` 这种：**命不中也能算出来**，
 *     于是能直接告诉你"这段文本在全文出现 1 次，但命中 0 次" ⇒ 一眼看出是节点上下文不对）；
 *   - 含元变量的结构 pattern ⇒ 无法定义"旧文本"（`$A` 不是一段文本）⇒ 不做统计，但**明说没做**，
 *     否则用户会以为"没警告＝已校验"。
 */
export function countablePattern(op) {
    if (op.mode === 'literal') return { kind: 'text', bound: op.wordBoundary !== false }
    if (/^[A-Za-z_$][\w$]*$/.test(op.pat)) return { kind: 'word', bound: true }
    if (metavariablesInPattern(op.pat).length === 0) return { kind: 'text', bound: false }
    return null
}

/** 按 countablePattern 的判据统计 `needle` 在 `text` 里的出现次数与行号 */
export function countOccurrences(text, needle, spec) {
    // 边界判据与 literalMatches 保持一致（Unicode：中文也算 token 字符，否则「中文」会误伤「中文标识」）
    const pre = spec.kind === 'word' || (spec.kind === 'text' && spec.bound && /^[\p{L}\p{N}_]/u.test(needle)) ? '(?<![\\p{L}\\p{N}_])' : ''
    const post = spec.kind === 'word' || (spec.kind === 'text' && spec.bound && /[\p{L}\p{N}_]$/u.test(needle)) ? '(?![\\p{L}\\p{N}_])' : ''
    // ⚠️ `.replace(/\n/g, ...)` 必须是**真换行**：早先写成 `/\\n/g`（反斜杠+n）⇒ 对真换行毫无作用，
 // 于是 CRLF 文件上 `hits=1` 而 `occurrences=0`（覆盖率自相矛盾，真实工具面验证时抓到）。
    const rx = new RegExp(`${pre}${escapeRx(needle)}${post}`.replace(/\n/g, '\\r?\\n'), 'gu')
    const lines = []
    let n = 0
    for (const m of text.matchAll(rx)) {
        n += 1
        if (lines.length < 5) lines.push((text.slice(0, m.index).match(/\n/g) ?? []).length + 1)
    }
    return { count: n, lines }
}

// --- 模板渲染 ---------------------------------------------------------------

/** 从 pattern 里抽出元变量名：`$$$MULTI` 与 `$single`/`$$single`（不含匿名 `$_`/`$$$`） */
export function metavariablesInPattern(pat) {
    const single = new Set()
    const multi = new Set()
    const text = String(pat)
    for (const m of text.matchAll(/\$\$\$([A-Za-z_][A-Za-z0-9_]*)/g)) if (!m[1].startsWith('_')) multi.add(m[1])
    for (const m of text.matchAll(/(?<!\$)\$\$?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (m[1].startsWith('_')) continue
        if (!multi.has(m[1])) single.add(m[1])
    }
    return { single, multi }
}

/**
 * 把 `out` 模板渲染成最终文本。
 *
 * **只在元变量确实是 pattern 的一部分时才插值**，其余一律按字面量输出 —— 这是 审计修的核心问题：
 * 旧实现把模板里**任何** `$` 都当元变量，于是 `out: 'echo "$HOME and $1" # cost: $5'` 会静默写成
 * `echo " and 1" # cost: 5`（shell 脚本被毁）；`${x}` 变 `{x}`；`$$` 被吞（上游 CLI 是**保留** `$$` 的）。
 *
 * 规则（与 `@ast-grep/cli 0.45.3` 对齐的部分已标注）：
 *  - `$$$NAME` / `$NAME` / `$$NAME`：NAME 必须出现在 pattern 里，否则 **报错**（打错名字曾静默替换成空串）；
 *  - `$_` / `$_NAME` / `$$$`：匿名，替换为空串（与 CLI 一致）；
 *  - `$$`：**原样保留 `$$`**（与 CLI 一致；旧实现吞成空）；
 *  - `\$`：转义，输出一个字面 `$`；
 *  - 其余 `$`（后面不是标识符，如 `$5`、`${x}`、行尾 `$`）：**原样保留**（旧实现会删掉 `$`，静默毁文本）。
 */
export function renderTemplate(template, node, source, pattern = null) {
    const text = String(template)
    const names = pattern === null ? null : metavariablesInPattern(pattern)
    const unknown = new Set()
    let out = ''
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        // `\$` 转义（注意方向：反斜杠在前）—— 输出一个字面 `$`
        if (ch === '\\' && text[i + 1] === '$') { out += '$'; i += 1; continue }
        if (ch !== '$') { out += ch; continue }
        if (text[i + 1] === '\\') { out += '$'; i += 1; continue } // `$\` 也当转义，别让它变成元变量
        if (text[i + 1] === '$' && text[i + 2] === '$') {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i + 3))
            if (!m) { out += ''; i += 2; continue } // `$$$` 匿名
            if (names !== null && !names.multi.has(m[1])) unknown.add('$$$' + m[1])
            else {
                const nodes = node.getMultipleMatches(m[1])
                if (nodes && nodes.length > 0) out += source.slice(nodes[0].range().start.index, nodes[nodes.length - 1].range().end.index)
            }
            i += 2 + m[1].length
            continue
        }
        if (text[i + 1] === '$') {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i + 2))
            if (!m) { out += '$$'; i += 1; continue } // `$$` 字面量（CLI 行为）
            if (m[1].startsWith('_')) { i += 1 + m[1].length; continue }
            if (names !== null && !names.single.has(m[1]) && !names.multi.has(m[1])) unknown.add('$' + m[1])
            else {
                const hit = node.getMatch(m[1])
                if (hit) out += hit.text()
            }
            i += 1 + m[1].length
            continue
        }
        const single = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i + 1))
        if (!single) { out += '$'; continue } // `$5` / `${x}` / 行尾 `$`：字面量
        if (single[1].startsWith('_')) { i += single[1].length; continue }
        if (names !== null && !names.single.has(single[1]) && !names.multi.has(single[1])) unknown.add('$' + single[1])
        else {
            const hit = node.getMatch(single[1])
            if (hit) out += hit.text()
        }
        i += single[1].length
    }
    if (unknown.size > 0) {
        const available = names === null ? '' : `；pattern 里的元变量：${[...names.single, ...names.multi].map((n) => '$' + n).join(', ') || '（无）'}`
        throw new ToolError(`模板里用了 pattern 中不存在的元变量 ${[...unknown].join(', ')}${available}。请检查 out 模板与 pat（要用字面美元符号请写 \\$）`)
    }
    return out
}

// --- 引擎 -------------------------------------------------------------------

const hasNul = (text) => text.includes('\u0000')

/** 内容哈希：预览时记下、apply 时逐文件比对（CAS 的基础） */
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 逐条规则、逐个文件地计算改写结果。**顺序语义**：后一条规则看到的是前一条改动后的文本
 * （与旧实现"每条规则对镜像跑一遍 -U"一致）。
 * @returns {{perFileCount:Map<string,number>, totalReplacements:number, filesTouched:string[], matches:object[], finalContents:Map<string,string>, warnings:string[]}}
 */
export function computeRewrite(ops, files, contents, verifySpecs = []) {
    const working = new Map()
    for (const f of files) working.set(f, contents.get(f) ?? '')
    const perFileCount = new Map()
    const matches = []
    const warnings = []
    const warned = new Set() // 去重（审计 D-14：同一条跳过提示会按 op 数重复 N 遍）
    const warn = (message) => { if (!warned.has(message)) { warned.add(message); warnings.push(message) } }
    const opCounts = {} // 逐 op 命中数（审计 D-9）：让"打错 pattern"与"本来没命中"可区分
    const opsPerFile = new Map() // 每个文件实际生效的规则数（审计 D-15：多规则时行号基于中间态）
    let collapsed = 0 // 多行结构被压成一行的替换数
    let capped = false

    for (const op of ops) {
        // 先占位：0 命中的规则也要出现在统计里（否则打错 pattern 与本来没命中还是分不清）
        if (opCounts[op.pat] === undefined) opCounts[op.pat] = 0
        for (const file of files) {
            const text = working.get(file)
            if (typeof text !== 'string') continue
            if (hasNul(text)) { warn(`skipped ${file}: looks binary`); continue }
            // literal 模式：**任何文本文件都能改**（不要求已知语言），按 token 边界字面替换
            if (op.mode === 'literal') {
                const hits = literalMatches(text, op.pat, op.wordBoundary !== false, op.out)
                if (hits.length === 0) continue
                let next = text
                for (let i = hits.length - 1; i >= 0; i -= 1) {
                    next = next.slice(0, hits[i].startIndex) + hits[i].after + next.slice(hits[i].endIndex)
                }
                working.set(file, next)
                perFileCount.set(file, (perFileCount.get(file) ?? 0) + hits.length)
                opCounts[op.pat] = (opCounts[op.pat] ?? 0) + hits.length
                opsPerFile.set(file, (opsPerFile.get(file) ?? 0) + 1)
                for (const e of hits) {
                    if (matches.length >= MAX_TOTAL_MATCHES) { capped = true; break }
                    matches.push({ file, line: e.line, column: e.column, before: e.before, after: e.after })
                }
                if (capped) break
                continue
            }
            const lang = langForFile(file)
            if (!lang) { warn(`skipped ${file}: unknown language for this extension (pass a file with a known extension)`); continue }
            let root
            try { root = parse(lang, text).root() }
            catch (error) {
                warn(`skipped ${file}: parse failed (${error instanceof Error ? error.message : String(error)})`)
                continue
            }
            let nodes
            try { nodes = root.findAll(op.pat) }
            catch (error) {
                throw new ToolError(`pattern ${JSON.stringify(op.pat)} failed: ${error instanceof Error ? error.message : String(error)}`)
            }
            if (!nodes || nodes.length === 0) continue

            const effective = []
            for (const node of nodes) {
                const before = node.text()
                const after = renderTemplate(op.out, node, text, op.pat)
                if (before === after) continue // 无变化的匹配不计入、也不提交
                const r = node.range()
                effective.push({ node, before, after, startIndex: r.start.index, endIndex: r.end.index, line: r.start.line, column: r.start.column })
            }
            if (effective.length === 0) continue

            // 重叠检查（只看**会产生变化**的匹配）：NAPI 对嵌套模式会返回重叠区间，提交它们语义不明
            const sorted = [...effective].sort((a, b) => (a.startIndex === b.startIndex ? b.endIndex - a.endIndex : a.startIndex - b.startIndex))
            for (let i = 1; i < sorted.length; i += 1) {
                if (sorted[i].startIndex < sorted[i - 1].endIndex) {
                    throw new ToolError(`Overlapping replacements detected in ${file} for pattern ${JSON.stringify(op.pat)}; refine pattern to avoid ambiguous edits`)
                }
            }

            const next = root.commitEdits(effective.map((e) => e.node.replace(e.after)))
            working.set(file, next)
            perFileCount.set(file, (perFileCount.get(file) ?? 0) + effective.length)
            opCounts[op.pat] = (opCounts[op.pat] ?? 0) + effective.length
            opsPerFile.set(file, (opsPerFile.get(file) ?? 0) + 1)
 // 多行 → 单行的替换计数（MCMOD 实测观察 3：$BODY 这类整段模板会顺手重排格式）
            for (const e of effective) if (e.before.includes('\n') && !e.after.includes('\n')) collapsed += 1
            for (const e of effective) {
                // 总命中数上限（审计 D-7）：到顶就不再收集，避免 40 万处命中把堆吃光
                if (matches.length >= MAX_TOTAL_MATCHES) { capped = true; break }
                matches.push({ file, line: e.line, column: e.column, before: e.before, after: e.after })
            }
            if (capped) break
        }
        if (capped) break
    }

    // 审计 D-15：多条规则改同一文件时，后面的规则是在**中间态**上解析的 ⇒ 行号对不上"原始文件"。
    // 与其假装准确，不如**明说**（只有确实发生时才说）。
    const multiOpFiles = [...opsPerFile.entries()].filter(([, n]) => n > 1).map(([f]) => f)
    if (multiOpFiles.length > 0) {
        warn(`行号说明：${multiOpFiles.length} 个文件被多条规则依次改写，其中的行号基于**前一条规则改写后的中间态**（与原始文件的绝对行号可能不同）`)
    }

    const finalContents = new Map()
    for (const f of files) finalContents.set(f, working.get(f) ?? contents.get(f) ?? '')

 // ── 覆盖率 + 事后一致性校验（MCMOD 反馈，**抽象成通用能力**）────────────
    // 背景：拿 AST pattern 当改名工具时，`X.foo()` / `X::m` / `instanceof X` 这类限定用法会漏 ✗，
    // 而预览只报"命中 N 处"，看不到旧文本还留着 ⇒ 直接 apply 就是**静默半成品**（比不改更危险）。
    // 一般化：**凡是能定义"应当消失的旧文本"的规则，都统计 全文出现 M / 命中 N / 改写后残留 R**，
    // 并在 apply 时把"R>0"当成默认拒绝条件（force 可强推）。也用于 `verify` 显式后置条件。
    const coverage = []
    const coverageSkipped = []
    for (const op of ops) {
        const spec = countablePattern(op)
        if (spec === null) { coverageSkipped.push(op.pat); continue }
        let occurrences = 0
        const hits = opCounts[op.pat] ?? 0
        const residualLines = []
        for (const f of files) occurrences += countOccurrences(contents.get(f) ?? '', op.pat, spec).count
 // **残留口径**（修正）：残留 = **原始文件里**没被本次改写覆盖到的旧文本 = occurrences - hits。
        // 以前数的是"改写后还剩几处"，于是 `out` 里含 `pat` 的规则（"在锚点前后插一句、保留锚点"、
        // "给集合加一项但保留原项"）必然报残留、被默认拒绝 —— 那是**我们刚写进去的**文本，不是漏改 ✗
        // （新会话碰到这种"被拒绝"很可能直接放弃工具去手写脚本）。该刹车的本意一点没松：
        // `X.foo()` / `X::m` / `instanceof X` 这类限定用法出现在**原文**里、且不被 hits 覆盖 ⇒ 仍然 > 0 ⇒ 仍然拒绝 ✓。
        const residual = Math.max(0, occurrences - hits)
        if (residual > 0) {
            // 行号取自原文（多处规则依次改写时会有偏移，预览里另有说明）；命中过的那些行可能也在其中。
            for (const f of files) {
                const r = countOccurrences(contents.get(f) ?? '', op.pat, spec)
                for (const line of r.lines) if (residualLines.length < 5) residualLines.push({ file: f, line })
            }
        }
        // 无变化的匹配不算命中（与 structural 的语义一致）
        if (occurrences > 0 || hits > 0) {
            coverage.push({
                pat: op.pat, out: op.out, mode: op.mode, kind: spec.kind, occurrences, hits, residual, residualLines,
                // `out` 含 `pat` 时，改写后的文本里还会出现 pat —— 那是本次写进去的，**不计入残留**（给文案用）。
                outContainsPat: String(op.out ?? '').includes(String(op.pat ?? '')),
            })
        }
    }

    // `verify`：调用方显式声明的后置条件（最通用的形态 —— 不看模式、不看元变量）
    const verifyResults = []
    for (const v of verifySpecs ?? []) {
        const text = String(v?.text ?? '')
        if (text === '') continue
        const spec = { kind: 'text', bound: v?.wordBoundary !== false }
        let count = 0
        const lines = []
        for (const f of files) {
            const r = countOccurrences(finalContents.get(f) ?? contents.get(f) ?? '', text, spec)
            count += r.count
            for (const line of r.lines) if (lines.length < 5) lines.push({ file: f, line })
        }
        const expect = v?.expect
        const want = expect === undefined || expect === null ? 0 : Number(expect)
        verifyResults.push({ text, expect: want, count, ok: count === want, lines })
    }

    return {
        perFileCount,
        totalReplacements: matches.length,
        filesTouched: [...perFileCount.keys()],
        matches,
        finalContents,
        warnings,
        opCounts,
        collapsed,
        opsPerFile: Object.fromEntries(opsPerFile),
        cappedByMatches: capped,
        coverage,
        coverageSkipped,
        verifyResults,
    }
}

// --- 提案暂存（按会话；TTL + 条数上限） --------------------------------------

export class StagingRegistry {
    constructor() {
        this.entries = new Map()
    }

    create(input) {
        this.prune()
        const entry = { ...input, id: randomUUID().replaceAll('-', '').slice(0, 12), createdAt: Date.now() }
        this.entries.set(entry.id, entry)
        this.prune()
        return entry
    }

    get(id, sessionId) {
        this.prune()
        const entry = this.entries.get(id)
        if (!entry || entry.sessionId !== sessionId) return undefined
        return entry
    }

    latest(sessionId) {
        this.prune()
        let newest
        for (const entry of this.entries.values()) {
            if (entry.sessionId !== sessionId) continue
            if (!newest || entry.createdAt > newest.createdAt) newest = entry
        }
        return newest
    }

    drop(id) {
        return this.entries.delete(id)
    }

    /** 某个会话当前的提案数（供诊断/自测） */
    countFor(sessionId) {
        let n = 0
        for (const entry of this.entries.values()) if (entry.sessionId === sessionId) n += 1
        return n
    }

    /**
     * 淘汰：**先按会话各自封顶**（审计 D-17：以前只有一个全局 50 条上限 ⇒ 别的会话多预览几次
     * 就能把本会话正要 apply 的提案挤掉），再保留一个全局上限兜底。
     */
    prune() {
        const now = Date.now()
        for (const [id, entry] of this.entries) if (now - entry.createdAt > TTL_MS) this.entries.delete(id)
        const bySession = new Map()
        for (const [id, entry] of this.entries) {
            const list = bySession.get(entry.sessionId)
            if (list === undefined) bySession.set(entry.sessionId, [{ id, createdAt: entry.createdAt }])
            else list.push({ id, createdAt: entry.createdAt })
        }
        for (const list of bySession.values()) {
            if (list.length <= MAX_ENTRIES_PER_SESSION) continue
            list.sort((a, b) => a.createdAt - b.createdAt)
            for (const victim of list.slice(0, list.length - MAX_ENTRIES_PER_SESSION)) this.entries.delete(victim.id)
        }
        while (this.entries.size > MAX_ENTRIES) {
            let oldest
            for (const [id, entry] of this.entries) if (!oldest || entry.createdAt < oldest.createdAt) oldest = { id, createdAt: entry.createdAt }
            if (!oldest) break
            this.entries.delete(oldest.id)
        }
    }
}

export const staging = new StagingRegistry()

// --- 结果渲染 ---------------------------------------------------------------

function toValue(matches, cap) {
    return matches.slice(0, cap).map((m) => ({
        file: m.file,
        line: m.line + 1, // 对外 1-based
        column: m.column + 1,
        before: truncate(m.before),
        after: truncate(m.after),
    }))
}

function buildMessage(action, counts, notices = {}) {
    const lines = []
    if (action === 'apply') lines.push(`Applied ${counts.total} replacements in ${counts.touched} files.`)
    else if (action === 'reject') lines.push('Discarded staged rewrite; files unchanged.')
    else if (counts.total > 0) {
        // 目标文件数必须出现在**人能读到的文本**里：AGENTS.md 铁律 #7 要求"apply 前确认目标文件数==1"，
 // 而以前只有结构化字段 filesTouched，message 里看不到（子代理审计 D-11）。
        lines.push(`Staged as a proposal — files NOT modified yet. (${counts.touched} file(s), ${counts.total} replacement(s)${counts.searched !== undefined ? `; scanned ${counts.searched} entries` : ''})`)
    }
    else lines.push('No replacements made — nothing was staged (check the pattern with ast_test_rule first)')
    if (notices.limitReached) lines.push('Limit reached; narrow paths.')
    const notes = notices.extraNotes ?? []
    for (const n of notes) lines.push(n)
    // 覆盖情况与残留（★第 1/2 条的一般化形态）：**必须让人一眼看到"旧文本还剩多少"**
    for (const c of notices.coverage ?? []) {
        lines.push(`覆盖情况：规则 ${JSON.stringify(c.pat)} → ${JSON.stringify(c.out)}（${c.mode}${c.kind === 'text' && c.mode === 'structural' ? '/字面计数' : ''}）命中 ${c.hits} / 全文出现 ${c.occurrences}`)
        if (c.hits === 0 && c.occurrences > 0) {
            lines.push(`⚠ 这段文本在文件里出现 ${c.occurrences} 次，但 pattern **一次都没命中** ⇒ 多半是**节点上下文**不对（例如 import 语句 vs 标识符、语句 vs 表达式），或文件语言判错了。先用 ast_search / ast_test_rule 看实际节点；只想要文本替换就用 mode:"literal"。`)
        }
        else if (c.residual > 0) {
            const where = c.residualLines.length > 0 ? `，例如 ${c.residualLines.map((r) => `${r.file}:${r.line}`).join('、')}` : ''
            lines.push(`⚠ 仍有 ${c.residual} 处未改到${where}`)
            if (c.outContainsPat) {
                lines.push('  ↳ 本条的替换文本里**也含**这段旧文本（“保留锚点”式改写）：残留只按**原始文件**统计，本次写进去的不算在内。')
            }
            if (c.mode !== 'literal') {
                lines.push('  ⇒ 限定/作用域用法（X.foo()、X::m、instanceof X 这类）用 AST pattern 常命中不到；**整段改名请用 mode:"literal"**（按 token 边界字面替换，一次覆盖 import / 限定名 / 方法引用）。只想改一部分就加 force:true。')
            }
            else {
                lines.push('  ⇒ literal 模式仍有残留：核对 pattern 拼写与大小写；wordBoundary:false 会连 OldSuffix 一起改。')
            }
        }
    }
    if ((notices.coverageSkipped ?? []).length > 0) {
        lines.push(`说明：${notices.coverageSkipped.length} 条含元变量的规则**未做**全文覆盖统计（$A 不是一段可计数的旧文本）—— 需要"改完必须满足某条件"就用 verify:[{text,expect}] 显式声明。`)
    }
    // 覆盖率**只统计参与改写的那批文件**：有文件被跳过（>2MB/二进制/读失败）时必须说明，
 // 否则"全文出现 N / 残留 0"会被误读成"整个 paths 都干净了"（刁钻角度探针）。
    if ((notices.skippedAny ?? false) && (notices.coverage ?? []).length > 0) {
        lines.push('⚠ 注意：上面的"全文出现/残留"**只统计实际参与改写的文件**；本次有文件被跳过（见上面的跳过提示），它们的旧文本没有被检查、也没有被改。')
    }
    for (const v of notices.verifyResults ?? []) {
        lines.push(`${v.ok ? '✅' : '⚠'} 后置条件：${JSON.stringify(v.text)} 出现 ${v.count} 次（期望 ${v.expect}）${v.ok ? '' : ` —— 例如 ${v.lines.map((r) => `${r.file}:${r.line}`).join('、')}`}`)
    }
    if (notices.changesTruncated) lines.push(`Preview truncated at ${notices.changesTruncated} changes; narrow paths.`)
    for (const w of notices.warnings ?? []) lines.push(`Note: ${w}`)
    // 有 file 就带上文件名，没有就原样打印（审计 D-14：以前按 kind 猜，跳过类提示会走错分支）
    for (const e of notices.parseErrors ?? []) lines.push(`Note: ${e.file !== undefined ? `${e.file}: ${e.message}` : e.message}`)
    return lines.join('\n') || 'No replacements made'
}

// --- 工具 -------------------------------------------------------------------

const parameters = {
    ops: {
        type: 'array',
        description: 'One or more rewrite rules. Each rule: pat is an ast-grep pattern using $NAME / $_ / $$$NAME metavariables (each stands for a whole AST node); out is the replacement, $NAME / $$$NAME captures from pat substitute into it, and an empty out deletes the matched node. Duplicate pat values fail. RENAMES: an AST pattern only matches AST positions — qualified/scoped usages like X.foo(), X::m, instanceof X are NOT matched by a bare-identifier pattern, so a rename staged that way is a half-done rewrite; use mode:"literal" for renames.',
        items: {
            type: 'object',
            additionalProperties: false,
            properties: {
                pat: { type: 'string', description: 'ast-grep pattern; metavariable names must be uppercase and stand for whole AST nodes. In literal mode this is plain text (no metavariables, no escaping) — e.g. ResourceLocation.' },
                out: { type: 'string', description: 'Replacement template; $NAME / $$$NAME captures from pat substitute in. Empty deletes the match. In literal mode it is plain replacement text.' },
                mode: { type: 'string', enum: ['structural', 'literal'], description: 'Per-rule override of the top-level mode. structural (default) = ast-grep pattern; literal = token-boundary text replacement (what renames want).' },
                wordBoundary: { type: 'boolean', description: 'literal mode only: require token boundaries (default true) so Old does not match inside OldSuffix. Set false for a plain substring replace.' },
            },
            required: ['pat', 'out'],
        },
    },
    paths: {
        type: 'array',
        description: 'Files, directories, or globs to rewrite. Directories are scanned recursively (hidden files included, node_modules skipped unless named in a path). At least one non-empty entry is required — never omit it.',
        items: { type: 'string' },
    },
    mode: {
        type: 'string',
        enum: ['structural', 'literal'],
        description: 'Default mode for every rule (per-rule mode overrides). structural = ast-grep AST pattern (good for structure, misses qualified usages). literal = token-boundary text replacement — THE right mode for renames/global text changes, covers import lines, qualified names and method references in one rule, and works on any text file.',
    },
    force: {
        type: 'boolean',
        description: 'apply only: proceed even when the post-check says the rewrite is incomplete (residual old text, or a failing verify condition). Without it, such an apply is REFUSED — a half-done rename compiles-looking code that is worse than no change.',
    },
    verify: {
        type: 'array',
        description: 'Explicit post-conditions checked against the rewritten content, e.g. [{ text: "ResourceLocation", expect: 0 }] ("after this edit that text must appear exactly 0 times"). Unlike the automatic coverage report this works for ANY rule (metavariables included). A failing condition blocks apply unless force:true.',
        items: {
            type: 'object',
            additionalProperties: false,
            properties: {
                text: { type: 'string', description: 'Literal text to count in the rewritten files.' },
                expect: { type: 'integer', description: 'Required occurrence count after the rewrite (default 0).' },
                wordBoundary: { type: 'boolean', description: 'Require token boundaries when counting (default true).' },
            },
            required: ['text'],
        },
    },
    action: {
        type: 'string',
        enum: ['preview', 'apply', 'reject'],
        description: 'preview (default): stage the rewrite and show the proposed edits (files NOT modified). apply: write the staged rewrite (stagedId from its preview; stale preview is rejected). reject: discard it.',
    },
    stagedId: {
        type: 'string',
        description: 'Proposal id returned by a preview; required for apply and reject (may be omitted to use this session\'s newest proposal).',
    },
    previewDetail: {
        type: 'string',
        enum: ['auto', 'summary', 'full'],
        description: 'Preview detail. auto (default): per-match lines for small edits, per-file summary (path once, first few matches, rest folded but counted) for large ones. full: every match. summary: always fold. Use full to eyeball each replacement.',
    },
}

const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        action: { type: 'string', enum: ['preview', 'apply', 'reject'], required: true },
        applied: { type: 'boolean', required: true },
        totalReplacements: { type: 'integer', required: true },
        filesTouched: { type: 'integer', required: true },
        filesSearched: { type: 'integer', required: true },
        entriesScanned: { type: 'integer' },
        limitReached: { type: 'boolean', required: true },
        stagedId: { type: 'string' },
        message: { type: 'string' },
        /** 每文件命中数（`{ "路径": 处数 }`）：summary 渲染要用它如实报"其余 N 处" */
        // ⚠️ `additionalProperties` **必须是布尔**（宿主 schema DSL 的硬规则；真宿主实测：写成
        // `{ type: 'integer' }` 会被判 `unsupported JSON schema: … must be a boolean` ⇒ **整个工具注册失败**，
        // 会话里直接没有 ast_edit）。这条现在由 host-surface-selftest 的"形状契约"盯着。
        perFileCount: { type: 'object', additionalProperties: true },
        changes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    file: { type: 'string', required: true },
                    line: { type: 'integer', required: true },
                    column: { type: 'integer', required: true },
                    before: { type: 'string', required: true },
                    after: { type: 'string', required: true },
                },
            },
        },
        parseErrors: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { type: 'string', required: true },
                    file: { type: 'string' },
                    message: { type: 'string', required: true },
                },
            },
        },
    },
}

async function doPreview(args, ops, exec, config, cwd, sessionId) {
    // `verify`：调用方显式声明的**后置条件**（通用形态 —— 不看模式、不看元变量；见 computeRewrite 尾部）
    const verifySpecs = Array.isArray(args?.verify)
        ? args.verify.map((v) => ({ text: String(v?.text ?? ''), expect: v?.expect ?? 0, wordBoundary: v?.wordBoundary !== false })).filter((v) => v.text !== '')
        : []
    const collected = await collectFiles(args.paths ?? [], { cwd, maxFiles: config.maxFiles })
    if (collected.files.length === 0) {
        return {
            ok: true,
            action: 'preview',
            applied: false,
            totalReplacements: 0,
            filesTouched: 0,
            filesSearched: collected.files.length,
            entriesScanned: collected.searchedCount,
            limitReached: collected.limitReached,
            message: 'No files matched the given paths.',
        }
    }
    const contents = new Map()
    const hashes = {}
    const hadBom = {}
    const parseErrors = []
    const extraNotes = []
    // 依赖目录默认不碰（依赖只在副本里 / 改 vendor 是灾难）；跳过了就**说出来**，并给出逃生门
    if ((collected.nodeModulesSkipped ?? 0) > 0) {
        extraNotes.push(`（已跳过 ${collected.nodeModulesSkipped} 个 node_modules 目录：依赖目录默认不改写 —— 要改就把那个文件路径显式写进 paths）`)
    }
    const linkOf = new Map() // 真实路径 → 用户给的符号链接路径（报告用）
    for (const file of collected.files) {
        // **abort 检查**（审计 D-22）：大仓预览中途 Ctrl-C 以前完全无效（只在入口查一次）
        if (exec?.signal?.aborted === true) throw new ToolError('ast_edit aborted（预览阶段收到中止信号）')
        let target = file
        // **符号链接**（审计 D-19 实测：改写会把链接替换成普通文件 ⇒ 真实目标没变、链接被断开）。
        // 解到真实路径再读写：链接保持不动，用户期望的那个文件才真的被改。
        try {
            const st = await fs.lstat(file)
            if (st.isSymbolicLink()) {
                target = await fs.realpath(file)
                linkOf.set(target, file)
                if (!extraNotes.includes('（有符号链接已解到真实路径）')) extraNotes.push('（有符号链接已解到真实路径）')
            }
            else if (st.nlink > 1 && !extraNotes.includes('⚠ 有硬链接文件：改写用 rename 替换 ⇒ 会把硬链接断开（其它链接名仍是旧内容）')) {
                extraNotes.push('⚠ 有硬链接文件：改写用 rename 替换 ⇒ 会把硬链接断开（其它链接名仍是旧内容）')
            }
        }
        catch { /* lstat 失败就按原路径处理，后面 readFile 会报错 */ }
        try {
            const raw = await fs.readFile(target, 'utf8')
            if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
                extraNotes.push(`⚠ 跳过超过 ${(MAX_FILE_BYTES / 1048576).toFixed(0)} MB 的文件：${file}`)
                continue
            }
 // BOM：NAPI 的 commitEdits 会把它丢掉（审计实测），自己记下来、写回时补回去
            const bom = raw.charCodeAt(0) === 0xFEFF
            const text = bom ? raw.slice(1) : raw
            hadBom[target] = bom
            if (target !== file) hadBom[file] = bom
            hashes[target] = sha256(text)
            if (target !== file) hashes[file] = hashes[target]
            contents.set(target, text)
        }
        catch (error) { parseErrors.push({ kind: 'read', file, message: error instanceof Error ? error.message : String(error) }) }
    }
    // 语言包注册失败要说出来（审计 D-8）：那会让对应扩展名退化成 "unknown language"
    try {
        const { failedLanguages } = await import('./lang.js')
        const failed = failedLanguages()
        if (failed.length > 0) extraNotes.push(`⚠ 有 ${failed.length} 个语言包注册失败（对应扩展名会被跳过）：${failed.slice(0, 6).join(', ')}`)
    }
    catch { /* lang.js 加载不了就算了：本段本来就已经降级 */ }
    const parseable = [...contents.keys()]
    if (parseable.length === 0) {
 // （刁钻角度探针）：**"一个可读文件都没有"必须说清为什么** ——
        // 以前只回一句 "No readable files matched the given paths."，而跳过原因（>2MB/二进制/读失败）就在 extraNotes 里被丢掉了 ✗。
        const why = extraNotes.length > 0 ? `\n原因：\n  - ${extraNotes.join('\n  - ')}` : ''
        const errs = parseErrors.length > 0 ? `\n读失败：\n  - ${parseErrors.slice(0, 5).map((e) => `${e.file ?? ''}: ${e.message}`).join('\n  - ')}` : ''
        return {
            ok: true,
            action: 'preview',
            applied: false,
            totalReplacements: 0,
            filesTouched: 0,
            filesSearched: collected.files.length,
            entriesScanned: collected.searchedCount,
            limitReached: collected.limitReached,
            message: `No readable files matched the given paths.（扫描到 ${collected.files.length} 个文件，其中 0 个可读/可改）${why}${errs}`,
            parseErrors: parseErrors.slice(0, PARSE_ERRORS_LIMIT),
        }
    }

    const result = computeRewrite(ops, parseable, contents, verifySpecs)
    const truncated = result.matches.length > config.maxRenderChanges ? config.maxRenderChanges : undefined
    const merged = [...parseErrors, ...result.warnings.map((w) => ({ kind: 'pattern', message: w }))]
    // 逐 op 命中的统计（审计 D-9）：打错 pattern 与"本来就没命中"以前完全同形
    for (const [pat, n] of Object.entries(result.opCounts ?? {})) {
        if (n === 0) extraNotes.push(`⚠ 规则 ${JSON.stringify(pat)} 命中 0 处 —— 若不确定 pattern 是否有效，先用 ast_test_rule 验证（NAPI 对部分无效模式不抛错，只静默 0 命中）`)
    }
    if (result.totalReplacements > MAX_TOTAL_MATCHES) extraNotes.push(`⚠ 命中数超过 ${MAX_TOTAL_MATCHES}，预览与结果都被截断`)
 // **多行被压成一行**（MCMOD 实测观察 3）：`$$$BODY` 这类整段模板会把原来的换行/缩进
    // 重排成一行 —— 属 ast-grep 模板的固有行为，但对"只想改个小片段"的用户是意外，所以点名。
    if (result.collapsed > 0) extraNotes.push(`⚠ 有 ${result.collapsed} 处把**多行结构压成一行**（模板里用 \`$$$\` 整段变量时会重排换行/缩进）；只想改小片段就把模板写窄一点（例如只替换签名而别带 \`{ $$$BODY }\`）`)
    // **0 改动不入栈**（审计 D-10）：以前一次探索性预览也会顶掉真正要用的提案，
    // 而它的 message 还不打印 stagedId ⇒ 之后的 apply 落到它上面、报 "Applied 0 replacements"。
    if (result.totalReplacements === 0) {
        const msg = buildMessage('preview', { total: 0, touched: 0, searched: collected.searchedCount }, {
            limitReached: collected.limitReached,
            extraNotes,
            warnings: result.warnings.slice(0, PARSE_ERRORS_LIMIT),
            parseErrors: merged.length ? merged.slice(0, PARSE_ERRORS_LIMIT) : undefined,
 // 0 命中时**最需要**这些诊断（"这段文本出现 5 次却一次都没命中"）——
            // 以前这条提前返回把覆盖率整段丢掉 ✗（MCMOD 反馈 ★4/★5 的根因就在这条路径上）。
            coverage: result.coverage,
            skippedAny: extraNotes.some((n) => /跳过/.test(n)),
            coverageSkipped: result.coverageSkipped,
            verifyResults: result.verifyResults,
        })
        return {
            ok: true,
            action: 'preview',
            applied: false,
            totalReplacements: 0,
            filesTouched: 0,
            filesSearched: collected.files.length,
            entriesScanned: collected.searchedCount,
            limitReached: collected.limitReached,
            stagedId: null,
            message: `${msg}\n（没有入栈，所以没有 stagedId；也不会顶掉你之前的提案）`,
            changes: [],
            parseErrors: merged.slice(0, PARSE_ERRORS_LIMIT),
        }
    }
    const entry = staging.create({
        sessionId,
        ops,
        paths: args.paths ?? [],
        files: parseable,
        totalReplacements: result.totalReplacements,
        filesTouched: result.filesTouched,
        perFileCount: Object.fromEntries(result.perFileCount),
        // **内容哈希 + BOM 状态**：apply 时逐文件比对（内容变过就拒绝），并把 BOM 补回去
        hashes,
        hadBom,
        linkOf: Object.fromEntries(linkOf),
        verifySpecs,
    })
    const changes = toValue(result.matches, config.maxRenderChanges)
    const previewMessage = buildMessage('preview', { total: result.totalReplacements, touched: result.filesTouched.length, searched: collected.searchedCount }, {
        limitReached: collected.limitReached,
        changesTruncated: truncated,
        extraNotes,
        warnings: result.warnings.slice(0, PARSE_ERRORS_LIMIT),
        parseErrors: merged.length ? merged.slice(0, PARSE_ERRORS_LIMIT) : undefined,
        coverage: result.coverage,
        skippedAny: extraNotes.some((n) => /跳过/.test(n)),
        coverageSkipped: result.coverageSkipped,
        verifyResults: result.verifyResults,
    })
    const message = `${previewMessage}\nStaged id: ${entry.id} — pass it as stagedId, or omit stagedId to apply this newest proposal.`
    return {
        ok: true,
        action: 'preview',
        applied: false,
        totalReplacements: result.totalReplacements,
        filesTouched: result.filesTouched.length,
        filesSearched: collected.files.length,
            entriesScanned: collected.searchedCount,
        limitReached: collected.limitReached,
        stagedId: entry.id,
        message,
        changes,
        perFileCount: Object.fromEntries(result.perFileCount),
        parseErrors: merged.slice(0, PARSE_ERRORS_LIMIT),
    }
}


async function doApply(args, exec, config, sessionId) {
    const stagedId = args.stagedId?.trim() || staging.latest(sessionId)?.id
    if (!stagedId) throw new ToolError('no live staged proposal for this session; run a preview first')
    const entry = staging.get(stagedId, sessionId)
    if (!entry) throw new ToolError(`unknown or expired stagedId ${stagedId}; run a preview again`)

    // 真正落盘前过沙箱闸门：预览不写盘、不受限；apply 可能写到工作区外，必须拦。
    assertWritableTargets(config.guardCtx?.() ?? null, entry.files)

    // ── 阶段 1：逐文件 CAS 校验（**任何不一致都不写盘**）────────────────────────
    // 以前只比"替换数"，外部只要把匹配内容改成别的（数量不变）就会被静默套用，
 // 用户审的是 A、落盘的是 B（子代理审计，含最小复现）。现在按内容哈希比。
    const live = new Map()
    const changed = []
    for (const file of entry.files) {
        let raw
        try { raw = await fs.readFile(file, 'utf8') }
        catch { changed.push(`${file}（读不到了）`); continue }
        const bom = raw.charCodeAt(0) === 0xFEFF
        const text = bom ? raw.slice(1) : raw
        const expect = entry.hashes?.[file]
        if (expect && sha256(text) !== expect) changed.push(file)
        live.set(file, text)
        if (entry.hadBom?.[file] !== undefined && entry.hadBom[file] !== bom) changed.push(`${file}（BOM 状态变了）`)
    }
    if (changed.length > 0) {
        throw new ToolError(`文件在预览之后被改过，已**拒绝写入**（避免把你没审过的内容写进去）：${changed.slice(0, 5).join('、')}${changed.length > 5 ? ` 等 ${changed.length} 个` : ''}。重新 preview 一次再 apply`)
    }
    const result = computeRewrite(entry.ops, entry.files, live, entry.verifySpecs ?? [])
    if (result.totalReplacements !== entry.totalReplacements) {
        throw new ToolError(`staged rewrite is stale (replacement count changed ${entry.totalReplacements} → ${result.totalReplacements}); re-run the preview`)
    }
    for (const [file, count] of result.perFileCount) {
        if ((entry.perFileCount[file] ?? 0) !== count) throw new ToolError(`staged rewrite is stale (file ${file} changed); re-run the preview`)
    }

 // ── 阶段 1.5：**改名类规则的事后一致性校验**（MCMOD 反馈 ★第 1 条）─────
    // 拿 AST pattern 当改名工具时，限定用法（X.foo() / X::m / instanceof X）会漏 ✗，
    // 而预览只报"命中 N 处" ⇒ 直接 apply 就是**静默半成品**（新旧名混用，只有编译才发现）。
    // 默认**拒绝写入**并列出残留行号；确认确实只想改一部分时用 force:true。
    const leftover = (result.coverage ?? []).filter((c) => c.residual > 0)
    const verifyFailed = (result.verifyResults ?? []).filter((v) => !v.ok)
    if ((leftover.length > 0 || verifyFailed.length > 0) && args?.force !== true) {
        const parts = []
        for (const c of leftover) {
            const where = c.residualLines.length > 0 ? `（例如 ${c.residualLines.map((r) => `${r.file}:${r.line}`).join('、')}）` : ''
            parts.push(`${JSON.stringify(c.pat)} → ${JSON.stringify(c.out)}：命中 ${c.hits}/${c.occurrences}，**还剩 ${c.residual} 处旧文本**${where}${c.outContainsPat ? '（本条替换文本里也含旧文本：残留只统计**原始文件**中未被覆盖的那些）' : ''}`)
        }
        for (const v of verifyFailed) {
            const where = v.lines.length > 0 ? `（例如 ${v.lines.map((r) => `${r.file}:${r.line}`).join('、')}）` : ''
            parts.push(`后置条件 ${JSON.stringify(v.text)}：期望 ${v.expect} 次，改写后 **${v.count} 次**${where}`)
        }
        throw new ToolError(
            `拒绝 apply：改写没有达到"改全/改对"的要求 ——\n  - ${parts.join('\n  - ')}\n`
            + '  改名或整段替换请用 mode:"literal"（AST pattern 命中不到限定用法 X.foo()、X::m、instanceof X，会留下新旧混用的半成品）；\n'
            + '  确实只想改一部分（例如旧名仍被别处引用），加 force:true 再 apply。',
        )
    }

    // ── 阶段 2：写盘。逐文件"再校验一次 → 写临时文件 → rename"（把窗口压到最小）──────
    const toWrite = [...result.finalContents].filter(([file, content]) => live.get(file) !== content)
    // 写前预检：只读/被占用/目录占位都要在**动任何文件之前**发现（避免写一半）
    const blocked = []
    for (const [file] of toWrite) {
        try {
            const fh = await fs.open(file, 'r+')
            await fh.close()
        }
        catch (error) { blocked.push(`${file}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (blocked.length > 0) {
        throw new ToolError(`写盘预检失败，**未写入任何文件**（先处理这些再重试）：\n${blocked.slice(0, 5).join('\n')}`)
    }
    const writeErrors = []
    const written = []
    let sawUnknown = false
    for (const [file, content] of toWrite) {
        // **abort 检查**（审计 D-22）：以前只在入口查一次 ⇒ 大仓 apply 中途 Ctrl-C 完全无效
        if (exec?.signal?.aborted === true) {
            writeErrors.push(`已中止（abort）：剩余 ${toWrite.length - written.length} 个文件未写`)
            break
        }
        const tmp = `${file}.dsh-tmp-${process.pid}-${randomUUID().slice(0, 8)}`
        let lock = null
        let phase = 'lock'
        try {
            // **独占锁**（照 dsh-ops 的 ops_replace 抄的一条）：持锁 → 读 → 核 sha256 → 原子发布。
            // 没有锁时，"核对哈希"与"rename 落盘"之间还有一个窗口，别人正好在这时写入就会被我们盖掉。
            // 锁文件放**系统临时目录**（按目标路径哈希命名）—— 目标目录一个文件都不多。
            lock = await acquireWriteLock(file)
            // rename 之前的最后一次 CAS：这段时间里别人再写就放弃（并且报告已经写了哪些）
            phase = 'read'
            const rawNow = await fs.readFile(file, 'utf8')
            const textNow = rawNow.charCodeAt(0) === 0xFEFF ? rawNow.slice(1) : rawNow
            if (entry.hashes?.[file] && sha256(textNow) !== entry.hashes[file]) {
                // 措辞与"阶段 1"的 CAS **保持一致**：从调用方看是同一件事（别人改过 ⇒ 拒绝写入），只是发现得更晚。
                // 以前这里是"文件在这一瞬间又被改动了"，并发测试要把失败归类时匹配不到（真 Linux 跑全量抓到）。
                throw new Error('文件在预览之后被改过，已**拒绝写入**（持锁后又发现变化）')
            }
            // **保留权限位**（审计 D-存疑）：tmp 是新建文件（默认 0644）⇒ 把 0755 脚本静默改成 0644
            // 是行为变化。先读原 mode，写完 tmp 套上再 rename（POSIX 有效，Windows 无害）。
            let mode = null
            try { mode = (await fs.stat(file)).mode } catch { /* 拿不到就算了 */ }
            // BOM 补回：NAPI 的 commitEdits 会把 BOM 丢掉（审计实测），这里按预览时记的状态还原
            const payload = entry.hadBom?.[file] ? `\uFEFF${content}` : content
            phase = 'write'
            await fs.writeFile(tmp, payload)
            if (mode !== null) {
                try { await fs.chmod(tmp, mode & 0o7777) } catch { /* 平台不支持就算了 */ }
            }
            phase = 'rename'
            await fs.rename(tmp, file)
            written.push(file)
        }
        catch (error) {
            try { await fs.rm(tmp, { force: true }) } catch { /* ignore */ }
            // rename 是最后一步且是原子的：它抛错时"到底换没换"在个别文件系统/杀软干预下无法断言 ⇒ 记 unknown
            if (phase === 'rename') sawUnknown = true
            writeErrors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
            break // 报错即停，别再制造更多不一致
        }
        finally {
            if (lock !== null) { try { await fs.rm(lock, { force: true }) } catch { /* ignore */ } }
        }
    }
    if (writeErrors.length) {
        const nothingWritten = written.length === 0
        // 措辞按**实际计划数**说（审计 D-20）：单个文件失败时也说 "wrote only some files"，读起来像写了一半
        const head = nothingWritten
            ? (toWrite.length === 1 ? 'apply failed（这个文件没有被写入）' : `apply failed（${toWrite.length} 个文件一个都没写入）`)
            : `apply 写了 ${written.length}/${toWrite.length} 个文件后失败`
        // **effectState**（照 dsh-ops 抄）：失败时最要紧的一句话是"到底写没写进去"，别让调用方猜
        const effectState = written.length > 0 ? 'applied' : (sawUnknown ? 'unknown' : 'none')
        const explain = effectState === 'none'
            ? '什么都没写'
            : (effectState === 'applied' ? `已写入 ${written.length} 个文件，其余未动` : '有一次 rename 的结局无法确定 —— 去核对目标文件')
        const wrapped = new ToolError(`${head}: ${writeErrors.join('; ')}${written.length ? `\n  已写入（${written.length}）：${written.join(', ')}\n  工作区处于**部分改写**状态：处理掉失败原因后重新 preview + apply 续做` : ''}\n  effectState: ${effectState}（${explain}）`)
        wrapped.effectState = effectState
        throw wrapped
    }
    staging.drop(entry.id)
    const message = `${buildMessage('apply', { total: result.totalReplacements, touched: result.filesTouched.length }, {
        warnings: result.warnings,
        coverage: result.coverage,
        skippedAny: false,
        coverageSkipped: result.coverageSkipped,
        verifyResults: result.verifyResults,
    })}\nApplied staged id ${entry.id}.`
    return {
        ok: true,
        action: 'apply',
        applied: true,
        totalReplacements: result.totalReplacements,
        filesTouched: result.filesTouched.length,
        filesSearched: entry.files.length,
        limitReached: false,
        message,
    }
}

function doReject(args, sessionId) {
    const stagedId = args.stagedId?.trim() || staging.latest(sessionId)?.id
    if (!stagedId) throw new ToolError('no live staged proposal for this session; run a preview first')
    const entry = staging.get(stagedId, sessionId)
    if (!entry) throw new ToolError(`unknown or expired stagedId ${stagedId}; run a preview again`)
    staging.drop(entry.id)
    return {
        ok: true,
        action: 'reject',
        applied: false,
        totalReplacements: 0,
        filesTouched: 0,
        filesSearched: entry.files.length,
        limitReached: false,
        stagedId: entry.id,
        message: 'Discarded staged rewrite; files unchanged.',
    }
}

export function tools(defineTool, options = {}) {
    const config = { maxFiles: resolveMaxFiles(options), maxRenderChanges: MAX_RENDER_CHANGES }
    return [
        defineTool({
            name: 'ast_edit',
            description: [
                'Preview and apply structural (AST-aware) rewrites over source files, in-process via @ast-grep/napi.',
                'Rules use $NAME / $_ / $$$NAME metavariables that stand for whole AST nodes; captures from pat substitute into out, and an empty out deletes the matched node.',
                'paths is REQUIRED (never omit it). Always previews first and stages the proposal: files are not modified until an apply with the returned stagedId, and a stale preview is rejected.',
            ].join(' '),
            parameters,
            timeoutMs: 300_000,
            output: {
                schema: outputSchema,
                render(args, rawValue) {
                    const value = rawValue
                    const lines = []
                    if (value.message) lines.push(value.message)
                    const changes = value.changes ?? []
                    const detail = resolvePreviewDetail(args?.previewDetail, changes.length)
                    if (detail === 'full') {
                        for (const change of changes) {
                            lines.push(`[${change.file}]`)
                            lines.push(`-${change.line}:${change.column} ${change.before}`)
                            lines.push(`+${change.line}:${change.column} ${change.after}`)
                        }
                    }
                    else if (changes.length > 0) {
                        // 按文件汇总：**路径只出现一次**，每文件列前 N 处，其余折叠（但总数照实报）
                        const byFile = new Map()
                        for (const change of changes) {
                            const list = byFile.get(change.file) ?? []
                            list.push(change)
                            byFile.set(change.file, list)
                        }
                        const perFile = value.perFileCount ?? {}
                        for (const [file, list] of byFile) {
                            const total = Number.isFinite(perFile[file]) ? perFile[file] : list.length
                            lines.push(`[${file}]  ${total} 处`)
                            for (const change of list.slice(0, SUMMARY_PER_FILE)) {
                                lines.push(`  ${change.line}:${change.column}  ${oneLine(change.before)} → ${oneLine(change.after)}`)
                            }
                            const hidden = total - Math.min(list.length, SUMMARY_PER_FILE)
                            if (hidden > 0) lines.push(`  ……其余 ${hidden} 处未列出`)
                        }
                        lines.push(`（明细已折叠：共 ${value.totalReplacements} 处 / ${value.filesTouched} 个文件；要逐处 \`-行:列\`/\`+行:列\` 用 previewDetail:"full"）`)
                    }
                    return [{ type: 'text', text: lines.join('\n') || '(no output)' }]
                },
                presentationMeta(_args, rawValue) {
                    const value = rawValue
                    return { action: value.action, ok: value.ok, replacements: value.totalReplacements, filesTouched: value.filesTouched }
                },
            },
            isConcurrencySafe(args) {
                return !args?.action || args.action === 'preview'
            },
            async execute(rawArgs, exec) {
                if (exec?.signal?.aborted === true) throw new ToolError('ast_edit aborted')
                const args = rawArgs ?? {}
                const action = args.action ?? 'preview'
                // 审计 D-18：以前所有拿不到 session id 的调用方共用 `'anonymous'` 桶 ⇒ 可以互相 apply 对方的提案。
    // 现在按**进程**隔离（同一宿主进程内的匿名调用方仍共享，跨进程不可能串）。
    const sessionId = exec?.agent?.session?.id ?? `anonymous-pid-${process.pid}`
                const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
                if (action === 'preview') {
                    const ops = resolveOps(args.ops ?? [], { mode: args.mode, wordBoundary: args.wordBoundary })
                    if (!Array.isArray(args.paths) || args.paths.length === 0 || args.paths.every((p) => !String(p ?? '').trim())) {
                        throw new ToolError('paths is required: at least one non-empty file, directory, or glob')
                    }
                    return doPreview(args, ops, exec, config, cwd, sessionId)
                }
                if (action === 'apply') return doApply(args, exec, { ...config, guardCtx: options.getCtx }, sessionId)
                if (action === 'reject') return doReject(args, sessionId)
                throw new ToolError(`unknown action ${String(action)}`)
            },
        }),
    ]
}

export function apply(ctx, defineTool, options = {}) {
    // 先走 `ctx.tools`（家族收口就在那上面：关掉的族/需要记账的登记都必须经过它）；
 // `ctx.get('tools')` 只作为兜底（以前只写 ctx.get，刷新时 ast_edit 重复注册）。
    const toolsMod = ctx.tools ?? (typeof ctx.get === 'function' ? ctx.get('tools') : null)
    if (!toolsMod) return 0
    const list = tools(defineTool, options)
    for (const t of list) toolsMod.register(t)
    return list.length
}

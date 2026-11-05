/**
 * `ast_search` 的 `action:"diff"`：拿一段**拟写入内容**与文件当前内容比，**不落盘、不入栈**。
 *
 * 放在只读侧（而不是 `ast_edit`）的理由：它不改任何东西 —— 语义上属于"看"，不属于"改"。
 * 用途：整文件替换 / 生成式改写（**没有 pattern 可跑**，`ast_edit.preview` 覆盖不到）之前先看一眼差异。
 *
 * 复用 checkpoint 家族那个**零依赖的纯文本行 diff 引擎**（没为一个动作再造一套）。
 * 两个保真细节（都实测踩出来的）：
 *  1. **行尾先归一再比较** —— CRLF 文件与 LF 内容直接比会把**每一行**都算成"删了再加"，预览失去意义；
 *     正文相同、只有行尾不同时单独报 `eolOnly`，不吞掉"你其实只改了行尾"。
 *  2. **BOM 当文件元数据** —— 比较正文，但 `after.revision` 按"写进去之后的字节"算（与其它工具 revision 口径一致）。
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { collectFiles } from '../glob.js'
import { ToolError } from '../errors.js'
import { diffLines, unifiedDiffLines } from '../checkpoint/diff.js'

/** 渲染上限（超出的 diff 行折叠，避免一次预览灌满上下文） */
export const DIFF_MAX_LINES = 240

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const linesOf = (text) => (text === '' ? 0 : text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0))
const eolOf = (text) => (/\r\n/.test(text) ? 'crlf' : (/[^\r]\n|^\n/.test(text) ? 'lf' : 'none'))
const canon = (text) => text.replace(/\r\n/g, '\n')

/**
 * @param {{paths?: unknown, content?: unknown}} args
 * @param {{agent?: {session?: {header?: {cwd?: string}}}}} [exec]
 */
export async function diffAction(args, exec) {
    const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
    const content = typeof args.content === 'string' ? args.content : null
    if (content === null) throw new ToolError('action:"diff" 需要 `content`：要对比的"拟写入内容"')
    const paths = (Array.isArray(args.paths) ? args.paths : []).map((p) => String(p ?? '').trim()).filter(Boolean)
    if (paths.length === 0) throw new ToolError('action:"diff" 需要 `paths`：**恰好一个**文件路径')
    const collected = await collectFiles(paths, { cwd, maxFiles: 4 })
    if (collected.files.length === 0) {
        throw new ToolError(`找不到要比较的文件（${paths.join('、')}）—— action:"diff" 比的是**磁盘上已有**的文件`)
    }
    if (collected.files.length !== 1) {
        const list = collected.files.slice(0, 3).join('、')
        throw new ToolError(`action:"diff" 只比较**一个**文件，这次解析出 ${collected.files.length} 个${list ? `（${list}${collected.files.length > 3 ? ' …' : ''}）` : ''} —— 请给单个文件路径`)
    }
    const file = collected.files[0]
    let raw
    try { raw = await fs.readFile(file, 'utf8') }
    catch (error) { throw new ToolError(`读不了 ${file}：${error instanceof Error ? error.message : String(error)}`) }

    const hadBom = raw.charCodeAt(0) === 0xFEFF
    const beforeText = hadBom ? raw.slice(1) : raw
    const afterText = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content
    const beforeRevision = sha256(raw)
    const afterRaw = hadBom ? `\uFEFF${afterText}` : afterText
    const afterRevision = sha256(afterRaw)
    const beforeCanon = canon(beforeText)
    const afterCanon = canon(afterText)
    const beforeEol = eolOf(beforeText)
    const afterEol = eolOf(afterText)
    // **按文本判**，不看 diff 引擎的输出 —— 引擎把"结尾换行"当成"增删一个空行"，靠 body 是否为空判会漏
    // （真机测试抓到：只差结尾换行时 body 非空 ⇒ 走普通 diff 分支，渲染成一行看不懂的"+0 −1 行"）。
    const stripTrail = (t) => t.replace(/\n$/, '')
    const sameText = beforeCanon === afterCanon
    const eolOnly = sameText && beforeEol !== afterEol
    const tailOnly = !sameText && !eolOnly && stripTrail(beforeCanon) === stripTrail(afterCanon)
    const identical = sameText && !eolOnly
    // 只有真要给人看行差异时才跑 diff 引擎（identical/eolOnly/tailOnly 都不需要它）
    const body = identical || eolOnly || tailOnly
        ? ''
        : unifiedDiffLines(beforeCanon, afterCanon, { fromLabel: '', toLabel: '', maxLines: DIFF_MAX_LINES })
            .replace(/^--- .*\n\+\+\+ .*\n/, '')
    const ops = body === '' ? [] : diffLines(beforeCanon, afterCanon)
    const added = body === '' ? 0 : ops.filter((op) => op.op === 'add').length
    const removed = body === '' ? 0 : ops.filter((op) => op.op === 'del').length
    const rel = path.relative(cwd, file) || file
    const message = identical
        ? `No differences — ${rel} 与给定 content 一致；未写盘。`
        : (eolOnly
            ? `仅行尾不同（${beforeEol} → ${afterEol}）；正文未变，未写盘。`
            : (tailOnly
                ? `仅结尾换行不同（文件${/\n$/.test(beforeText) ? '有' : '没有'}结尾换行 → content ${/\n$/.test(afterText) ? '有' : '没有'}）；正文未变，未写盘。`
                : body))
    return {
        action: 'diff',
        count: added + removed,
        truncated: /… 另有 \d+ 行未展示/.test(body),
        filesSearched: 1,
        filesWithHits: identical ? 0 : 1,
        message,
        diff: {
            path: rel,
            identical,
            eolOnly,
            tailOnly,
            added,
            removed,
            // `approximate`：中间窗口过大时 diffLines 是"整段删 + 整段加"，必须外显（别让人误以为做了真正的行对齐）
            approximate: Boolean(ops.approximate),
            eol: { before: beforeEol, after: afterEol },
            before: { bytes: Buffer.byteLength(raw, 'utf8'), lineCount: linesOf(beforeText), revision: beforeRevision, bom: hadBom },
            after: { bytes: Buffer.byteLength(afterRaw, 'utf8'), lineCount: linesOf(afterText), revision: afterRevision },
        },
    }
}

/** 给渲染层用：`[path]  +N −M 行  rev 旧 → 新` 一行表头（再加上面的 message 正文） */
export function renderDiff(value) {
    const d = value.diff
    if (d.identical) return `No differences — ${d.path}（${d.before.lineCount} 行，rev ${String(d.before.revision).slice(0, 12)}）与给定 content 一致；未写盘。`
    if (d.eolOnly) return `[${d.path}] 仅行尾不同（${d.eol.before} → ${d.eol.after}）；正文未变，未写盘。`
    if (d.tailOnly) return `[${d.path}] ${value.message}`
    const eolNote = d.eol.before !== d.eol.after ? `  （行尾 ${d.eol.before} → ${d.eol.after}）` : ''
    const head = `[${d.path}]  +${d.added} −${d.removed} 行  rev ${String(d.before.revision).slice(0, 12)} → ${String(d.after.revision).slice(0, 12)}${d.before.bom ? '  （保留 BOM）' : ''}${eolNote}${d.approximate ? '  ⚠ 近似对齐（中间窗口过大）' : ''}`
    return `${head}\n${value.message}`
}

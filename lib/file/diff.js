/**
 * file diff —— 「这个文件 vs 我准备写入的内容」的只读预览。
 *
 * 与 table_diff（两张表按键比对）、ast_edit 的 staged 预览不是一回事：
 * 这里回答的是"我若用 write 落盘，会改动哪几行"，用**公共前缀/后缀按行修剪**后
 * 只输出一个替换 hunk（不做最小 diff、不建 LCS 矩阵），大文件也是 O(行数)。
 * 分页按 hunk 行给 offset/limit，避免一次把整段 diff 灌进上下文。
 *
 * 三条硬边界（审计后补，都是"看起来能用、实际会误导"的坑）：
 *  ① 二进制文件不做行 diff（会出现整屏乱码 hunk）⇒ 直接拒绝并指向 read 的 hex；
 *  ② 旧文件有大小上限（整文件读入内存）⇒ 超过就要求分段；
 *  ③ **编码差异必须说清**：write 只会写 UTF-8，GB18030 / UTF-16 文件即使"行内容相同"，
 *     落盘也会整体重编码 —— 不能笼统说成"换行符或 BOM 差异"。
 */
import { readFileSync, statSync } from 'node:fs'
import { decodeBuffer, looksBinary, sniffBom } from './read.js'
import { sha256 } from './write.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const DEFAULT_CONTEXT = 3
const MAX_CONTEXT = 20
const MAX_PROPOSED_BYTES = 2 * 1024 * 1024
/** 旧文件整文件读入内存；超过这个体积就该用 read + 分段看，而不是 diff。 */
const MAX_OLD_BYTES = 8 * 1024 * 1024

const clampInt = (value, min, max, fallback) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(min, Math.trunc(n)), max)
}

/** 统一按 LF 切行，并记住原文是否以换行结尾（尾行差异也算改动）。 */
function splitLines(text) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const trailingNewline = normalized.endsWith('\n')
    const lines = normalized.split('\n')
    if (trailingNewline) lines.pop()
    return { lines, trailingNewline }
}

/** 文本里占多数的换行风格（用于解释"字节不同但行相同"到底差在哪）。 */
function eolKind(text) {
    const crlf = (text.match(/\r\n/g) ?? []).length
    const cr = (text.match(/\r(?!\n)/g) ?? []).length
    const lf = (text.match(/(?<!\r)\n/g) ?? []).length
    if (crlf === 0 && cr === 0 && lf === 0) return 'none'
    if (crlf >= cr && crlf >= lf) return 'CRLF'
    if (cr > lf) return 'CR'
    return 'LF'
}

export function diffFileOp({ path, content, offset, limit, context } = {}) {
    if (typeof path !== 'string' || path.trim() === '') return { ok: false, error: 'diff 要给 path（目标文件）' }
    if (typeof content !== 'string') return { ok: false, error: 'diff 要给 content（拟写入的完整内容）' }
    if (Buffer.byteLength(content, 'utf8') > MAX_PROPOSED_BYTES) {
        return { ok: false, error: `content 太大（>${MAX_PROPOSED_BYTES / 1048576} MB）；diff 不适合这么大的一次性预览` }
    }
    let stats
    try { stats = statSync(path) }
    catch (error) {
        return { ok: false, error: `读不到文件：${path}（${error instanceof Error ? error.message : String(error)}）` }
    }
    if (stats.isDirectory()) return { ok: false, error: `是目录，不是文件：${path}` }
    if (!stats.isFile()) return { ok: false, error: `不是普通文件：${path}` }
    if (stats.size > MAX_OLD_BYTES) {
        return { ok: false, error: `文件太大（${(stats.size / 1048576).toFixed(1)} MB > ${MAX_OLD_BYTES / 1048576} MB），不做整文件 diff；请用 file read 分段查看，或先缩小改动范围` }
    }
    let buffer
    try { buffer = readFileSync(path) }
    catch (error) {
        return { ok: false, error: `读不到文件：${path}（${error instanceof Error ? error.message : String(error)}）` }
    }
    const bom = sniffBom(buffer)
    // UTF-16 的 ASCII 字符天然带 NUL ⇒ BOM 优先，再判二进制（与 read 的顺序一致）。
    if (bom === null && looksBinary(buffer)) {
        return { ok: false, error: `二进制文件，不做行级 diff：${path}（要看内容请用 file read，它会给出 hex 预览）` }
    }
    const hasBom = bom !== null
    const decoded = decodeBuffer(buffer, 'auto')
    const oldText = decoded.text
    const encoding = decoded.encoding
    const nextBytes = Buffer.from(content, 'utf8')
    const oldHash = sha256(buffer)
    const newHash = sha256(nextBytes)
    const old = splitLines(oldText)
    const next = splitLines(content)

    let start = 0
    const paired = Math.min(old.lines.length, next.lines.length)
    while (start < paired && old.lines[start] === next.lines[start]) start += 1
    let oldEnd = old.lines.length
    let newEnd = next.lines.length
    while (oldEnd > start && newEnd > start && old.lines[oldEnd - 1] === next.lines[newEnd - 1]) {
        oldEnd -= 1
        newEnd -= 1
    }
    const sameLines = start === old.lines.length && oldEnd === start && newEnd === start
    const head = [
        `diff ${path}`,
        `old=${oldHash.slice(0, 12)}  ${old.lines.length} 行${old.trailingNewline ? '' : '（无尾换行）'}${hasBom ? `  BOM` : ''}${encoding === 'utf8' ? '' : `  encoding=${encoding}`}`,
        `new=${newHash.slice(0, 12)}  ${next.lines.length} 行${next.trailingNewline ? '' : '（无尾换行）'}`,
    ]
    // write 只写 UTF-8（BOM 由 bom:true 决定）⇒ 非 UTF-8 文件的"行相同"绝不等于"落盘无变化"。
    const reencode = encoding !== 'utf8'
    const encodeNote = reencode
        ? `文件编码是 ${encoding}，write 一律写 UTF-8 ⇒ 落盘会整体重编码（内容行不变，字节全变）`
        : ''
    if (sameLines) {
        const notes = []
        if (reencode) notes.push(encodeNote)
        if (old.trailingNewline !== next.trailingNewline) {
            notes.push(next.trailingNewline ? '行内容相同，但新内容多了结尾换行' : '行内容相同，但新内容少了结尾换行')
        }
        if (oldHash !== newHash) {
            const oldEol = eolKind(oldText)
            const newEol = eolKind(content)
            if (oldEol !== newEol && oldEol !== 'none' && newEol !== 'none') {
                notes.push(`行内容相同，但换行符不同（文件 ${oldEol} → 写入 ${newEol}）`)
            }
            else if (hasBom) {
                notes.push('内容相同（文件带 BOM；write 默认会去 BOM，需保留请用 bom:true）')
            }
            else if (notes.length === 0) {
                notes.push('行内容相同，但字节不同（BOM 或结尾换行差异；write 会按 content 原样写入）')
            }
        }
        if (notes.length === 0) notes.push('内容相同，无改动')
        return { ok: true, text: [...head, notes.join('；')].join('\n') }
    }
    const contextLines = clampInt(context, 0, MAX_CONTEXT, DEFAULT_CONTEXT)
    const from = Math.max(0, start - contextLines)
    const oldTo = Math.min(old.lines.length, oldEnd + contextLines)
    const newTo = Math.min(next.lines.length, newEnd + contextLines)
    const hunk = [`@@ -${from + 1},${oldTo - from} +${from + 1},${newTo - from} @@`]
    for (let index = from; index < start; index += 1) hunk.push(` ${old.lines[index]}`)
    for (let index = start; index < oldEnd; index += 1) hunk.push(`-${old.lines[index]}`)
    for (let index = start; index < newEnd; index += 1) hunk.push(`+${next.lines[index]}`)
    for (let index = oldEnd; index < oldTo; index += 1) hunk.push(` ${old.lines[index]}`)

    const pageSize = clampInt(limit, 1, MAX_LIMIT, DEFAULT_LIMIT)
    const pageStart = clampInt(offset, 0, hunk.length, 0)
    if (pageStart >= hunk.length) {
        return { ok: true, text: [...head, `（offset=${pageStart} 超出 hunk 的 ${hunk.length} 行；hunk 行号从 0 开始）`].join('\n'), nextOffset: null, total: hunk.length }
    }
    const page = hunk.slice(pageStart, pageStart + pageSize)
    const nextOffset = pageStart + page.length
    const tail = reencode ? `\n（注意：${encodeNote}）` : ''
    const footer = nextOffset < hunk.length
        ? `（hunk 行 ${pageStart + 1}-${nextOffset}/${hunk.length}；nextOffset=${nextOffset} 继续）${tail}`
        : `（hunk 共 ${hunk.length} 行）${tail}`
    return { ok: true, text: [...head, ...page, footer].join('\n'), nextOffset: nextOffset < hunk.length ? nextOffset : null, total: hunk.length }
}

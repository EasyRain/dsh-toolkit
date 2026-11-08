/**
 * file diff —— 「这个文件 vs 我准备写入的内容」的只读预览。
 *
 * 与 table_diff（两张表按键比对）、ast_edit 的 staged 预览不是一回事：
 * 这里回答的是"我若用 write 落盘，会改动哪几行"，用**公共前缀/后缀按行修剪**后
 * 只输出一个替换 hunk（不做最小 diff、不建 LCS 矩阵），大文件也是 O(行数)。
 * 分页按 hunk 行给 offset/limit，避免一次把整段 diff 灌进上下文。
 */
import { readFileSync } from 'node:fs'
import { decodeBuffer, sniffBom } from './read.js'
import { sha256 } from './write.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const DEFAULT_CONTEXT = 3
const MAX_CONTEXT = 20
const MAX_PROPOSED_BYTES = 2 * 1024 * 1024

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

export function diffFileOp({ path, content, offset, limit, context } = {}) {
    if (typeof content !== 'string') return { ok: false, error: 'diff 要给 content（拟写入的完整内容）' }
    if (Buffer.byteLength(content, 'utf8') > MAX_PROPOSED_BYTES) {
        return { ok: false, error: `content 太大（>${MAX_PROPOSED_BYTES / 1048576} MB）；diff 不适合这么大的一次性预览` }
    }
    let buffer
    try { buffer = readFileSync(path) }
    catch (error) {
        return { ok: false, error: `读不到文件：${path}（${error instanceof Error ? error.message : String(error)}）` }
    }
    const hasBom = sniffBom(buffer) !== null
    const oldText = decodeBuffer(buffer, 'auto').text
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
        `old=${oldHash.slice(0, 12)}  ${old.lines.length} 行${old.trailingNewline ? '' : '（无尾换行）'}${hasBom ? '  BOM' : ''}`,
        `new=${newHash.slice(0, 12)}  ${next.lines.length} 行${next.trailingNewline ? '' : '（无尾换行）'}`,
    ]
    if (sameLines) {
        const notes = []
        if (old.trailingNewline !== next.trailingNewline) {
            notes.push(next.trailingNewline ? '行内容相同，但新内容多了结尾换行' : '行内容相同，但新内容少了结尾换行')
        }
        else if (oldHash !== newHash) {
            notes.push('行内容相同，但字节不同（换行符或 BOM 差异；write 会按 content 原样写入）')
        }
        else {
            notes.push(hasBom ? '内容相同（文件带 BOM；write 默认会去 BOM，需保留请用 bom:true）' : '内容相同，无改动')
        }
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
    const page = hunk.slice(pageStart, pageStart + pageSize)
    const nextOffset = pageStart + page.length
    const footer = nextOffset < hunk.length
        ? `（hunk 行 ${pageStart + 1}-${nextOffset}/${hunk.length}；nextOffset=${nextOffset} 继续）`
        : `（hunk 共 ${hunk.length} 行）`
    return { ok: true, text: [...head, ...page, footer].join('\n'), nextOffset: nextOffset < hunk.length ? nextOffset : null, total: hunk.length }
}

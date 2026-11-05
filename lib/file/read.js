/**
 * file_read —— 只读的文件读取：**多文件 + 多区间 + 编码探测 + 二进制十六进制**。
 *
 * 为什么自己写：内核 0.2.2 移除了 `ops_read_files` / `ops_inspect_local_file`，宿主 `read` 只支持
 * 单文件单区间、且假定 UTF-8（本工作区有大量 GBK/GB18030 的 MC 模组文本，读出来就是乱码）。
 * 语义参考 dsh-ops（MIT，`Copyright (c) 2026 T-Auto and the dsh-ops contributors`），实现是 JS 重写：
 * ops 的读取逻辑在 Rust worker 里，无法直接复用。出处与许可全文见包根 `THIRD-PARTY-NOTICES.md`。
 *
 * 借鉴自 ops 的**读取协议**（这几条比"能读"本身更值钱，都经过实测）：
 *  - 读完就回 **revision**（整文件 sha256）⇒ 下一次 `edit` 可以直接拿它做 CAS，不用另外再读一遍；
 *  - **complete / nextOffset**：本段是否已到文件末尾、没到的话下一段从第几行开始（续读协议）；
 *  - **truncatedInLine**：单行超长被切（`maxLineChars`），与"文件没读完"是两回事；
 *  - **总输出预算**：多文件共享一份字节预算，而不是每个文件各 1 MB（20 个文件能把上下文撑爆）；
 *  - **`N|` 紧凑行号 + 可逆转义**：行号与正文之间只有一个 `|`，正文里的反斜杠/制表/控制字符转义，
 *    防止内容伪造出额外的行号或文件标题；
 *  - 同一父目录下的多文件共享一行 `[Base: "..."]`（省掉重复的绝对路径）。
 *
 * 设计边界（都为了"模型能自己纠错"）：
 *  - **逐文件隔离**：一个文件失败（不存在/是目录/二进制）不影响其它文件；
 *  - **编码探测**可解释：返回实际用的编码与依据（BOM / 严格 UTF-8 / GB18030 回退 / 有损）；
 *  - **有界**：总预算 + 单文件 maxBytes + 单次最多 20 文件 / 20 段 / 4000 行；
 *  - **二进制**不硬塞文本：给 offset + hex 预览，并提示这是二进制。
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, relative, resolve as resolvePath } from 'node:path'

export const LIMITS = Object.freeze({
    maxBytes: 1024 * 1024,
    hardMaxBytes: 16 * 1024 * 1024,
    /** 一次调用里所有文件**合计**最多显示的字节（共享预算，避免 20 个文件各 1 MB）。 */
    totalBytes: 2 * 1024 * 1024,
    maxFiles: 20,
    maxRanges: 20,
    maxLines: 4000,
    /** 单行显示上限；超出的部分不显示，并标 truncatedInLine。 */
    maxLineChars: 2000,
    binaryProbe: 8192,
    hexPreviewBytes: 256,
})

const ENCODINGS = ['auto', 'utf8', 'utf16le', 'utf16be', 'gb18030']

/** 8 KB 里出现 NUL 就当二进制（与 git 的判据同思路）。 */
function looksBinary(buffer) {
    const end = Math.min(buffer.length, LIMITS.binaryProbe)
    for (let i = 0; i < end; i += 1) if (buffer[i] === 0) return true
    return false
}

/** 十六进制预览：`00000000  4d 5a 90 00 …  |MZ..|` */
export function hexPreview(buffer, limit = LIMITS.hexPreviewBytes) {
    const slice = buffer.subarray(0, Math.min(buffer.length, limit))
    const lines = []
    for (let offset = 0; offset < slice.length; offset += 16) {
        const chunk = slice.subarray(offset, offset + 16)
        const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(16 * 3 - 1, ' ')
        const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
        lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`)
    }
    return lines.join('\n')
}

/** 带 BOM 时返回 { encoding, skip }；否则 null。 */
export function sniffBom(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return { encoding: 'utf8', skip: 3 }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: 'utf16le', skip: 2 }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return { encoding: 'utf16be', skip: 2 }
    return null
}

const decoderLabel = { utf16le: 'utf-16le', utf16be: 'utf-16be', gb18030: 'gb18030', utf8: 'utf-8' }

function decodeStrict(bytes, encoding) {
    return new TextDecoder(decoderLabel[encoding], { fatal: true }).decode(bytes)
}

function decodeLossy(bytes, encoding) {
    return new TextDecoder(decoderLabel[encoding], { fatal: false }).decode(bytes)
}

/**
 * 解码：BOM 优先 → 严格 UTF-8 → 严格 GB18030 → 有损 UTF-8（并报告替换字符数）。
 * @returns {{ text: string, encoding: string, reason: string, replacements: number }}
 */
export function decodeBuffer(buffer, requested = 'auto') {
    const bom = sniffBom(buffer)
    const body = bom ? buffer.subarray(bom.skip) : buffer
    if (requested !== 'auto') {
        const text = decodeLossy(body, requested)
        return { text, encoding: requested, reason: bom ? 'BOM + 显式指定' : '显式指定', replacements: (text.match(/\uFFFD/g) ?? []).length }
    }
    if (bom) return { text: decodeLossy(body, bom.encoding), encoding: bom.encoding, reason: 'BOM', replacements: 0 }
    try {
        return { text: decodeStrict(body, 'utf8'), encoding: 'utf8', reason: '严格 UTF-8 通过', replacements: 0 }
    }
    catch { /* 继续试 GB18030 */ }
    try {
        return { text: decodeStrict(body, 'gb18030'), encoding: 'gb18030', reason: '非 UTF-8，GB18030 严格通过', replacements: 0 }
    }
    catch { /* 退回有损 UTF-8 */ }
    const text = decodeLossy(body, 'utf8')
    return { text, encoding: 'utf8', reason: '无法严格解码（UTF-8/GB18030 均失败），有损显示', replacements: (text.match(/\uFFFD/g) ?? []).length }
}

/** 解析 `"1-40"` / `"12"` / `"12-"`；非法抛错（错误信息直接可读）。 */
export function parseRange(spec) {
    const text = String(spec ?? '').trim()
    const m = text.match(/^(\d+)\s*(?:-\s*(\d*))?$/)
    if (!m) throw new Error(`ranges 里的 ${JSON.stringify(text)} 不合法；写法是 "12" 或 "1-40"（行号从 1 开始）`)
    const start = Number(m[1])
    if (!Number.isInteger(start) || start < 1) throw new Error(`ranges 起始行必须 ≥1：${JSON.stringify(text)}`)
    // "12" = 只取第 12 行；"12-" = 第 12 行到末尾。
    const end = m[2] === undefined ? start : (m[2] === '' ? Number.POSITIVE_INFINITY : Number(m[2]))
    if (Number.isFinite(end) && end < start) throw new Error(`ranges 的结束行小于起始行：${JSON.stringify(text)}`)
    return { start, end }
}

/** 整文件 sha256（分块读，不把大文件整个塞进内存）。读不了返回 null。 */
export function fileRevision(filePath, size) {
    let fd
    try {
        const hash = createHash('sha256')
        fd = openSync(filePath, 'r')
        const chunk = Buffer.alloc(1024 * 1024)
        let offset = 0
        while (offset < size) {
            const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset)
            if (read <= 0) break
            hash.update(chunk.subarray(0, read))
            offset += read
        }
        return hash.digest('hex')
    }
    catch {
        return null
    }
    finally {
        if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关闭 */ } }
    }
}

/**
 * 正文转义（可逆）：反斜杠 → `\\`、制表 → `\t`、C0 控制字符与 U+2028/2029 → `\uXXXX`。
 * 目的不是好看，而是**防止文件内容伪造出额外的行号/标题**（`1|` 这样的前缀只能由我们产生）。
 */
export function escapeLine(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/\t/g, '\\t')
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** 读取单个文件（不抛：返回 `{ ok, ... }` 形状，失败带 error）。 */
export function readOne(filePath, options = {}) {
    const maxBytes = Math.min(Math.max(256, Number(options.maxBytes) || LIMITS.maxBytes), LIMITS.hardMaxBytes)
    const ranges = Array.isArray(options.ranges) ? options.ranges.map(parseRange) : null
    let stats
    try {
        stats = statSync(filePath)
    }
    catch (error) {
        return { ok: false, path: filePath, error: `读不到：${error instanceof Error ? error.message : String(error)}` }
    }
    if (stats.isDirectory()) return { ok: false, path: filePath, error: '是目录（目录列表请用 glob / pwsh Get-ChildItem）' }
    if (!stats.isFile()) return { ok: false, path: filePath, error: '不是普通文件' }

    const revision = fileRevision(filePath, stats.size)
    const meta = { size: stats.size, mtime: stats.mtime.toISOString(), lines: null, truncated: false }
    if (options.stat === true) return { ok: true, path: filePath, stat: meta, revision }

    // 多读 1 字节：用来判断是否被 maxBytes 截断（而不是猜）。
    const want = Math.min(stats.size, maxBytes + 1)
    const buffer = Buffer.alloc(want)
    let read = 0
    let fd
    try {
        fd = openSync(filePath, 'r')
        read = readSync(fd, buffer, 0, want, 0)
    }
    catch (error) {
        return { ok: false, path: filePath, error: `打开失败：${error instanceof Error ? error.message : String(error)}` }
    }
    finally {
        if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关闭 */ } }
    }
    const bytes = buffer.subarray(0, read)
    const truncated = stats.size > maxBytes
    const shown = truncated ? bytes.subarray(0, maxBytes) : bytes

    // ⚠️ 先看 BOM：UTF-16LE 的 ASCII 字符（含换行）天然带 0x00 字节，
    // 直接按 NUL 判二进制会把整个 UTF-16 文本误判成二进制（实测踩到）。
    const bom = sniffBom(shown)
    if (bom === null && looksBinary(shown)) {
        return {
            ok: true,
            path: filePath,
            binary: true,
            revision,
            stat: { ...meta, truncated },
            hex: hexPreview(shown),
            note: `二进制文件（前 ${Math.min(shown.length, LIMITS.hexPreviewBytes)} 字节；共 ${stats.size} 字节）`,
        }
    }

    const decoded = decodeBuffer(shown, options.encoding ?? 'auto')
    const allLines = decoded.text.split(/\r?\n/)
    // 末尾换行会多切出一个空串：只在它是"文件以换行结尾"时去掉，避免把真实空行也吞掉。
    if (allLines.length > 0 && allLines[allLines.length - 1] === '' && /\n$/.test(decoded.text)) allLines.pop()
    meta.lines = allLines.length

    const selected = []
    let truncatedInLine = false
    const push = (number, raw) => {
        let line = raw
        if (line.length > LIMITS.maxLineChars) {
            truncatedInLine = true
            line = line.slice(0, LIMITS.maxLineChars)
        }
        selected.push({ number, line })
    }
    if (ranges === null) {
        const limit = Math.min(allLines.length, LIMITS.maxLines)
        for (let index = 0; index < limit; index += 1) push(index + 1, allLines[index])
    }
    else {
        for (const range of ranges) {
            const end = Math.min(Number.isFinite(range.end) ? range.end : allLines.length, allLines.length)
            for (let n = range.start; n <= end && selected.length < LIMITS.maxLines; n += 1) push(n, allLines[n - 1] ?? '')
        }
    }

    const lastShown = selected.length > 0 ? selected[selected.length - 1].number : 0
    // complete 只回答"这段视图是否已经到文件末尾"；**行内截断是另一个事实**（truncatedInLine），
    // 两者不能混 —— 否则"读到末行但某行太长"会被误报成"还有下一页"。
    const complete = truncated !== true && lastShown >= allLines.length
    return {
        ok: true,
        path: filePath,
        encoding: decoded.encoding,
        encodingReason: decoded.reason,
        replacements: decoded.replacements,
        stat: { ...meta, truncated },
        lines: selected,
        truncated,
        truncatedInLine,
        complete,
        nextOffset: complete ? undefined : lastShown + 1,
        revision,
    }
}

/** 把结果渲染成模型可读的文本（多文件按块分段；失败的文件单独一段）。 */
export function renderReport(results, options = {}) {
    const okResults = results.filter((result) => result.ok === true && result.binary !== true && result.statOnly !== true)
    // 同一父目录的多文件共享一行 Base（省掉重复的绝对路径）。
    let base = null
    if (okResults.length > 1) {
        const dirs = new Set(okResults.map((result) => dirname(resolvePath(result.path))))
        if (dirs.size === 1) base = [...dirs][0]
    }
    const nameOf = (result) => {
        if (base === null) return JSON.stringify(result.path)
        return JSON.stringify(relative(base, resolvePath(result.path)).split('\\').join('/'))
    }
    const parts = base === null ? [] : [`[Base: ${JSON.stringify(base)}]`]
    for (const result of results) {
        const name = base === null ? JSON.stringify(result.path) : nameOf(result)
        if (result.ok !== true) {
            parts.push(`=== FILE: ${name} ===\n!! ${result.error}`)
            continue
        }
        if (result.statOnly === true) {
            parts.push(`=== FILE: ${name} ===\nsize=${result.stat.size} B · lines=${result.stat.lines ?? '?'} · mtime=${result.stat.mtime}${result.revision ? ` · revision=${result.revision}` : ''}`)
            continue
        }
        if (result.binary === true) {
            parts.push(`=== FILE: ${name} [binary] ===\n${result.note}\n${result.hex}`)
            continue
        }
        const first = result.lines.length > 0 ? result.lines[0].number : 0
        const last = result.lines.length > 0 ? result.lines[result.lines.length - 1].number : 0
        const range = result.lines.length > 0 ? `Lines ${first}-${last} of ${result.stat.lines}` : `Lines 0 of ${result.stat.lines}`
        const head = [
            `encoding=${result.encoding}${result.encodingReason ? ` (${result.encodingReason})` : ''}`,
            `${result.stat.size} B`,
            result.replacements > 0 ? `${result.replacements} 个无法解码的字符（U+FFFD）` : null,
            result.truncated ? `超过 maxBytes（${options.maxBytes ?? LIMITS.maxBytes} B）已截断` : null,
            result.truncatedInLine ? `有超长行被切到 ${LIMITS.maxLineChars} 字符` : null,
        ].filter(Boolean).join(' · ')
        const body = result.lines.map((item) => `${item.number}| ${escapeLine(item.line)}`).join('\n')
        const tail = result.revision
            ? (result.complete ? `[revision=${result.revision}; end of file; complete=true]` : `[revision=${result.revision}; more lines; nextOffset=${result.nextOffset}]`)
            : ''
        parts.push(`=== FILE: ${name} (${range}) ===\n${head}\n${body}${tail ? `\n${tail}` : ''}`)
    }
    return parts.join('\n\n')
}

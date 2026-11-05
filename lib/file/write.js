/**
 * file 工具的**写入半边**：write / edit / copy / move / remove / mkdir / stat。
 *
 * 语义参考 dsh-ops 的 `ops_write_file` / `ops_edit_file`（MIT，`Copyright (c) 2026 T-Auto and the
 * dsh-ops contributors`；出处见包根 `THIRD-PARTY-NOTICES.md`），但实现是纯 JS：
 *  - **expectedRevision**（sha256，或 `absent` = 只新建）做 CAS，防止"读到旧内容再覆盖"；
 *  - **原子写**：同目录临时文件 + rename，失败清理，不留半截文件；
 *  - **edit 的 hunk 必须唯一且不重叠**，否则宁可整单失败，也不猜；
 *  - 回执带新 revision / 字节数 / 行数，方便下一步接着 CAS。
 *
 * 编码边界：`write` 只写 UTF-8（可加 BOM）；`edit` 按原编码写回，但 **GB18030 无法编码** ⇒
 * 明确拒绝（先转 UTF-8），绝不在用户不知情时改变文件编码。
 */
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { decodeBuffer, sniffBom } from './read.js'

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])
const BOM_UTF16LE = Buffer.from([0xff, 0xfe])

export function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex')
}

/** 当前文件的 sha256；不存在返回 null。 */
export function currentRevision(path) {
    try {
        return sha256(readFileSync(path))
    }
    catch {
        return null
    }
}

/**
 * CAS 校验：`expectedRevision` 未给 ⇒ 不校验；`"absent"` ⇒ 必须不存在；否则必须等于当前 sha256。
 * @returns {{ ok: true } | { ok: false, message: string, current?: string|null }}
 */
export function checkRevision(path, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') return { ok: true }
    const exists = existsSync(path)
    if (String(expectedRevision) === 'absent') {
        return exists ? { ok: false, message: '期望新建（absent），但文件已存在；先读它，或改用当前 revision', current: currentRevision(path) } : { ok: true }
    }
    const want = String(expectedRevision).trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(want)) {
        return { ok: false, message: `expectedRevision 必须是 64 位 sha256 或 "absent"，收到 ${JSON.stringify(String(expectedRevision)).slice(0, 80)}` }
    }
    if (!exists) return { ok: false, message: '期望按 revision 修改，但文件不存在（新建请用 expectedRevision:"absent"）', current: null }
    const current = currentRevision(path)
    if (current !== want) return { ok: false, message: 'CAS 失败：文件在读取后被改动过（revision 不匹配）；先重读再改', current }
    return { ok: true }
}

/** 同目录临时文件 + fsync + rename；任何一步失败都清理临时文件。 */
export function atomicWrite(path, bytes, options = {}) {
    const dir = dirname(path)
    if (options.createParents !== false) mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${basename(path)}.dsh-toolkit-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    let fd
    try {
        fd = openSync(tmp, 'wx')
        writeSync(fd, bytes, 0, bytes.length)
        try { fsyncSync(fd) } catch { /* 某些文件系统不支持，忽略 */ }
        closeSync(fd)
        fd = undefined
        renameSync(tmp, path)
    }
    catch (error) {
        if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关闭 */ } }
        try { unlinkSync(tmp) } catch { /* 可能没建出来 */ }
        throw error
    }
}

const asPath = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const asString = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

/** write：整文件写入（UTF-8，可带 BOM）。 */
export function writeFileOp({ path, content, expectedRevision, bom = false, createParents = true }) {
    const check = checkRevision(path, expectedRevision)
    if (check.ok !== true) return { ok: false, action: 'write', path, ...check }
    const body = Buffer.from(asString(content), 'utf8')
    const bytes = bom === true ? Buffer.concat([BOM_UTF8, body]) : body
    try {
        atomicWrite(path, bytes, { createParents })
    }
    catch (error) {
        return { ok: false, action: 'write', path, message: `写入失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, action: 'write', path, bytes: bytes.length, revision: sha256(bytes), lines: countLines(asString(content)) }
}

function countLines(text) {
    if (text === '') return 0
    return text.split(/\r?\n/).length - (/\n$/.test(text) ? 1 : 0)
}

/**
 * edit：对原文做若干处 `oldText → newText` 替换。
 * 每条必须**唯一命中**，且各命中区间不得重叠 —— 不满足就整单失败（不猜、不部分应用）。
 */
export function editFileOp({ path, edits, expectedRevision }) {
    if (!Array.isArray(edits) || edits.length === 0) return { ok: false, action: 'edit', path, message: 'edits 不能为空（每项 {oldText,newText}）' }
    const check = checkRevision(path, expectedRevision)
    if (check.ok !== true) return { ok: false, action: 'edit', path, ...check }

    let bytes
    try {
        bytes = readFileSync(path)
    }
    catch (error) {
        return { ok: false, action: 'edit', path, message: `读取失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const bom = sniffBom(bytes)
    const decoded = decodeBuffer(bytes, 'auto')
    if (decoded.encoding === 'gb18030') {
        return { ok: false, action: 'edit', path, message: '原文件是 GB18030，改回同编码需要转码器；请先转成 UTF-8 再编辑（避免悄悄改变编码）' }
    }
    const text = decoded.text
    const matches = []
    for (const edit of edits) {
        const oldText = asString(edit?.oldText)
        const newText = asString(edit?.newText)
        if (oldText === '') return { ok: false, action: 'edit', path, message: 'edits[].oldText 不能为空' }
        const first = text.indexOf(oldText)
        if (first < 0) return { ok: false, action: 'edit', path, message: `oldText 在文件里找不到：${JSON.stringify(oldText.slice(0, 80))}` }
        if (text.indexOf(oldText, first + 1) >= 0) {
            return { ok: false, action: 'edit', path, message: `oldText 命中多处（要求唯一）：${JSON.stringify(oldText.slice(0, 80))}；带上更多上下文再试` }
        }
        matches.push({ start: first, end: first + oldText.length, newText })
    }
    matches.sort((a, b) => a.start - b.start)
    for (let i = 1; i < matches.length; i += 1) {
        if (matches[i].start < matches[i - 1].end) {
            return { ok: false, action: 'edit', path, message: 'edits 之间命中的区间重叠（同一段文本被改两次）；拆成两次调用' }
        }
    }
    let output = ''
    let cursor = 0
    for (const match of matches) {
        output += text.slice(cursor, match.start) + match.newText
        cursor = match.end
    }
    output += text.slice(cursor)

    const encoded = encodeLike(output, decoded.encoding, bom)
    try {
        atomicWrite(path, encoded)
    }
    catch (error) {
        return { ok: false, action: 'edit', path, message: `写入失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, action: 'edit', path, bytes: encoded.length, revision: sha256(encoded), replacements: matches.length, encoding: decoded.encoding }
}

/** 按原编码 + 原 BOM 写回（只支持 UTF-8 / UTF-16 系）。 */
function encodeLike(text, encoding, bom) {
    if (encoding === 'utf16le') {
        const body = Buffer.from(text, 'utf16le')
        return bom?.encoding === 'utf16le' ? Buffer.concat([BOM_UTF16LE, body]) : body
    }
    if (encoding === 'utf16be') {
        const body = Buffer.from(text, 'utf16le').swap16()
        return bom?.encoding === 'utf16be' ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body
    }
    const body = Buffer.from(text, 'utf8')
    return bom?.encoding === 'utf8' ? Buffer.concat([BOM_UTF8, body]) : body
}

export function copyFileOp({ path, to, overwrite = false, createParents = true }) {
    if (to === null) return { ok: false, action: 'copy', path, message: 'copy 需要 to（目标路径）' }
    if (existsSync(to) && overwrite !== true) return { ok: false, action: 'copy', path, message: `目标已存在：${to}（要覆盖请带 overwrite:true）` }
    try {
        if (createParents !== false) mkdirSync(dirname(to), { recursive: true })
        copyFileSync(path, to, overwrite === true ? 0 : 1)
    }
    catch (error) {
        return { ok: false, action: 'copy', path, message: `复制失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, action: 'copy', path, to, bytes: statSync(to).size }
}

export function moveFileOp({ path, to, overwrite = false, createParents = true }) {
    if (to === null) return { ok: false, action: 'move', path, message: 'move 需要 to（目标路径）' }
    if (existsSync(to) && overwrite !== true) return { ok: false, action: 'move', path, message: `目标已存在：${to}（要覆盖请带 overwrite:true）` }
    if (createParents !== false) mkdirSync(dirname(to), { recursive: true })
    try {
        renameSync(path, to)
        return { ok: true, action: 'move', path, to, mode: 'rename' }
    }
    catch (error) {
        // 跨卷 rename 会失败（EXDEV/EPERM）⇒ 退化成 复制 + 删源，并明确回显。
        try {
            copyFileSync(path, to, overwrite === true ? 0 : 1)
            unlinkSync(path)
            return { ok: true, action: 'move', path, to, mode: 'copy+unlink', note: `rename 失败（${error instanceof Error ? error.message : String(error)}），已退化为复制后删源` }
        }
        catch (second) {
            return { ok: false, action: 'move', path, message: `移动失败：${second instanceof Error ? second.message : String(second)}` }
        }
    }
}

/** 拒绝明显危险的目标（盘根/家目录），其余由调用方负责。 */
function unsafeTarget(path) {
    const normalized = resolve(path)
    return /^[A-Za-z]:[\\/]?$/.test(normalized) || normalized === '/' || normalized === join(process.env.USERPROFILE ?? '\u0000')
}

export function removeFileOp({ path, recursive = false, confirm = false }) {
    let stats
    try {
        stats = statSync(path)
    }
    catch (error) {
        return { ok: false, action: 'remove', path, message: `不存在或不可读：${error instanceof Error ? error.message : String(error)}` }
    }
    if (unsafeTarget(path)) return { ok: false, action: 'remove', path, message: '拒绝删除盘根/家目录' }
    if (stats.isDirectory() && recursive !== true) {
        return { ok: false, action: 'remove', path, message: '是目录；要删目录请带 recursive:true' }
    }
    if (confirm !== true) {
        return { ok: true, action: 'remove', path, dryRun: true, wouldRemove: stats.isDirectory() ? 'directory (recursive)' : `${stats.size} B`, message: '预览（未删除）：确认要删请带 confirm:true' }
    }
    try {
        rmSync(path, { recursive: recursive === true, force: false })
    }
    catch (error) {
        return { ok: false, action: 'remove', path, message: `删除失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, action: 'remove', path, removed: stats.isDirectory() ? 'directory (recursive)' : `${stats.size} B` }
}

export function mkdirOp({ path, recursive = true }) {
    try {
        mkdirSync(path, { recursive: recursive !== false })
    }
    catch (error) {
        return { ok: false, action: 'mkdir', path, message: `建目录失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, action: 'mkdir', path }
}

export function statOp({ path }) {
    try {
        const stats = statSync(path)
        return {
            ok: true,
            action: 'stat',
            path,
            size: stats.size,
            mtime: stats.mtime.toISOString(),
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            revision: stats.isFile() ? currentRevision(path) : null,
        }
    }
    catch (error) {
        return { ok: false, action: 'stat', path, message: `不存在或不可读：${error instanceof Error ? error.message : String(error)}` }
    }
}

/**
 * 单文件的**字面**批量替换（语义照 ops_replace，但不绑定之前的读取：每次重新读、重新算）。
 *  - `dryRun` 默认 true：只报"会改几处、在哪几行"，不落盘；
 *  - 二进制跳过；GB18030 文件若真的命中则拒绝（无法按原编码写回，先转 UTF-8）；
 *  - 回执带写后 revision，便于下一步操作。
 */
export function replaceInFileOp({ path, pattern, replacement = '', dryRun = true, maxMatches = 20000 }) {
    if (typeof pattern !== 'string' || pattern === '') return { ok: false, action: 'replace', path, message: 'pattern 不能为空（字面文本，不是正则）' }
    let bytes
    try {
        bytes = readFileSync(path)
    }
    catch (error) {
        return { ok: false, action: 'replace', path, message: `读取失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (bytes.subarray(0, 8192).includes(0)) return { ok: true, action: 'replace', path, matches: 0, skipped: true, message: '二进制文件，跳过' }
    const bom = sniffBom(bytes)
    const decoded = decodeBuffer(bytes, 'auto')
    if (decoded.encoding === 'gb18030') {
        if (decoded.text.includes(pattern)) return { ok: false, action: 'replace', path, message: 'GB18030 文件命中，但无法按原编码写回；请先转成 UTF-8' }
        return { ok: true, action: 'replace', path, matches: 0, skipped: true, message: 'GB18030 文件（未命中）' }
    }

    const positions = []
    let from = 0
    let matches = 0
    while (matches < maxMatches) {
        const at = decoded.text.indexOf(pattern, from)
        if (at < 0) break
        matches += 1
        if (positions.length < 10) positions.push((decoded.text.slice(0, at).match(/\n/g) ?? []).length + 1)
        from = at + pattern.length
    }
    if (matches === 0) return { ok: true, action: 'replace', path, matches: 0 }
    const truncated = matches >= maxMatches

    if (dryRun !== false) {
        return { ok: true, action: 'replace', path, matches, dryRun: true, lines: positions, truncated }
    }
    const next = decoded.text.split(pattern).join(replacement)
    const encoded = encodeLike(next, decoded.encoding, bom)
    try {
        atomicWrite(path, encoded)
    }
    catch (error) {
        return { ok: false, action: 'replace', path, message: `写入失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, action: 'replace', path, matches, bytes: encoded.length, revision: sha256(encoded), lines: positions, truncated }
}

/** 把写操作的结果渲染成一行式文本（模型据此决定下一步）。 */export function renderOpResult(result) {
    const parts = [`action=${result.action}`, `ok=${result.ok === true}`, `path=${result.path}`]
    if (result.to) parts.push(`to=${result.to}`)
    if (result.dryRun === true) parts.push('dryRun=true')
    if (result.bytes !== undefined) parts.push(`${result.bytes} B`)
    if (result.lines !== undefined) parts.push(`${result.lines} 行`)
    if (result.replacements !== undefined) parts.push(`${result.replacements} 处替换`)
    if (result.revision) parts.push(`revision=${result.revision}`)
    if (result.mode) parts.push(`mode=${result.mode}`)
    if (result.wouldRemove) parts.push(`wouldRemove=${result.wouldRemove}`)
    if (result.removed) parts.push(`removed=${result.removed}`)
    const head = parts.join('  ')
    if (result.ok === true) return result.message ? `${head}\n${result.message}` : (result.note ? `${head}\n${result.note}` : head)
    return `${head}\n!! ${result.message ?? '失败'}`
}

export { asPath, isAbsolute, resolve }

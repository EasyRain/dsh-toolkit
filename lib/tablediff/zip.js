/**
 * lib/tablediff/zip.js —— **零依赖、只读**的 zip/jar 读取（新增，起因：MC 模组移植时
 * 要跟上游混淆 jar 的版本变化，而 `table_diff` 的其它适配器只吃文本格式）。
 *
 * 提供两件事（都只读，不改动任何文件）：
 *  1. `listZipEntries(jar)` —— 条目清单（path / size / crc32 / method / compressed），
 *     可直接喂给 `table_diff`：两个版本的 jar ⇒ added/removed/changed 条目一眼看清；
 *  2. `readZipEntry(jar, name)` —— 取出单个条目的**原始字节**（stored / deflate 都支持），
 *     于是 `table_diff {a:"old.jar#entry:assets/x/lang/en_us.json", b:"new.jar#entry:..."}`
 *     就能直接比 jar 里的语言文件/配方/配置。
 *
 * 只解析 **中央目录**（EOCD → CEN），因此不需要解压整包；`.class` 是二进制，会被标成 binary
 * 而不是硬塞进文本解析（要看类结构请用反编译工具或外部的 apdiff 类工具链）。
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0')

/** 该条目是否像二进制（按扩展名快速判定，避免把 .class/.png 当文本读） */
export function looksBinary(name) {
    return /\.(class|png|jpg|jpeg|ogg|wav|zip|jar|nbt|dat|bin|so|dll|dylib|ttf|otf|webp|exe)$/i.test(String(name))
}

function findEocd(buf) {
    // 从尾部往前扫（EOCD 之后只可能有 ≤64 KB 的注释）
    const min = Math.max(0, buf.length - 22 - 65536)
    for (let i = buf.length - 22; i >= min; i -= 1) {
        if (buf.readUInt32LE(i) === EOCD_SIG) return i
    }
    return -1
}

/** 小于这个大小就整包读（快路径）；更大的包只读"尾部 + 中央目录"区间（按用户建议加） */
export const WHOLE_READ_LIMIT = 64 * 1024 * 1024
/** 中央目录本身的上限（20 万条目的包大约几 MB；给足余量但不放任） */
export const MAX_CENTRAL_DIR_BYTES = 256 * 1024 * 1024

/** 从 fd 精确读一段（循环补齐短读） */
function readRange(fd, start, length) {
    const buf = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
        const n = readSync(fd, buf, filled, length - filled, start + filled)
        if (n <= 0) break
        filled += n
    }
    return filled === length ? buf : buf.subarray(0, filled)
}

/** 解析中央目录区间 → entries（两条读取路径共用） */
function parseCentralDirectory(buf, base, count, notes) {
    const entries = []
    let p = base
    for (let n = 0; n < count; n += 1) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break
        const flags = buf.readUInt16LE(p + 8)
        const method = buf.readUInt16LE(p + 10)
        const crc = buf.readUInt32LE(p + 16)
        const compSize = buf.readUInt32LE(p + 20)
        const size = buf.readUInt32LE(p + 24)
        const nameLen = buf.readUInt16LE(p + 28)
        const extraLen = buf.readUInt16LE(p + 30)
        const commentLen = buf.readUInt16LE(p + 32)
        const localOff = buf.readUInt32LE(p + 42)
        const rawName = buf.subarray(p + 46, p + 46 + nameLen)
        // bit 11 置位才是 UTF-8；否则按 CP437 处理（我们只在非 ASCII 时退化，中文名 jar 极少）
        const name = (flags & 0x800) !== 0 ? rawName.toString('utf8') : rawName.toString('latin1')
        if ((flags & 0x1) !== 0) notes.push(`有加密条目（${name}）`)
        entries.push({ path: name, size, compressed: compSize, crc32: hex8(crc), method, localOff, flags })
        p += 46 + nameLen + extraLen + commentLen
    }
    return entries
}

/**
 * 列条目。返回 `{ entries, stats }`；entries 为 `{ path, size, compressed, crc32, method }`。
 *
 * **按文件大小分档**（用户建议）：
 *  - ≤ {@link WHOLE_READ_LIMIT}（64 MB）⇒ 整包读进内存（最简单、最快，覆盖全部实际模组包）；
 *  - 更大 ⇒ 只读**尾部 64 KB**（找 EOCD）＋**中央目录那一段字节**，不碰条目内容 ⇒ GB 级包也不会吃内存。
 * @param {string} jar
 * @param {{wholeReadLimit?: number}} [opts] `wholeReadLimit: 0` 可强制走"大包"路径（自测用来比对两条路一致）
 */
export function listZipEntries(jar, opts = {}) {
    const limit = Number.isFinite(opts.wholeReadLimit) ? Number(opts.wholeReadLimit) : WHOLE_READ_LIMIT
    const st = statSync(jar)
    if (!st.isFile()) throw new Error(`${jar}: 不是文件`)
    if (st.size <= limit) {
        const buf = readFileSync(jar)
        const eocd = findEocd(buf)
        if (eocd < 0) throw new Error(`${jar}: 不是 zip/jar（找不到 EOCD 记录）`)
        return finish(listZipEntriesFrom(buf, findEocd(buf), jar), jar)
    }
    // ---- 大包：有界读取 -------------------------------------------------------
    const fd = openSync(jar, 'r')
    try {
        const tailLen = Math.min(st.size, 22 + 65536)
        const tail = readRange(fd, st.size - tailLen, tailLen)
        const eocd = findEocd(tail)
        if (eocd < 0) throw new Error(`${jar}: 不是 zip/jar（尾部 64 KB 里找不到 EOCD 记录）`)
        const count = tail.readUInt16LE(eocd + 10)
        const cdSize = tail.readUInt32LE(eocd + 12)
        const cdOffset = tail.readUInt32LE(eocd + 16)
        const notes = []
        notes.push(`大包（${(st.size / 1048576).toFixed(0)} MB > ${(limit / 1048576).toFixed(0)} MB）：只读了尾部与中央目录 ${(cdSize / 1024).toFixed(0)} KB，未读条目内容`)
        if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) notes.push('zip64：条目数/偏移/大小超出 32 位，可能只列出一部分')
        if (cdOffset === 0 || cdOffset + cdSize > st.size) throw new Error(`${jar}: 中央目录区间不合法（offset=${cdOffset} size=${cdSize} 文件=${st.size}）`)
        if (cdSize > MAX_CENTRAL_DIR_BYTES) throw new Error(`${jar}: 中央目录 ${(cdSize / 1048576).toFixed(0)} MB 超过上限 ${MAX_CENTRAL_DIR_BYTES / 1048576} MB（条目数过多；用 unzip -l 之类先过滤）`)
        const cd = readRange(fd, cdOffset, cdSize)
        const entries = parseCentralDirectory(cd, 0, count === 0 ? 0xffff : count, notes)
        return finish({ entries, notes }, jar)
    }
    finally {
        closeSync(fd)
    }
}

/** 整包路径：EOCD + 中央目录都在同一个 buffer 里 */
function listZipEntriesFrom(buf, eocd, jar) {
    let count = buf.readUInt16LE(eocd + 10)
    const cdOffset = buf.readUInt32LE(eocd + 16)
    const notes = []
    if (count === 0xffff || cdOffset === 0xffffffff) notes.push('zip64：条目数或目录偏移超出 32 位，可能只列出一部分')
    if (cdOffset === 0 || cdOffset >= buf.length) throw new Error(`${jar}: 中央目录偏移不合法（${cdOffset}）`)
    if (count === 0) count = 0xffff // 交给签名匹配兜底
    return { entries: parseCentralDirectory(buf, cdOffset, count, notes), notes }
}

/** 统一的收尾：统计 + stats */
function finish({ entries, notes }, jar) {
    if (entries.length === 0) throw new Error(`${jar}: 中央目录里没有条目`)
    const dirs = entries.filter((e) => e.path.endsWith('/')).length
    return {
        entries,
        stats: {
            format: 'zip',
            records: entries.length,
            skipped: 0,
            note: notes.length > 0 ? [...new Set(notes)].join('；') : null,
            source: jar,
            keyFields: ['path'],
            valueField: null,
            zipEntries: entries.length,
            zipDirs: dirs,
        },
    }
}

/** 单个条目的解压上限（回归探针加）：head 里的 size 是**声明值**、可能撒谎，
 *  所以既看声明值，也用 `maxOutputLength` 兜住真实解压量 —— 防止 zip 炸弹把小文件解成几个 GB。 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024

/** 取单个条目的原始字节；没有该条目返回 null。 */
export function readZipEntry(jar, want) {
    const { entries } = listZipEntries(jar)
    const e = entries.find((x) => x.path === want)
    if (e === undefined) return null
    if (e.size > MAX_ENTRY_BYTES) {
        throw new Error(`条目 ${want} 声明解压后 ${(e.size / 1048576).toFixed(1)} MB，超过单条目上限 ${MAX_ENTRY_BYTES / 1048576} MB —— 不读它（可看清单里的 size/crc32，或先解包到磁盘再比）`)
    }
 // **只读这个条目需要的字节**：不再把整个包读进内存 ⇒ 大包里取单个条目也是常数内存
    const fd = openSync(jar, 'r')
    let raw
    try {
        const head = readRange(fd, e.localOff, 30)
        if (head.length < 30) return null
        const nameLen = head.readUInt16LE(26)
        const extraLen = head.readUInt16LE(28)
        raw = readRange(fd, e.localOff + 30 + nameLen + extraLen, e.compressed)
    }
    finally {
        closeSync(fd)
    }
    if (e.method === 0) {
        if (raw.length > MAX_ENTRY_BYTES) throw new Error(`条目 ${want} 有 ${(raw.length / 1048576).toFixed(1)} MB，超过单条目上限 ${MAX_ENTRY_BYTES / 1048576} MB`)
        return raw
    }
    if (e.method === 8) {
        try {
            return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
        }
        catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            // 声明值与实际不符（zip 炸弹最常见的手法）时给可行动的信息，而不是裸的 zlib 报错
            throw new Error(`条目 ${want} 解压失败或超过上限（声明 ${(e.size / 1048576).toFixed(1)} MB，上限 ${MAX_ENTRY_BYTES / 1048576} MB）：${why}`)
        }
    }
    throw new Error(`${want}: 不支持的压缩方式 ${e.method}（只支持 stored/deflate）`)
}

/** 条目名 → 用于"当作文本解析"的目标格式（按扩展名；未知返回 null） */
export function formatOfEntry(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name))
    return m === null ? null : m[1].toLowerCase()
}

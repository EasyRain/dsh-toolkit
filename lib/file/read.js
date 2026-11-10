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
import { listZipEntries, readZipEntry } from '../tablediff/zip.js'

export const LIMITS = Object.freeze({
    maxBytes: 1024 * 1024,
    hardMaxBytes: 16 * 1024 * 1024,
    /** 一次调用里所有文件**合计**最多显示的字节（共享预算，避免 20 个文件各 1 MB）。 */
    totalBytes: 2 * 1024 * 1024,
    maxFiles: 20,
    maxRanges: 20,
    maxLines: 4000,
    /** .docx / .xlsx / .pptx 这类 OOXML 的提取上限（都不做完整渲染）。 */
    docSheets: 5,
    docRows: 500,
    docCells: 20000,
    docSlides: 100,
    /** 单行显示上限；超出的部分不显示，并标 truncatedInLine。 */
    maxLineChars: 2000,
    binaryProbe: 8192,
    hexPreviewBytes: 256,
})

const ENCODINGS = ['auto', 'utf8', 'utf16le', 'utf16be', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'euc-jp', 'windows-1251', 'iso-8859-1']

/**
 * 自动探测的候选：只放**能校验字节合法性**的多字节编码。
 * 单字节编码（windows-1251 / iso-8859-1）对任何字节都"合法"，放进自动探测只会制造噪声 ⇒ 只能显式指定。
 */
const AUTO_CANDIDATES = ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'euc-jp']

/**
 * 探测只读样本的前 N 字节（VS Code 也是 64 KB 上限：`AUTO_ENCODING_GUESS_MAX_BYTES = 512 * 128`）。
 *
 * 为什么要采样：以前对整份内容做 5 次严格解码 + 5 次逐字符打分，1 MB 非 UTF-8 文件要 ~80 ms，
 * 10 MB 级就是几百毫秒；而编码是**全局属性**，前 64 KB 足够判断。采样后整份只解码一次。
 */
const DETECT_SAMPLE_BYTES = 64 * 1024

/** 打分只看候选文本的前 N 个字符：脚本/常用字比例是统计属性，2000 字足够，再多只是白烧 CPU。 */
const SCORE_SAMPLE_CHARS = 2000

/** 8 KB 里出现 NUL 就当二进制（与 git 的判据同思路）。 */
export function looksBinary(buffer) {
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

const decoderLabel = {
    utf8: 'utf-8',
    utf16le: 'utf-16le',
    utf16be: 'utf-16be',
    gb18030: 'gb18030',
    big5: 'big5',
    shift_jis: 'shift_jis',
    'euc-kr': 'euc-kr',
    'euc-jp': 'euc-jp',
    'windows-1251': 'windows-1251',
    'iso-8859-1': 'iso-8859-1',
}

function decodeStrict(bytes, encoding) {
    return new TextDecoder(decoderLabel[encoding], { fatal: true }).decode(bytes)
}

/**
 * 常见字表：只用于**在多个候选都能严格解码时排序**，不参与"能不能解"的判定。
 *
 * 为什么需要：GB18030 的字节空间几乎覆盖所有双字节组合，Big5 / 日文 / 韩文常被它"成功"误解
 * （实测 Big5 的「中文測試」会解成「いゅ代刚」，且 replacements=0）。这里用"输出里常见汉字/标点的比例"
 * 加"脚本不匹配扣分"来给出一个可解释的偏好，并在分差很小时明确提示歧义。
 */
const COMMON_CHARS = new Set([...'的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被做必战先回则任取据处理世车技且信越收信改展深商求', ...'的一是在不了有和人這中大為上個國我以要他時來用們生到作地於出就分對成會可主發年動同工也能下過子說產種面而方後多定行學法所民得經十三之進著等部度家電力裡如水化高自二理起小物現實加量都兩體制機當使點從業本去把性好應開它合還因由其些然前外天政四日那社義事平形相全表間樣與關各重新線內數正心反你明看原又麼利比或但質氣第向道命此變條只沒結解問意建月公無系軍很情者最立代想已通並提直題程展五果料象員革位入常文總次品式活設及管特件長求老頭基資邊流路級少圖山統接知較將組見計別她手角期根論運農指幾九區強放決西被做必戰先回則任取據處理世車技', ...'，。！？、；：“”‘’（）《》【】…—·「」『』～', '0123456789'])

/** 文本对某个编码的"合理性"评分（越大越像）。 */
function plausibleScore(text, encoding) {
    let han = 0, hits = 0, kana = 0, hangul = 0, cyrillic = 0, junk = 0
    for (const ch of text) {
        const code = ch.codePointAt(0)
        if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) junk += 1
        else if (code >= 0x3040 && code <= 0x30ff) kana += 1
        else if (code >= 0xac00 && code <= 0xd7af) hangul += 1
        // 兼容用字母（ㄱㅏ…）：现代韩文正文几乎不用，它大量出现通常意味着"被当韩文误解了"。
        else if (code >= 0x3130 && code <= 0x318f) junk += 1
        else if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1
        else if (code >= 0x4e00 && code <= 0x9fff) { han += 1; if (COMMON_CHARS.has(ch)) hits += 1 }
        else if (code >= 0x3400 && code <= 0x4dbf) junk += 1          // 扩展 A：现代文本几乎不用
        else if (code >= 0xe000 && code <= 0xf8ff) junk += 1          // 私用区
        else if (code >= 0x3000 && code <= 0x303f) { /* CJK 标点：中性 */ }
        else if (code >= 0xff00 && code <= 0xffef) { /* 全角：中性 */ }
    }
    const japanese = encoding === 'shift_jis' || encoding === 'euc-jp'
    const korean = encoding === 'euc-kr'
    const total = Math.max(1, han + kana + hangul + cyrillic + junk)
    // 该编码"本来就会产生"的字符算熟悉度；不该出现的（例如 Big5 解出假名）算不匹配。
    const familiar = (hits * 2 + han + (japanese ? kana * 2 : 0) + (korean ? hangul * 2 : 0)) / (total * 2)
    const mismatch = (japanese ? 0 : kana / total) + (korean ? 0 : hangul / total) + junk / total
    return familiar - mismatch
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
        if (!(requested in decoderLabel)) throw new Error(`不支持的 encoding：${JSON.stringify(requested)}；可用：auto, ${Object.keys(decoderLabel).join(', ')}`)
        // 显式指定优先严格解码：能严格解开就说明"这段字节确实合法"，比有损更可信。
        try {
            return { text: decodeStrict(body, requested), encoding: requested, reason: bom ? 'BOM + 显式指定' : '显式指定', replacements: 0 }
        }
        catch {
            const text = decodeLossy(body, requested)
            return { text, encoding: requested, reason: '显式指定（有非法字节，已用替换字符）', replacements: (text.match(/\uFFFD/g) ?? []).length }
        }
    }
    if (bom) return { text: decodeLossy(body, bom.encoding), encoding: bom.encoding, reason: 'BOM', replacements: 0 }
    try {
        return { text: decodeStrict(body, 'utf8'), encoding: 'utf8', reason: '严格 UTF-8 通过', replacements: 0 }
    }
    catch { /* 非 UTF-8：进多候选 */ }

    // 多候选：GB18030 的字节空间几乎覆盖所有双字节组合，Big5/日文/韩文常被它"成功"误解 ⇒
    // 不能只试第一个，要把所有能解开的候选都列出来；多个都能解时明确提示歧义。
    //
    // 只看样本（前 64 KB）。样本末尾可能把某个多字节字符切成半个 ⇒ 用宽松解码，然后按
    // "替换字符占比" 判断这个编码是否真的合法（截断最多产生 1–2 个替换字符，不影响判断）。
    const sample = body.length > DETECT_SAMPLE_BYTES ? body.subarray(0, DETECT_SAMPLE_BYTES) : body
    const usable = []
    for (const candidate of AUTO_CANDIDATES) {
        const text = decodeLossy(sample, candidate)
        const bad = (text.match(/\uFFFD/g) ?? []).length
        const chars = text.length || 1
        if (bad / chars > 0.005) continue          // 超过 0.5% 非法 ⇒ 这不是该编码
        usable.push({ encoding: candidate, text })
    }
    if (usable.length > 0) {
        const scored = usable.map((item) => ({ ...item, score: plausibleScore(item.text.slice(0, SCORE_SAMPLE_CHARS), item.encoding) }))
            .sort((a, b) => b.score - a.score)
        const [chosen, runnerUp] = scored
        // 分差很小时不装懂：用第一个（GB18030 对中文仍是默认）并把候选列出来。
        // 候选难分（分差小），或"最好的也说不通"（例如把单字节西里尔文当 GB18030）⇒ 都要提示。
        const ambiguous = chosen.score < 0.3 || (runnerUp !== undefined && chosen.score - runnerUp.score < 0.1)
        const reason = ambiguous
            ? `非 UTF-8；候选 ${scored.map((item) => item.encoding).join(' / ')} 都能严格解开且难以区分，暂按 ${chosen.encoding}（内容不对请显式指定 encoding）`
            : `非 UTF-8，${chosen.encoding} 严格通过`
        let text = chosen.text
        let replacements = 0
        if (body.length > DETECT_SAMPLE_BYTES) {
            try { text = decodeStrict(body, chosen.encoding) }
            catch {
                text = decodeLossy(body, chosen.encoding)
                replacements = (text.match(/\uFFFD/g) ?? []).length
            }
        }
        return {
            text,
            encoding: chosen.encoding,
            reason: replacements > 0 ? `${reason}（样本之外有非法字节，已用替换字符）` : reason,
            replacements,
            ...(ambiguous ? { ambiguous: true } : {}),
            candidates: scored.map((item) => item.encoding),
        }
    }
    const text = decodeLossy(body, 'utf8')
    return { text, encoding: 'utf8', reason: '无法严格解码（UTF-8 与各 CJK 候选均失败），有损显示', replacements: (text.match(/\uFFFD/g) ?? []).length }
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

/** 把 `allLines` 按 ranges / 行数上限切成要显示的行，并算出"行内截断"与最后一行的行号。 */
function selectLines(allLines, ranges) {
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
    return { selected, truncatedInLine, lastShown }
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXmlText(text) {
    return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (all, entity) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const code = Number.parseInt(entity.slice(2), 16)
            return Number.isFinite(code) ? String.fromCodePoint(code) : all
        }
        if (entity.startsWith('#')) {
            const code = Number.parseInt(entity.slice(1), 10)
            return Number.isFinite(code) ? String.fromCodePoint(code) : all
        }
        return XML_ENTITIES[entity] ?? all
    })
}

/**
 * .docx 是 zip + OOXML：只取 `word/document.xml`，把 `<w:p>` 段落按行还原、`<w:t>` 取文本、
 * `<w:tab/>`/`<w:br/>` 还原成制表/换行。**不是**完整渲染（不处理样式/表格结构/页眉页脚/图片），
 * 但足够"把合同/文档的正文读给模型看"。
 */
export function docxText(filePath) {
    const entry = readZipEntry(filePath, 'word/document.xml')
    if (entry === null) throw new Error('不是有效的 .docx（压缩包里没有 word/document.xml）')
    const xml = entry.toString('utf8')
    const lines = []
    // 按段落切；第一个 `<w:p>` 之前的内容忽略（通常是文档属性）
    for (const paragraph of xml.split(/<w:p[\s>]/).slice(1)) {
        const pieces = []
        const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g
        let match
        while ((match = token.exec(paragraph)) !== null) {
            if (match[1] !== undefined) pieces.push(decodeXmlText(match[1]))
            else if (match[0].startsWith('<w:tab')) pieces.push('\t')
            else pieces.push('\n')
        }
        lines.push(pieces.join(''))
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** OOXML 提取结果的统一形状：与文本读共用同一套截断/续读语义。 */
function documentResult({ filePath, text, encoding, reason, ranges, revision, meta }) {
    const allLines = text.split('\n')
    meta.lines = allLines.length
    const { selected, truncatedInLine, lastShown } = selectLines(allLines, ranges)
    const complete = lastShown >= allLines.length
    return {
        ok: true,
        path: filePath,
        encoding,
        encodingReason: reason,
        replacements: 0,
        stat: meta,
        lines: selected,
        truncated: false,
        truncatedInLine,
        complete,
        nextOffset: complete ? undefined : lastShown + 1,
        revision,
    }
}

/**
 * .xlsx：zip + OOXML。读 `xl/sharedStrings.xml` + 每个工作表的 `<row>/<c>`，输出
 * `[Sheet: 名称]` 后每行 `行号: A1=值  B1=值`。**不计算公式**（只给缓存值），不保留样式/合并单元格。
 */
export function xlsxText(filePath) {
    const names = new Set(listZipEntries(filePath).entries.map((entry) => entry.path))
    const readEntry = (name) => (names.has(name) ? (readZipEntry(filePath, name)?.toString('utf8') ?? null) : null)
    const shared = (() => {
        const xml = readEntry('xl/sharedStrings.xml')
        if (xml === null) return []
        return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlText(m[1])).join(''))
    })()
    const rels = new Map()
    for (const match of (readEntry('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /Id="([^"]+)"/.exec(match[0])?.[1]
        const target = /Target="([^"]+)"/.exec(match[0])?.[1]
        if (id !== undefined && target !== undefined) rels.set(id, target.replace(/^\/+/, '').replace(/^xl\//i, ''))
    }
    const sheets = [...(readEntry('xl/workbook.xml') ?? '').matchAll(/<sheet\b[^>]*>/g)].map((match) => {
        const name = /name="([^"]*)"/.exec(match[0])?.[1] ?? 'Sheet'
        const rid = /r:id="([^"]+)"/.exec(match[0])?.[1]
        return { name: decodeXmlText(name), target: rid === undefined ? undefined : rels.get(rid) }
    }).filter((sheet) => typeof sheet.target === 'string')

    const lines = []
    let rows = 0
    let truncated = false
    for (const sheet of sheets.slice(0, LIMITS.docSheets)) {
        const xml = readEntry(`xl/${sheet.target}`)
        if (xml === null) continue
        lines.push(`[Sheet: ${sheet.name}]`)
        for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
            if (rows >= LIMITS.docRows) { truncated = true; break }
            rows += 1
            const rowNumber = /r="(\d+)"/.exec(rowMatch[1])?.[1] ?? String(rows)
            const cells = []
            for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
                const ref = /r="([A-Z]+\d+)"/.exec(cellMatch[1])?.[1]
                const type = /t="([^"]+)"/.exec(cellMatch[1])?.[1]
                let value = ''
                if (type === 's') {
                    const index = Number(/<v>([\s\S]*?)<\/v>/.exec(cellMatch[2])?.[1])
                    value = shared[index] ?? ''
                }
                else if (type === 'inlineStr') {
                    value = [...cellMatch[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlText(m[1])).join('')
                }
                else {
                    value = decodeXmlText(/<v>([\s\S]*?)<\/v>/.exec(cellMatch[2])?.[1] ?? '')
                }
                if (value !== '') cells.push(ref === undefined ? value : `${ref}=${value}`)
            }
            if (cells.length > 0) lines.push(`${rowNumber}: ${cells.join('  ')}`)
        }
        if (truncated) break
    }
    if (lines.length === 0) throw new Error('没有可提取的单元格文本')
    if (truncated) lines.push(`…（达到 ${LIMITS.docRows} 行上限，已截断；完整表格请用 Python/openpyxl）`)
    return lines.join('\n')
}

/** .pptx：按 `ppt/slides/slideN.xml` 顺序提取 `<a:t>` 文本；不渲染版式/备注/图片。 */
export function pptxText(filePath) {
    const slides = listZipEntries(filePath).entries
        .map((entry) => entry.path)
        .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
        .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)[1]) - Number(/(\d+)\.xml$/i.exec(b)[1]))
    if (slides.length === 0) throw new Error('不是有效的 .pptx（没有 ppt/slides/slideN.xml）')
    const lines = []
    for (const slide of slides.slice(0, LIMITS.docSlides)) {
        const index = Number(/(\d+)\.xml$/i.exec(slide)[1])
        const xml = readZipEntry(filePath, slide)?.toString('utf8') ?? ''
        const texts = [...xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXmlText(match[1]))
        lines.push(`[slide ${index}]`)
        lines.push(...texts)
    }
    if (slides.length > LIMITS.docSlides) lines.push(`…（只列了前 ${LIMITS.docSlides} 页）`)
    return lines.join('\n')
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

    if (/\.pdf$/i.test(filePath)) {
        return { ok: false, path: filePath, error: 'PDF 是二进制格式，本工具不解析它；请用 office 技能（LibreOffice/Python 转文本），或先导出成 txt/docx 再读' }
    }
    const docKind = /\.docx$/i.test(filePath) ? 'docx' : (/\.xlsx$/i.test(filePath) ? 'xlsx' : (/\.pptx$/i.test(filePath) ? 'pptx' : null))
    if (docKind !== null) {
        const extract = docKind === 'docx' ? docxText : (docKind === 'xlsx' ? xlsxText : pptxText)
        const reason = docKind === 'docx'
            ? 'Word 文档（提取段落文本，非完整渲染）'
            : (docKind === 'xlsx' ? 'Excel 工作簿（按工作表/行提取，非完整渲染）' : 'PowerPoint（提取幻灯片文本，非完整渲染）')
        try {
            return documentResult({ filePath, text: extract(filePath), encoding: docKind, reason, ranges, revision, meta })
        }
        catch (error) {
            return { ok: false, path: filePath, error: `读取 ${docKind} 失败：${error instanceof Error ? error.message : String(error)}` }
        }
    }

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
    // 换行按编辑器语义切：CRLF / LF / 孤立 CR 都算换行（否则 CR-only 文件会显示成一行）。
    const allLines = decoded.text.split(/\r\n|\r|\n/)
    // 末尾换行会多切出一个空串：只在它是"文件以换行结尾"时去掉，避免把真实空行也吞掉。
    if (allLines.length > 0 && allLines[allLines.length - 1] === '' && /(?:\r\n|\r|\n)$/.test(decoded.text)) allLines.pop()
    meta.lines = allLines.length

    const { selected, truncatedInLine, lastShown } = selectLines(allLines, ranges)
    // complete 只回答"这段视图是否已经到文件末尾"；**行内截断是另一个事实**（truncatedInLine），
    // 两者不能混 —— 否则"读到末行但某行太长"会被误报成"还有下一页"。
    const complete = truncated !== true && lastShown >= allLines.length
    return {
        ok: true,
        path: filePath,
        encoding: decoded.encoding,
        encodingReason: decoded.reason,
        ...(decoded.ambiguous === true ? { encodingAmbiguous: true, encodingCandidates: decoded.candidates } : {}),
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
            result.encodingAmbiguous === true ? `⚠ 编码可能不是 ${result.encoding}（也能被 ${result.encodingCandidates.filter((item) => item !== result.encoding).join(' / ')} 解开）；内容不对就显式传 encoding` : null,
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

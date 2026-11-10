/**
 * lib/session —— DSH 会话日志工具箱（纯 node，无第三方依赖）
 *
 * 会话日志 `~/.dsh/sessions/<slug>/<session-id>/session.v4.jsonl.zstd` 是**多帧独立 zstd**
 * （append-only WAL 风格）：Node 的 `zstdDecompressSync(buf)` 只解第一帧，所以这里按魔数
 * `28 B5 2F FD` 扫描帧起点，逐帧 `zstdDecompressSync(buf.subarray(off))` 后拼接（解码器
 * 会在本帧结束处停下，所以"从帧头解到文件尾"是安全的）。
 *
 * 工具：
 *   session_list    列出会话（可按工作目录过滤）
 *   session_peek    看某个会话最后 N 条事件的摘要
 *   session_grep    在会话里按正则搜索事件文本
 *   session_diff    两个会话的事件级 diff（这是"会话 diff"的正式手段，替代临时脚本）
 *   session_export  导出为 .jsonl 或 .md
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { assertWritableTargets } from '../guard.js'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function sessionsRoot() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'sessions')
}

/**
 * `D:\work\my-project` -> `--D-work-my-project--`
 *
 * ⚠️ 宿主不是简单的"非字母数字 → `-`"：**空格与逗号等按 `~XXXX` 转义**（4 位十六进代码单元），
 * 只有 `: \ / * ? " < > |` 这类在 Windows 文件名里非法的字符才折叠成 `-`。实测：
 *   `C:\Program Files\nodejs`                -> `--C-Program~0020Files-nodejs--`
 *   `D:\work\My Game, v2`                    -> `--D-work-My~0020Game~002C~0020v2--`
 * 旧实现把空格也折成 `-` ⇒ **含空格的工作区永远找不到自己的会话**（`cwd=`/`last` 静默退化成全局最新，
 * 还会打印一句假的"按调用方工作区解析" —— 子代理审计实测）。
 */
const ILLEGAL_IN_FILENAME = new Set([':', '\\', '/', '*', '?', '"', '<', '>', '|'])
export function slugOf(cwd) {
    let out = ''
    for (const ch of String(cwd)) {
        if (/[A-Za-z0-9]/.test(ch)) { out += ch; continue }
        if (ILLEGAL_IN_FILENAME.has(ch)) {
            if (!out.endsWith('-')) out += '-' // 连续非法字符折叠成一个 '-'
            continue
        }
        out += `~${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    }
    return `--${out.replace(/^-+|-+$/g, '')}--`
}

/** 逐帧解码；返回 { text, frames, bad, bytes } */
export function decodeSessionFile(file, { maxBytes = 32 * 1024 * 1024 } = {}) {
    const buf = readFileSync(file)
    const offsets = frameOffsets(buf)
    if (offsets.length === 0) return { text: '', frames: 0, bad: 0, falsePositives: frameOffsets.lastFalsePositives ?? 0, bytes: buf.length }
    // 全解成本 = 解压后全文；大文件请用 scanEvents（逐帧）或 decodeSessionTail，不要整份拿。
    if (buf.length > maxBytes) throw new Error(`会话日志 ${(buf.length / 1048576).toFixed(1)} MB 超过全量解码上限 ${(maxBytes / 1048576).toFixed(0)} MB：请改用 session_read（pattern / tail）或 session_export（逐帧流式）`)
    const parts = []
    let bad = 0
    let i = 0
    while (i < offsets.length) {
        const one = decodeOneFrame(buf, offsets, i)
        if (one === null) { bad += 1; i += 1; continue }
        parts.push(one.text)
        i = one.next
    }
    return { text: parts.join(''), frames: offsets.length, bad, falsePositives: frameOffsets.lastFalsePositives ?? 0, bytes: buf.length }
}

/** 超过这个大小的日志走"尾读/流式"路径（实测 39.7 MB 日志全解码要 3.2 s / RSS 508 MB） */
const STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024

/**
 * 扫描帧偏移（只做 indexOf，不解压）。
 * **校验帧头结构**（审计 B-L15）：zstd 帧头描述符的第 3 位是保留位、必须为 0，而解压后的载荷里
 * 完全可能碰巧出现 28 B5 2F FD ⇒ 以前会把它当帧起点、解压失败后计一次"坏帧"（误报）。
 * 现在只接受结构合法的候选，结构不合法的算"载荷内假魔数"（不计入 bad）。
 */
function frameOffsets(buf) {
    const offsets = []
    let i = 0
    let falsePositives = 0
    while (true) {
        const k = buf.indexOf(MAGIC, i)
        if (k < 0) break
        const fhd = buf[k + 4]
        if (fhd === undefined || (fhd & 0x08) !== 0) { falsePositives += 1; i = k + 4; continue }
        offsets.push(k)
        i = k + 4
    }
    frameOffsets.lastFalsePositives = falsePositives
    return offsets
}

/**
 * **尾读**：只解最后若干帧，取末尾 maxLines 行事件（审计 M13）。
 * 用途：`session_peek` 只看最后几条，没必要把 15 万帧全解一遍。
 */
/**
 * **有界解压**：单帧解出来超过 `MAX_FRAME_BYTES` 就抛错，而不是按帧头声明的大小去分配。
 * 为什么必须加（实测事故）：帧扫描靠魔数 + 一个保留位判断，载荷里碰巧凑出 28 B5 2F FD 时仍可能被当成帧起点，
 * 于是 `zstdDecompressSync(buf.subarray(off))` 会去解一段垃圾；如果这段垃圾恰好声明了巨大的内容长度，
 * 进程会一次性申请巨量内存 —— 本机实测能把 64 GB 吃满、把宿主拖崩（不是"慢"，是 OOM）。
 * `maxOutputLength` 让这类输入变成一次普通的解码失败（计入 bad 帧），不再有放大效应。
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024
export function decompressFrame(buf, off, maxOutputLength = MAX_FRAME_BYTES) {
    return zlib.zstdDecompressSync(buf.subarray(off), { maxOutputLength })
}

/**
 * 解**单个帧**：帧 k 的压缩字节是 buf[off_k, off_{k+1})（最后一帧到文件尾）。
 * 为什么不能 `buf.subarray(off)`：Node 26 的 zstd 会从该偏移**一直解到缓冲区末尾**（多帧连续解码），
 * 逐偏移调用会把后面每一帧重复解一遍 ⇒ O(n²) 内存/时间（44 MB 会话实测吃满 64 GB 提交内存）。
 * 载荷里的假魔数会把真帧切断 ⇒ 解不开就把边界往后扩一帧再试（最多扩 4 次）。
 * @returns {{text: string, next: number} | null} next = 下一帧的偏移下标
 */
export function decodeOneFrame(buf, offsets, index, maxOutputLength = MAX_FRAME_BYTES) {
    for (let merge = 0; merge <= 4 && index + merge < offsets.length; merge += 1) {
        const from = offsets[index]
        const boundary = index + merge + 1
        const to = boundary < offsets.length ? offsets[boundary] : buf.length
        try {
            const text = zlib.zstdDecompressSync(buf.subarray(from, to), { maxOutputLength }).toString('utf8')
            return { text, next: boundary }
        }
        catch { /* 被假魔数切断：扩一帧再试 */ }
    }
    return null
}

export function decodeSessionTail(file, maxLines = 40) {
    const buf = readFileSync(file)
    const offsets = frameOffsets(buf)
    if (offsets.length === 0) return { lines: [], frames: 0, decodedFrames: 0, bad: 0, bytes: buf.length }
    const want = Math.max(1, Math.trunc(maxLines))
    // 从最后一帧往回逐帧解（每帧一次、内存有界），攒够行数就停
    let lines = []
    let bad = 0
    let decodedFrames = 0
    for (let i = offsets.length - 1; i >= 0 && lines.length < want; i -= 1) {
        const one = decodeOneFrame(buf, offsets, i)
        if (one === null) { bad += 1; continue }
        decodedFrames += 1
        const part = one.text.split('\n').filter((l) => l.trim() !== '')
        lines = part.concat(lines)
    }
    return { lines: lines.slice(-want), frames: offsets.length, decodedFrames, bad, bytes: buf.length }
}

/**
 * **流式逐事件扫描**（grep 用）：按帧解码 → 解析 → 回调 → 丢弃。
 * 不再把整份日志拼成一个巨型字符串并保留全部事件对象（那是 508 MB~1.1 GB RSS 的来源）。
 * @param {(ev:object, index:number)=>void} cb index 为事件序号（1-based，跨帧连续）
 */
export function scanEvents(file, cb) {
    const buf = readFileSync(file)
    const offsets = frameOffsets(buf)
    let bad = 0
    let badLines = 0
    let index = 0
    let i = 0
    while (i < offsets.length) {
        const one = decodeOneFrame(buf, offsets, i)
        if (one === null) { bad += 1; i += 1; continue }
        for (const line of one.text.split('\n')) {
            const t = line.trim()
            if (t === '') continue
            let ev
            try { ev = JSON.parse(t) }
            catch { badLines += 1; continue }
            index += 1
            cb(ev, index)
        }
        i = one.next
    }
    return { frames: offsets.length, bad, badLines, bytes: buf.length, events: index }
}

function listSessionDirs() {
    const root = sessionsRoot()
    if (!existsSync(root)) return []
    const out = []
    for (const slug of readdirSync(root)) {
        const slugDir = join(root, slug)
        let entries = []
        try {
            entries = readdirSync(slugDir, { withFileTypes: true })
        }
        catch { continue }
        for (const e of entries) {
            if (!e.isDirectory()) continue
            const dir = join(slugDir, e.name)
            let files = []
            try {
                files = readdirSync(dir).filter((f) => f.startsWith('session') && f.endsWith('.jsonl.zstd'))
            }
            catch { continue }
            for (const f of files) {
                const full = join(dir, f)
                const st = statSync(full)
                out.push({ slug, id: e.name, file: full, bytes: st.size, mtime: st.mtimeMs })
            }
        }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
}

/** 解析 `last` / 完整 id / id 前缀 / 文件名；可选 cwd 限定 slug */
function resolveSession(spec, cwd) {
    const all = listSessionDirs()
    if (all.length === 0) throw new Error(`no session logs under ${sessionsRoot()}`)
    const explicit = !(spec === undefined || spec === null || spec === '' || spec === 'last')
    let scoped = null
    let slugWanted = null
 // ⚠️ **显式给了 id/前缀时不受 cwd 限定**：既然说了要读哪个会话，就没必要再按工作区收窄；
    // 旧实现会先撞上"该工作区没有会话日志"直接抛错 —— 而那句错误信息恰恰叫人"显式给 session id"，自相矛盾
    // （别人拿显式 id 跨工作区读时会莫名失败）。`last` 仍然严格按 cwd 作用域解析。
    if (cwd && !explicit) {
        slugWanted = slugOf(cwd)
        scoped = all.filter((s) => s.slug === slugWanted)
        if (scoped.length === 0) {
            // 兜底：宿主对特殊字符的转义规则可能还有我们没覆盖的；用日志头帧里的 cwd 做**真值比对**
            const real = all.filter((s) => cwdOfSessionHead(s) === cwd)
            if (real.length > 0) { scoped = real; slugWanted = real[0].slug }
        }
        // ⚠️ **不再静默回退全局最新**：以前 scoped 为空就用 all，还会打印"按调用方工作区解析"的假声明
 // （子代理审计实测：不存在的工作区也会"成功"返回别人的会话）。
        if (scoped.length === 0) {
            throw new Error(`该工作区没有会话日志：${cwd}（slug=${slugWanted}；全库 ${all.length} 个文件）。显式给 session id，或不传 cwd 用全局最新`)
        }
    }
    const pool = scoped ?? all
    if (!explicit) return pool[0]
    // 也接受**裸 uuid**（`session_list` 打印的是 `session-<uuid>`，用户/agent 常常只带 uuid 那截）
    const alias = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(spec)) ? `session-${spec}` : null
    const hits = pool.filter((s) => s.id === spec || s.id.startsWith(spec) || s.file === spec || (alias !== null && s.id === alias))
    if (hits.length === 0) throw new Error(`no session matching "${spec}" (${pool.length} under this cwd, ${all.length} total)`)
    // 前缀歧义：**报错列候选**（与 checkpoint 的 id 策略一致；以前静默取 mtime 最新的那个）
    const ids = [...new Set(hits.map((s) => s.id))]
    if (ids.length > 1) throw new Error(`"${spec}" 匹配到 ${ids.length} 个会话，请给更长的前缀：${ids.slice(0, 5).join(', ')}`)
    return hits[0]
}

/** 读会话日志头帧里的 cwd（用于按工作区精确匹配；读不到返回 null） */
export function cwdOfSessionHead(s) {
    try {
        const buf = readFileSync(s.file)
        const off = buf.indexOf(MAGIC)
        if (off < 0) return null
        const first = zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8').split('\n')[0]
        const header = JSON.parse(first)
        return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : null
    }
    catch { return null }
}

/**
 * 当前会话的工作目录 —— 从会话日志**头一帧**里的 `cwd` 读出来（v4 头：{type,version,id,createdAt,cwd,...}）。
 * 宿主插件进程的 process.cwd() 是 profile 目录，不能当工作区用；优先取 DSH_SESSION_ID 指向的那个会话。
 * ⚠️ 指定了 DSH_SESSION_ID 但**找不到**时返回 null（以前 `?? all[0]` 会返回**别的工作区**的 cwd，
 * 让调用方以为自己在对的工作区里 —— 子代理审计实测）。
 */
export function currentWorkspaceCwd() {
    const wanted = process.env.DSH_SESSION_ID
    const all = listSessionDirs()
    const pick = wanted ? all.find((s) => s.id === wanted) : all[0]
    if (!pick) return null
    return cwdOfSessionHead(pick)
}

/** 给 checkpoint 模块用：解析某个工作目录当前（最新）的会话日志文件 */
export function resolveSessionFile(spec = 'last', cwd = undefined) {
    const s = resolveSession(spec, cwd)
    return { id: s.id, file: s.file, bytes: s.bytes, mtime: s.mtime, slug: s.slug }
}

function readEvents(file) {
    const { text, frames, bad, bytes } = decodeSessionFile(file)
    const events = []
    let badLines = 0
    for (const line of text.split('\n')) {
        const t = line.trim()
        if (t === '') continue
        try {
            events.push(JSON.parse(t))
        }
        catch {
            // 半行/坏行：**必须计数并外显**。以前直接跳过 ⇒ 一行坏行会与下一条完整事件粘在一起被双双丢掉，
 // 而工具只报"坏帧 0"，用户以为日志完整（子代理审计实测）。
            badLines += 1
        }
    }
    return { events, frames, bad, badLines, bytes }
}

/** 把解码结果里的异常情况说清楚（空文件 / 非 zstd 日志 / 坏帧 / 坏行 / 非法 UTF-8） */
export function decodeNotes({ frames, bad, badLines, bytes, text }) {
    const notes = []
    if (frames === 0) notes.push(bytes === 0 ? '⚠ 文件是空的（0 字节）' : '⚠ 没有解出任何 zstd 帧：这不是会话日志，或文件已损坏')
    if (bad > 0) notes.push(`⚠ 有 ${bad} 帧解码失败（内容可能不完整；日志被并发写入时会出现）`)
    if (badLines > 0) notes.push(`⚠ 有 ${badLines} 行无法解析（可能是半行，也可能连带丢失了紧随其后的一条事件）`)
    if (typeof text === 'string' && text.includes('\uFFFD')) notes.push('⚠ 解码后出现替换符 U+FFFD：日志里有非 UTF-8 字节，该处文本不可靠')
    return notes
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 目标目录：不存在就**自动创建**（友好）；存在但不是目录（例如同名文件）⇒ 明确报错。
 * 审计修正：旧注释写"直接报错"，代码却是 `mkdirSync`，而工具描述写"directory must exist" —— 三者互相矛盾。 */
function ensureDirOrThrow(dir) {
    if (existsSync(dir)) {
        if (!statSync(dir).isDirectory()) throw new Error(`路径的上级不是目录：${dir}`)
        return
    }
    mkdirSync(dir, { recursive: true })
}

/**
 * 灾难性回溯（ReDoS）粗筛：命中就拒绝执行。
 * JS 正则无法中途打断，`(a+)+$` 这种嵌套量词在 200 个字符上就能跑到 2^200 步 ——
 * 实测让 `session_grep` **永久挂死**（300 s 未返回、宿主卡住，子代理审计）。
 * 这里只做保守识别（宁可偶尔误拒，也不挂死），并给出改写方向。
 */
export function catastrophicHint(pattern) {
    const p = String(pattern)
    const nested = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(p)
    if (nested) return '括号内的量词外面又套了量词（如 (a+)+）'
    const altRepeat = /\((?:\s*[^()|]\s*\|)+\s*[^()|]\s*\)\s*[+*]/.test(p) && /[+*]/.test(p)
    if (altRepeat) return '重复的分支选择后又整体重复（如 (a|a)+）'
    if (/(\.\*){2,}/.test(p)) return '连续的通配重复（如 .*.*）'
    if (/\\[1-9]/.test(p)) return '反向引用（回溯代价高）'
    return null
}

/** 事件载荷：v4 日志把内容放在 `data` 里（老形状可能是 message/payload 或事件本身） */
export function payloadOf(ev) {
    return ev?.data ?? ev?.message ?? ev?.payload ?? ev ?? {}
}

const hhmmss = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : '')

/** 把一条事件压成一行：时间/类型/轮步/角色/工具/文本预览 */
export function summarizeEvent(ev, width = 160) {
    const p = payloadOf(ev)
    const type = ev?.type ?? '?'
    const parts = [hhmmss(ev?.time), type]
    if (ev?.seq !== undefined) parts.push(`seq=${ev.seq}`)
    if (p.turn !== undefined || p.step !== undefined) parts.push(`t${p.turn ?? '?'}.${p.step ?? '?'}`)
    const role = p.role ?? p.message?.role
    if (role) parts.push(String(role))
    const tool = p.name ?? p.toolName ?? p.tool
    if (tool) parts.push(`tool=${tool}`)
    if (type === 'tool/result') parts.push(p.ok === false ? 'ok=false' : 'ok=true')
    const inner = p.message ?? p
    const text = textOf(inner) || (typeof p.arguments === 'string' ? p.arguments : '')
    if (text) parts.push(clip(String(text).replace(/\s+/g, ' '), width))
    return parts.filter(Boolean).join(' ')
}

/** 抽取事件里的人可读文本（尽力而为，覆盖常见形状 —— 含**流式分片**事件） */
export function textOf(payload, depth = 0) {
    if (payload === null || payload === undefined || depth > 4) return ''
    if (typeof payload === 'string') return payload
    if (Array.isArray(payload)) return payload.map((x) => textOf(x, depth + 1)).filter(Boolean).join(' ')
    if (typeof payload !== 'object') return ''
    // ⚠️ 必须包含流式分片的键：真实日志里 `reasoning-chunks` / `text-chunks` 的正文在 `texts[]` 里，
    // 旧键表没有它 ⇒ 169,870 个事件里 **70.9% 的内容对 grep/peek 完全不可见**（静默假阴性，
 // 导出成 jsonl 后用 rg 却能搜到 —— 子代理审计实测）。
    const keys = [
        'text', 'texts', 'chunks', 'delta', 'parts', 'items', 'lines', 'body', 'markdown',
        'content', 'message', 'summary', 'title', 'input', 'output', 'result', 'args', 'note', 'description', 'value', 'values',
    ]
    const out = []
    for (const k of keys)
        if (payload[k] !== undefined) out.push(textOf(payload[k], depth + 1))
    return out.filter(Boolean).join(' ')
}

/**
 * 深度取文本：**遍历所有字符串值**（grep 用）。
 * 与 `textOf` 的差别：不依赖键表，所以未知形状的流式事件也不会漏；
 * 但会带上 role/name 之类的短标识，所以这里过滤掉看着像 id/哈希/枚举的值。
 */
export function deepTextOf(payload, depth = 0) {
    if (payload === null || payload === undefined || depth > 6) return ''
    if (typeof payload === 'string') {
        const s = payload
        if (s.length < 3) return ''
        if (/^[0-9a-fA-F]{16,}$/.test(s)) return ''         // 长十六进制（id/哈希）
        if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s)) return '' // uuid
        if (/^(true|false|null|undefined)$/.test(s)) return ''
        return s
    }
    if (Array.isArray(payload)) return payload.map((x) => deepTextOf(x, depth + 1)).filter(Boolean).join(' ')
    if (typeof payload !== 'object') return ''
    const out = []
    for (const v of Object.values(payload)) {
        const t = deepTextOf(v, depth + 1)
        if (t) out.push(t)
    }
    return out.join(' ')
}

// --- 会话间 diff -------------------------------------------------------------

/** 事件指纹：用于把两侧事件对齐（不含正文，避免正文变化影响配对） */
function eventKey(ev) {
    const p = payloadOf(ev)
    const kind = p.role ?? p.message?.role ?? ''
    const tool = p.name ?? p.toolName ?? p.tool ?? ''
    const id = p.callId ?? p.id ?? ''
    const at = p.turn !== undefined || p.step !== undefined ? `${p.turn ?? '?'}.${p.step ?? '?'}` : ''
    return `${ev?.type ?? '?'}|${kind}|${tool}|${id}|${at}`
}

/**
 * 摘要文本的保留长度（审计 M14）：以前每个事件都留**完整文本 + 事件对象**，一对会话实测峰值 1.1 GB。
 * 显示时最多 clip 140，词级 diff 也只用前几百字符 ⇒ 留 200 足够，比较则用**全文哈希**（不失真）。
 */
const DIGEST_TEXT_LIMIT = 200
const digestHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16)
/**
 * 短文本（≤ 上限）本身就是全文 ⇒ **不必存哈希**，比较时现算（绝大多数事件都走这条，
 * 实测省掉 ~34 万次 sha1 与每条 16 字符的额外开销）；超长文本才预存哈希。
 */
const digestEntry = (key, text) => (text.length <= DIGEST_TEXT_LIMIT
    ? { key, text, hash: undefined }
    : { key, text: clip(text, DIGEST_TEXT_LIMIT), hash: digestHash(text) })

function sideDigest(events) {
    const list = []
    for (const ev of events) {
        const p = payloadOf(ev)
        list.push(digestEntry(eventKey(ev), textOf(p.message ?? p).replace(/\s+/g, ' ').trim()))
    }
    return list
}

/**
 * **流式**取一侧摘要（审计 M14）：逐帧解码 → 摘要 → 丢弃，不再把整份日志拼成巨型字符串、
 * 也不保留事件对象与全文。内存 ≈ 摘要表本身（每条几十字节）而不是事件总量。
 */
function digestFile(file) {
    const list = []
    const stat = scanEvents(file, (ev) => {
        const p = payloadOf(ev)
        list.push(digestEntry(eventKey(ev), textOf(p.message ?? p).replace(/\s+/g, ' ').trim()))
    })
    return { list, frames: stat.frames, bad: stat.bad, badLines: stat.badLines, bytes: stat.bytes }
}

/**
 * 按 key 对齐两份事件序列，输出 added / removed / changed。
 *
 * **算法：哈希对齐（O(n+m)），不是 LCS 动态规划。** 实测：全量 LCS 表是 O(n·m)
 * 时间**和内存**，本机最大一对会话（169,870 × 63,206 事件）要 107 亿格 ≈ 41 GB，直接 OOM；
 * 而事件 key（type|role|tool|callId|turn.step）本来就近乎唯一，哈希对齐结果等价且快几个数量级。
 *
 * 做法：把 B 的 key 建成 `Map<key, {索引数组, 读指针}>`，正序扫 A，每个 A 事件在**游标之后**
 * 找同 key 的下一个未用 B 位置 ⇒ 配对（文本不同记 changed），找不到记 removed；配对的 B 位置
 * 之间被跳过的 B 事件记 added；A 扫完后剩余的 B 全部 added。只前进、不回退，保证顺序稳定。
 */
export function diffEvents(aEvents, bEvents, maxItems = 200) {
    return diffDigests(sideDigest(aEvents), sideDigest(bEvents), maxItems)
}

/** 摘要相同判定：任一侧有哈希（=那边超长被截断）就按**全文哈希**比（短的一侧现算），否则比文本 */
function sameDigest(x, y) {
    if (x?.hash !== undefined || y?.hash !== undefined) {
        const hx = x?.hash ?? digestHash(x?.text ?? '')
        const hy = y?.hash ?? digestHash(y?.text ?? '')
        return hx === hy
    }
    return x?.text === y?.text
}

/**
 * 对齐**已摘要**的两侧（`{key, text, hash}`）—— 与 `diffEvents` 同一算法，只是不做摘要阶段。
 * 让工具可以**流式**产出摘要（M14：内存从"事件总量"降到"摘要表"），而自测仍能用原始事件调用。
 */
export function diffDigests(A, B, maxItems = 200) {
    const index = new Map()
    for (let j = 0; j < B.length; j++) {
        const slot = index.get(B[j].key)
        if (slot === undefined) index.set(B[j].key, { at: [j], pos: 0 })
        else slot.at.push(j)
    }
    const added = []
    const removed = []
    const changed = []
    let cursor = 0
    let contentMatched = 0 // 靠"内容相同"配对救回来的条数（B-M9 的效果可见）
    for (let i = 0; i < A.length; i++) {
        const slot = index.get(A[i].key)
        let match = -1
        if (slot !== undefined) {
            while (slot.pos < slot.at.length && slot.at[slot.pos] < cursor) slot.pos++ // 已被前面的 A 消费掉
            if (slot.pos < slot.at.length) {
                // **三层对齐**（审计 B-M9）：同 key 的条目高度重复，纯位置配对会把"删 1 条"报成
                // added/removed 一大把。策略：
                //  ① 游程内先找**内容完全相同**的那一条（内容全一致时结果不变，仍然全 keep）；
                //  ② **有界前瞻**（窗口 4）：若后面几条 A 里有一条正好等于 B 当前条 ⇒ 当前这条判 removed
                //     （这是小窗口贪心 LCS，正是"删一条"这种最常见编辑的正确解）；
                //  ③ 都不成立才退回位置配对。
                const startIdx = slot.at[slot.pos]
                let runEnd = slot.pos
                while (runEnd < slot.at.length && slot.at[runEnd] === startIdx + (runEnd - slot.pos)) runEnd += 1
                let pick = -1
                for (let e = slot.pos; e < runEnd; e += 1) {
                    if (sameDigest(A[i], B[slot.at[e]])) { pick = e; break }
                }
                if (pick >= 0) {
                    if (pick !== slot.pos) contentMatched += 1
                    match = slot.at[pick]
                    slot.at.splice(pick, 1) // 用掉这一条（splice 保持数组有序，pos 指针相应回退）
                    if (pick < slot.pos) slot.pos = pick
                }
                else {
                    // ② 有界前瞻：当前 A 不在 B 里，但后面某条 A 与 B 当前条相同 ⇒ 当前条应判 removed
                    let skipCurrent = false
                    for (let la = 1; la <= 4 && i + la < A.length; la += 1) {
                        if (A[i + la].key !== A[i].key) continue
                        if (sameDigest(A[i + la], B[slot.at[slot.pos]])) { skipCurrent = true; break }
                    }
                    if (skipCurrent) {
                        contentMatched += 1
                        match = -1
                    }
                    else {
                        match = slot.at[slot.pos]
                        slot.pos += 1
                    }
                }
            }
        }
        if (match >= 0) {
            for (let k = cursor; k < match; k++) added.push({ key: B[k].key, text: B[k].text, index: k })
            cursor = match + 1
            if (!sameDigest(A[i], B[match])) changed.push({ key: A[i].key, a: A[i].text, b: B[match].text, aIndex: i, bIndex: match })
        }
        else removed.push({ key: A[i].key, text: A[i].text, index: i })
    }
    for (let k = cursor; k < B.length; k++) added.push({ key: B[k].key, text: B[k].text, index: k })
    // 同一 key 的游程长度：游程内只有"位置顺序"可用，内容错位会配错 ⇒ added/removed 虚高。
 // 把这个事实**外显**（审计：真实日志 key 高度重复，实测删 1 条被报成 added=6/removed=7）。
    let maxSlot = 0
    let multiKey = 0
    for (const slot of index.values()) {
        if (slot.at.length > maxSlot) maxSlot = slot.at.length
        if (slot.at.length > 1) multiKey += 1
    }
    return {
        counts: { a: A.length, b: B.length, added: added.length, removed: removed.length, changed: changed.length },
        added: added.slice(0, maxItems),
        removed: removed.slice(0, maxItems),
        changed: changed.slice(0, maxItems),
        truncated: added.length > maxItems || removed.length > maxItems || changed.length > maxItems,
        alignment: { maxSlot, multiKey, keys: index.size, contentMatched },
        total: { added: added.length, removed: removed.length, changed: changed.length },
    }
}

function lineDiff(a, b, maxLines = 40) {
    const A = a.split(' ')
    const B = b.split(' ')
    const setB = new Set(B)
    const setA = new Set(A)
    const onlyA = A.filter((w) => !setB.has(w))
    const onlyB = B.filter((w) => !setA.has(w))
    const fmt = (arr) => clip(arr.slice(0, maxLines).join(' '), 400)
    return `- ${fmt(onlyA)}\n+ ${fmt(onlyB)}`
}

// --- 工具注册 ---------------------------------------------------------------

const textOutput = (render) => ({
    schema: { type: 'string' },
    render: render ?? ((_args, value) => [{ type: 'text', text: String(value) }]),
})


/** JSON Schema -> defineTool value-schema dialect ({ field: { type, required, ... } }). */
function toValueSchema(jsonSchema) {
    const out = {}
    const required = new Set(jsonSchema?.required ?? [])
    for (const [key, value] of Object.entries(jsonSchema?.properties ?? {})) {
        out[key] = { ...value }
        if (required.has(key)) out[key].required = true
    }
    return out
}

/** defineTool wrapper: keeps our readable JSON Schema, emits the dialect the host validates. */

/** 一个会话目录的实际占用（session_catalog 报"子代理体量"用；读不到就按 0） */
function dirBytesOf(dir) {
    let total = 0
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) }
    catch { return 0 }
    for (const e of entries) {
        const p = join(dir, e.name)
        try {
            if (e.isDirectory()) total += dirBytesOf(p)
            else total += statSync(p).size
        }
        catch { /* 读不到就不计 */ }
    }
    return total
}

// --- 会话索引：跨会话能力（谓词/排序/体检）的地基 -------------------------------------------------
//
// 为什么需要缓存：给 `session_list` 加 `events/turns/title/integrity` 这些列意味着**必须解码日志**。
// 实测全库 129 份 / 321 MB 解一遍 **12.7 s**（最慢单份 39.7 MB → 3.6 s），而只 stat 是 **0.8 ms**。
// 所以重列一律**按需计算**，结果按 `路径 + 大小 + mtime` 缓存到 `$DSH_HOME/dsh-toolkit/session-index.json`；
// 缓存写不了只影响速度，不影响正确性（读不到就当没有）。

/** 插件状态目录（与信标同一套规则：`DSH_TOOLKIT_STATE_DIR` → `$DSH_HOME/dsh-toolkit`） */
export function toolkitStateDir() {
    const override = process.env.DSH_TOOLKIT_STATE_DIR
    if (typeof override === 'string' && override.trim() !== '') return override
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return join(home, 'dsh-toolkit')
}

const INDEX_VERSION = 1
export function sessionIndexFile() { return join(toolkitStateDir(), 'session-index.json') }

export function loadSessionIndex() {
    try {
        const raw = JSON.parse(readFileSync(sessionIndexFile(), 'utf8'))
        if (raw?.version !== INDEX_VERSION || raw.entries === null || typeof raw.entries !== 'object') return { version: INDEX_VERSION, entries: {} }
        return raw
    }
    catch { return { version: INDEX_VERSION, entries: {} } }
}

function saveSessionIndex(index) {
    try {
        mkdirSync(toolkitStateDir(), { recursive: true })
        const file = sessionIndexFile()
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(index), 'utf8')
        renameSync(tmp, file)
    }
    catch { /* 索引是加速手段：写不了就每次重算 */ }
}

/** 扫一个会话文件，得到"重列"需要的元数据（一次遍历，不保留事件） */
export function scanSessionMeta(file) {
    let events = 0
    let turns = 0
    let messages = 0
    let gaps = 0
    let prevSeq = null
    let title = null
    let lastUserAt = null
    let head = null
    const stat = scanEvents(file, (ev) => {
        events += 1
        const type = ev?.type ?? ev?.kind
        if (head === null) head = ev
        const seq = typeof ev?.seq === 'number' ? ev.seq : null
        if (seq !== null) {
            if (prevSeq !== null && seq > prevSeq + 1) gaps += seq - prevSeq - 1
            prevSeq = seq
        }
        if (type === 'turn/start') turns += 1
        if (type === 'user/message' || type === 'assistant/message') {
            messages += 1
            if (type === 'user/message' && typeof ev?.time === 'number') lastUserAt = ev.time
        }
        if (type === 'session/title') {
            const t = payloadOf(ev)?.title
            if (typeof t === 'string' && t.trim() !== '') title = t.trim().slice(0, 60) // 后来的标题覆盖先前的 fallback
        }
        else if (title === null && type === 'user/message') {
            const t = textOf(payloadOf(ev))
            if (t) title = t.trim().slice(0, 60)
        }
    })
    const p = head ? payloadOf(head) : {}
    const origin = typeof p?.origin === 'string' ? p.origin : null
    const delegationDepth = typeof p?.delegationDepth === 'number' ? p.delegationDepth : 0
    return {
        events, turns, messages, gaps, title, lastUserAt,
        frames: stat.frames,
        badFrames: stat.bad,
        badLines: stat.badLines,
        origin,
        delegationDepth,
        isSeeded: p?.isSeeded === true,
        cwd: typeof p?.cwd === 'string' ? p.cwd : null,
    }
}

/** 取元数据（命中缓存就用缓存；`size`/`mtime` 任一变化即重算） */
export function metaFor(row, index) {
    const key = row.file
    const cached = index.entries[key]
    const stamp = Math.round(Number(row.mtime))
    if (cached && cached.size === row.bytes && cached.mtime === stamp && Number.isFinite(cached.events)) return cached
    const meta = { ...scanSessionMeta(row.file), size: row.bytes, mtime: stamp, files: row.fileCount ?? 1 }
    index.entries[key] = meta
    return meta
}

/**
 * 结构体检结论。**只报真正可靠的两类**：`torn`（有坏帧/坏行 ⇒ 日志尾部或中间被截断）与
 * `unreadable`（一个事件都读不出来）。
 *
 * ⚠️ **`seq` 缺口不能当健康信号** —— 这是被真数据推翻过的判据（两次实测）：
 *  - 子代理会话（`origin:"subagent"`）的 seq 来自父会话计数器，自己那份日志本来就稀疏；
 *  - 早于 v4 的日志（`version: 0`）用的是**宿主全局**序号：实测一份 16.9 万事件的会话，seq 从 0 跳到 **2,494,494**，
 *    而它**能完整解码**、`session_read` 照常可用 —— 按"缺号数"报坏会得到两百多万个"坏事件"，纯属噪音；
 *  - fork/seed 会话把父会话事件按原 seq 重放进前缀、v1/v3/v4 多文件并存时文件边界也会"缺号"。
 * 所以这里**不计 gaps**（`meta.gaps` 仍保留，供需要时诊断），只把"读不出来"当问题。
 */
export function integrityOf(meta) {
    if (!meta) return 'unknown'
    if (meta.badFrames > 0 || meta.badLines > 0) return 'torn'
    if (meta.events === 0) return 'unreadable'
    return 'ok'
}

/** 同一个会话可能有多份文件（v1/v3/v4）：**合并成一行**，取最新那份的属性 */
export function sessionRows(pool) {
    const byId = new Map()
    for (const s of pool) {
        const prev = byId.get(s.id)
        if (!prev) { byId.set(s.id, { ...s, fileCount: 1, fileNames: [s.file] }); continue }
        prev.fileCount += 1
        prev.fileNames.push(s.file)
        if (s.mtime > prev.mtime) Object.assign(prev, { file: s.file, bytes: s.bytes, mtime: s.mtime, slug: s.slug })
    }
    return [...byId.values()].sort((a, b) => b.mtime - a.mtime)
}

/**
 * 单会话检索（`session_grep` 与跨会话 `scope` 共用）。返回命中与解码统计，不生成文案。
 * 大文件走流式逐帧扫描（不把整份日志拼成巨型字符串并留住全部事件）。
 */
function grepOneSession(file, bytes, re, { limit = 30, width = 200, signal } = {}) {
    const hits = []
    let matched = 0
    const matchesOne = (ev) => {
        const line = summarizeEvent(ev, width)
        if (re.test(line)) return line
        const deep = deepTextOf(payloadOf(ev))
        return deep && re.test(deep) ? line : null
    }
    if (bytes > STREAM_THRESHOLD_BYTES) {
        const stat = scanEvents(file, (ev, index) => {
            if ((index & 1023) === 0 && signal?.aborted) throw new Error('aborted')
            const line = matchesOne(ev)
            if (line === null) return
            matched += 1
            if (hits.length < limit) hits.push({ index, line })
        })
        return { hits, matched, frames: stat.frames, bad: stat.bad, badLines: stat.badLines, events: stat.events }
    }
    const decoded = readEvents(file)
    for (let k = 0; k < decoded.events.length; k += 1) {
        const line = matchesOne(decoded.events[k])
        if (line === null) continue
        matched += 1
        if (hits.length < limit) hits.push({ index: k + 1, line })
    }
    return { hits, matched, frames: decoded.frames, bad: decoded.bad, badLines: decoded.badLines, events: decoded.events.length, text: decoded.text }
}

export function tools(defineTool, options = {}) {
    // 导出/落盘类动作要过沙箱闸门（宿主策略管不到插件里的 fs 写入）。
    const guardCtx = typeof options.getCtx === 'function' ? options.getCtx : () => null
    const tool = (def) => defineTool({ ...def, parameters: toValueSchema(def.parameters) })
    // "last" 的语义：**调用方会话所在工作区**里的最新会话（以前是全局最新 ⇒ 多工作区时会读到别人的会话）。
    // 只在 spec 省略或为 'last' 时套用；显式给了 id 就不要用 cwd 去限制搜索范围（否则跨工作区按 id 找会失败）。
    const execCwd = (exec) => {
        try {
            const cwd = exec?.agent?.session?.header?.cwd
            return typeof cwd === 'string' && cwd !== '' ? cwd : null
        }
        catch { return null }
    }
    const cwdFor = (args, exec, spec) => {
        if (typeof args?.cwd === 'string' && args.cwd !== '') return args.cwd
        if (spec === undefined || spec === null || spec === '' || spec === 'last') {
            const fromExec = execCwd(exec)
            if (fromExec !== null) return fromExec
            try {
                const w = options.resolveWorkspaceCwd?.()
                if (typeof w === 'string' && w !== '') return w
            }
            catch { /* ignore */ }
        }
        return null
    }
    const badNote = (bad) => (bad > 0 ? `  ⚠ 有 ${bad} 帧解码失败（内容可能不完整；日志被并发写入时会出现）` : '')
    /**
     * `last` 的**解析依据**必须打进输出：否则"本会话恰好是全局最新"时新旧两种实现选中的是同一个会话，
 * 使用者无法判定作用域是否生效（Darktide 就卡在这里，只能记成"无法判定"）。
 * ⚠️ 审计：`resolveSession` 以前在作用域为空时**静默回退全局最新**，这句却仍然断言
     * "按调用方工作区解析" ⇒ 用户被引导到错误结论。现在作用域为空直接抛错，这里再核对一次
     * "解析出来的会话确实属于该工作区"，不属于就明说"不是按工作区解析的"。
     */
    const lastNote = (spec, cwd, resolvedId) => {
        const isLast = spec === undefined || spec === null || spec === '' || spec === 'last'
        if (!isLast) return ''
        if (cwd === null) return '  ［last = 全局最新：拿不到调用方会话工作区，未按工作区限定］'
        let globalNewest = null
        let sameWorkspace = null
        try {
            const all = listSessionDirs()
            globalNewest = all[0] ?? null
            const hit = all.find((s) => s.id === resolvedId)
            sameWorkspace = hit ? hit.slug === slugOf(cwd) : null
        }
        catch { /* 读不到就只报依据 */ }
        if (sameWorkspace === false) return `  ［⚠ last 不是该工作区的会话：${cwd}（slug=${slugOf(cwd)}）里没有会话日志，结果来自别的工作区］`
        const contrast = globalNewest === null
            ? ''
            : globalNewest.id === resolvedId
                ? '；它同时也是全局最新（此例无法区分作用域，换个会话再试）'
                : `；全局最新是 ${globalNewest.id}@${globalNewest.slug}`
        return `  ［last 按调用方工作区解析：${cwd}${contrast}］`
    }
    const legacy = [
        ({
            name: 'session_list',
            description: 'List DeepSeek Harness session logs on disk (newest first). Optionally filter by a working directory. Read-only.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    cwd: { type: 'string', description: 'Only sessions whose workspace directory is this path (e.g. the project root you are working in).' },
                    limit: { type: 'number', description: 'Max rows (default 20).' },
                },
            },
            output: textOutput(),
            async execute(args) {
                const all = listSessionDirs()
                // cwd 过滤：slug 精确匹配 + 头帧 cwd 真值兜底；**匹配 0 个要说清是"该工作区没有"**，
 // 而不是让调用方以为"全库都没有"（旧实现的假 no logs，子代理审计）。
                let pool = all
                let scopeNote = ''
                if (args?.cwd) {
                    const want = String(args.cwd)
                    let scoped = all.filter((s) => s.slug === slugOf(want))
                    if (scoped.length === 0) scoped = all.filter((s) => cwdOfSessionHead(s) === want)
                    if (scoped.length === 0) return `no session logs under ${sessionsRoot()} for workspace ${want}（slug=${slugOf(want)}；全库 ${all.length} 个文件）。不传 cwd 可看全部`
                    pool = scoped
                    scopeNote = ` (filtered by cwd=${want}, slug=${slugOf(want)})`
                }
                // limit 校验：0/负数以前会静默变成"没有日志"或悄悄少几行
                const wantLimit = Number(args?.limit ?? 20)
                const limit = Number.isFinite(wantLimit) ? Math.min(1000, Math.max(1, Math.trunc(wantLimit))) : 20
                // 同一个 session id 可能有 session.jsonl.zstd / v3 / v4 多个文件：**合并成一行**并标出文件数与最新版本，
                // 否则同一 id 会重复出现（实测 126 行 = 98 个会话），而且看不出读的是哪个版本。
                const byId = new Map()
                for (const s of pool) {
                    const prev = byId.get(s.id)
                    if (!prev) { byId.set(s.id, { ...s, fileCount: 1, fileNames: [s.file] }); continue }
                    prev.fileCount += 1
                    prev.fileNames.push(s.file)
                    if (s.mtime > prev.mtime) Object.assign(prev, { file: s.file, bytes: s.bytes, mtime: s.mtime, slug: s.slug })
                }
                const merged = [...byId.values()].sort((a, b) => b.mtime - a.mtime)
                const rows = merged.slice(0, limit)
                // 空库也要给**同样的表头**（`sessions root:` / `total: 0 session(s)`）—— 调用方与自测靠它判读，
                // 而且"到底在哪里找的"在空的时候反而更重要（root 可被 DSH_SESSION_ROOT 覆盖）。
                if (rows.length === 0) {
                    return [
                        `sessions root: ${sessionsRoot()}`,
                        `total: 0 session(s) / ${pool.length} file(s)${scopeNote}`,
                        `no session logs under ${sessionsRoot()}`,
                    ].join('\n')
                }
                const lines = rows.map((s) => {
                    const when = new Date(s.mtime).toISOString().replace('T', ' ').slice(0, 19)
                    const ver = (s.file.match(/session(\.v\d+)?\.jsonl\.zstd$/) ?? [])[1] ?? ''
                    const extra = s.fileCount > 1 ? `  files=${s.fileCount}(newest ${ver || '.v1'})` : (ver ? `  ${ver}` : '')
                    return `${s.id}  ${when}  ${(s.bytes / 1024 / 1024).toFixed(1)} MB  ${s.slug}${extra}`
                })
                const notes = []
                if (wantLimit !== limit) notes.push(`（limit=${JSON.stringify(args?.limit)} 已夹到 ${limit}）`)
                if (merged.length > rows.length) notes.push(`（共 ${merged.length} 个会话，只显示前 ${rows.length} 个）`)
                return [
                    `sessions root: ${sessionsRoot()}`,
                    `total: ${merged.length} session(s) / ${pool.length} file(s)${scopeNote}`,
                    ...lines,
                    ...(notes.length ? ['', ...notes] : []),
                ].join('\n')
            },
        }),

        ({
            name: 'session_peek',
            description: 'Show the last N events of a session log as one-line summaries (decodes the multi-frame zstd log). Read-only.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    session: { type: 'string', description: 'Session id, id prefix, or "last" (default).' },
                    cwd: { type: 'string', description: 'Workspace to disambiguate "last" (default: the calling session workspace).' },
                    tail: { type: 'number', description: 'How many events from the end (default 20).' },
                    width: { type: 'number', description: 'Text preview width per event (default 160).' },
                },
            },
            output: textOutput(),
            async execute(args, exec) {
                const cwd = cwdFor(args, exec, args?.session)
                const s = resolveSession(args?.session, cwd)
                const wantTail = Number(args?.tail ?? 20)
                const tail = Number.isFinite(wantTail) ? Math.max(1, Math.trunc(wantTail)) : 20
                // **大文件走尾读**（审计 M13）：只看最后 N 条没必要解 15 万帧（实测 3.2 s / RSS 508 MB）
                if (s.bytes > STREAM_THRESHOLD_BYTES) {
                    const t = decodeSessionTail(s.file, tail)
                    const events = []
                    for (const line of t.lines) {
                        try { events.push(JSON.parse(line)) } catch { /* 坏行已在 notes 里计 */ }
                    }
                    const notes = decodeNotes({ frames: t.frames, bad: t.bad, badLines: 0, bytes: t.bytes, text: '' })
                    notes.push(`（尾读模式：只解了最后 ${t.decodedFrames}/${t.frames} 帧，行号用事件自带的 seq；要绝对序号或全文请用 session_read（给 pattern）/ session_export）`)
                    return [
                        `${s.id}  ${(t.bytes / 1024 / 1024).toFixed(1)} MB  frames=${t.frames}  tail=${events.length}${notes.length ? '\n  ' + notes.join('\n  ') : ''}${lastNote(args?.session, cwd, s.id)}`,
                        ...events.map((ev) => `${String(ev?.seq ?? '?').padStart(7)}  ${summarizeEvent(ev, args?.width ?? 160)}`),
                    ].join('\n')
                }
                const decoded = readEvents(s.file)
                const { events, frames, bad, bytes, badLines } = decoded
                const slice = events.slice(-tail)
                const notes = decodeNotes({ frames, bad, badLines, bytes, text: decoded.text })
                if (wantTail !== tail) notes.push(`（tail=${JSON.stringify(args?.tail)} 已按 1 处理）`)
                if (events.length === 0) notes.push('⚠ 没有解析出任何事件（见上面的原因），下面的输出是空的')
                return [
                    `${s.id}  ${(bytes / 1024 / 1024).toFixed(1)} MB  frames=${frames}  events=${events.length}${notes.length ? '\n  ' + notes.join('\n  ') : ''}${lastNote(args?.session, cwd, s.id)}`,
                    ...slice.map((ev, k) => `${String(events.length - slice.length + k + 1).padStart(5)}  ${summarizeEvent(ev, args?.width ?? 160)}`),
                ].join('\n')
            },
        }),

        ({
            name: 'session_grep',
            description: 'Search decoded session events for a regular expression, printing one-line summaries with their event index. Read-only.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    pattern: { type: 'string', description: 'JavaScript regular expression (case-insensitive unless flags say otherwise).' },
                    flags: { type: 'string', description: 'Regex flags, default "i".' },
                    session: { type: 'string', description: 'Session id, id prefix, or "last" (default).' },
                    cwd: { type: 'string', description: 'Workspace to disambiguate "last" (default: the calling session workspace).' },
                    limit: { type: 'number', description: 'Max matches (default 30).' },
                    width: { type: 'number', description: 'Text preview width (default 200).' },
                },
                required: ['pattern'],
            },
            output: textOutput(),
            async execute(args, exec) {
                // flags：`g`/`y` 会让 `re.test()` 带 lastIndex 状态 ⇒ 行首命中被跳过、结果静默变少。
                // 这里剥掉它们（并告知），让同一 pattern 在不同 flags 下结果一致。
                const rawFlags = String(args?.flags ?? 'i')
                const flags = rawFlags.replace(/[gy]/g, '')
                let re
                try { re = new RegExp(String(args.pattern), flags) }
                catch (error) { throw new Error(`pattern 无效：${error instanceof Error ? error.message : String(error)}`) }
                // 灾难性回溯护栏：`(a+)+$` 这类嵌套量词在长行上会指数回溯 —— 实测 200 字符窗口就能让工具
 // **永久挂死**（300 s 未返回、宿主卡住，子代理审计）。JS 正则无法中途打断，
                // 所以只能提前识别并拒绝，并给出写法建议。
                const cat = catastrophicHint(String(args.pattern))
                if (cat) throw new Error(`pattern 有灾难性回溯风险（${cat}），会挂死扫描。请改写：用更具体的字符类/锚点，或先缩小 session/width`)
                const cwd = cwdFor(args, exec, args?.session)
                const s = resolveSession(args?.session, cwd)
                if (exec?.signal?.aborted) throw new Error('aborted')
                const wantLimit = Number(args?.limit ?? 30)
                const limit = Number.isFinite(wantLimit) ? Math.min(10_000, Math.max(1, Math.trunc(wantLimit))) : 30
                const width = Number(args?.width ?? 200)
                const safeWidth = Number.isFinite(width) ? Math.max(20, Math.trunc(width)) : 200
                // 扫描逻辑与跨会话检索共用一份（`grepOneSession`）：两处各写一遍迟早会漂移
                const g = grepOneSession(s.file, s.bytes, re, { limit, width: safeWidth, signal: exec?.signal })
                const hits = g.hits.map((h) => `${String(h.index).padStart(7)}  ${h.line}`)
                const matched = g.matched
                const frames = g.frames
                const badFrames = g.bad
                const badLines = g.badLines
                const eventCount = g.events
                const decodedText = g.text ?? ''
                const notes = decodeNotes({ frames, bad: badFrames, badLines, bytes: s.bytes, text: decodedText })
                if (rawFlags !== flags) notes.push(`（flags 里的 g/y 已剥掉：${JSON.stringify(rawFlags)} → ${JSON.stringify(flags)}）`)
                if (wantLimit !== limit) notes.push(`（limit=${JSON.stringify(args?.limit)} 已夹到 ${limit}）`)
                if (matched > hits.length) notes.push(`（命中 ${matched} 条，只显示了前 ${hits.length} 条 —— 要更多请调大 limit）`)
                const foot = (notes.length ? '\n  ' + notes.join('\n  ') : '') + lastNote(args?.session, cwd, s.id)
                return hits.length === 0
                    ? `no match for /${args.pattern}/${flags} in ${eventCount} events of ${s.id}${foot}`
                    : [`${s.id}: ${hits.length} of ${matched} match(es) in ${eventCount} events${foot}`, ...hits].join('\n')
            },
        }),

        ({
            name: 'session_diff',
            description: 'Event-level diff between two session logs (hash alignment by type/role/tool/id, then text — not an LCS). Prefer this over an ad-hoc script. Read-only.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    a: { type: 'string', description: 'Left session: id, id prefix, or "last".' },
                    b: { type: 'string', description: 'Right session: id, id prefix, or "last".' },
                    cwd: { type: 'string', description: 'Workspace path to disambiguate ids.' },
                    maxItems: { type: 'number', description: 'Max rows per section (default 40).' },
                    withText: { type: 'boolean', description: 'Also print a word-level +/- sample for changed events (default true).' },
                },
                required: ['a', 'b'],
            },
            output: textOutput(),
            async execute(args, exec) {
                const cwdA = cwdFor(args, exec, args.a)
                const cwdB = cwdFor(args, exec, args.b)
                const sa = resolveSession(args.a, cwdA)
                const sb = resolveSession(args.b, cwdB)
                // **流式取摘要**（审计 M14）：以前 readEvents 两侧全量常驻（事件对象 + 全文 + 拼接字符串），
                // 一对大会话实测峰值 1.1 GB。现在逐帧解码 → 摘要（200 字符 + 全文哈希）→ 丢弃。
                const ga = digestFile(sa.file)
                const gb = digestFile(sb.file)
                const d = diffDigests(ga.list, gb.list, args?.maxItems ?? 40)
                const out = [
                    `a: ${sa.id}  events=${d.counts.a}${badNote(ga.bad)}${lastNote(args.a, cwdA, sa.id)}`,
                    `b: ${sb.id}  events=${d.counts.b}${badNote(gb.bad)}${lastNote(args.b, cwdB, sb.id)}`,
                    `added=${d.counts.added} removed=${d.counts.removed} changed=${d.counts.changed}${d.truncated ? ' (rows truncated)' : ''}`,
                    `（流式摘要：比较用全文哈希；展示文本截到 ${200} 字符，词级 diff 也只在该段内）`,
                ]
                // 对齐质量提示：key 高度重复时游程内只能按位置配，计数会虚高（见 diffEvents 注释）
                if (d.alignment && d.alignment.maxSlot > 8) {
                    out.push(`⚠ 对齐置信度提示：同一 key 的游程最长 ${d.alignment.maxSlot} 条（${d.alignment.multiKey}/${d.alignment.keys} 个 key 有重复），段内按**位置**配对 ⇒ 计数可能偏大（真实差异小时尤其明显）`)
                }
 // **不同源会话**提示（MCMOD 实测观察）：两侧几乎没有共同内容时，
                // added/removed 全是"两份不同会话的差集"，与"同一会话被改过"完全不是一回事。
                if (d.alignment && d.alignment.keys > 0 && d.alignment.contentMatched === 0
                    && d.counts.changed === 0 && (d.counts.added + d.counts.removed) > 20
                    && d.counts.a > 0 && d.counts.b > 0
                    && Math.min(d.counts.added, d.counts.removed) / Math.max(1, Math.min(d.counts.a, d.counts.b)) > 0.5) {
                    out.push('⚠ 两侧几乎没有共同内容 —— 可能**不是同源会话**（分叉/接续/不同项目），这样的 added/removed 只是两份日志的差集，不代表"改动"')
                }
                if (d.removed.length) out.push('', '--- only in a ---', ...d.removed.map((r) => `- [${r.index + 1}] ${clip(r.text, 140) || r.key}`))
                if (d.added.length) out.push('', '--- only in b ---', ...d.added.map((r) => `+ [${r.index + 1}] ${clip(r.text, 140) || r.key}`))
                if (d.changed.length) {
                    out.push('', '--- changed ---')
                    for (const c of d.changed) {
                        out.push(`~ [a${c.aIndex + 1} / b${c.bIndex + 1}] ${c.key}`)
                        if (args?.withText !== false) out.push(lineDiff(c.a, c.b))
                    }
                }
                return out.join('\n')
            },
        }),

        ({
            name: 'session_catalog',
            description: 'List a session\'s subagent/catalog registrations as a table: childId / mode / label / created / times registered / whether the child session directory still exists / its size / gc-backup presence. Read-only; use it first when the App shows a subagent row whose data is missing (before writing an ad-hoc decode script).',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    session: { type: 'string', description: 'Session id, id prefix, or "last" (default).' },
                    cwd: { type: 'string', description: 'Workspace to disambiguate "last" (default: the calling session workspace).' },
                    gcRoot: { type: 'string', description: 'Subagent GC backup root (default ~/.dsh/subagent-gc-backup).' },
                    limit: { type: 'number', description: 'Max child rows to print (default 40).' },
                },
            },
            output: textOutput(),
            async execute(args, exec) {
                const cwd = cwdFor(args, exec, args?.session)
                const s = resolveSession(args?.session, cwd)
                const gcRoot = typeof args?.gcRoot === 'string' && args.gcRoot !== ''
                    ? resolve(args.gcRoot)
                    : join(homedir(), '.dsh', 'subagent-gc-backup')
                const rows = new Map()
                const subagentTypes = new Map()   // 事件名 → 次数（catalog 事件名万一变了能一眼看出来）
                const oddShapes = new Map()
                let events = 0
                let subagentEvents = 0
                let catalogEvents = 0
                let missingSeq = 0
                let prevSeq = null
                scanEvents(s.file, (ev, index) => {
                    events = index
                    const seq = typeof ev?.seq === 'number' ? ev.seq : null
                    if (seq !== null) {
                        if (prevSeq !== null && seq > prevSeq + 1) missingSeq += seq - prevSeq - 1
                        prevSeq = seq
                    }
                    const type = String(ev?.type ?? '')
                    if (!/subagent/i.test(type)) return
                    subagentEvents += 1
                    subagentTypes.set(type, (subagentTypes.get(type) ?? 0) + 1)
                    if (!/catalog/i.test(type)) return
                    catalogEvents += 1
                    // ⚠️ 真实形状是**一条事件一个 child**（`{version,childId,childCreatedAt,mode,label?}`），
                    // 不是"一份快照数组"—— 旧的一次性脚本按数组解析，永远打印"(非数组)"。
                    const data = payloadOf(ev) ?? {}
                    const id = data.childId ?? data.id ?? data.sessionId ?? data.agentId ?? null
                    if (id === null || id === '') {
                        const shape = Object.keys(data).join(',') || '(空)'
                        oddShapes.set(shape, (oddShapes.get(shape) ?? 0) + 1)
                        return
                    }
                    const key = String(id)
                    const cur = rows.get(key) ?? { id: key, count: 0, mode: '', label: '', created: null }
                    cur.count += 1
                    if (cur.mode === '' && data.mode !== undefined) cur.mode = String(data.mode)
                    if (cur.label === '' && data.label !== undefined) cur.label = String(data.label)
                    if (cur.created === null && data.childCreatedAt !== undefined) cur.created = Number(data.childCreatedAt)
                    rows.set(key, cur)
                })
                const list = [...rows.values()].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
                const mb = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`)
                const out = [
                    `${s.id}  ${mb(s.bytes)}  events=${events}${missingSeq > 0 ? `  ⚠ seq 缺号 ${missingSeq}（日志可能被外部改动过）` : ''}`,
                    `subagent/* 事件 ${subagentEvents} 条，其中 subagent/catalog ${catalogEvents} 条 → 去重 child ${list.length} 个`,
                ]
                if (catalogEvents === 0) {
                    out.push(subagentEvents > 0
                        ? `⚠ 有 subagent 事件但没有 catalog —— 事件名可能变了，本次见到的：${[...subagentTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join('、')}`
                        : '⚠ 该会话没有 subagent/* 登记 —— 可能确实没派过子代理（不是错误）')
                    return out.join('\n')
                }
                const wantRows = Number(args?.limit ?? 40)
                const maxRows = Number.isFinite(wantRows) ? Math.max(1, Math.trunc(wantRows)) : 40
                const slug = s.slug
                let alive = 0
                let gone = 0
                let inGcCount = 0
                let aliveBytes = 0
                out.push('', 'childId   mode          label                       created            次数  会话目录  体量      gc备份')
                const shown = []
                // ⚠️ 统计要覆盖**全部** child（早先只统计显示出来的前 N 行 ⇒ 汇总数字偏小，
                // 属于"看着对的错数字"）。显示与统计分开处理。
                for (const r of list) {
                    const dir = join(sessionsRoot(), slug, r.id)
                    const isAlive = existsSync(dir)
                    const size = isAlive ? dirBytesOf(dir) : 0
                    const inGc = existsSync(join(gcRoot, slug, r.id))
                    if (isAlive) { alive += 1; aliveBytes += size }
                    else { gone += 1; if (inGc) inGcCount += 1 }
                    if (shown.length >= maxRows) continue
                    const created = r.created === null ? '-' : new Date(r.created).toISOString().slice(0, 16).replace('T', ' ')
                    shown.push(`${r.id.slice(0, 8)}  ${(r.mode === '' ? '-' : r.mode).padEnd(12)}  ${(r.label === '' ? '-' : r.label).slice(0, 25).padEnd(25)}  ${created.padEnd(16)}  ${String(r.count).padStart(4)}  ${isAlive ? 'YES' : 'no '}       ${(isAlive ? mb(size) : '-').padEnd(8)}  ${inGc ? 'YES' : 'no'}`)
                }
                out.push(...shown)
                if (list.length > maxRows) out.push(`… 还有 ${list.length - maxRows} 个未显示（用 limit 调大）`)
                out.push('', `汇总：child ${list.length} 个；会话目录仍在 ${alive} 个（合计 ${mb(aliveBytes)}）；已不在 ${gone} 个（其中 gc-backup 里还有 ${inGcCount} 个，**彻底丢失 ${gone - inGcCount} 个**）`)
                if (gone - inGcCount > 0) {
                    out.push(`⚠ ${gone - inGcCount} 个 child 的数据已不在 ⇒ App 里可能出现"幽灵子代理行"。先确认备份，**别直接改会话日志**（断 seq 会让会话再也打不开）`)
                }
                if (oddShapes.size > 0) out.push('', `⚠ 认不出 childId 的 catalog 形状：${[...oddShapes.entries()].map(([k, v]) => `${k}×${v}`).join('；')}（宿主版本可能改了字段名）`)
                return out.join('\n')
            },
        }),

        ({
            name: 'session_export',
            description: 'Decode a session log to plain .jsonl (verbatim events) or a .md digest (one line per event). Writes one file atomically; refuses to overwrite unless overwrite:true.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    session: { type: 'string', description: 'Session id, id prefix, or "last" (default).' },
                    cwd: { type: 'string', description: 'Workspace to disambiguate "last" (default: the calling session workspace).' },
                    to: { type: 'string', description: 'Destination path (required). Parent directories are created if missing; an existing target is refused unless overwrite:true, and a session log is never overwritten.' },
                    format: { type: 'string', enum: ['jsonl', 'md'], description: 'Output format (default jsonl).' },
                    overwrite: { type: 'boolean', description: 'Allow replacing an existing destination file (default false). Session logs themselves are NEVER overwritten.' },
                },
                required: ['to'],
            },
            output: textOutput(),
            async execute(args, exec) {
                const cwd = cwdFor(args, exec, args?.session)
                const s = resolveSession(args?.session, cwd)
                const to = resolve(String(args.to))
                // ── 目标校验（写盘之前！）────────────────────────────────────────────
                // 旧实现直接 writeFileSync(to)：① 目标指向会话日志本身会把日志变成裸 jsonl ⇒ frames=0，
                // **会话永久打不开**（对应工作区铁律 #1 的灾难），而工具还回报成功；② 目录不存在要等
 // 整个解码跑完才报错；③ 已存在文件被无提示截断（子代理审计实测）。
                if (to === resolve(s.file)) throw new Error(`拒绝：目标就是源会话日志本身（${to}）—— 那会把它写坏，会话将永久打不开`)
                if (to.startsWith(resolve(sessionsRoot()) + sep)) throw new Error(`拒绝写入会话日志目录：${to}（那会破坏宿主加载器依赖的 zstd 多帧格式）`)
                // 导出也是写盘：只读会话拒绝，工作区外按宿主策略判。
                assertWritableTargets(guardCtx(), [to], { session: exec?.agent?.session })
                ensureDirOrThrow(dirname(to))
                if (existsSync(to)) {
                    const st = statSync(to)
                    if (st.isDirectory()) throw new Error(`目标是目录：${to}`)
                    const head = st.size > 0 ? readFileSync(to).subarray(0, 4) : Buffer.alloc(0)
                    if (head.length === 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) {
                        throw new Error(`拒绝覆盖 zstd 文件（${to}）—— 看起来是会话日志，写坏它会让会话永久打不开`)
                    }
                    if (st.size > 0 && args?.overwrite !== true) {
                        throw new Error(`目标已存在（${(st.size / 1024).toFixed(1)} KB）：${to}。要替换请显式传 overwrite: true`)
                    }
                }
                // ── 逐帧流式 + 原子写 ────────────────────────────────────────────────
                // 不再先 readEvents 全量：44 MB 日志整份解成一个字符串会把提交内存吃满（Node 26 的多帧语义下更糟）。
                // 逐帧解码 → 立刻写盘 → 丢弃，峰值 ≈ 压缩文件 + 单帧。
                const tmp = `${to}.dsh-export-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
                const fh = openSync(tmp, 'w')
                let frames = 0
                let bad = 0
                let badLines = 0
                let bytes = 0
                let exported = 0
                try {
                    let buf = []
                    const flush = () => { if (buf.length) { writeSync(fh, buf.join('\n') + '\n'); buf = [] } }
                    const stat = scanEvents(s.file, (ev) => {
                        exported += 1
                        if ((exported & 511) === 0 && exec?.signal?.aborted) throw new Error('aborted')
                        buf.push(args?.format === 'md' ? `## ${summarizeEvent(ev, 200)}\n` : JSON.stringify(ev))
                        if (buf.length >= 512) flush()
                    })
                    frames = stat.frames
                    bad = stat.bad
                    badLines = stat.badLines
                    bytes = stat.bytes
                    flush()
                    if (exported === 0) throw new Error(`这条会话解不出任何事件（frames=${frames}，${bytes} 字节）。没有写出文件`)
                }
                catch (error) {
                    try { closeSync(fh) } catch { /* ignore */ }
                    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
                    throw error
                }
                closeSync(fh)
                const notes = decodeNotes({ frames, bad, badLines, bytes, text: '' })
                renameSync(tmp, to) // 原子替换：要么旧内容、要么完整新内容，不会留半个文件
                return `exported ${exported} events (${frames} frames) from ${s.id}\n  -> ${to}${notes.length ? '\n  ' + notes.join('\n  ') : ''}${lastNote(args?.session, cwd, s.id)}`
            },
        }),
    ]

 // ── 成对合并（工具面收敛第二步：session 6 → 4）────────────────────────────────
    // 数据来源：参数重叠度（Jaccard）实测 —— list+catalog 0.50、peek+grep 0.43，是剩下最像的两对；
    // diff/export 只有 0.11（读 vs 写），ast 那对 0.00，故不动。
    // 业务逻辑仍然一行没改：两个 mode 各自委派给上面的原定义（execute 与 render 都复用）。
    const implOf = (name) => legacy.find((t) => t.name === name) ?? null
    const listImpl = implOf('session_list')
    const catalogImpl = implOf('session_catalog')
    const peekImpl = implOf('session_peek')
    const grepImpl = implOf('session_grep')
    const diffImpl = implOf('session_diff')
    const exportImpl = implOf('session_export')
    const PARAMS_OF_LIST = { sessions: ['cwd', 'limit', 'where', 'fields', 'sort', 'offset'], subagents: ['session', 'cwd', 'gcRoot', 'limit'] }
    const PARAMS_OF_READ = { peek: ['session', 'cwd', 'tail', 'width'], grep: ['pattern', 'flags', 'session', 'cwd', 'limit', 'width', 'scope', 'maxHitsPerSession'] }

    /**
     * 跨会话检索（`session_read {scope}`）：按会话分组输出，双上限 + 时间预算，绝不无界扫。
     * 为什么必须有上限：实测全库 129 份 / 321 MB 解一遍 12.7 s，最慢单份 3.6 s —— 无界扫描 = 把工具变成卡死源。
     */
    const searchAcrossSessions = async (args, exec, scope, cwd) => {
        const rawFlags = String(args?.flags ?? 'i')
        const flags = rawFlags.replace(/[gy]/g, '')
        let re
        try { re = new RegExp(String(args?.pattern), flags) }
        catch (error) { throw new Error(`pattern 无效：${error instanceof Error ? error.message : String(error)}`) }
        const cat = catastrophicHint(String(args?.pattern))
        if (cat) throw new Error(`pattern 有灾难性回溯风险（${cat}），会挂死扫描。请改写：用更具体的字符类/锚点，或先缩小 scope/width`)
        const clampInt = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d }
        const limit = clampInt(args?.limit, 30, 1, 2000)
        const perSession = clampInt(args?.maxHitsPerSession, 5, 1, 100)
        const width = clampInt(args?.width, 200, 20, 4000)

        const all = sessionRows(listSessionDirs())
        let pool = all
        let scopeNote = ''
        if (scope === 'workspace') {
            if (cwd === null) throw new Error('scope=workspace 需要 cwd（拿不到调用方会话工作区时请显式给 cwd）')
            pool = all.filter((s) => s.slug === slugOf(cwd))
            scopeNote = `cwd=${cwd}`
            if (pool.length === 0) return `no session logs for workspace ${cwd}（slug=${slugOf(cwd)}）；改用 scope=all 可搜全部`
        }
        const MAX_SESSIONS = 200
        const budgetMs = 10_000
        const started = Date.now()
        const groups = []
        let scanned = 0
        let withHits = 0
        let totalHits = 0
        let eventsScanned = 0
        let stopped = null
        for (const row of pool.slice(0, MAX_SESSIONS)) {
            if (exec?.signal?.aborted) throw new Error('aborted')
            if (Date.now() - started > budgetMs) { stopped = `时间预算 ${budgetMs} ms 用尽`; break }
            if (totalHits >= limit) { stopped = `已到 limit=${limit}`; break }
            const remain = limit - totalHits
            const g = grepOneSession(row.file, row.bytes, re, { limit: Math.min(perSession, remain), width, signal: exec?.signal })
            scanned += 1
            eventsScanned += g.events
            if (g.matched > 0) {
                withHits += 1
                totalHits += Math.min(g.matched, Math.min(perSession, remain))
                groups.push({ row, hits: g.hits, matched: g.matched })
            }
        }
        const skipped = Math.max(0, pool.length - scanned)
        const head = `search /${String(args?.pattern)}/${flags} · scope=${scope}${scopeNote ? ` (${scopeNote})` : ''} · ${scanned} session(s) / ${eventsScanned} events scanned, ${withHits} with hits · ${Date.now() - started} ms`
        const notes = []
        if (rawFlags !== flags) notes.push(`（flags 里的 g/y 已剥掉：${JSON.stringify(rawFlags)} → ${JSON.stringify(flags)}；跨会话检索不需要也不支持带状态的正则）`)
        if (stopped) notes.push(`（提前结束：${stopped}；还有 ${skipped} 个会话未扫描）`)
        else if (skipped > 0) notes.push(`（会话数上限 ${MAX_SESSIONS}：只扫了前 ${scanned} 个，其余 ${skipped} 个未扫描）`)
        if (totalHits >= limit) notes.push(`（命中已达 limit=${limit}：要更多请调大 limit，或把 pattern 写窄）`)
        if (groups.length === 0) {
            return [`${head}`, `no match`, ...(notes.length ? ['', ...notes] : [])].join('\n')
        }
        const lines = [head]
        for (const g of groups) {
            const shown = g.hits.length
            lines.push('', `${g.row.id}  ${shown} of ${g.matched} match(es)`)
            for (const h of g.hits) lines.push(`${String(h.index).padStart(7)}  ${h.line}`)
        }
        if (notes.length) lines.push('', ...notes)
        return lines.join('\n')
    }

    const listTool = tool({
        name: 'session_list',
        description:
            'List DeepSeek Harness session logs on disk (newest first), or the subagent/catalog registrations of one session. ' +
            '`kind` picks which (default "sessions"). `where` filters by objective predicates (empty / noTitle / olderThanDays / minBytes / maxBytes / integrity), ' +
            '`fields` opts into heavy columns (events / turns / title / integrity), `sort` and `offset` page the result. Read-only. ' +
            'Heavy columns decode the logs once and are cached by path+size+mtime. For the events inside a session use session_read.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: { type: 'string', enum: ['sessions', 'subagents'], description: 'sessions (default) = logs on disk; subagents = that session’s catalog registrations (size, gc backup).' },
                cwd: { type: 'string', description: 'sessions: filter by workspace dir. subagents: disambiguate "last".' },
                limit: { type: 'number', description: 'Max rows (default 20; subagents 40).' },
                where: {
                    type: 'object',
                    additionalProperties: false,
                    description: 'Predicates (ANDed, all optional).',
                    properties: {
                        empty: { type: 'boolean', description: 'No user/assistant messages and ≤6 events.' },
                        noTitle: { type: 'boolean', description: 'No title event and no user message to derive one.' },
                        olderThanDays: { type: 'number', description: 'mtime older than N days.' },
                        minBytes: { type: 'number', description: 'Size lower bound (bytes).' },
                        maxBytes: { type: 'number', description: 'Size upper bound (bytes).' },
                        integrity: { type: 'string', enum: ['ok', 'torn', 'unreadable'], description: 'torn = undecodable frames/lines; unreadable = no events. Sequence gaps are NOT a health signal (subagent/early logs use a parent/global counter).' },
                    },
                },
                fields: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Columns. Cheap: id, when, bytes, slug, fileCount. Heavy (one decode, cached): events, turns, messages, title, integrity, lastUserAt.',
                },
                sort: { type: 'string', enum: ['mtime', 'bytes', 'events'], description: 'mtime (default) | bytes | events.' },
                offset: { type: 'number', description: 'Skip N rows after filtering.' },
                session: { type: 'string', description: 'subagents: session id, id prefix or "last" (default "last").' },
                gcRoot: { type: 'string', description: 'subagents: subagent GC backup root (default ~/.dsh/subagent-gc-backup).' },
            },
        },
        output: {
            schema: { type: 'string' },
            render(args, value) {
                const t = (args?.kind ?? 'sessions') === 'subagents' ? catalogImpl : null
                return t?.output?.render ? t.output.render(args, value) : [{ type: 'text', text: String(value) }]
            },
        },
        async execute(args, exec) {
            const kind = typeof args?.kind === 'string' && args.kind !== '' ? args.kind : 'sessions'
            if (!Object.hasOwn(PARAMS_OF_LIST, kind)) throw new Error(`未知 kind ${JSON.stringify(args?.kind)}；可用：sessions / subagents`)
            const allowed = new Set([...(PARAMS_OF_LIST[kind] ?? []), 'kind'])
            const strays = Object.keys(args ?? {}).filter((k) => !allowed.has(k))
            if (strays.length > 0) {
                throw new Error(`kind "${kind}" 不接受参数 ${strays.map((s) => JSON.stringify(s)).join(', ')}（该 kind 可用：${(PARAMS_OF_LIST[kind] ?? []).join(', ')}）`)
            }
            if (kind === 'subagents') return await catalogImpl.execute(args, exec)

            // ---- kind: sessions（本工具自己实现：谓词 / 字段 / 排序 / 分页）----
            const all = listSessionDirs()
            let pool = all
            let scopeNote = ''
            if (args?.cwd) {
                const want = String(args.cwd)
                let scoped = all.filter((s) => s.slug === slugOf(want))
                if (scoped.length === 0) scoped = all.filter((s) => cwdOfSessionHead(s) === want)
                if (scoped.length === 0) return `no session logs under ${sessionsRoot()} for workspace ${want}（slug=${slugOf(want)}；全库 ${all.length} 个文件）。不传 cwd 可看全部`
                pool = scoped
                scopeNote = ` (filtered by cwd=${want}, slug=${slugOf(want)})`
            }
            const clampInt = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d }
            // 体型校验：这几个参数**错用时会静默出错**（数组当对象、字符串当布尔、NaN 比较恒 false ⇒ 静默空结果），
            // 所以宁可显式拒绝并列出可用值 —— 判据同 postures：「清晰报错 = 可接受，静默错 = 必须修」。
            if (args?.limit !== undefined && !Number.isFinite(Number(args.limit))) throw new Error(`limit 必须是数字（收到 ${JSON.stringify(args.limit)}）`)
            if (args?.offset !== undefined && !Number.isFinite(Number(args.offset))) throw new Error(`offset 必须是数字（收到 ${JSON.stringify(args.offset)}）`)
            const wantLimit = Number(args?.limit ?? 20)
            const limit = clampInt(wantLimit, 20, 1, 1000)
            const offset = clampInt(args?.offset, 0, 0, 1_000_000)
            const where = args?.where === undefined ? null : args.where
            if (where !== null && (typeof where !== 'object' || Array.isArray(where))) {
                throw new Error(`where 必须是对象（如 {"empty":true}），收到 ${Array.isArray(args?.where) ? '数组' : JSON.stringify(args?.where)}；可用谓词：empty / noTitle / olderThanDays / minBytes / maxBytes / integrity`)
            }
            if (where !== null) {
                const shapes = { empty: 'boolean', noTitle: 'boolean', olderThanDays: 'number', minBytes: 'number', maxBytes: 'number', integrity: 'string' }
                const unknown = Object.keys(where).filter((k) => !Object.hasOwn(shapes, k))
                if (unknown.length > 0) throw new Error(`where 不认识 ${unknown.join(', ')}；可用：${Object.keys(shapes).join(' / ')}`)
                for (const [key, type] of Object.entries(shapes)) {
                    const value = where[key]
                    if (value === undefined) continue
                    if (typeof value !== type) throw new Error(`where.${key} 必须是 ${type}（收到 ${JSON.stringify(value)}）`)
                    if (type === 'number' && !(Number.isFinite(value) && value >= 0)) throw new Error(`where.${key} 必须是非负有限数（收到 ${JSON.stringify(value)}）`)
                }
                if (typeof where.integrity === 'string' && !['ok', 'torn', 'unreadable'].includes(where.integrity)) {
                    throw new Error(`where.integrity 只能是 ok / torn / unreadable（收到 ${JSON.stringify(where.integrity)}）；"gaps" 不是健康信号：seq 在子代理会话里是父会话计数、早期日志里是宿主全局计数`)
                }
                if (where.minBytes !== undefined && where.maxBytes !== undefined && where.minBytes > where.maxBytes) {
                    throw new Error(`where.minBytes(${where.minBytes}) 大于 maxBytes(${where.maxBytes})：区间反了，这样永远筛不出东西`)
                }
            }
            const FIELD_NAMES = ['id', 'when', 'bytes', 'slug', 'fileCount', 'events', 'turns', 'messages', 'title', 'integrity', 'lastUserAt']
            if (args?.fields !== undefined && !Array.isArray(args.fields)) {
                throw new Error(`fields 必须是字符串数组（如 ["id","events"]），收到 ${JSON.stringify(args.fields)}`)
            }
            if (Array.isArray(args?.fields)) {
                const bad = args.fields.map(String).filter((f) => !FIELD_NAMES.includes(f))
                if (bad.length > 0) throw new Error(`fields 不认识 ${bad.join(', ')}；可用：${FIELD_NAMES.join(' / ')}`)
            }
            const requested = Array.isArray(args?.fields) && args.fields.length > 0 ? args.fields.map(String) : null
            if (args?.sort !== undefined && !['mtime', 'bytes', 'events'].includes(String(args.sort))) {
                throw new Error(`sort 只能是 mtime / bytes / events（收到 ${JSON.stringify(args.sort)}）`)
            }
            const HEAVY = new Set(['events', 'turns', 'messages', 'title', 'integrity', 'lastUserAt'])
            const hasPredicates = where !== null && Object.keys(where).length > 0
            const whereHeavy = Boolean(where && (where.empty !== undefined || where.noTitle !== undefined || where.integrity !== undefined))
            const sortKey = typeof args?.sort === 'string' ? args.sort : 'mtime'
            const needHeavy = whereHeavy || sortKey === 'events' || Boolean(requested && requested.some((f) => HEAVY.has(f)))

            const merged = sessionRows(pool)
            const index = needHeavy ? loadSessionIndex() : null
            const now = Date.now()
            const DAY = 86_400_000
            const prepared = []
            let computed = 0
            let startedHeavy = 0
            if (needHeavy) startedHeavy = Date.now()
            for (const row of merged) {
                let meta = null
                if (needHeavy) {
                    const before = index.entries[row.file]
                    meta = metaFor(row, index)
                    if (!before || before !== meta) computed += 1
                }
                if (where) {
                    if (where.olderThanDays !== undefined && !((now - row.mtime) >= Number(where.olderThanDays) * DAY)) continue
                    if (where.minBytes !== undefined && !(row.bytes >= Number(where.minBytes))) continue
                    if (where.maxBytes !== undefined && !(row.bytes <= Number(where.maxBytes))) continue
                    const isEmpty = meta ? (meta.messages === 0 && meta.events <= 6) : null
                    if (where.empty === true && isEmpty !== true) continue
                    if (where.empty === false && isEmpty !== false) continue
                    if (where.noTitle === true && meta?.title) continue
                    if (where.noTitle === false && !meta?.title) continue
                    if (typeof where.integrity === 'string') {
                        if (integrityOf(meta) !== where.integrity) continue
                    }
                }
                prepared.push({ row, meta })
            }
            if (sortKey === 'bytes') prepared.sort((a, b) => b.row.bytes - a.row.bytes)
            else if (sortKey === 'events') prepared.sort((a, b) => (b.meta?.events ?? 0) - (a.meta?.events ?? 0))
            const heavyMs = needHeavy ? Date.now() - startedHeavy : 0
            if (needHeavy && computed > 0) saveSessionIndex(index)

            const page = prepared.slice(offset, offset + limit)
            const mb = (n) => (n / 1024 / 1024).toFixed(1)
            const when = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19)
            const versionOf = (file) => (file.match(/session(\.v\d+)?\.jsonl\.zstd$/) ?? [])[1] ?? ''
            const lines = page.map(({ row, meta }) => {
                const ver = versionOf(row.file)
                const extra = row.fileCount > 1 ? `  files=${row.fileCount}(newest ${ver || '.v1'})` : (ver ? `  ${ver}` : '')
                if (requested === null) return `${row.id}  ${when(row.mtime)}  ${mb(row.bytes)} MB  ${row.slug}${extra}`
                const cols = requested.map((f) => {
                    switch (f) {
                        case 'id': return row.id
                        case 'when': return when(row.mtime)
                        case 'bytes': return `${mb(row.bytes)} MB`
                        case 'slug': return row.slug
                        case 'fileCount': return `${row.fileCount}${extra}`
                        case 'events': return `events=${meta?.events ?? '?'}`
                        case 'turns': return `turns=${meta?.turns ?? '?'}`
                        case 'messages': return `messages=${meta?.messages ?? '?'}`
                        case 'integrity': return `integrity=${integrityOf(meta)}`
                        case 'lastUserAt': return `lastUserAt=${meta?.lastUserAt ? when(meta.lastUserAt) : '-'}`
                        case 'title': return `title=${meta?.title ? JSON.stringify(meta.title) : '-'}`
                        default: return `${f}=?(未知字段)`
                    }
                })
                return cols.join('  ')
            })
            if (prepared.length === 0 && merged.length > 0) {
                return [
                    `sessions root: ${sessionsRoot()}`,
                    `total: ${merged.length} session(s) / ${pool.length} file(s)${scopeNote}`,
                    `no session matched the filter（${merged.length} 个会话全部被 where/offset 排除；放宽 where 或去掉 offset）`,
                    hasPredicates ? `本轮的 where：${JSON.stringify(where)}` : '',
                ].filter((line) => line !== '').join('\n')
            }
            if (prepared.length === 0) {
                return [
                    `sessions root: ${sessionsRoot()}`,
                    `total: 0 session(s) / ${pool.length} file(s)${scopeNote}`,
                    `no session logs under ${sessionsRoot()}`,
                ].join('\n')
            }
            const notes = []
            if (wantLimit !== limit) notes.push(`（limit=${JSON.stringify(args?.limit)} 已夹到 ${limit}）`)
            if (prepared.length > offset + page.length) notes.push(`（筛选后共 ${prepared.length} 个会话，offset=${offset}，只显示 ${page.length} 个）`)
            if (needHeavy) notes.push(`（重列按需计算：本次解码 ${computed} 个会话，用时 ${heavyMs} ms${computed === 0 ? '，其余命中缓存' : ''}；缓存 ${sessionIndexFile()}）`)
            return [
                `sessions root: ${sessionsRoot()}`,
                `total: ${prepared.length} session(s) / ${pool.length} file(s)${scopeNote}${hasPredicates ? '  [filtered]' : ''}`,
                ...lines,
                ...(notes.length ? ['', ...notes] : []),
            ].join('\n')
        },
    })

    const readTool = tool({
        name: 'session_read',
        description:
            'Read events from session logs. `pattern` greps them (JS regex; backtracking rejected) — in this one session by default, or across sessions with `scope` (grouped, bounded by `limit`/`maxHitsPerSession`). ' +
            'Without `pattern`, return the last `tail` events — the quick "what just happened?" view. Read-only.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                session: { type: 'string', description: 'Session id, prefix, or "last" (default). Ignored when scope is workspace/all.' },
                cwd: { type: 'string', description: 'Disambiguate "last"; also the workspace that scope=workspace searches.' },
                pattern: { type: 'string', description: 'JS regex. Omit to read the last `tail` events instead.' },
                flags: { type: 'string', description: 'Regex flags (default "i").' },
                tail: { type: 'number', description: 'Without pattern: how many events from the end (default 20).' },
                limit: { type: 'number', description: 'With pattern: max matches (default 30); total cap across sessions.' },
                width: { type: 'number', description: 'Preview width per event (default 160).' },
                scope: { type: 'string', enum: ['session', 'workspace', 'all'], description: 'session (default) | workspace | all. Needs pattern.' },
                maxHitsPerSession: { type: 'number', description: 'Cross-session: per-session cap (default 5).' },
            },
        },
        output: {
            schema: { type: 'string' },
            render(args, value) {
                const cross = typeof args?.scope === 'string' && args.scope !== 'session'
                const t = cross ? null : (typeof args?.pattern === 'string' && args.pattern !== '' ? grepImpl : peekImpl)
                return t?.output?.render ? t.output.render(args, value) : [{ type: 'text', text: String(value) }]
            },
        },
        async execute(args, exec) {
            const scope = typeof args?.scope === 'string' && args.scope !== '' ? args.scope : 'session'
            const mode = typeof args?.pattern === 'string' && args.pattern !== '' ? 'grep' : 'peek'
            if (scope !== 'session' && mode !== 'grep') throw new Error('scope=workspace/all 只用于检索：请同时给出 pattern（只想看最近事件就保持 scope 默认 "session"）')
            if (scope !== 'session' && args?.session !== undefined) throw new Error('scope=workspace/all 时不接受 session（要指定单个会话就用默认 scope，或把 pattern 写窄）')
            if (!['session', 'workspace', 'all'].includes(scope)) throw new Error(`未知 scope ${JSON.stringify(args?.scope)}；可用：session / workspace / all`)
            const allowed = new Set([...(PARAMS_OF_READ[mode] ?? []), 'kind'])
            const strays = Object.keys(args ?? {}).filter((k) => !allowed.has(k))
            if (strays.length > 0) {
                const hint = mode === 'peek' && strays.includes('limit')
                    ? '（不给 pattern 时用 tail 指定条数；要按正则过滤就给 pattern）'
                    : mode === 'grep' && strays.includes('tail')
                        ? '（给 pattern 后就按 limit 限制命中数；tail 只在“读最后 N 条”时用）'
                        : ''
                throw new Error(`session_read ${mode === 'grep' ? '按 pattern 过滤时' : '读最后 N 条时'}不接受参数 ${strays.map((s) => JSON.stringify(s)).join(', ')}${hint}（可用：${(PARAMS_OF_READ[mode] ?? []).join(', ')}）`)
            }
            if (scope === 'session') return await (mode === 'grep' ? grepImpl : peekImpl).execute(args, exec)
            return await searchAcrossSessions(args, exec, scope, cwdFor(args, exec, undefined))
        },
    })

    return [listTool, readTool, tool(diffImpl), tool(exportImpl)]
}

export function apply(ctx, defineTool, options = {}) {
    const list = tools(defineTool, options)
    for (const t of list) ctx.tools.register(t)
    return list.length
}

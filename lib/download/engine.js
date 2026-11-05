/**
 * lib/download/engine.js —— 多线程分片下载引擎。
 *
 * 模型**借鉴 aria2 的分片语义**（自己实现，未抄代码；aria2 是 GPLv2，本插件是 MIT）：
 *  - 固定大小的 **chunk 队列 + N 个 worker 工作窃取**（对应 aria2 的 piece + `--stream-piece-selector`）：
 *    谁先干完谁接着拿下一块 ⇒ 快的连接自然多干活，不会出现"某一片特别慢把整体拖住"；
 *  - **`minSplitSize`**（对应 `-k/--min-split-size`）：小于这个大小的尾巴并进前一块，不切碎；
 *  - **`lowestSpeedLimit`**（对应 `--lowest-speed-limit`，本工具**默认开启**）：某块持续低于该速率就
 *    **把它剩下的范围从中间劈开、后半段扔回队列** ⇒ 卡住的连接不再拖住整包（这正是"走 代理软件 代理就卡"的对策）；
 *  - **断点续传**：数据写 `<to>.part`，进度（每块 start/end/done）写 `<to>.part.manifest.json`；
 *    续传前比对 finalUrl/total/etag/last-modified，远端变了就重来（避免两个版本拼成一个坏文件）；
 *  - **收尾原子改名**：长度校验 + sha256（给没给期望值都自算一次）通过后才 `rename(.part → to)`；
 *  - 服务器不支持 Range ⇒ **明确回退单流**，绝不假装多线程。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fetchFollowing, pingProxy, resolveProxyAsync } from './net.js'

export const MIN_SEGMENTED_BYTES = 1024 * 1024        // 小于 1 MB 不值得分片
export const DEFAULT_THREADS = 8
export const MAX_THREADS = 32                         // **手动**上限
export const AUTO_MAX_THREADS = 16                    // 自动档封顶（用户要求：32 容易招服务器反感）
export const THREAD_TIERS = [1, 2, 4, 8, 16]          // 自动档只在这些值里取（1/2/4/8/16 递进）
export const DEFAULT_MIN_SPLIT = 1024 * 1024          // 1 MB：比 aria2 的默认 20M 小，网页文件更常见
export const DEFAULT_LOWEST_SPEED = 8 * 1024          // 8 KB/s：低于它且持续 6 秒 ⇒ 劈开重排
export const DEFAULT_CHUNK_MAX = 32 * 1024 * 1024
export const SEGMENT_RETRIES = 3
export const MANIFEST_VERSION = 2                     // v2：segments → chunks（语义相同，多了"动态拆分"）
const PROGRESS_INTERVAL_MS = 400
const MANIFEST_SAVE_BYTES = 4 * 1024 * 1024
const SLOW_CHECK_MS = 2000
const SLOW_STRIKES = 3                                // 连续 3 次测速都低 ⇒ 判定为慢片
// **收尾慢**（用户 实测的 ABD 通病）：其他连接结束后，剩下的连接还停留在"均分份额"上不回升
const STALE_RATE_RATIO = 0.5          // 低于"本任务见过的最好速率"的这个比例 ⇒ 判定收尾慢
const STALE_STRIKES = 2               // 连续几次判定 ⇒ 动手（劈开 / 重连）
/**
 * 慢尾/慢片检测的**调参口**：默认值就是生产行为，只有自测会把它们调小 ——
 * 否则"收尾加速"那段的用例要按 2 s × 2 次的真实节奏等二十多秒（实测 28 s，占整份下载自测的 3/4）。
 * 用**惰性读**（不是模块加载时读）是为了让自测能在同一个进程里按段设置。
 */
const envPositive = (name, dflt) => {
    const v = Number(process.env[name])
    return Number.isFinite(v) && v > 0 ? v : dflt
}
const slowCheckMs = () => envPositive('DSH_DOWNLOAD_SLOW_CHECK_MS', SLOW_CHECK_MS)
const staleStrikes = () => envPositive('DSH_DOWNLOAD_STALE_STRIKES', STALE_STRIKES)
const MAX_RECONNECTS_PER_CHUNK = 3    // 每块最多重连几次（等价于自动"暂停/继续"）
export const TAIL_MIN_SPLIT = 512 * 1024   // 收尾劈开的**绝对下限**（minSplitSize 再小也不许切得比它碎）
const MAX_SPLITS_PER_CHUNK = 2        // 同一个块最多被劈几次（防“越切越碎”）
const MAX_TOTAL_CHUNKS = 2048         // 整包块数上限（防病态增长）
const MAX_GROW_ATTEMPTS = 3           // 每个下载最多几次"向上试探并发"（限连接数的站点别反复撞墙）
const REJECT_COOLDOWN_MS = 2500       // 同一次"并发突发"里的后续拒绝不再重复降档
/** 按主机记住"实测能跑几条并发连接"（限连接数的站点：下次直接从上限起步，少挨几轮 429） */
const HOST_CONCURRENCY_CAP = new Map()

export const partPathOf = (to) => `${to}.part`
export const manifestPathOf = (to) => `${to}.part.manifest.json`

const backoff = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 跟随重定向探测：Range 支持、总大小、校验器、代理信息、**每连接采样吞吐** */
export async function probeTarget({ url, headers = {}, proxy = 'auto', sampleBytes = 1024 * 1024, connections = 4, timeoutMs = 30000, signal = null, sample = true }) {
    const proxySpec = await resolveProxyAsync(proxy, new URL(url).hostname)
    if (proxySpec.kind !== 'none' && !(await pingProxy(proxySpec))) {
        throw new Error(`代理连不上：${proxySpec.host}:${proxySpec.port}（来源：${proxySpec.source}）—— 确认该代理是否在运行、地址端口是否正确；也可显式传 proxy:"http://…"／proxy:"socks5h://…" 指定你自己的代理，或 proxy:"direct" 直连`)
    }
    const head = await fetchFollowing({ url, headers: { ...headers, Range: 'bytes=0-0' }, proxyOption: proxy, timeoutMs, signal })
    head.stream.resume()
    const cr = head.headers['content-range']
    const rangeSupported = typeof cr === 'string' && /\/(\d+)\s*$/.test(cr)
    const total = rangeSupported ? Number(cr.split('/')[1]) : Number(head.headers['content-length'] ?? 0)
    const info = {
        requestedUrl: url,
        finalUrl: head.finalUrl,
        status: head.status,
        rangeSupported,
        acceptRanges: head.headers['accept-ranges'] ?? null,
        total: Number.isFinite(total) ? total : 0,
        contentType: head.headers['content-type'] ?? null,
        etag: head.headers['etag'] ?? null,
        lastModified: head.headers['last-modified'] ?? null,
        redirects: head.redirects,
        timings: head.timings,
        proxy: { kind: proxySpec.kind, host: proxySpec.host ?? null, port: proxySpec.port ?? null, source: proxySpec.source },
        samples: [],
    }
    if (!sample || info.total === 0) return info
    const n = clamp(Math.trunc(connections), 1, MAX_THREADS)
    const per = Math.max(64 * 1024, Math.min(Math.trunc(sampleBytes), Math.floor(info.total / n) || info.total))
    const jobs = []
    for (let i = 0; i < n; i += 1) {
        const start = i * per
        if (start >= info.total) break
        const end = Math.min(start + per - 1, info.total - 1)
        const t0 = Date.now()
        jobs.push((async () => {
            const r = await fetchFollowing({ url: info.finalUrl, headers, proxyOption: proxy, range: { start, end }, timeoutMs: 60000, signal })
            let got = 0
            for await (const chunk of r.stream) got += chunk.length
            const ms = Math.max(1, Date.now() - t0)
            return { connection: i, bytes: got, ms, mbps: got / 1048576 / (ms / 1000), status: r.status }
        })().catch((error) => ({ connection: i, bytes: 0, ms: Date.now() - t0, mbps: 0, error: String(error.message ?? error).slice(0, 80) })))
    }
    info.samples = await Promise.all(jobs)
    const ok = info.samples.filter((s) => s.error === undefined && s.bytes > 0)
    if (ok.length > 0) {
        const rates = ok.map((s) => s.mbps).sort((a, b) => a - b)
        info.sampleSummary = {
            connections: ok.length,
            minMbps: rates[0],
            medianMbps: rates[Math.floor(rates.length / 2)],
            maxMbps: rates[rates.length - 1],
            aggregateMbps: rates.reduce((s, x) => s + x, 0),
            failed: info.samples.length - ok.length,
        }
    }
    return info
}

export async function readManifest(to) {
    try {
        const raw = await readFile(manifestPathOf(to), 'utf8')
        const m = JSON.parse(raw)
        if (!m || (m.version !== MANIFEST_VERSION && m.version !== 1)) return null
        // v1 的 segments 字段名迁移成 chunks（结构一致）
        if (m.chunks === undefined && Array.isArray(m.segments)) m.chunks = m.segments
        return m
    }
    catch { return null }
}

const saveManifest = async (to, manifest) => {
    manifest.updatedAt = new Date().toISOString()
    await writeFile(manifestPathOf(to), JSON.stringify(manifest, null, 2))
}

const manifestStillValid = (manifest, info) => manifest !== null
    && manifest.total === info.total
    && manifest.finalUrl === info.finalUrl
    && (manifest.etag ?? null) === (info.etag ?? null)
    && (manifest.lastModified ?? null) === (info.lastModified ?? null)

async function fileSize(path) {
    try { return (await stat(path)).size }
    catch { return 0 }
}

/**
 * 打开（必要时创建）.part 用于**定位写**。
 * ⚠️ 绝不能用 `'a+'`：`O_APPEND` 会让 position 参数失效、所有写都追加到末尾 ⇒ 分片乱序落盘，
 * **大小对、内容错**（本地夹具实测，只有 sha256 校验才发现）。
 */
async function openPart(part) {
    if ((await fileSize(part)) === 0) {
        const created = await open(part, 'w')
        await created.close()
    }
    return open(part, 'r+')
}

/** 只认"用户主动中止" —— 不能看错误文本：服务器中途断流时 Node 的响应流也报 `aborted`。 */
const isUserAbort = (signal, error) => signal?.aborted === true || String(error?.name ?? '') === 'AbortError'

/**
 * **自动线程数决策**（用户要求"小文件少线程、大文件多线程、也可手动指定"）。
 *
 * 输入是探测结果（总大小 + 每连接采样吞吐），输出 `{ threads, reason }` —— reason 会被回显给用户，
 * 让人看得出"为什么是这个数"，而不是一个黑箱数字。
 *
 * 两条依据相乘：
 *  1. **大小档**（小文件连接开销占比高，多线程反而更慢：真链接实测 4.2 MB 单流 24 MB/s、8 线程 19 MB/s）；
 *  2. **实测增益**（`合计 ÷ 中位单连接`）—— 增益不明显说明瓶颈不在"每连接限速"（例如 CDN 不限单连接），
 *     那就收敛线程数，别去无谓地多开连接。
 * 再按"有用的分片数"封顶（片再小也没意义，`planChunks` 里有 minSplit 下限）。
 */
export function planThreads({
    total = 0,
    rangeSupported = true,
    sampleSummary = null,
    requested = null,
    minSplitSize = DEFAULT_MIN_SPLIT,
    maxThreads = AUTO_MAX_THREADS,
} = {}) {
    const manualCap = MAX_THREADS
    if (requested !== null && requested !== undefined && Number.isFinite(Number(requested))) {
        // 手动：允许到 32（用户明确说 32 只在手动时允许）
        return { threads: clamp(Math.trunc(Number(requested)), 1, manualCap), reason: '手动指定' }
    }
    const cap = clamp(Math.trunc(maxThreads), 1, AUTO_MAX_THREADS)
    if (!rangeSupported) return { threads: 1, reason: '服务器不支持 Range ⇒ 只能单流' }
    if (!(total > 0)) return { threads: Math.min(4, cap), reason: '拿不到总大小 ⇒ 保守取 4' }

    const MB = 1024 * 1024
    // **递进档**（用户偏好 1/2/4/8/16，不要 3/6/12 这种零碎值）
    const sizeTier = total < 1 * MB ? 1
        : total < 8 * MB ? 2
            : total < 64 * MB ? 4
                : total < 512 * MB ? 8
                    : 16
    // 小文件（<1 MB）直接单流：连接建立 + 收尾校验的开销比省下的时间还多
    if (sizeTier === 1) return { threads: 1, reason: `文件很小（${(total / 1024).toFixed(0)} KB < 1 MB）⇒ 单流更划算` }
    const gain = (sampleSummary !== null && sampleSummary.connections >= 2 && sampleSummary.medianMbps > 0)
        ? sampleSummary.aggregateMbps / sampleSummary.medianMbps
        : null
    let threads = sizeTier
    let reason = gain === null
        ? `按大小档（${(total / MB).toFixed(1)} MB ⇒ ${sizeTier}），无可用的吞吐采样`
        : (gain >= 1.8
            ? `大小档 ${sizeTier} + 探测显示多连接有效（合计 ≈ ${gain.toFixed(1)}× 单连接）`
            : `探测显示多连接收益不明显（合计 ≈ ${gain.toFixed(1)}× 单连接）⇒ 折半收敛到 ${Math.max(1, sizeTier / 2)}`)
    // 收益不明显 ⇒ **折半**（保持 1/2/4/8/16 的递进）
    if (gain !== null && gain < 1.8) threads = Math.max(1, Math.floor(sizeTier / 2))
 // **慢链路要更多连接**（GitHub 实测）：走代理时每连接可能只有 0.2~0.4 MB/s，
    // 而连接加上去总带宽还会涨（同一文件：4 连接 3.77 MB/s、16 连接 7.72 MB/s）⇒ 大小档太保守。
    // 判据：多连接确实有效（gain ≥ 1.8）**且**每连接很慢（< 1 MB/s）⇒ 档位 ×4（仍受自动上限约束）。
    else if (gain !== null && gain >= 1.8 && sampleSummary.medianMbps < 1.0) {
        const boosted = Math.min(cap, Math.max(sizeTier, sizeTier * 4))
        if (boosted > threads) {
            reason += `；每连接仅 ${sampleSummary.medianMbps.toFixed(2)} MB/s（慢链路）⇒ 提到 ${boosted}`
            threads = boosted
        }
    }

    // 封顶到自动档上限（≥512 MB 档正好是 16，与 AUTO_MAX_THREADS 一致；这里防参数被改坏）
    if (threads > cap) {
        reason += `；自动档上限 ${cap} ⇒ 收敛到 ${cap}`
        threads = cap
    }
    // 片再小没意义：别开出比"**实际会切出的片数**"更多的连接。
    // ⚠️ 必须用 `planChunks` 的真实结果（它会对小文件放宽片下限），不能再用 minSplitSize 估算 ——
 // 否则 2 MB 的文件会被算成"只够 2 片"而把并发压到 2（实测）。
    const useful = Math.max(1, planChunks(total, Math.max(1, threads), minSplitSize).length)
    if (threads > useful) {
        const snapped = [...THREAD_TIERS].reverse().find((t) => t <= useful) ?? 1
        if (snapped !== threads) reason += `；实际只切出 ${useful} 片 ⇒ 收敛到 ${snapped}`
        threads = snapped
    }
    return { threads: clamp(threads, 1, cap), reason }
}

/**
 * **分块的最小大小与覆盖性**（用户要求"剩下的小块不能一直分"）。
 *
 * - `canSplit(remaining, minSplit)`：还剩多少才允许再劈一刀 —— 劈完两半都得不小于下限；
 * - `normalizeChunks(chunks, total, minSplit)`：把碎块并进相邻块、去重叠，并**校验覆盖**（0..total-1
 *   无空洞无重叠）。它既防"越切越碎"，也是"文件缺一块却改名成功"这类事故的结构性防线
 * （实测事故：动态劈出的块没人接手 ⇒ 缺口被当成成功）。
 */
export function canSplit(remaining, minSplitSize = DEFAULT_MIN_SPLIT) {
    const floor = Math.max(TAIL_MIN_SPLIT, Math.trunc(minSplitSize))
    return remaining >= 2 * floor
}

export function normalizeChunks(chunks, total, minSplitSize = DEFAULT_MIN_SPLIT) {
    const floor = Math.max(64 * 1024, Math.trunc(minSplitSize))
    const sorted = chunks.map((c) => ({ ...c })).sort((a, b) => a.start - b.start)
    const merged = []
    for (const c of sorted) {
        if (c.start > c.end) continue
        const prev = merged[merged.length - 1]
        if (prev === undefined) { merged.push(c); continue }
        // 与前一块重叠/相邻且（任一块小于下限）⇒ 合并
        if (c.start <= prev.end + 1 && (c.end - c.start + 1 < floor || prev.end - prev.start + 1 < floor)) {
            const prevDone = Math.min(prev.done ?? 0, prev.end - prev.start + 1)
            const cDone = Math.min(c.done ?? 0, c.end - c.start + 1)
            prev.end = Math.max(prev.end, c.end)
            prev.done = prevDone + cDone
            continue
        }
        // 与上一块相邻（无空洞）时也并起来 —— 相邻的小块没有分开的意义
        if (c.start === prev.end + 1 && (c.end - c.start + 1 < floor || prev.end - prev.start + 1 < floor)) {
            prev.end = c.end
            continue
        }
        merged.push(c)
    }
    // 覆盖性校验（用于"落盘前"的强断言）
    const gaps = []
    let cursor = 0
    for (const c of merged) {
        if (c.start > cursor) gaps.push(`${cursor}-${c.start - 1}`)
        cursor = Math.max(cursor, c.end + 1)
    }
    if (cursor < total) gaps.push(`${cursor}-${total - 1}`)
    return { chunks: merged, gaps }
}

/**
 * 按总大小与线程数切块（对应 aria2 的 piece）。
 *
 * ⚠️ 真链接实测踩到的坑：`size` 的下限若直接取 `minSplitSize`（默认 1 MB），
 * 2 MB 的文件会被切成 2 块、尾巴 1.0 MB 又因"小于 minSplit"被并回前一块 ⇒ **只剩 1 块**，
 * 多线程彻底失效（日志里 `threads=2 chunks=1`，用户感受就是"走了代理还是慢"）。
 * 所以下限改成 `min(minSplitSize, total/(threads*2))`：**小文件允许更小的片**，但保证切得出
 * ≥ 2×threads 块；尾巴合并也只在"尾巴确实很小（< size/2）"时才做。
 */
export function planChunks(total, threads, minSplit = DEFAULT_MIN_SPLIT, chunkMax = DEFAULT_CHUNK_MAX) {
    const n = clamp(Math.trunc(threads), 1, MAX_THREADS)
    const hardMin = 64 * 1024
    // 为了能切出 ≥2n 块，单片上限不能超过 total/(2n)；下限仍尊重用户的 minSplit（但不许把并行彻底掐死）
    const relaxFloor = Math.max(hardMin, Math.floor(total / Math.max(1, n * 2)))
    const floor = Math.max(hardMin, Math.min(Math.trunc(minSplit), relaxFloor))
    const size = clamp(Math.ceil(total / (n * 4)), floor, chunkMax)
    const chunks = []
    for (let start = 0; start < total; start += size) {
        const end = Math.min(start + size - 1, total - 1)
        chunks.push({ start, end, done: 0 })
    }
    // 尾巴确实很小（不到一块的一半）才并进前一块（aria2 的 "does not split less than 2*SIZE" 精神）
    if (chunks.length > 1) {
        const last = chunks[chunks.length - 1]
        if (last.end - last.start + 1 < Math.floor(size / 2)) {
            chunks.pop()
            chunks[chunks.length - 1].end = last.end
        }
    }
    return chunks
}

export async function sha256Of(path, signal = null) {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    for await (const chunk of stream) {
        if (signal?.aborted) throw new Error('aborted')
        hash.update(chunk)
    }
    return hash.digest('hex')
}

/**
 * **未知大小**资源的流式下载（服务器既没给 `Content-Length` 也不支持 Range；加）。
 *
 * 与分块路径的本质差别：没有 `total` ⇒ 没有偏移量、没有分片、没有长度校验。
 * 完整性只剩两条：① 用户给的 `sha256`（给了就**必**校验）；② HTTP 层无错且流正常结束。
 * 所以：**无断点续传**（旧 `.part` 一律丢掉重下）、**无多线程**、**无收尾加速**。
 * 进度上报 `total: 0` + `percent: 0`（让 worker 的 `percent.toFixed` 不炸；展示层看 `total > 0` 判断不出百分比）。
 * @returns 与 `downloadFile` 同形状的统计对象（额外 `unknownTotal: true`、`mode: 'stream'`）
 */
export async function downloadUnknownSize({
    url, to, headers = {}, proxy = 'auto', timeoutMs = 30000, signal = null, onProgress = null, log = () => {},
    info, expectedSha256 = null, expectedBytes = null, speedLimit = 0,
}) {
    const part = partPathOf(to)
    if (await fileSize(part) > 0) log('未知大小 + 不支持 Range ⇒ 无法续传：丢掉旧 .part，从头下')
    await rm(part, { force: true })
    await rm(manifestPathOf(to), { force: true })

    const handle = await open(part, 'w')
    const startedAt = Date.now()
    let downloaded = 0
    let lastTick = 0
    const report = (force = false) => {
        const now = Date.now()
        if (!force && now - lastTick < PROGRESS_INTERVAL_MS) return
        lastTick = now
        if (typeof onProgress === 'function') {
            const elapsed = Math.max(1, now - startedAt) / 1000
            onProgress({
                downloaded,
                total: 0,
                percent: 0,          // 没有总量 ⇒ 百分比无意义；给数字而不是 null（worker 会 toFixed）
                bytesPerSecond: downloaded / elapsed,
                elapsedMs: now - startedAt,
                active: downloaded > 0 ? 1 : 0,
                queued: 0,
                mode: 'stream',
                splits: 0,
                resplits: 0,
                reconnects: 0,
            })
        }
    }
    report(true)
    try {
        const res = await fetchFollowing({ url: info?.finalUrl ?? url, headers, proxyOption: proxy, timeoutMs, signal })
        if (res.status !== 200 && res.status !== 206) throw new Error(`无法下载：${info?.finalUrl ?? url} 返回 HTTP ${res.status}`)
        // ⚠️ `fetchFollowing` 返回的可读体是 Node 流 **`res.stream`**（不是 web 的 `res.body`）—— 重定向处理里
        // `res.stream.resume()` 就是证据；用它才能真正复用代理/重定向/超时那整套机制。
        if (res.stream === null || res.stream === undefined) throw new Error('响应没有可读流，未知大小资源无法流式落盘')
        for await (const chunk of res.stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (buf.length === 0) continue
            await handle.write(buf)
            downloaded += buf.length
            report()
            if (speedLimit > 0) {
                const expected = ((Date.now() - startedAt) / 1000) * speedLimit
                if (downloaded > expected + 256 * 1024) await new Promise((r) => setTimeout(r, 50))
            }
        }
        await handle.close()
        report(true)
    }
    catch (error) {
        try { await handle.close() } catch { /* 可能已关 */ }
        const aborted = isUserAbort(signal, error) || String(error?.message) === 'user-abort'
        const wrapped = new Error(aborted ? 'aborted' : error.message)
        wrapped.downloaded = downloaded
        wrapped.total = 0
        wrapped.partKept = true
        throw wrapped
    }

    // 未知大小只能在**下载后**核对期望字节数（服务端没给，没法提前比）
    if (expectedBytes !== null && expectedBytes !== undefined && Number(expectedBytes) !== downloaded) {
        throw new Error(`期望大小 ${expectedBytes} 字节，但实际收到 ${downloaded} 字节（未知大小资源只能事后核对）—— .part 保留：${part}`)
    }
    const digest = await sha256Of(part, signal)
    if (expectedSha256 !== null && expectedSha256 !== undefined && expectedSha256 !== '') {
        const want = String(expectedSha256).toLowerCase().replace(/^sha256:/, '')
        if (digest !== want) {
            await rm(part, { force: true })
            throw new Error(`sha256 校验失败（期望 ${want.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…）—— 已删除 .part，请重下`)
        }
    }
    await rename(part, to)
    const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
    log(`完成（未知大小）${downloaded} 字节，${seconds.toFixed(1)} s，${(downloaded / 1048576 / seconds).toFixed(1)} MB/s，sha256=${digest}`)
    return {
        ok: true,
        to,
        bytes: downloaded,
        seconds,
        mbps: downloaded / 1048576 / seconds,
        mode: 'stream',
        unknownTotal: true,
        threads: 1,
        chunks: 1,
        splits: 0,
        resplits: 0,
        reconnects: 0,
        downgrades: 0,
        noRangeFallback: false,
        concurrency: 1,
        hostCap: null,
        resumedFrom: 0,
        sha256: digest,
        finalUrl: info?.finalUrl,
        proxy: info?.proxy,
    }
}

/**
 * 下载（chunk 队列 + 工作窃取 + 慢片动态拆分）。
 * @returns 统计对象；中止时抛 `Error('aborted')`（`.part`/manifest 保留，可续）
 */
export async function downloadFile({
    url,
    to,
    threads = DEFAULT_THREADS,
    headers = {},
    proxy = 'auto',
    resume = true,
    overwrite = false,
    expectedSha256 = null,
    expectedBytes = null,
    minSplitSize = DEFAULT_MIN_SPLIT,
    lowestSpeedLimit = DEFAULT_LOWEST_SPEED,
    speedLimit = 0,                  // 全局限速（字节/秒），0 = 不限
    tailBoost = true,                // 收尾加速：慢尾自动劈开/重连（等价于 ABD 的"暂停再继续"）
    timeoutMs = 30000,
    signal = null,
    onProgress = null,
    log = () => {},
    probeInfo = null,
}) {
    if (typeof to !== 'string' || to === '') throw new Error('必须给 to（目标文件路径）')
    const wants = clamp(Math.trunc(threads), 1, MAX_THREADS)
    const info = probeInfo ?? await probeTarget({ url, headers, proxy, signal, sample: false, timeoutMs })
    if (info.status !== 200 && info.status !== 206) throw new Error(`无法下载：${info.finalUrl} 返回 HTTP ${info.status}`)
 // **未知大小**（服务器既没给 Content-Length 也不支持 Range，加）⇒ 走单连接流式落盘（边下边存，直到流结束）。
    // 这条分支绕过了长度校验（没有 total 可比）：完整性只剩 sha256（用户给了才有）+“HTTP 层无错、流正常结束”；
    // 也因此**无断点续传、无多线程、无收尾加速**（那三者都建立在偏移量模型上）。文案必须说清，不能让人以为“下载成功＝内容完整”。
    const unknownTotal = !(info.total > 0)
    if (!unknownTotal && expectedBytes !== null && expectedBytes !== info.total) {
        throw new Error(`期望大小 ${expectedBytes} 字节，但服务器给的是 ${info.total} 字节（URL 变了？）`)
    }
    await mkdir(dirname(to), { recursive: true })

    const existing = await fileSize(to)
    if (existing > 0 && !overwrite) {
        throw new Error(`目标已存在（${existing} 字节）：${to} —— 要覆盖请传 overwrite:true；要续传请确保上次留下的是 ${partPathOf(to)}（.part + .part.manifest.json）`)
    }

    if (unknownTotal) {
        return await downloadUnknownSize({
            url, to, headers, proxy, timeoutMs, signal, onProgress, log, info,
            expectedSha256, expectedBytes, speedLimit,
        })
    }

    const part = partPathOf(to)
    let manifest = resume ? await readManifest(to) : null
    const partSizeBefore = await fileSize(part)
    if (manifest !== null && !manifestStillValid(manifest, info)) {
        log('远端内容变了（etag/大小/最终 URL 不一致）⇒ 丢掉旧 .part 重新下')
        await rm(part, { force: true })
        await rm(manifestPathOf(to), { force: true })
        manifest = null
    }
    if (manifest === null) {
        await rm(part, { force: true })
        await rm(manifestPathOf(to), { force: true })
    }

    const segmented = info.rangeSupported && info.total >= MIN_SEGMENTED_BYTES && wants > 1
    const mode = segmented ? 'segmented' : 'single'
    if (!info.rangeSupported && wants > 1) log('服务器不支持 Range ⇒ 回退单流（多线程无意义）')

    if (manifest !== null) {
        // 续传：重建队列 —— 未完成的块回到队列，尾巴过小就并进前一块
        const pending = manifest.chunks
            .map((c) => ({ start: c.start + Math.min(c.done ?? 0, c.end - c.start + 1), end: c.end, done: 0 }))
            .filter((c) => c.start <= c.end)
        const doneBytes = manifest.chunks.reduce((s, c) => s + Math.min(c.done ?? 0, c.end - c.start + 1), 0)
        log(`续传：已有 ${(doneBytes / 1048576).toFixed(1)} MB，剩 ${(pending.reduce((s, c) => s + (c.end - c.start + 1), 0) / 1048576).toFixed(1)} MB（${pending.length} 块）`)
        if (pending.length > 1) {
            const last = pending[pending.length - 1]
            if (last.end - last.start + 1 < Math.max(64 * 1024, Math.trunc(minSplitSize))) {
                pending.pop()
                pending[pending.length - 1].end = last.end
            }
        }
        manifest.chunks = pending.length > 0 ? pending : [{ start: 0, end: info.total - 1, done: 0 }]
    }
    else {
        manifest = {
            version: MANIFEST_VERSION,
            url,
            finalUrl: info.finalUrl,
            total: info.total,
            etag: info.etag,
            lastModified: info.lastModified,
            threads: segmented ? wants : 1,
            minSplitSize,
            chunks: segmented ? planChunks(info.total, wants, minSplitSize) : [{ start: 0, end: info.total - 1, done: 0 }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }
    }
    await saveManifest(to, manifest)

    const handle = await openPart(part)
    const totalDone = () => manifest.chunks.reduce((s, x) => s + Math.min(x.done ?? 0, x.end - x.start + 1), 0)
    let downloaded = totalDone()
    const startedAt = Date.now()
    let lastTick = 0
    let savedBytes = downloaded
    let throttledBytes = 0
    const throttleStart = Date.now()
    let splits = 0
    // ---- 收尾加速（用户的 ABD 经验：靠"暂停再继续"重置连接；这里自动化）----
    // `bestRate` 的**基准**优先取探测阶段测到的"每连接中位速率"：真实场景里"快块可能压根没留下采样"
    // （夹具实测：快块 2 秒内就下完 ⇒ bestRate 只剩慢连接自己的速率 ⇒ stale 永不成立、加速形同虚设）。
    let bestRate = info?.sampleSummary?.medianMbps > 0 ? (info.sampleSummary.medianMbps * 1024 * 1024) / 1000 : 0
    let resplits = 0            // 因"收尾慢 + 有空闲连接"而劈开的次数
    let reconnects = 0          // 因"收尾慢"而断开重连的次数（等价于自动暂停/继续）
    const Threads = Math.max(1, Math.min(manifest.threads, manifest.chunks.length))
    const activeChunks = () => manifest.chunks.filter((x) => x.done < x.end - x.start + 1).length

    const report = (force = false) => {
        const now = Date.now()
        if (!force && now - lastTick < PROGRESS_INTERVAL_MS) return
        lastTick = now
        if (typeof onProgress === 'function') {
            const elapsed = Math.max(1, now - startedAt) / 1000
            onProgress({
                downloaded,
                total: manifest.total,
                percent: manifest.total === 0 ? 100 : (downloaded / manifest.total) * 100,
                bytesPerSecond: downloaded / elapsed,
                elapsedMs: now - startedAt,
                active: activeChunks(),
                queued: manifest.chunks.filter((x) => x.done === 0 && x.pending !== true && x.done < x.end - x.start + 1).length,
                mode,
                splits,
                resplits,
                reconnects,
            })
        }
    }
    const persist = async (force = false) => {
        if (!force && downloaded - savedBytes < MANIFEST_SAVE_BYTES) return
        savedBytes = downloaded
        await saveManifest(to, manifest)
    }
    const maybeThrottle = async () => {
        if (speedLimit <= 0) return
        const elapsed = (Date.now() - throttleStart) / 1000
        const expected = elapsed * speedLimit
        if (throttledBytes + downloaded > expected + 256 * 1024) {
            // 超出配额的 256 KB 就小睡一下（令牌桶的简化版）
            const over = throttledBytes + downloaded - expected
            await backoff(Math.min(1000, Math.ceil((over / speedLimit) * 1000)))
        }
        throttledBytes = Math.max(0, expected - downloaded)
    }

    /** 一块的下载循环：断流从 `done` 续请求；返回 true 表示被"慢片拆分"打断（剩余范围已回队列） */
    const runChunk = async (chunk, onRejected = null, chunkSignal = null) => {
        // `noteRejection` 由下面的并发控制段定义（闭包在调用时才解析）：
        // 任何一次 403/429/503 都要反馈给并发控制，哪怕这次重试最终成功了。
        let attempt = 0
        let slowStrikes = 0
        let markBytes = chunk.done
        let markAt = Date.now()
        while (chunk.done < chunk.end - chunk.start + 1) {
            if (signal?.aborted) throw new Error('user-abort')
            const start = chunk.start + chunk.done
            const maxAttempts = SEGMENT_RETRIES
            attempt += 1
            try {
                const res = await fetchFollowing({ url: info.finalUrl, headers, proxyOption: proxy, range: { start, end: chunk.end }, timeoutMs, signal: chunkSignal ?? signal })
                if (res.status !== 206 && res.status !== 200) {
                    const err = new Error(`块 ${chunk.start}-${chunk.end} 返回 HTTP ${res.status}`)
                    err.status = res.status
                    // `Retry-After`（秒或 HTTP 日期）：429/503 时服务器会告诉我们等多久
                    const ra = res.headers?.['retry-after']
                    if (ra !== undefined) {
                        const secs = Number(ra)
                        err.retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(ra) - Date.now())
                    }
                    throw err
                }
                if (res.status === 200 && start !== 0) {
                    res.stream.destroy()
                    const err = new Error(`块 ${chunk.start}-${chunk.end}：服务器忽略了 Range（返回 200）—— 该站点不支持分段/断点续传`)
                    err.code = 'RANGE_IGNORED'
                    throw err
                }
                let writeAt = start
                for await (const piece of res.stream) {
                    if ((chunkSignal ?? signal)?.aborted) { res.stream.destroy(); throw new Error('user-abort') }
                    await handle.write(piece, 0, piece.length, writeAt)
                    writeAt += piece.length
                    chunk.done += piece.length
                    downloaded += piece.length
                    report()
                    await persist()
                    await maybeThrottle()
                    // **慢片/收尾检测**：每 SLOW_CHECK_MS 看一次
                    //  ① 低于绝对阈值（lowestSpeedLimit）连续多次 ⇒ 从中间劈开，后半段扔回队列；
 // ② **收尾慢**（用户 报告：其他连接结束后，剩下的连接仍停留在"均分份额"
                    //     上不回升；ABD 靠"暂停再继续"重置连接）：当**有空闲 worker**、且本条速率明显低于
                    //     本任务见过的**最好速率**时 ⇒ ① 先尝试再劈开（让空闲连接一起收尾），
                    //     ② 连续 STALE_STRIKES 次仍慢 ⇒ **断开重连**（等价于自动"暂停/继续"，
                    //     新连接会重新分到带宽），每块最多重连 MAX_RECONNECTS_PER_CHUNK 次。
                    const now = Date.now()
                    if (now - markAt >= slowCheckMs()) {
                        const rate = ((chunk.done - markBytes) * 1000) / (now - markAt)
                        markBytes = chunk.done
                        markAt = now
                        if (rate > bestRate) bestRate = rate
                        const remaining = chunk.end - (chunk.start + chunk.done) + 1
                        // 收尾重连只是换个连接（不丢数据、代价极低），所以它的门槛比"劈开"低得多；
                        // 但**劈开**必须守 `canSplit()`（两半都不小于 max(TAIL_MIN_SPLIT, minSplitSize)）。
                        const tailFloor = 256 * 1024
                        const idleWorkers = Threads - activeChunks()
                        const stale = bestRate > 0 && rate < bestRate * STALE_RATE_RATIO

                        if (lowestSpeedLimit > 0 && rate < lowestSpeedLimit) {
                            slowStrikes += 1
                            // **分块下限**：劈完两半都不能小于 max(TAIL_MIN_SPLIT, minSplitSize)，且别越切越碎
                            if (slowStrikes >= SLOW_STRIKES && canSplit(remaining, minSplitSize)) {
                                const mid = chunk.start + chunk.done + Math.floor(remaining / 2)
                                res.stream.destroy()
                                manifest.chunks.push({ start: mid, end: chunk.end, done: 0 })
                                chunk.end = mid - 1
                                splits += 1
                                log(`块 ${chunk.start}-${chunk.end} 持续低速（${(rate / 1024).toFixed(1)} KB/s）⇒ 拆分：后半段 ${mid}-${manifest.chunks[manifest.chunks.length - 1].end} 交回队列（第 ${splits} 次）`)
                                report(true)
                                break
                            }
                        }
                        else slowStrikes = 0
                        // **收尾加速**（tailBoost）：本条速率远低于"本任务见过的最好速率" ⇒ 说明这条连接
                        // 停留在旧的均分份额上（其他连接退出后不回升）。**关键动作是断开重连**（= 自动
                        // "暂停/继续"：新连接会重新分到带宽）；若此刻还有空闲 worker，顺手把剩余范围劈一半
                        // 交回队列，让它立刻被另一条新连接接走。每块重连有上限，避免打转。
                        if (tailBoost && stale && remaining > tailFloor) {
                            chunk.staleStrikes = (chunk.staleStrikes ?? 0) + 1
                            if (chunk.staleStrikes >= staleStrikes() && (chunk.reconnects ?? 0) < MAX_RECONNECTS_PER_CHUNK) {
                                chunk.staleStrikes = 0
                                chunk.reconnects = (chunk.reconnects ?? 0) + 1
                                let tailNote = ''
                                // 劈开必须同时满足：① 有空闲连接；② **守分块下限**（canSplit）；
                                // ③ 这个块还没被劈夠次数；④ 总块数没到上限 —— 否则只重连、不再切碎
                                const splitsOfChunk = chunk.splits ?? 0
                                if (idleWorkers > 0 && canSplit(remaining, minSplitSize)
                                    && splitsOfChunk < MAX_SPLITS_PER_CHUNK && manifest.chunks.length < MAX_TOTAL_CHUNKS) {
                                    const mid = chunk.start + chunk.done + Math.floor(remaining / 2)
                                    manifest.chunks.push({ start: mid, end: chunk.end, done: 0 })
                                    chunk.end = mid - 1
                                    chunk.splits = splitsOfChunk + 1
                                    resplits += 1
                                    tailNote = `，并把后半段 ${mid}-${manifest.chunks[manifest.chunks.length - 1].end} 交回队列给空闲连接（第 ${resplits} 次劈开）`
                                }
                                else if (idleWorkers > 0) {
                                    // 说清"为什么不劈"，免得日志里只有重连让人觉得奇怪
                                    const why = !canSplit(remaining, minSplitSize)
                                        ? `剩余 ${(remaining / 1024).toFixed(0)} KB 不足以再劈（下限 ${(Math.max(TAIL_MIN_SPLIT, minSplitSize) / 1024).toFixed(0)} KB）`
                                        : (splitsOfChunk >= MAX_SPLITS_PER_CHUNK ? `该块已劈 ${splitsOfChunk} 次（上限 ${MAX_SPLITS_PER_CHUNK}）` : `总块数已达上限 ${MAX_TOTAL_CHUNKS}`)
                                    tailNote = `（未劈开：${why}）`
                                }
                                res.stream.destroy()
                                reconnects += 1
                                log(`收尾重连：块 ${chunk.start}-${chunk.end} 速率 ${(rate / 1024).toFixed(0)} KB/s 远低于最好 ${(bestRate / 1024).toFixed(0)} KB/s（空闲连接 ${idleWorkers}）⇒ 断开重连${tailNote}（该块第 ${chunk.reconnects}/${MAX_RECONNECTS_PER_CHUNK} 次，总计第 ${reconnects} 次）`)
                                report(true)
                                await backoff(120)
                                break
                            }
                        }
                        else if (!stale) chunk.staleStrikes = 0
                    }
                }
                attempt = 0
            }
            catch (error) {
                if (isUserAbort(chunkSignal ?? signal, error)) throw new Error('user-abort')
                const msg = error instanceof Error ? error.message : String(error)
                // **Range 被忽略**：这是结构性失败（该站点不支持分段），重试没意义 ⇒ 直接抛给上层回退单流
                if (error?.code === 'RANGE_IGNORED') throw error
                // **被拒也要反馈给并发控制**：即使这次重试后来成功了，也说明"刚才那条连接多了"
 // （实测：不反馈的话并发会悄悄长回去，第二次下载又去撞墙）
                const seenStatus = Number(error?.status ?? /HTTP (\d{3})/.exec(msg)?.[1] ?? 0)
                if ((seenStatus === 403 || seenStatus === 429 || seenStatus === 503) && typeof onRejected === 'function') {
                    onRejected(seenStatus, Number(error?.retryAfterMs) || 0)
                }
                if (attempt >= maxAttempts) {
                    // 把 HTTP 状态与 Retry-After 透出去：上层据此判断"服务器拒绝并发"并降线程
                    const status = Number(error?.status ?? /HTTP (\d{3})/.exec(msg)?.[1] ?? 0)
                    const finalError = new Error(`块 ${chunk.start}-${chunk.end} 重试 ${maxAttempts} 次仍失败（已写 ${chunk.done} 字节）：${msg}`)
                    if (status > 0) finalError.status = status
                    if (Number(error?.retryAfterMs) > 0) finalError.retryAfterMs = Number(error.retryAfterMs)
                    throw finalError
                }
                log(`块 ${chunk.start}-${chunk.end} 出错（已写 ${chunk.done} 字节，第 ${attempt} 次重试）：${msg}`)
                await backoff(400 * attempt)
            }
        }
    }

    let failure = null
    let downgrades = 0          // 因服务器拒绝并发（403/429/503）而**降线程**的次数
    const requestedConcurrency = Math.max(1, Math.min(manifest.threads, Math.max(1, manifest.chunks.length)))
 // **按主机记住"实测最多几条连接"**（用户 有的站点允许并发但限连接数，
    // 例如要 16 条只放 4 条）⇒ 同主机下次直接从这里起步，省掉一轮轮被拒
    const hostKey = (() => { try { return new URL(info.finalUrl ?? url).host } catch { return url } })()
    const learnedCap = HOST_CONCURRENCY_CAP.get(hostKey) ?? null
    let concurrency = learnedCap === null ? requestedConcurrency : Math.max(1, Math.min(requestedConcurrency, learnedCap))
    if (learnedCap !== null && learnedCap < requestedConcurrency) {
        log(`该主机上次实测最多 ${learnedCap} 条并发连接（记忆生效）⇒ 这次从 ${concurrency} 起步`)
    }
    let running = 0
    let noRangeFallback = false
    let lastRejectAt = 0
    let growAttempts = 0
    const rejectedRecently = () => Date.now() - lastRejectAt < 8000
    /**
     * **任何**一次 403/429/503 的反馈（包括被 runChunk 内部重试吸收掉的那些）：
     * 立刻把并发**降一档**并记住该主机上限，同时在 8 秒内禁止"向上试探"。
     * 这样"允许并发但限连接数"的站点会被稳稳压在它的上限内，而不是反复撞墙。
     */
    const noteRejection = (status, retryAfterMs) => {
        const now = Date.now()
        const burst = now - lastRejectAt < REJECT_COOLDOWN_MS
        lastRejectAt = now
        grownSinceReject = 0
        // **一次突发只降一档**：8 条一起撞上去会被拒 6-8 次，逐次降档会一路掉到 1 条，
 // 白白浪费服务器真正允许的并发（实测：限 2 条时被降到 1）。
        if (burst) return
        if (concurrency > 1) {
            const before = concurrency
            concurrency -= 1
            HOST_CONCURRENCY_CAP.set(hostKey, concurrency)
            log(`被拒（HTTP ${status}${retryAfterMs > 0 ? `，Retry-After ${(retryAfterMs / 1000).toFixed(1)}s` : ''}）⇒ 并发 ${before} → ${concurrency}，并记住该主机上限`)
        }
        else {
            HOST_CONCURRENCY_CAP.set(hostKey, 1)
        }
    }
    let grownSinceReject = 0
    let singleLaneRejects = 0      // 已降到单通道仍被拒的次数（有进展就清零）
    /** 等一个"并发名额"：服务器拒绝并发时会把 concurrency 调小，已在跑的连接照旧、新连接受控。
     *  返回 false ⇒ 本轮已被取消（例如回退单流），调用方要直接退出，**不能死等名额**。 */
    const acquire = async (runSignal = null) => {
        while (running >= concurrency) {
            if (runSignal !== null && runSignal.aborted) return false
            if (signal?.aborted) throw new Error('user-abort')
            await new Promise((r) => setTimeout(r, 120))
        }
        running += 1
        return true
    }
    try {
        for (let round = 0; round < 2; round += 1) {
            // 每轮一个"轮级取消"：回退单流前必须能让本轮所有 worker 立刻停下（见下面的 catch）
            const roundController = new AbortController()
            const runSignal = signal ? AbortSignal.any([signal, roundController.signal]) : roundController.signal
            const workers = Array.from({ length: concurrency }, async () => {
                while (true) {
                    if (runSignal.aborted) return
                    // ⚠️ 必须查**活的** `manifest.chunks`，不能用启动时的快照：动态劈出的块是 push 进
                    //    `manifest.chunks` 的，用快照就**永远看不见**它们 ⇒ 那一段没人下、文件缺一块却
 // 照样改名成功（收尾加速夹具实测：672768-1048575 从未被请求，内容错）。
                    const next = manifest.chunks.find((c) => c.done < c.end - c.start + 1 && c.claimed !== true)
                    if (next === undefined) return
                    next.claimed = true
                    if (!(await acquire(runSignal))) return
                    let grown = false
                    try { await runChunk(next, noteRejection, runSignal) }
                    catch (error) {
                        // **服务器忽略 Range**（明明说支持，实际返回整包 200）⇒ 回退单流重下，而不是报错
                        if (error?.code === 'RANGE_IGNORED' && round === 0) throw error
                        // **服务器拒绝并发**（403/429/503；"禁止多线程"或"限制连接数"）⇒ 降并发 + 把这块
                        // 放回队列，**绝不判死**：这块只是没轮到，等并发数降下来会再被领取。
                        const status = error?.status ?? 0
                        const rejected = status === 403 || status === 429 || status === 503
                        if (rejected) {
                            grownSinceReject = 0
                            lastRejectAt = Date.now()
                            if (concurrency <= 1) {
                                // ⚠️ 降到单通道还被拒 ≠ "站点禁止下载"：服务器上往往还有一条**残留连接**
                                //    （或刚触发限流）⇒ 先等一会儿重试几次，**有进展就不算失败**；连续多次
 // 毫无进展才如实报错（实测：限 2 条的站点被误判成"禁止下载"）。
                                singleLaneRejects += 1
                                if (singleLaneRejects > 6) {
                                    throw new Error(`已降到单通道仍连续被拒 ${singleLaneRejects} 次（HTTP ${status}）：该站点禁止下载、限流或需要鉴权/换 UA`)
                                }
                                const waitSingle = Math.min(8000, Math.max(600, error?.retryAfterMs ?? 1500))
                                log(`单通道也被拒（HTTP ${status}，第 ${singleLaneRejects} 次）⇒ 等 ${(waitSingle / 1000).toFixed(1)}s 重试（可能是残留连接或限流）`)
                                await new Promise((r) => setTimeout(r, waitSingle))
                                continue
                            }
                            downgrades += 1
                            const before = concurrency
                            concurrency = Math.max(1, Math.floor(concurrency / 2))
                            HOST_CONCURRENCY_CAP.set(hostKey, concurrency)      // 记住这个上限，下次直接用
                            const wait = Math.min(10_000, Math.max(400, error?.retryAfterMs ?? 800))
                            log(`服务器拒绝并发（HTTP ${status}）⇒ 并发 ${before} → ${concurrency}，等 ${(wait / 1000).toFixed(1)}s 后继续（已记住该主机上限）`)
                            await new Promise((r) => setTimeout(r, wait))
                            continue
                        }
                        throw error
                    }
                    finally {
                        running -= 1
                        next.claimed = false
                        singleLaneRejects = 0
                        // **向上试探**：连续成功、且**最近没被拒**（含被重试吸收的那些）才慢慢加回去，
                        // 且整个下载最多试探 MAX_GROW_ATTEMPTS 次 —— 免得反复撞墙挨 429
                        if (concurrency < requestedConcurrency && growAttempts < MAX_GROW_ATTEMPTS) {
                            grownSinceReject += 1
                            if (grownSinceReject >= 5 && !rejectedRecently()) {
                                concurrency += 1
                                growAttempts += 1
                                grown = true
                                grownSinceReject = 0
                                log(`已连续成功且近期没被拒 ⇒ 试着把并发提到 ${concurrency}（请求值 ${requestedConcurrency}，第 ${growAttempts}/${MAX_GROW_ATTEMPTS} 次试探）`)
                            }
                        }
                        void grown
                    }
                }
            })
            try {
                await Promise.all(workers)
                break
            }
            catch (error) {
                if (error?.code === 'RANGE_IGNORED' && round === 0) {
                    // ⚠️ `Promise.all` 在**第一个** rejection 就返回，别的 worker 可能还在往 `.part` 里写；
 // 必须先让它们停下来再清盘，否则"清空重下"会和旧写入打架（夹具实测：
                    //    合并后大小 393216 ≠ 3145728 —— 回退后被仍在跑的 worker 写坏了）。
                    roundController.abort()
                    await Promise.allSettled(workers)
 // 服务器不接受分段：**清掉已下的部分，单流从头下**（用户 要求兜住这类站点）
                    noRangeFallback = true
                    log(`服务器忽略了 Range（分段请求返回整包 200）⇒ **回退单流**：清空已下内容、从头下载（该站点不支持断点续传/多线程）`)
                    for (const c of manifest.chunks) delete c.claimed
                    manifest.chunks = [{ start: 0, end: manifest.total - 1, done: 0 }]
                    manifest.threads = 1
                    concurrency = 1
                    running = 0
                    await handle.truncate(0)
                    manifest.segmented = false
                    await saveManifest(to, manifest)
                    report(true)
                    continue
                }
                throw error
            }
        }
    }
    catch (error) {
        failure = error
    }
    // 如实记录**实际**并发（被限连接数时会小于请求值）
    if (!noRangeFallback && concurrency < manifest.threads) manifest.threads = concurrency
    // 清理临时标记再落盘
    for (const c of manifest.chunks) delete c.claimed
    await handle.close()
    report(true)
    await saveManifest(to, manifest)

    if (failure !== null) {
        const error = new Error(isUserAbort(signal, failure) || String(failure.message) === 'user-abort' ? 'aborted' : failure.message)
        error.downloaded = totalDone()
        error.total = manifest.total
        error.partKept = true
        throw error
    }

    const gotSize = await fileSize(part)
    if (gotSize !== manifest.total) {
        throw new Error(`合并后大小不对：${gotSize} ≠ ${manifest.total}（.part 保留，可再次 resume）`)
    }
 // **落盘前必须证明"每一块都真的下完了"**（加）：动态劈出的块若因任何原因
    // 没人接手，文件大小可能仍是 total（稀疏写），但中间是空的 —— 那种文件绝不能改名成功。
    const missing = manifest.chunks.filter((c) => (c.done ?? 0) < c.end - c.start + 1)
    if (missing.length > 0) {
        const gaps = missing.slice(0, 3).map((c) => `${c.start + (c.done ?? 0)}-${c.end}`).join(', ')
        throw new Error(`有 ${missing.length} 个分片没下完（缺口：${gaps}）—— 已保留 .part + manifest，可直接重跑同 to 续传（这不是"静默成功"）`)
    }
    const handle2 = await open(part, 'r+')
    await handle2.truncate(manifest.total)
    await handle2.close()
    // 无论有没有给期望值都自算一次：乱序写/代理篡改不该悄悄改名成功
    const digest = await sha256Of(part, signal)
    if (expectedSha256 !== null && expectedSha256 !== undefined && expectedSha256 !== '') {
        const want = String(expectedSha256).toLowerCase().replace(/^sha256:/, '')
        if (digest !== want) {
            await rm(part, { force: true })
            await rm(manifestPathOf(to), { force: true })
            throw new Error(`sha256 校验失败（期望 ${want.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…）—— 已删除 .part，请重下`)
        }
    }
    await rename(part, to)
    await rm(manifestPathOf(to), { force: true })
    const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
    return {
        ok: true,
        to,
        bytes: manifest.total,
        seconds,
        mbps: manifest.total / 1048576 / seconds,
        mode: noRangeFallback ? 'single' : mode,
        threads: manifest.threads,
        chunks: manifest.chunks.length,
        splits,
        resplits,
        reconnects,
        downgrades,
        noRangeFallback,
        // 最终**实际**并发（被服务器限连接数时会小于请求值）与该主机的实测上限
        concurrency: noRangeFallback ? 1 : Math.max(1, concurrency),
        hostCap: HOST_CONCURRENCY_CAP.get(hostKey) ?? null,
        resumedFrom: partSizeBefore,
        sha256: digest,
        finalUrl: info.finalUrl,
        proxy: info.proxy,
    }
}

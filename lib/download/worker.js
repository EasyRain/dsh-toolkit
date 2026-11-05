/**
 * lib/download/worker.js —— 后台下载 worker（由 `download` 工具以 detached 方式 spawn）。
 *
 * 用法：`node lib/download/worker.js <spec.json>`
 * 职责：
 *  1. 读 spec（url/to/headers/proxy/threads/校验…以及 statusPath/cancelPath/logPath）；
 *  2. 跑 `downloadFile()`，把进度**节流**写进状态文件（含 pid / 速度 / 分片数 / splits）；
 *  3. 轮询 cancel 标志 ⇒ `AbortController.abort()`（进程内优雅停；`.part`+manifest 保留）；
 *  4. 结束写终态（done/failed/cancelled）并退出码 0/1。
 *
 * 为什么单独一个进程：GB 级下载不该占住一轮对话；宿主重启也不影响（状态在磁盘上，可续传）。
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { downloadFile, probeTarget } from './engine.js'

const specPath = process.argv[2]
if (specPath === undefined) {
    console.error('usage: node worker.js <spec.json>')
    process.exit(2)
}

let spec
try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'))
}
catch (error) {
    console.error(`spec 读不出来：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
}

const writeStatus = (patch) => {
    const now = new Date().toISOString()
    const base = (() => {
        try { return JSON.parse(readFileSync(spec.statusPath, 'utf8')) }
        catch { return {} }
    })()
    const next = { ...base, ...patch, id: spec.id, url: spec.url, to: spec.to, updatedAt: now, pid: process.pid }
    try { writeFileSync(spec.statusPath, JSON.stringify(next, null, 2)) }
    catch { /* 状态写不进去不该让下载挂掉 */ }
    return next
}

const log = (msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`
    try { appendFileSync(spec.logPath, line) }
    catch { /* ignore */ }
}

const cancelled = () => existsSync(spec.cancelPath)
const controller = new AbortController()
let cancelWatch = setInterval(() => {
    if (cancelled()) {
        log('收到取消标志 ⇒ 中止（.part 保留，可续）')
        controller.abort()
    }
}, 400)

const cleanup = () => { clearInterval(cancelWatch); cancelWatch = null }

try {
    writeStatus({ state: 'starting', startedAt: new Date().toISOString(), downloaded: 0 })
    log(`worker 启动 pid=${process.pid} url=${spec.url} to=${spec.to} threads=${spec.threads} proxy=${typeof spec.proxy === 'string' ? spec.proxy : JSON.stringify(spec.proxy)}`)

    // 复用工具层已探测过的信息（避免重复探测；没有就自己探一次，sample:false 很快）
    const info = spec.probeInfo ?? await probeTarget({
        url: spec.url,
        headers: spec.headers ?? {},
        proxy: spec.proxy ?? 'auto',
        timeoutMs: spec.timeoutMs ?? 30000,
        sample: false,
        signal: controller.signal,
    })
    writeStatus({
        state: 'downloading',
        finalUrl: info.finalUrl,
        total: info.total,
        rangeSupported: info.rangeSupported,
        etag: info.etag,
        lastModified: info.lastModified,
        proxy: info.proxy,
    })
    log(`探测：total=${info.total} range=${info.rangeSupported} proxy=${info.proxy.kind} final=${info.finalUrl}`)

    let lastWrite = 0
    const result = await downloadFile({
        url: spec.url,
        to: spec.to,
        threads: spec.threads ?? 8,
        headers: spec.headers ?? {},
        proxy: spec.proxy ?? 'auto',
        resume: spec.resume !== false,
        overwrite: spec.overwrite === true,
        expectedSha256: spec.expectedSha256 ?? null,
        expectedBytes: spec.expectedBytes ?? null,
        minSplitSize: spec.minSplitSize,
        lowestSpeedLimit: spec.lowestSpeedLimit,
        speedLimit: spec.speedLimit ?? 0,
        timeoutMs: spec.timeoutMs ?? 30000,
        signal: controller.signal,
        probeInfo: info,
        log,
        onProgress: (p) => {
            const now = Date.now()
            if (now - lastWrite < 700) return          // 节流：状态文件别写太频
            lastWrite = now
            writeStatus({
                state: 'downloading',
                downloaded: p.downloaded,
                total: p.total,
                percent: Number(p.percent.toFixed(2)),
                bytesPerSecond: Math.round(p.bytesPerSecond),
                elapsedMs: p.elapsedMs,
                active: p.active,
                mode: p.mode,
                splits: p.splits,
            })
        },
    })

    cleanup()
    writeStatus({
        state: 'done',
        downloaded: result.bytes,
        total: result.bytes,
        percent: 100,
        bytesPerSecond: Math.round(result.bytes / Math.max(0.001, result.seconds)),
        seconds: Number(result.seconds.toFixed(2)),
        mode: result.mode,
        threads: result.threads,
        chunks: result.chunks,
        splits: result.splits,
        sha256: result.sha256,
        finalUrl: result.finalUrl,
        proxy: result.proxy,
        finishedAt: new Date().toISOString(),
    })
    log(`完成 ${result.bytes} 字节，${result.seconds.toFixed(1)} s，${result.mbps.toFixed(1)} MB/s，sha256=${result.sha256}`)
    // 成功后删掉 spec/cancel 残留（状态文件保留，便于 status 查看历史）
    try { rmSync(specPath, { force: true }) } catch { /* ignore */ }
    try { rmSync(spec.cancelPath, { force: true }) } catch { /* ignore */ }
    process.exit(0)
}
catch (error) {
    cleanup()
    const message = error instanceof Error ? error.message : String(error)
    const aborted = message === 'aborted' || cancelled()
    writeStatus({
        state: aborted ? 'cancelled' : 'failed',
        error: aborted ? '已取消（.part + manifest 保留，可续传）' : message,
        downloaded: typeof error?.downloaded === 'number' ? error.downloaded : undefined,
        total: typeof error?.total === 'number' ? error.total : undefined,
        finishedAt: new Date().toISOString(),
    })
    log(aborted ? '已取消' : `失败：${message}`)
    try { if (aborted) rmSync(spec.cancelPath, { force: true }) } catch { /* ignore */ }
    process.exit(aborted ? 0 : 1)
}

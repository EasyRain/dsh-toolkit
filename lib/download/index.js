/**
 * lib/download/index.js —— `download` / `download_status` / `download_cancel` 三个工具。
 *
 * 设计要点：
 *  - **默认落盘 `<会话工作区>/downloads/`**，同名**拒绝**（要覆盖得显式 `overwrite:true`；要续传就沿用 `.part`）；
 *  - **自动前后台**：`mode:'auto'`（默认）时，≤ 32 MB 或未知大小在前台跑完并直接给结果；更大的起**后台任务**
 *    （大文件不该占住一轮对话），也可显式 `mode:'foreground'|'background'`；
 *  - **探测模式** `probe:true`（或 `dryRun:true`）：只跟随重定向、探 Range/总大小/每连接吞吐，**不写任何文件** ——
 *    用来回答"在你这台机器 + 这条链接 + 这个代理下，多线程到底有没有用"；
 *  - 后台任务的状态写在 `<downloads>/.dsh-downloads/<id>.json`，取消写 `<id>.cancel` 标志（worker 会读），
 *    必要时再杀进程；**取消默认保留 `.part` + manifest**，下次可续。
 */
import { spawn } from 'node:child_process'
import { assertWritableTargets } from '../guard.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOWEST_SPEED, DEFAULT_MIN_SPLIT, DEFAULT_THREADS, MAX_THREADS, downloadFile, partPathOf, planThreads, probeTarget } from './engine.js'
import { diagnoseNetError, resolveProxyAsync } from './net.js'
import { toFieldMap } from '../deps.js'

export const name = 'download'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'worker.js')
/**
 * 状态与日志的目录名（点开头，与 `.dsh-checkpoint-ignore` 等自家文件的约定一致）。
 * 落点 = **`<工作区>/downloads/.dsh-downloads/`**（downloads/ 留给下载产物，所以放它的下级）。
 * 旧版把同一个目录名建在**目标文件旁边**（`<目标目录>/.dsh-downloads`），现在**目标目录一个文件都不放**：
 * 那批残留会被读取（status/cancel 仍能管到）并清理掉。
 */
const STATE_DIR = '.dsh-downloads'
const AUTO_BACKGROUND_BYTES = 32 * 1024 * 1024

const textOutput = () => ({
    schema: { type: 'string', description: 'Human-readable report (plain text).' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
})

const mb = (b) => (b === null || b === undefined ? '?' : `${(b / 1048576).toFixed(1)} MB`)
const kbRate = (bps) => (bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`)
/** 直连的**原因**（`direct` 与"auto 没找到代理"在结果里必须能区分开，否则改名的意义就丢了） */
const directReason = (source = '') => {
    if (/explicit direct/i.test(source)) return '显式指定 direct'
    if (/bypass/i.test(source)) return 'NO_PROXY / 绕过规则命中'
    if (/unparsable/i.test(source)) return '代理配置无法解析，已按直连处理'
    return '未发现系统/环境代理'
}

/** 全局配置：入口注入"会话工作区"解析器（与其它段一致），并集中放默认值 */
export const config = {
    resolveWorkspaceCwd: null,
    defaultThreads: DEFAULT_THREADS,
    autoBackgroundBytes: AUTO_BACKGROUND_BYTES,
}

const dirOf = (exec) => {
    try {
        const cwd = exec?.agent?.session?.header?.cwd ?? (typeof config.resolveWorkspaceCwd === 'function' ? config.resolveWorkspaceCwd() : null)
        if (typeof cwd === 'string' && cwd !== '') return cwd
    }
    catch { /* 落回 process.cwd() */ }
    return process.cwd()
}

const resolveFrom = (p, base) => (isAbsolute(p) ? resolve(p) : resolve(base, p))

/** `downloads/` 目录（缺失时建） */
async function downloadsDir(exec) {
    const dir = join(dirOf(exec), 'downloads')
    await mkdir(dir, { recursive: true })
    return dir
}

/**
 * 状态与日志的落点 = **`<工作区>/downloads/.dsh-downloads/`**（downloads/ 留给下载产物，所以放它的下级）。
 *
 * 为什么不是"目标文件旁边"：目标目录可能是模型目录、游戏 mod 目录这类**会被别的程序扫描**的地方，
 * 用户实测反馈——下载完在 `ComfyUI-Shared\models\*\` 里留下了 `.dsh-downloads`。
 * 现在**目标目录一个文件都不放**；记录与日志都在 downloads/.dsh-downloads/ 里，以后要查直接翻这个目录。
 */
const stateDirOf = (exec) => join(dirOf(exec), 'downloads', STATE_DIR)
/** 任务索引（就在上面那个目录里，记录每个后台任务的**真实状态目录**，兼容旧版写在目标目录旁的记录）。 */
const indexFileOf = (exec) => join(stateDirOf(exec), 'jobs.json')

/** 终态：到了这里就只剩"结果记录"，可以清理 */
const TERMINAL_STATES = new Set(['done', 'completed', 'failed', 'cancelled', 'interrupted'])

const readJobFile = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

/** 把 pruneState 的结果说成一句人话（三处输出共用，避免各写各的） */
const sweepNote = (swept) => {
    const bits = []
    if (swept.temp > 0) bits.push(`${swept.temp} 个临时件（spec/cancel/孤儿日志）`)
    if (swept.legacyRecords > 0) bits.push(`${swept.legacyRecords} 条旧版残留记录`)
    if (swept.dirsRemoved > 0) bits.push(`${swept.dirsRemoved} 个空的 .dsh-downloads 目录`)
    return bits.length === 0 ? '' : `（顺手清理：${bits.join('、')}）`
}

/**
 * 收拾临时状态与**旧版残留**（用户定调：状态与日志放 `<工作区>/downloads/.dsh-downloads/`，
 * **目标目录一个文件都不放**；记录与日志留着，以后要查直接翻那个目录）。
 *
 * 具体做什么：
 *  ① 终态任务的 `.spec.json` / `.cancel` 是纯临时件 ⇒ 删；`.json`（结果记录）与 `.log` **保留**；
 *  ② 孤儿文件（状态记录已经不在了的 `.log`/`.spec.json`/`.cancel`）⇒ 删；
 *  ③ 历史封顶：主目录里终态记录超过 `HISTORY_CAP` 条时，删最旧的（连同它的 `.log`）；
 *  ④ **旧版目录**（`<工作区>/.dsh-downloads`、`<目标目录>/.dsh-downloads`）里的终态记录一律清掉，
 *     目录空了就把目录本身删掉 —— 这正是"下载完在模型目录里留下点目录"的那批残留。
 */
function pruneState(exec, args = null) {
    let temp = 0
    let legacyRecords = 0
    let dirsRemoved = 0
    const primary = stateDirOf(exec)
    const HISTORY_CAP = 200
    for (const dir of resolveStateDirs(exec, args)) {
        if (!existsSync(dir)) continue
        let names = []
        try { names = readdirSync(dir) } catch { continue }
        const legacy = dir !== primary
        const byId = new Map()
        for (const f of names) {
            if (f === 'jobs.json') continue
            const m = /^(.+?)\.(json|log|cancel|spec\.json)$/.exec(f)
            if (m === null) continue
            const list = byId.get(m[1]) ?? []
            list.push(m[2])
            byId.set(m[1], list)
        }
        const settled = []
        for (const [id, suffixes] of byId) {
            const statusFile = join(dir, `${id}.json`)
            const hasRecord = suffixes.includes('json') && existsSync(statusFile)
            const status = hasRecord ? readJobFile(statusFile) : null
            // 正在跑（记录在且不是终态）⇒ 一律不碰
            if (hasRecord && !TERMINAL_STATES.has(String(status?.state ?? ''))) continue
            const at = status === null ? 0 : Date.parse(String(status.finishedAt ?? status.updatedAt ?? status.startedAt ?? '')) || 0
            settled.push({ id, at })
            // 纯临时件先删；旧版目录连记录与日志一起退休（那批残留不该继续留在别人的目录里）
            for (const suffix of ['spec.json', 'cancel']) {
                const p = join(dir, `${id}.${suffix}`)
                if (!existsSync(p)) continue
                try { rmSync(p, { force: true }); temp += 1 } catch { /* ignore */ }
            }
            if (legacy) {
                for (const suffix of ['json', 'log']) {
                    const p = join(dir, `${id}.${suffix}`)
                    if (!existsSync(p)) continue
                    try { rmSync(p, { force: true }); if (suffix === 'json') legacyRecords += 1 } catch { /* ignore */ }
                }
            }
        }
        // 孤儿件：只剩 .log/.spec.json/.cancel，没有对应记录
        for (const f of names) {
            if (f === 'jobs.json') continue
            const m = /^(.+?)\.(log|cancel|spec\.json)$/.exec(f)
            if (m === null) continue
            if (existsSync(join(dir, `${m[1]}.json`))) continue
            try { rmSync(join(dir, f), { force: true }); temp += 1 } catch { /* ignore */ }
        }
        if (legacy) {
            // 旧版目录：清理后空了就把目录本身删掉
            // ⚠️ 必须用 rmdirSync：Windows 上 `rmSync(dir, { recursive: false })` 对目录会抛 ERR_FS_EISDIR
            // （它只会 unlink 文件），被 catch 吞掉 ⇒ "删空目录"看起来执行了、其实一直没删。
            try {
                if (readdirSync(dir).length === 0) { rmdirSync(dir); dirsRemoved += 1 }
            }
            catch { /* 非空/被占用都属正常 */ }
        }
        else {
            // 历史封顶：只保留最近 HISTORY_CAP 条终态记录（连日志一起清），避免 downloads/.dsh-downloads 无限长
            const keep = new Set(settled.sort((a, b) => b.at - a.at).slice(0, HISTORY_CAP).map((s) => s.id))
            for (const s of settled) {
                if (keep.has(s.id)) continue
                for (const suffix of ['json', 'log']) { try { rmSync(join(dir, `${s.id}.${suffix}`), { force: true }) } catch { /* ignore */ } }
            }
            // 主目录清空了也删掉（下次起后台任务会重建），避免留一个空的 .dsh-downloads
            try {
                if (readdirSync(dir).length === 0) { rmdirSync(dir); dirsRemoved += 1 }
            }
            catch { /* 非空/被占用都属正常 */ }
        }
    }
    // 索引里指向"已经没有任何状态文件"的条目清掉（避免 jobs.json 无限长）
    try {
        const idx = readJobIndex(exec)
        let changed = false
        for (const [id, entry] of Object.entries(idx)) {
            const where = typeof entry?.stateDir === 'string' ? entry.stateDir : primary
            let alive = false
            try { alive = readdirSync(where).some((f) => f.startsWith(`${id}.`)) } catch { alive = false }
            if (!alive) { delete idx[id]; changed = true }
        }
        if (changed) {
            if (Object.keys(idx).length === 0) rmSync(indexFileOf(exec), { force: true })
            else writeFileSync(indexFileOf(exec), JSON.stringify(idx, null, 2))
        }
    }
    catch { /* ignore */ }
    return { temp, legacyRecords, dirsRemoved }
}

function readJobIndex(exec) {
    try { return JSON.parse(readFileSync(indexFileOf(exec), 'utf8')) } catch { return {} }
}

/** 起后台任务时登记（写失败不影响下载本身） */
function rememberJob(exec, entry) {
    try {
        const dir = stateDirOf(exec)
        mkdirSync(dir, { recursive: true })
        const idx = readJobIndex(exec)
        idx[entry.id] = { stateDir: entry.stateDir, to: entry.to ?? null, url: entry.url ?? null, at: new Date().toISOString() }
        // 只保留最近 200 条，避免无限增长
        const keys = Object.keys(idx)
        if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete idx[k]
        writeFileSync(indexFileOf(exec), JSON.stringify(idx, null, 2))
    }
    catch { /* 索引只是加速查找，坏了不影响 */ }
}

/**
 * 候选状态目录（顺序即优先级，去重）。
 *
 * ⚠️ 状态机 fuzz 抓到的真 bug：`download` 把状态写在 `<目标文件目录>/.dsh-downloads`，
 * 而 `download_status`/`download_cancel` 只在 `<工作区>/downloads/.dsh-downloads` 里找 ⇒
 * **只要 `to` 不在默认 downloads/ 下，就报"没有后台下载任务"**（worker 明明在跑，甚至已被杀）。
 * 现在：主目录（`downloads/.dsh-downloads`）+ 索引里登记过的目录 + **旧版遗留目录**，都会查（旧的那批还能被 status/cancel 管到）。
 */
function resolveStateDirs(exec, args = null) {
    const dirs = [stateDirOf(exec)]
    for (const entry of Object.values(readJobIndex(exec))) {
        if (entry !== null && typeof entry.stateDir === 'string') dirs.push(entry.stateDir)
    }
    // 旧版落点（只读 + 清理，见 pruneState）：工作区根的 `.dsh-downloads`、以及**目标目录旁边**的 `.dsh-downloads`
    dirs.push(join(dirOf(exec), STATE_DIR))
    if (args !== null && typeof args?.to === 'string' && args.to !== '') {
        try { dirs.push(join(dirname(resolveFrom(args.to, dirOf(exec))), STATE_DIR)) } catch { /* ignore */ }
    }
    return [...new Set(dirs.map((d) => d.replace(/[\\/]+$/, '')))]
}

/** 列出所有候选目录里的状态文件（按 id 去重；同名以**先出现的候选目录**为准） */
const listJobFiles = (exec, args = null) => {
    const seen = new Set()
    const files = []
    for (const dir of resolveStateDirs(exec, args)) {
        if (!existsSync(dir)) continue
        let names = []
        try { names = readdirSync(dir) } catch { continue }
        for (const f of names) {
            // ⚠️ 排除 worker 的参数文件（`<id>.spec.json`）与取消标志：它们也以 .json 结尾，
 // 当状态文件读会得到"没有 state"的记录（夹具实测踩到 → 列表里出现幽灵任务并崩）
            if (!f.endsWith('.json') || f.endsWith('.spec.json') || f === 'jobs.json') continue
            if (seen.has(f)) continue
            seen.add(f)
            files.push(join(dir, f))
        }
    }
    return files
}

/** URL → 默认文件名（URL 解码、去掉危险字符；查不到就用 download.bin） */
function nameFromUrl(url) {
    try {
        const u = new URL(url)
        const last = basename(u.pathname)
        if (last === '' || last === '/') return 'download.bin'
        return decodeURIComponent(last).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180)
    }
    catch { return 'download.bin' }
}

/** 解析 `headers` 参数：数组 `["K: V"]` 或对象；再并入 cookie/referer */
function buildHeaders(args) {
    const out = {}
    const raw = args?.headers
    if (Array.isArray(raw)) {
        for (const line of raw) {
            if (typeof line !== 'string') continue
            const i = line.indexOf(':')
            if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
        }
    }
    else if (raw !== null && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
    }
    if (typeof args?.cookie === 'string' && args.cookie !== '') out.Cookie = args.cookie
    if (typeof args?.referer === 'string' && args.referer !== '') out.Referer = args.referer
    return out
}

const readStatus = (file) => {
    try { return JSON.parse(readFileSync(file, 'utf8')) }
    catch { return null }
}

const pidAlive = (pid) => {
    if (typeof pid !== 'number' || pid <= 0) return false
    try { process.kill(pid, 0); return true }
    catch { return false }
}

/** 一个任务的"人话"状态：结合 status 文件 + 进程是否还在 + .part/目标文件现状 */
export function describeJob(status) {
    if (status === null) return { line: '(状态文件读不出来)', state: 'unknown' }
    const { id, total, downloaded } = status
    // 状态文件可能被半写入/是别的 json ⇒ 一律兜底，不让"看进度"这个动作本身崩
    const state = typeof status.state === 'string' ? status.state : 'unknown'
    const pct = total > 0 ? `${((downloaded / total) * 100).toFixed(1)}%` : '?'
    const alive = state === 'downloading' || state === 'starting' ? pidAlive(status.pid) : false
    let real = state
    if ((state === 'downloading' || state === 'starting') && !alive) real = 'interrupted'
    const rate = status.bytesPerSecond ? `  ${kbRate(status.bytesPerSecond)}` : ''
    const where = status.to ? ` → ${status.to}` : ''
    const extra = real === 'interrupted' ? '（worker 进程已不在：可能被中断/宿主重启；`download` 再跑一次同 to 会续传）' : ''
    return {
        state: real,
        line: `${id}  ${real.padEnd(12)} ${pct.padStart(7)}  ${mb(downloaded)}/${mb(total)}${rate}  threads=${status.threads ?? '?'} splits=${status.splits ?? 0}${where}${extra}`,
    }
}

export function tools(defineTool, options = {}) {
    // 落盘目标也要过沙箱闸门（宿主策略管不到插件里的 fs 写入）。
    const guardCtx = typeof options.getCtx === 'function' ? options.getCtx : () => null
    const tool = (def) => defineTool({ ...def, parameters: toValueSchema(def.parameters) })

    const jobTool = ({
        name: 'download',
        description: 'Zero-dependency multi-connection downloader (Range chunks + resume + sha256 + proxy detection). '
            + 'action picks the verb (default start); probe first to see whether multi-connection helps. '
            + 'Defaults: threads auto, resume, destination <session workspace>/downloads/, existing target refused. '
            + 'Details and failure modes: docs/DOWNLOAD.md.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                url: { type: 'string', description: 'HTTP(S) URL to download.' },
                to: { type: 'string', description: 'Destination file (absolute, or relative to the session workspace). Default: <workspace>/downloads/<name from URL>.' },
                probe: { type: 'boolean', description: 'Only PROBE: follow redirects, report Range support / total size / per-connection throughput. Writes nothing.' },
                mode: { type: 'string', enum: ['auto', 'foreground', 'background'], description: 'auto (default): foreground when the file is <= 32 MB or unknown, otherwise background.' },
                threads: { type: 'number', description: 'Parallel connections. OMIT for AUTO (recommended): decided from file size + measured per-connection throughput (tiny files get 1, big files up to 12). Pass a number (1..32) to force it; 1 = single stream.' },
                resume: { type: 'boolean', description: 'Resume from an existing .part + manifest (default true); remote-change detection restarts safely.' },
                overwrite: { type: 'boolean', description: 'Allow replacing an existing target file (default false).' },
                proxy: { type: 'string', description: 'auto (default — usually just omit this) = follow the system proxy; it is direct when no proxy is configured, so omitting it is safe either way. direct = force a direct connection (right for hosts you know are reachable, e.g. LAN/localhost). Or an explicit URL like http://127.0.0.1:7890 / socks5h://user:pass@127.0.0.1:7891.' },
                headers: { type: 'array', items: { type: 'string' }, description: 'Extra request headers as "Name: value" strings (e.g. ["Authorization: Bearer …"]).' },
                cookie: { type: 'string', description: 'Cookie header value (shorthand for a headers entry).' },
                referer: { type: 'string', description: 'Referer header value (many CDNs 403 without it).' },
                sha256: { type: 'string', description: 'Expected sha256 (hex, optional "sha256:" prefix). Mismatch deletes the .part and fails.' },
                expectedBytes: { type: 'number', description: 'Expected exact size in bytes (mismatch aborts before downloading).' },
                minSplitSize: { type: 'number', description: `Do not create chunks smaller than this (default ${DEFAULT_MIN_SPLIT} bytes).` },
                lowestSpeedLimit: { type: 'number', description: `Split a chunk whose speed stays below this (bytes/s) — default ${DEFAULT_LOWEST_SPEED}; stalled proxy connections get re-queued.` },
                speedLimit: { type: 'number', description: 'Global speed limit in bytes/s (0 = unlimited).' },
                timeoutMs: { type: 'number', description: 'Per-request timeout in ms (default 30000).' },
            },
            required: ['url'],
        },
        output: textOutput(),
        async execute(args, exec) {
            const url = String(args?.url ?? '')
            if (!/^https?:\/\//i.test(url)) throw new Error(`url 必须是 http(s) 链接：${JSON.stringify(url)}`)
            const headers = buildHeaders(args)
            // `auto`（默认）= **跟随系统代理**（PAC/规则模式下由代理自己决定哪些直连、哪些走代理；
            // 全局模式就全走代理）；`'direct'` = 强制直连（用于**确知**可直连的地址：本机/LAN/内网，
            // 或你实测走代理反而更慢的地址）。`'none'`/`'off'`/`false` 是它的历史别名，仍然接受。
            const proxy = args?.proxy ?? 'auto'
            // `threads` 不给 ⇒ **自动**（按大小档 × 实测每连接增益；见 planThreads）；给了数字 ⇒ 手动（1 = 单流）
            const requestedThreads = Number.isFinite(Number(args?.threads)) ? clampInt(args.threads, 1, MAX_THREADS, DEFAULT_THREADS) : null
            const minSplitSize = clampInt(args?.minSplitSize, 64 * 1024, 64 * 1024 * 1024, DEFAULT_MIN_SPLIT)
            const timeoutMs = clampInt(args?.timeoutMs, 1000, 600000, 30000)

            // ---- 失败时把"下一步怎么办"也说清楚（DNS 解析失败/连不上/TLS 重置/代理不可用）----
            // 起因：若你的网络对域名解析有干扰，直连某些站点会大多失败/很慢，失败信息必须给出可执行的出路。
            const wrapFailure = async (error) => {
                let proxyKind = proxy === 'auto' ? 'auto' : proxy
                let proxySource = null
                try {
                    // 用**异步**解析（含 PAC 与端口探测）：用户机器上代理软件走 PAC，只读注册表会误报"无代理"
                    const resolved = await resolveProxyAsync(proxy, (() => { try { return new URL(url).hostname } catch { return null } })())
                    proxyKind = resolved.kind
                    proxySource = resolved.source ?? null
                }
                catch { /* 诊断本身失败不影响原始错误 */ }
                const hints = diagnoseNetError(error, { proxyKind, proxySource, url })
                if (hints.length === 0) throw error
                const wrapped = new Error(`${error instanceof Error ? error.message : String(error)}\n${hints.join('\n')}`)
                wrapped.code = error?.code
                wrapped.status = error?.status
                wrapped.downloaded = error?.downloaded
                wrapped.total = error?.total
                wrapped.partKept = error?.partKept
                throw wrapped
            }

            // ---- 探测模式：不写任何文件 ----
            if (args?.probe === true || args?.dryRun === true) {
                const info = await probeTarget({ url, headers, proxy, timeoutMs, sampleBytes: 256 * 1024, connections: 4 }).catch(wrapFailure)
                const advice = planThreads({ total: info.total, rangeSupported: info.rangeSupported, sampleSummary: info.sampleSummary, requested: requestedThreads, minSplitSize })
                const lines = [
                    `probe  ${url}`,
                    `  最终 URL   : ${info.finalUrl}${info.redirects.length > 0 ? `（${info.redirects.length} 次重定向${info.strippedNote ? `；${info.strippedNote}` : ''}）` : ''}`,
                    `  HTTP 状态  : ${info.status}`,
                    `  总大小     : ${mb(info.total)}${info.total > 0 ? ` (${info.total} 字节)` : '（拿不到 —— 服务器既没给 Content-Length 也不支持 Range）'}`,
                    `  Range 支持 : ${info.rangeSupported ? `是（accept-ranges=${info.acceptRanges ?? '?'}）` : '**否** ⇒ 多线程无意义，工具会自动回退单流'}`,
                    `  校验器     : etag=${info.etag ?? '-'} last-modified=${info.lastModified ?? '-'}`,
                    `  内容类型   : ${info.contentType ?? '-'}`,
                    `  代理       : ${info.proxy.kind === 'none' ? `直连（${directReason(info.proxy.source)}）` : `${info.proxy.kind}://${info.proxy.host}:${info.proxy.port}（来源：${info.proxy.source}）`}`,
                ]
                if (info.sampleSummary) {
                    const s = info.sampleSummary
                    const gain = s.aggregateMbps / Math.max(0.001, s.medianMbps)
                    lines.push(
                        `  吞吐采样   : ${s.connections} 条连接 —— 每条 ${s.minMbps.toFixed(2)}~${s.maxMbps.toFixed(2)} MB/s（中位 ${s.medianMbps.toFixed(2)}），合计 ≈ ${s.aggregateMbps.toFixed(2)} MB/s${s.failed > 0 ? `（${s.failed} 条失败）` : ''}`,
                        `  **结论**   : ${s.connections > 1 && gain > 1.5
                            ? `多连接**有效**（合计 ≈ ${gain.toFixed(1)}× 单连接）⇒ 提高线程数有收益（多半是"每连接被限速"，例如走代理）`
                            : '多连接收益不明显（合计 ≈ 单连接）⇒ 瓶颈不在"每连接限速"，多开线程不会更快'}`,
                        // 实测提醒：小文件上"建立连接 + 收尾校验"的开销占比大，多线程可能反而略慢
 // （真链接实测：4.2 MB 同一 CDN，1 线程 24 MB/s、8 线程 19 MB/s）
                        info.total < 16 * 1024 * 1024 ? '  提醒       : 文件较小（<16 MB），连接开销占比高，多线程可能反而略慢；大文件才明显' : '',
                    )
                }
                else if (info.total > 0) lines.push('  吞吐采样   : （已跳过）')
                lines.push(`  **线程建议** : ${requestedThreads === null ? `auto ⇒ threads=${advice.threads}` : `手动 threads=${advice.threads}`}（${advice.reason}）`)
                return lines.join('\n')
            }

            // ---- 决定目标路径 ----
            const base = dirOf(exec)
            const to = typeof args?.to === 'string' && args.to !== ''
                ? resolveFrom(args.to, base)
                : join(await downloadsDir(exec), nameFromUrl(url))
            assertWritableTargets(guardCtx(), [to], { session: exec?.agent?.session })
            const existing = (() => { try { return statSync(to).size } catch { return 0 } })()
            if (existing > 0 && args?.overwrite !== true) {
                throw new Error(`目标已存在（${existing} 字节）：${to}\n  要覆盖：overwrite:true；要续传：上次的 ${partPathOf(to)} 还在就直接再调一次（会续）；换名字：给 to`)
            }

            // ---- 先探测（拿到总大小 + 每连接采样 ⇒ 才能定线程数/是否单流），再决定前后台 ----
            const info = await probeTarget({ url, headers, proxy, timeoutMs, sample: true, sampleBytes: 256 * 1024, connections: 4 }).catch(wrapFailure)
            const advice = planThreads({ total: info.total, rangeSupported: info.rangeSupported, sampleSummary: info.sampleSummary, requested: requestedThreads, minSplitSize })
            const threads = advice.threads
            const threadsLabel = requestedThreads === null ? `threads=auto→${threads}（${advice.reason}）` : `threads=${threads}（手动）`

            // ---- 后台模式：起 worker，立刻返回任务 id ----
            const wantBackground = args?.mode === 'background'
                || (args?.mode !== 'foreground' && info.total > config.autoBackgroundBytes)
            if (wantBackground) {
                return await startBackground({ exec, url, to, headers, proxy, threads, args, timeoutMs, probeInfo: info, threadsLabel })
            }

            const res = await downloadFile({
                url,
                to,
                threads,
                headers,
                proxy,
                resume: args?.resume !== false,
                overwrite: args?.overwrite === true,
                expectedSha256: args?.sha256 ?? null,
                expectedBytes: typeof args?.expectedBytes === 'number' ? args.expectedBytes : null,
                minSplitSize,
                lowestSpeedLimit: clampInt(args?.lowestSpeedLimit, 0, 100 * 1024 * 1024, DEFAULT_LOWEST_SPEED),
                speedLimit: clampInt(args?.speedLimit, 0, 1024 * 1024 * 1024, 0),
                timeoutMs,
                probeInfo: info,
            }).catch(wrapFailure)
            return [
                `downloaded  ${res.to}`,
                `  ${mb(res.bytes)}  ${res.seconds.toFixed(1)} s  ≈ ${res.mbps.toFixed(1)} MB/s  mode=${res.mode} ${threadsLabel} chunks=${res.chunks} splits=${res.splits}`,
                `  sha256 ${res.sha256}`,
 // fuzz 审计结论：**没有期望校验值时，"格式合法的内容篡改"无从发现**
                // （恶意服务器 fuzz 的 corrupt 模式实测：24 个种子里有 2 个只能靠 sha256 拦下）。
                // 很多项目（含 GitHub Release 的 `.sha256` 附件）都公布校验值 ⇒ 主动提示一次。
                (args?.sha256 ?? '') === '' ? '  提示：未给 sha256 ⇒ 无法发现"格式合法的内容篡改"；项目若公布了校验值（GitHub Release 常带 .sha256 附件），带上 sha256:"…" 即可拦住' : '',
                res.resumedFrom > 0 ? `  续传自 ${mb(res.resumedFrom)}（远端校验器一致）` : '',
                res.strippedNote ? `  ${res.strippedNote}` : '',
                `  最终 URL ${res.finalUrl}`,
                `  代理 ${res.proxy.kind === 'none' ? `直连（${directReason(res.proxy.source)}）` : `${res.proxy.kind}://${res.proxy.host}:${res.proxy.port}`}${res.proxy.kind !== 'none' && res.proxy.source ? `（来源：${res.proxy.source}）` : ''}`,
            ].filter(Boolean).join('\n')
        },
    })

    /** 宿主 job 的 owner 必须是 **session id**（JobSpec.owner: SessionId），不能传 Agent 对象。 */
    function ownerIdOf(exec) {
        const session = exec?.agent?.session?.id
        if (typeof session === 'string' && session !== '') return session
        const agent = exec?.agent?.id
        return typeof agent === 'string' && agent !== '' ? agent : undefined
    }

    /**
     * 把后台下载登记成**宿主 job**：UI 任务列表可见、可单独停止、带进度行。
     * @returns {string|null} 宿主 jobId（没有 jobs 服务时为 null）
     */
    function registerHostJob({ exec, statusPath, child, stateDir, id, to, total }) {
        const jobs = (() => { try { return guardCtx()?.get?.('jobs') } catch { return undefined } })()
        if (typeof jobs?.start !== 'function') return null
        const readStatus = () => {
            try { return JSON.parse(readFileSync(statusPath, 'utf8')) } catch { return null }
        }
        const progressText = { value: '' }
        try {
            return jobs.start({
                kind: 'download',
                label: `${basename(to)}${total > 0 ? ` (${mb(total)})` : ''}`,
                ...(ownerIdOf(exec) === undefined ? {} : { owner: ownerIdOf(exec) }),
                output: [{
                    channel: 'stdout',
                    read(offset) {
                        const from = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
                        return { text: progressText.value.slice(from), nextOffset: progressText.value.length, lossy: false }
                    },
                }],
                run: (handle) => {
                    let cancelledReason = null
                    let finish = null
                    const done = new Promise((resolveDone) => {
                        finish = resolveDone
                        const settleFromStatus = () => {
                            const status = readStatus()
                            const got = Number(status?.downloaded ?? 0)
                            const totalNow = Number(status?.total ?? total ?? 0)
                            const percent = totalNow > 0 ? `${Math.floor((got / totalNow) * 100)}%` : ''
                            const line = [percent, `${mb(got)}${totalNow > 0 ? `/${mb(totalNow)}` : ''}`, status?.state ?? 'running'].filter(Boolean).join(' ')
                            progressText.value = `${line}\n`
                            try { handle.updateProgress(line) } catch { /* 旧宿主没有 */ }
                            if (cancelledReason !== null) return { status: 'killed', detail: cancelledReason }
                            const state = String(status?.state ?? '')
                            if (TERMINAL_STATES.has(state)) {
                                return { status: state === 'done' ? 'completed' : (state === 'cancelled' ? 'killed' : 'failed'), detail: status?.error ?? `${mb(got)} ${state}` }
                            }
                            return null
                        }
                        const timer = setInterval(() => {
                            const outcome = settleFromStatus()
                            if (outcome !== null) { clearInterval(timer); finish(outcome) }
                        }, 500)
                        child.on('exit', () => { setTimeout(() => {
                            const outcome = settleFromStatus() ?? { status: cancelledReason !== null ? 'killed' : 'failed', detail: cancelledReason ?? 'worker 退出但状态未终态' }
                            clearInterval(timer); finish(outcome)
                        }, 300) })
                        if (typeof timer.unref === 'function') timer.unref()
                    })
                    // 结算后从「后台任务」列表里撤掉（完成通知已经发出；列表只留还在跑的下载）。
                    done.then(() => setTimeout(() => { try { jobs.remove(handle.id, undefined) } catch { /* 已移除 */ } }, 1500))
                        .catch(() => { /* 结算异常不影响 */ })
                    return {
                        done,
                        cancel: (reason) => {
                            const text = reason === undefined || reason === '' ? 'cancelled by the user' : String(reason)
                            cancelledReason = text
                            try { writeFileSync(join(stateDir, `${id}.cancel`), text) } catch { /* 已删 */ }
                            try { child.kill() } catch { /* 已退出 */ }
                        },
                    }
                },
            })
        }
        catch { return null }
    }

    /** 起后台任务（detached worker + 状态文件 + 取消标志） */
    async function startBackground({ exec, url, to, headers, proxy, threads, args, timeoutMs, probeInfo = null, threadsLabel = '' }) {
        // ⚠️ 状态**只写工作区** `<工作区>/downloads/.dsh-downloads`，绝不写进目标文件所在目录：
        // 目标目录很可能是模型/mod 目录这类被别的程序扫描的地方，留一个点目录会让它们行为异常
        // （用户实测：下完在 ComfyUI 的 models 各子目录里留下了 `.dsh-downloads`）。
        await downloadsDir(exec)
        const stateDir = stateDirOf(exec)
        await mkdir(stateDir, { recursive: true })
        const id = `dl-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
        const statusPath = join(stateDir, `${id}.json`)
        const specPath = join(stateDir, `${id}.spec.json`)
        const logPath = join(stateDir, `${id}.log`)
        const spec = {
            id,
            url,
            to,
            headers,
            proxy,
            threads,
            timeoutMs,
            resume: args?.resume !== false,
            overwrite: args?.overwrite === true,
            expectedSha256: args?.sha256 ?? null,
            expectedBytes: typeof args?.expectedBytes === 'number' ? args.expectedBytes : null,
            minSplitSize: clampInt(args?.minSplitSize, 64 * 1024, 64 * 1024 * 1024, DEFAULT_MIN_SPLIT),
            lowestSpeedLimit: clampInt(args?.lowestSpeedLimit, 0, 100 * 1024 * 1024, DEFAULT_LOWEST_SPEED),
            speedLimit: clampInt(args?.speedLimit, 0, 1024 * 1024 * 1024, 0),
            statusPath,
            cancelPath: join(stateDir, `${id}.cancel`),
            logPath,
            probeInfo,
        }
        writeFileSync(specPath, JSON.stringify(spec, null, 2))
        writeFileSync(statusPath, JSON.stringify({
            id, state: 'starting', url, to, total: probeInfo?.total ?? 0, downloaded: 0, threads,
            startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), specPath,
        }, null, 2))
        const child = spawn(process.execPath, [WORKER, specPath], { detached: true, stdio: 'ignore', windowsHide: true })
 // 登记到任务索引：	o 可能在默认 downloads/ 之外，状态/取消都要能找到它（修的真 bug）
        rememberJob(exec, { id, stateDir, to, url })
        child.unref()
        // 同时登记到**宿主的后台任务**：这样下载会出现在 UI 的任务列表里（带进度），可以单独停止。
        // 取消沿用原有的 `.cancel` 标志文件（worker 自己收尾、保留 .part 以便续传），再补一刀 kill 兜底。
        const hostJobId = registerHostJob({ exec, statusPath, child, stateDir, id, to, total: probeInfo?.total ?? 0 })
        return [
            `background job ${id}`,
            `  → ${to}`,
            `  ${threadsLabel}${probeInfo?.sampleSummary ? `；探测增益 ≈ ${(probeInfo.sampleSummary.aggregateMbps / Math.max(0.001, probeInfo.sampleSummary.medianMbps)).toFixed(1)}× 单连接` : ''}`,
            `  状态：download { action: "status", id: "${id}" }（或 {to:"${to}"}）；取消：download { action: "cancel", id: "${id}" }`
            , ...(hostJobId === null ? [] : [`  也出现在「后台任务」里（jobId=${hostJobId}），可直接在那里停止；结束时自动结算`]),
            `  状态与日志：${stateDir}（就在工作区 downloads/ 下，随时可查；**目标目录不会留下任何文件**）`,
            probeInfo ? `  已探测：total=${mb(probeInfo.total)} range=${probeInfo.rangeSupported ? 'yes' : 'no'} proxy=${probeInfo.proxy.kind}${probeInfo.proxy.source ? `（${probeInfo.proxy.source}）` : ''}` : '',
        ].filter(Boolean).join('\n')
    }

    const statusTool = ({
        name: 'download_status',
        description: 'Show progress of background downloads (reads the job status files under <workspace>/downloads/.dsh-downloads/, checks whether the worker process is alive, and reports interrupted jobs as resumable).',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', description: 'Job id (or id prefix).' },
                to: { type: 'string', description: 'Match a job by its destination path (absolute or workspace-relative).' },
                all: { type: 'boolean', description: 'List every known job (default: list all, detail when id/to is given).' },
                limit: { type: 'number', description: 'Max rows when listing (default 20).' },
            },
        },
        output: textOutput(),
        async execute(args, exec) {
            // 顺手收拾临时件与旧版残留（见 pruneState 的说明；结果记录与日志保留，随时可查）
            const swept = pruneState(exec, args)
            const files = listJobFiles(exec, args)
            if (files.length === 0) {
                const tail = sweepNote(swept) === '' ? '' : `\n  ${sweepNote(swept)}`
                return `没有后台下载任务（已查这些状态目录：\n  ${resolveStateDirs(exec, args).join('\n  ')}）\n  ⇒ 用 download {url} 起一个；大文件在 mode:auto 下会自动转后台${tail}`
            }
            const jobs = files.map((f) => readStatus(f)).filter((j) => j !== null)
                .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
            const wantId = typeof args?.id === 'string' ? args.id : null
            const wantTo = typeof args?.to === 'string' ? resolveFrom(args.to, dirOf(exec)) : null
            const picked = jobs.filter((j) => (wantId === null || String(j.id).startsWith(wantId)) && (wantTo === null || j.to === wantTo))
            if ((wantId !== null || wantTo !== null) && picked.length === 0) {
                return `没找到匹配的任务（${wantId ?? ''}${wantTo ?? ''}）—— 现有：\n  ${jobs.slice(0, 10).map((j) => j.id).join('\n  ')}`
            }
            const list = (wantId !== null || wantTo !== null) ? picked : jobs.slice(0, clampInt(args?.limit, 1, 200, 20))
            const lines = list.map((j) => describeJob(j).line)
            const detail = (wantId !== null || wantTo !== null) && list.length === 1 ? list[0] : null
            const out = [`downloads root: ${stateDirOf(exec)}`, `total: ${jobs.length} job(s)`, ...lines]
            if (sweepNote(swept) !== '') out.push(sweepNote(swept))
            if (detail !== null) {
                const part = partPathOf(detail.to)
                const partExists = existsSync(part)
                out.push(
                    '',
                    `详情 ${detail.id}`,
                    `  state      : ${describeJob(detail).state}`,
                    `  url        : ${detail.url}`,
                    `  最终 URL   : ${detail.finalUrl ?? '-'}`,
                    `  目标       : ${detail.to}`,
                    `  .part      : ${partExists ? `${mb(statSync(part).size)}（保留 ⇒ 可续传）` : '（不存在）'}`,
                    `  threads    : ${detail.threads ?? '?'}  splits=${detail.splits ?? 0}  mode=${detail.mode ?? '?'}`,
                    `  proxy      : ${detail.proxy ? (detail.proxy.kind === 'none' ? `直连（${directReason(detail.proxy.source)}）` : `${detail.proxy.kind}://${detail.proxy.host}:${detail.proxy.port}`) : '-'}`,
                    `  起止       : ${detail.startedAt ?? '-'} → ${detail.updatedAt ?? '-'}`,
                    detail.error ? `  ⚠ 错误     : ${detail.error}` : '',
                    detail.state === 'done' ? `  ✅ 已完成，sha256 ${detail.sha256 ?? '(未算)'}` : '',
                )
            }
            return out.filter((l) => l !== '').join('\n')
        },
    })

    const cancelTool = ({
        name: 'download_cancel',
        description: 'Cancel a background download (writes a cancel flag the worker checks, then kills the worker if needed). By default the .part + manifest are KEPT so a later download with the same destination resumes; pass deletePart:true to remove them.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                id: { type: 'string', description: 'Job id (or id prefix).' },
                to: { type: 'string', description: 'Cancel the job whose destination is this path.' },
                deletePart: { type: 'boolean', description: 'Also delete the .part + manifest (default false: keep for resume).' },
                waitMs: { type: 'number', description: 'How long to wait for the worker to stop (default 3000).' },
            },
        },
        output: textOutput(),
        async execute(args, exec) {
            const wantId = typeof args?.id === 'string' ? args.id : null
            const wantTo = typeof args?.to === 'string' ? resolveFrom(args.to, dirOf(exec)) : null
            if (wantId === null && wantTo === null) throw new Error('要给 id 或 to（用 download { action: "status", all: true } 看有哪些任务）')
 // 用与 status 相同的候选目录：任务可能写在**目标文件所在目录**（修）
            const files = listJobFiles(exec, args)
            const found = files.map((f) => ({ f, job: readStatus(f) })).filter((x) => x.job !== null)
            const hit = found.find((x) => (wantId !== null && String(x.job.id).startsWith(wantId)) || (wantTo !== null && x.job.to === wantTo))
            if (hit === undefined) throw new Error(`没找到任务（${wantId ?? wantTo}）`)
            const job = hit.job
            const jobDir = dirname(hit.f)
            if (job.state === 'done') return `任务 ${job.id} 已经完成，无需取消（目标 ${job.to}）`
            writeFileSync(join(jobDir, `${job.id}.cancel`), new Date().toISOString())
            const waitMs = clampInt(args?.waitMs, 200, 60000, 3000)
            const t0 = Date.now()
            let stopped = false
            while (Date.now() - t0 < waitMs) {
                const now = readStatus(join(jobDir, `${job.id}.json`))
                if (now !== null && now.state === 'cancelled') { stopped = true; break }
                if (!pidAlive(job.pid)) { stopped = true; break }
                await new Promise((r) => setTimeout(r, 150))
            }
            if (!stopped && pidAlive(job.pid)) {
                try { process.kill(job.pid) }
                catch { /* 已经退了 */ }
                stopped = true
            }
            const part = partPathOf(job.to)
            let removed = false
            if (args?.deletePart === true) {
                for (const p of [part, `${part}.manifest.json`]) {
                    if (existsSync(p)) { rmSync(p, { force: true }); removed = true }
                }
            }
            // 取消完就是终态：顺手把它的 spec/cancel 临时件清掉
            const swept = pruneState(exec, args)
            return [
                `cancelled ${job.id}`,
                `  目标 ${job.to}`,
                existsSync(part) ? `  .part 保留 ${mb(statSync(part).size)} ⇒ 再次 download 同 to 会**续传**（deletePart:true 可删除）` : '  .part 不存在（可能是刚起或已完成）',
                removed ? '  已按 deletePart:true 删除 .part + manifest' : '',
                swept.temp > 0 || swept.legacyRecords > 0 || swept.dirsRemoved > 0 ? `  ${sweepNote(swept)}` : '',
            ].filter(Boolean).join('\n')
        },
    })

 // ── 合并成**一个** action 驱动的工具（工具面收敛 3→1）────────────────────────
    // 三个动词共用 `id`/`to` 两个参数，分开注册等于把同一套定位逻辑讲三遍（实测 4,364 字符）。
    // 业务逻辑一行没改：仍然走上面三个 execute（render 也委派过去，保真）。
    // `action` 可省 ⇒ 默认 start（最常见："给我下这个 URL"），`probe:true` 照旧可用。
    const ACTION_OF = { start: 'download', probe: 'download', status: 'download_status', cancel: 'download_cancel' }
    const PARAMS_OF = {
        start: ['url', 'to', 'probe', 'mode', 'threads', 'resume', 'overwrite', 'proxy', 'headers', 'cookie', 'referer', 'sha256', 'expectedBytes', 'minSplitSize', 'lowestSpeedLimit', 'speedLimit', 'timeoutMs'],
        probe: ['url', 'to', 'probe', 'mode', 'threads', 'resume', 'overwrite', 'proxy', 'headers', 'cookie', 'referer', 'sha256', 'expectedBytes', 'minSplitSize', 'lowestSpeedLimit', 'speedLimit', 'timeoutMs'],
        status: ['id', 'to', 'all', 'limit'],
        cancel: ['id', 'to', 'deletePart', 'waitMs'],
    }
    const implOf = (action) => ({ download: jobTool, download_status: statusTool, download_cancel: cancelTool })[ACTION_OF[action]] ?? null
    const merged = tool({
        name: 'download',
        description: [
            'Multi-connection downloader with resume, checksum and proxy awareness. One tool: `action` picks the verb (default start).',
            'start downloads (leave `threads` unset to auto-pick; `.part`+manifest make a re-run resume; files >32 MB go to the background by themselves),',
            'probe measures only, status/cancel manage background jobs (cancel keeps the `.part`).',
            'Parameter descriptions are prefixed with the action(s) they belong to; parameters for another action are rejected, not ignored.',
            'Details and failure modes: docs/DOWNLOAD.md.',
        ].join(' '),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', enum: ['start', 'probe', 'status', 'cancel'], description: 'Which verb to run. Default: start.' },
                url: { type: 'string', description: 'start/probe: HTTP(S) URL to download.' },
                to: { type: 'string', description: 'start: destination file (absolute, or relative to the session workspace); the default is <workspace>/downloads/<name>. status/cancel: match a job by its destination path.' },
                probe: { type: 'boolean', description: 'start: only PROBE (follow redirects, report Range support / total size / per-connection throughput). Writes nothing.' },
                mode: { type: 'string', enum: ['auto', 'foreground', 'background'], description: 'start: auto (default) is foreground when the file is <= 32 MB or unknown, otherwise background.' },
                threads: { type: 'number', description: 'start: parallel connections. OMIT for AUTO (recommended) — it is decided from file size + measured per-connection throughput. Pass 1..32 to force it; 1 = single stream.' },
                resume: { type: 'boolean', description: 'start: resume from an existing .part + manifest (default true); remote-change detection restarts safely.' },
                overwrite: { type: 'boolean', description: 'start: allow replacing an existing target file (default false).' },
                proxy: { type: 'string', description: 'start: usually OMIT this. "auto" (default) = follow the system proxy, and go direct when none is configured (safe in both worlds). "direct" = force a direct connection (right for hosts you know are reachable, e.g. LAN/localhost). Or an explicit URL like http://127.0.0.1:7890 / socks5h://user:pass@127.0.0.1:7891.' },
                headers: { type: 'array', items: { type: 'string' }, description: 'start: extra request headers as "Name: value" strings.' },
                cookie: { type: 'string', description: 'start: Cookie header value (shorthand for a headers entry).' },
                referer: { type: 'string', description: 'start: Referer header value (many CDNs 403 without it).' },
                sha256: { type: 'string', description: 'start: expected sha256 (hex, optional "sha256:" prefix). Mismatch deletes the .part and fails.' },
                expectedBytes: { type: 'number', description: 'start: expected exact size in bytes (mismatch aborts before downloading).' },
                minSplitSize: { type: 'number', description: 'start: do not create chunks smaller than this (default 1048576 bytes).' },
                lowestSpeedLimit: { type: 'number', description: 'start: split a chunk whose speed stays below this (bytes/s) — default 8192; stalled proxy connections get re-queued.' },
                speedLimit: { type: 'number', description: 'start: global speed limit in bytes/s (0 = unlimited).' },
                timeoutMs: { type: 'number', description: 'start: per-request timeout in ms (default 30000).' },
                id: { type: 'string', description: 'status/cancel: job id (or id prefix).' },
                all: { type: 'boolean', description: 'status: list every known job.' },
                limit: { type: 'number', description: 'status: max rows when listing (default 20).' },
                deletePart: { type: 'boolean', description: 'cancel: also delete the .part + manifest (default false: keep for resume).' },
                waitMs: { type: 'number', description: 'cancel: how long to wait for the worker to stop (default 3000).' },
            },
        },
        output: {
            schema: { type: 'string', description: 'Human-readable report (plain text).' },
            render(args, value) {
                const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'start'
                const t = implOf(action === 'probe' ? 'probe' : action)
                return t?.output?.render ? t.output.render(args, value) : [{ type: 'text', text: String(value) }]
            },
        },
        async execute(args, exec) {
            let action = typeof args?.action === 'string' && args.action !== '' ? args.action : (args?.probe === true ? 'probe' : 'start')
            if (action === 'start' && args?.probe === true) action = 'probe'
            const target = implOf(action)
            if (target === null) throw new Error(`未知 action ${JSON.stringify(args?.action)}；可用：start / probe / status / cancel`)
            if ((action === 'start' || action === 'probe') && (args?.url === undefined || args.url === '')) {
                throw new Error(`action "${action}" 需要参数 url；要查进度用 { action: "status", id: "dl-…" }，要停止用 { action: "cancel", id: "dl-…" }`)
            }
            const allowed = new Set([...(PARAMS_OF[action] ?? []), 'action'])
            const strays = Object.keys(args ?? {}).filter((k) => !allowed.has(k))
            if (strays.length > 0) {
                throw new Error(`action "${action}" 不接受参数 ${strays.map((s) => JSON.stringify(s)).join(', ')}（该 action 可用：${(PARAMS_OF[action] ?? []).join(', ') || '无'}）`)
            }
 // ⚠️ 宿主侧评审抓到的 P0（合并层路由丢失判别位）：旧实现判的是 `args.probe === true || args.dryRun === true`
            // （本文件 :255），而 `{ action: "probe" }` 这两个字段都是 undefined ⇒ 会掉进**普通下载**分支：
            // 以为在探测、实际花流量还写了文件。这里显式把判别位补上（`action:"probe"` 是权威意图，压过 probe:false）。
            const callArgs = action === 'probe' ? { ...args, probe: true } : args
            // 起新任务前顺手扫一遍旧状态：这样"以前版本留在目标目录里的 `.dsh-downloads`"也会被清掉
            pruneState(exec, args)
            return await target.execute(callArgs, exec)
        },
    })
    return [merged]
}

/** 整数夹取（参数可能来自模型，类型不保证） */
function clampInt(value, lo, hi, fallback) {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

/**
 * 与其它段一致的转换：**先把 JSON Schema 转成宿主字段映射方言**，再交给 `defineTool`。
 *
 * ⚠️ 血的教训：这里原本直接交原始 JSON Schema，宿主 DSL 拒收
 * （`unsupported JSON schema: parameters.type must be a value schema object`）⇒ 工具退回“无 schema”注册
 * ⇒ **整个会话起不来**（`session event "request/header" carries non-JSON-serializable data`）。
 * 契约就是别自己拼 schema：`defineTool({ ...def, parameters: toFieldMap(def.parameters) })`。
 */
function toValueSchema(parameters) {
    return toFieldMap(parameters)
}

export function apply(ctx, defineTool, options = {}) {
    if (typeof options?.resolveWorkspaceCwd === 'function') config.resolveWorkspaceCwd = options.resolveWorkspaceCwd
    const defs = tools(defineTool, { getCtx: options?.getCtx })
    for (const def of defs) ctx.tools.register(def)
    return defs.length
}

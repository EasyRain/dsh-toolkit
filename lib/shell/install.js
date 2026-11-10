/**
 * bash 的"有没有装 / 装一下"—— 宿主侧（**两个明确安装源**，不做代理探测）。
 *
 * 为什么不自带 bash：dsh-ops 自带 PortableGit 让包变成 +392 MB。我们改成
 * "优先用系统 Git；没有就一键装一份**用户级** PortableGit"：
 *  - 装到 `%LOCALAPPDATA%\dsh-toolkit\git`，不需要管理员、不写注册表、不动系统 Git；
 *  - 装完把 60 MB 安装包删掉；
 *  - 检测顺序见 `lib/shell/bash.js` 的 `localCandidates()`（自装的优先于系统的）。
 *
 * 源分成两个（用户自己选，程序不猜网络）：
 *  - `mirror`：npmmirror 国内镜像，**直连**（实测 60 MB / 2.7 s）；
 *  - `github`：GitHub release，给"有系统代理/能直连"的人。
 *
 * 下载复用 `lib/download/engine.js`（多线程 + 续传 + 校验），解压用 PortableGit 自带的
 * 7z SFX：`PortableGit-*.7z.exe -y -o<dir>`（实测 11.7 s，产物就是 `bin\bash.exe`）。
 *
 * 依赖全部可注入，自测不碰网络也不碰磁盘。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findBash, requestShellRemount } from './bash.js'
import { NIUBASH, NIUBASH_SOURCE_IDS, findNiubash, installNiubash, niubashRoot } from './niubash.js'
import { downloadFile } from '../download/engine.js'
import { SOURCES, SOURCE_IDS, assetName, downloadDir, installDir, manualHint, sourceUrl } from './sources.js'

const errorText = (error) => (error instanceof Error ? error.message : String(error))

export function createInstaller(deps = {}) {
    const find = deps.find ?? findBash
    const download = deps.download ?? downloadFile
    const spawnFn = deps.spawnFn ?? spawn
    const mkdir = deps.mkdir ?? mkdirSync
    const remove = deps.remove ?? rmSync
    const exists = deps.exists ?? existsSync
    const env = deps.env ?? process.env
    const platform = deps.platform ?? process.platform
    let job = null

    const snapshot = () => (job === null ? { state: 'idle' } : {
        state: job.state,
        source: job.source,
        phase: job.phase,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        progress: job.progress,
        error: job.error,
        path: job.path,
        lines: job.lines.slice(-8),
    })

    const status = () => {
        const path = find()
        // 注意：`installed` 只是"系统/自装 Git Bash 在哪"的**诊断**信息 —— 工具本身不再使用它（见 pickBash）。
        return {
            installed: path !== null,
            path,
            platform: process.platform,
            arch: process.arch,
            canInstall: platform === 'win32',
            dir: installDir(env),
            manual: manualHint(platform),
            sources: SOURCE_IDS.map((id) => ({ id, label: SOURCES[id].label })),
            job: snapshot(),
        }
    }

    const extract = (exe, target) => new Promise((resolve, reject) => {
        mkdir(target, { recursive: true })
        let child
        try {
            // PortableGit 是 7z 自解压包：`-y` 全部覆盖、`-o<dir>` 指定解压目录（注意**没有空格**）。
            child = spawnFn(exe, ['-y', `-o${target}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        }
        catch (error) {
            reject(error)
            return
        }
        const remember = (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                const text = line.trim()
                if (text !== '') job?.lines.push(text)
            }
            if (job !== null && job.lines.length > 200) job.lines.splice(0, job.lines.length - 200)
        }
        try {
            child.stdout?.on('data', remember)
            child.stderr?.on('data', remember)
        }
        catch { /* 流不可用不影响解压 */ }
        child.on?.('error', (error) => reject(error))
        child.on?.('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`解压失败（退出码 ${code}）；可能被杀软拦截，或安装包不完整`))
        })
    })

    const run = async (sourceId) => {
        const target = installDir(env)
        const archive = join(downloadDir(env), assetName())
        mkdir(dirname(archive), { recursive: true })
        const url = sourceUrl(sourceId)
        job.url = url
        await download({
            url,
            to: archive,
            threads: 8,
            // **不做代理探测**：选镜像的人就是直连；选 GitHub 的人自己保证网络。
            proxy: 'direct',
            overwrite: true,
            timeoutMs: 120000,
            onProgress: (progress) => {
                if (job === null) return
                job.progress = {
                    downloaded: progress?.downloaded ?? 0,
                    total: progress?.total ?? 0,
                    percent: Math.round(progress?.percent ?? 0),
                }
            },
        })
        job.phase = 'extract'
        await extract(archive, target)
        job.phase = 'verify'
        const path = find()
        if (path === null) {
            job.state = 'failed'
            job.error = '安装包解压完成，但仍然找不到 bash.exe（目录结构可能变了）'
        }
        else {
            job.state = 'done'
            job.path = path
            try { remove(archive, { force: true }) } catch { /* 删不掉只是占 60 MB */ }
        }
        job.finishedAt = new Date().toISOString()
    }

    const start = (sourceId = 'mirror') => {
        if (find() !== null) return { started: false, already: true, status: status() }
        if (!SOURCE_IDS.includes(sourceId)) return { started: false, unknownSource: true, status: status() }
        if (job !== null && job.state === 'installing') return { started: false, busy: true, status: status() }
        if (platform !== 'win32') return { started: false, unsupported: true, status: status() }
        job = {
            state: 'installing',
            source: sourceId,
            phase: 'download',
            lines: [],
            progress: { downloaded: 0, total: 0, percent: 0 },
            startedAt: new Date().toISOString(),
        }
        void run(sourceId).catch((error) => {
            if (job === null) return
            job.state = 'failed'
            job.error = errorText(error)
            job.finishedAt = new Date().toISOString()
        })
        return { started: true, status: status() }
    }

    return { status, start }
}

/**
 * 受限运行时（Windows 沙箱里的 bash）的安装器 —— 同样"用户级、可注入、不碰网络实现"。
 *
 * 为什么要它：workspace-write / read-only 会话里系统 Git Bash 起不来（MSYS 在 Low IL 下建信号管道被拒），
 * 而 **dsh-ops 不是必需品** —— 我们自己装一份 Niubash 就能跑受限 bash。
 */
export function createRuntimeInstaller(deps = {}) {
    const env = deps.env ?? process.env
    const platform = deps.platform ?? process.platform
    const install = deps.install ?? ((options) => installNiubash({ ...options, env, download: deps.download ?? downloadFile }))
    const find = deps.find ?? (() => findNiubash({ env }))
    // 装好后默认尝试把 shell 族挂上（`apply()` 缺运行时返回 0 时登记的回调）。
    const onInstalled = deps.onInstalled ?? (() => requestShellRemount())
    let job = null

    const snapshot = () => (job === null ? { state: 'idle' } : {
        state: job.state,
        source: job.source,
        phase: job.phase,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        progress: job.progress,
        error: job.error,
        path: job.path,
    })

    const status = () => {
        let current = null
        try { current = find() } catch { current = null }
        return {
            available: current !== null,
            path: current?.file ?? null,
            dir: niubashRoot(env),
            version: NIUBASH.version,
            platform,
            arch: process.arch,
            // 只有 Windows x64 有这份载荷（上游只发 win-x64）。
            canInstall: platform === 'win32' && process.arch === 'x64',
            url: NIUBASH.url,
            bytes: NIUBASH.bytes,
            sources: NIUBASH_SOURCE_IDS.map((id) => ({ id, label: id === 'mirror' ? '国内加速' : 'GitHub' })),
            job: snapshot(),
        }
    }

    const start = (sourceId = 'mirror') => {
        if (find() !== null) return { started: false, already: true, status: status() }
        if (platform !== 'win32' || process.arch !== 'x64') return { started: false, unsupported: true, status: status() }
        if (job !== null && job.state === 'installing') return { started: false, busy: true, status: status() }
        if (!NIUBASH_SOURCE_IDS.includes(sourceId)) return { started: false, unknownSource: true, status: status() }
        job = { state: 'installing', source: sourceId, phase: 'download', startedAt: new Date().toISOString(), progress: { downloaded: 0, total: NIUBASH.bytes, percent: 0 } }
        void (async () => {
            try {
                const runtime = await install({
                    source: sourceId,
                    onProgress: (progress) => {
                        if (job === null) return
                        job.progress = {
                            downloaded: progress?.downloaded ?? 0,
                            total: progress?.total ?? NIUBASH.bytes,
                            percent: Math.round(progress?.percent ?? 0),
                        }
                    },
                })
                if (job === null) return
                job.phase = 'verify'
                job.state = runtime === null ? 'failed' : 'done'
                job.path = runtime?.file ?? null
                if (runtime === null) job.error = '下载与解压完成，但没有找到可用的 niu.exe'
                // 装好就把 shell 族**立即挂上**（用户不必重启宿主）。
                else {
                    try { await onInstalled(runtime) } catch { /* 挂载失败只影响本次即时生效，重启后仍可用 */ }
                }
            }
            catch (error) {
                if (job === null) return
                job.state = 'failed'
                job.error = errorText(error)
            }
            finally {
                if (job !== null) job.finishedAt = new Date().toISOString()
            }
        })()
        return { started: true, status: status() }
    }

    return { status, start }
}

export const installer = createInstaller()
export const runtimeInstaller = createRuntimeInstaller()
export const bashStatus = () => ({ ...installer.status(), runtime: runtimeInstaller.status() })
export const startInstall = (sourceId) => installer.start(sourceId)
export const startRuntimeInstall = (sourceId) => runtimeInstaller.start(sourceId)

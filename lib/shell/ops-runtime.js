/**
 * Windows 受限模式专用：借用 dsh-ops 的**受限运行时**。
 *
 * 为什么需要它：系统 Git Bash 在宿主沙箱里起不来（MSYS 建信号管道被拒，`0xC0000142`）。
 * dsh-ops 验证过两条路：
 *   ① **Niubash**（dsh-ops 0.5.x 起的默认 Windows 载荷）：原生 shell，沙箱由宿主提供，
 *      首次使用时在 `DSH_HOME` 里准备一次副本（`dsh-ops/shells/niubash-prepared/<hash>`）；
 *   ② **钉住的 MSYS + IPC 补丁**（0.4.x 的默认，现在降级为 legacy）：复制它钉住的 MSYS →
 *      给 `msys-2.0.dll` 打补丁 → 再交给宿主 `sandbox.confine`。
 *
 * 我们**不自带**上百 MB 载荷，而是复用机器上已安装的 dsh-ops（MIT）：
 * 优先 Niubash（新默认），退回 MSYS（老版本 / 显式 Git Bash 用户）；
 * 两者都拿不到 ⇒ 返回 `null`，调用方据此**明确拒绝**，绝不放行。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

let memo

/** 解析 dsh-ops 的安装根目录（profile 的 node_modules 里）。 */
function opsRootOf() {
    const require = createRequire(import.meta.url)
    try { return dirname(require.resolve('dsh-ops/package.json')) }
    catch { return dirname(require.resolve('dsh-ops')) }
}

/**
 * 只校验**可执行文件**与收据哈希（比整树校验宽松，用于运行过的树）。
 *
 * 为什么需要：Niubash 第一次执行会在自己的目录里建 `winuxcmd/dev`（运行时目录），
 * 而冻结清单只列“压缩包里出现过的目录” ⇒ 整树校验从此永远失败（dsh-ops 0.5.2 的已知问题，
 * 其 dev 分支改成“先复制一份再跑”来规避）。我们退一步只认最关键的那一项：`niu.exe` 的 sha256
 * 必须等于收据里的 `executableSha256`，其余运行时目录不参与判定 —— 安全性不打折（跑的就是这个 exe）。
 */
function verifyExecutableOnly(root) {
    try {
        const receiptNames = ['provenance.json']
        let receipt = null
        for (const name of receiptNames) {
            const file = join(root, name)
            if (!existsSync(file)) continue
            receipt = JSON.parse(readFileSync(file, 'utf8'))
            break
        }
        if (receipt === null || receipt.backend !== 'niubash') return false
        if (typeof receipt.executableSha256 !== 'string' || receipt.executableSha256 === '') return false
        const exe = join(root, typeof receipt.executable === 'string' && receipt.executable !== '' ? receipt.executable : 'niu.exe')
        if (!existsSync(exe)) return false
        const digest = createHash('sha256').update(readFileSync(exe)).digest('hex')
        return digest === receipt.executableSha256
    }
    catch { return false }
}

/** 与 dsh-ops 的 `runtime()` 同形：NIU_ROOT + 该载荷自己的 PATH 前缀。 */
function niubashEnv(root, inheritedPath = process.env.PATH ?? process.env.Path ?? '') {
    return {
        NIU_ROOT: join(root, 'winuxcmd'),
        PATH: [root, join(root, 'bin'), join(root, 'winuxcmd', 'usr', 'bin'), join(root, 'winuxcmd', 'bin'), inheritedPath]
            .filter(Boolean).join(';'),
    }
}

/** Niubash：dsh-ops 0.5.x 的默认后端（模块不存在时返回 null，交给 MSYS 分支）。 */
async function tryNiubash(opsRoot) {
    try {
        const mod = await import(pathToFileURL(join(opsRoot, 'lib', 'niubash', 'runtime.js')).href)
        if (typeof mod.niubashCandidates !== 'function' || typeof mod.verifiedNiubash !== 'function') return null
        for (const candidate of mod.niubashCandidates(opsRoot, process.env)) {
            if (typeof candidate?.file !== 'string' || !existsSync(candidate.file)) continue
            try {
                // 整树校验（冻结清单 + 收据）：全新载荷走这条。
                const runtime = mod.verifiedNiubash(candidate.file)
                if (typeof runtime?.file === 'string' && runtime.file !== '') {
                    return { file: runtime.file, env: runtime.env ?? {}, backend: 'niubash', integrity: 'tree' }
                }
            }
            catch {
                // 跑过一次之后 niu 会建 winuxcmd/dev ⇒ 整树校验必然失败；退到"只认 exe 哈希"。
                const root = dirname(candidate.file)
                if (verifyExecutableOnly(root)) {
                    return { file: candidate.file, env: niubashEnv(root), backend: 'niubash', integrity: 'executable' }
                }
            }
        }
        return null
    }
    catch { return null }
}

/** legacy MSYS：0.4.x 的钉住载荷 + `confinedBash`（IPC 补丁）。 */
async function tryMsys(opsRoot) {
    try {
        const bashIpc = await import(pathToFileURL(join(opsRoot, 'lib', 'bash-ipc.js')).href)
        if (typeof bashIpc.confinedBash !== 'function') return null
        const require = createRequire(import.meta.url)
        let pinnedRoot
        try { pinnedRoot = dirname(require.resolve('@dsh-ops/bash-win32-x64/package.json')) }
        catch { pinnedRoot = join(opsRoot, '..', '@dsh-ops', 'bash-win32-x64') }
        const pinnedBash = join(pinnedRoot, 'usr', 'bin', 'bash.exe')
        if (!existsSync(pinnedBash)) return null
        const runtime = bashIpc.confinedBash(pinnedBash, { source: 'bundled' })
        if (typeof runtime?.file !== 'string' || runtime.file === '') return null
        return { file: runtime.file, env: runtime.env ?? {}, backend: 'msys' }
    }
    catch { return null }
}

/**
 * 解析可用的受限运行时（Niubash 优先，MSYS 兜底）。
 *
 * @param {{opsRoot?: string, platform?: string}} [options] `opsRoot` 仅供自测注入（指向一个假的 dsh-ops 包）。
 * @returns {Promise<{file: string, env: Record<string,string>, backend: 'niubash'|'msys'} | null>}
 */
export async function resolveOpsConfinedBash(options = {}) {
    if ((options.platform ?? process.platform) !== 'win32') return null
    const injected = typeof options.opsRoot === 'string' && options.opsRoot !== ''
    if (!injected && memo !== undefined) return memo
    let resolved = null
    try {
        const opsRoot = injected ? options.opsRoot : opsRootOf()
        resolved = (await tryNiubash(opsRoot)) ?? (await tryMsys(opsRoot))
    }
    catch {
        resolved = null
    }
    if (!injected) memo = resolved
    return resolved
}

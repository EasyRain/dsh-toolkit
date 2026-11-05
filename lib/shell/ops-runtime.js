/**
 * Windows 受限模式专用：借用 dsh-ops 的**私有 MSYS 运行时**。
 *
 * 为什么需要它：系统 Git Bash 在宿主沙箱里起不来（MSYS 建信号管道被拒，`0xC0000142`）。
 * dsh-ops 的解法是：复制它钉住的 MSYS → 给 `msys-2.0.dll` 打 IPC 补丁 → 用打过补丁的 bash 跑，
 * 再交给宿主 `sandbox.confine`。这条路它们已经验证过。
 *
 * 我们**不自带** 174 MB 载荷，而是复用机器上已安装的：
 *   - `dsh-ops`（MIT）的 `lib/bash-ipc.js`
 *   - `@dsh-ops/bash-win32-x64` 的钉住载荷
 * 任一缺失 / 版本不符 / 打补丁失败 ⇒ 返回 `null`，调用方据此**明确拒绝**，绝不放行。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

let memo

/** @returns {Promise<{file: string, env: Record<string,string>} | null>} */
export async function resolveOpsConfinedBash() {
    if (process.platform !== 'win32') return null
    if (memo !== undefined) return memo
    try {
        const require = createRequire(import.meta.url)
        let opsRoot
        try { opsRoot = dirname(require.resolve('dsh-ops/package.json')) }
        catch { opsRoot = dirname(require.resolve('dsh-ops')) }
        const bashIpc = await import(pathToFileURL(join(opsRoot, 'lib', 'bash-ipc.js')).href)
        if (typeof bashIpc.confinedBash !== 'function') throw new Error('dsh-ops/lib/bash-ipc.js 没有导出 confinedBash')

        let pinnedRoot
        try { pinnedRoot = dirname(require.resolve('@dsh-ops/bash-win32-x64/package.json')) }
        catch { pinnedRoot = join(opsRoot, '..', '@dsh-ops', 'bash-win32-x64') }
        const pinnedBash = join(pinnedRoot, 'usr', 'bin', 'bash.exe')
        const runtime = bashIpc.confinedBash(pinnedBash, { source: 'bundled' })
        if (typeof runtime?.file !== 'string' || runtime.file === '') throw new Error('confinedBash 没有返回可执行路径')
        memo = { file: runtime.file, env: runtime.env ?? {} }
        return memo
    }
    catch {
        memo = null
        return null
    }
}

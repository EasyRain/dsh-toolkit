/**
 * 受限模式（read-only / workspace-write）用的运行时解析。
 *
 * 为什么需要它：Windows 沙箱把进程压到 Low IL，系统 Git Bash（MSYS）在 Low IL 下**建不了信号管道**
 * （`couldn't create signal pipe, Win32 error 5` / `0xC0000142`）⇒ 受限模式必须换一个原生 shell。
 *
 * 我们的选择：**只认自己装的 Niubash**（`%LOCALAPPDATA%\dsh-toolkit\niubash\<版本>`，
 * 或者离线包里自带的 `runtime/niubash/<版本>`）——
 *   ① 用户机器上的 bash 五花八门（Git Bash / WSL / 魔改版），行为不一致；
 *   ② 借 dsh-ops 的运行时会让"装了 ops 的机器"和"没装的机器"表现不同，而 ops 不在是常态；
 *   ③ dsh-ops 0.5.2 的 Niubash 首次执行后会写自己的目录，整树校验永久失败（我们踩过）。
 *
 * 没有运行时 ⇒ 返回 `null`，调用方**明确拒绝**（fail-closed），提示去设置页下载。
 */
import { packageRoot, resolveNiubash } from './niubash.js'

let memo

/**
 * @param {{env?: object, platform?: string, packageRoot?: string}} [options]
 * @returns {Promise<{file: string, env: Record<string,string>, backend: 'niubash', source: 'dsh-toolkit'} | null>}
 */
export async function resolveOpsConfinedBash(options = {}) {
    if ((options.platform ?? process.platform) !== 'win32') return null
    const cacheable = options.env === undefined && options.packageRoot === undefined
    if (cacheable && memo !== undefined) return memo
    let resolved = null
    try {
        const niu = resolveNiubash({
            env: options.env ?? process.env,
            ...(options.packageRoot === undefined ? { packageRoot: packageRoot() } : { packageRoot: options.packageRoot }),
        })
        if (niu !== null) resolved = { file: niu.file, env: niu.env, backend: 'niubash', source: 'dsh-toolkit' }
    }
    catch { resolved = null }
    if (cacheable) memo = resolved
    return resolved
}

/** 兼容旧名（`bash.js` 早先 import 的是这个名字）。 */
export const resolveConfinedBash = resolveOpsConfinedBash

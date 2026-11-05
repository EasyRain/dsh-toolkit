/**
 * bash 安装源 —— **两个明确的源，不做代理探测**。
 *
 * 背景（实测）：国内不挂代理访问 GitHub 基本连不上，而 npmmirror 的
 * `/-/binary/git-for-windows/` 镜像有完整的 PortableGit（实测 60 MB / 2.7 s）；华为云镜像也可用。
 * 所以设置页给**两个按钮**，让用户自己选，而不是让程序猜网络环境：
 *   - `mirror`：npmmirror 国内镜像（默认推荐，直连）；
 *   - `github`：GitHub 官方 release（需要系统级代理/能直连的人用）。
 *
 * 两者下的是**同一个文件**（同一个版本、同名 PortableGit），所以校验/解压路径完全一致。
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 固定一个经过实测的版本；镜像会长期保留它（升级时改这里并跑一次实测）。 */
export const GIT_VERSION = 'v2.56.0.windows.4'

export const SOURCES = Object.freeze({
    mirror: { id: 'mirror', label: '国内镜像（npmmirror）', base: 'https://registry.npmmirror.com/-/binary/git-for-windows' },
    github: { id: 'github', label: 'GitHub 官方', base: 'https://github.com/git-for-windows/git/releases/download' },
})

export const SOURCE_IDS = Object.freeze(Object.keys(SOURCES))

/**
 * PortableGit 资产名。Git for Windows 的 tag 与文件名规则不同：
 *   tag `v2.56.0.windows.4` → 文件 `PortableGit-2.56.0.4-64-bit.7z.exe`
 */
export function assetName(version = GIT_VERSION, arch = process.arch) {
    const bare = String(version).replace(/^v/i, '').replace(/windows\./i, '')
    const suffix = arch === 'arm64' ? 'arm64' : '64-bit'
    return `PortableGit-${bare}-${suffix}.7z.exe`
}

export function sourceUrl(id, { version = GIT_VERSION, arch = process.arch } = {}) {
    const source = SOURCES[id]
    if (source === undefined) throw new Error(`未知的安装源 ${JSON.stringify(id)}；可用：${SOURCE_IDS.join(', ')}`)
    return `${source.base}/${version}/${assetName(version, arch)}`
}

/** 本插件自己安装的位置（不碰系统 Git，也不需要管理员）。 */
export function installDir(env = process.env) {
    const local = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== '' ? env.LOCALAPPDATA : join(homedir(), 'AppData', 'Local')
    return join(local, 'dsh-toolkit', 'git')
}

/** 安装包的落盘位置（与 installDir 同一父目录，装完会删）。 */
export function downloadDir(env = process.env) {
    return join(dirname(installDir(env)), 'downloads')
}

export function manualHint(platform = process.platform) {
    if (platform === 'win32') return { label: 'Git for Windows（手动安装）', url: 'https://git-scm.com/download/win' }
    if (platform === 'darwin') return { label: 'bash（Homebrew）', url: 'https://www.gnu.org/software/bash/', command: 'brew install bash' }
    return { label: 'bash（发行版包管理器）', url: 'https://www.gnu.org/software/bash/', command: 'sudo apt-get install -y bash' }
}

/**
 * 自带受限运行时（Niubash）—— **不依赖 dsh-ops** 的 Windows 沙箱方案。
 *
 * 为什么需要：Windows 的 workspace-write / read-only 会话里，系统 Git Bash 起不来
 * （MSYS 在 Low IL 下建信号管道被拒：`couldn't create signal pipe, Win32 error 5` / 0xC0000142）。
 * dsh-ops 的解法是"钉住的私有 MSYS + DLL 补丁"（约 174 MB），或者换 **Niubash**（原生 shell，
 * 直接受宿主沙箱约束）。我们自己装一份 Niubash，就能在没有 dsh-ops 的机器上继续用受限 bash。
 *
 * 与我们其它安装流程一样的取舍：
 *  - 装到 **用户级** `%LOCALAPPDATA%\dsh-toolkit\niubash\<版本>`，不要管理员、不动系统；
 *  - **只从 GitHub release 下**（npmmirror 没有这个二进制），下完校验 **归档 sha256**（钉死）再解压，
 *    解压只认 `.tar.gz` 里的普通文件/目录（拒绝绝对路径、`..`、符号链接）；
 *  - 解压后确认 `niu.exe` 存在，并把它自己的 sha256 记进 `.verified` 标记，之后**不再重复哈希** 33 MB。
 *
 * 全部依赖可注入 ⇒ 自测不碰网络。
 */
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** 钉死的上游版本与归档指纹（与 dsh-ops 用的是同一份 Niubash 1.5.0）。 */
export const NIUBASH = Object.freeze({
    version: '1.5.0',
    archive: 'niubash-v1.5.0-win-x64.tar.gz',
    url: 'https://github.com/unixwin/niubash/releases/download/v1.5.0/niubash-v1.5.0-win-x64.tar.gz',
    sha256: 'da28cdc4e2e87f777ee0eae71386276f9c6a0ed135c1e2baad943acd8d349b87',
    bytes: 32_931_587,
    executable: 'niu.exe',
})

const MARKER = '.dsh-toolkit-niubash.json'

/** 用户级安装目录（与 PortableGit 的 `dsh-toolkit\git` 同级）。 */
export function niubashRoot(env = process.env) {
    const base = env.LOCALAPPDATA ?? env.APPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(base, 'dsh-toolkit', 'niubash', NIUBASH.version)
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** `niu.exe` 的运行环境：NIU_ROOT + 该载荷自己的 PATH 前缀（与上游 `runtime()` 同形）。 */
export function niubashEnv(dir, inheritedPath = process.env.PATH ?? process.env.Path ?? '') {
    return {
        NIU_ROOT: join(dir, 'winuxcmd'),
        PATH: [dir, join(dir, 'bin'), join(dir, 'winuxcmd', 'usr', 'bin'), join(dir, 'winuxcmd', 'bin'), inheritedPath]
            .filter(Boolean).join(';'),
    }
}

/**
 * 找一个**已经装好且校验过**的 Niubash。
 * 首次校验会把 exe 的 sha256 写进标记文件；之后只要 exe 的 size/mtime 没变就直接信标记（省 33 MB 哈希）。
 */
export function findNiubash({ env = process.env, dir = niubashRoot(env) } = {}) {
    const exe = join(dir, NIUBASH.executable)
    let stats
    try { stats = statSync(exe) }
    catch { return null }
    if (!stats.isFile()) return null
    const marker = join(dir, MARKER)
    try {
        const remembered = JSON.parse(readFileSync(marker, 'utf8'))
        if (remembered?.version === NIUBASH.version && remembered.size === stats.size && remembered.mtimeMs === stats.mtimeMs
            && typeof remembered.sha256 === 'string' && remembered.sha256 !== '') {
            return { file: exe, dir, env: niubashEnv(dir, env.PATH ?? env.Path ?? '') }
        }
    }
    catch { /* 没有标记就重算一次 */ }
    const digest = sha256(readFileSync(exe))
    try {
        writeFileSync(marker, `${JSON.stringify({ version: NIUBASH.version, size: stats.size, mtimeMs: stats.mtimeMs, sha256: digest }, null, 2)}\n`)
    }
    catch { /* 标记写不进去不影响使用 */ }
    return { file: exe, dir, env: niubashEnv(dir, env.PATH ?? env.Path ?? ''), sha256: digest }
}

/** 只读的 512 字节 tar 头解析（`name` 与 ustar `prefix` 拼起来就是完整路径）。 */
function tarEntry(header) {
    const text = (from, length) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/, '').trim()
    const sizeText = text(124, 12).replace(/[^0-7]/g, '')
    const prefix = text(345, 155)
    const name = text(0, 100)
    return {
        name: prefix === '' ? name : `${prefix}/${name}`,
        size: sizeText === '' ? 0 : parseInt(sizeText, 8),
        type: String.fromCharCode(header[156] ?? 0),
        // 硬链接（type '1'）的目标在 157..257：Niubash 的 winuxcmd 里大量 exe 是硬链接。
        linkname: text(157, 100),
    }
}

const SAFE_TYPE = new Set(['0', '\0', '1', '5', '7'])

/**
 * 解开 `.tar.gz`：**只写普通文件与目录**，拒绝绝对路径 / `..` / 符号链接 / 设备节点。
 *
 * 为什么自己解：受限运行时要在**用户机器**上装，不能假设有 `tar.exe`（Windows 自带的是 bsdtar，
 * 但 PATH 上不一定有，且我们不想 spawn 外部程序）。上层先校验归档 sha256，这里只负责安全落地。
 *
 * @param {Buffer} archive gzip 压缩的 tar
 * @param {string} target 目标目录（已存在或会被创建）
 * @param {{strip?: number, fs?: object}} [options] `strip` = 去掉路径前几段（默认 1，剥掉顶层目录）
 * @returns {number} 写出的文件数
 */
export function extractTarGz(archive, target, options = {}) {
    const strip = Number.isInteger(options.strip) ? options.strip : 1
    const io = options.fs ?? { existsSync, linkSync, mkdirSync, writeFileSync }
    const tar = gunzipSync(archive)
    let offset = 0
    let written = 0
    const root = normalize(target)
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512)
        if (header.every((byte) => byte === 0)) break
        const entry = tarEntry(header)
        offset += 512
        const body = tar.subarray(offset, offset + entry.size)
        offset += Math.ceil(entry.size / 512) * 512
        if (!SAFE_TYPE.has(entry.type)) throw new Error(`归档里有不支持的类型（${JSON.stringify(entry.type)}）：${entry.name}`)
        const parts = entry.name.split('/').filter((part) => part !== '' && part !== '.')
        if (entry.name.startsWith('/') || isAbsolute(entry.name) || parts.includes('..')) {
            throw new Error(`归档里有不安全路径：${entry.name}`)
        }
        const stripped = parts.slice(strip)
        if (stripped.length === 0) continue
        const destination = normalize(join(root, ...stripped))
        const inside = relative(root, destination)
        if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`归档路径越界：${entry.name}`)
        if (entry.type === '5') {
            io.mkdirSync(destination, { recursive: true })
            continue
        }
        io.mkdirSync(dirname(destination), { recursive: true })
        if (entry.type === '1') {
            // 硬链接：目标同样要剥前缀并做越界检查，绝不 follow 到归档外。
            const linkParts = entry.linkname.split('/').filter((part) => part !== '' && part !== '.')
            if (entry.linkname.startsWith('/') || isAbsolute(entry.linkname) || linkParts.includes('..')) {
                throw new Error(`归档里有不安全的硬链接目标：${entry.linkname}`)
            }
            const linkTarget = normalize(join(root, ...linkParts.slice(strip)))
            const linkInside = relative(root, linkTarget)
            if (linkInside === '' || linkInside.startsWith('..') || isAbsolute(linkInside)) {
                throw new Error(`硬链接目标越界：${entry.linkname}`)
            }
            io.linkSync(linkTarget, destination)
            written += 1
            continue
        }
        io.writeFileSync(destination, body)
        written += 1
    }
    return written
}

/**
 * 下载（可选）+ 校验 + 解压 + 校验 exe，返回可用的运行时。
 * @param {{download?: Function, env?: object, dir?: string, url?: string, sha256?: string, onProgress?: Function}} [options]
 */
export async function installNiubash(options = {}) {
    const env = options.env ?? process.env
    const dir = options.dir ?? niubashRoot(env)
    const url = options.url ?? NIUBASH.url
    const expected = options.sha256 ?? NIUBASH.sha256
    const download = options.download
    if (typeof download !== 'function') throw new Error('installNiubash 需要注入 download（不内置网络实现）')
    // 下载放在**独立的临时目录**里：安装失败时不能在安装根下留空目录（否则"没装成"看起来像"装了半截"）。
    const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'dsh-toolkit-niubash-'))
    const archivePath = join(workDir, NIUBASH.archive)
    await download({ url, to: archivePath, overwrite: true, timeoutMs: 180_000, onProgress: options.onProgress })
    const archive = readFileSync(archivePath)
    const digest = sha256(archive)
    if (digest !== expected) {
        try { rmSync(archivePath, { force: true }) } catch { /* 删不掉只是占地方 */ }
        throw new Error(`Niubash 归档校验失败：期望 ${expected.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…（已丢弃，未安装）`)
    }
    // 先解到临时目录再原子换上去：解压失败不会留下半个运行时。
    const staging = `${dir}.staging-${process.pid}`
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* 无旧目录 */ }
    mkdirSync(staging, { recursive: true })
    try {
        const files = extractTarGz(archive, staging)
        if (files === 0) throw new Error('归档里没有可解出的文件')
        const stagedExe = join(staging, NIUBASH.executable)
        if (!existsSync(stagedExe)) throw new Error(`解压完成但没有 ${NIUBASH.executable}（归档结构可能变了）`)
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* 旧版本先清掉 */ }
        mkdirSync(dirname(dir), { recursive: true })
        renameSync(staging, dir)
    }
    catch (error) {
        try { rmSync(staging, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
        throw error
    }
    finally {
        try { rmSync(workDir, { recursive: true, force: true }) } catch { /* 删不掉只是占 33 MB */ }
    }
    return findNiubash({ env, dir })
}

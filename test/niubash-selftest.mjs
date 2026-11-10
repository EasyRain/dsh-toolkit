/**
 * niubash 自测：归档校验、tar 解包安全边界、标记缓存、以及"我们自己的运行时优先于 dsh-ops"。
 *
 * 为什么不联网跑：33 MB 的下载在自测里不可接受，也不可靠。这里用**手工构造的 tar.gz**
 * 覆盖解包器的每条边界（普通文件 / 目录 / `..` 越界 / 符号链接 / 绝对路径），
 * 再用注入的 `download` 演示"哈希不符 ⇒ 丢弃不安装"。
 *
 * 跑法：node test/niubash-selftest.mjs
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const niubash = await import('../lib/shell/niubash.js')
const { extractTarGz, findNiubash, installNiubash, NIUBASH, niubashRoot } = niubash
const { resolveOpsConfinedBash } = await import('../lib/shell/ops-runtime.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 240)}`}`)
}

/** 手写 tar 头（ustar，512 字节记录），足够覆盖解包器关心的字段。 */
function tarHeader(name, size, type = '0', linkname = '') {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write(linkname, 157, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write(type, 156, 1, 'ascii')
    header.write('ustar\0' + '00', 257, 8, 'ascii')
    return header
}

/** 用条目列表拼一个 tar.gz：`{name, body?, type?}`；`strip` 默认剥掉第一段。 */
function makeArchive(entries) {
    const chunks = []
    for (const entry of entries) {
        const body = entry.body === undefined ? Buffer.alloc(0) : Buffer.from(entry.body)
        chunks.push(tarHeader(entry.name, body.length, entry.type ?? '0', entry.linkname ?? ''))
        if (body.length > 0) {
            chunks.push(body)
            const pad = (512 - (body.length % 512)) % 512
            if (pad > 0) chunks.push(Buffer.alloc(pad))
        }
    }
    chunks.push(Buffer.alloc(1024))
    return gzipSync(Buffer.concat(chunks))
}

const root = mkdtempSync(join(tmpdir(), 'tk-niubash-'))

try {
    console.log('== 1. tar.gz 解包：普通文件 + 目录 + 剥掉顶层目录 ==')
    {
        const archive = makeArchive([
            { name: 'niubash-1.5.0/', type: '5' },
            { name: 'niubash-1.5.0/niu.exe', body: 'EXE' },
            { name: 'niubash-1.5.0/winuxcmd/', type: '5' },
            { name: 'niubash-1.5.0/winuxcmd/etc/readme.txt', body: 'hello' },
        ])
        const target = join(root, 'ok')
        const files = extractTarGz(archive, target)
        ok('解出 2 个文件（目录不算）', files === 2, String(files))
        ok('剥掉顶层目录后路径正确', readFileSync(join(target, 'niu.exe'), 'utf8') === 'EXE', '')
        ok('嵌套文件也落地', readFileSync(join(target, 'winuxcmd', 'etc', 'readme.txt'), 'utf8') === 'hello')
    }

    console.log('== 1b. 硬链接（真实归档里 winuxcmd/usr/bin/*.exe 大量是硬链接）==')
    {
        const archive = makeArchive([
            { name: 'pkg/niu.exe', body: 'EXE' },
            { name: 'pkg/winuxcmd/usr/bin/gawk.exe', type: '1', linkname: 'pkg/niu.exe' },
        ])
        const target = join(root, 'hardlink')
        const files = extractTarGz(archive, target)
        const linked = join(target, 'winuxcmd', 'usr', 'bin', 'gawk.exe')
        ok('硬链接条目被解开', files === 2 && existsSync(linked), String(files))
        ok('硬链接内容与目标一致', readFileSync(linked, 'utf8') === 'EXE')
        const badLink = makeArchive([{ name: 'pkg/niu.exe', body: 'EXE' }, { name: 'pkg/x.exe', type: '1', linkname: 'pkg/../../evil' }])
        let error = null
        try { extractTarGz(badLink, join(root, 'hardlink-bad')) } catch (thrown) { error = thrown instanceof Error ? thrown.message : String(thrown) }
        ok('硬链接目标越界 ⇒ 拒绝', error !== null && /硬链接/.test(error), String(error).slice(0, 100))
    }

    console.log('== 2. 解包安全边界 ==')
    {
        const cases = [
            ['绝对路径', [{ name: '/etc/passwd', body: 'x' }], /不安全路径/],
            ['上跳 ..', [{ name: 'pkg/../../evil.txt', body: 'x' }], /不安全路径/],
            ['符号链接', [{ name: 'pkg/link', type: '2' }], /不支持的类型/],
        ]
        for (const [label, entries, pattern] of cases) {
            let error = null
            try { extractTarGz(makeArchive(entries), join(root, `bad-${label.replace(/[^\w]/g, '')}`)) }
            catch (thrown) { error = thrown instanceof Error ? thrown.message : String(thrown) }
            ok(`${label} ⇒ 拒绝`, error !== null && pattern.test(error), String(error).slice(0, 120))
        }
        ok('越界内容没有被写到目标目录之外', !existsSync(join(root, 'evil.txt')) && !existsSync(join(tmpdir(), 'evil.txt')), '')
    }

    console.log('== 3. installNiubash：哈希不符 ⇒ 丢弃、不安装 ==')
    {
        const env = { ...process.env, LOCALAPPDATA: join(root, 'appdata') }
        const archive = makeArchive([{ name: 'pkg/niu.exe', body: 'EXE' }])
        let downloadedTo = null
        const fakeDownload = async ({ to }) => { downloadedTo = to; writeFileSync(to, archive) }
        let error = null
        try { await installNiubash({ env, download: fakeDownload, sha256: 'deadbeef'.repeat(8) }) }
        catch (thrown) { error = thrown instanceof Error ? thrown.message : String(thrown) }
        ok('哈希不符 ⇒ 报错', error !== null && /归档校验失败/.test(error), String(error).slice(0, 120))
        ok('坏归档被删掉（不占地方）', downloadedTo === null || !existsSync(downloadedTo), String(downloadedTo))
        ok('没有留下安装目录', !existsSync(niubashRoot(env)), niubashRoot(env))

        const good = await installNiubash({
            env,
            download: fakeDownload,
            sha256: createHash('sha256').update(archive).digest('hex'),
        })
        ok('哈希正确 ⇒ 装好并返回 niu.exe', good !== null && /niu\.exe$/i.test(good.file), JSON.stringify(good?.file))
        ok('装到用户级目录', good !== null && good.file.startsWith(niubashRoot(env)), niubashRoot(env))
    }

    console.log('== 4. 标记缓存：exe 没变就不重复哈希 ==')
    {
        const env = { ...process.env, LOCALAPPDATA: join(root, 'appdata') }
        const found = findNiubash({ env })
        ok('findNiubash 找到已装的', found !== null && existsSync(found.file))
        const marker = JSON.parse(readFileSync(join(found.dir, '.dsh-toolkit-niubash.json'), 'utf8'))
        ok('标记里记了 sha256 与 size', typeof marker.sha256 === 'string' && marker.size > 0, JSON.stringify(marker).slice(0, 120))
        ok('exe 的 mtime 与标记一致（下次直接信标记）', marker.mtimeMs === statSync(found.file).mtimeMs)
        writeFileSync(found.file, 'TAMPERED') // 改了内容但 mtime 会变 ⇒ 标记失效 ⇒ 重算
        const again = findNiubash({ env })
        ok('内容被改 ⇒ 重算哈希并刷新标记', again?.sha256 !== marker.sha256, JSON.stringify({ before: marker.sha256.slice(0, 8), after: String(again?.sha256).slice(0, 8) }))
    }

    console.log('== 5. ops-runtime：我们自己的运行时优先于 dsh-ops ==')
    {
        const env = { ...process.env, LOCALAPPDATA: join(root, 'appdata') }
        const resolved = await resolveOpsConfinedBash({ env, platform: 'win32', opsRoot: join(root, 'no-ops-here') })
        ok('dsh-ops 不存在也能解析出运行时', resolved !== null && resolved.backend === 'niubash', JSON.stringify(resolved?.backend))
        ok('来源标记为 dsh-toolkit（不是 dsh-ops）', resolved?.source === 'dsh-toolkit', String(resolved?.source))
    }
}
finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

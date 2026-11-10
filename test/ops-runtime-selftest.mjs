/**
 * ops-runtime 自测：受限运行时的后端选择（Niubash 优先 → MSYS 兜底 → 都没有就 null）。
 *
 * 为什么值得单测：这两条后端是**运行时才能验证**的（0.5.x 换成 Niubash，0.4.x 是钉住 MSYS），
 * 选错了只在受限模式（workspace-write / read-only）才炸，平时 danger-full-access 完全看不出来。
 * 这里用假 dsh-ops 包把三条分支都钉住，不依赖机器上真的装了哪个版本。
 *
 * 跑法：node test/ops-runtime-selftest.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { resolveOpsConfinedBash } = await import('../lib/shell/ops-runtime.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 240)}`}`)
}

const root = mkdtempSync(join(tmpdir(), 'tk-ops-runtime-'))

/** 造一个"假 dsh-ops 包"：按需生成 lib/niubash/runtime.js 与 lib/bash-ipc.js 及可执行占位文件。 */
function fakeOps(name, { niubash = false, msys = false, niubashThrows = false } = {}) {
    // 真实安装布局：`<profile>/node_modules/dsh-ops` 与同级的 `@dsh-ops/bash-win32-x64`
    const base = join(root, name)
    const dir = join(base, 'dsh-ops')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-ops', version: '0.5.2' }))
    if (niubash) {
        const exe = join(dir, 'niu.exe')
        writeFileSync(exe, 'stub')
        mkdirSync(join(dir, 'lib', 'niubash'), { recursive: true })
        writeFileSync(join(dir, 'lib', 'niubash', 'runtime.js'), `
export function niubashCandidates() { return [{ file: ${JSON.stringify(exe)}, source: 'bundled' }] }
export function verifiedNiubash(file) {
${niubashThrows ? "  throw new Error('EXECUTOR_UNAVAILABLE: Niubash payload verification failed')" : ''}
  return { file, env: { NIU_ROOT: ${JSON.stringify(join(dir, 'winuxcmd'))} } }
}
`)
    }
    if (msys) {
        const payload = join(base, '@dsh-ops', 'bash-win32-x64', 'usr', 'bin')
        mkdirSync(payload, { recursive: true })
        const bash = join(payload, 'bash.exe')
        writeFileSync(bash, 'stub')
        writeFileSync(join(dir, 'lib', 'bash-ipc.js'), `
export function confinedBash(file) { return { file, env: { PATH: 'msys-path' } } }
`)
    }
    return dir
}

try {
    console.log('== 1. 0.5.x：有 Niubash 就用 Niubash（优先于 MSYS）==')
    {
        const dir = fakeOps('both', { niubash: true, msys: true })
        const runtime = await resolveOpsConfinedBash({ opsRoot: dir, platform: 'win32' })
        ok('backend=niubash', runtime?.backend === 'niubash', JSON.stringify(runtime))
        ok('返回 niu.exe 与 NIU_ROOT 环境', /niu\.exe$/i.test(runtime?.file ?? '') && runtime?.env?.NIU_ROOT !== undefined, JSON.stringify(runtime?.env))
    }

    console.log('== 2. Niubash 校验失败 ⇒ 退回 MSYS ==')
    {
        const dir = fakeOps('fallback', { niubash: true, msys: true, niubashThrows: true })
        const runtime = await resolveOpsConfinedBash({ opsRoot: dir, platform: 'win32' })
        ok('backend=msys', runtime?.backend === 'msys', JSON.stringify(runtime))
        ok('返回钉住 MSYS 的 bash.exe', /bash\.exe$/i.test(runtime?.file ?? ''), JSON.stringify(runtime?.file))
    }

    console.log('== 3. 只有 MSYS（0.4.x 安装）==')
    {
        const dir = fakeOps('msys-only', { msys: true })
        const runtime = await resolveOpsConfinedBash({ opsRoot: dir, platform: 'win32' })
        ok('backend=msys', runtime?.backend === 'msys')
    }

    console.log('== 4. 两者都没有 ⇒ null（调用方据此 fail-closed）==')
    {
        const dir = fakeOps('empty', {})
        const runtime = await resolveOpsConfinedBash({ opsRoot: dir, platform: 'win32' })
        ok('返回 null 而不是抛错', runtime === null, JSON.stringify(runtime))
    }

    console.log('== 5. 平台与坏路径 ==')
    {
        const dir = fakeOps('platform', { niubash: true })
        ok('非 win32 直接 null（POSIX 用宿主 bash）', (await resolveOpsConfinedBash({ opsRoot: dir, platform: 'linux' })) === null)
        ok('opsRoot 不存在 ⇒ null', (await resolveOpsConfinedBash({ opsRoot: join(root, 'nope'), platform: 'win32' })) === null)
    }
}
finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

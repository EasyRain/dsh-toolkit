/**
 * bash 自测 —— 覆盖 ② 线移交包里那 12 项验收，外加"工具定义形状"三项。
 *
 * 这些断言都是**实测踩出来的**，不要为了跑快删：
 *  - `-c` 而非 `-lc`（coreutils 在非登录 shell 的 PATH 上）
 *  - 超时必须杀整棵进程树（否则 `sleep` 孙进程会把 promise 拖住）
 *  - 继承的 `PWD` 会让 `pwd` 说谎
 *  - 强制 UTF-8 locale（否则中文乱码）
 *
 * 跑法：node test/bash-selftest.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { findBash, runBash, renderResult, tools, DEFAULTS } = await import('../lib/shell/bash.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 240)}`}`)
}

const bash = findBash()
console.log(`bash = ${bash}`)
if (bash === null) {
    console.log('\nSKIP：本机没有 Git Bash（这些用例在装 Git for Windows 的机器上必须全过）')
    process.exit(0)
}

console.log('== 1. 基本执行 ==')
{
    const r = await runBash('echo hello')
    ok('basic echo', r.exitCode === 0 && r.stdout.trim() === 'hello', JSON.stringify(r))
    ok('ok 与 durationMs 有值', r.ok === true && r.durationMs >= 0 && r.bashPath === bash)
}

console.log('== 2. UTF-8 与 locale ==')
{
    const r = await runBash('printf "第三行\\n第一行\\n第二行\\n" | sort')
    ok('utf8 pipeline（sort 认中文）', r.exitCode === 0 && r.stdout.startsWith('第一行'), JSON.stringify(r.stdout))
    const v = await runBash('x=你好; echo "变量=$x"')
    ok('变量展开 + 中文', v.stdout.includes('变量=你好'), JSON.stringify(v.stdout))
}

console.log('== 3. 引号与 argv 直传（不经 Windows 命令行二次解析）==')
{
    const r = await runBash('echo "a\'b" \'c"d\'')
    ok('引号混用', r.stdout.trim() === 'a\'b c"d', JSON.stringify(r.stdout))
}

console.log('== 4. stdout / stderr 分开 + 退出码 ==')
{
    const r = await runBash('echo out1; echo err1 >&2; exit 7')
    ok('退出码 7 透传', r.exitCode === 7, String(r.exitCode))
    ok('stdout 与 stderr 分开', r.stdout.trim() === 'out1' && r.stderr.trim() === 'err1', JSON.stringify({ out: r.stdout, err: r.stderr }))
    ok('非 0 退出 ⇒ ok=false', r.ok === false)
}

console.log('== 5. coreutils 在非登录 shell 的 PATH 上（所以用 -c 不用 -lc）==')
{
    const r = await runBash('command -v ls sort tr sed awk head tail wc | wc -l')
    ok('8 个 coreutils 全部可解析', r.stdout.trim() === '8', JSON.stringify(r.stdout))
}

console.log('== 6. 继承的 PWD 必须被清掉 ==')
{
    const dir = mkdtempSync(join(tmpdir(), 'tk-bash-'))
    try {
        const r = await runBash('pwd', { cwd: dir })
        const posix = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`)
        ok('pwd 输出的是传入的 cwd（不是父进程的）', r.stdout.trim() === posix || r.stdout.trim().endsWith(dir.split('\\').pop()), `${JSON.stringify(r.stdout)} vs ${posix}`)
    }
    finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

console.log('== 7. 带空格的路径 ==')
if (process.platform === 'win32') {
    const r = await runBash('ls "C:/Program Files/Git"/*.exe | head -1')
    ok('MSYS 路径 + 空格', r.exitCode === 0 && r.stdout.includes('git-bash.exe'), JSON.stringify(r.stdout))
}
else {
    const dir = mkdtempSync(join(tmpdir(), 'tk bash space-'))
    try {
        // 目录名里带空格：验证 cwd 原样传给 bash（不经过二次切词）。
        const r = await runBash('basename "$PWD"', { cwd: dir })
        const base = dir.split(/[\\/]/).filter(Boolean).pop()
        ok('POSIX 路径 + 空格', r.exitCode === 0 && r.stdout.trim() === base, JSON.stringify({ out: r.stdout, base }))
    }
    finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

console.log('== 8. 输出上限 ==')
{
    const r = await runBash('yes x | head -200000', { maxOutputBytes: 4096 })
    ok('超限置 truncated=true', r.truncated === true, JSON.stringify({ len: r.stdout.length, truncated: r.truncated }))
    ok('截断后仍不崩（退出码可读）', typeof r.exitCode === 'number' || r.timedOut === true)
}

/** 当前在跑的 sleep 进程数（Windows 用 tasklist，POSIX 用 pgrep）。 */
function countSleep() {
    if (process.platform === 'win32') {
        const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq sleep.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
        const text = String(r.stdout ?? '')
        if (/no tasks|没有运行的任务/i.test(text)) return 0
        return text.split('\n').filter((line) => line.toLowerCase().includes('sleep.exe')).length
    }
    const r = spawnSync('pgrep', ['-x', 'sleep'], { encoding: 'utf8' })
    if (r.status !== 0) return 0
    return String(r.stdout ?? '').trim().split('\n').filter(Boolean).length
}

console.log('== 9. 超时杀整棵进程树（含 fork 出来的孙进程）==')
{
    // ② 线的验收条件：`sleep 45` + 2000 ms ⇒ 4 s 内返回，且**不留** sleep 进程。
    // 复合命令必须测：单条 `sleep 45` 会被 bash exec 成同一个进程（taskkill 够用），
    // 但 `sleep 45; echo done` 会 fork 出孙进程，其 Windows PPID 指向已退出的 fork 辅助进程 ⇒
    // taskkill /T 抓不到 ⇒ 只能靠 MSYS 进程组（kill -9 -pgid）。这是踩过的真回归。
    const before = countSleep()
    const t0 = Date.now()
    const r = await runBash('sleep 45; echo done', { timeoutMs: 2000 })
    const elapsed = Date.now() - t0
    ok('复合命令超时：timedOut=true 且 4 s 内返回（只等 close 会被 pipe 拖到 4.2 s+）', r.timedOut === true && elapsed < 4000, `elapsed=${elapsed}ms timedOut=${r.timedOut}`)
    ok('超时结果 ok=false', r.ok === false)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = countSleep()
    ok('超时后没有残留 sleep 进程（fork 出来的也要杀掉）', after <= before, `before=${before} after=${after}`)
}

console.log('== 9b. 管道/后台任务同样不残留 ==')
{
    const before = countSleep()
    const r = await runBash('sleep 40 & sleep 41 & sleep 42', { timeoutMs: 1500 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = countSleep()
    ok('后台任务超时后无残留', r.timedOut === true && after <= before, `after=${after} before=${before}`)
}

console.log('== 10. 错误输入 ==')
{
    const empty = await runBash('   ')
    ok('空命令被拒', empty.ok === false && /non-empty/.test(empty.error ?? ''), JSON.stringify(empty.error))
    const missing = await runBash('definitely_not_a_command_xyz')
    ok('不存在的命令 ⇒ 非 0 退出 + stderr', missing.exitCode !== 0 && missing.stderr.length > 0, JSON.stringify({ code: missing.exitCode, err: missing.stderr }))
}

console.log('== 11. 工具定义形状（宿主注册契约）==')
{
    const seen = []
    const fake = (def) => { seen.push(def); return def }
    const list = tools(fake, { resolveWorkspaceCwd: () => 'D:/DshWorkSpace/Addons' })
    ok('只注册 1 个工具', list.length === 1, String(list.length))
    const def = seen[0] ?? {}
    ok('名字是 bash', def.name === 'bash')
    ok('参数是字段映射方言（command 必填）', def.parameters?.command?.required === true && typeof def.parameters?.command?.type === 'string')
    ok('参数面 = command / cwd / timeoutMs', Object.keys(def.parameters ?? {}).sort().join(',') === 'command,cwd,timeoutMs', Object.keys(def.parameters ?? {}).join(','))
    ok('有 output.schema 与 render', def.output?.schema !== undefined && typeof def.output?.render === 'function')
    ok('描述里写清了非交互与超时', /Non-interactive/.test(def.description) && /timeout/i.test(def.description))
}

console.log('== 12. 文本投影 ==')
{
    const text = renderResult({ ok: true, exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false, truncated: false, durationMs: 81, bashPath: bash })
    ok('投影含头部与 stdout 原文', /ok=true/.test(text) && /exitCode=0/.test(text) && /--- stdout ---\nhi/.test(text))
    const bad = renderResult({ ok: false, exitCode: 127, stdout: '', stderr: 'nope\n', timedOut: false, truncated: true, durationMs: 3, bashPath: bash })
    ok('空 stdout 标 (empty)，stderr 原样', /\(empty\)/.test(bad) && /nope/.test(bad) && /truncated/.test(bad))
    ok('默认上限是 2 MB', DEFAULTS.maxOutputBytes === 2 * 1024 * 1024)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

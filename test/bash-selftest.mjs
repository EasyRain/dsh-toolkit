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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const bashModule = await import('../lib/shell/bash.js')
const { createLocalSubprocess } = await import('./support/local-subprocess.mjs')
const localSubprocess = createLocalSubprocess()
const { findBash, renderResult, apply, DEFAULTS } = bashModule
// 生产走宿主 subprocess；自测用同契约的本地替身（spawn/终止/输出/spill 行为一致）。
// 自测里 bash 指向**系统 Git Bash**（`DSH_TOOLKIT_BASH` 是显式调试覆盖；生产只认自装的 Niubash）。
const TEST_BASH = findBash()
const runBash = (command, options = {}) => bashModule.runBash(command, {
    subprocess: localSubprocess,
    ...(TEST_BASH === null ? {} : { bashPath: TEST_BASH }),
    ...options,
})
const tools = (define, options = {}) => bashModule.tools(define, {
    subprocess: localSubprocess,
    ...(TEST_BASH === null ? {} : { bashPath: TEST_BASH }),
    ...options,
})

let failures = 0

/** Windows 上后台任务可能还占着临时目录（cwd），删不掉不该让自测崩掉。 */
const bestEffortRm = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 留给系统清理 */ } }
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
    ok('参数是字段映射方言（command 与 script_path 二选一，均非必填）', typeof def.parameters?.command?.type === 'string' && def.parameters?.command?.required !== true && typeof def.parameters?.script_path?.type === 'string')
    ok('参数面 = ops 那套 + background', Object.keys(def.parameters ?? {}).sort().join(',') === 'background,command,cwd,description,graceMs,includeDiagnostics,justification,run_in_background,sandbox_permissions,script_path,timeoutMs,workdir', Object.keys(def.parameters ?? {}).join(','))
    ok('有 output.schema 与 render', def.output?.schema !== undefined && typeof def.output?.render === 'function')
    ok('描述里写清了超时/晋升与沙箱边界', /promoted|spooled/.test(def.description) && /sandboxed mode|confined/.test(def.description))
}

console.log('== 12. 文本投影 ==')
{
    const text = renderResult({ ok: true, exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false, truncated: false, durationMs: 81, bashPath: bash })
    ok('投影含头部与 stdout 原文', /ok=true/.test(text) && /exitCode=0/.test(text) && /--- stdout ---\nhi/.test(text))
    const bad = renderResult({ ok: false, exitCode: 127, stdout: '', stderr: 'nope\n', timedOut: false, truncated: true, durationMs: 3, bashPath: bash })
    ok('空 stdout 不再占一行（无内容就不出现），stderr 原样', !/--- stdout ---/.test(bad) && /--- stderr ---/.test(bad) && /nope/.test(bad) && /truncated/.test(bad))
    ok('默认上限是 2 MB', DEFAULTS.maxOutputBytes === 2 * 1024 * 1024)
}

console.log('== 13. 隐藏宿主 pwsh（Windows，省常驻 schema）==')
{
    const { mountHostShellHiding, HOST_SHELL_NAMES } = await import('../lib/shell/host-shell.js')
    ok('只隐藏 pwsh / pwsh_persistent 两个名字', HOST_SHELL_NAMES.join(',') === 'pwsh,pwsh_persistent', HOST_SHELL_NAMES.join(','))

    const posix = mountHostShellHiding({ inject: () => { throw new Error('不该走到这里') } }, () => {}, 'linux')
    ok('POSIX 不隐藏任何东西', posix.mounted === false && posix.reason === 'posix')

    const calls = []
    const disposed = []
    const handlers = {}
    let cleanup = null
    const toolsFor = (agent) => ({
        get: (name) => (HOST_SHELL_NAMES.includes(name) ? { name } : undefined),
        restrict: (options) => { calls.push({ agent, options }); return () => disposed.push(agent) },
    })
    const makeAgent = (name) => ({ name, ctx: { get: (service) => (service === 'tools' ? toolsFor(name) : undefined) } })
    const first = makeAgent('a1')
    const scope = {
        get: (service) => (service === 'agents' ? { list: () => [first] } : (service === 'tools' ? toolsFor('root') : undefined)),
        on: (event, handler) => { handlers[event] = handler },
        effect: (fn) => { cleanup = fn() },
    }
    const ctx = { inject: (deps, callback) => { ok('注入的是 tools', Array.isArray(deps) && deps.includes('tools')); callback(scope) } }
    const logs = []
    const mounted = mountHostShellHiding(ctx, (line) => logs.push(line), 'win32')
    ok('挂载成功', mounted.mounted === true, JSON.stringify(mounted))
    ok('已有会话立刻被隐藏（deny 两个名字）', calls.length === 1 && calls[0].agent === 'a1' && calls[0].options.deny.join(',') === 'pwsh,pwsh_persistent', JSON.stringify(calls))

    const second = makeAgent('a2')
    handlers['agent/created']?.({ agent: second })
    ok('新会话创建时也隐藏', calls.length === 2 && calls[1].agent === 'a2', JSON.stringify(calls.map((call) => call.agent)))
    // ops 的写法是直接 `agent.ctx.tools`（没有 get('tools')），两条路都要能走
    const direct = { name: 'a3', ctx: { tools: toolsFor('a3') } }
    handlers['agent/created']?.({ agent: direct })
    ok('agent.ctx.tools 直接可见时也能隐藏', calls.length === 3 && calls[2].agent === 'a3', JSON.stringify(calls.map((call) => call.agent)))
    // 受限会话（workspace-write）**也隐藏 pwsh**：我们用自装 Niubash，沙箱里能跑，不需要留兜底
    const restricted = { name: 'a4', session: {}, ctx: { get: (service) => (service === 'tools' ? toolsFor('a4') : (service === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined)) } }
    handlers['agent/created']?.({ agent: restricted })
    ok('受限会话也隐藏 pwsh（Niubash 能在沙箱里跑）', calls.some((call) => call.agent === 'a4'), JSON.stringify(calls.map((call) => call.agent)))
    // restrict() 永久失败（例如 unknown global tool）只记一次，不反复重试
    const before = logs.length
    const broken = { name: 'a5', session: {}, ctx: { get: (service) => (service === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : (service === 'tools' ? { get: () => ({}), restrict: () => { throw new Error('unknown global tool "pwsh"') } } : undefined)) } }
    handlers['agent/created']?.({ agent: broken })
    handlers['agent/created']?.({ agent: broken })
    ok('restrict 永久失败只记一次日志', logs.slice(before).filter((line) => /hiding failed/.test(line)).length === 1, logs.slice(before).join(' | '))
    handlers['agent/disposed']?.({ agent: second })
    ok('会话销毁时还原', disposed.includes('a2'), disposed.join(','))
    cleanup?.()
    ok('插件卸载时把剩下的都还原', disposed.includes('a1'), disposed.join(','))
    ok('日志里有动作记录', logs.some((line) => /hidden/.test(line)), logs.join(' | '))
}

console.log('== 14. 与 ops 对齐的新参数（script_path / workdir / graceMs / spill / diagnostics）==')
{
    ok('graceMs 默认 250', DEFAULTS.graceMs === 250)
    const dir2 = mkdtempSync(join(tmpdir(), 'tk bash ops-'))
    try {
        const script = join(dir2, 'my script.sh')
        writeFileSync(script, 'echo from-script "$@"\n', 'utf8')
        const viaScript = await runBash('', { scriptPath: script })
        ok('script_path 能跑带空格的脚本', viaScript.ok === true && /from-script/.test(viaScript.stdout), JSON.stringify(viaScript).slice(0, 160))
        const conflict = await runBash('echo x', { scriptPath: script })
        ok('script_path 与 command 同时给 ⇒ 拒绝', conflict.ok === false && /二选一/.test(conflict.error ?? ''), conflict.error)
        const missing = await runBash('', { scriptPath: join(dir2, 'nope.sh') })
        ok('脚本不存在 ⇒ 明确报错', missing.ok === false && /不存在/.test(missing.error ?? ''))

        const base = dir2.split(/[\\/]/).filter(Boolean).pop()
        const viaWorkdir = await runBash('basename "$PWD"', { workdir: dir2 })
        ok('workdir 是 cwd 的别名', viaWorkdir.ok === true && viaWorkdir.stdout.trim() === base, JSON.stringify({ out: viaWorkdir.stdout, base }))
        const cwdWins = await runBash('basename "$PWD"', { cwd: dir2, workdir: tmpdir() })
        ok('cwd 与 workdir 都给时 cwd 优先', cwdWins.stdout.trim() === base)

        const big = await runBash('seq 1 20000', { maxOutputBytes: 1024 })
        ok('超上限 ⇒ truncated 且给出 spillPath', big.truncated === true && typeof big.spillPath === 'string', JSON.stringify(big).slice(0, 160))
        if (typeof big.spillPath === 'string') {
            const spilled = readFileSync(big.spillPath, 'utf8')
            ok('spill 文件里有完整输出的尾巴（20000）', spilled.includes('20000') && spilled.length > 1024, String(spilled.length))
            ok('渲染里明示落盘路径', renderResult(big).includes(big.spillPath))
            rmSync(big.spillPath, { force: true })
        }

        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dir2 })[0]
        const plain = await def.execute({ command: 'echo hi' })
        ok('默认不打印 diagnostics', !/diagnostics:/.test(plain) && /hi/.test(plain))
        const verbose = await def.execute({ command: 'echo hi', includeDiagnostics: true })
        ok('includeDiagnostics 时打印 bash/cwd/timeout/grace', /diagnostics: bash=/.test(verbose) && /cwd=/.test(verbose) && /graceMs=250/.test(verbose), verbose.slice(-140))
    }
    finally {
        bestEffortRm(dir2)
    }
}

console.log('== 14e. 前台默认 10 秒转后台（长命令可在「后台任务」里单独停止）==')
{
    const dirP = mkdtempSync(join(tmpdir(), 'tk bash promote-after-'))
    try {
        let captured = null
        const jobs = { start(options) { captured = options; return 'job-auto' } }
        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dirP, getJobs: () => jobs })[0]
        // 不传 timeoutMs：用默认阈值（这里把阈值临时调小，免得测试等 20 秒）
        const previous = process.env.DSH_TOOLKIT_PROMOTE_AFTER_MS
        process.env.DSH_TOOLKIT_PROMOTE_AFTER_MS = '300'
        let text
        try {
            text = await def.execute({ command: 'sleep 5; echo late', description: 'auto promote' }, { agent: { id: 'a1', session: { id: 's1' } } })
        }
        finally {
            if (previous === undefined) delete process.env.DSH_TOOLKIT_PROMOTE_AFTER_MS
            else process.env.DSH_TOOLKIT_PROMOTE_AFTER_MS = previous
        }
        ok('默认超时 ⇒ 转后台并给 jobId', /kind=promoted/.test(text) && /jobId=job-auto/.test(text), text.slice(0, 160))
        ok('晋升 job 带 owner（UI 才能单独停止）', captured?.owner !== undefined, JSON.stringify(captured?.owner))
        const run = captured.run()
        run.cancel('stop')
        await run.done
    }
    finally { rmSync(dirP, { recursive: true, force: true }) }
}

console.log('== 14f. 前台命令不创建 job（避免控制器拒绝与逐条通知）==')
{
    const dirF = mkdtempSync(join(tmpdir(), 'tk bash fg-owner-'))
    try {
        let captured = null
        const fakeJobs = { start(options) { captured = options; return 'job-fg' }, remove() { /* 移除 */ } }
        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dirF, getJobs: () => fakeJobs })[0]
        const text = await def.execute({ command: 'echo fg-hi', description: 'fg' }, { agent: { id: 'agent-1', session: { id: 's-1' } } })
        ok('前台命令正常执行', /exit code: 0/.test(text), text.slice(0, 120))
        ok('前台命令**完全不创建 job**（无主会被控制器拒绝，有主会被逐条注入通知）', captured === null, JSON.stringify(captured))
    }
    finally { rmSync(dirF, { recursive: true, force: true }) }
}

console.log('== 15. 后台任务（接宿主 jobs 服务）==')
{
    const dir4 = mkdtempSync(join(tmpdir(), 'tk bash bg-'))
    try {
        let captured = null
        const fakeJobs = { start(options) { captured = options; return 'job-7' } }
        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dir4, getJobs: () => fakeJobs })[0]
        const text = await def.execute({ command: 'echo bg-hi', background: true, description: 'say hi' }, { agent: { id: 'agent-1' } })
        ok('background 返回 jobId 与用法', /kind=background/.test(text) && /jobId=job-7/.test(text) && /job_output/.test(text), text)
        ok('jobs.start 收到 kind/label/owner/output', captured?.kind === 'bash' && captured?.label === 'say hi' && captured?.owner === 'agent-1' && captured?.output?.length === 2 && captured.output[0].channel === 'stdout', JSON.stringify({ kind: captured?.kind, label: captured?.label, owner: captured?.owner }))
        const run = captured.run()
        const done = await run.done
        ok('后台任务结束 ⇒ completed', done.status === 'completed', JSON.stringify(done))
        ok('输出经 reader 可读', captured.output[0].read(0).text.includes('bg-hi'), captured.output[0].read(0).text)
        ok('reader 的 nextOffset 跟上', captured.output[0].read(0).nextOffset > 0)

        let captured2 = null
        const jobs2 = { start(options) { captured2 = options; return 'job-8' } }
        const def2 = tools((tool) => tool, { resolveWorkspaceCwd: () => dir4, getJobs: () => jobs2 })[0]
        const text2 = await def2.execute({ command: 'sleep 3', background: true }, {})
        ok('第二个任务也返回 jobId', /job-8/.test(text2))
        const run2 = captured2.run()
        run2.cancel('stop it')
        const done2 = await run2.done
        ok('cancel 后 done 报 killed', done2.status === 'killed', JSON.stringify(done2))

        const def3 = tools((tool) => tool, { resolveWorkspaceCwd: () => dir4 })[0]
        const aliasText = await def2.execute({ command: 'sleep 3', run_in_background: true }, {})
        ok('run_in_background 别名等价于 background', /kind=background/.test(aliasText) && /jobId=/.test(aliasText), aliasText.slice(0, 90))
        const noJobs = await def3.execute({ command: 'echo x', background: true })
        ok('没有 jobs 服务 ⇒ 明确报错而不是静默', /jobs 服务/.test(noJobs) && /ok=false/.test(noJobs), noJobs)
    }
    finally {
        bestEffortRm(dir4)
    }
}

console.log('== 16. 沙箱闸门（非完全权限必须真受限，否则拒绝执行）==')
{
    const bashPath = findBash()
    const dir5 = mkdtempSync(join(tmpdir(), 'tk bash sandbox-'))
    try {
        const makeCtx = (mode, sandbox) => ({ get: (name) => (name === 'sandboxPolicy' ? { resolve: () => ({ mode }) } : (name === 'sandbox' ? sandbox : undefined)) })
        // 默认按 POSIX 语义测 confine 路径；Windows 的“系统 Git Bash 起不来”单独测。
        const define = (ctx, sandboxPlatform = 'linux') => tools((tool) => tool, { resolveWorkspaceCwd: () => dir5, getCtx: () => ctx, sandboxPlatform })[0]

        const dangerCalls = []
        const danger = define(makeCtx('danger-full-access', { confine: async (argv) => { dangerCalls.push(argv); return { argv, enforcement: 'full' } } }))
        const dangerOut = await danger.execute({ command: 'echo free-ok' }, { agent: { session: {} } })
        ok('danger-full-access 不调用 confine', dangerCalls.length === 0 && /free-ok/.test(dangerOut), dangerOut.slice(0, 120))

        const confined = define(makeCtx('workspace-write', {
            confine: async () => ({ argv: [bashPath, '-c', 'echo confined-ok'], enforcement: 'full', denialSignatures: ['blocked by sandbox'] }),
        }))
        const confinedOut = await confined.execute({ command: 'echo original-should-not-run' }, { agent: { session: {} } })
        ok('受限模式用 confinement 的 argv 执行', /confined-ok/.test(confinedOut) && !/original-should-not-run/.test(confinedOut), confinedOut.slice(0, 160))
        ok('沙箱正常执行时**不再**回显模式/强度', !/\[sandbox:/.test(confinedOut), confinedOut.slice(0, 160))

        const denied = define(makeCtx('workspace-write', {
            confine: async () => ({ argv: [bashPath, '-c', 'echo "blocked by sandbox" >&2; exit 1'], enforcement: 'partial', denialSignatures: ['blocked by sandbox'] }),
        }))
        const deniedOut = await denied.execute({ command: 'touch nope' }, { agent: { session: {} } })
        ok('沙箱拒绝 ⇒ 明确标 denied', /\[sandbox: file access denied under workspace-write mode\]/.test(deniedOut), deniedOut.slice(0, 200))

        const closed = define(makeCtx('workspace-write', {}))
        const closedOut = await closed.execute({ command: 'touch touched.txt' }, { agent: { session: {} } })
        ok('拿不到 confinement ⇒ 拒绝执行', /ok=false/.test(closedOut) && /SANDBOX_UNAVAILABLE/.test(closedOut), closedOut.slice(0, 200))
        ok('拒绝时命令确实没跑（没有副作用）', !existsSync(join(dir5, 'touched.txt')))
        ok('回执标出 unavailable', /\[sandbox: unavailable/.test(closedOut), closedOut.slice(0, 200))

        // 连 sandboxPolicy 服务都拿不到（宿主上下文里）⇒ 同样拒绝，不能退化成"直接放行"
        const noPolicy = define({ get: () => undefined })
        const noPolicyOut = await noPolicy.execute({ command: 'echo should-not-run' }, { agent: { session: {} } })
        ok('拿不到 sandboxPolicy ⇒ 拒绝执行', /ok=false/.test(noPolicyOut) && /SANDBOX_UNAVAILABLE/.test(noPolicyOut) && !/should-not-run/.test(noPolicyOut), noPolicyOut.slice(0, 200))

        // Windows 但拿不到可用的运行时 ⇒ 提前拒绝，并指向设置页（不提"受限模式"这种死说法）
        const winRestricted = define(makeCtx('workspace-write', { confine: async (argv) => ({ argv, enforcement: 'full' }) }), 'win32')
        const winOut = await winRestricted.execute({ command: 'touch win32-touched.txt' }, { agent: { session: {} } })
        ok('Windows 运行时不可用 ⇒ 拒绝执行并指向设置页', /ok=false/.test(winOut) && /EXECUTOR_UNAVAILABLE/.test(winOut) && /设置/.test(winOut), winOut.slice(0, 240))
        ok('Windows 拒绝时命令确实没跑', !existsSync(join(dir5, 'win32-touched.txt')))
    }
    finally {
        bestEffortRm(dir5)
    }
}

console.log('== 17. 平台注册面（POSIX 让位给宿主 bash）==')
{
    const registered = []
    const fake = { tools: { register: (tool) => registered.push(tool) }, get: () => undefined }
    const { platformSupportsShell } = await import('../lib/configure.js')
    ok('shell 族只支持 Windows', platformSupportsShell('linux') === false && platformSupportsShell('darwin') === false && platformSupportsShell('win32') === true)
    const posixCount = apply(fake, (tool) => tool, { platform: 'linux' })
    ok('POSIX 不注册（宿主已有 bash）', posixCount === 0 && registered.length === 0, String(posixCount))
    const winNoRuntime = apply(fake, (tool) => tool, { platform: 'win32', bashPath: '' })
    ok('Windows 但没有运行时 ⇒ 不注册（族视为关闭）', winNoRuntime === 0 && registered.length === 0, String(winNoRuntime))
    const winCount = apply(fake, (tool) => tool, { platform: 'win32', bashPath: TEST_BASH })
    ok('Windows + 运行时 ⇒ 注册 1 个 bash', winCount === 1 && registered.length === 1 && registered[0].name === 'bash', String(winCount))
    ok('POSIX/Windows 都只注册同名工具（宿主 UI 显示「运行命令」）', registered[0]?.name === 'bash')
}

console.log('== 18. 环境净化（照 ops：无颜色、无分页器、英文消息）==')
{
    const r = await runBash('printf "%s|%s|%s|%s" "$NO_COLOR" "$TERM" "$PAGER" "$LC_MESSAGES"')
    ok('NO_COLOR/TERM/PAGER/LC_MESSAGES 固定', r.stdout === '1|dumb|cat|C', JSON.stringify(r.stdout))
    ok('UTF-8 locale 保留（中文按字符不按字节）', (await runBash('printf %s "中文" | wc -m')).stdout.trim() === '2')
}

console.log('== 19. 中途晋升为后台（ops 的 promoted 语义）==')
{
    const dir6 = mkdtempSync(join(tmpdir(), 'tk bash promote-'))
    try {
        const direct = await runBash('echo before; sleep 5', { timeoutMs: 400, promoteOnTimeout: true })
        ok('到点不杀，返回 promoted + live', direct.promoted === true && typeof direct.live?.done?.then === 'function', JSON.stringify(Object.keys(direct)))
        ok('partial 里保留晋升前的输出', String(direct.partial?.stdout ?? '').includes('before'), JSON.stringify(direct.partial?.stdout))
        direct.live.kill()
        const settled = await direct.live.done
        ok('晋升后进程仍可结束/收尸', settled.status === 'failed' || settled.exitCode === null, JSON.stringify(settled))

        let captured = null
        const jobs = { start(options) { captured = options; return 'job-9' } }
        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dir6, getJobs: () => jobs })[0]
        const text = await def.execute({ command: 'sleep 5; echo late', timeoutMs: 300, description: 'long one' }, { agent: { id: 'a1' } })
        ok('工具层返回 kind=promoted + jobId', /kind=promoted/.test(text) && /jobId=job-9/.test(text) && /job_output/.test(text), text.slice(0, 200))
        ok('jobs.start 收到 kind/label/output', captured?.kind === 'bash' && captured?.label === 'long one' && captured?.output?.length === 2, JSON.stringify({ kind: captured?.kind, label: captured?.label }))
        const run = captured.run()
        run.cancel('stop')
        const done = await run.done
        ok('取消后任务结束', done.status === 'failed' || done.exitCode !== 0, JSON.stringify(done))

        let fgStarts = 0
        let removedJob = null
        const jobs2 = { start() { fgStarts += 1; return 'job-fg' }, remove(id) { removedJob = id } }
        const defFg = tools((tool) => tool, { resolveWorkspaceCwd: () => dir6, getJobs: () => jobs2 })[0]
        const fgText = await defFg.execute({ command: 'echo hi' })
        ok('前台命令不登记 job（只有晋升时才登记）', fgStarts === 0 && /ok=true/.test(fgText), JSON.stringify({ fgStarts }))
        ok('因此也没有移除动作', removedJob === null, JSON.stringify({ removedJob }))
        const def2 = tools((tool) => tool, { resolveWorkspaceCwd: () => dir6 })[0]
        const killed = await def2.execute({ command: 'sleep 5', timeoutMs: 300 })
        ok('没有 jobs 服务时仍按超时杀掉', /timedOut=true/.test(killed), killed.slice(0, 140))
    }
    finally {
        bestEffortRm(dir6)
    }
}

console.log('== 20. spill 上限 + 结构化失败 ==')
{
    const dir7 = mkdtempSync(join(tmpdir(), 'tk bash spill-'))
    try {
        const big = await runBash('seq 1 200000', { maxOutputBytes: 1024, maxSpillBytes: 2048 })
        ok('溢出时标记 truncated 并给出 spillPath', big.truncated === true && typeof big.spillPath === 'string', JSON.stringify({ truncated: big.truncated, spillPath: big.spillPath }))
        if (typeof big.spillPath === 'string') {
            const size = statSync(big.spillPath).size
            ok('spill 文件不超过上限（+头部）', size <= 2048 + 128, String(size))
            rmSync(big.spillPath, { force: true })
        }
        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dir7 })[0]
        const timed = await def.execute({ command: 'sleep 5', timeoutMs: 300 })
        ok('超时失败带 failure=TIMEOUT', /\[failure: TIMEOUT; effects: unknown; retry: after-input-change\]/.test(timed), timed.slice(-200))
        const exit1 = await def.execute({ command: 'exit 3' })
        ok('非零退出带 failure=EXIT_NONZERO', /\[failure: EXIT_NONZERO; effects: unknown; retry: never\]/.test(exit1), exit1.slice(-160))
        const ctx = { get: (name) => (name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined) }
        const closed = tools((tool) => tool, { resolveWorkspaceCwd: () => dir7, getCtx: () => ctx, sandboxPlatform: 'win32' })[0]
        const blocked = await closed.execute({ command: 'echo x' })
        ok('受限模式缺运行时带 failure=EXECUTOR_UNAVAILABLE', /\[failure: EXECUTOR_UNAVAILABLE; effects: none; retry: after-config-change\]/.test(blocked), blocked.slice(-220))
    }
    finally { bestEffortRm(dir7) }
}

console.log('== 21. 宿主取消（停止按钮）能真正打断 ==')
{
    const envOut = await runBash('printf "%s|%s" "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE"')
    ok('git 不会弹凭据交互（GIT_TERMINAL_PROMPT/GCM_INTERACTIVE）', envOut.stdout === '0|never', JSON.stringify(envOut.stdout))

    const controller = new AbortController()
    const started = Date.now()
    const pending = runBash('sleep 5; echo late', { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const cancelled = await pending
    const elapsed = Date.now() - started
    ok('bash 被宿主取消 ⇒ 快速返回 cancelled', cancelled.ok === false && /cancelled/i.test(cancelled.error ?? '') && elapsed < 3000, JSON.stringify({ elapsed, error: cancelled.error }))

    const def = tools((tool) => tool, { resolveWorkspaceCwd: () => tmpdir() })[0]
    const c2 = new AbortController()
    const pending2 = def.execute({ command: 'sleep 5' }, { signal: c2.signal })
    setTimeout(() => c2.abort(), 150)
    const text = await pending2
    const pre = new AbortController()
    pre.abort()
    const preRes = await runBash('echo x', { signal: pre.signal })
    ok('进进程前已取消 ⇒ 直接 cancelled', preRes.ok === false && /cancelled/i.test(preRes.error ?? ''))
    ok('工具层取消回执带 [aborted] 与 failure=CANCELLED', /\[aborted\]/.test(text) && /\[failure: CANCELLED;/.test(text), text.slice(-200))
}

console.log('== 22. 逐次升级审批（sandbox_permissions）==')
{
    const { approveEscalation } = await import('../lib/shell/approval.js')
    const policy = { mode: 'workspace-write', workspaceRoot: 'D:/ws' }
    const ctx = (approval, mode = () => policy.mode) => ({
        get: (name) => name === 'sandboxPolicy' ? { resolve: () => ({ ...policy, mode: mode() }) } : name === 'approval' ? approval : undefined,
    })
    const exec = { agent: { session: { id: 's' } }, callId: 'c1', signal: { throwIfAborted() {} } }
    ok('没请求就不升级', (await approveEscalation(ctx({ request: async () => 'denied' }), {}, exec)).mode === 'workspace-write')
    let seen = null
    const allowed = await approveEscalation(ctx({ request: async (asked) => { seen = asked; return 'allowed-once' } }), { sandbox_permissions: 'danger-full-access', justification: 'need full' }, exec)
    ok('批准后按目标模式执行', allowed.mode === 'danger-full-access' && seen?.reason === 'need full' && seen?.toolName === 'bash', JSON.stringify(seen))
    let failed = ''
    try { await approveEscalation(ctx({ request: async () => 'denied' }), { sandbox_permissions: 'danger-full-access', justification: 'x' }, exec) } catch (error) { failed = error.message }
    ok('拒绝 ⇒ APPROVAL_DENIED', /^APPROVAL_DENIED/.test(failed), failed)
    failed = ''
    try { await approveEscalation(ctx(undefined), { sandbox_permissions: 'danger-full-access', justification: 'x' }, exec) } catch (error) { failed = error.message }
    ok('无审批服务 ⇒ APPROVAL_UNAVAILABLE', /^APPROVAL_UNAVAILABLE/.test(failed), failed)
    failed = ''
    let modeNow = 'workspace-write'
    const shifting = { get: (name) => name === 'sandboxPolicy' ? { resolve: () => ({ ...policy, mode: modeNow }) } : name === 'approval' ? { request: async () => { modeNow = 'danger-full-access'; return 'allowed-once' } } : undefined }
    try { await approveEscalation(shifting, { sandbox_permissions: 'danger-full-access', justification: 'x' }, exec) } catch (error) { failed = error.message }
    ok('审批期间策略变化 ⇒ AUTHORITY_CHANGED', /^AUTHORITY_CHANGED/.test(failed), failed)
    failed = ''
    try { await approveEscalation(ctx({ request: async () => 'allowed-once' }), { sandbox_permissions: 'danger-full-access' }, exec) } catch (error) { failed = error.message }
    ok('更宽模式缺 justification ⇒ APPROVAL_INVALID', /^APPROVAL_INVALID/.test(failed), failed)
    const sameMode = await approveEscalation(ctx({ request: async () => { throw new Error('不该走审批') } }), { sandbox_permissions: 'workspace-write' }, exec)
    ok('同模式不需要 justification 也不走审批', sameMode.mode === 'workspace-write')
    failed = ''
    const oddMode = { get: (name) => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'some-future-mode', workspaceRoot: 'D:/ws' }) } : name === 'approval' ? { request: async () => 'allowed-once' } : undefined }
    try { await approveEscalation(oddMode, { sandbox_permissions: 'danger-full-access', justification: 'x' }, exec) } catch (error) { failed = error.message }
    ok('未知当前模式 ⇒ APPROVAL_INVALID（不静默放行）', /^APPROVAL_INVALID/.test(failed), failed)

    const dir8 = mkdtempSync(join(tmpdir(), 'tk bash escalate-'))
    try {
        let asked = null
        const live = { mode: 'workspace-write', workspaceRoot: dir8 }
        const c2 = { get: (name) => name === 'sandboxPolicy' ? { resolve: () => live } : name === 'approval' ? { request: async (a) => { asked = a; return 'allowed-once' } } : undefined }
        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dir8, getCtx: () => c2, sandboxPlatform: 'win32' })[0]
        const escalated = await def.execute({ command: 'echo escalated-ok', sandbox_permissions: 'danger-full-access', justification: 'test' }, { agent: { session: { id: 's' } }, callId: 'c1' })
        ok('升级后命令真的执行（未受限）', /ok=true/.test(escalated) && /escalated-ok/.test(escalated) && asked !== null, escalated.slice(0, 160))
        const deniedCtx = { get: (name) => name === 'sandboxPolicy' ? { resolve: () => live } : name === 'approval' ? { request: async () => 'denied' } : undefined }
        const defDenied = tools((tool) => tool, { resolveWorkspaceCwd: () => dir8, getCtx: () => deniedCtx, sandboxPlatform: 'win32' })[0]
        const denied = await defDenied.execute({ command: 'echo should-not-run', sandbox_permissions: 'danger-full-access', justification: 'test' }, { agent: { session: { id: 's' } }, callId: 'c2' })
        ok('拒绝时命令不执行且带 failure=APPROVAL_DENIED', /\[failure: APPROVAL_DENIED;/.test(denied) && !/should-not-run/.test(denied), denied.slice(-200))
    }
    finally { bestEffortRm(dir8) }
}

console.log('== 22b. 参数错误码 / 未起进程无副作用 / DSH 环境注入 ==')
{
    const def = tools((tool) => tool, { resolveWorkspaceCwd: () => tmpdir() })[0]
    const both = await def.execute({ command: 'echo x', script_path: '/tmp/x.sh', description: 'both' })
    ok('command + script_path 同时给 ⇒ INVALID_BASH_ARGUMENT', /\[failure: INVALID_BASH_ARGUMENT; effects: none; retry: after-input-change\]/.test(both), both.slice(-160))

    const missing = await def.execute({ command: '   ', description: 'empty' })
    ok('空命令 ⇒ INVALID_BASH_ARGUMENT（且 effects=none）', /INVALID_BASH_ARGUMENT/.test(missing) && /effects: none/.test(missing), missing.slice(-140))

    const noScript = await def.execute({ script_path: '/definitely/not/here.sh', description: 'noscript' })
    ok('脚本不存在 ⇒ INVALID_BASH_ARGUMENT', /INVALID_BASH_ARGUMENT/.test(noScript), noScript.slice(-140))

    const died = await def.execute({ command: 'exit 9', description: 'nonzero' })
    ok('起了进程后非零退出 ⇒ effects=unknown（可能有副作用）', /EXIT_NONZERO; effects: unknown/.test(died), died.slice(-120))

    // 宿主 shellEnv.collect 的 DSH_* 要真的进到子进程
    const envCtx = { get: (name) => name === 'shellEnv'
        ? { collect: () => ({ DSH_HOME: 'C:/dsh-home', DSH_SHELL: '1', DSH_SESSION_ID: 'sess-123' }) }
        : (name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined) }
    const defEnv = tools((tool) => tool, { resolveWorkspaceCwd: () => tmpdir(), getCtx: () => envCtx })[0]
    const envText = await defEnv.execute({ command: 'printf "%s|%s" "$DSH_SHELL" "$DSH_SESSION_ID"', description: 'env' })
    ok('宿主 shellEnv 的 DSH_* 注入子进程', /1\|sess-123/.test(envText), envText.slice(0, 200))
}

console.log('== 22c. 运行时不在了 ⇒ shell 族整个不注册（并登记重挂回调）==')
{
    const registered = []
    const fakeCtx = { tools: { register: (tool) => registered.push(tool) }, get: () => undefined }
    // 显式传空 bashPath 模拟"运行时未安装"（开发机上可能已经装过运行时）
    const none = bashModule.apply(fakeCtx, (tool) => tool, { platform: 'win32', bashPath: '' })
    ok('没有运行时 ⇒ apply 返回 0、一个工具都不注册', none === 0 && registered.length === 0, JSON.stringify({ none, registered: registered.length }))

    ok('缺运行时登记的挂载回调可被执行', (await bashModule.requestShellRemount()) === false)
    let called = 0
    bashModule.setShellRemount(async () => { called += 1; return true })
    ok('requestShellRemount 调用回调并回 true', (await bashModule.requestShellRemount()) === true && called === 1)
    bashModule.setShellRemount(null)
    ok('清掉回调后不再执行', (await bashModule.requestShellRemount()) === false && called === 1)

    // 有运行时（自测用显式 bashPath 模拟）⇒ 正常注册
    const withRuntime = bashModule.apply({ ...fakeCtx, tools: { register: (tool) => registered.push(tool) } }, (tool) => tool, { platform: 'win32', bashPath: TEST_BASH })
    ok('有运行时 ⇒ 注册 1 个 bash', withRuntime === 1 && registered.some((tool) => tool.name === 'bash'), String(withRuntime))
}

console.log('== 22f. 后台/晋升回执：教模型用 wait 而不是轮询 ==')
{
    const def = tools((tool) => tool, { getJobs: () => fakeJobs })[0]
    // fakeJobs 已在后台用例里定义；这里单独造一份最小实现
    const started = []
    const jobs = {
        start: (options) => { started.push(options); return 'job-wait-1' },
        remove: () => true,
        get: () => undefined,
    }
    const def2 = tools((tool) => tool, { getJobs: () => jobs })[0]
    const out = await def2.execute({ command: 'echo hi', run_in_background: true, description: 'bg' }, { agent: { id: 'a', session: {} } })
    ok('后台回执提示 wait:true', /job_output \{ id, wait: true \}/.test(out), out.slice(0, 160))
    ok('后台回执明确劝阻 sleep 轮询', /不要用 sleep 轮询/.test(out), out.slice(0, 160))
}

console.log('== 23. 会话/agent 销毁时收尾活任务 ==')
{
    const dir9 = mkdtempSync(join(tmpdir(), 'tk bash dispose-'))
    try {
        let captured = null
        const jobs = { start(options) { captured = options; return 'job-live' }, remove() {} }
        const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dir9, getJobs: () => jobs })[0]
        await def.execute({ command: 'sleep 5', background: true }, { agent: { id: 'a1', session: { id: 's1' } } })
        const run = captured.run()
        bashModule.disposeLiveJobs({ sessionId: 's1' })
        const done = await run.done
        ok('会话销毁 ⇒ 活任务被取消', done.status === 'killed' || done.status === 'failed', JSON.stringify(done))
        const handlers = {}
        const off = bashModule.mountJobCleanup({ on(event, handler) { handlers[event] = handler; return () => {} } })
        ok('挂上 agent/session 销毁事件', typeof handlers['agent/disposed'] === 'function' && typeof handlers['session/disposed'] === 'function')
        off()

        let removeCalls = 0
        const jobs3 = { start() { return 'job-r' }, remove() { removeCalls += 1 } }
        const defR = tools((tool) => tool, { resolveWorkspaceCwd: () => dir9, getJobs: () => jobs3 })[0]
        await defR.execute({ command: 'echo retry-drop' }, { agent: { id: 'a1', session: { id: 's2' } } })
        await new Promise((resolve) => setTimeout(resolve, 300))
        ok('前台执行不产生 job ⇒ 也不调用 remove', removeCalls === 0, String(removeCalls))
    }
    finally { bestEffortRm(dir9) }
}

console.log('== 24. 宿主 terminal 卡片契约 ==')
{
    const def = tools((tool) => tool, { resolveWorkspaceCwd: () => tmpdir() })[0]
    ok('description 必填（卡片据此判定非 persistent）', def.parameters.description?.required === true)
    const okText = await def.execute({ command: 'echo card', description: 'card' })
    ok('成功回执以 [exit code: 0] 结尾', okText.trimEnd().endsWith('[exit code: 0]'), okText.slice(-40))
    const bad = await def.execute({ command: 'exit 7', description: 'card' })
    ok('非零回执以 [exit code: 7] 结尾', bad.trimEnd().endsWith('[exit code: 7]'), bad.slice(-40))
    const controller = new AbortController()
    const pending = def.execute({ command: 'sleep 5', description: 'card' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    const cancelled = await pending
    ok('取消回执也带进程结局标记', /\[(exit code: -?\d+|killed by signal: [^\]]+)\]$/.test(cancelled.trimEnd()), cancelled.slice(-60))
}

console.log('== 25. 宿主 subprocess 路径（spawn/终止/输出交给宿主）==')
{
    const makeHandle = ({ stdout = '', stderr = '', exitCode = 0, delayMs = 0 }) => {
        const makeReader = (text) => ({ readFrom(from) { return { text: text.slice(from), nextOffset: text.length, lossy: false } } })
        return { collected: { stdout: makeReader(stdout), stderr: makeReader(stderr) }, done: new Promise((resolve) => setTimeout(() => resolve({ exitCode, signal: null }), delayMs)), terminate() {} }
    }
    let seenSpec = null
    const host = { spawn(spec) { seenSpec = spec; return makeHandle({ stdout: 'host-out\n' }) } }
    const r = await runBash('echo hi', { subprocess: host, cwd: tmpdir() })
    ok('spawn 参数交给宿主（argv/stdio）', Array.isArray(seenSpec?.argv) && seenSpec.argv[1] === '-c' && seenSpec.stdio?.stdin === 'ignore', JSON.stringify({ argv: seenSpec?.argv?.slice(0, 2) }))
    ok('宿主输出可回读', r.ok === true && r.stdout === 'host-out\n' && r.exitCode === 0, JSON.stringify({ ok: r.ok, out: r.stdout }))
    const hostFail = { spawn() { return makeHandle({ stderr: 'bad\n', exitCode: 3 }) } }
    const rf = await runBash('false', { subprocess: hostFail })
    ok('非零退出可读', rf.ok === false && rf.exitCode === 3 && rf.stderr === 'bad\n', JSON.stringify({ ok: rf.ok, exit: rf.exitCode }))
    const hostSlow = { spawn() { return makeHandle({ stdout: 'partial\n', delayMs: 300 }) } }
    const promoted = await runBash('sleep', { subprocess: hostSlow, timeoutMs: 80, promoteOnTimeout: true })
    ok('超时晋升返回 live 句柄', promoted.promoted === true && typeof promoted.live?.done?.then === 'function' && String(promoted.partial?.stdout).includes('partial'), JSON.stringify(Object.keys(promoted)))
    promoted.live.kill()
    const controller = new AbortController()
    const hostAbort = { spawn() { return makeHandle({ delayMs: 300 }) } }
    setTimeout(() => controller.abort(), 80)
    const ra = await runBash('sleep', { subprocess: hostAbort, signal: controller.signal })
    ok('取消回执带 cancelled', ra.ok === false && /cancelled/i.test(ra.error ?? ''), JSON.stringify({ error: ra.error }))

    // 执行器内部异常（宿主句柄 done 直接 reject）：不能把异常抛给上层，也不该留下 job。
    const rejecting = { spawn() { return { collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } }, done: Promise.reject(new Error('boom')), terminate() {} } } }
    const removedIds = []
    const jobsBroken = { start() { return 'job-broken' }, remove(id) { removedIds.push(id) } }
    const defBroken = bashModule.tools((tool) => tool, { subprocess: rejecting, getJobs: () => jobsBroken, resolveWorkspaceCwd: () => tmpdir(), ...(TEST_BASH === null ? {} : { bashPath: TEST_BASH }) })[0]
    const brokenText = await defBroken.execute({ command: 'x', description: 'broken' })
    ok('执行器内部异常 ⇒ SPAWN_FAILED 而不是抛给上层', /\[failure: SPAWN_FAILED/.test(brokenText), brokenText.slice(-160))
    ok('异常路径没有留下 job（前台不登记）', removedIds.length === 0, JSON.stringify(removedIds))

    let liveText = 'partial\n'
    const liveReader = { readFrom(from) { return { text: liveText.slice(from), nextOffset: liveText.length, lossy: false } } }
    const liveHandle = {
        collected: { stdout: liveReader, stderr: { readFrom() { return { text: '', nextOffset: 0, lossy: false } } } },
        done: new Promise((resolve) => setTimeout(() => { liveText += 'tail\n'; resolve({ exitCode: 0, signal: null }) }, 400)),
        terminate() {},
    }
    const chunks = []
    const hostLive = { spawn() { return liveHandle } }
    const livePromoted = await runBash('sleep', { subprocess: hostLive, timeoutMs: 100, promoteOnTimeout: true, onChunk: (channel, text) => { if (channel === 'stdout') chunks.push(text) } })
    setTimeout(() => { liveText += 'late\n' }, 180)
    await livePromoted.live.done
    await new Promise((resolve) => setTimeout(resolve, 40))
    ok('晋升后持续回传输出（含结束前最后一块）', chunks.join('').includes('late') && chunks.join('').includes('tail'), JSON.stringify(chunks))

    const hostSignal = { spawn() { return makeHandle({ exitCode: 3840 }) } }
    const sig = await runBash('x', { subprocess: hostSignal })
    ok('Windows 的 signal<<8 退出码还原成信号名', sig.signal === 'SIGTERM' && sig.exitCode === null && sig.rawExitCode === 3840, JSON.stringify({ signal: sig.signal, exitCode: sig.exitCode }))
    const realSig = await runBash('kill -TERM $$', { subprocess: localSubprocess })
    ok('被信号杀掉的回执带 signal=SIGTERM', realSig.signal === 'SIGTERM' && /\[killed by signal: SIGTERM\]/.test(renderResult(realSig)), JSON.stringify({ signal: realSig.signal }))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

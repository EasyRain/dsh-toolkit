/**
 * bash —— 进程内执行器：把一个命令行交给 **Git Bash**（POSIX shell）跑，拿回 stdout/stderr。
 *
 * 为什么自己写：内核 0.2.2-rc.1 把 `ops_bash` 整组移除了，`dsh-ops` 的 shell 组件随之报废
 * （它包装的正是内核那个工具）。这里**不碰任何内核内部 API**，只用 `node:child_process`，
 * 所以内核怎么升都不受影响；也不用带 392 MB 的 PortableGit（用系统 Git for Windows）。
 * 设计依据是 ② 线移交的 bash 工具规格与参考实现（他们的验收 12 项全过），本仓库复刻其行为并加了工具契约自测。
 *
 * 四个实测出来的坑（照做，别"优化"）：
 *  ① `-c` 不要 `-lc`：81 ms vs 206 ms，Git Bash 非登录 shell 的 PATH 里已经有 coreutils。
 *  ② 超时必须 `taskkill /T /F`：`child.kill()` 只杀直接子进程，`sleep` 这类孙进程会活下来，
 *     promise 会拖到孙进程自己退出（实测 1.5 s 超时拖到 5.25 s）。
 *  ③ 要删掉继承来的 `PWD`/`OLDPWD`：PowerShell 会把父进程的 PWD 传下来，bash 的 `pwd` 就会说谎。
 *  ④ 显式 `LC_ALL=C.UTF-8`：否则 coreutils 可能按控制台代码页输出，中文乱码。
 *
 * 安全边界：这是一个**真正的 shell**（`bash -c`，argv 直传，不经过 Windows 命令行二次解析）。
 * 它不做命令白名单 —— 权限由宿主/沙箱决定；这里只保证不交互、有超时、有输出上限、找不到 bash 时明确报错。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createSandboxGate, resolveSandboxMode } from './sandbox.js'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export const DEFAULTS = Object.freeze({
    timeoutMs: 60_000,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 2 * 1024 * 1024,
    /** 超时后先"礼貌地"杀一次，等这么久再强杀整棵树（照 ops 的 graceMs）。 */
    graceMs: 250,
})

/** Windows 上 Git for Windows 的常见位置（顺序即优先级）。 */
const WINDOWS_CANDIDATES = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\local\\bin\\bash.exe',
]

const POSIX_CANDIDATES = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']

/**
 * 本插件**自己装**的 PortableGit（见 lib/shell/install.js）的候选位置。
 * 优先级高于系统 Git：用户明确点了"安装"，就该用我们装的那份。
 */
function localCandidates(env = process.env) {
    const roots = [env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE].filter((root) => typeof root === 'string' && root !== '')
    const out = []
    for (const root of roots) {
        const base = join(root, 'dsh-toolkit', 'git')
        out.push(join(base, 'bin', 'bash.exe'))
        out.push(join(base, 'usr', 'bin', 'bash.exe'))
        out.push(join(base, 'PortableGit', 'bin', 'bash.exe'))
    }
    return out
}

let cachedBash = null

/**
 * 找一个可用的 bash；找不到返回 `null`（调用方必须明确报错，**绝不自动下载任何东西**）。
 * 结果按存在性缓存：删了 Git 之后会重新扫描，不会一直指着一条死路径。
 */
export function findBash(env = process.env) {
    if (cachedBash !== null && existsSync(cachedBash)) return cachedBash
    cachedBash = null
    // 显式覆盖（测试/多份 Git 并存时用）
    const explicit = typeof env.DSH_TOOLKIT_BASH === 'string' && env.DSH_TOOLKIT_BASH !== '' ? env.DSH_TOOLKIT_BASH : null
    if (explicit !== null && existsSync(explicit)) return (cachedBash = explicit)
    const candidates = process.platform === 'win32'
        ? [...localCandidates(env), ...WINDOWS_CANDIDATES]
        : POSIX_CANDIDATES
    for (const path of candidates) {
        if (existsSync(path)) return (cachedBash = path)
    }
    const exe = process.platform === 'win32' ? 'bash.exe' : 'bash'
    for (const entry of String(env?.PATH ?? '').split(delimiter)) {
        const dir = entry.trim().replace(/^"|"$/g, '')
        if (dir === '') continue
        const path = join(dir, exe)
        if (existsSync(path)) return (cachedBash = path)
    }
    return null
}

/**
 * 杀掉整棵进程树。`child.kill()` 在 Windows 上只通知直接子进程，
 * 孙进程（`sleep`、`node` 之类）会继续跑并把 promise 拖住 —— 必须用 `taskkill /T`。
 */
function killTree(pid) {
    if (!pid) return
    if (process.platform === 'win32') {
        try {
            const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
            if (process.env.DSH_TOOLKIT_BASH_DEBUG === '1') {
                process.stderr.write(`[bash killTree] pid=${pid} status=${r.status} out=${JSON.stringify(String(r.stdout ?? '').trim())} err=${JSON.stringify(String(r.stderr ?? '').trim())}\n`)
            }
        }
        catch {
            try { process.kill(pid, 'SIGKILL') } catch { /* 进程可能已经退出 */ }
        }
        return
    }
    // POSIX：子进程以独立进程组启动（detached），负 PID = 整组一起杀。
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
}

const clamp = (value, min, max, fallback) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(min, Math.trunc(n)), max)
}

/**
 * 包装脚本：把当前 shell 的进程组号写进临时文件，然后原样 eval 用户命令。
 *
 * 为什么需要（实测）：`sleep 45; echo done` 这类复合命令里，MSYS 的 `fork` 会把子进程的
 * **Windows PPID 指向一个已经退出的辅助进程** ⇒ `taskkill /T`（按 PPID 遍历）**永远抓不到**那个 sleep，
 * 超时后它会留在后台。MSYS 自己的 `kill -9 -<pgid>`（负号 = 进程组）能杀掉，因为 ps 显示子进程与 bash
 * 同属一个 PGID。所以这里先记 pgid，超时时用它杀组，再用 taskkill 兜底。
 *
 * `$0` 保持 `bash`（与 `bash -c` 的默认一致）、`$#`/`$@` 在 eval 前已被清空 ⇒ 对用户命令语义透明。
 */
const WRAPPER = 'printf "%s" "$$" >| "$1"; shift; __dsh_toolkit_cmd="$1"; shift; eval "$__dsh_toolkit_cmd"'

/** 把一个字符串包成 bash 的 single-quoted 参数（script_path 用；路径里可能有空格/引号）。 */
function quoteBashArg(value) {
    // ' → '\'' （关引号 + 转义的撇号 + 再开引号），bash 里唯一可靠的 single-quote 转义
    return `'${String(value).split("'").join("'\\''")}'`
}

/** 杀 MSYS 进程组（仅 Windows 需要；POSIX 用 detached + kill(-pid)）。 */
function killProcessGroup(bash, pidFile) {
    if (process.platform !== 'win32') return false
    try {
        const pgid = readFileSync(pidFile, 'utf8').trim()
        if (!/^\d+$/.test(pgid) || pgid === '0') return false
        spawnSync(bash, ['-c', `kill -9 -${pgid} 2>/dev/null || true`], { windowsHide: true, stdio: 'ignore' })
        return true
    }
    catch {
        return false
    }
}

/**
 * 跑一个命令行。
 *
 * @param {string} command 交给 `bash -c` 的命令行（非空）
 * @param {{ cwd?: string, timeoutMs?: number, maxOutputBytes?: number }} [options]
 * @returns {Promise<{ ok: boolean, exitCode: number|null, signal: string|null,
 *   stdout: string, stderr: string, truncated: boolean, timedOut: boolean,
 *   durationMs: number, bashPath: string|null, error?: string }>}
 */
export async function runBash(command, options = {}) {
    const bash = typeof options.bashPath === 'string' && options.bashPath !== '' ? options.bashPath : findBash()
    if (bash === null) {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: null,
            error: 'bash not found: install Git for Windows (C:\\Program Files\\Git\\bin\\bash.exe) and reopen the host',
        })
    }
    // command 与 script_path 二选一（照 ops 的语义）：给了 script_path 就用 bash 跑那个脚本文件。
    const scriptPath = typeof options.scriptPath === 'string' && options.scriptPath.trim() !== '' ? options.scriptPath.trim() : null
    let line = typeof command === 'string' ? command : ''
    if (scriptPath !== null && line.trim() !== '') {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
            error: 'script_path 与 command 二选一：给了脚本路径就不要再给 command',
        })
    }
    if (scriptPath !== null) {
        if (!existsSync(scriptPath)) {
            return Promise.resolve({
                ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
                truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
                error: `script_path 不存在：${scriptPath}`,
            })
        }
        line = `bash ${quoteBashArg(scriptPath)}`
    }
    if (line.trim() === '') {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
            error: 'command must be a non-empty string（或用 script_path 指定脚本）',
        })
    }

    // cwd 是本插件的名字；workdir 是 ops/host 的名字，两个都收（workdir 只是别名）。
    const workdir = options.cwd ?? options.workdir
    const cwd = typeof workdir === 'string' && workdir.trim() !== '' ? workdir : process.cwd()
    const timeoutMs = clamp(options.timeoutMs, 1, DEFAULTS.maxTimeoutMs, DEFAULTS.timeoutMs)
    const maxOutputBytes = clamp(options.maxOutputBytes, 256, 64 * 1024 * 1024, DEFAULTS.maxOutputBytes)
    const graceMs = clamp(options.graceMs, 0, 10_000, DEFAULTS.graceMs)

    // ③ 父进程的 PWD 会让 `pwd` 说谎；④ 代码页会让中文乱码。
    // 环境净化（照 ops）：关颜色/分页器、消息目录固定英文，避免 ANSI 序列与 `less` 之类把非交互调用挂住。
    const env = {
        ...process.env,
        ...(options.env ?? {}),
        NO_COLOR: '1',
        TERM: 'dumb',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        LC_MESSAGES: 'C',
        LC_ALL: 'C.UTF-8',
        LANG: 'C.UTF-8',
    }
    delete env.PWD
    delete env.OLDPWD

    const startedAt = Date.now()
    // 每次调用一个 pgid 文件（见 WRAPPER 注释）；finish 时删掉，异常路径也不会留垃圾。
    // 受限沙箱下写 %TEMP% 可能被拒（Windows 沙箱会卡住 MSYS），所以允许调用方指定目录（通常用工作区）。
    const pidDir = typeof options.pidDir === 'string' && options.pidDir !== '' ? options.pidDir : tmpdir()
    const pidFile = join(pidDir, `dsh-toolkit-bash-${process.pid}-${startedAt}-${Math.random().toString(36).slice(2, 8)}.pgid`)
    let argv = [bash, '-c', WRAPPER, 'bash', pidFile, line]
    // 沙箱闸门：宿主给了 sandboxPolicy 且不是完全权限时，把整条 argv 交给 sandbox.confine 包一层。
    if (typeof options.prepareArgv === 'function') {
        try {
            const prepared = await options.prepareArgv(argv, options.signal)
            if (Array.isArray(prepared) && prepared.length > 0) argv = prepared
        }
        catch (error) {
            return {
                ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
                truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
                error: error instanceof Error ? error.message : String(error),
                ...(typeof options.sandboxOfError === 'function' ? { sandbox: options.sandboxOfError(error) } : {}),
            }
        }
    }

    return new Promise((resolve) => {
        let settled = false
        let out = ''
        let err = ''
        let outBytes = 0
        let errBytes = 0
        let truncated = false
        let timedOut = false
        let cancelled = false
        let promoted = false
        let doneResolve = null
        // 输出超上限时不静默丢弃：把**完整**输出落到临时文件，回执给路径（照 ops 的 spill 思路）。
        let spillPath = null
        let spillFd = null
        let spillBytes = 0
        let spillTruncated = false
        const spillCap = clamp(options.maxSpillBytes, 1024, 1024 * 1024 * 1024, MAX_SPILL_BYTES)
        const overflowed = { stdout: false, stderr: false }
        const spill = (text) => {
            try {
                if (spillPath === null) {
                    spillPath = join(tmpdir(), `dsh-toolkit-bash-${process.pid}-${startedAt}-${Math.random().toString(36).slice(2, 8)}.log`)
                    spillFd = openSync(spillPath, 'w')
                    writeSync(spillFd, '=== full output（stdout/stderr 交错顺序为近似值）===\n')
                }
                if (spillTruncated) return
                const bytes = Buffer.byteLength(text, 'utf8')
                if (spillBytes + bytes > spillCap) {
                    spillTruncated = true
                    const room = Math.max(0, spillCap - spillBytes)
                    if (room > 0) { writeSync(spillFd, text.slice(0, room)); spillBytes += room }
                    return
                }
                writeSync(spillFd, text)
                spillBytes += bytes
            }
            catch { /* 落盘失败不影响主流程，truncated 仍然为 true */ }
        }
        // 每次调用一个 pgid 文件（见 WRAPPER 注释）；finish 时删掉，异常路径也不会留垃圾。
        // ① `-c`（不是 `-lc`）：快 2.5 倍，且 coreutils 本来就在 PATH 上。
        //    外层用 WRAPPER 记下 MSYS 进程组号，命令原样作为 `$2` 交给 eval（argv 直传，不经 cmd.exe）。
        const child = spawn(argv[0], argv.slice(1), {
            cwd,
            env,
            windowsHide: true,
            // POSIX 上放进自己的进程组，超时才杀得掉孙进程（见 killTree）。
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        const cleanup = () => {
            try { rmSync(pidFile, { force: true }) } catch { /* 文件可能没写成 */ }
        }

        const finish = (payload) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            cleanup()
            try { options.signal?.removeEventListener?.('abort', onAbort) } catch { /* 老 Node */ }
            try { if (spillFd !== null) closeSync(spillFd) } catch { /* 已关 */ }
            resolve({
                ok: payload.exitCode === 0 && timedOut === false && payload.error === undefined,
                durationMs: Date.now() - startedAt,
                bashPath: bash,
                stdout: out,
                stderr: err,
                truncated,
                timedOut,
                exitCode: payload.exitCode ?? null,
                signal: payload.signal ?? null,
                ...(spillPath === null ? {} : { spillPath }),
                ...(spillTruncated ? { spillTruncated: true } : {}),
                diagnostics: { bashPath: bash, cwd, timeoutMs, graceMs, maxOutputBytes },
                ...(payload.error === undefined ? {} : { error: payload.error }),
            })
        }

        /** 两路一起杀：先 MSYS 进程组（能抓到 taskkill 抓不到的 fork 子进程），再按树兜底。 */
        const killAll = () => {
            killProcessGroup(bash, pidFile)
            killTree(child.pid)
        }

        // 外部取消（后台任务被 job_kill 停掉）：与超时同样的两路杀，但标记成 cancelled 而不是 timedOut。
        const onAbort = () => {
            if (settled || cancelled) return
            cancelled = true
            killAll()
            setTimeout(() => finish({ exitCode: null, signal: 'SIGKILL', error: 'cancelled' }), 100)
        }
        if (options.signal !== undefined && options.signal !== null) {
            if (options.signal.aborted) onAbort()
            else options.signal.addEventListener('abort', onAbort, { once: true })
        }

        /** 到点不杀，改为"晋升为后台"：把还活着的进程与后续输出交给调用方（宿主 jobs）。 */
        const promoteNow = () => {
            if (settled) return
            settled = true
            promoted = true
            clearTimeout(timer)
            resolve({
                promoted: true,
                timeoutMs,
                live: {
                    pid: child.pid,
                    kill: () => { try { killAll() } catch { /* 已退出 */ } },
                    done: new Promise((resolveDone) => { doneResolve = resolveDone }),
                },
                partial: { stdout: out, stderr: err, truncated, spillPath, durationMs: Date.now() - startedAt },
                diagnostics: { bashPath: bash, cwd, timeoutMs, graceMs, maxOutputBytes },
            })
        }
        /** 晋升出去之后，进程真正结束时再收尾（清 pgid、关 spill、resolve live.done）。 */
        const settleLive = (code, signal) => {
            if (doneResolve === null) return
            const done = doneResolve
            doneResolve = null
            try { killAll() } catch { /* 已退出 */ }
            try { if (spillFd !== null) closeSync(spillFd) } catch { /* 已关 */ }
            cleanup()
            done({ status: code === 0 ? 'completed' : 'failed', detail: `exit code: ${code ?? '?'}`, exitCode: code ?? null, signal: signal ?? null })
        }

        const timer = setTimeout(() => {
            if (options.promoteOnTimeout === true) { promoteNow(); return }
            timedOut = true
            // 先温和终止（POSIX 是 SIGTERM；Windows 上 kill() 只结束 bash 本身），等 graceMs 再强杀整棵树。
            try { child.kill() } catch { /* 已经退出 */ }
            setTimeout(() => {
                killAll()
                // 树被杀后 'close' 通常会来；万一不来，2 s 后自己收尾，别让调用方一直挂着。
                setTimeout(() => finish({ exitCode: null, signal: 'SIGKILL' }), 2000)
            }, graceMs)
        }, timeoutMs)

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            if (typeof options.onChunk === 'function') { try { options.onChunk('stdout', chunk) } catch { /* 订阅方问题不影响执行 */ } }
            const bytes = Buffer.byteLength(chunk, 'utf8')
            if (outBytes + bytes > maxOutputBytes) {
                truncated = true
                if (!overflowed.stdout) { overflowed.stdout = true; spill(out) }
                spill(chunk)
                return
            }
            outBytes += bytes
            out += chunk
        })
        child.stderr.on('data', (chunk) => {
            if (typeof options.onChunk === 'function') { try { options.onChunk('stderr', chunk) } catch { /* 同上 */ } }
            const bytes = Buffer.byteLength(chunk, 'utf8')
            if (errBytes + bytes > maxOutputBytes) {
                truncated = true
                if (!overflowed.stderr) { overflowed.stderr = true; spill(err) }
                spill(chunk)
                return
            }
            errBytes += bytes
            err += chunk
        })
        child.on('error', (error) => {
            finish({ exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) })
        })
        // ⚠️ 不能只等 `close`（实测）：`sleep 45; echo done` 这类复合命令里 bash 会 fork 出孙进程，
        // 超时杀掉 bash 后，**孙进程仍持有 stdout/stderr 的写端** ⇒ `close` 永远不触发，只能等 2 s 兜底
        // ⇒ 2 s 超时被抬到 4.2 s，而且留下残留进程。`exit` 在进程退出时立刻触发，是可靠信号；
        // 这里给它 100 ms 把管道里剩下的数据收完（正常命令 `close` 会在几 ms 内先到，不受影响）。
        child.on('exit', (code, signal) => {
            setTimeout(() => {
                if (promoted) { settleLive(code, signal); return }
                if (timedOut) killAll() // 补一刀：退出瞬间又 fork 出来的也带走
                finish({ exitCode: code, signal })
            }, 100)
        })
        child.on('close', (code, signal) => {
            if (promoted) { settleLive(code, signal); return }
            finish({ exitCode: code, signal })
        })
    })
}

/** 工具返回值的文本投影（模型看到的就是这段；stdout/stderr 原样保留，不做转义）。 */
export function renderResult(result) {
    const r = result ?? {}
    const head = [
        `ok=${r.ok === true}`,
        `exitCode=${r.exitCode === null || r.exitCode === undefined ? '?' : r.exitCode}`,
        `timedOut=${r.timedOut === true}`,
        `truncated=${r.truncated === true}`,
        `${r.durationMs ?? 0}ms`,
        r.bashPath ? `bash=${r.bashPath}` : null,
        r.signal ? `signal=${r.signal}` : null,
    ].filter(Boolean).join('  ')
    const parts = [head]
    if (typeof r.error === 'string' && r.error !== '') parts.push(`error: ${r.error}`)
    parts.push('--- stdout ---', r.stdout === '' ? '(empty)' : String(r.stdout).replace(/\n$/, ''))
    parts.push('--- stderr ---', r.stderr === '' ? '(empty)' : String(r.stderr).replace(/\n$/, ''))
    if (r.truncated === true) parts.push(`(输出超过上限，已截断；上限 ${DEFAULTS.maxOutputBytes} B)`)
    if (typeof r.spillPath === 'string') parts.push(`完整输出已落盘：${r.spillPath}（用 file read 分段查看）`)
    if (r.spillTruncated === true) parts.push(`（落盘也达到 ${MAX_SPILL_BYTES / 1048576} MB 上限，剩余输出已丢弃）`)
    if (r.failure !== undefined) parts.push(`[failure: ${r.failure.code}; effects: ${r.failure.effectState}; retry: ${r.failure.retry}]${r.failure.nextAction === undefined ? '' : ` ${r.failure.nextAction}`}`)
    if (r.aborted === true) parts.push('[aborted]')
    if (r.diagnostics !== undefined) parts.push(`diagnostics: cwd=${r.diagnostics.cwd}  timeoutMs=${r.diagnostics.timeoutMs}  graceMs=${r.diagnostics.graceMs}`)
    if (/^SANDBOX_UNAVAILABLE/.test(String(r.error ?? ''))) parts.push('[sandbox: unavailable — 命令未执行]')
    if (r.sandbox?.denied === true) parts.push(`[sandbox: file access denied under ${r.sandbox.mode} mode]`)
    if (r.sandbox?.runnerFailed === true) parts.push('[sandbox: runner failed before the command ran]')
    if (r.sandbox !== undefined && r.sandbox.mode && r.sandbox.denied !== true && r.sandbox.runnerFailed !== true) parts.push(`[sandbox: ${r.sandbox.mode}${r.sandbox.enforcement ? ` / ${r.sandbox.enforcement}` : ''}]`)
    return parts.join('\n')
}

/** 后台任务每路最多留多少（超出记 lost，host 会看到 lossy）。 */
const BACKGROUND_CAP_BYTES = 4 * 1024 * 1024

/** 输出落盘上限（照 ops）：超过就不再写，回执明确告知。 */
const MAX_SPILL_BYTES = 64 * 1024 * 1024

/** 后台任务的输出缓冲：给宿主 jobs 的 `read(offset)` 用。 */
function makeStreamBuffers(capBytes = BACKGROUND_CAP_BYTES) {
    const text = { stdout: '', stderr: '' }
    const lost = { stdout: 0, stderr: 0 }
    return {
        append(stream, chunk) {
            if (text[stream].length + chunk.length > capBytes) { lost[stream] += chunk.length; return }
            text[stream] += chunk
        },
        reader(stream) {
            return {
                channel: stream,
                read(offset) {
                    const start = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
                    return { text: text[stream].slice(start), nextOffset: text[stream].length, lossy: lost[stream] > 0 }
                },
            }
        },
    }
}

/** 失败回执的结构化字段（照 ops 的 failure 契约：code / effectState / retry / nextAction）。 */
export function failureOf({ ok, timedOut, error, exitCode, signal, sandbox }) {
    if (ok === true && sandbox?.denied !== true) return undefined
    const text = String(error ?? '')
    if (/^SANDBOX_UNAVAILABLE/.test(text)) return { code: 'SANDBOX_UNAVAILABLE', message: text.slice(0, 300), effectState: 'none', retry: 'after-config-change', nextAction: '修复沙箱服务或切到 danger-full-access 后重试' }
    if (/EXECUTOR_UNAVAILABLE/.test(text)) return { code: 'EXECUTOR_UNAVAILABLE', message: text.slice(0, 300), effectState: 'none', retry: 'after-config-change', nextAction: '安装/修复 bash 运行时或切到 danger-full-access' }
    if (/bash not found/i.test(text)) return { code: 'EXECUTOR_UNAVAILABLE', message: text.slice(0, 300), effectState: 'none', retry: 'after-config-change', nextAction: '安装 Git for Windows（工具集里有安装按钮）' }
    if (sandbox?.denied === true) return { code: 'SANDBOX_DENIED', message: 'sandbox denied file effects', effectState: 'unknown', retry: 'never', nextAction: '命令效果被沙箱拒绝；放宽策略或改路径' }
    if (/cancelled/i.test(text)) return { code: 'CANCELLED', message: text, effectState: 'unknown', retry: 'never' }
    if (timedOut === true) return { code: 'TIMEOUT', message: text === '' ? 'timeout' : text, effectState: 'unknown', retry: 'after-input-change', nextAction: '增大 timeoutMs 或改用 background' }
    if (signal !== null && signal !== undefined) return { code: 'KILLED_BY_SIGNAL', message: `signal ${signal}`, effectState: 'unknown', retry: 'never' }
    if (typeof exitCode === 'number' && exitCode !== 0) return { code: 'EXIT_NONZERO', message: `exit code ${exitCode}`, effectState: 'unknown', retry: 'never' }
    if (text !== '') return { code: 'SPAWN_FAILED', message: text.slice(0, 300), effectState: 'none', retry: 'after-input-change' }
    return undefined
}

/** 工具定义（字段映射方言；`defineTool` 会翻译成宿主 schema）。 */
export function tools(defineTool, options = {}) {
    const workspace = typeof options.resolveWorkspaceCwd === 'function' ? options.resolveWorkspaceCwd : () => null
    return [
        defineTool({
            name: 'bash',
            description:
                'Run a bash command (Git Bash on Windows) non-interactively; returns the exit code plus separate stdout/stderr. ' +
                'Windows-only; on POSIX the host ships its own bash. Prefer it over pwsh for POSIX text pipelines and quoting PowerShell would mangle; ' +
                'do Windows-native work as `powershell.exe -NoProfile -Command "..."`. On timeout it is promoted to a host background job when available ' +
                '(reply carries its jobId; use job_output/job_kill), otherwise the tree is killed. Output beyond the cap is spooled to a file whose path is returned. ' +
                'Under a sandboxed mode it runs confined and refuses to run when confinement is unavailable (never bypasses the sandbox). ' +
                'Fails loudly when bash is missing; never downloads anything.',
            parameters: {
                command: { type: 'string', description: 'Bash command/pipeline; omit when using script_path.' },
                script_path: { type: 'string', description: 'Script file to run with bash; omit when using command.' },
                description: { type: 'string', description: 'Short label.' },
                cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
                workdir: { type: 'string', description: 'Alias of cwd; cwd wins.' },
                timeoutMs: { type: 'integer', description: `Timeout in ms (default ${DEFAULTS.timeoutMs}, max ${DEFAULTS.maxTimeoutMs}).` },
                graceMs: { type: 'integer', description: `Grace before forced kill (default ${DEFAULTS.graceMs}).` },
                includeDiagnostics: { type: 'boolean', description: 'Include resolved cwd/timeout/grace.' },
                background: { type: 'boolean', description: 'Run as a host background job; returns a jobId.' },
            },
            output: {
                schema: { type: 'string', description: 'Header (ok/exitCode/timedOut/truncated/duration/bash) + raw stdout + raw stderr (+ spill path / diagnostics).' },
                render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            async execute(args, exec) {
                const cwd = (typeof args?.cwd === 'string' && args.cwd.trim() !== '')
                    ? args.cwd
                    : ((typeof args?.workdir === 'string' && args.workdir.trim() !== '') ? args.workdir : (workspace() ?? undefined))
                const scriptPath = typeof args?.script_path === 'string' ? args.script_path : undefined
                // 沙箱闸门：非 danger-full-access 时必须拿到 confinement，否则拒绝执行。
                const sandboxPlatform = options.sandboxPlatform ?? process.platform
                const wantedMode = typeof options.getCtx === 'function' ? resolveSandboxMode(options.getCtx(), exec) : null
                let sandboxRuntime = null
                if (wantedMode !== null && wantedMode !== 'danger-full-access' && sandboxPlatform === 'win32') {
                    try { sandboxRuntime = typeof options.resolveConfinedBash === 'function' ? await options.resolveConfinedBash() : null }
                    catch { sandboxRuntime = null }
                    if (sandboxRuntime === null) {
                        const error = 'EXECUTOR_UNAVAILABLE: Windows 的受限模式需要 dsh-ops 的私有 MSYS 运行时（dsh-ops 与 @dsh-ops/bash-win32-x64 缺失，或打补丁失败）；系统 Git Bash 在沙箱里起不来。请切到 danger-full-access 或安装 dsh-ops。命令未执行。'
                        return renderResult({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 0, bashPath: findBash(), error, failure: failureOf({ ok: false, error, exitCode: null, timedOut: false, signal: null }) })
                    }
                }
                const gate = typeof options.getCtx === 'function' ? createSandboxGate(options.getCtx(), { platform: sandboxPlatform, hasConfinedRuntime: sandboxRuntime !== null }) : null
                let decision
                const prepareArgv = gate === null ? undefined : async (argv, signal) => {
                    decision = await gate.prepareArgv(argv, exec, signal)
                    return decision.argv
                }

                // 后台任务：交给宿主的 jobs 服务（这样 job_output / job_kill 才认得这个 id）。
                if (args?.background === true) {
                    const jobs = typeof options.getJobs === 'function' ? options.getJobs() : undefined
                    if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') {
                        return 'ok=false  kind=background\n后台任务不可用：宿主没有 jobs 服务（或尚未就绪）；去掉 background 同步执行'
                    }
                    const buffers = makeStreamBuffers()
                    const controller = new AbortController()
                    const label = (typeof args?.description === 'string' && args.description.trim() !== '')
                        ? args.description.trim()
                        : String(args?.command ?? args?.script_path ?? 'bash').slice(0, 80)
                    try {
                        const jobId = jobs.start({
                            kind: 'bash',
                            label,
                            ...(exec?.agent?.id === undefined ? {} : { owner: exec.agent.id }),
                            output: [buffers.reader('stdout'), buffers.reader('stderr')],
                            run: () => ({
                                done: runBash(String(args?.command ?? ''), {
                                    cwd,
                                    scriptPath,
                                    timeoutMs: args?.timeoutMs,
                                    graceMs: args?.graceMs,
                                    signal: controller.signal,
                                    onChunk: (stream, chunk) => buffers.append(stream, chunk),
                                    ...(prepareArgv === undefined ? {} : { prepareArgv }),
                                    ...(sandboxRuntime === null ? {} : { bashPath: sandboxRuntime.file, env: sandboxRuntime.env, pidDir: cwd }),
                                }).then((result) => {
                                    const sandbox = gate?.classify({ decision, exitCode: result.exitCode, stderr: result.stderr, error: result.error })
                                    return {
                                        status: result.timedOut || controller.signal.aborted ? 'killed' : (result.ok ? 'completed' : 'failed'),
                                        detail: result.error ?? `exit code: ${result.exitCode ?? '?'}`,
                                        ...(sandbox === undefined ? {} : { sandbox }),
                                    }
                                }).catch((error) => ({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })),
                                cancel: (reason) => controller.abort(new Error(reason === undefined ? 'cancelled' : String(reason))),
                            }),
                        })
                        return `ok=true  kind=background  jobId=${jobId}  label=${label}\n后台执行中：用 job_output（channel=stdout/stderr）读输出，job_kill 终止。`
                    }
                    catch (error) {
                        return `ok=false  kind=background\n后台任务启动失败：${error instanceof Error ? error.message : String(error)}`
                    }
                }

                const jobs = typeof options.getJobs === 'function' ? options.getJobs() : undefined
                const canPromote = typeof jobs?.start === 'function'
                const promoteBuffers = canPromote ? makeStreamBuffers() : null
                const result = await runBash(String(args?.command ?? ''), {
                    cwd,
                    scriptPath,
                    timeoutMs: args?.timeoutMs,
                    graceMs: args?.graceMs,
                    ...(prepareArgv === undefined ? {} : { prepareArgv }),
                    ...(sandboxRuntime === null ? {} : { bashPath: sandboxRuntime.file, env: sandboxRuntime.env, pidDir: cwd }),
                    ...(canPromote ? { promoteOnTimeout: true, onChunk: (stream, chunk) => promoteBuffers.append(stream, chunk) } : {}),
                })
                // 到点仍在跑 ⇒ 不杀，转成后台任务（ops 的 promoted 语义）：长任务不必取消重跑。
                if (result.promoted === true) {
                    const label = (typeof args?.description === 'string' && args.description.trim() !== '')
                        ? args.description.trim()
                        : String(args?.command ?? args?.script_path ?? 'bash').slice(0, 80)
                    let jobId
                    try {
                        jobId = jobs.start({
                            kind: 'bash',
                            label,
                            ...(exec?.agent?.id === undefined ? {} : { owner: exec.agent.id }),
                            output: [promoteBuffers.reader('stdout'), promoteBuffers.reader('stderr')],
                            run: () => ({ done: result.live.done, cancel: (reason) => result.live.kill(reason) }),
                        })
                    }
                    catch (error) {
                        try { result.live.kill() } catch { /* 已退出 */ }
                        return `ok=false  kind=promoted
晋升后台失败（已终止命令）：${error instanceof Error ? error.message : String(error)}`
                    }
                    const partial = result.partial ?? {}
                    const stdoutText = partial.stdout === undefined || partial.stdout === '' ? '(empty)' : String(partial.stdout).replace(/\n$/, '')
                    const stderrText = partial.stderr === undefined || partial.stderr === '' ? '(empty)' : String(partial.stderr).replace(/\n$/, '')
                    return `ok=true  kind=promoted  jobId=${jobId}  label=${label}  after=${result.timeoutMs}ms
`
                        + `命令仍在运行，已转入后台：用 job_output（channel=stdout/stderr）读输出、job_kill 终止。
`
                        + `--- stdout (partial) ---
${stdoutText}
--- stderr (partial) ---
${stderrText}`
                }
                const sandbox = gate?.classify({ decision, exitCode: result.exitCode, stderr: result.stderr, error: result.error })
                const failure = failureOf({ ok: result.ok, timedOut: result.timedOut, error: result.error, exitCode: result.exitCode, signal: result.signal, sandbox })
                const view = {
                    ...(args?.includeDiagnostics === true ? result : { ...result, diagnostics: undefined }),
                    ...(sandbox === undefined ? {} : { sandbox }),
                    ...(failure === undefined ? {} : { failure }),
                    ...(result.error === 'cancelled' ? { aborted: true } : {}),
                }
                return renderResult(view)
            },
        }),
    ]
}

export function apply(ctx, defineTool, options = {}) {
    // POSIX 上宿主本来就发布 `bash`；同名注册会撞车/遮蔽宿主的工具 ⇒ **让位**。
    // Windows 上宿主用的是 `pwsh`，所以 `bash` 归我们（宿主 UI 也会显示「运行命令」）。
    const platform = options.platform ?? process.platform
    if (platform !== 'win32') return 0
    // 惰性取 jobs：apply 时服务可能还没就绪，真正执行时再查（拿不到就明确报错）。
    const getJobs = () => {
        try { return typeof ctx.get === 'function' ? ctx.get('jobs') : undefined }
        catch { return undefined }
    }
    const list = tools(defineTool, { ...options, getJobs, getCtx: () => ctx, resolveConfinedBash: async () => {
        try {
            const module = await import('./ops-runtime.js')
            return await module.resolveOpsConfinedBash()
        }
        catch { return null }
    } })
    for (const tool of list) ctx.tools.register(tool)
    return list.length
}

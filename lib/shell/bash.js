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
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { approveEscalation } from './approval.js'
import { createSandboxGate, resolveSandboxMode } from './sandbox.js'

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
 * Windows/MSYS 把"被信号杀掉"编码成 `signal << 8`（实测 SIGINT=512、SIGKILL=2304、
 * SIGSEGV=2816、SIGTERM=3840），而 `outcome.signal` 恒为 null。这里还原成信号名，
 * 免得回执里出现 3840 这种看不懂的数字。
 */
const WINDOWS_SIGNAL_CODES = Object.freeze({
    1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
    9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
    16: 'SIGSTKFLT', 17: 'SIGCHLD', 18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP', 21: 'SIGTTIN', 22: 'SIGTTOU',
    24: 'SIGXCPU', 25: 'SIGXFSZ', 26: 'SIGVTALRM', 27: 'SIGPROF', 29: 'SIGIO', 30: 'SIGPWR', 31: 'SIGSYS',
})

function decodeWindowsSignal(exitCode) {
    if (typeof exitCode !== 'number' || exitCode <= 0 || exitCode % 256 !== 0) return null
    const signal = WINDOWS_SIGNAL_CODES[exitCode / 256]
    return signal === undefined ? null : signal
}

const clamp = (value, min, max, fallback) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(min, Math.trunc(n)), max)
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
    const commandLine = typeof command === 'string' ? command : ''
    if (scriptPath !== null && commandLine.trim() !== '') {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
            error: 'script_path 与 command 二选一：给了脚本路径就不要再给 command', errorCode: 'INVALID_BASH_ARGUMENT', started: false,
        })
    }
    if (scriptPath !== null && !existsSync(scriptPath)) {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
            error: `script_path 不存在：${scriptPath}`, errorCode: 'INVALID_BASH_ARGUMENT', started: false,
        })
    }
    if (scriptPath === null && commandLine.trim() === '') {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
            error: 'command must be a non-empty string（或用 script_path 指定脚本）', errorCode: 'INVALID_BASH_ARGUMENT', started: false,
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
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        LC_ALL: 'C.UTF-8',
        LANG: 'C.UTF-8',
    }
    delete env.PWD
    delete env.OLDPWD

    const startedAt = Date.now()
    if (options.subprocess === undefined || options.subprocess === null || typeof options.subprocess.spawn !== 'function') {
        return {
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
            error: 'EXECUTOR_UNAVAILABLE: host subprocess service is unavailable; the command was not started',
        }
    }
    let argv = [bash, ...(scriptPath === null ? ['-c', commandLine] : [scriptPath])]
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
    // 宿主的"停止"可能发生在起进程之前（prepareArgv/沙箱准备阶段）：先看一眼，别白起一个进程。
    if (options.signal !== undefined && options.signal !== null && options.signal.aborted) {
        return {
            ok: false, exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash, error: 'cancelled',
        }
    }
    return runBashViaHost({
        spawn: options.subprocess.spawn.bind(options.subprocess),
        argv,
        env,
        cwd,
        timeoutMs,
        graceMs,
        maxOutputBytes,
        maxSpillBytes: clamp(options.maxSpillBytes, 1024, 1024 * 1024 * 1024, MAX_SPILL_BYTES),
        startedAt,
        bashPath: bash,
        ...(options.promoteOnTimeout === true ? { promoteOnTimeout: true } : {}),
        ...(options.noTimeout === true ? { noTimeout: true } : {}),
        ...(typeof options.onChunk === 'function' ? { onChunk: options.onChunk } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
}

/** 宿主 `ctx.subprocess.spawn` 路径：终止升级/输出预算/spill/管道生命周期都由宿主管理。 */
async function runBashViaHost(spec) {
    const controller = new AbortController()
    const abortNow = (reason) => { try { controller.abort(new Error(reason)) } catch { /* 已中止 */ } }
    if (spec.signal !== undefined && spec.signal !== null) {
        if (spec.signal.aborted) abortNow('cancelled')
        else spec.signal.addEventListener('abort', () => abortNow('cancelled'), { once: true })
    }
    let handle
    try {
        handle = spec.spawn({
            argv: spec.argv,
            cwd: spec.cwd,
            env: spec.env,
            stdio: {
                stdin: 'ignore',
                stdout: { maxBytes: spec.maxOutputBytes, spill: { maxBytes: spec.maxSpillBytes } },
                stderr: { maxBytes: spec.maxOutputBytes, spill: { maxBytes: spec.maxSpillBytes } },
            },
            graceMs: spec.graceMs,
            signal: controller.signal,
        })
    }
    catch (error) {
        return {
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: spec.bashPath,
            error: error instanceof Error ? error.message : String(error),
        }
    }
    const readers = { stdout: handle.collected?.stdout, stderr: handle.collected?.stderr }
    const offsets = { stdout: 0, stderr: 0 }
    const readDelta = (channel) => {
        const reader = readers[channel]
        if (reader === undefined || reader === null || typeof reader.readFrom !== 'function') return ''
        try {
            const chunk = reader.readFrom(offsets[channel])
            const text = typeof chunk?.text === 'string' ? chunk.text : ''
            offsets[channel] = Number.isFinite(chunk?.nextOffset) ? chunk.nextOffset : offsets[channel] + text.length
            return text
        }
        catch { return '' }
    }
    const readAll = (channel) => {
        const reader = readers[channel]
        if (reader === undefined || reader === null || typeof reader.readFrom !== 'function') return { text: '', truncated: false }
        try {
            const chunk = reader.readFrom(0)
            return {
                text: typeof chunk?.text === 'string' ? chunk.text : '',
                truncated: chunk?.lossy === true,
                ...(typeof chunk?.spillPath === 'string' ? { spillPath: chunk.spillPath } : {}),
            }
        }
        catch { return { text: '', truncated: false } }
    }
    const poll = typeof spec.onChunk === 'function'
        ? setInterval(() => {
            for (const channel of ['stdout', 'stderr']) {
                const text = readDelta(channel)
                if (text === '') continue
                try { spec.onChunk(channel, text) } catch { /* 订阅方问题不影响执行 */ }
            }
        }, 80)
        : null
    poll?.unref?.()
    let timedOut = false
    let promoted = false
    /** 把最后一个轮询周期之后到达的字节补交给订阅方（promoted/正常结束都要）。 */
    const flushChunks = () => {
        if (typeof spec.onChunk !== 'function') return
        for (const channel of ['stdout', 'stderr']) {
            const text = readDelta(channel)
            if (text === '') continue
            try { spec.onChunk(channel, text) } catch { /* 忽略 */ }
        }
    }
    const outcome = await new Promise((resolve) => {
        const timer = spec.noTimeout === true ? null : setTimeout(() => {
            if (spec.promoteOnTimeout === true) {
                promoted = true
                const stdout = readAll('stdout')
                const stderr = readAll('stderr')
                resolve({
                    promoted: true,
                    timeoutMs: spec.timeoutMs,
                    live: {
                        kill: () => abortNow('cancelled'),
                        // done 若 reject（提供方崩了），也要给出一个终态，否则 unhandled rejection 会冒到宿主。
                        done: handle.done.then((settled) => ({
                            status: settled?.exitCode === 0 ? 'completed' : 'failed',
                            exitCode: settled?.exitCode ?? null,
                            signal: settled?.signal ?? null,
                        })).catch((error) => ({ status: 'failed', detail: error instanceof Error ? error.message : String(error), exitCode: null, signal: null })),
                    },
                    partial: { stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated, ...(stdout.spillPath === undefined ? {} : { spillPath: stdout.spillPath }) },
                    diagnostics: { bashPath: spec.bashPath, cwd: spec.cwd, timeoutMs: spec.timeoutMs, graceMs: spec.graceMs, maxOutputBytes: spec.maxOutputBytes },
                })
                return
            }
            timedOut = true
            abortNow('timeout')
        }, spec.timeoutMs)
        handle.done.then((settled) => {
            if (timer !== null) clearTimeout(timer)
            flushChunks()
            if (poll !== null) clearInterval(poll)
            if (promoted) return
            const stdout = readAll('stdout')
            const stderr = readAll('stderr')
            const rawExitCode = settled?.exitCode ?? null
            const decodedSignal = settled?.signal === null || settled?.signal === undefined ? decodeWindowsSignal(rawExitCode) : null
            resolve({
                started: true,
                ok: rawExitCode === 0 && !timedOut && !controller.signal.aborted,
                exitCode: decodedSignal === null ? rawExitCode : null,
                signal: settled?.signal ?? decodedSignal ?? null,
                ...(decodedSignal === null ? {} : { rawExitCode }),
                stdout: stdout.text,
                stderr: stderr.text,
                truncated: stdout.truncated || stderr.truncated,
                ...(stdout.spillPath === undefined ? {} : { spillPath: stdout.spillPath }),
                timedOut,
                durationMs: Date.now() - spec.startedAt,
                bashPath: spec.bashPath,
                ...(controller.signal.aborted ? { error: timedOut ? 'timed out' : 'cancelled' } : {}),
                diagnostics: { bashPath: spec.bashPath, cwd: spec.cwd, timeoutMs: spec.timeoutMs, graceMs: spec.graceMs, maxOutputBytes: spec.maxOutputBytes },
            })
        }).catch((error) => {
            // 提供方在结算时抛错：同样要收尾定时器/轮询，并回一个结构化失败（否则 unhandled rejection 会打崩宿主）。
            if (timer !== null) clearTimeout(timer)
            if (poll !== null) clearInterval(poll)
            if (promoted) return
            const stdout = readAll('stdout')
            const stderr = readAll('stderr')
            resolve({
                ok: false, exitCode: null, signal: null,
                stdout: stdout.text, stderr: stderr.text,
                truncated: stdout.truncated || stderr.truncated,
                timedOut,
                durationMs: Date.now() - spec.startedAt,
                bashPath: spec.bashPath,
                error: `SPAWN_FAILED: 执行器结算失败（${error instanceof Error ? error.message : String(error)}）`,
                diagnostics: { bashPath: spec.bashPath, cwd: spec.cwd, timeoutMs: spec.timeoutMs, graceMs: spec.graceMs, maxOutputBytes: spec.maxOutputBytes },
            })
        })
    })
    return outcome
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
    if (r.failure !== undefined) parts.push(`[failure: ${r.failure.code}; effects: ${r.failure.effectState}; retry: ${r.failure.retry}]${r.failure.nextAction === undefined ? '' : ` ${r.failure.nextAction}`}`)
    if (r.aborted === true) parts.push('[aborted]')
    if (r.diagnostics !== undefined) parts.push(`diagnostics: cwd=${r.diagnostics.cwd}  timeoutMs=${r.diagnostics.timeoutMs}  graceMs=${r.diagnostics.graceMs}`)
    if (/^SANDBOX_UNAVAILABLE/.test(String(r.error ?? ''))) parts.push('[sandbox: unavailable — 命令未执行]')
    if (r.sandbox?.denied === true) parts.push(`[sandbox: file access denied under ${r.sandbox.mode} mode]`)
    if (r.sandbox?.runnerFailed === true) parts.push('[sandbox: runner failed before the command ran]')
    if (r.sandbox !== undefined && r.sandbox.mode && r.sandbox.denied !== true && r.sandbox.runnerFailed !== true) parts.push(`[sandbox: ${r.sandbox.mode}${r.sandbox.enforcement ? ` / ${r.sandbox.enforcement}` : ''}]`)
    // 宿主客户端按最后一行识别进程结局（terminal 卡片）；必须放在**最后**。
    if (typeof r.signal === 'string' && r.signal !== '') parts.push(`[killed by signal: ${r.signal}]`)
    else parts.push(`[exit code: ${r.exitCode === null || r.exitCode === undefined ? 'null' : r.exitCode}]`)
    return parts.join('\n')
}

/** 后台任务每路最多留多少（超出记 lost，host 会看到 lossy）。 */
const BACKGROUND_CAP_BYTES = 4 * 1024 * 1024

/** 输出落盘上限（照 ops）：超过就不再写，回执明确告知。 */
const MAX_SPILL_BYTES = 64 * 1024 * 1024

/** 还活着的任务：会话/agent 销毁时据此收尾（promoted 任务不随 tool call 结束）。 */
const LIVE_JOBS = []
function trackJob(entry) {
    LIVE_JOBS.push(entry)
    return () => {
        const index = LIVE_JOBS.indexOf(entry)
        if (index >= 0) LIVE_JOBS.splice(index, 1)
    }
}
export function disposeLiveJobs({ agentId, sessionId } = {}) {
    for (const entry of [...LIVE_JOBS]) {
        const matchAgent = agentId !== undefined && entry.agentId === agentId
        const matchSession = sessionId !== undefined && entry.sessionId === sessionId
        if (!matchAgent && !matchSession) continue
        try { entry.cancel() } catch { /* 已结束 */ }
        const index = LIVE_JOBS.indexOf(entry)
        if (index >= 0) LIVE_JOBS.splice(index, 1)
    }
}
/** 挂到宿主生命周期事件上：会话/agent 销毁时把还活着的 job 杀掉。 */
/**
 * 结算后把宿主 job 从列表里移除（宿主 `jobs.remove(id, caller)` 要求任务已终态）。
 * 刚 resolve 时宿主可能还没落终态 ⇒ 短轮询重试，避免"已结束"堆积（实测踩过：37 条残留）。
 */
export function dropJobWhenSettled(jobs, jobId, owner) {
    if (jobs === undefined || jobs === null || typeof jobs.remove !== 'function') return
    const attempt = (left) => {
        try { jobs.remove(jobId, owner) }
        catch { if (left > 0) setTimeout(() => attempt(left - 1), 50) }
    }
    attempt(40)
}

export function mountJobCleanup(ctx) {
    const offAgent = ctx.on('agent/disposed', ({ agent }) => disposeLiveJobs({ agentId: agent?.id }))
    const offSession = ctx.on('session/disposed', (session) => disposeLiveJobs({ sessionId: session?.id }))
    return () => {
        try { offAgent?.() } catch { /* 已释放 */ }
        try { offSession?.() } catch { /* 已释放 */ }
    }
}

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
export function failureOf({ ok, timedOut, error, exitCode, signal, sandbox, errorCode, started }) {
    if (ok === true && sandbox?.denied !== true) return undefined
    const text = String(error ?? '')
    // 参数级错误：命令**根本没起进程**，重试前必须先改参数（照 ops 的 INVALID_BASH_ARGUMENT）。
    if (errorCode === 'INVALID_BASH_ARGUMENT' || /^INVALID_BASH_ARGUMENT/.test(text)) {
        return { code: 'INVALID_BASH_ARGUMENT', message: text.slice(0, 300), effectState: 'none', retry: 'after-input-change', nextAction: '按提示改正参数后重试；本次未执行任何命令' }
    }
    // 起了进程才可能有副作用；没起来就一定是 none（比一律 unknown 更有用）。
    const effects = started === false ? 'none' : 'unknown'
    if (/^APPROVAL_/.test(text)) return { code: text.split(':')[0], message: text.slice(0, 300), effectState: 'none', retry: 'never', nextAction: '未执行任何命令；改用不越权的命令，或让操作员放宽会话策略' }
    if (/^AUTHORITY_CHANGED/.test(text)) return { code: 'AUTHORITY_CHANGED', message: text.slice(0, 300), effectState: 'none', retry: 'after-config-change', nextAction: '审批期间策略变了；确认当前策略后重试' }
    if (/^SANDBOX_UNAVAILABLE/.test(text)) return { code: 'SANDBOX_UNAVAILABLE', message: text.slice(0, 300), effectState: 'none', retry: 'after-config-change', nextAction: '修复沙箱服务或切到 danger-full-access 后重试' }
    if (/EXECUTOR_UNAVAILABLE/.test(text)) return { code: 'EXECUTOR_UNAVAILABLE', message: text.slice(0, 300), effectState: 'none', retry: 'after-config-change', nextAction: '安装/修复 bash 运行时或切到 danger-full-access' }
    if (/bash not found/i.test(text)) return { code: 'EXECUTOR_UNAVAILABLE', message: text.slice(0, 300), effectState: 'none', retry: 'after-config-change', nextAction: '安装 Git for Windows（工具集里有安装按钮）' }
    if (sandbox?.denied === true) return { code: 'SANDBOX_DENIED', message: 'sandbox denied file effects', effectState: 'unknown', retry: 'never', nextAction: '命令效果被沙箱拒绝；放宽策略或改路径' }
    if (/cancelled/i.test(text)) return { code: 'CANCELLED', message: text, effectState: 'unknown', retry: 'never' }
    if (timedOut === true) return { code: 'TIMEOUT', message: text === '' ? 'timeout' : text, effectState: effects, retry: 'after-input-change', nextAction: '增大 timeoutMs 或改用 background' }
    if (signal !== null && signal !== undefined) return { code: 'KILLED_BY_SIGNAL', message: `signal ${signal}`, effectState: effects, retry: 'never' }
    if (typeof exitCode === 'number' && exitCode !== 0) return { code: 'EXIT_NONZERO', message: `exit code ${exitCode}`, effectState: effects, retry: 'never' }
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
                description: { type: 'string', required: true, description: 'Required label shown in the UI.' },
                cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
                workdir: { type: 'string', description: 'Alias of cwd; cwd wins.' },
                timeoutMs: { type: 'integer', description: `Timeout in ms (default ${DEFAULTS.timeoutMs}, max ${DEFAULTS.maxTimeoutMs}).` },
                graceMs: { type: 'integer', description: `Grace before forced kill (default ${DEFAULTS.graceMs}).` },
                includeDiagnostics: { type: 'boolean', description: 'Include resolved cwd/timeout/grace.' },
                background: { type: 'boolean', description: 'Deprecated alias of run_in_background.' },
                run_in_background: { type: 'boolean', description: 'Run as a host background job; returns a jobId. No execution timeout unless timeoutMs is given.' },
                sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Request a wider sandbox mode for this call only; the host asks the user and nothing runs unless granted.' },
                justification: { type: 'string', description: 'Why the wider mode is needed; required with sandbox_permissions.' },
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
                // 宿主 subprocess 服务（#2）：有就走宿主托管，没有就退回自建 spawn。
                let hostSubprocess = options.subprocess
                if (hostSubprocess === undefined && typeof options.getCtx === 'function') {
                    try { hostSubprocess = options.getCtx()?.get?.('subprocess') } catch { hostSubprocess = undefined }
                }
                // 宿主管理的 DSH_* 环境（DSH_HOME / DSH_SHELL / DSH_SESSION_ID / DSH_PROFILE…）：
                // 照 ops 用 ctx.shellEnv.collect(exec)，让子命令能识别自己跑在 DSH 里。
                let dshEnv = {}
                if (typeof options.getCtx === 'function') {
                    try { dshEnv = options.getCtx()?.get?.('shellEnv')?.collect?.(exec) ?? {} } catch { dshEnv = {} }
                }
                // 逐次升级（照 ops）：先过审批，再决定要不要受限运行时；未批准就绝不执行。
                let policyOverride = null
                if (args?.sandbox_permissions !== undefined) {
                    if (typeof options.getCtx !== 'function') {
                        const error = 'APPROVAL_UNAVAILABLE: 没有宿主上下文，无法申请更宽的模式；未执行任何命令'
                        return renderResult({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 0, bashPath: findBash(), error, failure: failureOf({ ok: false, error }) })
                    }
                    try { policyOverride = await approveEscalation(options.getCtx(), args, exec) }
                    catch (thrown) {
                        const error = thrown instanceof Error ? thrown.message : String(thrown)
                        return renderResult({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 0, bashPath: findBash(), error, failure: failureOf({ ok: false, error }) })
                    }
                }
                // 沙箱闸门：非 danger-full-access 时必须拿到 confinement，否则拒绝执行。
                const sandboxPlatform = options.sandboxPlatform ?? process.platform
                const wantedMode = policyOverride?.mode ?? (typeof options.getCtx === 'function' ? resolveSandboxMode(options.getCtx(), exec) : null)
                let sandboxRuntime = null
                if (wantedMode !== null && wantedMode !== 'danger-full-access' && sandboxPlatform === 'win32') {
                    try { sandboxRuntime = typeof options.resolveConfinedBash === 'function' ? await options.resolveConfinedBash() : null }
                    catch { sandboxRuntime = null }
                    if (sandboxRuntime === null) {
                        const error = 'EXECUTOR_UNAVAILABLE: Windows 的受限模式需要一个受限运行时（dsh-ops 0.5+ 的 Niubash，或 0.4.x 的钉住 MSYS + IPC 补丁）；当前两者都不可用，系统 Git Bash 在沙箱里起不来。请安装/修复 dsh-ops，或切到 danger-full-access。命令未执行。'
                        return renderResult({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 0, bashPath: findBash(), error, failure: failureOf({ ok: false, error, exitCode: null, timedOut: false, signal: null }) })
                    }
                }
                const gate = typeof options.getCtx === 'function' ? createSandboxGate(options.getCtx(), { platform: sandboxPlatform, hasConfinedRuntime: sandboxRuntime !== null }) : null
                let decision
                const prepareArgv = gate === null ? undefined : async (argv, signal) => {
                    decision = await gate.prepareArgv(argv, exec, signal, policyOverride)
                    return decision.argv
                }

                // 后台任务：交给宿主的 jobs 服务（这样 job_output / job_kill 才认得这个 id）。
                if (args?.run_in_background === true || args?.background === true) {
                    const jobs = typeof options.getJobs === 'function' ? options.getJobs() : undefined
                    if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') {
                        return 'ok=false  kind=background\n后台任务不可用：宿主没有 jobs 服务（或尚未就绪）；去掉 background 同步执行'
                    }
                    const buffers = makeStreamBuffers()
                    const controller = new AbortController()
                    // 后台任务同样要能被宿主的"停止"打断（否则只能等 job_kill）。
                    if (exec?.signal !== undefined) {
                        if (exec.signal.aborted) controller.abort(new Error('cancelled'))
                        else exec.signal.addEventListener('abort', () => controller.abort(new Error('cancelled')), { once: true })
                    }
                    const label = (typeof args?.description === 'string' && args.description.trim() !== '')
                        ? args.description.trim()
                        : String(args?.command ?? args?.script_path ?? 'bash').slice(0, 80)
                    let untrackJob = null
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
                                    ...(args?.timeoutMs === undefined ? { noTimeout: true } : { timeoutMs: args.timeoutMs }),
                                    graceMs: args?.graceMs,
                                    signal: controller.signal,
                                    onChunk: (stream, chunk) => buffers.append(stream, chunk),
                                    ...(prepareArgv === undefined ? {} : { prepareArgv }),
                                    ...(sandboxRuntime === null ? {} : { bashPath: sandboxRuntime.file, pidDir: cwd }),
                                    ...(Object.keys({ ...(sandboxRuntime?.env ?? {}), ...dshEnv }).length === 0 ? {} : { env: { ...(sandboxRuntime?.env ?? {}), ...dshEnv } }),
                                    ...(hostSubprocess === undefined ? {} : { subprocess: hostSubprocess }),
                                }).then((result) => {
                                    const sandbox = gate?.classify({ decision, exitCode: result.exitCode, stderr: result.stderr, error: result.error })
                                    return {
                                        status: result.timedOut || controller.signal.aborted ? 'killed' : (result.ok ? 'completed' : 'failed'),
                                        detail: result.error ?? `exit code: ${result.exitCode ?? '?'}`,
                                        ...(sandbox === undefined ? {} : { sandbox }),
                                    }
                                }).catch((error) => ({ status: 'failed', detail: error instanceof Error ? error.message : String(error) }))
                                    .then((settled) => { untrackJob?.(); return settled }),
                                cancel: (reason) => controller.abort(new Error(reason === undefined ? 'cancelled' : String(reason))),
                            }),
                        })
                        untrackJob = trackJob({
                            agentId: exec?.agent?.id,
                            sessionId: exec?.agent?.session?.id,
                            cancel: (reason) => controller.abort(new Error(reason === undefined ? 'cancelled' : String(reason))),
                        })
                        return `ok=true  kind=background  jobId=${jobId}  label=${label}\n后台执行中：用 job_output（channel=stdout/stderr）读输出，job_kill 终止。`
                    }
                    catch (error) {
                        return `ok=false  kind=background\n后台任务启动失败：${error instanceof Error ? error.message : String(error)}`
                    }
                }

                const jobs = typeof options.getJobs === 'function' ? options.getJobs() : undefined
                const buffers = typeof jobs?.start === 'function' ? makeStreamBuffers() : null
                const controller = new AbortController()
                const label = (typeof args?.description === 'string' && args.description.trim() !== '')
                    ? args.description.trim()
                    : String(args?.command ?? args?.script_path ?? 'bash').slice(0, 80)
                // 前台也先登记成宿主 job：这样"正在运行命令"会出现在后台任务列表里，可以只停这一条而不结束会话。
                let jobId
                let settleJob = null
                let cancelLive = null
                let untrackJob = null
                if (buffers !== null) {
                    const jobDone = new Promise((resolveDone) => { settleJob = resolveDone })
                    try {
                        jobId = jobs.start({
                            kind: 'bash',
                            label,
                            ...(exec?.agent?.id === undefined ? {} : { owner: exec.agent.id }),
                            output: [buffers.reader('stdout'), buffers.reader('stderr')],
                            run: () => ({ done: jobDone, cancel: () => { try { cancelLive?.() } catch { /* 已退出 */ } controller.abort(new Error('cancelled')) } }),
                        })
                    }
                    catch {
                        jobId = undefined
                        settleJob = null
                    }
                    if (jobId !== undefined) {
                        untrackJob = trackJob({
                            agentId: exec?.agent?.id,
                            sessionId: exec?.agent?.session?.id,
                            cancel: () => { try { cancelLive?.() } catch { /* 已退出 */ } controller.abort(new Error('cancelled')) },
                        })
                    }
                }
                if (exec?.signal !== undefined) {
                    if (exec.signal.aborted) controller.abort(new Error('cancelled'))
                    else exec.signal.addEventListener('abort', () => controller.abort(new Error('cancelled')), { once: true })
                }
                let result
                try {
                    result = await runBash(String(args?.command ?? ''), {
                        cwd,
                        scriptPath,
                        timeoutMs: args?.timeoutMs,
                        graceMs: args?.graceMs,
                        ...(prepareArgv === undefined ? {} : { prepareArgv }),
                        ...(sandboxRuntime === null ? {} : { bashPath: sandboxRuntime.file, pidDir: cwd }),
                        ...(Object.keys({ ...(sandboxRuntime?.env ?? {}), ...dshEnv }).length === 0 ? {} : { env: { ...(sandboxRuntime?.env ?? {}), ...dshEnv } }),
                        ...(hostSubprocess === undefined ? {} : { subprocess: hostSubprocess }),
                        ...(buffers === null ? {} : { promoteOnTimeout: true, onChunk: (stream, chunk) => buffers.append(stream, chunk) }),
                        signal: controller.signal,
                    })
                }
                catch (thrown) {
                    // runBash 正常路径只 return；走到这里说明内部异常（例如宿主句柄 done 直接 reject）。
                    // 必须收尾已登记的 job，否则它会永远挂在「后台任务」里。
                    const error = `SPAWN_FAILED: 执行器内部异常（${thrown instanceof Error ? thrown.message : String(thrown)}）；命令状态未知，请先核对再重试`
                    if (settleJob !== null) settleJob({ status: 'failed', detail: error })
                    untrackJob?.()
                    if (jobId !== undefined) dropJobWhenSettled(jobs, jobId, exec?.agent?.id)
                    return renderResult({ ok: false, exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 0, bashPath: findBash(), error, failure: failureOf({ ok: false, error }) })
                }
                // 到点仍在跑 ⇒ 任务已经在 job 里，直接交给后台继续（不用杀、不用重跑）。
                if (result.promoted === true) {
                    if (jobId !== undefined && settleJob !== null) {
                        cancelLive = () => result.live.kill()
                        result.live.done.then((settled) => { settleJob(settled); untrackJob?.() })
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
                    try { result.live.kill() } catch { /* 已退出 */ }
                    return 'ok=false  kind=promoted\n晋升后台失败（已终止命令）：宿主 jobs 服务拒绝登记'
                }
                if (settleJob !== null) {
                    settleJob({
                        status: result.error === 'cancelled' ? 'killed' : (result.ok ? 'completed' : 'failed'),
                        detail: result.error ?? `exit code: ${result.exitCode ?? '?'}`,
                    })
                }
                untrackJob?.()
                // 正常结束的前台命令不留在"后台任务"列表里（照 ops：结算后移除，带 owner 并重试到终态）。
                if (jobId !== undefined) dropJobWhenSettled(jobs, jobId, exec?.agent?.id)
                const sandbox = gate?.classify({ decision, exitCode: result.exitCode, stderr: result.stderr, error: result.error })
                const failure = failureOf({ ok: result.ok, timedOut: result.timedOut, error: result.error, exitCode: result.exitCode, signal: result.signal, sandbox, errorCode: result.errorCode, started: result.started })
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

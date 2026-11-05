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
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export const DEFAULTS = Object.freeze({
    timeoutMs: 60_000,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 2 * 1024 * 1024,
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
export function runBash(command, options = {}) {
    const bash = findBash()
    if (bash === null) {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: null,
            error: 'bash not found: install Git for Windows (C:\\Program Files\\Git\\bin\\bash.exe) and reopen the host',
        })
    }
    if (typeof command !== 'string' || command.trim() === '') {
        return Promise.resolve({
            ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
            truncated: false, timedOut: false, durationMs: 0, bashPath: bash,
            error: 'command must be a non-empty string',
        })
    }

    const cwd = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd : process.cwd()
    const timeoutMs = clamp(options.timeoutMs, 1, DEFAULTS.maxTimeoutMs, DEFAULTS.timeoutMs)
    const maxOutputBytes = clamp(options.maxOutputBytes, 256, 64 * 1024 * 1024, DEFAULTS.maxOutputBytes)

    // ③ 父进程的 PWD 会让 `pwd` 说谎；④ 代码页会让中文乱码。
    const env = { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }
    delete env.PWD
    delete env.OLDPWD

    return new Promise((resolve) => {
        const startedAt = Date.now()
        let settled = false
        let out = ''
        let err = ''
        let outBytes = 0
        let errBytes = 0
        let truncated = false
        let timedOut = false
        // 每次调用一个 pgid 文件（见 WRAPPER 注释）；finish 时删掉，异常路径也不会留垃圾。
        const pidFile = join(tmpdir(), `dsh-toolkit-bash-${process.pid}-${startedAt}-${Math.random().toString(36).slice(2, 8)}.pgid`)

        // ① `-c`（不是 `-lc`）：快 2.5 倍，且 coreutils 本来就在 PATH 上。
        //    外层用 WRAPPER 记下 MSYS 进程组号，命令原样作为 `$2` 交给 eval（argv 直传，不经 cmd.exe）。
        const child = spawn(bash, ['-c', WRAPPER, 'bash', pidFile, command], {
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
                ...(payload.error === undefined ? {} : { error: payload.error }),
            })
        }

        /** 两路一起杀：先 MSYS 进程组（能抓到 taskkill 抓不到的 fork 子进程），再按树兜底。 */
        const killAll = () => {
            killProcessGroup(bash, pidFile)
            killTree(child.pid)
        }

        const timer = setTimeout(() => {
            timedOut = true
            killAll()
            // 树被杀后 'close' 通常会来；万一不来，2 s 后自己收尾，别让调用方一直挂着。
            setTimeout(() => finish({ exitCode: null, signal: 'SIGKILL' }), 2000)
        }, timeoutMs)

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            const bytes = Buffer.byteLength(chunk, 'utf8')
            if (outBytes + bytes > maxOutputBytes) { truncated = true; return }
            outBytes += bytes
            out += chunk
        })
        child.stderr.on('data', (chunk) => {
            const bytes = Buffer.byteLength(chunk, 'utf8')
            if (errBytes + bytes > maxOutputBytes) { truncated = true; return }
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
                if (timedOut) killAll() // 补一刀：退出瞬间又 fork 出来的也带走
                finish({ exitCode: code, signal })
            }, 100)
        })
        child.on('close', (code, signal) => finish({ exitCode: code, signal }))
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
    return parts.join('\n')
}

/** 工具定义（字段映射方言；`defineTool` 会翻译成宿主 schema）。 */
export function tools(defineTool, options = {}) {
    const workspace = typeof options.resolveWorkspaceCwd === 'function' ? options.resolveWorkspaceCwd : () => null
    return [
        defineTool({
            name: 'bash',
            description:
                'Run a bash command line (Git Bash on Windows) and get stdout/stderr separately with the exit code. ' +
                'Prefer bash over pwsh for POSIX text pipelines (grep/sed/awk/sort/uniq), globbing, and anything whose quoting ' +
                'would be mangled by PowerShell. On Windows the host pwsh tool is hidden while this family is on: run Windows-native ' +
                'work (services, registry, ACLs, scheduled tasks, WMI) as `powershell.exe -NoProfile -Command "..."` from here. ' +
                'Non-interactive: stdin is closed, so interactive prompts (read/sudo/ssh) hang until the timeout. ' +
                'On timeout the whole process tree is killed. Output is capped and flagged truncated. ' +
                'Fails loudly when bash is missing — it never downloads anything.',
            parameters: {
                command: { type: 'string', required: true, description: 'Bash command line. Runs as: bash -c "<command>".' },
                cwd: { type: 'string', description: 'Working directory (Windows or POSIX path). Defaults to the session workspace.' },
                timeoutMs: { type: 'integer', description: `Timeout in ms. Default ${DEFAULTS.timeoutMs}, max ${DEFAULTS.maxTimeoutMs}; on timeout the process tree is killed.` },
            },
            output: {
                schema: { type: 'string', description: 'Header (ok/exitCode/timedOut/truncated/duration/bash) + raw stdout + raw stderr.' },
                render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            async execute(args) {
                const cwd = typeof args?.cwd === 'string' && args.cwd.trim() !== ''
                    ? args.cwd
                    : (workspace() ?? undefined)
                const result = await runBash(String(args?.command ?? ''), {
                    cwd,
                    timeoutMs: args?.timeoutMs,
                })
                return renderResult(result)
            },
        }),
    ]
}

export function apply(ctx, defineTool, options = {}) {
    const list = tools(defineTool, options)
    for (const tool of list) ctx.tools.register(tool)
    return list.length
}

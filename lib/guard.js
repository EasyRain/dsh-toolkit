/**
 * 写操作的沙箱闸门 —— 让 `file` / `ast_edit` / `checkpoint restore` / `download` 也尊重宿主策略。
 *
 * 为什么需要：`bash` 会把整条 argv 过 `sandbox.confine`，所以被真正关在沙箱里；
 * 但插件里的写操作是**直接 `node:fs`**，宿主自己的 fs 围栏（`@deepseek-ai/dsh-fs-sandbox`）
 * 管不到插件代码 ⇒ 在 workspace-write 会话里它们能写到工作区之外（实测确实能）。
 *
 * 规则与宿主保持一致（`writableRoots(policy)`）：
 *   - `read-only`      ⇒ 任何写/删/移都拒；
 *   - `workspace-write` ⇒ 目标必须在 `workspaceRoot`、`additionalWritableRoots`、`/tmp`、`os.tmpdir()` 之内；
 *   - `danger-full-access` ⇒ 不拦。
 * 拿不到策略服务时**放行**（宿主没装/旧内核），但由调用方记一条信标——插件不能替宿主做权限判断。
 *
 * 拒绝时抛 `SandboxDeniedError`（`code = FS_SANDBOX_DENIED`），消息里带模型可读的
 * `[sandbox: file access denied under <mode> mode]` 标记。
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const FS_SANDBOX_DENIED = 'FS_SANDBOX_DENIED'

export class SandboxDeniedError extends Error {
    constructor(message, details = {}) {
        super(message)
        this.name = 'SandboxDeniedError'
        this.code = FS_SANDBOX_DENIED
        this.mode = details.mode ?? null
        this.target = details.target ?? null
    }
}

/** 规范化：能 realpath 就 realpath（跟随符号链接），否则按字面 resolve。 */
function canonical(path) {
    const text = String(path)
    const absolute = isAbsolute(text) ? text : resolve(text)
    try {
        return realpathSync.native(absolute)
    }
    catch {
        return absolute
    }
}

/**
 * 目标路径的规范形式：**父目录 realpath + 文件名**。
 *
 * 为什么不直接 realpath 整个路径：写入目标通常还不存在（新建文件），realpath 会失败退回字面路径，
 * 于是 `C:\Users\EASYRA~1\...`（8.3 短名）和 `C:\Users\Easy Rain\...`（长名）被当成两个地方，
 * 误判成"不在可写根内"。宿主自己的围栏也是先 resolve 目标再比。
 */
function canonicalTarget(path) {
    const absolute = isAbsolute(String(path)) ? String(path) : resolve(String(path))
    try {
        return join(canonical(dirname(absolute)), basename(absolute))
    }
    catch {
        return absolute
    }
}

/** 大小写不敏感平台上的比较键。 */
function key(path, { target = false } = {}) {
    const normalized = target ? canonicalTarget(path) : canonical(path)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 解析当前会话的文件策略；拿不到返回 null（= 由宿主兜底，我们放行）。 */
export function resolveFilePolicy(ctx, session) {
    try {
        const service = ctx?.get?.('sandboxPolicy')
        if (service === undefined || service === null || typeof service.resolve !== 'function') return null
        const policy = service.resolve(session === undefined ? undefined : { session })
        return policy !== null && typeof policy === 'object' && typeof policy.mode === 'string' ? policy : null
    }
    catch {
        return null
    }
}

/** 某个策略允许写的根（与宿主 `writableRoots()` 同口径）。 */
export function writableRoots(policy) {
    if (policy === null || policy === undefined || policy.mode !== 'workspace-write') return []
    const roots = []
    const push = (value) => {
        if (typeof value === 'string' && value !== '') roots.push(key(value))
        else if (value !== null && typeof value === 'object' && typeof value.path === 'string' && value.path !== '') roots.push(key(value.path))
    }
    push(policy.workspaceRoot)
    for (const extra of policy.additionalWritableRoots ?? []) push(extra)
    push('/tmp')
    push(tmpdir())
    return [...new Set(roots)]
}

/** target 是否在 root 之下（含 root 本身）。 */
export function isUnderPath(target, root) {
    const child = key(target, { target: true })
    const parent = root.endsWith(sep) ? root : `${root}${sep}`
    return child === root || child.startsWith(parent)
}

/**
 * 检查一批目标能否写。返回 `null` 表示放行，否则返回拒绝信息（不改状态、不抛错）。
 * @param {{policy: object|null, targets: string[]}} options
 */
export function inspectTargets({ policy, targets }) {
    if (policy === null || policy === undefined) return null
    if (policy.mode === 'danger-full-access') return null
    const list = (targets ?? []).filter((item) => typeof item === 'string' && item !== '')
    if (list.length === 0) return null
    if (policy.mode === 'read-only') {
        return { target: list[0], mode: 'read-only', message: '当前是 read-only 会话，任何写操作都被拒绝' }
    }
    const roots = writableRoots(policy)
    const outside = list.filter((target) => !roots.some((root) => isUnderPath(target, root)))
    if (outside.length === 0) return null
    return { target: outside[0], mode: policy.mode, message: `目标不在可写根内（工作区 ${policy.workspaceRoot ?? '?'} 及其附加目录）` }
}

/**
 * 断言这批目标可写；不允许就抛 `SandboxDeniedError`。
 * 错误消息统一成模型能直接读懂的一行 + 宿主同款标记。
 */
export function assertWritableTargets(ctx, targets, { session } = {}) {
    const policy = resolveFilePolicy(ctx, session)
    const denial = inspectTargets({ policy, targets })
    if (denial === null) return
    const marker = `[sandbox: file access denied under ${denial.mode} mode]`
    const error = new SandboxDeniedError(`${marker} 无法写入 "${denial.target}"：${denial.message}。命令未执行，也没有产生副作用。`, denial)
    throw error
}

/**
 * 只读会话里**写插件自己的仓库**也要拒：快照/留底/导出都落在 `$DSH_HOME` 或工作区内，
 * read-only 的语义是"这一轮不写任何东西"，快照也没法用（restore 同样被拒）。
 */
export function assertWritableStorage(ctx, session, what = '这个操作') {
    const policy = resolveFilePolicy(ctx, session)
    if (policy === null || policy === undefined) return
    if (policy.mode === 'read-only') {
        throw new SandboxDeniedError(`[sandbox: file access denied under read-only mode] ${what}需要写盘（快照仓库 / 留底），只读会话不允许。命令未执行，也没有产生副作用。`, { mode: 'read-only' })
    }
}

/** 把任意异常转成"带标记的一行"，供各族在 `ok=false` 回执里用。 */
export function describeDenial(error) {
    if (error instanceof SandboxDeniedError) return error.message
    return null
}

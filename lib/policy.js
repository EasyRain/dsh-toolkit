/**
 * 写盘授权词汇与判定（借鉴 T-Auto/dsh-ops 的 `lib/permissions.js`）。
 *
 * 它那条原则值得照抄：**`Model inputs never select an authority mode.`**
 * —— 工具参数可以用来**收窄**权限，绝不能用来**放大**权限；放大只能由运维方（用户/宿主环境）做。
 *
 * 背景（对照查出的我们自己的口子）：`checkpoint { action:"journal_restore", allowOutside:true }`
 * 以前只要模型显式传参就能把写盘范围扩到工作区之外 ⇒ 参数在选择权限模式 ✗。
 * 现在改为：**`allowOutside` 仍是必要条件，但不是充分条件** —— 还要运维方在宿主进程里开
 * `DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES=1`（模型无法设置宿主环境变量）。
 */
export const MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** 运维方开关：允许把 pre-image 写回**调用方工作区之外**。 */
export function outsideWritesAllowed() {
    return process.env.DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES === '1'
}

/**
 * 跨工作区写盘被拒时的**可执行**错误（结构化措辞，与 dsh-ops 的 `nextAction` 同风格）：
 * 说清"谁才能开、怎么开、别做什么"。
 */
export function outsideWritesRefusal(target, base) {
    return new Error(
        `拒绝写回工作区之外的文件：${target}（调用方工作区是 ${base}）。`
        + ' 跨工作区写盘只能由**运维方**开启：在宿主进程环境里设 DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES=1，然后重启宿主'
        + '（工具参数 `allowOutside` 无法开启它 —— 只用来在本开关已开时进一步收窄/确认）。'
        + ' 需要恢复工作区外的文件时，请让用户开这个开关，或把备份复制进工作区后再恢复。'
        + ' 不要为此改写工作区外的路径、也不要绕过校验。',
    )
}

/** 归一化任意来源的模式字符串；认不出来就返回 null（⇒ 调用方按"未知"处理，不据此放宽任何事）。 */
export function normalizeMode(value) {
    const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return MODES.includes(s) ? s : null
}

/**
 * 从服务对象上尽力读出当前模式（宿主形状未公开 ⇒ 多点探测）。
 * **只认字符串**：读不到就是 null —— 未知**绝不放宽**（保持既有行为），也绝不据此拒绝。
 */
export function modeOf(policy) {
    if (policy === null || policy === undefined) return null
    if (typeof policy === 'string') return normalizeMode(policy)
 // 实测（探针宿主信标）：服务暴露的键是 `[ctx, name, defaultMode, workspaceRoot]`
    // ⇒ `defaultMode` 是主要候选；其余是"换个宿主/版本也能认出来"的兜底。
    const probes = [
        policy.defaultMode, policy.mode, policy.current,
        policy.policy?.mode, policy.sandbox?.mode, policy.sandboxPolicy?.mode,
    ]
    for (const p of probes) {
        const m = normalizeMode(typeof p === 'function' ? safeCall(p, policy) : p)
        if (m !== null) return m
    }
    return null
}

function safeCall(fn, self) {
    try { return fn.call(self) }
    catch { return null }
}

// --- 会话策略的读取------------------------------------------------
// 宿主把权限放在 `sandboxPolicy` 服务里（`app.asar` 内有 `sandboxPolicy` 与 `sandbox/mode` 事件，
// 但**服务形状没有公开文档**）⇒ 这里只"尽力探测"：读得到就记住，读不到就是 null。
// 判定原则（照抄 dsh-ops）：**未知绝不放宽，也绝不据此拒绝** —— 收紧要基于确定的事实。

let cachedMode = null

/** 探测一个 sandboxPolicy 服务实例：返回 `{ mode, keys }`（keys 仅用于诊断/信标）。 */
export function probePolicyService(service) {
    if (service === null || service === undefined) return { mode: null, keys: [] }
    let keys = []
    try { keys = Object.keys(service).slice(0, 12) } catch { keys = [] }
    return { mode: modeOf(service), keys }
}

export function setCurrentMode(mode) {
    cachedMode = normalizeMode(mode)
    return cachedMode
}

export function currentMode() {
    return cachedMode
}

/** 只读会话里应拒绝写盘操作（读不到策略时返回 false ⇒ 保持既有行为，绝不误拦）。 */
export function isReadOnly() {
    return cachedMode === 'read-only'
}


/**
 * 受限模式下的"逐次升级"审批（照 dsh-ops 的 `sandbox_permissions` 语义）。
 *
 * 只有**比当前更宽**的请求才需要审批；审批通过前绝不执行命令；通过后还要复核策略没变
 * （`AUTHORITY_CHANGED`）—— 审批期间会话被降级就作废。
 *
 * 失败一律是"未执行任何命令"：APPROVAL_INVALID / APPROVAL_UNAVAILABLE / APPROVAL_<OUTCOME>。
 * 审批服务不可用时**不降级放行**，和宿主的策略保持一致。
 */
const RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

export const BASH_ESCALATION_MODES = Object.freeze(Object.keys(RANK))

export function validateEscalation(args, standing) {
    const target = args?.sandbox_permissions
    const reason = args?.justification
    if (target !== 'workspace-write' && target !== 'danger-full-access') {
        throw new Error('APPROVAL_INVALID: sandbox_permissions 只能是 workspace-write 或 danger-full-access；未执行任何命令')
    }
    const standingRank = RANK[standing.mode]
    // 当前模式不在可升级集合里（宿主加了新模式？）⇒ 无法判断宽窄，拒绝而不是静默放行。
    if (standingRank === undefined) {
        throw new Error(`APPROVAL_INVALID: 当前会话模式 ${standing.mode} 无法判断宽窄；未执行任何命令`)
    }
    if (target === standing.mode) {
        // 同模式不算升级，justification 可选（与 ops 一致：只在真正改变模式时要求理由）。
        if (reason !== undefined && typeof reason !== 'string') {
            throw new Error('APPROVAL_INVALID: justification 必须是字符串；未执行任何命令')
        }
        return
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
        throw new Error('APPROVAL_INVALID: 请求更宽的模式需要非空 justification；未执行任何命令')
    }
    if (RANK[target] < standingRank) {
        throw new Error(`APPROVAL_INVALID: 请求的 ${target} 比当前 ${standing.mode} 更窄；未执行任何命令`)
    }
}

/**
 * 返回这次调用应当使用的策略（`{...standing, mode}`）。
 * 不需要升级时原样返回；需要时走宿主 `approval.request`。
 */
export async function approveEscalation(ctx, args, exec = {}) {
    const service = (name) => { try { return ctx?.get?.(name) } catch { return undefined } }
    const policyService = service('sandboxPolicy')
    let standing
    try { standing = policyService?.resolve?.({ session: exec?.agent?.session }) }
    catch (error) { throw new Error(`SANDBOX_UNAVAILABLE: 读取沙箱策略失败（${error instanceof Error ? error.message : String(error)}）；未执行任何命令`) }
    if (standing === undefined || standing === null || typeof standing.mode !== 'string') {
        throw new Error('SANDBOX_UNAVAILABLE: 拿不到当前会话的沙箱策略；未执行任何命令')
    }
    const target = args?.sandbox_permissions
    if (target === undefined) return standing
    validateEscalation(args, standing)
    if (target === standing.mode) return standing
    const approval = service('approval')
    if (exec?.agent === undefined || typeof approval?.request !== 'function') {
        throw new Error('APPROVAL_UNAVAILABLE: 审批服务不可用；未执行任何命令，不要绕过会话策略')
    }
    const outcome = await approval.request({
        agent: exec.agent,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        toolName: 'bash',
        reason: String(args.justification),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
    if (outcome !== 'allowed-once') {
        throw new Error(`APPROVAL_${String(outcome).toUpperCase().replaceAll('-', '_')}: 未获批准；未执行任何命令`)
    }
    // 审批期间调用被取消：转成我们自己的错误码，别把 DOMException 漏给上层（会被归类成 SPAWN_FAILED）。
    try { exec?.signal?.throwIfAborted?.() }
    catch { throw new Error('CANCELLED: 审批期间调用被取消；未执行任何命令') }
    let current
    try { current = policyService?.resolve?.({ session: exec.agent.session }) }
    catch { current = undefined }
    if (current?.mode !== standing.mode || current?.workspaceRoot !== standing.workspaceRoot) {
        throw new Error('AUTHORITY_CHANGED: 审批期间会话策略发生了变化；未执行任何命令')
    }
    return { ...standing, mode: target }
}

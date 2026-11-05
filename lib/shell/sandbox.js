/**
 * 沙箱闸门 —— 让 `bash` 尊重宿主的 `sandboxPolicy`，而不是"直接给通过"。
 *
 * 为什么必须有：dsh-ops 的 bash 是走宿主的 `sandboxPolicy` + `sandbox.confine` + `subprocess` 的；
 * 我们这个执行器直接 `child_process` 起进程。**不给它加闸门，在 workspace-write 会话里它就是一个
 * 绕过沙箱的后门**（而 danger-full-access 用户无感）。所以这里照 ops 的语义补齐，并且**失败即拒绝**：
 * 只要策略不是 `danger-full-access`，拿不到 `sandbox.confine` 就绝不起进程。
 *
 * 与 ops 的差异：ops 在受限模式下还会换用它们的 confined Bash 运行时（IPC 包装）；
 * 我们直接把**整条 argv** 交给 `sandbox.confine` 包一层，不依赖那条运行时。
 */
const message = (error) => (error instanceof Error ? error.message : String(error))

export function createSandboxGate(ctx) {
    const service = (name) => {
        try { return ctx?.get?.(name) }
        catch { return undefined }
    }

    const policyFor = (exec) => {
        const policyService = service('sandboxPolicy')
        if (policyService === undefined || policyService === null || typeof policyService.resolve !== 'function') return { available: false }
        let policy
        try { policy = policyService.resolve({ session: exec?.agent?.session }) }
        catch (error) { return { available: true, error: message(error) } }
        if (policy === undefined || policy === null || typeof policy.mode !== 'string') return { available: true, error: 'sandboxPolicy.resolve() 没有给出策略' }
        return { available: true, policy }
    }

    return {
        /**
         * 返回 `{ argv, mode, confinement }`；受限模式下拿不到有效 confinement 就**抛错**（不起进程）。
         */
        async prepareArgv(argv, exec, signal) {
            const { available, policy, error } = policyFor(exec)
            // 宿主**有**沙箱体系但这次拿不到策略服务：按"不可验证"处理 ⇒ 拒绝执行。
            // （独立调用/测试不会走到这里：gate 只在宿主上下文里创建。）
            if (!available) throw new Error('SANDBOX_UNAVAILABLE: sandboxPolicy 服务不可用，无法确认沙箱策略；未执行任何命令')
            if (error !== undefined) throw new Error(`SANDBOX_UNAVAILABLE: ${error}；未执行任何命令`)
            if (policy.mode === 'danger-full-access') return { argv, mode: policy.mode, confinement: null }
            const session = exec?.agent?.session
            if (session === undefined || session === null) {
                throw new Error(`SANDBOX_UNAVAILABLE: ${policy.mode} 模式需要会话身份，但这次调用没有拿到；未执行任何命令`)
            }
            const sandbox = service('sandbox')
            if (sandbox === undefined || sandbox === null || typeof sandbox.confine !== 'function') {
                throw new Error(`SANDBOX_UNAVAILABLE: ${policy.mode} 模式下 sandbox.confine 不可用；未执行任何命令`)
            }
            let confinement
            try { confinement = await sandbox.confine(argv, policy, signal) }
            catch (thrown) { throw new Error(`SANDBOX_UNAVAILABLE: ${message(thrown)}；未执行任何命令`) }
            if (confinement === undefined || confinement === null
                || !Array.isArray(confinement.argv) || confinement.argv.length === 0
                || !['full', 'partial'].includes(confinement.enforcement)) {
                throw new Error('SANDBOX_UNAVAILABLE: sandbox.confine 返回了无效结果；未执行任何命令')
            }
            return { argv: confinement.argv, mode: policy.mode, confinement }
        },

        /** 从退出码 + stderr 里判断"被沙箱拒绝"还是"沙箱自己坏了"（照 ops 的签名匹配）。 */
        classify({ decision, exitCode, stderr, error }) {
            if (decision === undefined || decision === null || decision.mode === null) return undefined
            const confinement = decision.confinement
            const text = `${stderr ?? ''}\n${error ?? ''}`.toLowerCase()
            const runnerFailed = confinement !== null && Array.isArray(confinement?.runnerFailureRules)
                ? confinement.runnerFailureRules.some((rule) => {
                    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) return false
                    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !(rule.informationalLines ?? []).some((info) => String(info).toLowerCase() === line))
                    return lines.some((line) => (rule.fatalSignatures ?? []).some((signature) => line.includes(String(signature).toLowerCase())))
                })
                : false
            const denied = !runnerFailed && exitCode !== 0 && Array.isArray(confinement?.denialSignatures)
                ? confinement.denialSignatures.some((signature) => text.includes(String(signature).toLowerCase()))
                : false
            return {
                mode: decision.mode,
                denied,
                ...(confinement === null ? {} : { enforcement: confinement.enforcement }),
                ...(runnerFailed ? { runnerFailed: true } : {}),
            }
        },
    }
}

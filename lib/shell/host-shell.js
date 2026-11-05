/**
 * 宿主自带 shell 工具的隐藏（照 dsh-ops 的 "shell replacement" 做法）。
 *
 * 为什么：Windows 上宿主默认发布 `pwsh` / `pwsh_persistent`。有了 `bash` 之后这两个
 * 既占常驻 schema 的 token，又让模型在两个 shell 之间犹豫。ops 的做法是**按会话
 * `tools.restrict({ deny: [...] })`**：只隐藏、不卸载，插件卸载/会话销毁时自动还原。
 *
 * 三条保守约定：
 *  - **只在 win32 做**：POSIX 上宿主本来就只有 bash，没有可隐藏的；
 *  - **只在 bash 真的可用时才隐藏**：没装 bash 还藏 pwsh ⇒ 会话没有任何 shell（灾难）；
 *  - **只隐藏这两个名字**：不碰其它工具，也不去猜宿主将来会发布什么。
 */
export const HOST_SHELL_NAMES = Object.freeze(['pwsh', 'pwsh_persistent'])

const message = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 挂上"隐藏宿主 shell"的监听。返回 `{ mounted, reason }`；失败只记日志，不抛。
 *
 * 生命周期照 ops：`agent/created` 时给新会话加 deny，`agent/disposed` 时撤销，
 * 插件卸载时（`ctx.effect` 的清理）把还活着的全部撤销。
 */
export function mountHostShellHiding(ctx, log = () => {}, platform = process.platform) {
    if (platform !== 'win32') return { mounted: false, reason: 'posix' }
    let stopped = false
    const entries = new Map()
    const hide = (agent) => {
        if (stopped || agent === undefined || agent === null || entries.has(agent)) return
        try {
            // ops 直接用 `agent.ctx.tools`；有的内核/作用域只给 `get('tools')` —— 两种都试。
            const tools = agent.ctx?.tools ?? agent.ctx?.get?.('tools')
            if (tools === undefined || typeof tools.restrict !== 'function') {
                log('host-shell hiding skipped: tools.restrict 不可用')
                return
            }
            // 只 deny 当前真的存在的名字（宿主可能没发布 pwsh_persistent）。
            const names = HOST_SHELL_NAMES.filter((name) => {
                try { return typeof tools.get !== 'function' || tools.get(name, agent) !== undefined }
                catch { return true }
            })
            if (names.length === 0) return
            entries.set(agent, tools.restrict({ deny: names }))
            log(`host-shell hidden: ${names.join(', ')}`)
        }
        catch (error) {
            log(`host-shell hiding failed: ${message(error)}`)
        }
    }
    const show = (agent) => {
        const dispose = entries.get(agent)
        if (dispose === undefined) return
        entries.delete(agent)
        try { dispose() }
        catch (error) { log(`host-shell restore failed: ${message(error)}`) }
    }
    try {
        ctx.inject(['tools'], (scope) => {
            try {
                for (const agent of scope.get('agents')?.list?.() ?? []) hide(agent)
            }
            catch { /* 没有 agents 服务就算了 */ }
            try { scope.on?.('agent/created', ({ agent }) => hide(agent)) }
            catch { /* 老内核没有这个事件 */ }
            try { scope.on?.('agent/disposed', ({ agent }) => show(agent)) }
            catch { /* 同上 */ }
            try {
                scope.effect?.(() => () => {
                    stopped = true
                    for (const agent of [...entries.keys()]) show(agent)
                }, 'dsh-toolkit: host shell hiding')
            }
            catch (error) { log(`host-shell effect 注册失败: ${message(error)}`) }
        })
        return { mounted: true }
    }
    catch (error) {
        log(`host-shell mount failed: ${message(error)}`)
        return { mounted: false, reason: message(error) }
    }
}

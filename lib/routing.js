/**
 * 由**活的工具注册表**生成的紧凑路由段（借鉴 T-Auto/dsh-ops 的 `renderToolingPolicy`）。
 *
 * 为什么"生成"而不是手写一段说明：
 *  ① 手写的会漂移 —— 我们踩过：工具合并/改名后，文案里还留着旧工具名（`download_status` 之类）✗；
 *  ② 工作区级的 `AGENTS.md` 覆盖不到别的工作区，而这段是**插件自带**的；
 *  ③ 只广告**确实挂载**的工具：某个家族没挂上（依赖缺失/未启用），对应行自动消失，绝不广告不存在的工具。
 *
 * 代价：常驻成本（每个会话每轮都付）。所以这里只有 4 行、并按需指向 `toolkit_help`。
 */
const LINES = [
    {
        tools: ['table_diff', 'table_peek'],
        text: '比表/词表/配置/导出数据 → `table_diff`（先用 `table_peek` 看它被读成什么）；同一文件按列比对：`valueFieldA/B`；翻译场景加 `normalize`',
    },
    {
        tools: ['ast_edit'],
        text: '改名 / 全局文本替换 → `ast_edit {mode:"literal"}`（AST pattern 命中不到 `X.foo()`、`X::m` 限定用法；预览会报「命中 N / 全文出现 M」，残留默认拒绝）',
    },
    {
        tools: ['session_read', 'session_diff', 'session_export', 'checkpoint'],
        text: '翻历史会话 → `session_read`（给 `pattern` 过滤）/ `session_diff`；快照与回滚 → `checkpoint {action:…}`',
    },
    {
        tools: ['download'],
        text: '下载 → `download {action:"probe"|"start"|"status"|"cancel"}`（先 probe 再决定线程）',
    },
]

/**
 * @param {string[]} published 当前实际挂载的工具名
 * @returns {string} markdown 片段；一个相关工具都没挂载时返回 `''`（整段消失，不留空标题）
 */
export function renderRouting(published) {
    const names = new Set(Array.isArray(published) ? published : [])
    const rows = LINES.filter((row) => row.tools.some((t) => names.has(t))).map((row) => `- ${row.text}`)
    if (rows.length === 0) return ''
    const help = names.has('toolkit_help') ? '（细节/踩坑：`toolkit_help {topic}`）' : ''
    return ['## dsh-toolkit', ...rows, help ? `- ${help.slice(1)}` : ''].filter(Boolean).join('\n')
}

/**
 * **服务晚一步才就绪时的可重试注册**。
 *
 * 为什么需要（实测）：`ctx.inject(['systemPrompt'], cb)` 的回调在启动早期就会跑，
 * 那时服务对象**在**、但 `section()` 还没挂上 —— 同一台机器上有的 boot 记 `routing section registered`、
 * 有的 boot 记 `systemPrompt.section unavailable; routing section skipped`。一次性判断的后果是
 * **整个会话都少掉路由段**，而那段正是"这工具能用在哪"的显式说明（可发现性，不是装饰）。
 *
 * 语义：立刻试一次 → 失败按 `delays` 重试 → 成功即停；全失败才 `onGiveUp(次数)` 报一次。
 * `attempt` 抛异常按失败处理（服务形状没就绪就是"还不该成功"，不该炸掉整个 apply）。
 * 定时器默认 `unref()`：不阻止进程退出（无头运行里没等到也不算错）。
 *
 * @param {(attempt:number)=>boolean} attempt 返回 `true` = 成功，不再重试
 * @param {object} [options]
 * @param {number[]} [options.delays] 重试延时（ms），长度即重试次数；空 = 只试一次
 * @param {(ms:number, run:()=>void)=>void} [options.schedule] 注入调度器（自测用，免真等待）
 * @param {(attempts:number)=>void} [options.onGiveUp]
 * @returns {{attempts:()=>number, settled:()=>boolean}} 便于观测/断言
 */
export function retryRegister(attempt, { delays = [], schedule, onGiveUp } = {}) {
    let attempts = 0
    let settled = false
    const tick = () => {
        if (settled) return
        attempts += 1
        let ok = false
        try { ok = attempt(attempts) === true }
        catch { ok = false }
        if (ok) { settled = true; return }
        if (attempts > delays.length) {
            settled = true
            try { onGiveUp?.(attempts) } catch { /* 报告失败不影响其它段 */ }
            return
        }
        const wait = delays[attempts - 1]
        if (typeof schedule === 'function') { schedule(wait, tick); return }
        const timer = setTimeout(tick, wait)
        if (typeof timer?.unref === 'function') timer.unref()
    }
    tick()
    return { attempts: () => attempts, settled: () => settled }
}

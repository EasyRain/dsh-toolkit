/**
 * 插件配置的归一化与家族级开关。
 *
 * 宿主作者指引：*"Put tunable values in the plugin's `Config` so users change them in
 * `cordis.patch.yml`; the user's patch layer survives upgrades."* —— 配置从 profile patch 行的
 * `config:` 传进来，**改配置免重启**（宿主对 profile 配置是热生效的，见 SKILL.md:225）。
 *
 * 这里只做两件事：
 *  ① 归一化（默认全开、只认显式 `false`）；
 *  ② **家族级开关**：在 `defineTool` 的唯一收口处按工具名判族丢注册 ——
 *     这样"不要 AST"的会话可以省下约 7.7 KB 常驻 schema，而不必给 6 个段各写一遍判断。
 */
export const FAMILIES = Object.freeze(['ast', 'session', 'checkpoint', 'table', 'download', 'shell', 'file', 'help'])

const FAMILY_OF = Object.freeze({
    ast_search: 'ast', ast_dump_tree: 'ast', ast_test_rule: 'ast', ast_edit: 'ast',
    session_list: 'session', session_read: 'session', session_diff: 'session', session_export: 'session',
    checkpoint: 'checkpoint',
    table_diff: 'table', table_peek: 'table',
    download: 'download',
    bash: 'shell',
    file: 'file',
    toolkit_help: 'help',
})

export const familyOfTool = (name) => FAMILY_OF[String(name)] ?? 'other'

/**
 * @param {object} options profile patch 行的 `config`（入口 `apply(ctx, options)` 的第二参数）
 * 例：`config: { families: { ast: false }, checkpoint: { root: "/path/to/ck" }, astEdit: { maxFiles: 50 } }`
 */
export function normalizeConfig(options = {}) {
    const families = {}
    for (const f of FAMILIES) families[f] = options?.families?.[f] !== false // 只认显式 false
 // `help` **常开**（用户要求）：它是 agent 唯一能问出"哪些族启用 / 怎么开"的入口，
    // 关掉它就再也问不出来了 —— 所以它不进设置表单，也不受配置影响。
    families.help = true
    const root = options?.checkpoint?.root
    return {
        families,
        checkpointRoot: typeof root === 'string' && root.trim() !== '' ? root.trim() : null,
        astEdit: {
            maxFiles: options?.astEdit?.maxFiles,
            maxRenderChanges: options?.astEdit?.maxRenderChanges,
        },
        /** 被配置关掉的工具名（信标/诊断用） */
        disabled: [],
    }
}

/**
 * 把 `defineTool` 包一层家族闸门。**返回被丢弃的 def 本身**（各段只用它做命名/计数，不会因此报错）。
 */
export function gateDefineTool(inner, config, onSkip) {
    return (def) => {
        const name = String(def?.name ?? '')
        const family = familyOfTool(name)
        if (config.families[family] === false) {
            config.disabled.push(name)
            try { onSkip?.(name, family) }
            catch { /* 诊断失败不影响注册 */ }
            return def
        }
        return inner(def)
    }
}

/** 供信标/`toolkit_help` 用的一句话摘要。 */
export function describeConfig(config) {
    const off = FAMILIES.filter((f) => config.families[f] === false)
    const bits = [`families=${off.length === 0 ? 'all' : `-${off.join(',-')}`}`]
    if (config.checkpointRoot !== null) bits.push(`checkpoint.root=${config.checkpointRoot}`)
    if (config.astEdit.maxFiles !== undefined) bits.push(`astEdit.maxFiles=${config.astEdit.maxFiles}`)
    return bits.join(' ')
}

// ── 生效配置的共享只读视图─────────────────────────────────────────
// 为什么需要它：`lib/search.js` 的注册路径是 `ctx.tools.register(defineTool(def))` —— 它**直接调
// `ctx.tools.register`**，所以"只在 defineTool 收口处丢注册"对它无效 ✗（实测：被关的 ast_search
// 仍以**字段映射方言**被注册 ⇒ 宿主整个请求 INVALID_REQUEST ✗）。让该段自查这个视图，
// 比"改 6 个段"更小，也比"包住宿主的 tools.register"更安全（作者资料明确要求**不要 mutate 共享注册表** ✗）。
let activeConfig = null

export function setActiveConfig(config) {
    activeConfig = config ?? null
    return activeConfig
}

/** 没设置过配置（自测/裸用）时一律视为**开启** —— 绝不因为"没读到配置"而少注册工具。 */
export function familyEnabled(family) {
    if (activeConfig === null) return true
    return activeConfig.families?.[family] !== false
}

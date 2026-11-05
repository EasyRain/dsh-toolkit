/**
 * dsh-toolkit 的插件设置 schema（从 dsh 源码实证得来）。
 *
 * 为什么要有它：DSH 的"插件设置"表单**只投影 `.volatile()` 字段**
 *   - `packages/settings/settings/README.md`：「Forms expose only volatile fields from active,
 *     uniquely addressed profile entries. Ordinary configuration remains editable through Cordis
 *     configuration files.」
 *   - 表单命名空间 = **profile 条目的 id**（本插件即 patch 行的 `id`）。
 *   - 消费者读值用 **`config.<字段>.get()`**（`docs/subsystems/settings.md`、cookbook
 *     `adding-a-settings-card`），改值后宿主向该 fiber 发 **`loader/volatile-update`**；
 *     只有"普通字段"变化才 remount 条目。
 *
 * 所以：**家族开关必须是 volatile 布尔字段**，才能出现在设置页里并且可热改。
 *
 * ⚠️ 这里全程 try/catch：`@deepseek-ai/schemastery` 解析不到时**导出 undefined**，
 * 与"本插件从来没有 Config"完全等价（宿主 schema 缺失即不校验），绝不让入口加载失败
 * —— 那个"整段消失"的教训（见 lib/index.js 顶部注释）。
 */

/** 家族开关的展示顺序 + 文案（浏览器半 lib/client.js 里有一份键名的副本，两处必须一致）。 */
export const FAMILY_TOGGLES = Object.freeze([
    { key: 'ast', zh: 'AST 结构检索与改写', en: 'AST search & edit', zhHint: 'ast_search / ast_dump_tree / ast_test_rule / ast_edit（4 个）', enHint: 'ast_search / ast_dump_tree / ast_test_rule / ast_edit (5)' },
    { key: 'table', zh: '表对比', en: 'Table diff', zhHint: 'table_diff / table_peek（任意表格式，哈希连接 O(N+M)）', enHint: 'table_diff / table_peek (hash join O(N+M))' },
    { key: 'session', zh: '会话日志', en: 'Session logs', zhHint: 'session_list / session_read / session_diff / session_export（4 个）', enHint: 'session_list / session_read / session_diff / session_export (4)' },
    { key: 'checkpoint', zh: '快照与回滚', en: 'Checkpoint & rewind', zhHint: 'checkpoint（7 个动作）+ /checkpoint、/rewind 命令', enHint: 'checkpoint (7 actions) + /checkpoint, /rewind' },
    { key: 'download', zh: '下载器', en: 'Downloader', zhHint: 'download（start / probe / status / cancel）多线程 + 断点续传', enHint: 'download (start / probe / status / cancel), multi-thread + resume' },
    { key: 'shell', zh: 'Bash 执行器', en: 'Bash shell', zhHint: 'bash（Git Bash：POSIX 管道/引号，超时杀整棵进程树）', enHint: 'bash (Git Bash: POSIX pipelines/quoting; kills the process tree on timeout)' },
    { key: 'file', zh: '文件读写', en: 'File access', zhHint: 'file（read/stat/write/edit/copy/move/remove/mkdir；编码探测 + revision CAS）', enHint: 'file (read/stat/write/edit/copy/move/remove/mkdir; encoding probe + revision CAS)' },
])

let schema
try {
    const mod = await import('@deepseek-ai/schemastery')
    const z = mod?.default ?? mod
    if (typeof z?.object === 'function' && typeof z?.boolean === 'function') {
        const shape = {}
        for (const item of FAMILY_TOGGLES) {
            const field = z.boolean().default(false)
            // 老版本 schemastery 没有 `.volatile()` ⇒ 退回普通字段（设置页不显示，但配置照旧生效）
            shape[item.key] = typeof field.volatile === 'function' ? field.volatile() : field
        }
        schema = z.object(shape)
    }
}
catch {
    schema = undefined
}

/** 导出的 `Config`：宿主用它的 Standard Schema 面校验条目配置，并从同一份 schema 生成设置表单。 */
export const ConfigSchema = schema

export const configSchemaKind = schema === undefined ? 'none' : 'schemastery'

/**
 * 把 volatile 引用读成普通布尔（`apply` 收到的是 `Volatile<boolean>`，不是 boolean）。
 * 只返回**配置里确实出现过的键**，未出现的留给旧的 `families: {...}` 与默认值。
 */
export function readFamilyToggles(options = {}) {
    const out = {}
    for (const item of FAMILY_TOGGLES) {
        const raw = options?.[item.key]
        if (raw === undefined) continue
        const value = raw !== null && typeof raw.get === 'function' ? raw.get() : raw
        out[item.key] = value !== false
    }
    return out
}

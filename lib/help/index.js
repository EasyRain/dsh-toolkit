/**
 * toolkit_help —— 按需取回本插件的使用说明与"踩坑清单"。
 *
 * 为什么要有这个工具：工具 schema 会进**每个**会话的常驻上下文（20 个工具 ≈ 4.5k tokens），
 * 而"怎么选、怎么解读输出、有哪些坑"这类内容只对**正在用**它的人有价值。放这里 ⇒ 常驻成本≈0，
 * 需要时一次调用取回。
 *
 * 三条经验（都是踩过的）：
 *  1. 文档**必须懒加载**：`ast_grep_help` 当年在模块导入期 readFileSync，文档一旦缺失会让整个插件 import 失败
 *     （20 个工具全没）。这里缺文件只降级成一句提示。
 *  2. 主题→小节用文档里的 `## ` 标题映射；标题漂移时**退化返回全文 + 提示**，不要抛。
 *  3. 缓存**必须按 mtime 失效**（见 `lib/doc-cache.js`）：否则改了文档工具还返回旧内容，
 *     且首次读失败会被缓存一辈子。
 */
import { createDocLoader } from '../doc-cache.js'
// `ast_grep_help` 并入本工具 —— 主题表来自**零依赖**的 lib/ast/help-topics.js
// （刻意不 import search.js：那边顶层 import @ast-grep/napi，会把"缺依赖就隔离 AST 族"的性质废掉）
import { HELP_SOURCE, HELP_TOPICS } from '../ast/help-topics.js'
// 家族开关的**活**状态（`lib/configure.js` 的共享只读视图）—— toolkit_help 每次都要报出来。
import { FAMILIES, familyEnabled } from '../configure.js'

export const name = 'dsh-toolkit-help'
export const inject = ['tools']

const DOC_URL = new URL('../../docs/TOOLKIT.md', import.meta.url) // lib/help/ → 上两级才是包根

/** 主题 → 文档小节标题（`## ` 或 `### ` 级；`section()` 两种都支持） */
const TOPICS = Object.freeze({
    overview: ['## overview'],
    'table-diff': ['## table-diff'],
    shell: ['## shell'],
    file: ['## file'],
    checkpoint: ['## checkpoint'],
    session: ['## session'],
    ast: ['## ast'],
 // 上游 ast-grep 规则指南，并入本文件（ast_grep_help 取同一节，但按更细的小节切）
    'ast-rules': ['## ast-rules'],
    gotchas: ['## gotchas'],
 // 并入的细粒度规则主题（原 ast_grep_help）：小节是 `### ` 级
    ...HELP_TOPICS,
    full: [],
})

/** 哪些主题来自上游 ast-grep 指南（回显出处用；MIT 合规） */
const UPSTREAM_TOPICS = new Set([...Object.keys(HELP_TOPICS), 'ast-rules'])

const FALLBACK = [
    '# dsh-toolkit 帮助文档缺失',
    '',
    '`docs/TOOLKIT.md` 读不到（安装副本可能没同步 docs 目录）。插件其余工具不受影响。',
    '要点速记：',
    '- 比两张表用 `table_diff`（先 `table_peek` 看它被读成了什么）；一侧 0 数据时输出**首行**是 `⚠⚠`，底部写"无法比较"，**不是**"没有差异"。',
    '- 相对路径与 glob 的基准 = **调用方会话工作区**。',
    '- `checkpoint_restore` 必须 `confirm: true` 才写盘；跨工作区用 `pruneExtra` 会被拒绝。',
    '- `ast_edit` 的 `paths` 必填，流程 preview → 确认目标文件数 → apply。',
].join('\n')

// 文档加载器：懒加载 + 按 mtime 失效（改了 docs 立刻生效；首次读失败也能在文件补上后恢复）
const docLoader = createDocLoader(DOC_URL)
function helpDoc() {
    return docLoader.load()
}

/** 取 `## <heading>` 到下一个同级/更高级标题之间的内容；找不到返回 null（不抛）。 */
export function section(markdown, heading) {
    const lines = String(markdown).split(/\r?\n/)
    const start = lines.indexOf(heading)
    if (start < 0) return null
    const level = (heading.match(/^#+/) ?? ['#'])[0].length
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
        const m = lines[i].match(/^(#+) /)
        if (m && m[1].length <= level) { end = i; break }
    }
    return lines.slice(start, end).join('\n').trim()
}

/** 纯函数：给定文档文本与主题 → 结果对象（便于自测，不依赖磁盘）。 */
export function helpFrom(docText, topic = 'overview') {
    const key = String(topic ?? 'overview')
    if (!(key in TOPICS)) throw new Error(`unsupported help topic ${JSON.stringify(key)}；可用：${Object.keys(TOPICS).join(', ')}`)
    if (!docText) return { topic: key, degraded: true, text: FALLBACK }
    if (key === 'full') return { topic: key, degraded: false, text: String(docText).trim() }
    const wanted = TOPICS[key]
    const parts = wanted.map((h) => section(docText, h))
    const missing = wanted.filter((_, i) => parts[i] === null)
    if (missing.length > 0) {
        return {
            topic: key,
            degraded: true,
            text: `${String(docText).trim()}\n\n---\n(注意：请求的小节在文档里找不到：${missing.join(' / ')} —— 已返回全文；说明 docs/TOOLKIT.md 可能已改版，需要更新 TOPICS 映射)`,
        }
    }
    return { topic: key, degraded: false, text: parts.join('\n\n') }
}

/** 家族启用状态：toolkit_help 是 agent 唯一能问出"哪些族开着"的地方，所以每次回复都带上这一行。 */
export function familyStatus() {
    const on = []
    const off = []
    for (const family of FAMILIES) (familyEnabled(family) ? on : off).push(family)
    const line = `家族状态：${on.length ? `${on.join(' / ')} ✓` : '（全部关闭）'}${off.length ? ` ｜ 已关闭：${off.join(' / ')}（在 **设置 → 工具集** 里打开）` : ''}`
    return { on, off, line }
}

/** `topic: 'families'` 的正文：状态 + 怎么开 + 为什么 help 不能关。 */
function familyTopic() {
    return [
        '# dsh-toolkit 家族开关',
        '',
        familyStatus().line,
        '',
        '- 打开方式：桌面端 **设置 → 工具集**（那里有 **' + String(FAMILIES.filter((f) => f !== 'help').length) + ' 个**开关，`help` 不在其中 —— 它常开；拨完即时生效，不需要重启）。',
        '- 关掉的族**不会注册它的工具** —— 省下常驻上下文，也不会让模型看到用不到的工具。',
        '- 默认**全部关闭**（为发布给他人使用）；自己按需打开即可。',
        '- `toolkit_help`（本工具）**常开**且不可关闭：否则关掉之后 agent 就再也问不出"还能用什么 / 怎么开"。',
    ].join('\n')
}

export function tools(defineTool) {
    const tool = (def) => defineTool(def)
    return [
        tool({
            name: 'toolkit_help',
            description:
                'On-demand usage notes and gotchas for this toolkit (table_diff / checkpoint / session / download / ast), ' +
                'plus the vendored **ast-grep rule guidance** (MIT). Read this before using table_diff or checkpoint in an unfamiliar workspace, ' +
                'when a result looks surprising (a count of 0, a refusal, a ⚠⚠ warning), or before writing a complex ast-grep rule. ' +
                'Topics: overview / families / table-diff / shell / file / checkpoint / session / ast / ast-rules / gotchas / full, and the rule topics ' +
                'workflow / rule-object / atomic / relational / composite / metavariables.',
            // 注意方言：defineTool 要的是**字段映射**（{ 字段: {type, required, ...} }），
            // 给原始 JSON Schema（parameters.type = 'object'）会被宿主拒绝：
            // "unsupported JSON schema: parameters.type must be a value schema object"
 // （实测：这一条会让 apply 里该段整段注册失败，其余工具不受影响）
            parameters: {
                topic: {
                    type: 'string',
                    enum: [...Object.keys(TOPICS), 'families'],
                    description: 'Which section to return. Defaults to overview; use gotchas for the pitfall list, full for everything, a family name, or an ast-grep rule topic (workflow / rule-object / atomic / relational / composite / metavariables).',
                },
            },
            output: {
                schema: { type: 'string', description: 'Markdown usage notes.' },
                render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            async execute(args) {
                const topic = args?.topic ?? 'overview'
                if (topic === 'families') return familyTopic()
                const statusLine = familyStatus().line
                const r = helpFrom(helpDoc(), topic)
 // 上游内容的出处必须跟着内容一起回显（MIT 合规；合并时补上）
                const source = UPSTREAM_TOPICS.has(String(topic))
                    ? `\n\n---\n> 上游出处（MIT）：${HELP_SOURCE.url} @ ${HELP_SOURCE.commit.slice(0, 8)}；已并入本插件的 \`docs/TOOLKIT.md#ast-rules\`（中文译本）。`
                    : ''
                const head = r.degraded ? '' : `# dsh-toolkit help · ${r.topic}\n\n`
                return `${statusLine}\n\n${head}${r.text}${source}`
            },
        }),
    ]
}

export function apply(ctx, defineTool) {
    const list = tools(defineTool)
    for (const t of list) ctx.tools.register(t)
    return list.length
}

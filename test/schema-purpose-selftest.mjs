/**
 * **schema 用途底线（purpose floor）自测** —— 起因（2026-10-20 的讨论）：
 *
 *   "schema 一压再压，token 是少了，但模型会不会根本不知道这工具能用在哪，于是完全不调用？"
 *
 * 先看账（`docs\2026-10-20-dsh-ops-v0.4.1-vs-toolkit\LOG.md` §8.4）：常驻 6,545 tok 里
 * **参数说明 73%**（4,777）、**描述里的用途句 16%**（~1,045）、原理 2%（141）、示例 0（早就搬进 `toolkit_help`）。
 * 也就是说：继续压**必然先压到"用在哪"**。这道门就是不许压过线 —— 它不管总量（那是 `toolkit-help` 的预算闸门），
 * 只管"信息还在不在"：
 *
 *  ① **用途句**：每个工具的描述必须命中 `PURPOSE` 里登记的那几条正则（全部命中，AND）；
 *  ② **动词表**：`action` 枚举里的每个值都要在描述里出现 —— 枚举是模型的动词表，
 *     藏掉一个动作，模型就再也想不到那个动作（`download` 的 `probe`、`checkpoint` 的 `journal_restore` 都是这么被发现的）；
 *  ③ **参数说明**：每个参数都要有非空 description（`integer` 的 `（1..N）` 合成说明算通过，那是范围不是含义）；
 *  ④ **描述地板**：每个工具有一份冻结的字节数，描述比它短 10% 以上即红（防"悄悄削一句"）；
 *  ⑤ **新工具必须登记**：注册面与 `PURPOSE` 的键集合必须完全一致 —— 加工具却不写"它能用在哪"，直接红。
 *
 * 为什么单独一份而不是塞进别的套件：它是**发布面契约**（改了就得被看见），而且很便宜（< 1 s，无副作用）。
 * 跑法：`node test/schema-purpose-selftest.mjs`（入口优先取安装副本 —— 那里能解析 @ast-grep/napi）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const ok = (label, cond, extra = '') => { checks++; if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }

/** 载入真入口（安装副本优先；源码树在没有依赖时会少 AST 段） */
const candidates = [
    join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/index.js'),
    join(homedir(), '.dsh/profiles/_probe-toolkit/node_modules/dsh-toolkit/lib/index.js'),
    new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
]
let entry = null
let used = ''
for (const candidate of candidates) {
    try {
        entry = await import(new URL(`file:///${String(candidate).replace(/\\/g, '/')}`).href)
        used = candidate
        break
    }
    catch { /* 试下一个 */ }
}
ok('真入口可加载', entry !== null, used.includes('node_modules') ? '安装副本' : '源码树')

const registered = []
const ctx = {
    tools: { register: (t) => registered.push(t) },
    get: (n) => (n === 'tools' ? ctx.tools : n === 'commands' ? { register: () => {} } : undefined),
    on: () => () => {},
    effect: () => {},
    logger: { warn: () => {} },
    inject: (_deps, cb) => { try { cb(ctx) } catch { /* 可选服务 */ } },
}
await entry.apply(ctx, {})
ok('注册面非空', registered.length > 0, `${registered.length} 个工具`)

// --- 用途登记表（**改描述就要同步改这里**，这是有意的摩擦） ----------------------
// use：描述里必须仍然出现的信息（AND 关系） —— 抽的是"这工具能用在哪"，不是措辞；
// floor：描述字节地板（当前值 −10% 取整），防悄悄削句。
const PURPOSE = {
    ast_search: { use: [/read-only/i, /find nodes/i, /metavariables/i], floor: 300 },
    ast_edit: { use: [/preview/i, /rewrite/i, /paths is REQUIRED/i], floor: 390 },
    ast_dump_tree: { use: [/syntax structure/i, /parser/i], floor: 155 },
    ast_test_rule: { use: [/yaml rule/i, /snippet/i], floor: 115 },
    session_list: { use: [/session logs/i, /subagent/i, /where/i], floor: 300 },
    session_read: { use: [/session logs/i, /pattern/i, /scope/i], floor: 300 },
    session_diff: { use: [/diff/i, /not an lcs/i], floor: 150 },
    session_export: { use: [/jsonl/i, /atomic/i], floor: 160 },
    checkpoint: { use: [/snapshot/i, /roll back/i, /journal/i], floor: 515 },
    table_diff: { use: [/glossar|locali|词表/i, /hash join/i, /无法比较/i], floor: 480 },
    table_peek: { use: [/parsed|how it was parsed/i, /table_diff/], floor: 158 },
    download: { use: [/downloader/i, /resume/i, /proxy/i], floor: 465 },
    bash: { use: [/stdout/i, /stderr/i, /timeout/i], floor: 300 },
    file: { use: [/encoding/i, /expectedRevision/i, /atomic/i], floor: 300 },
    toolkit_help: { use: [/gotchas/i, /topics/i, /ast-grep rule guidance/i], floor: 485 },
}

console.log('== 1. 用途句还在（否则模型不知道该用它干什么） ==')
for (const t of registered) {
    const rule = PURPOSE[t.name]
    if (!rule) { ok(`${t.name}: 已登记用途`, false, '缺 PURPOSE 条目'); continue }
    const desc = String(t.description ?? '')
    const missing = rule.use.filter((re) => !re.test(desc)).map(String)
    ok(`${t.name}: 用途信息完整`, missing.length === 0, missing.length ? `缺 ${missing.join(' / ')}` : '')
}

console.log('== 2. 动词表完整（action 枚举的每个值都出现在描述里） ==')
const actionTools = registered.filter((t) => Array.isArray(t.parameters?.properties?.action?.enum))
ok('存在 action 驱动的工具', actionTools.length > 0, actionTools.map((t) => t.name).join(', '))
for (const t of actionTools) {
    const enumValues = t.parameters.properties.action.enum
    const desc = String(t.description ?? '')
    // 子串匹配（不要求词边界）：`reject` 命中 `rejected`、`journal_restore` 命中自己
    const missing = enumValues.filter((v) => !desc.toLowerCase().includes(String(v).toLowerCase()))
    ok(`${t.name}: ${enumValues.length} 个动作都点到了`, missing.length === 0, missing.length ? `没提到 ${missing.join(',')}` : '')
}

console.log('== 3. 每个参数都有说明（空说明 = 模型只能猜） ==')
for (const t of registered) {
    const props = Object.entries(t.parameters?.properties ?? {})
    const bare = props.filter(([, p]) => typeof p?.description !== 'string' || p.description.trim() === '').map(([k]) => k)
    ok(`${t.name}: ${props.length} 个参数都有说明`, bare.length === 0, bare.length ? `缺 ${bare.join(',')}` : '')
}

console.log('== 4. 描述不许被悄悄削（冻结字节地板） ==')
for (const t of registered) {
    const rule = PURPOSE[t.name]
    if (!rule) continue
    const bytes = Buffer.byteLength(String(t.description ?? ''), 'utf8')
    ok(`${t.name}: 描述 ≥ ${rule.floor} B`, bytes >= rule.floor, `${bytes} B`)
}

console.log('== 5. 新工具必须登记（注册面 ≡ 用途表） ==')
const regNames = registered.map((t) => t.name).sort()
const knownNames = Object.keys(PURPOSE).sort()
const unregistered = regNames.filter((n) => !PURPOSE[n])
const phantom = knownNames.filter((n) => !regNames.includes(n))
ok('注册的每个工具都在 PURPOSE 里', unregistered.length === 0, unregistered.join(', ') || `共 ${regNames.length} 个`)
ok('PURPOSE 里没有已不存在的工具', phantom.length === 0, phantom.join(', ') || '')

// 与预算闸门的分工：这里**不管总量**。但顺手把"描述占比"记下来，供以后判断是否又靠描述堆料。
const totalBytes = registered.reduce((a, t) => a + Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description ?? '', parameters: t.parameters ?? {} }), 'utf8'), 0)
const descBytes = registered.reduce((a, t) => a + Buffer.byteLength(String(t.description ?? ''), 'utf8'), 0)
console.log(`\n参考：描述合计 ${descBytes} B / 整份 schema ${totalBytes} B（${(100 * descBytes / totalBytes).toFixed(0)}%）；`
    + ` 参数说明占大头是正常的（那是调用期契约），这块由 toolkit-help 的预算闸门管。`)
// 兜底断言：描述不能重新膨胀到"用途文档"的程度（历史教训：把说明写进 schema = 每轮都付）
ok('描述合计不超过整份 schema 的 45%', descBytes <= totalBytes * 0.45, `${(100 * descBytes / totalBytes).toFixed(0)}%`)

console.log(failures === 0 ? `\nALL PASS（${checks} 条断言）` : `\n${failures} FAILURE(S)（共 ${checks} 条断言）`)
process.exit(failures === 0 ? 0 : 1)

// toolkit_help 自测：注册、主题、退化行为（文档缺失/小节漂移）、以及 schema 体积对比
import { readFileSync } from 'node:fs'
import { apply, helpFrom, section, tools } from '../lib/help/index.js'

let failures = 0
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }

console.log('== 1. 注册与形状 ==')
const captured = []
apply({ tools: { register: (t) => captured.push(t) } }, (def) => def)
const tool = captured[0]
ok('注册了 1 个工具', captured.length === 1, captured.map((t) => t.name).join(','))
ok('名字是 toolkit_help', tool?.name === 'toolkit_help')
ok('description 说明何时该用（含 table_diff / checkpoint）', /table_diff/.test(tool.description) && /checkpoint/.test(tool.description))
ok('topic 是枚举且含 gotchas/full', Array.isArray(tool.parameters.topic?.enum) && tool.parameters.topic.enum.includes('gotchas') && tool.parameters.topic.enum.includes('full'), (tool.parameters.topic?.enum ?? []).join(','))
// 方言断言：defineTool 只吃字段映射；给原始 JSON Schema（type:'object' + properties）会被宿主拒，
// 表现为 apply 里该段整段失败（实测："parameters.type must be a value schema object"）。
// 自测若只在假包装上跑就会漏掉它 —— 所以这里显式锁住形状。
ok('parameters 是字段映射方言（不是原始 JSON Schema）', tool.parameters.type === undefined && tool.parameters.properties === undefined && Boolean(tool.parameters.topic), JSON.stringify(Object.keys(tool.parameters)))
// ast_grep_help 并入后，这一个工具要同时列出两个主题族（14 个主题）⇒ 上限从 900 提到 1400
// （仍然很小：合并前两个 help 加起来约 1.2k，且对比 download/checkpoint 的 3.7-4.3k 仍是零头）。
// 关键是**不许失控**：真要写小抄请放进 docs/TOOLKIT.md（按需取回），不要塞进 schema。
ok('体积可控（常驻成本）', JSON.stringify(tool).length < 1400, `${JSON.stringify(tool).length} 字符`)

console.log('== 2. 主题取回（真文档） ==')
const byTopic = async (t) => (await tool.execute({ topic: t }))
// 路径必须指向包根的 docs/TOOLKIT.md（lib/help/ 要上两级）—— 曾经少一层，导致永远走降级分支
const realDoc = readFileSync(new URL('../docs/TOOLKIT.md', import.meta.url), 'utf8')
ok('工具读到的是真文档而不是降级速记', !(await byTopic('overview')).includes('帮助文档缺失'), (await byTopic('overview')).slice(0, 40).replace(/\n/g, ' '))
const overview = await byTopic('overview')
ok('overview 有内容且是 markdown', overview.includes('# dsh-toolkit help') && overview.includes('## overview'))
const td = await byTopic('table-diff')
ok('table-diff 主题含"0 结果"契约', /0 结果绝不能读成/.test(td), td.split('\n')[1]?.slice(0, 60) ?? '')
ok('table-diff 主题含 mapA 配方', /mapA/.test(td) && /命中率/.test(td))
const ck = await byTopic('checkpoint')
ok('checkpoint 主题含 pruneExtra 跨工作区拒绝', /跨工作区.*拒绝/.test(ck))
ok('checkpoint 主题含 hash-only 不可回滚', /回滚不了|not-stored/.test(ck))
const ses = await byTopic('session')
ok('session 主题含 last 的语义', /调用方会话工作区里最新/.test(ses))
const ast = await byTopic('ast')
ok('ast 主题含 paths 必填与 preview→apply', /paths` 必填|paths\*\* 必填/.test(ast) && /preview/.test(ast))
const got = await byTopic('gotchas')
ok('gotchas 主题是清单', /(^|\n)1\./.test(got) && /无法比较|0 结果/.test(got))
const full = await byTopic('full')
ok('full 返回全文且最长', full.length > td.length && full.includes('## gotchas'))
const dflt = await tool.execute({})
ok('默认主题 = overview', dflt.includes('## overview'))
let bad = null
try { await byTopic('nope') } catch (e) { bad = e.message }
ok('未知主题报错并列出可用值', bad !== null && /unsupported help topic/.test(bad) && /gotchas/.test(bad), (bad ?? '').slice(0, 60))

console.log('== 3. 退化行为（纯函数，不依赖磁盘） ==')
ok('文档为空 ⇒ 返回内置速记而非抛错', (() => { const r = helpFrom('', 'overview'); return r.degraded === true && /帮助文档缺失/.test(r.text) && /⚠⚠/.test(r.text) })())
ok('小节缺失 ⇒ 退化返回全文 + 提示', (() => { const r = helpFrom('# 只有标题\n\n没有任何小节\n', 'checkpoint'); return r.degraded === true && /找不到/.test(r.text) && /已返回全文/.test(r.text) })())
ok('section() 找不到返回 null（不抛）', section('## a\nx\n', '## b') === null)
ok('section() 正确切到下一个同级标题', section('## a\nA\n## b\nB\n', '## a') === '## a\nA')

console.log('== 4. 文档与主题映射一致性 ==')
const doc = realDoc
for (const topic of ['overview', 'table-diff', 'checkpoint', 'session', 'ast', 'gotchas']) {
    ok(`文档里有 ## ${topic} 小节`, helpFrom(doc, topic).degraded === false)
}

console.log('== 5. schema 常驻体积：预算 + baseline（改用字节口径） ==')
{
    // 借鉴 T-Auto/dsh-ops 的做法（docs/schema-measurement.md + scripts/measure-schemas.mjs）：
    // 常驻 schema 是**每个会话都要付的钱**，所以要有 checked-in 的数字与预算，而不是凭感觉。
    // 口径 = `{name,description,parameters}` 的紧凑 UTF-8 字节（中文 3 字节/字符 ⇒ bytes/4 对中文是**高估**）。
    const { measure } = await import('../scripts/measure-schemas.mjs')
    const report = await measure()
    const baseline = JSON.parse(readFileSync(new URL('../docs/schema-baseline.json', import.meta.url), 'utf8'))
    const pct = (now, was) => `${now >= was ? '+' : ''}${(((now - was) / was) * 100).toFixed(1)}%`
    const full = report.tools.length
    ok('登记到的工具数（安装副本应满 13；源码树缺 yaml 时会少 AST 段）', full === baseline.total.tools || report.entry === 'source tree', `${full} 个（${report.entry}，baseline ${baseline.total.tools}）`)
    ok('总 schema 字节在预算内（baseline +5%）', report.total.bytes <= Math.ceil(baseline.total.bytes * 1.05), `${report.total.bytes} B vs ${baseline.total.bytes} B（${pct(report.total.bytes, baseline.total.bytes)}）`)
    const over = report.tools.filter((t) => {
        const was = baseline.tools.find((x) => x.name === t.name)
        return was !== undefined && t.bytes > Math.ceil(was.bytes * 1.10)
    })
    ok('没有单个工具悄悄膨胀超过 10%', over.length === 0, over.map((t) => `${t.name} ${t.bytes} > ${Math.ceil(baseline.tools.find((x) => x.name === t.name).bytes * 1.1)}`).join('、') || '无')
    ok('新增工具必须显式归族（不许落在 other）', report.families.other === undefined, Object.keys(report.families).join(','))
    const biggest = [...report.tools].sort((a, b) => b.bytes - a.bytes).slice(0, 4).map((t) => `${t.name} ${t.bytes}`).join('、')
    console.log(`  （合计 ${report.total.bytes} B ≈${report.total.approximateTokens} tok；最大四件：${biggest}）`)
    console.log(`  （按需文档 docs/TOOLKIT.md ${report.onDemand?.bytes ?? '?'} B —— 只有真的请教才付这份钱；要写小抄请放这里，不要塞进 schema）`)
}

console.log('== 6. 文档缓存：按"纳秒 mtime + size"失效（审计修复点） ==')
{
    // 旧实现"读一次存一辈子"：改了 docs 不生效，且首次读失败会被永久缓存。
    // 只比毫秒 mtime 也不够（同刻度写入测不出来），所以锁住"纳秒 + size 双信号"。
    const { createDocLoader } = await import('../lib/doc-cache.js')
    let reads = 0
    let ns = 1000n
    let size = 10
    let exists = true
    const loader = createDocLoader('fake://doc', {
        read: () => { if (!exists) throw new Error('ENOENT: no such file'); reads += 1; return `v${reads}` },
        stat: () => { if (!exists) throw new Error('ENOENT'); return { mtimeNs: ns, size } },
    })
    ok('首次读取', loader.load() === 'v1' && reads === 1)
    ok('指纹未变 ⇒ 不重读（省 IO）', loader.load() === 'v1' && reads === 1)
    ns = 2000n
    ok('mtime 变化 ⇒ 重读（改了文档即时生效）', loader.load() === 'v2' && reads === 2)
    ns = 2000n; size = 11 // 同刻度但大小变了
    ok('同一时间刻度、size 变了 ⇒ 也重读（毫秒粒度不够，需要 size 兜底）', loader.load() === 'v3' && reads === 3)
    exists = false
    ok('文件消失 ⇒ 返回空串且不抛，error 有原因', loader.load() === '' && loader.error() !== null, String(loader.error()).slice(0, 24))
    ok('仍缺失时不反复重读', loader.load() === '' && reads === 3)
    exists = true; ns = 3000n
    ok('文件又出现 ⇒ 自动恢复（旧实现会永久卡在空文档）', loader.load() === 'v4' && loader.error() === null)
    ok('真实加载器返回纳秒指纹字符串', (() => { const real = createDocLoader(new URL('../docs/TOOLKIT.md', import.meta.url)); return typeof real.load() === 'string' && real.load().length > 1000 })())
}

console.log('== 7. 由注册表生成的路由段（systemPrompt.section）==')
{
 // 借鉴 dsh-ops：路由说明**生成**而不是手写 —— 手写的会漂移（我们踩过旧工具名），
    // 生成的只广告**确实挂载**的工具，且工作区级 AGENTS.md 覆盖不到的地方也能看到。
    const { renderRouting } = await import('../lib/routing.js')
    const full = renderRouting(['table_diff', 'table_peek', 'ast_edit', 'session_read', 'checkpoint', 'download', 'toolkit_help'])
    ok('满挂载时给出 4 组路由 + 标题', /^## dsh-toolkit/.test(full) && (full.match(/^- /gm) ?? []).length === 5, `${(full.match(/^- /gm) ?? []).length} 行`)
    ok('常驻成本受控（< 900 字节）', Buffer.byteLength(full, 'utf8') < 900, `${Buffer.byteLength(full, 'utf8')} B`)
    ok('只广告已挂载的工具（未挂载 ⇒ 整行消失）', (() => {
        const only = renderRouting(['table_diff'])
        return /table_diff/.test(only) && !/ast_edit/.test(only) && !/download/.test(only) && !/session_/.test(only)
    })())
    ok('一个相关工具都没有 ⇒ 整段消失（不留空标题）', renderRouting(['ast_dump_tree']) === '' && renderRouting([]) === '')
    ok('没有 toolkit_help 时不提它', !/toolkit_help/.test(renderRouting(['table_diff'])))
}

console.log('== 8. 配置与家族开关（profile patch 的 config:）==')
{
 // （借鉴作者资料"Put tunable values in the plugin's Config"）：
    // 开关只放在 `defineTool` 的唯一收口处 ⇒ 机制必须是纯函数、可测。
    const { normalizeConfig, familyOfTool, gateDefineTool, describeConfig, FAMILIES } = await import('../lib/configure.js')
    const cfg = normalizeConfig()
    ok('默认全部家族开启', FAMILIES.every((f) => cfg.families[f] === true), JSON.stringify(cfg.families))
    ok('只认显式 false（写 0/空串不算关）', normalizeConfig({ families: { ast: 0, session: '' } }).families.ast === true)
    ok('关掉一个家族只影响那一个', (() => { const c = normalizeConfig({ families: { ast: false } }); return c.families.ast === false && c.families.table === true })())
    ok('工具→家族映射覆盖已知工具', ['ast_edit', 'table_diff', 'table_peek', 'session_read', 'checkpoint', 'download', 'bash', 'file', 'toolkit_help'].every((n) => familyOfTool(n) !== 'other'))
    ok('未知工具归 other（不静默当某族）', familyOfTool('no_such_tool') === 'other')
    const seen = []
    const gate = gateDefineTool((def) => { seen.push(def.name); return def }, normalizeConfig({ families: { ast: false } }))
    gate({ name: 'ast_edit' }); gate({ name: 'table_diff' })
    ok('闸门丢弃被关家族的工具、放行其它', !seen.includes('ast_edit') && seen.includes('table_diff'), seen.join(','))
    ok('被关掉的工具名会被记账（信标/诊断用）', (() => { const c = normalizeConfig({ families: { ast: false } }); gateDefineTool(() => {}, c)({ name: 'ast_edit' }); return c.disabled.includes('ast_edit') })())
    ok('checkpoint.root 只在给了非空字符串时生效', normalizeConfig({ checkpoint: { root: 'D:/ck' } }).checkpointRoot === 'D:/ck' && normalizeConfig({ checkpoint: { root: '  ' } }).checkpointRoot === null)
    ok('describeConfig 给出可读摘要', /families=/.test(describeConfig(normalizeConfig({ families: { ast: false }, checkpoint: { root: 'D:/ck' } }))))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

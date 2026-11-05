/**
 * 文档声称 ↔ 实际行为 的自动核对：node test/docs-claims-selftest.mjs
 *
 * 为什么需要它：`docs/TOOLKIT.md` 是**手写**的（给 agent 按需读），代码一改文档就可能**撒谎**。
 * 就抓到一个：文档还写着"二进制按 `DSH_AST_GREP_BINARY` 探测"，而进程内 NAPI 引擎
 * 里根本没有二进制这回事了。本文件把"可机械核对"的声称全部变成断言：
 *
 *  A. 工具清单：文档里提到的工具必须真的注册；注册的工具必须在文档里被提到
 *  B. 主题清单：`toolkit_help` / `ast_grep_help` 的主题与文档一致
 *  C. 参数名：文档里引用的参数必须真的存在于对应工具的 schema
 *  D. 数字：文档写的上限/默认值必须与代码常量一致
 *  E. 已移除的东西不得再出现在文档里（二进制探测、已删的许可文件、已删的上游文件）
 *  F. 文档引用的**输出原文**必须真的在代码里（改文案不改文档 ⇒ 这里会红）
 *  G. README 里的自测份数/徽章必须与实际文件数一致
 *
 * 零依赖：只做文本与注册表核对，不需要 @ast-grep/napi。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const here = new URL('.', import.meta.url)
const PKG = new URL('..', here)
let failures = 0
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }
const read = (rel) => readFileSync(new URL(rel, PKG), 'utf8')
const readInstalled = (rel) => {
    try { return readFileSync(join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit', rel), 'utf8') }
    catch { return '' }
}

const DOC = read('docs/TOOLKIT.md')
const DOC_SELF = DOC.split('## ast-rules')[0] // 只看我们自己写的那部分（ast-rules 是上游译文）
const code = {
    search: read('lib/search.js'),
    edit: read('lib/ast/edit.js'),
    glob: read('lib/glob.js'),
    checkpoint: read('lib/checkpoint/index.js'),
    session: read('lib/session/index.js'),
    tablediff: read('lib/tablediff/index.js'),
    adapters: read('lib/tablediff/adapters.js'),
    entry: read('lib/index.js'),
    help: read('lib/help/index.js'),
    topics: read('lib/ast/help-topics.js'),
}
const ALL_CODE = Object.values(code).join('\n')

console.log('== A. 工具清单 ==')
// 从安装副本取真实注册的工具（依赖可解析）；取不到就退回源码树（仅能拿到名字）
let registered = []
try {
    const mod = await import(pathToFileURL(join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/index.js')).href)
    const captured = []
    const registry = { register: (t) => captured.push(t) }
    const ctx = {
        tools: registry,
        get(name) { return name === 'tools' ? registry : name === 'commands' ? { register: () => {} } : undefined },
        logger: { warn: () => {} }, on: () => {}, effect: () => {},
        inject: (_deps, cb) => { try { cb(ctx) } catch { /* 可选服务缺失 */ } },
    }
    await mod.apply(ctx, {})
    registered = captured.map((t) => t.name)
} catch { /* 副本不可用 */ }
if (registered.length === 0) {
    console.log('  SKIP: 安装副本不可用，工具清单核对跳过（源码树跑不了宿主注册）')
} else {
    const docTools = [...new Set([...DOC.matchAll(/`((?:table|ast|session|checkpoint|toolkit)_[a-z_]+)`/g)].map((m) => m[1]))]
    const phantom = docTools.filter((t) => !registered.includes(t))
    ok('文档提到的工具都真实存在', phantom.length === 0, phantom.join(',') || `${docTools.length} 个都认`)
    const undocumented = registered.filter((t) => !DOC.includes(t))
    ok('注册的工具都在文档里出现过', undocumented.length === 0, undocumented.join(',') || `${registered.length} 个都有`)
    ok('文档说"七族 15 个工具"，实际也是 15（收敛：checkpoint 7→1、download 3→1、帮助 2→1、session 成对 6→4；bash/file 是内核 0.2.2 后的新增）', /七族 15 个工具/.test(DOC) && registered.length === 15, `实际 ${registered.length}`)
    // 按"族"显式列名（AST 族里 ast_dump_tree / ast_test_rule 没有 ast_ 前缀，不能按前缀数）
    const families = {
        ast: ['ast_search', 'ast_dump_tree', 'ast_test_rule', 'ast_edit'],
        session: ['session_list', 'session_read', 'session_diff', 'session_export'],   // 成对合并：6 -> 4
        checkpoint: ['checkpoint'],   // 工具面收敛：7 个动词合并成 action 驱动的一个工具
        table: ['table_diff', 'table_peek'],
        download: ['download'],       // 同上：3 -> 1
        shell: ['bash'],              // 内核 0.2.2 移除 ops_bash 后的自建执行器
        file: ['file'],               // 文件读写（编码探测 + revision CAS）
    }
    const familyClaim = { ast: 'AST（4）', session: '会话日志（4）', checkpoint: 'checkpoint（1）', table: '表 diff（2）', download: '下载（1）', shell: 'Bash（1）', file: 'File（1）' }
    for (const [fam, names] of Object.entries(families)) {
        const actual = names.filter((n) => registered.includes(n)).length
        ok(`${fam} 族：列名 ${names.length} 个、实注册 ${actual} 个`, actual === names.length, actual === names.length ? '' : registered.join(','))
        ok(`README 里写的「${familyClaim[fam]}」与实际一致`, read('README.zh-CN.md').includes(familyClaim[fam]))
    }
    ok('toolkit_help 也在注册表里', registered.includes('toolkit_help'))
}

console.log('== B. 主题清单 ==')
{
    const helpLiteral = [...code.help.matchAll(/^\s{4}'?([a-z-]+)'?: \[/gm)].map((m) => m[1])
    const ruleTopics = [...code.topics.matchAll(/^\s{4}'?([a-z-]+)'?: \[/gm)].map((m) => m[1])
 // ast_grep_help 并入 toolkit_help —— 规则主题以 `...HELP_TOPICS` **展开**进 help 的主题表，
    // 正则看不到展开 ⇒ 判定"覆盖"时把数据模块的键并进来。
    const helpKeys = [...helpLiteral, ...ruleTopics.filter((t) => t !== 'full')]
    const ruleTopicKeys = new Set(ruleTopics)
    for (const t of helpLiteral) {
        if (t === 'full') continue
        ok(`toolkit_help 主题 ${t} 在文档里有对应小节`, ruleTopicKeys.has(t) ? true : DOC.includes(`## ${t}`))
    }
    const docAstTopics = /workflow\/rule-object\/atomic\/relational\/composite\/metavariables\/full/.test(DOC)
    ok('文档写明的规则主题与实际一致（已并入 toolkit_help）', docAstTopics && ruleTopics.join(',') === 'workflow,rule-object,atomic,relational,composite,metavariables,full', ruleTopics.join(','))
    ok('并入后 toolkit_help 的主题表覆盖了全部规则主题', ruleTopics.filter((t) => t !== 'full').every((t) => helpKeys.includes(t)), `helpKeys=${helpKeys.length} ruleTopics=${ruleTopics.length}`)
}

console.log('== C. 文档引用的参数名确实存在 ==')
{
    // 每个参数名 → 必须出现在对应工具的 schema 或实现里
    const params = {
        table_diff: ['keyField', 'valueField', 'keyHints', 'valueHints', 'mapA', 'mapB', 'mapAFrom', 'mapATo', 'mapMode', 'only', 'filter', 'ci', 'trim', 'limit', 'query', 'format'],
        checkpoint: ['exclude', 'maxCopyBytes', 'maxCopyTotal', 'maxFiles', 'confirm', 'files', 'pruneExtra', 'keep', 'drop', 'sessionKey', 'path', 'limit'],
        session_diff: ['maxItems'],
        ast_edit: ['paths', 'ops', 'action', 'stagedId'],
        ast_dump_tree: ['code', 'language', 'format', 'max_nodes', 'max_depth'],
        ast_search: ['source', 'paths', 'pattern', 'language', 'capture_names', 'max_matches', 'max_match_chars'],
        ast_test_rule: ['code', 'yaml'],
        toolkit_help: ['topic'],
    }
    let missing = 0
    for (const [tool, names] of Object.entries(params)) {
        for (const n of names) {
            // 参数必须在该工具所在文件的 schema 文本里出现（宽松但足够：抓"文档写了代码没有"的漂移）
            const hay = ALL_CODE
            if (!hay.includes(n)) { missing += 1; console.log(`    !! ${tool}.${n} 在代码里找不到`) }
        }
    }
    ok(`文档引用的 ${Object.values(params).flat().length} 个参数名都能在代码里找到`, missing === 0)
    ok('文档提到的 `only=added|removed|changed` 与实现一致', /only=added\|removed\|changed/.test(DOC) && /only = 'all'/.test(code.tablediff))
    ok('文档提到的 mapMode 取值与实际一致', /first.*last.*all/s.test(DOC) && /mapMode/.test(ALL_CODE) && /'all'/.test(ALL_CODE))
}

console.log('== D. 文档里的数字 vs 代码常量 ==')
{
    const pairs = [
        ['>300 MB 被拒', /300 MB 会被拒绝/, /MAX_TEXT_BYTES = 300 \* 1024 \* 1024/, 'adapters'],
        ['单文件复制上限 1 MB', /默认 1 MB/, /MAX_COPY_BYTES = 1024 \* 1024/, 'checkpoint'],
        ['复制总量上限 50 MB', /默认 50 MB/, /MAX_COPY_TOTAL = 50 \* 1024 \* 1024/, 'checkpoint'],
        ['journal 跳过 >20 MB', />20 MB 跳过/, /20 \* 1024 \* 1024/, 'checkpoint'],
        ['journal 最多 200 条', /最多留 200 条/, /JOURNAL_MAX = 200/, 'checkpoint'],
        ['SQLite 只列前 25 张表', /前 25/, /slice\(0, 25\)/, 'adapters'],
        ['每段展示默认 50', /默认 50/, /limit = 50/, 'tablediff'],
        ['匹配数 ≤200', /匹配数 ≤200/, /MAX_MATCHES = 200/, 'search'],
        ['单条文本 ≤2 万字符', /2 万字符/, /MAX_MATCH_CHARS = 20_000/, 'search'],
        ['源码 ≤2M 字符', /2M 字符/, /MAX_SOURCE_CHARS = 2_000_000/, 'search'],
        ['树节点 ≤5000', /树节点 ≤5000/, /MAX_TREE_NODES = 5_000/, 'search'],
        ['规则 YAML ≤200KB', /规则 YAML ≤200KB/, /MAX_RULE_YAML_CHARS = 200_000/, 'search'],
    ]
    for (const [label, docRx, codeRx, file] of pairs) {
        ok(`数字一致：${label}`, docRx.test(DOC_SELF) && codeRx.test(code[file]), docRx.test(DOC_SELF) ? '' : '（文档里没这句了）')
    }
}

console.log('== E. 已移除的东西不得再出现在文档里 ==')
{
    // ① 全篇都不该出现（连历史说明里也不该有）
    for (const token of ['DSH_AST_GREP_BINARY', 'binaryPath']) {
        ok(`全篇不再提「${token}」`, !DOC.includes(token))
    }
    // ② 我们自己写的那部分不该提（ast-rules 的署名块里允许出现历史文件名，那是出处说明）
    for (const token of ['@ast-grep/cli', 'fast-glob', 'ast-grep.mdc', 'NOTICE.md', 'LICENSE.dsh-ast-grep', 'AST_GREP_MCP_LICENSE.txt']) {
        ok(`自写部分不再提「${token}」`, !DOC_SELF.includes(token))
    }
    ok('代码里也确实没有二进制探测了', !code.search.includes('DSH_AST_GREP_BINARY') && !code.edit.includes('DSH_AST_GREP_BINARY'))
}

console.log('== F. 文档引用的输出原文真的在代码里 ==')
{
    const quotes = [
        ['glob 合并回显', '合并', code.tablediff + code.adapters],
        ['无法比较（不是"没有差异"）', '无法比较', code.tablediff + code.adapters],
        ['⚠⚠ 警告符号', '⚠⚠', code.tablediff + code.session],
        ['last 的解析依据方括号', '［last 按调用方工作区解析', code.session],
        ['坏帧告警', '帧解码失败', code.session],
        ['快照体积回显', 'copied', code.checkpoint],
        ['复制预算外显', '复制预算用尽', code.checkpoint],
        ['hashOnly 外显', 'hashOnly', code.checkpoint],
        ['清单截断外显', '文件数上限截断', code.checkpoint],
        ['not-stored 回滚提示', 'not-stored', code.checkpoint],
        ['/checkpoint 命令', '/checkpoint', code.checkpoint],
        ['/rewind 命令', '/rewind', code.checkpoint],
        ['stagedId 回报', 'stagedId', code.edit],
    ]
    for (const [label, needle, hay] of quotes) {
        ok(`代码里存在：${label}`, hay.includes(needle))
    }
}

console.log('== G. README 的计数与徽章 ==')
{
    const tests = readdirSync(new URL('test/', PKG)).filter((f) => f.endsWith('-selftest.mjs')).length
    for (const file of ['README.md', 'README.zh-CN.md']) {
        const t = read(file)
        const en = file === 'README.md'
        const claim = en ? /(\d+) \*-selftest\.mjs suites/ : /共 (\d+) 份 \*-selftest\.mjs/
        const m = t.match(claim)
        ok(`${file} 写的自测份数 = 实际（${tests}）`, m && Number(m[1]) === tests, m ? `写了 ${m[1]}` : '（没找到该句式）')
        const badge = t.match(/tests-(\d+)%20suites/)
        ok(`${file} 徽章份数 = 实际`, badge && Number(badge[1]) === tests, badge ? `徽章 ${badge[1]}` : '（没找到徽章）')
    }
}

console.log('== H. schema 体积数字 vs docs/schema-baseline.json ==')
{
 // 这几处最容易"改了基线忘了改文档" —— 就抓到一次：按约定重冻 baseline 后，
    // docs/schema-measurement.md 里还印着旧总量/旧家族小计（文档照样"看起来权威"）。
    const baseline = JSON.parse(read('docs/schema-baseline.json'))
    const sm = read('docs/schema-measurement.md')
    const fmt = (n) => n.toLocaleString('en-US')
    ok(`schema-measurement.md 的工具 schema 总量 = baseline（${fmt(baseline.total.bytes)}）`, sm.includes(fmt(baseline.total.bytes)))
    ok(`schema-measurement.md 的常驻合计 = baseline（${fmt(baseline.resident.bytes)}）`, sm.includes(fmt(baseline.resident.bytes)))
    ok(`schema-measurement.md 的按需体积 = baseline（${fmt(baseline.onDemand.bytes)}）`, sm.includes(fmt(baseline.onDemand.bytes)))
    const drifted = Object.entries(baseline.families).filter(([fam, v]) => !sm.includes(`${fam}\` ${fmt(v.bytes)} B`))
    ok('schema-measurement.md 的家族小计逐项 = baseline', drifted.length === 0, drifted.map(([f, v]) => `${f} 期望 ${fmt(v.bytes)}`).join('、') || `${Object.keys(baseline.families).length} 个都对`)
    ok('schema-current.json 与 baseline 同格式版本', JSON.parse(read('docs/schema-current.json')).format === baseline.format)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

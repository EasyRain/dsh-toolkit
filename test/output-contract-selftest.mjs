/**
 * 输出契约自测（新增，起因：MCMOD 宿主侧实测的 P0 —— `ast_grep_help` 声明了
 * `output.schema.additionalProperties: false` 却**没列任何 properties** ⇒ 宿主按 schema 校验返回值时
 * 把 `topic/source/markdown` 全判成"未声明属性" ⇒ 工具 0% 可用。15 份纯 `node:` 层自测**结构上抓不到**
 * 这类问题（它们不经过宿主 schema 校验），所以这里补两层：
 *
 *  ① **静态 lint**：遍历真入口注册出的每个工具，检查 parameters / output.schema —— 
 *     `additionalProperties: false` 的 object 必须**声明 properties**（P0 就是这一条）；
 *  ② **动态校验**：对**只读、无副作用**的工具用最小参数真跑一遍，用它的 output.schema **校验真实返回值**。
 *
 * 跑法：`node test/output-contract-selftest.mjs`（入口优先取安装副本 —— 那里能解析 @ast-grep/napi，
 * 源码树里 AST 族会按设计被隔离掉）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}

// --- 载入真入口（优先安装副本：依赖可解析） ---------------------------------
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
ok('注册出 15 个工具（收敛：checkpoint 7→1、download 3→1、帮助 2→1、session 成对 6→4；bash/file 新增）', registered.length === 15, `${registered.length} 个`)

// --- ① 静态 lint ------------------------------------------------------------
/** 递归找"additionalProperties:false 但没 properties"的 object schema（宿主会拒收这类返回值） */
function lintSchema(schema, where, out) {
    if (schema === null || typeof schema !== 'object') return
    if (Array.isArray(schema)) { schema.forEach((s, i) => lintSchema(s, `${where}[${i}]`, out)); return }
    if (schema.type === 'object') {
        const hasProps = schema.properties !== undefined && Object.keys(schema.properties).length > 0
        if (schema.additionalProperties === false && !hasProps) {
            out.push(`${where}: object + additionalProperties:false 但没声明 properties（宿主会拒收返回体/入参）`)
        }
    }
    if (schema.properties) for (const [k, v] of Object.entries(schema.properties)) lintSchema(v, `${where}.properties.${k}`, out)
    if (schema.items) lintSchema(schema.items, `${where}.items`, out)
    if (schema.additionalProperties !== null && typeof schema.additionalProperties === 'object') lintSchema(schema.additionalProperties, `${where}.additionalProperties`, out)
    for (const key of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(schema[key])) schema[key].forEach((s, i) => lintSchema(s, `${where}.${key}[${i}]`, out))
}

const lintIssues = []
for (const t of registered) {
    lintSchema(t.parameters, `${t.name}.parameters`, lintIssues)
    lintSchema(t.output?.schema, `${t.name}.output.schema`, lintIssues)
}
ok('静态 lint：没有"additionalProperties:false 却不列 properties"的 schema', lintIssues.length === 0, lintIssues.slice(0, 3).join('；'))

const noOutputSchema = registered.filter((t) => t.output === undefined || t.output.schema === undefined).map((t) => t.name)
ok('每个工具都声明了 output.schema', noOutputSchema.length === 0, noOutputSchema.join(', '))

const noRender = registered.filter((t) => typeof t.output?.render !== 'function').map((t) => t.name)
ok('每个工具都声明了 output.render', noRender.length === 0, noRender.join(', '))

// --- ③ 参数面钉住 -----------------------------------------------------------
// 目的（MCMOD 复核小项 ②）：`docs-claims-selftest` 那条只检查"列出的参数都已声明"，
// **新加参数不会让它红** ⇒ 文档↔实现会悄悄漂移。这里把 13 个工具的参数集**逐字钉住**：
// 谁加了/删了参数而没同步这份清单，这里就红（加参数时顺手更新本表即可）。
const EXPECTED_PARAMS = {
    bash: ['command', 'script_path', 'description', 'cwd', 'workdir', 'timeoutMs', 'graceMs', 'includeDiagnostics', 'background'],
    file: ['action', 'path', 'paths', 'ranges', 'encoding', 'maxBytes', 'content', 'bom', 'edits', 'pattern', 'replacement', 'dryRun', 'expectedRevision', 'to', 'overwrite', 'recursive', 'confirm', 'createParents'],
    ast_dump_tree: ['code', 'language', 'format', 'max_nodes', 'max_depth'],
    ast_test_rule: ['code', 'yaml'],
 // ast_grep_help 已并入 toolkit_help（工具面收敛），不再是独立工具
 // 只读侧：action 驱动（grep = 原来的搜索；diff = 文件 vs 拟写入内容）
    ast_search: ['action', 'content', 'source', 'paths', 'pattern', 'language', 'capture_names', 'max_matches', 'max_match_chars', 'include_vendored', 'offset', 'text_mode'],
 // （MCMOD 反馈）：+ mode/force/verify —— 改名用 literal、覆盖率校验与后置条件
    ast_edit: ['ops', 'paths', 'action', 'stagedId', 'mode', 'force', 'verify', 'previewDetail'],   // + previewDetail（大改动折叠）；diff 已移出到 ast_search
    session_list: ['kind', 'cwd', 'limit', 'session', 'gcRoot', 'where', 'fields', 'sort', 'offset'],   // + session_catalog（kind="subagents"）；where/fields/sort/offset = 谓词/重列/分页（2026-10-24 合并，未新增工具）
    session_read: ['session', 'cwd', 'pattern', 'flags', 'tail', 'limit', 'width', 'scope', 'maxHitsPerSession'],   // session_peek + session_grep 合并；scope = 跨会话检索
    session_diff: ['a', 'b', 'cwd', 'maxItems', 'withText'],
    session_export: ['session', 'cwd', 'to', 'format', 'overwrite'],
 // 工具面收敛：checkpoint_*（7 个）合并成 action 驱动的 `checkpoint`，
    // download{,_status,_cancel}（3 个）合并成 action 驱动的 `download`。参数面 = 各 action 的并集。
    checkpoint: ['action', 'note', 'cwd', 'exclude', 'presetExclude', 'estimate', 'maxFiles', 'maxCopyBytes', 'maxCopyTotal',
        'limit', 'id', 'other', 'maxDiffs', 'files', 'dryRun', 'confirm', 'pruneExtra', 'path', 'sessionKey', 'allowOutside', 'drop', 'keep'],
    download: ['action', 'cookie', 'expectedBytes', 'headers', 'lowestSpeedLimit', 'minSplitSize', 'mode', 'overwrite', 'probe', 'proxy', 'referer', 'resume', 'sha256', 'speedLimit', 'threads', 'timeoutMs', 'to', 'url',
        'id', 'all', 'limit', 'deletePart', 'waitMs'],
    table_diff: ['a', 'b', 'format', 'formatA', 'formatB', 'keyField', 'valueField', 'keyFieldA', 'valueFieldA', 'keyFieldB', 'valueFieldB', 'keyHints', 'valueHints', 'mapA', 'mapB', 'mapAFrom', 'mapATo', 'mapBFrom', 'mapBTo', 'mapMode', 'ci', 'trim', 'filter', 'only', 'limit', 'showValues', 'query', 'normalize', 'ordered', 'table', 'valueFields'],
    table_peek: ['source', 'format', 'keyField', 'valueField', 'keyHints', 'valueHints', 'query', 'normalize', 'ordered', 'table', 'limit'],
    toolkit_help: ['topic'],
}
const paramDrift = []
for (const t of registered) {
    const actual = Object.keys(t.parameters?.properties ?? {}).sort()
    const expected = EXPECTED_PARAMS[t.name]
    if (expected === undefined) { paramDrift.push(`${t.name}: 新工具未登记进 EXPECTED_PARAMS`); continue }
    const want = [...expected].sort()
    if (actual.join(',') !== want.join(',')) {
        const added = actual.filter((x) => !want.includes(x))
        const removed = want.filter((x) => !actual.includes(x))
        paramDrift.push(`${t.name}:${added.length > 0 ? ` 新增 ${added.join('/')}` : ''}${removed.length > 0 ? ` 缺失 ${removed.join('/')}` : ''}`)
    }
}
ok('参数面与钉住的清单一致（增删参数必须同步这里）', paramDrift.length === 0, paramDrift.slice(0, 3).join('；'))

// --- ③ 宿主 DSL 方言 lint（**这条能拦住“会话起不来”的那类事故**）-----------------
// 事故：`download` 段把**原始 JSON Schema** 交给 `defineTool`，宿主 DSL 拒收
// （`parameters.type must be a value schema object`）⇒ 工具退回“无 schema”注册
// ⇒ 宿主写 `request/header` 事件时报 `carries non-JSON-serializable data`，**整个会话起不来**。
// 契约固定为：`defineTool({ ...def, parameters: toFieldMap(def.parameters) })`。
// 这里用一个“像宿主那样挑剔”的假 DSL（顶层必须是参数名；出现 type/properties 即拒收）跑一遍各段。
{
    const strictDsl = (def) => {
        const p = def?.parameters
        if (p !== null && typeof p === 'object' && (Object.prototype.hasOwnProperty.call(p, 'type') || Object.prototype.hasOwnProperty.call(p, 'properties'))) {
            throw new Error(`原始 JSON Schema 不是宿主方言（工具 ${def.name}）`)
        }
        return def
    }
    const violations = []
    for (const name of ['session', 'checkpoint', 'tablediff', 'download']) {
        try {
            const mod = await import(`../lib/${name}/index.js`)
            if (typeof mod.tools !== 'function') continue
            mod.tools(strictDsl)
        }
        catch (error) {
            violations.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    try {
        const search = await import('../lib/search.js')
        search.apply({ tools: { register: () => {} } }, strictDsl)
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 源码树缺 `yaml` / `@ast-grep/napi` 时允许跳过（安装副本里会真跑到）
        if (!/Cannot find package|ERR_MODULE_NOT_FOUND/.test(message)) violations.push(`search: ${message}`)
    }
    ok('各段交给宿主 DSL 的都是字段映射（不是原始 JSON Schema）', violations.length === 0, violations.slice(0, 2).join('；'))
}

// --- ② 动态校验：只读工具用最小参数真跑，用 schema 校验返回值 ----------------
function typeOf(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
}
function validate(schema, value, path, errs) {
    if (schema === null || typeof schema !== 'object') return
    const t = schema.type
    if (Array.isArray(t)) { // 联合类型：任一匹配即可（宿主 DSL 不支持，但我们的 schema 里可能出现）
        if (!t.includes(typeOf(value))) errs.push(`${path}: 期望 ${t.join('|')}，实际 ${typeOf(value)}`)
        return
    }
    if (t === 'object') {
        if (typeOf(value) !== 'object') { errs.push(`${path}: 期望 object，实际 ${typeOf(value)}`); return }
        const props = schema.properties ?? {}
        for (const req of schema.required ?? []) if (value[req] === undefined) errs.push(`${path}.${req}: required 但缺失`)
        for (const [k, v] of Object.entries(value)) {
            if (props[k] !== undefined) validate(props[k], v, `${path}.${k}`, errs)
            else if (schema.additionalProperties === false) errs.push(`${path}.${k}: 未声明属性（additionalProperties:false）`)
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, `${path}.${k}`, errs)
        }
        return
    }
    if (t === 'array') {
        if (!Array.isArray(value)) { errs.push(`${path}: 期望 array，实际 ${typeOf(value)}`); return }
        if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errs))
        return
    }
    if (t === 'string' && typeof value !== 'string') errs.push(`${path}: 期望 string，实际 ${typeOf(value)}`)
    if ((t === 'number' || t === 'integer') && typeof value !== 'number') errs.push(`${path}: 期望 number，实际 ${typeOf(value)}`)
    if (t === 'boolean' && typeof value !== 'boolean') errs.push(`${path}: 期望 boolean，实际 ${typeOf(value)}`)
    if (t === 'null' && value !== null) errs.push(`${path}: 期望 null，实际 ${typeOf(value)}`)
    if (schema.enum !== undefined && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} 不在 enum 内`)
}

// ⚠️ 别用 `process.env.TEMP` —— Linux 上没有这个变量，`?? '.'` 会把沙盒建在**仓库当前目录**里。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-contract-'))
const exec = { agent: { session: { header: { cwd: sandbox } } } }
writeFileSync(join(sandbox, 'a.csv'), 'k,v\na,1\nb,2\n', 'utf8')
writeFileSync(join(sandbox, 'b.csv'), 'k,v\na,1\nb,3\n', 'utf8')

// 只列**只读、无副作用**的工具（写盘类工具不在这里跑：`checkpoint` 的 create/restore/prune/journal_restore、
// `download` 的 start/probe、ast_edit、session_export 都会产生副作用）
const READ_ONLY_CALLS = {
    ast_search: { source: 'const a = 1;\nconst b = 2;\n', pattern: 'const $A = $B;', language: 'javascript' },
    ast_dump_tree: { code: 'const a = 1;', language: 'javascript' },
    ast_test_rule: { code: 'const a = 1;', yaml: 'id: t\nlanguage: javascript\nrule:\n  pattern: const $A = $B;\n' },
    toolkit_help: { topic: 'overview' },
    table_peek: { source: join(sandbox, 'a.csv') },
    table_diff: { a: join(sandbox, 'a.csv'), b: join(sandbox, 'b.csv') },
    session_list: { limit: 1 },
    session_read: { tail: 1 },          // peek+grep 合并（不给 pattern = 原 peek）
    // 合并后的只读 action（写盘的那些 action 一律不在这里跑）
    checkpoint: { action: 'list', limit: 1 },
    download: { action: 'status', limit: 1 },
}
const dynamicIssues = []
let ran = 0
for (const t of registered) {
    const args = READ_ONLY_CALLS[t.name]
    if (args === undefined) continue
    ran += 1
    let value
    try {
        value = await t.execute(args, exec)
    }
    catch (error) {
        // 允许"参数/业务/环境错误"（例如 checkpoint id 不存在、临时目录里没有会话日志）——
        // 这类抛错正是期望行为，不算契约问题
        const msg = error instanceof Error ? error.message : String(error)
        if (/does-not-exist|not found|no checkpoint|没有会话日志|no session|sessions root/.test(msg)) continue
        dynamicIssues.push(`${t.name}: 抛错 ${msg.slice(0, 80)}`)
        continue
    }
    const errs = []
    validate(t.output?.schema, value, `${t.name}()`, errs)
    if (errs.length > 0) dynamicIssues.push(...errs.slice(0, 3))
}
ok(`动态校验：${ran} 个只读工具的返回值都符合自己的 output.schema`, dynamicIssues.length === 0, dynamicIssues.slice(0, 4).join('；'))
// P0 那一类（`output.schema` 声明了 object 就必须列全真实字段）现在由 ast_search / ast_edit 覆盖；
// 原来的 ast_grep_help 已在 并入 toolkit_help（后者返回纯字符串，不再有该风险面）。
ok('动态校验确实覆盖到了 ast_search（P0 同类工具）', READ_ONLY_CALLS.ast_search !== undefined && registered.some((t) => t.name === 'ast_search'))

rmSync(sandbox, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

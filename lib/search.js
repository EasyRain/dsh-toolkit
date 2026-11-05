/**
 * AST 只读工具面 + `ast_grep_help`。
 *
 * 来源：取自 `dsh-ast-grep@0.1.0`（MIT，许可全文见包根 `THIRD-PARTY-NOTICES.md` §1.1）。**本包对它做过修改**：
 *   1) 帮助文档改为**懒加载** —— 上游在模块导入期 `readFileSync` 那份 `.mdc`，文件缺失/损坏会让整个
 *      插件 import 失败（连带 20 个工具全不挂载）；现在首次调用时才读，失败只让这一个工具降级成速记。
 *   2) 帮助小节找不到时**降级返回全文 + 提示**（上游会 `throw`），上游文档改版不会让工具整体失败。
 *   3) 其余（工具名、参数 schema、`search`/`dumpTree`/`testRule` 逻辑、语言注册表）与上游一致。
 *
 * 按 MIT 要求保留了版权与许可声明；完整来源、改动说明与许可全文见包根 `THIRD-PARTY-NOTICES.md`。
 */
import { readFileSync } from 'node:fs'
import { familyEnabled } from './configure.js'


import { parse as parseYaml } from 'yaml'

import { Lang, parse } from '@ast-grep/napi'
import { HELP_SOURCE, HELP_TOPICS, RULES_SECTION, helpTopicHeadings } from './ast/help-topics.js'
// 动态语言的注册交给 `lib/ast/lang.js`：它**逐个 import 验证 + 一次性批量注册**
// （实测 `registerDynamicLanguage` 只有第一次调用生效，所以不能在这里再注册一遍）。
// 这里只保留"语言名列表"，用于 `LANGUAGES` 与参数校验。
import './ast/lang.js'
import { toFieldMap, toJsonSchema } from './deps.js'
// `action:"diff"`（只读的"文件 vs 拟写入内容"）放在家族内的独立模块里 —— 它不改任何东西，
// 所以归这一侧，而不是 `ast_edit`。
import { diffAction, renderDiff } from './ast/diff.js'
import { ToolError } from './errors.js'

export { HELP_TOPICS, RULES_SECTION, helpTopicHeadings }

export const name = 'ast-grep-tool'
export const inject = ['tools']

const DYNAMIC_LANGUAGE_NAMES = Object.freeze([
  'angular', 'bash', 'bicep', 'c', 'cpp', 'csharp', 'dart', 'elixir',
  'glimmer-javascript', 'glimmer-typescript', 'go', 'haskell', 'java', 'json', 'kotlin', 'lua',
  'markdown', 'php', 'python', 'ruby', 'rust', 'scala', 'sql', 'swift', 'toml', 'yaml',
])

const LANGUAGES = Object.freeze({
  ...Object.fromEntries(DYNAMIC_LANGUAGE_NAMES.map((language) => [language, language])),
  css: Lang.Css,
  html: Lang.Html,
  javascript: Lang.JavaScript,
  jsx: Lang.JavaScript,
  tsx: Lang.Tsx,
  typescript: Lang.TypeScript,
})

const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(LANGUAGES))

const MAX_SOURCE_CHARS = 2_000_000
const DEFAULT_MAX_MATCHES = 50
const MAX_MATCHES = 200
const DEFAULT_MAX_MATCH_CHARS = 2_000
const MAX_MATCH_CHARS = 20_000
const DEFAULT_MAX_TREE_NODES = 500
const MAX_TREE_NODES = 5_000
const DEFAULT_MAX_TREE_DEPTH = 30
const MAX_TREE_DEPTH = 100
const MAX_RULE_YAML_CHARS = 200_000

// 帮助文档加载器**已随 ast_grep_help 一起搬走**（现由 lib/help/index.js 懒加载，同样按 mtime 失效）：
// 本模块不再碰 docs/ —— 顶层只保留 AST 检索/改写所需的 @ast-grep/napi。
// 规则主题表仍在零依赖的 lib/ast/help-topics.js 里，本模块继续 re-export 给自测用。

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`)
  }
  return value
}

function sourceAndLanguage(args, sourceKey = 'source') {
  const source = args[sourceKey]
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error(`${sourceKey} must be a non-empty string`)
  }
  if (source.length > MAX_SOURCE_CHARS) {
    throw new Error(`${sourceKey} exceeds the ${MAX_SOURCE_CHARS}-character limit`)
  }
  const language = String(args.language ?? '').toLowerCase()
  if (!(language in LANGUAGES)) {
    throw new Error(`unsupported language ${JSON.stringify(args.language)}`)
  }
  return { source, language }
}

function position(pos) {
  return { line: pos.line + 1, column: pos.column + 1, byteOffset: pos.index }
}

function debugPosition(pos) {
  return `(${pos.line},${pos.column})`
}

function dumpTree(args) {
  const { source, language } = sourceAndLanguage(args, 'code')
  const format = args.format ?? 'cst'
  if (!['pattern', 'ast', 'cst'].includes(format)) {
    throw new Error('format must be pattern, ast, or cst')
  }
  const maxNodes = integer(args.max_nodes, DEFAULT_MAX_TREE_NODES, 1, MAX_TREE_NODES, 'max_nodes')
  const maxDepth = integer(args.max_depth, DEFAULT_MAX_TREE_DEPTH, 1, MAX_TREE_DEPTH, 'max_depth')
  const root = parse(LANGUAGES[language], source).root()
  const namedOnly = format === 'ast'
  const lines = [`Debug ${format.toUpperCase()}:`]
  let count = 0
  let hitNodeCap = false
  let hitDepthCap = false
  const visit = (node, depth) => {
    if (count >= maxNodes) {
      hitNodeCap = true
      return
    }
    if (depth > maxDepth) {
      hitDepthCap = true
      return
    }
    count += 1
    const value = node.range()
    const label = format === 'pattern'
      ? `${node.kind()} ${node.text()}`.trimEnd()
      : `${node.kind()} ${debugPosition(value.start)}-${debugPosition(value.end)}`
    lines.push(`${'  '.repeat(depth)}${label}`)
    const children = namedOnly ? node.namedChildren() : node.children()
    for (const child of children) visit(child, depth + 1)
  }
  visit(root, 0)
  // 说清**为什么**被截断（上游一律写成 "at depth N"，用 max_nodes 触发时会误导）
  if (hitNodeCap || hitDepthCap) {
    const reasons = []
    if (hitNodeCap) reasons.push(`max_nodes=${maxNodes}`)
    if (hitDepthCap) reasons.push(`max_depth=${maxDepth}`)
    lines.push(`... truncated after ${count} nodes (${reasons.join(' + ')} reached); raise the cap or narrow the code`)
  }
  return lines.join('\n')
}

function parseRuleYaml(yaml) {
  if (typeof yaml !== 'string' || yaml.length === 0) throw new Error('yaml must be a non-empty string')
  if (yaml.length > MAX_RULE_YAML_CHARS) throw new Error(`yaml exceeds the ${MAX_RULE_YAML_CHARS}-character limit`)
  let config
  try {
    config = parseYaml(yaml)
  } catch (error) {
    throw new Error(`invalid rule YAML: ${error.message}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('rule YAML must be an object')
  if (typeof config.id !== 'string' || !config.id) throw new Error('rule YAML must have a non-empty id')
  if (typeof config.language !== 'string' || !(config.language.toLowerCase() in LANGUAGES)) {
    throw new Error(`unsupported language ${JSON.stringify(config.language)}`)
  }
  if (!config.rule || typeof config.rule !== 'object' || Array.isArray(config.rule)) {
    throw new Error('rule YAML must have a rule object')
  }
  return { ...config, language: config.language.toLowerCase() }
}

function cliRange(node) {
  const value = node.range()
  return {
    byteOffset: { start: value.start.index, end: value.end.index },
    start: { line: value.start.line, column: value.start.column },
    end: { line: value.end.line, column: value.end.column },
  }
}

function metavariableNames(value, names = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\$+(?!_)([A-Z][A-Z0-9_]*)/g)) names.add(match[1])
  } else if (Array.isArray(value)) {
    for (const item of value) metavariableNames(item, names)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) metavariableNames(item, names)
  }
  return names
}

function testRule(args) {
  if (typeof args.code !== 'string' || args.code.length === 0) throw new Error('code must be a non-empty string')
  if (args.code.length > MAX_SOURCE_CHARS) throw new Error(`code exceeds the ${MAX_SOURCE_CHARS}-character limit`)
  const config = parseRuleYaml(args.yaml)
  const matcher = { rule: config.rule, constraints: config.constraints, utils: config.utils }
  const nodes = parse(LANGUAGES[config.language], args.code).root().findAll(matcher)
  // 0 命中**不是错误** —— 这个工具的用途就是"试规则"：返回空数组，由 render 给出可操作的建议。
  // （上游实现直接 throw，表现为"工具执行失败"，会让调用方误以为规则写坏了或工具坏了。）
  if (nodes.length === 0) return []
  const names = [...metavariableNames(matcher)]
  return nodes.map((node) => ({
    text: node.text(),
    range: cliRange(node),
    file: 'STDIN',
    language: config.language,
    metaVariables: {
      single: Object.fromEntries(names.flatMap((name) => {
        const value = node.getMatch(name)
        return value ? [[name, { text: value.text(), range: cliRange(value) }]] : []
      })),
      multi: Object.fromEntries(names.flatMap((name) => {
        // 实测语义：单节点元变量的 getMultipleMatches() 返回 0；多节点元变量捕获 1 个时返回 1。
        // 上游写成 `> 1` ⇒ **只捕获一个节点时该元变量在输出里彻底消失**（没法确认它捕获了什么）。
        const values = node.getMultipleMatches(name)
        return values.length > 0
          ? [[name, values.map((value) => ({ text: value.text(), range: cliRange(value) }))]]
          : []
      })),
      transformed: {},
    },
    ruleId: config.id,
    severity: config.severity ?? 'hint',
    note: config.note ?? null,
    message: config.message ?? '',
  }))
}

function range(node) {
  const value = node.range()
  return { start: position(value.start), end: position(value.end) }
}

function clippedText(text, limit) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/**
 * 匹配文本按 `text_mode` 裁剪（paths 与内联两个模式共用）：
 *  - `line`（默认）：**只给第一行** —— 结构查询里多行节点原文能吃掉绝大部分 token
 *    （实测 20 条 `if ($COND) { $$$BODY }` = 2,737 token ≈ 137/条），而"这种结构在哪"只想要位置 + 首行；
 *  - `node`：整段节点原文（旧行为；要看完整上下文/整段改写时才用）；
 *  - `none`：不给 `text` 字段（只要 file/line/kind 的清单）。
 * 多行节点被压成一行时 `truncated: true` —— **如实说明"这不是完整原文"**，别被当成节点全文。
 */
function textForNode(node, mode, limit) {
  if (mode === 'none') return {}
  const full = node.text()
  if (mode === 'node') return clippedText(full, limit)
  const firstLine = full.split(/\r?\n/, 1)[0]
  const clipped = clippedText(firstLine, limit)
  return { text: clipped.text, truncated: clipped.truncated || firstLine.length !== full.length }
}

/** 没要捕获就不输出空对象（每条匹配省一个 `"captures":{}`） */
function capturesFor(input, node) {
  if (input.captureNames.length === 0) return {}
  return {
    captures: Object.fromEntries(input.captureNames.map((name) => [name, capture(node, name, input.maxMatchChars)])),
  }
}

function capture(node, name, limit) {
  const many = node.getMultipleMatches(name)
  const values = many.length > 0 ? many : [node.getMatch(name)].filter(Boolean)
  return values.map((value) => ({
    ...clippedText(value.text(), limit),
    kind: value.kind(),
    range: range(value),
  }))
}

function normalizeArgs(args) {
  const hasPaths = Array.isArray(args?.paths) && args.paths.length > 0
  if (hasPaths && typeof args?.source === 'string' && args.source !== '') {
    throw new Error('给 source（内联源码）或 paths（文件/目录/glob）之一，不要同时给：paths 模式下语言按文件扩展名自动判定')
  }
  if (!hasPaths) {
 // **observation（MCMOD 实测）**：把文件路径/glob 当 source 传进来会**静默 0 命中**
    // （路径字符串被当成源码解析）。这里直接报错并指路，而不是给一个看着正常的 count:0。
    const raw = args?.source
    if (typeof raw === 'string' && raw !== '' && !raw.includes('\n') && raw.length < 512) {
      const looksPath = /[*?]/.test(raw) || /\.(java|kt|ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|php|cs|c|h|cpp|hpp|lua|json|ya?ml|toml|md|sql|sh|swift|scala|dart|hs|ex|exs|bicep|css|html)$/i.test(raw)
      if (looksPath) {
        throw new Error(`source 看起来是**文件路径或 glob**（${JSON.stringify(raw.slice(0, 80))}）—— 它会被当成源码字符串解析（结果恒为 0 命中）。要在文件里找结构请改用 paths: [${JSON.stringify(raw)}]（语言按扩展名自动判定）`)
      }
    }
  }
  const { source, language } = hasPaths
    ? { source: '', language: String(args.language ?? '').toLowerCase() }
    : sourceAndLanguage(args)
  if (hasPaths && language !== '' && !(language in LANGUAGES)) {
    throw new Error(`unsupported language ${JSON.stringify(args.language)}`)
  }
  const pattern = args.pattern
  const validPattern = typeof pattern === 'string'
    ? pattern.length > 0
    : pattern && typeof pattern === 'object' && !Array.isArray(pattern) &&
      typeof pattern.context === 'string' && pattern.context.length > 0
  if (!validPattern) {
    throw new Error('pattern must be a non-empty string or an object with non-empty context')
  }
  const captureNames = args.capture_names ?? []
  if (!Array.isArray(captureNames) || captureNames.length > 20) {
    throw new Error('capture_names must be an array with at most 20 entries')
  }
  const uniqueCaptureNames = [...new Set(captureNames)]
  for (const captureName of uniqueCaptureNames) {
    if (typeof captureName !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(captureName)) {
      throw new Error('capture_names entries must omit $ and use uppercase metavariable names')
    }
  }
  return {
    source,
    paths: hasPaths ? args.paths.map((p) => String(p)) : null,
    pattern,
    language,
    includeVendored: args.include_vendored === true || args.includeVendored === true,
    offset: integer(args.offset, 0, 0, MAX_PATH_OFFSET, 'offset'),
    textMode: normalizeTextMode(args.text_mode ?? args.textMode),
    captureNames: uniqueCaptureNames,
    maxMatches: integer(args.max_matches, DEFAULT_MAX_MATCHES, 1, MAX_MATCHES, 'max_matches'),
    maxMatchChars: integer(
      args.max_match_chars,
      DEFAULT_MAX_MATCH_CHARS,
      1,
      MAX_MATCH_CHARS,
      'max_match_chars',
    ),
  }
}

/**
 * paths 模式的**每页文件数**：一页最多搜这么多文件（超过就报 limitReached + nextOffset，**不静默截断**）。
 * 用 `offset` 取下一页：文件列表按路径排序（`collectFiles` 返回前 `.sort()`），所以翻页**稳定可续**、不重不漏。
 */
const MAX_PATH_FILES = 500
/** `offset` 的合理上界（防手滑写出天文数字让遍历白跑） */
const MAX_PATH_OFFSET = 100_000
/** `text_mode` 的取值 */
const TEXT_MODES = ['line', 'node', 'none']
const normalizeTextMode = (raw) => (typeof raw === 'string' && TEXT_MODES.includes(raw.toLowerCase()) ? raw.toLowerCase() : 'line')

/**
 * 在**文件/目录/glob** 里找结构（新增，MCMOD 评审建议 2）：
 * 直接回答"这种语法结构在哪" —— 返回 `file` + 1-based 行列 + 片段，语言按扩展名自动判定。
 */
async function searchInPaths(input, exec) {
  const { collectFiles } = await import('./glob.js')
  const { langForFile } = await import('./ast/lang.js')
  const cwd = (() => {
    try { return exec?.agent?.session?.header?.cwd ?? process.cwd() } catch { return process.cwd() }
  })()
  const collected = await collectFiles(input.paths, {
    cwd,
    // 多收 `offset` 个文件，才能在**排序后的稳定列表**上切出第 offset 页（不重不漏）
    maxFiles: input.offset + MAX_PATH_FILES,
    // includeVendored:true 才连同 node_modules 一起搜（缺省跳过 —— 依赖目录多半是噪声；
    // 但**显式在 paths 里写 node_modules** 时也允许，规则见 glob.js 的 collectFiles）
    ...(input.includeVendored === true ? { allowNodeModules: true } : {}),
  })
  const page = collected.files.slice(input.offset, input.offset + MAX_PATH_FILES)
  // 还有没有下一页：要么收集时就被上限截断，要么这一页之后仍有文件
  const moreFiles = collected.limitReached === true || collected.files.length > input.offset + page.length
  const matcher = typeof input.pattern === 'string' ? input.pattern : { rule: { pattern: input.pattern } }
  const matches = []
  const skipped = []
  let count = 0
  let filesWithHits = 0
  for (const file of page) {
    let language = input.language
    if (language === '') {
      const inferred = langForFile(file)
      if (inferred === null || inferred === undefined) { skipped.push(`${file}: 扩展名不支持（用 language 显式指定）`); continue }
      language = inferred
    }
    let text
    try {
      const { readFile } = await import('node:fs/promises')
      text = await readFile(file, 'utf8')
    }
    catch (error) { skipped.push(`${file}: 读不了（${error instanceof Error ? error.message : String(error)}）`); continue }
    if (text.length > MAX_SOURCE_CHARS) { skipped.push(`${file}: 超过 ${MAX_SOURCE_CHARS} 字符，跳过`); continue }
    let root
    try { root = parse(language, text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).root() }
    catch (error) { skipped.push(`${file}: 解析失败（${error instanceof Error ? error.message : String(error)}）`); continue }
    const found = root.findAll(matcher)
    if (found.length === 0) continue
    count += found.length
    filesWithHits += 1
    for (const node of found) {
      if (matches.length >= input.maxMatches) break
      const r = node.range()
      const path = await import('node:path')
      matches.push({
        file: path.relative(cwd, file) || file,
        line: r.start.line + 1,
        column: r.start.column + 1,
        ...textForNode(node, input.textMode, input.maxMatchChars),
        kind: node.kind(),
 // ⚠️ 只调一次 `capture(node, name, …)`（MCMOD 复核抓到的回归：这里曾写成
        // `capture(name, …) ? capture(node, name, …) : undefined` —— **参数错位**，把字符串当 node
        // 传给 `node.getMultipleMatches` ⇒ 带 `capture_names` 的 paths 查询 100% 抛 TypeError；
        // 而且那个探针调用本身就是多余的重复提取）。
        ...capturesFor(input, node),
      })
    }
  }
  return {
    language: input.language === '' ? 'per-file' : input.language,
    count,
    truncated: count > matches.length,
    filesSearched: page.length,
    filesWithHits,
    limitReached: moreFiles,
    // 分页：文件按路径排序，`nextOffset` 传回来就是下一页（不重不漏）；没有下一页就不给这个字段
    offset: input.offset,
    ...(moreFiles ? { nextOffset: input.offset + page.length } : {}),
    // 如实回报被跳过的依赖目录：**静默漏文件比搜得慢危险得多**
    nodeModulesSkipped: collected.nodeModulesSkipped ?? 0,
    // `skipped` 只列前 10 条明细；**总数**另外给（否则"跳过了 300 个"和"跳过了 10 个"看起来一样）
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 10),
    matches,
  }
}

function search(args) {
  const input = normalizeArgs(args)
  const root = parse(LANGUAGES[input.language], input.source).root()
  const matcher = typeof input.pattern === 'string' ? input.pattern : { rule: { pattern: input.pattern } }
  const found = root.findAll(matcher)
  const selected = found.slice(0, input.maxMatches)
  return {
    language: input.language,
    count: found.length,
    truncated: found.length > selected.length,
    matches: selected.map((node) => ({
      ...textForNode(node, input.textMode, input.maxMatchChars),
      kind: node.kind(),
      range: range(node),
      ...capturesFor(input, node),
    })),
  }
}

export function apply(ctx, defineTool = null) {
  // A-3：统一注册契约 —— 这 4 个工具的参数以前是**原始 JSON Schema** 直接交给 ctx.tools.register，
  // 绕过 defineTool ⇒ 宿主不做入参校验（`code: 42` 之类会漏进工具体，报错语义与其它 16 个工具不一致）。
  // 现在翻译成字段映射方言后交给 defineTool；未传 defineTool 时保持旧行为（源码树自测用）。
  // 返回**实际注册的工具名**（X-1：入口信标要用它写真实名单，本模块没有 tools() 可调）。
  const registered = []
  const put = (tool) => {
 // 本段**直接**调 ctx.tools.register（不像其它段那样只走 defineTool）⇒
    // 配置关掉 `ast` 族时必须在这里就停住，否则会用**字段映射方言**注册出去、
    // 让宿主整个请求 INVALID_REQUEST（实测）。
    if (!familyEnabled('ast')) return
    registered.push(tool.name)
    if (typeof defineTool === 'function') {
      try {
        ctx.tools.register(defineTool({ ...tool, parameters: toFieldMap(tool.parameters) }))
        return
      }
      catch (error) {
 // **降级兜底**（实测教训）：宿主 DSL 若拒收某个键（`minimum`、`oneOf`、
        // object schema 缺 `additionalProperties`…），以前会让这 4 个工具**整段消失**。
        // 退回时必须产出**合法 JSON Schema**（字段映射形状的 parameters 会让模型 API 报
        // `schema must be a JSON Schema of 'type: "object"', got 'type: null'` ⇒ 连会话都开不了）。
        const reason = error instanceof Error ? error.message : String(error)
        if (typeof console?.warn === 'function') console.warn(`dsh-toolkit: defineTool rejected ${tool.name} (${reason}); registered with a normalized schema`)
        const safe = { ...tool, description: `${tool.description} [schema validation disabled: ${reason}]` }
        if (safe.parameters && typeof safe.parameters === 'object') safe.parameters = toJsonSchema(safe.parameters)
        if (safe.output && typeof safe.output === 'object' && safe.output.schema) safe.output = { ...safe.output, schema: toJsonSchema(safe.output.schema) }
        ctx.tools.register(safe)
        return
      }
    }
    ctx.tools.register(tool)
  }
  put({
    name: 'ast_dump_tree',
    description:
      'Dump code syntax structure or pattern structure using the same parser as ast_search. ' +
      'Use cst for concrete syntax, ast for named nodes, and pattern to inspect pattern parsing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Code or pattern text to inspect.' },
        language: { type: 'string', enum: SUPPORTED_LANGUAGES, description: 'Parser for `code` (required; nothing is inferred from a bare snippet).' },
        format: { type: 'string', enum: ['pattern', 'ast', 'cst'], description: 'Defaults to cst.' },
        max_nodes: { type: 'integer', minimum: 1, maximum: MAX_TREE_NODES },
        max_depth: { type: 'integer', minimum: 1, maximum: MAX_TREE_DEPTH },
      },
      required: ['code', 'language'],
    },
    output: {
      schema: { type: 'string', description: 'Bounded syntax tree dump.' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => dumpTree(args ?? {}),
  })

  put({
    name: 'ast_test_rule',
    description:
      'Test an ast-grep YAML rule against an inline code snippet using @ast-grep/napi. ' +
      'The YAML must contain id, language, and rule fields.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'Code to test.' },
        yaml: { type: 'string', description: 'ast-grep YAML rule with id, language, and rule fields.' },
      },
      required: ['code', 'yaml'],
    },
    output: {
      schema: { type: 'array', description: 'Matches in ast-grep CLI-compatible zero-based ranges.' },
      render: (_args, value) => [{
        type: 'text',
        // 0 命中是**合法结果**（试规则的目的就是看它匹配什么）；给出可操作的建议，而不是报"执行失败"
        text: Array.isArray(value) && value.length === 0
          ? 'No matches. The rule parsed fine — check `pattern` / `kind` / `strictness`; if you used `inside` or `has`, add `stopBy: end` (that is the most common reason for zero matches).'
          // ⚠️ 以前这里直接把上游 JSON 原样打出来：一条命中 ≈ **331 tok**（嵌套两套 range + metaVariables 三个空壳），
          // 而它要回答的只是"命中没、命中了什么"。现在渲染成一行/命中（区间 + 元变量），值本身仍是原 JSON。
          : value.map((m) => {
            const vars = Object.entries(m?.metaVariables?.single ?? {})
              .map(([k, v]) => `${k}=${String(v?.text ?? '').replace(/\s+/g, ' ').slice(0, 40)}`)
              .join(' ')
            const start = m?.range?.start ?? {}
            const end = m?.range?.end ?? {}
            const where = `${m?.file ?? 'STDIN'} ${(start.line ?? 0) + 1}:${(start.column ?? 0) + 1}-${(end.line ?? 0) + 1}:${(end.column ?? 0) + 1}`
            return `${m?.ruleId ?? 'rule'} @ ${where} · ${String(m?.text ?? '').replace(/\s+/g, ' ').slice(0, 60)}${vars ? `  [${vars}]` : ''}`
          }).join('\n'),
      }],
    },
    execute: async (args) => testRule(args ?? {}),
  })


  put({
    name: 'ast_search',
    description:
      'Read-only AST tool. action "grep" (default): find nodes matching an ast-grep pattern (inline source or paths). ' +
      'action "diff": compare one file with `content` (unified diff + revisions, nothing written). ' +
      'Metavariables: $EXPR, $$$ARGS. For complex rules or a failed pattern call toolkit_help ' +
      '(topics: workflow, metavariables, rule-object).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['grep', 'diff'],
          description: 'grep (default): find matches. diff: compare one file with `content` — nothing staged or written; use it before a whole-file rewrite, where there is no pattern.',
        },
        content: {
          type: 'string',
          description: 'action:"diff" only: the content you are about to write (BOM/CRLF accounted for).',
        },
        source: { type: 'string', description: 'Inline source text (give source or paths, not both).' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files, directories or globs (instead of inline source); language inferred per file. Answers "where is this structure".',
        },
        pattern: {
 // ⚠️ 宿主 DSL **不支持联合类型**（真宿主实测：`parameters.pattern.type must be
          // string/number/integer/boolean/null/array/object` ⇒ 该工具被 defineTool 拒收、退回"无 schema"
          // 注册 ⇒ 模型 API 报 `Invalid schema for function … type: null` ⇒ **整个会话起不来**）。
          // 所以 schema 只广告字符串形态；对象形态（context/selector/strictness）由工具体继续接受，
          // 说明写在 description 里（校验仍在 `normalizeArgs`）。
          type: 'string',
          description: 'ast-grep pattern string. Object form {context, selector, strictness} works at runtime but is not advertised here (the host schema DSL rejects unions).',
        },
        language: {
          type: 'string',
          enum: SUPPORTED_LANGUAGES,
          description: 'Parser language. jsx is an alias of javascript; tsx is not typescript.',
        },
        include_vendored: {
          type: 'boolean',
          description: 'Also search node_modules (default false; skipped dirs are counted). Naming one in paths includes it.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Skip this many files (stable path order); pass a previous nextOffset to continue a capped search.',
        },
        text_mode: {
          type: 'string',
          description: 'Match text: line (default) = first line only (truncation marked); node = whole node source; none = no text (file/line/kind only).',
        },
        capture_names: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string' },
          description: 'Optional uppercase metavariable names without $, for example ["FN", "ARGS"].',
        },
        max_matches: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MATCHES,
          description: 'Maximum returned matches; defaults to 50. The total count is still reported.',
        },
        max_match_chars: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_MATCH_CHARS,
          description: 'Maximum text returned per match or capture; defaults to 2000.',
        },
      },
      // ⚠️ **不要**在这里写 `required: ['pattern']`：宿主会在**分派之前**按 schema 校验，
      // 而 `action:"diff"` 根本不需要 pattern —— 真宿主实测会直接报
      // `invalid arguments: missing required property "pattern"`。
      // 按 action 变化的必填参数只能在**工具体内**校验（`checkpoint`/`download` 同一条规矩）：
      // grep ⇒ pattern 必填（`normalizeArgs` 抛错，措辞已含"non-empty string"）；diff ⇒ paths + content 必填。
    },
    output: {
 // ⚠️ **output.schema 会校验返回值**（真宿主实测：只写 `{type:'object',
      // additionalProperties:false}` 会把 `language/count/truncated/matches` 全判成"未声明属性"⇒
      // 工具**拿不到结果**、只报 schema 错。所以必须把真实形状声明出来）。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          language: { type: 'string' },
          count: { type: 'number' },
          truncated: { type: 'boolean' },
 // paths 模式才有的字段（新增）：必须声明齐，否则宿主按 additionalProperties:false 拒收返回值
          filesSearched: { type: 'number' },
          filesWithHits: { type: 'number' },
          limitReached: { type: 'boolean' },
          offset: { type: 'number' },
          nextOffset: { type: 'number' },
          nodeModulesSkipped: { type: 'number' },
          skippedCount: { type: 'number' },
          skipped: { type: 'array', items: { type: 'string' } },
          matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          // action:"diff" 才有（`action` 与 `message` 两种动作共用）
          action: { type: 'string' },
          message: { type: 'string' },
          diff: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              identical: { type: 'boolean' },
              eolOnly: { type: 'boolean' },
              tailOnly: { type: 'boolean' },
              added: { type: 'number' },
              removed: { type: 'number' },
              approximate: { type: 'boolean' },
              eol: {
                type: 'object',
                additionalProperties: false,
                properties: { before: { type: 'string' }, after: { type: 'string' } },
              },
              before: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  bytes: { type: 'number' },
                  lineCount: { type: 'number' },
                  revision: { type: 'string' },
                  bom: { type: 'boolean' },
                },
              },
              after: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  bytes: { type: 'number' },
                  lineCount: { type: 'number' },
                  revision: { type: 'string' },
                },
              },
            },
          },
        },
        description: 'Structured ast-grep match results, or a file-vs-content diff (action:"diff").',
      },
      render: (_args, value) => {
        // action:"diff"：表头 + unified diff 正文（路径只出现一次）
        if (value !== null && typeof value === 'object' && value.action === 'diff' && value.diff !== undefined) {
          return [{ type: 'text', text: renderDiff(value) }]
        }
        const text = JSON.stringify(value, null, 2)
        // 跳过了依赖目录就**说出来**（静默漏文件比搜得慢危险得多）
        const skipNote = value !== null && typeof value === 'object' && (value.nodeModulesSkipped ?? 0) > 0
          ? `\n\n（已跳过 ${value.nodeModulesSkipped} 个 node_modules 目录 —— 依赖目录默认不搜。要一起搜就加 include_vendored:true，或把那个 node_modules 路径直接写进 paths。）`
          : ''
        // 撞了每页 500 文件的上限就**明确给出下一页怎么取**（而不是只说"被截断"）
        const nextNote = value !== null && typeof value === 'object' && Number.isFinite(value.nextOffset)
          ? `\n\n（这一页搜了 ${value.filesSearched} 个文件，**还有更多**：用 offset:${value.nextOffset} 接着搜 —— 文件按路径排序，翻页不重不漏。）`
          : ''
        // 被跳过的文件**不止**明细里那几条时，把总数说出来（否则"跳过 300 个"和"跳过 10 个"看起来一样）
        const skippedNote = value !== null && typeof value === 'object' && (value.skippedCount ?? 0) > (value.skipped?.length ?? 0)
          ? `\n\n（另有 ${(value.skippedCount ?? 0) - (value.skipped?.length ?? 0)} 个文件被跳过，明细只列前 ${value.skipped?.length ?? 0} 条 —— 常见原因：扩展名不支持、超过大小上限、读不了。）`
          : ''
        if (value !== null && typeof value === 'object' && value.count === 0) {
 // **0 命中是最容易白跑一轮的地方**（MCMOD 实测观察 1/2）：列常见原因，直接指路
          return [{
            type: 'text',
            text: `${text}\n\n0 命中 —— 常见原因（按概率）：\n`
              + '  1) pattern 不是**完整节点**：只写 `protected $RET $NAME($$$ARGS)`（没有方法体）会静默不匹配，试补 `{ $$$BODY }`；\n'
              + '  2) 语言/解析器选错：`jsx` 与 `javascript`、`tsx` 与 `typescript` 是不同解析器；\n'
              + '  3) 想搜**文件**却把路径传给了 `source`（会被当源码，恒 0 命中）⇒ 用 `paths: ["src/**/*.java"]`；\n'
              + '  4) 复杂规则先看 `toolkit_help {topic:"rule-object"}`（或 metavariables / relational / workflow / ast-rules）。',
          }]
        }
        return [{ type: 'text', text: `${text}${skipNote}${skippedNote}${nextNote}` }]
      },
    },
    execute: async (args, exec) => {
      // `action:"diff"` 归只读侧（它不改任何东西）；默认仍是 grep，旧调用不用改。
      const action = args?.action ?? 'grep'
      if (action === 'diff') return diffAction(args ?? {}, exec)
      if (action !== 'grep') throw new ToolError(`unknown action ${String(action)}（可用：grep | diff）`)
      // 必填在**这里**校验（不能挂到 schema 的 `required` 上，否则 diff 会被宿主先拒掉）
      if (args?.pattern === undefined || args?.pattern === null) {
        throw new ToolError('action:"grep" 需要 `pattern`（ast-grep 模式）；要比较"文件 vs 拟写入内容"请用 action:"diff" + paths + content')
      }
      const input = normalizeArgs(args ?? {})
      return input.paths === null ? search(args ?? {}) : await searchInPaths(input, exec)
    },
  })
  return registered
}

export { dumpTree, search, testRule }

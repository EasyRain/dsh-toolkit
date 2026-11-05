/**
 * 集中依赖再导出（原 `lib/edit/deps.js`，随自研化搬到 `lib/deps.js`）。
 *
 * `@deepseek-ai/dsh-tools` 是 harness 内部包，随 app 打包，**从 profile 的 node_modules 解析不到**。
 * 早先这里写的是静态 import，一旦解析失败整行插件都加载不了（还会把搜索工具一起带走）。
 * 所以改成"能拿到就用、拿不到就用**形状等价**的兜底"：
 *  - 真 `defineTool`：做参数/输出 schema 校验（`parameters` 必须是**字段映射方言**，给原始 JSON Schema
 * 会被拒 —— 实测踩过）；
 * - 兜底（子代理审计 A-2 修）：**不再返回裸恒等函数**。恒等函数会让 15 个工具丢全部入参校验，
 *    而且 `output.schema` 还是字段映射形状 ⇒ 宿主 `register()` 的 `assertSupportedJsonSchema` 会直接
 *    **拒绝注册**（工具静默消失）。现在兜底会把字段映射**翻译成宿主接受的 JSON Schema**，
 *    并把"用的是兜底"这件事暴露出去（`defineToolKind`）。
 */

/** 字段映射方言 → JSON Schema（宿主 register 与校验都认这个形状） */
export function toJsonSchema(fieldMap) {
    if (fieldMap === null || typeof fieldMap !== 'object') return fieldMap
    // 已经是 JSON Schema：补齐宿主要求的 additionalProperties 后原样返回
    if (fieldMap.type !== undefined || fieldMap.properties !== undefined) {
        if (fieldMap.type === 'object' && fieldMap.additionalProperties === undefined) {
            // 宿主实测要求 object schema **显式**声明 additionalProperties（真/假）。这里默认给 **true**：
            // 这条分支既可能吃到"参数 schema"也可能吃到"输出 schema"，而我们没有 properties 可声明时
            // 用 false 会把合法数据判成"未声明属性"（`ast_search` 的返回值就这样被拒过一次）。
            // 宽容只会少一层严格，不会毁功能；合成路径（字段映射 → schema）仍用 false（参数天然闭合）。
            return { ...fieldMap, additionalProperties: true }
        }
        return fieldMap
    }
    const properties = {}
    const required = []
    for (const [name, spec] of Object.entries(fieldMap)) {
        if (spec === null || typeof spec !== 'object') { properties[name] = { type: 'string' }; continue }
        const { required: isRequired, ...rest } = spec
        properties[name] = rest
        if (isRequired === true) required.push(name)
    }
    const schema = { type: 'object', properties, additionalProperties: false }
    if (required.length > 0) schema.required = required
    return schema
}

const identity = (tool) => tool

/** 兜底实现：翻译 dialect，保证注册出来的形状与真 defineTool 一致 */
/** 把被过滤掉的键写成**人/模型可读**的补充说明（挂在 description 末尾） */
function describeDropped(spec) {
    const parts = []
    const min = spec.minimum
    const max = spec.maximum
    if (min !== undefined && max !== undefined) parts.push(`${min}..${max}`)
    else if (min !== undefined) parts.push(`≥${min}`)
    else if (max !== undefined) parts.push(`≤${max}`)
    if (spec.maxItems !== undefined) parts.push(`最多 ${spec.maxItems} 项`)
    if (spec.minItems !== undefined && spec.minItems > 0) parts.push(`至少 ${spec.minItems} 项`)
    if (spec.pattern !== undefined) parts.push(`形如 ${spec.pattern}`)
    if (spec.default !== undefined) parts.push(`默认 ${JSON.stringify(spec.default)}`)
    return parts.length > 0 ? `（${parts.join('，')}）` : ''
}

/**
 * JSON Schema → 字段映射方言（真 `defineTool` 要的形状）—— 审计 A-3：让 search 的 4 个工具也走统一契约。
 *
 * ⚠️ 宿主 DSL **只接受一部分键**（实测：`parameters.max_nodes.minimum is not supported by
 * the value schema DSL` ⇒ 整个 search 段注册失败、AST 检索族全没）。所以这里**白名单过滤**：
 * 只保留 `type/description/required/items/enum/default`，其余丢掉但**写进 description**，
 * 模型仍能看到边界；真正的越界校验在工具体里（`integer(args.x, …)`），行为不变。
 */
const DSL_KEYS = new Set(['type', 'description', 'required', 'items', 'enum', 'default'])
export function toFieldMap(jsonSchema) {
    if (jsonSchema === null || typeof jsonSchema !== 'object') return jsonSchema
    if (jsonSchema.type !== 'object' || jsonSchema.properties === undefined) return jsonSchema
    const required = new Set(jsonSchema.required ?? [])
    const out = {}
    for (const [name, spec] of Object.entries(jsonSchema.properties)) {
        if (spec === null || typeof spec !== 'object') { out[name] = { type: 'string' }; continue }
        const kept = {}
        for (const [k, v] of Object.entries(spec)) {
            if (k === 'required') continue
            if (DSL_KEYS.has(k)) kept[k] = k === 'items' && v && typeof v === 'object' ? toFieldMapValue(v) : v
        }
        const extra = describeDropped(spec)
        if (extra) kept.description = `${kept.description ?? ''}${kept.description ? ' ' : ''}${extra}`.trim()
        if (required.has(name)) kept.required = true
        out[name] = kept
    }
    return out
}

/** 数组项的值 schema 也过滤一遍 */
function toFieldMapValue(spec) {
    const kept = {}
    for (const [k, v] of Object.entries(spec)) if (DSL_KEYS.has(k)) kept[k] = v
    return kept
}

function fallbackDefineTool(tool) {
    const out = { ...tool }
    if (tool?.parameters && typeof tool.parameters === 'object') out.parameters = toJsonSchema(tool.parameters)
    if (tool?.output && typeof tool.output === 'object' && tool.output.schema) {
        out.output = { ...tool.output, schema: toJsonSchema(tool.output.schema) }
    }
    return out
}

let defineTool = fallbackDefineTool
let defineToolKind = 'fallback'

try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') { defineTool = mod.defineTool; defineToolKind = 'real' }
}
catch {
    // 保留兜底实现
}

export { defineTool, defineToolKind }

/**
 * 把 `defineTool` 包成**永不抛错**的版本（审计 A-2 的彻底解法）。
 *
 * 背景：宿主 DSL 会拒绝它不认识的键（实测 `parameters.max_nodes.minimum is not supported by the
 * value schema DSL`；也不支持 `oneOf` 联合类型、要求 object schema 显式声明 `additionalProperties`），
 * 而 defineTool 抛错会让**整个 section 的工具全没**（AST 检索族就这样消失过一次）。
 *
 * ⚠️ 退回时**必须产出宿主可接受的形状**（分叉会话实测教训）：如果直接把"未包装对象"
 * 注册进去，字段映射形状的 `parameters` 会让模型 API 报
 * `Invalid schema for function 'x': schema must be a JSON Schema of 'type: "object"', got 'type: null'`
 * ⇒ **新宿主连会话都开不起来**。所以这里用 `toJsonSchema()` 把 parameters / output.schema 都翻译成
 * 合法 JSON Schema（含 `additionalProperties`），只是失去了宿主级入参校验（工具体内仍有校验）。
 */
export function makeSafeDefineTool(defineTool, onError = null) {
    return (tool) => {
        try {
            return defineTool(tool)
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            if (typeof onError === 'function') {
                try { onError(tool?.name ?? '?', reason) }
                catch { /* 记录失败不影响注册 */ }
            }
            const safe = { ...tool, description: `${tool?.description ?? ''} [schema validation disabled: ${reason}]`.trim() }
            if (safe.parameters && typeof safe.parameters === 'object') safe.parameters = toJsonSchema(safe.parameters)
            if (safe.output && typeof safe.output === 'object' && safe.output.schema) {
                safe.output = { ...safe.output, schema: toJsonSchema(safe.output.schema) }
            }
            return safe
        }
    }
}

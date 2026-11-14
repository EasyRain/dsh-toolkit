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

/**
 * 字段映射方言 → JSON Schema（宿主 register 与校验都认这个形状）。
 *
 * ⚠️ 必须**递归**：`required` 是对象级关键字（string 数组），属性里出现布尔
 * `required: true` 会被严格 provider（中转站 / new-api / Go 网关）判非法，典型报错
 * `Invalid schema for function 'file': true is not of type "array"`。这里递归把**任何层级**
 * 的布尔 `required` 上提到所属对象的 `required` 数组，绝不泄露给 provider。
 */
/**
 * 去掉**嵌套**的 `required`（只保留根节点那一层）。
 *
 * 为什么：宿主 0.2.2-rc.3 起，工具参数由它自己的 value-schema DSL 编译，**只有根节点**允许
 * `required: [...]`；数组 items 的对象里再出现 `required`（数组或布尔都不确定被接受）会被判
 * "parameters.<字段>.items.required is not supported by the value schema DSL"，
 * 整条注册被拒（实测 rc.3 上 `ast_edit` 与 `file` 就是这样退化成"schema 校验被禁用"的兜底注册）。
 *
 * 取舍：嵌套必填**不再由 schema 表达**，改由运行时校验 + 字段描述兜底（edit 的 oldText/newText、
 * ast_edit 的 pat/out 都在描述里写明了）。好处是注册形状对宿主/严格 provider 都绝对安全。
 * 纯函数：不修改入参。
 */
export function stripNestedRequired(schema, depth = 0) {
    if (schema === null || typeof schema !== 'object') return schema
    if (Array.isArray(schema)) return schema.map((item) => stripNestedRequired(item, depth))
    const out = {}
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'required') {
            // 只保留两层：根对象的 `required: [...]`，以及**字段映射**里每个字段的 `required: true`。
            // 再深（数组 items 的对象、其 properties…）一律丢弃——宿主 rc.3 的 DSL 不接受。
            if (depth <= 1) out.required = value
            continue
        }
        out[key] = stripNestedRequired(value, depth + 1)
    }
    return out
}

export function toJsonSchema(schema) {
    if (schema === null || typeof schema !== 'object') return schema
    if (Array.isArray(schema)) return schema.map(toJsonSchema)
    // 已经是 JSON Schema（有 type/properties/组合关键字）：递归清洗
    if (schema.type !== undefined || schema.properties !== undefined
        || schema.oneOf !== undefined || schema.anyOf !== undefined || schema.allOf !== undefined) {
        return sanitizeSchema(schema)
    }
    return fieldMapToSchema(schema)
}

function fieldMapToSchema(fieldMap) {
    const properties = {}
    const required = []
    for (const [name, spec] of Object.entries(fieldMap)) {
        if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
            properties[name] = { type: 'string' }
            continue
        }
        const { required: isRequired, ...rest } = spec
        properties[name] = toJsonSchema(rest)
        if (isRequired === true) required.push(name)
    }
    const schema = { type: 'object', properties, additionalProperties: false }
    if (required.length > 0) schema.required = required
    return schema
}

const SCHEMA_ARRAY_KEYS = ['oneOf', 'anyOf', 'allOf', 'prefixItems']
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions']
const SCHEMA_SINGLE_KEYS = ['items', 'additionalProperties', 'additionalItems', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']

function sanitizeSchema(schema) {
    const out = {}
    let required = Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === 'string') : []
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'required') continue
        if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const properties = {}
            for (const [name, spec] of Object.entries(value)) {
                if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
                    const { required: nestedRequired, ...rest } = spec
                    if (nestedRequired === true && !required.includes(name)) required.push(name)
                    properties[name] = sanitizeSchema(rest)
                }
                else properties[name] = spec
            }
            out.properties = properties
            continue
        }
        if (SCHEMA_ARRAY_KEYS.includes(key) && Array.isArray(value)) {
            out[key] = value.map(toJsonSchema)
            continue
        }
        if (SCHEMA_MAP_KEYS.includes(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            const map = {}
            for (const [name, sub] of Object.entries(value)) map[name] = toJsonSchema(sub)
            out[key] = map
            continue
        }
        if (SCHEMA_SINGLE_KEYS.includes(key) && value !== null && typeof value === 'object') {
            out[key] = toJsonSchema(value)
            continue
        }
        out[key] = value
    }
    if (required.length > 0) out.required = required
    // 宿主实测要求 object schema **显式**声明 additionalProperties（真/假）。输出 schema 给 true：
    // 用 false 会把合法数据判成"未声明属性"（`ast_search` 的返回值就这样被拒过一次）。
    if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = true
    return out
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
        // **先洗一遍再交给宿主**：rc.3 的 value-schema DSL 只允许根节点有 `required`，
        // 嵌套的会让 `defineTool` 直接抛错（进而退回"schema 校验被禁用"的兜底）。
        // 注意这一步必须在 defineTool **之前**——放到 register 阶段的 sanitize 里已经晚了。
        let prepared = tool
        if (prepared !== null && typeof prepared === 'object' && prepared.parameters !== null && typeof prepared.parameters === 'object') {
            prepared = { ...prepared, parameters: stripNestedRequired(prepared.parameters) }
        }
        try {
            return defineTool(prepared)
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            if (typeof onError === 'function') {
                try { onError(tool?.name ?? '?', reason) }
                catch { /* 记录失败不影响注册 */ }
            }
            const safe = { ...tool, description: `${tool?.description ?? ''} [schema validation disabled: ${reason}]`.trim() }
            if (safe.parameters && typeof safe.parameters === 'object') safe.parameters = stripNestedRequired(toJsonSchema(safe.parameters))
            if (safe.output && typeof safe.output === 'object' && safe.output.schema) {
                safe.output = { ...safe.output, schema: toJsonSchema(safe.output.schema) }
            }
            return safe
        }
    }
}

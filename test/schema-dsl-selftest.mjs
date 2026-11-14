/**
 * 宿主 rc.3 的 value-schema DSL 兼容性自测。
 *
 * 背景：宿主 0.2.2-rc.3 起用**自己的 DSL** 编译工具参数，只允许根节点有 `required: [...]`；
 * 数组 items 的对象里再出现 `required` 会被判
 * `parameters.<字段>.items.required is not supported by the value schema DSL`，**整条注册被拒**
 * （实测 rc.3 上 `ast_edit` 与 `file` 就是这样从工具列表里消失的）。
 *
 * 修法：注册前把嵌套的 `required` 数组降级成 DSL 原生的 `properties[x].required = true`。
 * 这个自测盯住"降级本身正确"以及"我们的工具定义里不再有嵌套 required 数组"。
 *
 * 跑法：node test/schema-dsl-selftest.mjs
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const { makeSafeDefineTool, stripNestedRequired, toJsonSchema } = await import('../lib/deps.js')
const fileFamily = await import('../lib/file/index.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 200)}`}`)
}

/** 收集除根之外的所有 `required` 数组路径。 */
function nestedRequiredPaths(node, path = '', out = []) {
    if (node === null || typeof node !== 'object') return out
    if (Array.isArray(node)) {
        node.forEach((value, index) => nestedRequiredPaths(value, `${path}[${index}]`, out))
        return out
    }
    if (Array.isArray(node.required) && path !== '') out.push(`${path}.required`)
    for (const [key, value] of Object.entries(node)) {
        if (key === 'required') continue
        nestedRequiredPaths(value, path === '' ? key : `${path}.${key}`, out)
    }
    return out
}

try {
    console.log('== 1. 降级规则 ==')
    {
        const input = {
            type: 'object',
            properties: {
                action: { type: 'string' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { oldText: { type: 'string' }, newText: { type: 'string' }, note: { type: 'string' } },
                        required: ['oldText', 'newText'],
                    },
                },
            },
            required: ['action'],
        }
        const out = stripNestedRequired(input)
        ok('根 required 数组保留', Array.isArray(out.required) && out.required.join(',') === 'action', JSON.stringify(out.required))
        ok('嵌套 required 数组被移除', out.properties.edits.items.required === undefined)
        ok('嵌套必填整体移除（不留布尔，避免 DSL 再判未知键）',
            out.properties.edits.items.properties.oldText.required === undefined
            && out.properties.edits.items.properties.newText.required === undefined)
        ok('不再有嵌套 required 数组', nestedRequiredPaths(out).length === 0, nestedRequiredPaths(out).join(', '))
        ok('纯函数：入参未被修改', Array.isArray(input.properties.edits.items.required))
    }

    console.log('== 2. 其它形状：oneOf / 数组 of 对象 / 已是布尔形式 ==')
    {
        const union = stripNestedRequired({
            type: 'object',
            properties: {
                pick: {
                    oneOf: [
                        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
                        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
                    ],
                },
            },
        })
        ok('oneOf 分支里的 required 也被降级', nestedRequiredPaths(union).length === 0, nestedRequiredPaths(union).join(', '))
        ok('oneOf 分支里的必填也被移除（不猜宿主接受哪种形式）',
            union.properties.pick.oneOf[0].properties.a.required === undefined
            && union.properties.pick.oneOf[0].required === undefined)

        const alreadyBoolean = stripNestedRequired({ type: 'object', properties: { x: { type: 'string', required: true } } })
        ok('嵌套的布尔 required 也会被清掉（DSL 两种写法都不冒险）', alreadyBoolean.properties.x.required === undefined)

        const itemsArray = stripNestedRequired({
            type: 'object',
            properties: { pairs: { type: 'array', items: [{ type: 'object', properties: { k: { type: 'string' } }, required: ['k'] }] } },
        })
        ok('items 是数组（元组）时也处理', nestedRequiredPaths(itemsArray).length === 0, nestedRequiredPaths(itemsArray).join(', '))
    }

    console.log('== 2b. makeSafeDefineTool：在 defineTool **之前**就洗掉（否则兜底=校验被禁用）==')
    {
        // 模拟宿主 rc.3：看到嵌套 required 就抛错
        const strictDefineTool = (tool) => {
            const walk = (node, depth = 0) => {
                if (node === null || typeof node !== 'object') return
                if (Array.isArray(node)) { node.forEach((value) => walk(value, depth)); return }
                for (const [key, value] of Object.entries(node)) {
                    if (key === 'required' && depth > 0) throw new Error('parameters.x.items.required is not supported by the value schema DSL')
                    walk(value, depth + 1)
                }
            }
            walk(tool.parameters)
            return tool
        }
        const errors = []
        const safe = makeSafeDefineTool(strictDefineTool, (name, reason) => errors.push(`${name}: ${reason}`))
        const out = safe({
            name: 'file',
            description: 'demo',
            parameters: {
                type: 'object',
                properties: {
                    edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' } }, required: ['oldText'] } },
                },
                required: ['edits'],
            },
        })
        ok('严格 defineTool 不再抛错（说明是在它之前洗的）', errors.length === 0, errors.join(' | '))
        ok('描述里没有 "schema validation disabled" 后缀', !/schema validation disabled/.test(String(out.description)), String(out.description))
        ok('根 required 仍在', Array.isArray(out.parameters.required) && out.parameters.required.join(',') === 'edits')
    }

    console.log('== 3. 我们的工具定义：注册形状里没有嵌套 required 数组 ==')
    {
        const defineTool = (definition) => definition
        for (const def of fileFamily.tools(defineTool, {})) {
            const raw = def.parameters
            const params = raw.type === undefined && raw.properties === undefined ? toJsonSchema(raw) : raw
            const before = nestedRequiredPaths(params)
            const after = nestedRequiredPaths(stripNestedRequired(params))
            ok(`${def.name}：降级后无嵌套 required`, after.length === 0, after.join(', '))
            if (before.length > 0) ok(`${def.name}：原本确实存在嵌套 required（说明这条不是空转）`, before.length > 0, before.join(', '))
        }
    }

    console.log('== 4. ast_edit（若安装副本可用）==')
    {
        const installed = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-toolkit', 'lib', 'ast', 'edit.js')
        if (!existsSync(installed)) {
            console.log('  SKIP  ast_edit（找不到安装副本）')
        }
        else {
            const astEdit = await import(pathToFileURL(installed).href)
            const defineTool = (definition) => definition
            const def = astEdit.tools(defineTool, {})[0]
            const raw = def.parameters
            const params = raw.type === undefined && raw.properties === undefined ? toJsonSchema(raw) : raw
            const after = nestedRequiredPaths(stripNestedRequired(params))
            ok('ast_edit：降级后无嵌套 required', after.length === 0, after.join(', '))
            ok('ast_edit：根仍是 object', stripNestedRequired(params).type === 'object')
        }
    }
}
finally {
    /* 无临时文件 */
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

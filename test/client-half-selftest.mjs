/**
 * 浏览器半（lib/client.js）自测 —— 用**桩模块加载器**把 lazy-CJS 工厂跑起来。
 *
 * 为什么值得有：`lib/client.js` 是**手写**的浏览器产物，宿主里一旦写错就是"设置节不出现"甚至
 * App 退出（铁律 #5），而它在 Node 里平时根本不会被加载。这里用最小桩把三件事钉死：
 *   ① `window.__ModuleLoader__.load({id, factory})` 的 id 必须是**包名**（宿主按裸包名挂浏览器半）；
 *   ② 工厂返回的客户端插件形状（name/inject/apply），`apply` 不抛错、且只在
 *      `whileServed(['dsh-toolkit'])` 成立时登记 `settings.section`；
 *   ③ 六个开关的渲染与写回：值取 `snapshot.value[key] !== false`（与宿主同口径），
 *      交互走 `form.set(key, boolean)`。
 *
 * 桩 React 只实现 `createElement/useState/useEffect`，并把元素树递归"渲染"成普通对象树，
 * 足够检查结构与回调（无需真实 React/DOM）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')

let passed = 0
let failed = 0
const ok = (name, condition, detail = '') => {
    if (condition) { passed += 1; console.log(`  PASS  ${name}`) }
    else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 桩：模块加载器 + React ────────────────────────────────────────────────────
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded.push(entry) } } }

const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useReducer: (_reducer, initial) => [initial, () => {}],
}
const requireStub = (spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected require(${spec}) — 客户端半只允许平台自带模块`)
}

/** 递归调用函数组件，得到普通对象树（桩 React 不需要真的挂载）；字符串子节点原样保留 */
function render(node) {
    if (Array.isArray(node)) return node.flatMap(render)
    if (node === null || node === undefined) return []
    if (typeof node !== 'object') return [node]
    if (typeof node.type === 'function') return render(node.type(node.props))
    return [{ ...node, children: (node.children ?? []).flatMap((child) => (child !== null && typeof child === 'object' ? render(child) : [child])) }]
}
const flatten = (nodes) => nodes.flatMap((n) => (n !== null && typeof n === 'object' ? [n, ...flatten(n.children ?? [])] : []))
const allText = (nodes) => flatten(nodes).map((n) => (n.children ?? []).filter((c) => typeof c === 'string').join('')).join(' ')

// ── 1) 加载工厂 ───────────────────────────────────────────────────────────────
console.log('§1 模块加载器契约')
const source = readFileSync(CLIENT, 'utf8')
new Function('window', 'require', 'navigator', source)(globalThis.window, requireStub, { language: 'zh-CN' })
ok('lib/client.js 调用了 window.__ModuleLoader__.load 一次', loaded.length === 1, `实际 ${loaded.length} 次`)
ok('id 是包名（dsh-toolkit）', loaded[0]?.id === 'dsh-toolkit', `实际 ${JSON.stringify(loaded[0]?.id)}`)
ok('入口只 require 平台模块 react', !/require\(['"](?!react['"])/.test(source))

const mod = loaded[0].factory(requireStub)
console.log('§2 客户端插件形状')
ok('name = dsh-toolkit', mod?.name === 'dsh-toolkit')
ok('inject 数组含 slots', Array.isArray(mod?.inject) && mod.inject.includes('slots'))
ok('apply 是函数', typeof mod?.apply === 'function')

console.log('§2b bash 开关的禁用逻辑（没装不许打开）')
{
    const internals = mod?.__internals ?? {}
    ok('导出测试缝', typeof internals.isSwitchDisabled === 'function' && typeof internals.apiPath === 'function')
    ok('bash 还没探测出来时不禁用', internals.isSwitchDisabled('shell', true, null) === false)
    ok('bash 未安装 ⇒ 禁用 shell', internals.isSwitchDisabled('shell', true, { installed: false }) === true)
    ok('bash 已安装 ⇒ 放行', internals.isSwitchDisabled('shell', true, { installed: true }) === false)
    ok('POSIX 上 shell 族直接禁用（宿主自带 bash）', internals.isSwitchDisabled('shell', true, { installed: true, platform: 'linux' }) === true)
    ok('Windows 上已安装则可用', internals.isSwitchDisabled('shell', true, { installed: true, platform: 'win32' }) === false)
    ok('只影响 shell，其它族不受影响', internals.isSwitchDisabled('ast', true, { installed: false }) === false)
    ok('不可写时全禁', internals.isSwitchDisabled('ast', false, { installed: true }) === true)
    ok('状态路由 = /dsh-toolkit/bash/status', internals.BASH_STATUS_PATH === 'dsh-toolkit/bash/status')
    ok('安装路由 = /dsh-toolkit/bash/install', internals.BASH_INSTALL_PATH === 'dsh-toolkit/bash/install')
    ok('apiPath 解析成以 / 开头的路径', internals.apiPath(internals.BASH_STATUS_PATH) === '/dsh-toolkit/bash/status', internals.apiPath(internals.BASH_STATUS_PATH))
}

// ── 3) apply：可选缝 + 设置节登记 ─────────────────────────────────────────────
function makeCtx(options = {}) {
    const seen = { sections: [], whileServed: [], injected: [] }
    const form = {
        snapshot: options.snapshot ?? { status: 'ready', writable: true, value: { ast: true, table: false }, revision: 3 },
        writes: [],
        listeners: [],
        getSnapshot() { return this.snapshot },
        subscribe(listener) { this.listeners.push(listener); return () => {} },
        set(field, value) { this.writes.push([field, value]); return Promise.resolve(true) },
        unset(field) { this.writes.push([field, null]); return Promise.resolve(true) },
    }
    const ctx = {
        inject(deps, callback) {
            seen.injected.push(deps.join(','))
            if (options.withConfigForms === false) return
            if (deps.includes('configForms')) {
                callback({
                    configForms: {
                        get: (ns) => (ns === 'dsh-toolkit' ? form : null),
                        whileServed: (namespaces, register) => { seen.whileServed.push(namespaces); return register() },
                    },
                    slots: ctx.slots,
                    effect: (fn) => { fn(); return () => {} },
                })
            }
        },
        slots: {
            inject: (name, callback) => { seen.injected.push(name); return callback() },
            register: (spec, component) => { seen.sections.push({ spec, component }); return () => {} },
        },
        effect: (fn) => { fn(); return () => {} },
        form,
    }
    return { ctx, seen, form }
}

console.log('§3 apply 登记设置节')
{
    const { ctx, seen, form } = makeCtx()
    mod.apply(ctx)
    ok('whileServed 只声明自己的命名空间', JSON.stringify(seen.whileServed) === '[["dsh-toolkit"]]', JSON.stringify(seen.whileServed))
    ok('登记到 settings.section 一次', seen.sections.length === 1, `实际 ${seen.sections.length}`)
    const spec = seen.sections[0]?.spec ?? {}
    ok('槽位名 = settings.section', spec.name === 'settings.section')
    ok('id = dsh-toolkit（设置节稳定 id）', spec.id === 'dsh-toolkit')
    ok('order 是数字', typeof spec.order === 'number')
    ok('label 是函数且非空', typeof spec.label === 'function' && String(spec.label()).length > 0)

    console.log('§4 渲染六个开关')
    const tree = render([{ type: seen.sections[0].component, props: {}, children: [] }])
    const boxes = flatten(tree).filter((n) => n.type === 'input' && n.props.type === 'checkbox')
    ok('渲染出 7 个 checkbox（help 常开，不在卡片里）', boxes.length === 7, `实际 ${boxes.length}`)
    ok('缺省字段视为关（value 里没有 session 就不勾）', boxes[2]?.props.checked === false)
    ok('显式 false 视为关（table=false）', boxes[1]?.props.checked === false)
    ok('可写时不禁用', boxes.every((b) => b.props.disabled === false))
    ok('提示文案进了树', /AST/.test(allText(tree)))

    console.log('§5 写回')
    boxes[0].props.onChange({ currentTarget: { checked: false } })
    ok('切换第一个开关写 ast=false', JSON.stringify(form.writes) === '[["ast",false]]', JSON.stringify(form.writes))

    console.log('§6 只读/未就绪时不给开关')
    const ro = makeCtx({ snapshot: { status: 'ready', writable: false, value: {} } })
    mod.apply(ro.ctx)
    const roTree = render([{ type: ro.seen.sections[0].component, props: {}, children: [] }])
    ok('不可写时 checkbox 全部禁用', flatten(roTree).filter((n) => n.type === 'input').every((n) => n.props.disabled === true))
    const un = makeCtx({ snapshot: { status: 'unavailable', writable: false, value: undefined } })
    mod.apply(un.ctx)
    const unTree = render([{ type: un.seen.sections[0].component, props: {}, children: [] }])
    ok('unavailable 时不渲染任何 checkbox', flatten(unTree).filter((n) => n.type === 'input').length === 0)
}

console.log('§7 可选缝：没有 configForms 也不抛错')
{
    const { ctx, seen } = makeCtx({ withConfigForms: false })
    let threw = null
    try { mod.apply(ctx) } catch (error) { threw = error }
    ok('apply 不抛错', threw === null, threw?.message)
    ok('不登记设置节', seen.sections.length === 0)
}

console.log(`\nclient-half: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

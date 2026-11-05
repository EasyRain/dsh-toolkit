/**
 * 家族热开关（`loader/volatile-update` → 重装）与注册收口的自测 —— 两个真事故的护栏。
 *
 * 事故一：旧 `gateDefineTool` 只把 `defineTool` 换成恒等、**返回原 def**，而各段照样
 *   `ctx.tools.register(def)` ⇒ 字段映射方言进注册表 ⇒ 宿主
 *   `Invalid schema for function 'download': … got 'type: null'` ⇒ **整个请求**（会话）全废。
 * 事故二：`lib/ast/edit.js` 用 `ctx.get('tools')` 取服务，绕过了收口 ⇒ 刷新时旧登记释放不掉 ⇒
 *   `tool "ast_edit" is already registered` ⇒ 整段 FAILED（该族其余工具一起没）。
 *
 * 这份自测用**会记名、会报重复**的桩注册表把两条路都钉住：关掉的族一个都不许注册、
 * 每次刷新后"工具集合"必须与配置一致、重复注册次数必须为 0。
 */
const PKG = new URL('..', import.meta.url)
const mod = await import(new URL('lib/index.js', PKG).href)

let passed = 0
let failed = 0
const ok = (name, condition, detail = '') => {
    if (condition) { passed += 1; console.log(`  PASS  ${name}`) }
    else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** 桩宿主：`register` 记名 + 重复即抛（与 @deepseek-ai/dsh-tools 同文案）；服务经 `get()` 也能取到。 */
function makeHost() {
    const live = new Map()
    const defs = []
    const duplicates = []
    const events = []
    const tools = {
        register(def) {
            const name = String(def?.name ?? '')
            if (live.has(name)) {
                duplicates.push(name)
                throw new Error(`tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`)
            }
            live.set(name, def)
            defs.push(def)
            return () => { live.delete(name) }
        },
        schemas() { return [...live.keys()].map((name) => ({ name })) },
    }
    const commands = { register() { return () => {} } }
    const ctx = {
        logger: { warn: () => {} },
        tools,
        commands,
        get(name) { return name === 'tools' ? tools : (name === 'commands' ? commands : undefined) },
        on(name, fn) { events.push([name, fn]); return () => {} },
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
        inject() { return () => {} },
    }
    return { ctx, live, defs, duplicates, events, tools }
}

const names = (live) => [...live.keys()].sort().join(', ')

console.log('§1 首次装配')
const host = makeHost()
let table = true
const options = {
    get ast() { return { get: () => true } },
    get table() { return { get: () => table } },
}
await mod.apply(host.ctx, options)
const initial = names(host.live)
ok('注册了工具（源码树缺 ast 依赖时也会 ≥6 个）', host.live.size >= 6, `实际 ${host.live.size}`)
ok('每个 def 的 parameters 都是 JSON Schema 对象', host.defs.every((d) => d?.parameters === undefined || d.parameters.type === 'object'))
ok('登记了 loader/volatile-update 监听', host.events.some(([n]) => n === 'loader/volatile-update'))
const watcher = host.events.find(([n]) => n === 'loader/volatile-update')?.[1]
ok('监听器把刷新 promise 返回出来（便于诊断/测试）', typeof watcher === 'function' && watcher() instanceof Promise)
await watcher()

console.log('§2 关掉一族 → 该族工具必须消失')
table = false
await watcher()
const off = names(host.live)
ok('table_* 全部注销', ![...host.live.keys()].some((n) => n.startsWith('table_')), off)
ok('其余工具仍在（会话/checkpoint/下载/帮助）', ['session_list', 'checkpoint', 'download', 'toolkit_help'].every((n) => host.live.has(n)), off)

console.log('§3 打开回去 → 与初始一致')
table = true
await watcher()
ok('工具集合回到初始状态', names(host.live) === initial, `${names(host.live)} ≠ ${initial}`)
ok('全程没有一次重复注册', host.duplicates.length === 0, host.duplicates.join(', '))

console.log('§4 连点开关按顺序收敛到最后一次')
table = false
const p1 = watcher()
table = true
const p2 = watcher()
await Promise.all([p1, p2])
ok('串行化后仍是"开"的状态', names(host.live) === initial, names(host.live))
ok('连点也没有重复注册', host.duplicates.length === 0, host.duplicates.join(', '))

console.log(`\nvolatile-refresh: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 && host.duplicates.length === 0 ? 0 : 1)

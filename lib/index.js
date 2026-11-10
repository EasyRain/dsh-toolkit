/**
 * dsh-toolkit —— 自有的 DSH 多工具插件：**六族 14 个工具 + 一个按需帮助**（宿主侧）
 *
 * 族开关：六族**默认全部关闭**，在「设置 → 工具集」按需开启（`lib/config-schema.js` 里的 volatile 布尔
 *         ⇒ 宿主设置页会投影；未启用的族在 `ctx.tools.register` 这一层就被拒掉 —— 见 `familyScope()`，
 *         它同时拦下 `ctx.get('tools')` / `ctx.commands` 这类旁路，否则会留下"半注册"的工具）。
 *         `toolkit_help` 常开且不可关，所以模型总能先问清哪些族启用了。
 *
 * 一、表 diff（2）table_diff / table_peek —— lib/tablediff/*（适配器 → 投影 → 哈希连接 O(N+M)）
 *
 * 二、AST（4）ast_search / ast_dump_tree / ast_test_rule / ast_edit
 *     检索：lib/search.js（源自 dsh-ast-grep@0.1.0，MIT）
 * 改写：lib/ast/edit.js + lib/ast/lang.js（**自研**，进程内 @ast-grep/napi，；
 *           此前是并入上游 dsh-ast-edit-tool@0.1.6 的实现 + 外调 ast-grep 二进制）
 *     行为要点：paths 必填、preview→apply 两步、apply 前过期校验、落盘原子写、覆盖率/残留校验。
 *     文件收集：lib/glob.js（自研，取代 fast-glob + ignore）
 *
 * 三、会话日志（4）session_list / session_read / session_diff / session_export —— lib/session/index.js
 *     纯 node + 原生 zstd；会话日志是多帧独立 zstd，逐帧解码；session_diff 是哈希对齐（不是 LCS）
 *
 * 四、checkpoint（1 个工具，七个动作）create / list / diff / restore / prune / journal / journal_restore
 *     —— lib/checkpoint/index.js + lib/checkpoint/diff.js（**均为自研**）
 *     命令：/checkpoint、/rewind
 *     自动行为：监听宿主 fs 层的写/改意图（fs/write-intent、fs/edit-intent）与 tools/pre-execute，
 *               在文件被改写前留底原文；**不开**自动间隔快照。
 *
 * 五、下载（1 个工具，四个动作）start / probe / status / cancel —— lib/download/*
 *     零依赖多线程：Range 分片 + `.part`/manifest 续传 + sha256 + 系统代理探测（注册表 → PAC → 环境变量
 *     → 常见本地端口；**不要求装代理软件**）。
 *
 * 六、按需帮助（1）toolkit_help —— lib/help/index.js，正文 docs/TOOLKIT.md（懒加载）
 *     schema 会进每个会话的常驻上下文，所以"怎么选/怎么解读/有哪些坑"这类内容放文档、按需取回。
 *
 * 加载信标：把 apply() 每一步写一行日志，用来区分"插件没挂载"与"挂载了但某一段注册失败"，
 *           并靠 `build=` 版本戳分辨跑的是哪一版。默认位置 `$DSH_HOME/dsh-toolkit/_toolkit-load.log`
 *           与系统临时目录；可用 `DSH_TOOLKIT_BEACON_DIR` 指定（**不硬编码任何本机路径**）。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// ⚠️ **不要在这里静态 import 各功能段**（子代理审计 A-1）：
// 静态 import 的求值发生在模块加载期，任何一段的深层依赖坏掉（实测：`yaml` 缺失、
// 31 个 `@ast-grep/lang-*` 原生二进制缺失/未批准 postinstall）都会让**整个入口 import 失败**，
// 下面 6 个 try/catch 一次都跑不到 ⇒ 20 个工具 + 2 个命令全没（连"module imported"信标都不会出现）。
// 改为**段内 await import()**：坏掉的那一段只损失它自己，其余照常注册。
import { defineTool, defineToolKind, makeSafeDefineTool, toJsonSchema } from './deps.js'
// 配置归一化 + 家族级开关（profile patch 的 `config:` 传进来，改配置免重启）
import { FAMILIES, familyEnabled, familyOfTool, normalizeConfig, describeConfig, setActiveConfig } from './configure.js'
// 导出 `Config`（schemastery）—— 宿主的"插件设置"页**只投影 `.volatile` 字段**，
// 所以家族开关做成 volatile 布尔后才会出现在设置页里（实证：dsh 源码 packages/settings/settings/README.md
// + docs/subsystems/settings.md + cookbook/adding-a-settings-card）。该模块内部全程 try/catch，
// 解析不到 schemastery 时导出 undefined（等价于"没有 Config"），不会拖垮入口。
import { ConfigSchema, configSchemaKind, FAMILY_TOGGLES, readFamilyToggles } from './config-schema.js'

// 信标：写多个位置，用来区分 "模块没被 import"（都不出现）/ "import 了但 apply 没跑"（只有 module imported 行）
//   / "apply 跑到一半失败"（能看到停在哪一段）。
// 位置：$DSH_TOOLKIT_BEACON_DIR（可选，目录不存在则自动跳过）+ $DSH_HOME/dsh-toolkit（跨平台固定位置）
//   + 系统临时目录（永远可用）。**不硬编码任何本机路径** —— 发布版在别人机器上照样能用。
const BEACON_DIRS = [
    process.env.DSH_TOOLKIT_BEACON_DIR,
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-toolkit'),
    tmpdir(),
].filter((d) => typeof d === 'string' && d !== '')
const BEACON_FILES = [...new Set(BEACON_DIRS.map((d) => join(d, '_toolkit-load.log')))]

/**
 * 代码版本戳（加的）。为什么需要：宿主**缓存宿主侧模块** —— 「插件页关再开」不会重新
 * import `.js`（源码改动要么**整体重启**，要么给 profile 打 opt-in 的模块监听
 * `- id: hmr` + `config: { root: ["."] }`）。没有版本戳时，日志里只能靠行号/新特性猜"跑的是哪一版"，
 * 这次为此绕了三轮。凡是信标里带 `build=` 的行，就能直接对上源码。
 */
const BUILD = '2026-10-17T12:20Z-denaturalized+beacon-home+session-id-fix'

function beacon(line) {
    const text = `${new Date().toISOString()} ${line}\n`
    for (const file of BEACON_FILES) {
        try {
            // 目录可能还不存在（$DSH_HOME/dsh-toolkit 是新建的固定位置）⇒ 先建一次，否则 appendFileSync 直接抛。
            try { mkdirSync(dirname(file), { recursive: true }) } catch { /* 建不了就跳过这个位置 */ }
            // **封顶**（审计 A-4）：信标在 fs 写意图热路径上被同步调用，旧实现只追加不裁剪
            // （实测 10 分钟涨 7 KB，且包含所有被改文件的绝对路径）。超过 2 MB 只留最近 200 行。
            try {
                if (statSync(file).size > 2 * 1024 * 1024) {
                    const tail = readFileSync(file, 'utf8').split('\n').slice(-200).join('\n')
                    writeFileSync(file, `# beacon rotated at ${new Date().toISOString()} (kept last 200 lines)\n${tail}`)
                }
            }
            catch { /* 文件不存在：正常情况 */ }
            appendFileSync(file, text)
        }
        catch {
            // 单个位置写不进去不影响插件
        }
    }
}

// 导入期探针：只要宿主 import 到这个模块就会立刻留痕（哪怕后面 apply 没被调用）。
beacon(`module imported (entry evaluated); cwd=${process.cwd()}`)

// cordis 的一条硬规矩：**访问没有写进 inject 的服务属性会直接抛异常**
// （"cannot get property X without inject"）。所以探针必须包 try/catch —— 
// 就是因为信标里直接读 ctx.commands，导致 apply() 第一句抛错、整行插件静默不挂载。
function hasService(ctx, name) {
    try {
        return Boolean(ctx[name])
    }
    catch {
        return false
    }
}

/** 取某个 section 会注册的工具名（只构建对象、不注册）—— 信标要写**真实**名单而不是硬编码字符串（审计 A-4） */
function namesOf(build) {
    try {
        return (build() ?? []).map((t) => t?.name).filter(Boolean).join(', ')
    }
    catch (error) {
        return `names unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
}

function warn(ctx, message) {
    if (typeof ctx.logger?.warn === 'function')
        ctx.logger.warn(`dsh-toolkit: ${message}`)
    else
        console.warn(`dsh-toolkit: ${message}`)
}

// 插件设置（目前只有 ast_edit 的 maxFiles；也可用 DSH_AST_MAX_FILES 覆盖）。
// 注意：这是**静态再导出**，`lib/ast/edit.js` 若导入失败会让整个入口失败 —— 所以这里只做
// 惰性转发（真正的解析推迟到第一次读取时），保证入口本身永远能加载。
export const resolveMaxFiles = (...args) => import('./ast/edit.js').then((m) => m.resolveMaxFiles(...args))
export const staging = new Proxy({}, {
    get: (_t, prop) => async (...args) => {
        const m = await import('./ast/edit.js')
        const value = m.staging?.[prop]
        return typeof value === 'function' ? value.apply(m.staging, args) : value
    },
})

export const name = 'dsh-toolkit'
// tools 给三类工具；commands/sessions 给 checkpoint 的命令与会话游标（缺失时该段自行降级）。
export const inject = ['tools']
// 插件设置表单的来源：宿主从这份 schema 生成"设置 → 插件 → dsh-toolkit"里的表单（只含 volatile 字段）。
export const Config = ConfigSchema

/** 把 volatile 家族开关（`config.ast.get()`）并进旧的 `families: {...}`；两者都支持，volatile 优先。 */
function withFamilyToggles(options) {
    const flat = readFamilyToggles(options)
    if (Object.keys(flat).length === 0) return options
    return { ...options, families: { ...(options?.families ?? {}), ...flat } }
}

/**
 * 兜底（实测教训）：**字段映射方言的 def 绝不能进注册表**。
 *
 * 交给 `tools.register` 的 `parameters` 有两条来路：走 `defineTool` 的会被翻译成 JSON Schema；
 * 一旦某条路把"未包装的 def"漏进来（旧版 `gateDefineTool` 就是这么漏的 —— 它只把 `defineTool`
 * 换成恒等并**返回原 def**，而各段照样 `ctx.tools.register(def)`），宿主序列化给模型时就是
 * `Invalid schema for function 'download': schema must be a JSON Schema of 'type: "object"', got 'type: null'`，
 * **整个请求**失败（不是单个工具失败，实测把会话直接打死）。所以在注册收口再验一次形状。
 */
function sanitizeDefinition(def) {
    if (def === null || typeof def !== 'object') return def
    const isFieldMap = (schema) => schema !== null && typeof schema === 'object' && schema.type === undefined && schema.properties === undefined
    let out = def
    if (isFieldMap(def.parameters)) {
        out = { ...out, parameters: toJsonSchema(def.parameters) }
        beacon(`register guard: parameters 是字段映射方言，已翻译成 JSON Schema（${String(def?.name ?? '?')}）`)
    }
    if (out.output !== null && typeof out.output === 'object' && out.output.schema !== undefined) {
        // 递归清洗：即使已经是 JSON Schema，也要把任何层级的布尔 `required` 上提成数组
        // （严格 provider 会以 `true is not of type "array"` 拒绝整个请求）。
        out = { ...out, output: { ...out.output, schema: toJsonSchema(out.output.schema) } }
    }
    return out
}

/**
 * 每族一个**可回收的 scope**：登记照旧，但
 *  ① 登记产生的 disposer 全进本族的桶（`tools.register`，以及 `ctx.on/effect/inject` 的返回值）；
 *  ② **关掉的族直接拒收注册**（返回空 disposer）—— 这一层才是"真的不注册"。各段的写法是
 *     `ctx.tools.register(defineTool(def))`，所以只把 `defineTool` 换成恒等是拦不住的：
 * 那次 `ast_search` 就是以**字段映射方言**漏进宿主、让整个请求 INVALID_REQUEST。
 */
/** 段里会往里登记东西的服务：这些都要经收口，否则卸族时释放不到（`ctx.get('tools')` / `ctx.commands`）。 */
const RECORDED_SERVICES = new Set(['tools', 'commands', 'sessions', 'fs', 'systemPrompt', 'jobs'])

function familyScope(ctx, family, bucket, onSkip) {
    const record = (value) => {
        if (typeof value === 'function') bucket.push(value)
        return value
    }
    /** 服务对象：任何方法调用**只要返回函数**就记下来（`register`/`on`/`subscribe`… 都算）。 */
    const recordingService = (service) => {
        if (service === null || typeof service !== 'object') return service
        return new Proxy(service, {
            get(target, prop) {
                let value
                try { value = Reflect.get(target, prop, target) } catch { return undefined }
                if (typeof value !== 'function') return value
                return (...args) => record(value.apply(target, args))
            },
        })
    }
    let tools
    const wrapped = new Map()
    const serviceOf = (name, raw) => {
        if (name === 'tools') return raw === undefined ? undefined : tools
        if (!RECORDED_SERVICES.has(name)) return raw
        if (!wrapped.has(name)) wrapped.set(name, recordingService(raw))
        return wrapped.get(name)
    }
    try {
        const real = ctx.tools
        tools = new Proxy({}, {
            get(_t, prop) {
                if (prop === 'register') {
                    return (def) => {
                        const name = String(def?.name ?? '')
                        if (!familyEnabled(familyOfTool(name))) {
                            try { onSkip?.(name, family) } catch { /* 诊断失败不影响注册 */ }
                            return () => {}
                        }
                        try {
                            return record(real.register(sanitizeDefinition(def)))
                        }
                        catch (error) {
                            // 刷新竞态：上一轮同名登记还没释放完（或段里绕过了收口）。沿用既有登记即可
                            // —— 让"重复注册"把整段（该族其余工具）一起带走，比留一个旧登记糟得多。
                            const message = error instanceof Error ? error.message : String(error)
                            if (/already registered/.test(message)) {
                                beacon(`register guard: ${name} 已注册（刷新竞态），沿用既有登记`)
                                return () => {}
                            }
                            throw error
                        }
                    }
                }
                const value = real[prop]
                return typeof value === 'function' ? value.bind(real) : value
            },
        })
    }
    catch { tools = undefined }
    const serviceByName = (name) => {
        let value
        try { value = (typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]) } catch { return undefined }
        return serviceOf(name, value)
    }
    return new Proxy({}, {
        get(_t, prop) {
            // ⚠️ 关键：`ctx.get('tools')` 也必须走收口 —— `lib/ast/edit.js` 就是这么拿 tools 的。
 // 以前它落在真 ctx 上：既躲过家族闸门、登记也不进桶 ⇒ 实测刷新时
            // `ast_edit` 重复注册、整个 ast 段 FAILED（"already registered"）。
            if (prop === 'get') {
                return (name, ...rest) => {
                    if (RECORDED_SERVICES.has(name)) return serviceByName(name)
                    let value
                    try { value = Reflect.get(ctx, 'get', ctx) } catch { return undefined }
                    return typeof value === 'function' ? value.call(ctx, name, ...rest) : undefined
                }
            }
            let value
            try { value = Reflect.get(ctx, prop, ctx) } catch { return undefined }
            if (typeof value === 'function') {
                // 这些登记也算本族的：卸族时要一并释放（checkpoint 的命令与 fs 留底钩子就走这里）
                if (prop === 'effect' || prop === 'on' || prop === 'inject') return (...args) => record(value.apply(ctx, args))
                return value.bind(ctx)
            }
            if (RECORDED_SERVICES.has(prop)) return serviceOf(prop, value)
            return value
        },
        has(_t, prop) { try { return prop in ctx } catch { return false } },
    })
}

/**
 * 装配入口。为什么必须自己监听 volatile：设置页里拨开关时，宿主**只把值提交到引用上、不 remount 条目**
 * （`vendor/loader/README.md`：volatile-only 改动 commit 后向本 fiber 发 `loader/volatile-update`），
 * 所以"关掉的族真的不注册工具 / 打开的族重新注册"这件事只能由我们自己完成。
 */
export async function apply(ctx, options = {}) {
    beacon(`apply() entered; build=${BUILD} ctx.tools=${hasService(ctx, 'tools') ? 'yes' : 'no'} ctx.commands=${hasService(ctx, 'commands') ? 'yes' : 'no'} ctx.sessions=${hasService(ctx, 'sessions') ? 'yes' : 'no'} defineTool=${defineToolKind}`)

    // **配置校验**（审计 A-7）：cordis 的 Config 校验我们没导出，插件选项以前**完全不校验** ⇒ 写错键
    // 只会静默无效。这里点出未知键（不抛错，只警告 + 写信标），够用且不破坏既有配置。
    {
        // `help` 在旧配置里可能存在（它已改为**常开**），所以列进已知键：不报警、实际上被忽略。
        const known = new Set(['astEdit', 'version', 'debug', 'families', 'checkpoint', ...FAMILY_TOGGLES.map((item) => item.key)])
        const unknown = Object.keys(options ?? {}).filter((k) => !known.has(k))
        if (unknown.length > 0) {
            warn(ctx, `未知配置键被忽略：${unknown.join(', ')}（支持：${[...known].join(', ')}）`)
            beacon(`config: unknown keys ignored: ${unknown.join(', ')}`)
        }
    }

    const state = { buckets: new Map(), queue: Promise.resolve() }
    await applyAll(ctx, options, state)
    try {
        ctx.on('loader/volatile-update', () => refreshFamilies(ctx, options, state))
        beacon('volatile watcher registered (loader/volatile-update)')
    }
    catch (error) {
        beacon(`volatile watcher FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
    await applyAux(ctx)
}

/**
 * 拨开关后的增量生效：**整插件重装**。粒度做到"族"没有收益（全部重装只有几毫秒），却要冒
 * "卸一半"的风险；这里先卸光再按新配置装一遍，永远不会留半个家族。连点开关由 `queue` 串行化。
 */
function refreshFamilies(ctx, options, state) {
    state.queue = state.queue
        .then(async () => {
            const next = normalizeConfig(withFamilyToggles(options))
            let released = 0
            for (const bucket of state.buckets.values()) {
                for (const dispose of [...bucket].reverse()) {
                    try { dispose(); released += 1 } catch { /* 单个释放失败不阻断重装 */ }
                }
            }
            state.buckets.clear()
            setActiveConfig(next)
            beacon(`loader/volatile-update → ${describeConfig(next)}；释放 ${released} 个登记，重装各段`)
            await applyAll(ctx, options, state)
            beacon('volatile refresh done')
        })
        .catch((error) => beacon(`volatile refresh FAILED: ${error instanceof Error ? error.message : String(error)}`))
    return state.queue
}

/** 装配主体（第 1–7 段）。`apply` 与 `refreshFamilies` 都走这里，`state.buckets` 记每族的 disposer。 */
async function applyAll(ctx, options, state) {
    // **所有段共用同一个"永不抛错"的 defineTool**：宿主 DSL 拒收某个键时，只让那一个工具退回
 // 无 schema 校验的注册，而不是让整段（甚至整族）消失 —— AST 检索族就是这样没的。
    // 家族闸门不在这里（光换 defineTool 拦不住 `ctx.tools.register`）：它由 `familyScope()` 收口。
    const config = normalizeConfig(withFamilyToggles(options))
    beacon(`config schema: ${configSchemaKind}, volatile 家族开关=${Object.keys(readFamilyToggles(options)).length}`)
    // 必须在 import checkpoint 段**之前**设好（它的 ROOT 是模块导入时算的）
    if (config.checkpointRoot !== null) process.env.DSH_TOOLKIT_CHECKPOINTS = config.checkpointRoot
    // 让"直接 ctx.tools.register"的段（如 search.js）也能看到开关：视图未设置时一律视为开启
    setActiveConfig(config)
    const safeDefineTool = makeSafeDefineTool(defineTool, (name, reason) => beacon(`defineTool rejected ${name}: ${reason}（该工具退回无 schema 校验注册，功能不变）`))
    beacon(`config: ${describeConfig(config)}`)

    // 每族一个 scope + 一个 disposer 桶（同一族可含多个段，如 ast = search + astEdit）
    const scopes = new Map()
    for (const family of FAMILIES) {
        const bucket = []
        state.buckets.set(family, bucket)
        scopes.set(family, familyScope(ctx, family, bucket, (name, fam) => beacon(`tool ${name} skipped by config (family=${fam})`)))
    }

    // --- 1) AST 检索（只读，失败也不该拖垮其它几段）
    try {
        const search = await import('./search.js')
        const searchNames = search.apply(scopes.get('ast'), safeDefineTool)
        beacon(`search.apply ok (${(searchNames ?? []).join(', ')})`)
    }
    catch (error) {
        beacon(`search.apply FAILED: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`)
        warn(ctx, `ast 检索工具未注册（${error instanceof Error ? error.message : String(error)}）`)
    }

    // --- 2) AST 改写（进程内 @ast-grep/napi，不需要外部二进制）
    try {
        const astEdit = await import('./ast/edit.js')
        const n = astEdit.apply(scopes.get('ast'), safeDefineTool, { maxFiles: options?.astEdit?.maxFiles })
        beacon(`astEdit.apply ok (${n} tool registered: ast_edit)`)
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        beacon(`astEdit.apply FAILED: ${message}\n${error instanceof Error ? error.stack ?? '' : ''}`)
        warn(ctx, `ast_edit 未注册（${message}）`)
    }

    // --- 3) 会话日志工具（纯 node，必然可注册）
    let session = null
    try {
        session = await import('./session/index.js')
        const n = session.apply(scopes.get('session'), safeDefineTool, {
            resolveWorkspaceCwd: () => {
                try {
                    return session.currentWorkspaceCwd()
                }
                catch {
                    return null
                }
            },
        })
        beacon(`session.apply ok (${n} tools: ${namesOf(() => session.tools(defineTool, {}))})`)
    }
    catch (error) {
        session = null
        beacon(`session.apply FAILED: ${error instanceof Error ? error.message : String(error)}`)
        warn(ctx, `会话日志工具未注册（${error instanceof Error ? error.message : String(error)}）`)
    }

    // --- 4) checkpoint / rewind（依赖 session 段：拿不到就退化成"没有会话上下文"）
    try {
        const checkpoint = await import('./checkpoint/index.js')
        const n = await checkpoint.apply(scopes.get('checkpoint'), {
            defineTool: safeDefineTool,
            resolveSessionFile: (cwd) => {
                if (!session) return null
                try {
                    return session.resolveSessionFile('last', cwd)
                }
                catch {
                    return null
                }
            },
            resolveWorkspaceCwd: () => {
                if (!session) return null
                try {
                    return session.currentWorkspaceCwd()
                }
                catch {
                    return null
                }
            },
            mutationHook: true,
            beacon,
        })
        beacon(`checkpoint.apply ok (${n} tools: ${namesOf(() => checkpoint.tools(defineTool))})`)
    }
    catch (error) {
        beacon(`checkpoint.apply FAILED: ${error instanceof Error ? error.message : String(error)}`)
        warn(ctx, `checkpoint/rewind 未注册（${error instanceof Error ? error.message : String(error)}）`)
    }

    // --- 5) key→value 表 diff（语术表这类；哈希连接 O(N+M)）
    try {
        const tablediff = await import('./tablediff/index.js')
        const n = tablediff.apply(scopes.get('table'), safeDefineTool, {
            resolveWorkspaceCwd: () => {
                if (!session) return null
                try {
                    return session.currentWorkspaceCwd()
                }
                catch {
                    return null
                }
            },
        })
        beacon(`tablediff.apply ok (${n} tools: ${namesOf(() => tablediff.tools(defineTool))})`)
    }
    catch (error) {
        beacon(`tablediff.apply FAILED: ${error instanceof Error ? error.message : String(error)}`)
        warn(ctx, `table_diff 未注册（${error instanceof Error ? error.message : String(error)}）`)
    }

    // --- 6) 多线程下载器（download / download_status / download_cancel）——零依赖，支持系统代理自动探测
    try {
        const download = await import('./download/index.js')
        const n = download.apply(scopes.get('download'), safeDefineTool, {
            resolveWorkspaceCwd: () => {
                if (!session) return null
                try {
                    return session.currentWorkspaceCwd()
                }
                catch {
                    return null
                }
            },
        })
        beacon(`download.apply ok (${n} tools: ${namesOf(() => download.tools(defineTool))})`)
    }
    catch (error) {
        beacon(`download.apply FAILED: ${error instanceof Error ? error.message : String(error)}`)
        warn(ctx, `download 未注册（${error instanceof Error ? error.message : String(error)}）`)
    }
    // --- 7) bash 执行器（纯 child_process，不碰内核 API）—— 内核 0.2.2 移除 `ops_bash` 后的替代；
    //        用系统 Git for Windows，**不下载任何东西**，找不到就明确报错。
    /** 缺运行时时的信标文案（区分平台 / 未安装）。 */
    const resolveShellReason = (shell) => {
        if (process.platform !== 'win32') return 'shell family: POSIX 由宿主 bash 接管，本族不注册'
        return 'shell family: 运行时未安装（设置页「Bash 执行器」→ 安装受限运行时）；下载完成后自动挂载'
    }

    // --- 7) bash 执行器 —— 统一使用本插件安装的运行时（Niubash）。
    //        运行时不在这里下载：**没装就整个族不注册**（等设置页下载完再挂上，见 requestShellRemount）。
    const mountShellFamily = async () => {
        const shell = await import('./shell/bash.js')
        const n = shell.apply(scopes.get('shell'), safeDefineTool, {
            resolveWorkspaceCwd: () => {
                if (!session) return null
                try {
                    return session.currentWorkspaceCwd()
                }
                catch {
                    return null
                }
            },
        })
        if (n === 0) {
            // 没运行时（或非 Windows）：族保持关闭，并登记"装好后重新挂载"的回调。
            shell.setShellRemount(async () => {
                const remounted = await mountShellFamily()
                return remounted > 0
            })
            beacon(resolveShellReason(shell))
            return 0
        }
        shell.setShellRemount(null)
        beacon(`bash.apply ok (${n} tool)`)
        try { shell.mountJobCleanup(ctx) }
        catch (error) { beacon(`job cleanup mount FAILED: ${error instanceof Error ? error.message : String(error)}`) }
        try {
            const path = shell.pickBash()
            try {
                const policyService = ctx.get('sandboxPolicy')
                const sandboxService = ctx.get('sandbox')
                beacon(`sandbox services: policy=${policyService ? 'yes' : 'no'} confine=${typeof sandboxService?.confine === 'function' ? 'yes' : 'no'}`)
            }
            catch (probeError) { beacon(`sandbox services probe FAILED: ${probeError instanceof Error ? probeError.message : String(probeError)}`) }
            beacon(path === null ? 'shell runtime missing' : `bash runtime: ${path}`)
            // 有运行时才隐藏宿主自带的 pwsh/pwsh_persistent（省常驻 schema + 避免两个 shell 争抢）。
            try {
                const hostShell = await import('./shell/host-shell.js')
                const result = hostShell.mountHostShellHiding(ctx, beacon)
                beacon(`host shell hiding: ${result.mounted ? 'mounted' : `skipped (${result.reason})`}`)
            }
            catch (error) {
                beacon(`host shell hiding FAILED: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
        catch { /* 探测失败不影响注册 */ }
        return n
    }
    try {
        await mountShellFamily()
    }
    catch (error) {
        beacon(`bash.apply FAILED: ${error instanceof Error ? error.message : String(error)}`)
        warn(ctx, `bash 未注册（${error instanceof Error ? error.message : String(error)}）`)
    }

    // --- 8) 文件读写（read/stat/write/edit/copy/move/remove/mkdir）—— 替代被移除的 ops 文件族：
    //        编码探测（BOM/UTF-8/GB18030）、多文件多区间、二进制 hex、revision CAS + 原子写。
    try {
        const file = await import('./file/index.js')
        const n = file.apply(scopes.get('file'), safeDefineTool, {
            resolveWorkspaceCwd: () => {
                if (!session) return null
                try {
                    return session.currentWorkspaceCwd()
                }
                catch {
                    return null
                }
            },
        })
        beacon(`file.apply ok (${n} tool: ${namesOf(() => file.tools(defineTool, {}))})`)
    }
    catch (error) {
        beacon(`file.apply FAILED: ${error instanceof Error ? error.message : String(error)}`)
        warn(ctx, `file 未注册（${error instanceof Error ? error.message : String(error)}）`)
    }

    // --- 9) 按需帮助（toolkit_help）—— 把"怎么选/怎么解读输出/有哪些坑"从常驻 schema 里挪出来，
    //        需要时一次调用取回（文档 docs/TOOLKIT.md，懒加载，缺失只降级不抛）
    try {
        const help = await import('./help/index.js')
        const n = help.apply(scopes.get('help'), safeDefineTool)
        beacon(`help.apply ok (${n} tool: ${namesOf(() => help.tools(defineTool))})`)
    }
    catch (error) {
        beacon(`help.apply FAILED: ${error instanceof Error ? error.message : String(error)}`)
        warn(ctx, `toolkit_help 未注册（${error instanceof Error ? error.message : String(error)}）`)
    }

}

/** 只装一次、与家族开关无关的三段（8–10）：工具路由段、权限模式探测、设置表单探测。 */
async function applyAux(ctx) {
    // --- 8) 由**注册表**生成的工具路由段（`ctx.systemPrompt.section`）—————————————
    // 宿主作者指引明确支持这个 API；但它的选项形状没有公开文档 ⇒ 全程 try/catch + 信标：
 // **形状不对只损失这一段**，绝不影响上面 13 个工具的注册（守住 那个"整段消失"的教训）。
    // 只广告实际挂载的工具名（家族缺失/未启用 ⇒ 对应行自动消失），所以不会出现陈旧名。
    try {
        const routing = await import('./routing.js')
        const visibleNames = (scope) => {
            try {
                const list = scope.get('tools')?.schemas?.() ?? []
                return list.map((t) => t?.name).filter((n) => typeof n === 'string')
            }
            catch { return [] }
        }
        ctx.inject(['systemPrompt'], (spCtx) => {
            // 服务可能"在但还没就绪"（见 routing.retryRegister 的注释）⇒ 立刻试 + 有界重试，
            // 否则这段在本会话里**永远**不会出现（实测：同一台机器两次 boot 一次成功一次跳过）。
            const readService = () => { try { return spCtx.get('systemPrompt') } catch { return undefined } }
            routing.retryRegister((attempt) => {
                const sp = readService()
                if (typeof sp?.section !== 'function') return false
                try {
                    spCtx.effect(() => {
                        const dispose = sp.section({
                            name: 'dsh-toolkit:routing',
                            order: 3260,
                            interpolate: false,
                            text: () => routing.renderRouting(visibleNames(spCtx)),
                        })
                        return () => { try { dispose?.() } catch { /* 释放失败不影响其它段 */ } }
                    }, 'dsh-toolkit: routing section')
                }
                catch (error) {
                    // effect/section 抛错不是"服务晚到"，重试也没用
                    beacon(`routing section FAILED: ${error instanceof Error ? error.message : String(error)}`)
                    return true
                }
                beacon(`routing section registered (systemPrompt.section, attempt ${attempt})`)
                return true
            }, {
                delays: [150, 600, 2000],
                onGiveUp: (attempts) => beacon(`systemPrompt.section unavailable; routing section skipped (${attempts} attempts)`),
            })
        })
    }
    catch (error) {
        beacon(`routing section FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }

    // --- 9) 会话权限探测（`sandboxPolicy`）————————————————————————————————
    // 宿主把权限模式放在 `sandboxPolicy` 服务里，但**形状未公开** ⇒ 只探测 + 记信标（零成本、不阻断）：
    // 只有读到 `read-only` 时才让写盘操作提前给出清晰拒绝；读不到就保持既有行为（不做任何收紧）。
    try {
        const policyMod = await import('./policy.js')
        ctx.inject(['sandboxPolicy'], (policyCtx) => {
            const service = policyCtx.get('sandboxPolicy')
            const info = policyMod.probePolicyService(service)
            policyMod.setCurrentMode(info.mode)
            beacon(`sandboxPolicy: mode=${info.mode ?? 'unknown'} keys=[${info.keys.join(',')}]`)
        })
    }
    catch (error) {
        beacon(`sandboxPolicy probe FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }

    // --- 10) 设置表单探测（`settings.describe()`）——————————————————————————————
    // 宿主"插件设置"页只投影 `.volatile()` 字段，命名空间 = **profile 条目的 id**。这里把宿主的
    // 表单描述符写进信标，用来**实证**"我们的 volatile 家族开关确实进了表单"（而不是靠猜）。
    // 形状未公开 ⇒ 全程 try/catch + 只记摘要；读不到就零影响。
    try {
        ctx.inject(['settings'], (settingsCtx) => {
            const probe = (when) => {
                try {
                    const service = settingsCtx.get ? settingsCtx.get('settings') : settingsCtx.settings
                    if (typeof service?.describe !== 'function') {
                        beacon(`settings.describe unavailable (${when})`)
                        return
                    }
                    const raw = service.describe()
                    const rows = Array.isArray(raw) ? raw : Object.entries(raw ?? {}).map(([ns, v]) => ({ ns, ...(v ?? {}) }))
                    const mine = rows.filter((r) => String(r?.ns ?? r?.id ?? '').includes('dsh-toolkit'))
                    const names = rows.map((r) => r?.ns ?? r?.id).filter(Boolean)
                    beacon(`settings.describe (${when}): ${rows.length} 个表单 [${names.join(', ')}]；本插件命中 ${mine.length}`)
                    for (const row of mine) {
                        let keys = []
                        try { keys = Object.keys(row.schema?.properties ?? row.fields ?? {}) }
                        catch { keys = [] }
                        let dump = ''
                        try { dump = JSON.stringify(row).slice(0, 700) }
                        catch (error) { dump = `unserializable: ${error instanceof Error ? error.message : String(error)}` }
                        beacon(`settings.form ns=${row.ns ?? row.id} 字段=[${keys.join(', ')}] 描述符键=[${Object.keys(row).join(',')}]`)
                        beacon(`settings.form dump: ${dump}`)
                    }
                }
                catch (error) {
                    beacon(`settings.describe FAILED (${when}): ${error instanceof Error ? error.message : String(error)}`)
                }
            }
            probe('immediate')
            // 自己的条目在 apply 期间还没 start 完 ⇒ `describe()` 立刻查是看不到自己的，必须稍后再探。
            // 定时器 `unref()`：不阻止进程退出（一次性/无头运行里没等到也不算错）。
            for (const delay of [1000, 4000]) {
                try {
                    const timer = setTimeout(() => probe(`after ${delay}ms`), delay)
                    if (typeof timer?.unref === 'function') timer.unref()
                }
                catch { /* 定时器不可用：只留首次探测 */ }
            }
        })
    }
    catch (error) {
        beacon(`settings probe FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }

    // --- 11) bash 安装路由（设置页的"有没有装 / 一键装"）————————————————————
    // 走宿主 webServer 的精确路由（与 dshmarket 同一路子）。任何一步失败只损失这两个路由，
    // 设置页退化成"没有安装按钮"，不影响工具注册。
    try {
        const routes = await import('./shell/routes.js')
        routes.mountBashRoutes(ctx, beacon)
    }
    catch (error) {
        beacon(`bash routes import FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }

    beacon('apply() done')
}



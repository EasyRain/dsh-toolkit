/**
 * dsh-toolkit —— 浏览器半（**手写**，不引构建链；）。
 *
 * 形态就是 dsh 客户端模块系统要的 lazy-CJS 工厂（对照本机已安装的 dsh-context /
 * dsh-better-sidebar 产物头尾确认过）：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => exports })
 * `id` 必须是**包名**（宿主把浏览器半挂在"specifier = 裸包名"的那一行上）。
 *
 * 这一半干什么：在 **设置（Settings）** 里加一节"工具集"，把六个家族开关做成真正的开关。
 * 依据（都来自 dsh 源码 / 本机已装插件的源码，不是猜的）：
 *   - 设置节注册到槽位 **`settings.section`**（`name/id/order/label`；0.2.0-rc.2 只投影
 *     id/order/label，图标由 shell 自己挑）—— 实证：dsh-better-sidebar 的
 *     `src/client/index.tsx:433`（MIT，本机安装版自带 src/）。
 *   - 值走客户端服务 **`ctx.configForms`**（`get(ns)` → `{ getSnapshot, subscribe, set, unset,
 *     mutate }`）；`whileServed([ns], register)` 只在宿主确实在服务这个命名空间时登记 ——
 *     实证：`@deepseek-ai/dsh-client-ui-settings` 的 `config-form-types.ts`（类型即契约）。
 *   - 命名空间 = **profile 条目 id**，只有 `.volatile()` 字段会被投影（宿主侧对应
 *     `lib/config-schema.js`）。改值经 ConfigEditor 落进 profile 的 patch 文件，宿主随后向该
 *     fiber 发 `loader/volatile-update`。
 *
 * 只用平台自带模块 `react`（PLATFORM_MODULES 里就有），其余全靠 ctx 服务 ⇒ 不需要打包器。
 */

window.__ModuleLoader__.load({
    id: 'dsh-toolkit',
    factory: (require) => {
        const React = require('react')
        const h = React.createElement

        /** 表单命名空间 = 我们的 profile 条目 id */
        const NS = 'dsh-toolkit'

        const DICT_ZH = {
            nav: '工具集',
            title: '工具集（dsh-toolkit）',
            desc: '**默认全部关闭**：不用的族不注册它的工具（省下常驻 schema）。按需打开，改完立即生效。',
            loading: '正在读取配置…',
            unavailable: '宿主没有把这个插件的配置暴露给本页面（配置不可写）。',
            readOnly: '当前配置层不可写（可能被上层 patch 覆盖）。',
            on: '开',
            off: '关',
            failed: '写入被拒绝，已回读宿主的真实值。',
            ast: 'AST 结构检索与改名',
            astHint: 'ast_search / ast_dump_tree / ast_test_rule / ast_edit（4 个）',
            table: '表对比',
            tableHint: 'table_diff / table_peek —— 任意表格式，哈希连接 O(N+M)',
            session: '会话日志',
            sessionHint: 'session_list / session_read / session_diff / session_export（4 个）',
            checkpoint: '快照与回滚',
            checkpointHint: 'checkpoint（7 个动作）+ /checkpoint、/rewind 命令',
            download: '下载器',
            downloadHint: 'download（start / probe / status / cancel）多线程 + 断点续传',
            shell: 'Bash 执行器',
            shellHint: 'bash（Git Bash：POSIX 管道/引号；超时杀整棵进程树）',
            file: '文件读写',
            fileHint: 'file（read/stat/write/edit/copy/move/remove/mkdir；编码探测 + revision CAS）',
            bashMissing: '没检测到 bash（Git Bash）。装好之前这个开关不能打开。',
            bashHostOwned: '当前平台由宿主自带的 bash 接管；本族只在 Windows 启用。',
            runtimeFound: 'bash 运行时已就绪',
            runtimeMissing: '还没有安装 bash 运行时（约 33 MB）。装好后即可在任意会话里使用 bash。',
            runtimeUnsupported: '当前平台/架构没有可用的 bash 运行时载荷。',
            runtimeInstallMirror: '从国内加速安装',
            runtimeInstallGithub: '从 GitHub 安装',
            bashFound: '已检测到 bash',
            installMirror: '从国内镜像安装',
            installGithub: '从 GitHub 安装',
            installing: '安装中…',
            installFailed: '安装失败',
            help: '按需帮助',
            helpHint: 'toolkit_help（14 个主题）—— 取代把细节塞进常驻 schema',
        }

        const DICT_EN = {
            nav: 'Toolkit',
            title: 'Toolkit (dsh-toolkit)',
            desc: 'Every family starts OFF: a disabled family registers no tools (less resident schema). Turn on what you need; changes apply immediately.',
            loading: 'Loading configuration…',
            unavailable: 'The Host does not expose this plugin’s configuration to this page.',
            readOnly: 'This configuration layer is read-only (probably overridden by a patch above).',
            on: 'On',
            off: 'Off',
            failed: 'The write was refused; the Host value was re-read.',
            ast: 'AST search & rename',
            astHint: 'ast_search / ast_dump_tree / ast_test_rule / ast_edit (5)',
            table: 'Table diff',
            tableHint: 'table_diff / table_peek — any table format, hash join O(N+M)',
            session: 'Session logs',
            sessionHint: 'session_list / session_read / session_diff / session_export (4)',
            checkpoint: 'Checkpoint & rewind',
            checkpointHint: 'checkpoint (7 actions) + /checkpoint, /rewind',
            download: 'Downloader',
            downloadHint: 'download (start / probe / status / cancel), multi-thread + resume',
            shell: 'Bash shell',
            shellHint: 'bash (Git Bash: POSIX pipelines/quoting; kills the process tree on timeout)',
            file: 'File access',
            fileHint: 'file (read/stat/write/edit/copy/move/remove/mkdir; encoding probe + revision CAS)',
            bashMissing: 'bash (Git Bash) was not found. This switch stays off until it is installed.',
            bashHostOwned: 'The host ships its own bash on this platform; this family is Windows-only.',
            runtimeFound: 'bash runtime ready',
            runtimeMissing: 'The bash runtime is not installed yet (~33 MB). Install it once and bash works in every session.',
            runtimeUnsupported: 'No bash runtime payload exists for this platform/arch.',
            runtimeInstallMirror: 'Install via mirror',
            runtimeInstallGithub: 'Install from GitHub',
            bashFound: 'bash detected',
            installMirror: 'Install from the China mirror',
            installGithub: 'Install from GitHub',
            installing: 'Installing…',
            installFailed: 'Install failed',
            help: 'On-demand help',
            helpHint: 'toolkit_help (14 topics)',
        }

        /** 顺序即表单里的顺序；键名必须与 lib/config-schema.js 的 FAMILY_TOGGLES 一致。 */
        // `help`（toolkit_help）**常开**且不在这里：它是 agent 查询"哪些族开了 / 怎么开"的入口，
        // 关掉它就没人能告诉你还能用什么。
        const FIELDS = ['ast', 'table', 'session', 'checkpoint', 'download', 'shell', 'file']

        const S = {
            head: { fontWeight: 600, fontSize: 13, marginBottom: 2 },
            sub: { fontSize: 12, opacity: 0.72, marginBottom: 12, lineHeight: 1.6 },
            row: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)' },
            text: { flex: '1 1 auto', minWidth: 0 },
            name: { fontSize: 13, lineHeight: 1.5 },
            hint: { fontSize: 12, opacity: 0.66, lineHeight: 1.55, marginTop: 2 },
            box: { font: 'inherit' },
            state: { fontSize: 12, opacity: 0.72, padding: '8px 0' },
            bashBox: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 },
            btnRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
            btn: { font: 'inherit', fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', background: 'transparent', cursor: 'pointer' },
        }

        /** 订阅快照：`subscribe` 返回 disposer，快照引用稳定到下次变化。 */
        function useSnapshot(form) {
            const [snap, setSnap] = React.useState(() => {
                try { return form.getSnapshot() } catch (error) { return { status: 'unavailable', error } }
            })
            React.useEffect(() => {
                let disposed = false
                const sync = () => { if (!disposed) { try { setSnap(form.getSnapshot()) } catch { /* 保持上一份快照 */ } } }
                sync()
                let off = () => {}
                try { off = form.subscribe(sync) } catch { /* 订阅不上就只显示首帧 */ }
                return () => { disposed = true; try { off() } catch { /* 释放失败无妨 */ } }
            }, [form])
            return snap
        }

        function Switch(props) {
            const { checked, disabled, onToggle, label } = props
            return h('input', {
                type: 'checkbox',
                checked,
                disabled,
                'aria-label': label,
                style: { width: 34, height: 18, margin: '2px 0 0', flex: '0 0 auto', accentColor: 'var(--dsw-alias-brand, currentColor)', cursor: disabled ? 'default' : 'pointer' },
                onChange: (event) => { onToggle(event.currentTarget.checked) },
            })
        }

        /** 宿主路由：bash 的检测与安装（见 lib/shell/routes.js） */
        const BASH_STATUS_PATH = 'dsh-toolkit/bash/status'
        const BASH_INSTALL_PATH = 'dsh-toolkit/bash/install'
        const RUNTIME_INSTALL_PATH = 'dsh-toolkit/bash/runtime/install'
        const RUNTIME_STATUS_PATH = 'dsh-toolkit/bash/runtime/status'

        /** 相对路径 → 当前页面可 fetch 的绝对路径（与 dshmarket 的 api() 同思路）。 */
        function apiPath(path) {
            const relative = String(path).replace(/^\/+/, '')
            if (typeof document === 'undefined') return `/${relative}`
            try { return new URL(relative, document.baseURI).pathname } catch { return `/${relative}` }
        }

        async function readBashStatus() {
            if (typeof fetch !== 'function') return null
            try {
                const response = await fetch(apiPath(BASH_STATUS_PATH), { headers: { accept: 'application/json' }, cache: 'no-store' })
                if (response === null || response === undefined || response.ok !== true) return null
                return await response.json()
            }
            catch { return null }
        }

        function requestInstall(source) {
            if (typeof fetch !== 'function') return Promise.resolve(null)
            return fetch(apiPath(BASH_INSTALL_PATH), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source }),
            }).then((response) => response.json()).catch(() => null)
        }

        /** 受限运行时（沙箱里的 bash）的探测与安装 —— 与 dsh-ops 无关，自己装一份 Niubash。 */
        async function readRuntimeStatus() {
            if (typeof fetch !== 'function') return null
            try {
                const response = await fetch(apiPath(RUNTIME_STATUS_PATH), { headers: { accept: 'application/json' }, cache: 'no-store' })
                if (response === null || response === undefined || response.ok !== true) return null
                return await response.json()
            }
            catch { return null }
        }

        function requestRuntimeInstall(source = 'mirror') {
            if (typeof fetch !== 'function') return Promise.resolve(null)
            return fetch(apiPath(RUNTIME_INSTALL_PATH), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source }),
            }).then((response) => response.json()).catch(() => null)
        }

        /**
         * 开关是否禁用：不可写时全禁；**bash 没装时只禁 shell**（用户明确要求"没装就不给打开"）。
         * `bash === null` 表示"还没探测出来"——此时不要误禁。
         */
        function isSwitchDisabled(key, writable, bash, runtime) {
            if (writable !== true) return true
            if (key !== 'shell') return false
            // POSIX：宿主自带 bash 接管，本族不启用（不是"装了没有"的问题）。
            if (bash !== null && bash !== undefined && typeof bash.platform === 'string' && bash.platform !== 'win32') return true
            // Windows：**只认我们自己装的运行时**（系统 Git Bash 不参与，装了也不会被使用）。
            // 还没探测出来（runtime 为 null）时先不禁用，避免界面闪一下。
            if (runtime === null || runtime === undefined) return false
            return runtime.available !== true
        }

        function makeSection(form, t) {
            return function ToolkitSettingsSection() {
                const snap = useSnapshot(form)
                const [notice, setNotice] = React.useState('')
                const [bash, setBash] = React.useState(null)
                const [runtime, setRuntime] = React.useState(null)
                const status = snap?.status ?? 'loading'
                const value = (snap && typeof snap.value === 'object' && snap.value !== null) ? snap.value : {}
                const writable = status === 'ready' && snap?.writable !== false

                // 进入卡片时探测一次 bash；装的过程中每 1.5 s 轮询一次，直到不是 installing。
                React.useEffect(() => {
                    let alive = true
                    readBashStatus().then((next) => {
                        if (!alive || next === null) return
                        setBash(next)
                        if (next.runtime !== undefined) setRuntime(next.runtime)
                    })
                    readRuntimeStatus().then((next) => { if (alive && next !== null) setRuntime(next) })
                    return () => { alive = false }
                }, [])

                const launchRuntimeInstall = (source) => {
                    setNotice('')
                    requestRuntimeInstall(source).then((result) => {
                        if (result && result.status) setRuntime(result.status)
                        const tick = (left) => {
                            if (left <= 0) return
                            readRuntimeStatus().then((next) => {
                                if (next !== null) setRuntime(next)
                                if (next !== null && next.job && next.job.state === 'installing') setTimeout(() => tick(left - 1), 1500)
                            })
                        }
                        setTimeout(() => tick(240), 800)
                    })
                }

                const launchInstall = (source) => {
                    setNotice('')
                    requestInstall(source).then((result) => {
                        if (result && result.status) setBash(result.status)
                        const tick = (left) => {
                            if (left <= 0) return
                            readBashStatus().then((next) => {
                                if (next !== null) setBash(next)
                                if (next !== null && next.job && next.job.state === 'installing') setTimeout(() => tick(left - 1), 1500)
                            })
                        }
                        setTimeout(() => tick(240), 800)
                    })
                }

                const bashFooter = () => {
                    if (bash === null) return null
                    if (typeof bash.platform === 'string' && bash.platform !== 'win32') return h('div', { key: 'bash', style: S.hint }, t('bashHostOwned'))
                    const job = (runtime && runtime.job) || {}
                    const installing = job.state === 'installing'
                    if (runtime !== null && runtime !== undefined && runtime.available === true) {
                        return h('div', { key: 'bash', style: S.hint }, `${t('runtimeFound')}: ${runtime.path}`)
                    }
                    if (runtime !== null && runtime !== undefined && runtime.canInstall !== true) {
                        return h('div', { key: 'bash', style: S.hint }, t('runtimeUnsupported'))
                    }
                    return h('div', { key: 'bash', style: S.bashBox }, [
                        h('div', { key: 'm', style: S.hint }, t('runtimeMissing')),
                        h('div', { key: 'b', style: S.btnRow }, [
                            h('button', { key: 'mirror', type: 'button', style: S.btn, disabled: installing, onClick: () => launchRuntimeInstall('mirror') }, t('runtimeInstallMirror')),
                            h('button', { key: 'github', type: 'button', style: S.btn, disabled: installing, onClick: () => launchRuntimeInstall('github') }, t('runtimeInstallGithub')),
                        ]),
                        installing ? h('div', { key: 'p', style: S.hint }, `${t('installing')} ${job.progress && job.progress.percent ? `${job.progress.percent}%` : ''}`) : null,
                        job.state === 'failed' ? h('div', { key: 'e', style: S.hint }, `${t('installFailed')}: ${job.error ?? ''}`) : null,
                    ])
                }

                const onToggle = (key, next) => {
                    setNotice('')
                    let settled
                    try { settled = form.set(key, next) } catch (error) { settled = Promise.reject(error) }
                    Promise.resolve(settled).then((ok) => { if (ok === false) setNotice(t('failed')) }, () => { setNotice(t('failed')) })
                }

                const runtimeReady = runtime !== null && runtime !== undefined && runtime.available === true
                const rows = FIELDS.map((key) => {
                    // 未写过的字段读到的是 schema 默认值 false；只有显式 true 才算开（与宿主侧同口径）。
                    // shell 族例外：运行时没装时宿主**不注册**这个族（等价于关闭），所以界面上也显示为关。
                    const checked = value[key] === true && (key !== 'shell' || runtimeReady || runtime === null)
                    return h('div', { key, style: S.row }, [
                        h(Switch, { key: 'sw', checked, disabled: isSwitchDisabled(key, writable, bash, runtime), label: t(key), onToggle: (next) => { onToggle(key, next) } }),
                        h('div', { key: 'tx', style: S.text }, [
                            h('div', { key: 'n', style: S.name }, t(key)),
                            h('div', { key: 'h', style: S.hint }, t(key + 'Hint')),
                            key === 'shell' ? bashFooter() : null,
                        ]),
                    ])
                })

                const state = status === 'ready'
                    ? (writable ? (notice ? h('div', { style: S.state }, notice) : null) : h('div', { style: S.state }, t('readOnly')))
                    : h('div', { style: S.state }, status === 'unavailable' ? t('unavailable') : t('loading'))

                return h('div', { style: S.box }, [
                    h('div', { key: 't', style: S.head }, t('title')),
                    h('div', { key: 'd', style: S.sub }, t('desc')),
                    state,
                    status === 'ready' ? h('div', { key: 'rows' }, rows) : null,
                ])
            }
        }

        /**
         * 只做三件事：绑字典 → 拿 configForms 的命名空间视图 → 在宿主服务该命名空间时登记设置节。
         * 全程"可选缝"：任一服务缺席都只是**这一节不出现**，不影响插件其它部分。
         */
        function apply(ctx) {
            let locale = null
            try {
                ctx.inject(['locale'], (c) => {
                    locale = c.locale
                    try { locale.register(NS, { zh: DICT_ZH, en: DICT_EN }) } catch { /* 字典注册失败就用内置中文 */ }
                })
            }
            catch { /* 没有 locale 服务：用内置中文 */ }

            const t = (key) => {
                try {
                    const text = locale && typeof locale.lookup === 'function' ? locale.lookup(NS, key) : undefined
                    if (typeof text === 'string' && text !== '') return text
                }
                catch { /* 查字典失败：回退 */ }
                return DICT_ZH[key] ?? key
            }

            try {
                ctx.inject(['configForms'], (c) => {
                    const forms = c.configForms
                    if (forms === null || typeof forms !== 'object' || typeof forms.get !== 'function') return
                    const form = forms.get(NS)
                    if (form === null || typeof form !== 'object' || typeof form.getSnapshot !== 'function') return
                    const Section = makeSection(form, t)
                    const register = () => c.slots.inject('settings.section', () => c.slots.register({
                        name: 'settings.section',
                        id: NS,
                        order: 60,
                        label: () => t('nav'),
                    }, Section))
                    // whileServed 的第二个参数是"登记函数"，返回它的 disposer（与官方 ui-settings-shell 同形）。
                    c.effect(() => forms.whileServed([NS], register), 'dsh-toolkit: settings section')
                })
            }
            catch { /* configForms 缺席：设置节不出现，插件其余部分照常 */ }
        }

        return {
            name: 'dsh-toolkit',
            inject: ['slots'],
            apply,
            // 测试缝（只给 client-half 自测用；宿主不会读它）
            __internals: { isSwitchDisabled, apiPath, BASH_STATUS_PATH, BASH_INSTALL_PATH },
        }
    },
})

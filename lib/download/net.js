/**
 * lib/download/net.js —— **零依赖**的网络底层（为多线程下载器而写）。
 *
 * 为什么不用 `fetch`/undici：
 *  - 需要**精确控制 Range、每连接独立请求、代理隧道**，以及"首字节/连接耗时"这类可测量指标；
 *  - 宿主环境里代理往往是 **代理软件 之类的本机代理**（用户实测：直连尚可、走代理就卡），
 *    而 Node 的 `fetch` **不读 Windows 系统代理**，`http.request` 也不会 —— 必须自己处理：
 *      ① `proxy: 'auto'` ⇒ 读注册表 `Internet Settings`（代理软件"系统代理"开关写的就是它）
 *      ② 显式 `proxy: 'http://127.0.0.1:7890'` / `'socks5h://127.0.0.1:7891'`（带账号密码也行）
 *      ③ 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含小写）
 *  - 代理实现：HTTP 代理 **CONNECT 隧道**（https 目标）与绝对形式请求（http 目标）；
 *    SOCKS5（含 `socks5h` 远程解析域名）与 RFC1929 账号密码认证。
 *
 * 只做"能拿数据"这件事；分片/续传/校验在 `engine.js`。
 */
import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

export const MAX_REDIRECTS = 6
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

const DEFAULT_UA = 'dsh-toolkit-download/0.4 (+node)'

/** 读 Windows「Internet Settings」里的系统代理（代理软件 打开"系统代理"就是写这里）。非 Windows 或没开则 null。 */
export function getSystemProxy() {
    if (process.platform !== 'win32') return null
    let out = ''
    try {
        out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true })
    }
    catch { return null }
    const server = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out)?.[1]?.trim() ?? null
    const override = (/ProxyOverride\s+REG_SZ\s*([^\r\n]*)/i.exec(out)?.[1] ?? '').trim()
    const pacUrl = /AutoConfigURL\s+REG_SZ\s*([^\r\n]+)/i.exec(out)?.[1]?.trim() ?? null
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)
    if (!enabled) {
 // ⚠️ 实测（本机代理软件）：`ProxyEnable=0` **但 `AutoConfigURL` 有值** ⇒ 系统走 **PAC**，
        // 固定代理是关的。以前这里直接 `return null` ⇒ 报"检测不到系统代理"。现在把 PAC 一起带出去给上层。
        return pacUrl === null ? null : { url: null, override: override.split(';').map((s) => s.trim()).filter(Boolean), pacUrl, source: 'system PAC' }
    }
    if (!server) return null
    // 形式二选一：`host:port` 或 `http=host:port;https=host:port;socks=host:port`
    const perProto = (proto) => new RegExp(`(?:^|;)${proto}=([^;]+)`, 'i').exec(server)?.[1]?.trim()
    const plain = /^[\w.-]+:\d+$/.test(server) ? server : null
    const chosen = perProto('https') ?? plain ?? perProto('http') ?? perProto('socks')
    if (!chosen) return null
    const socks = perProto('socks') === chosen
    return {
        url: `${socks ? 'socks5h' : 'http'}://${chosen}`,
        override: override.split(';').map((s) => s.trim()).filter(Boolean),
        source: 'system (registry)',
    }
}

/** 常见本地代理端口 → 协议（探测兜底；7890 是最常见的 mixed 端口（HTTP 一定能用）） */
const LOCAL_PROXY_PORTS = [
    [7890, 'http'],      // 最常见的 mixed 端口
    [7891, 'socks5h'],   // 常见的 socks 端口
    [10809, 'http'],     // v2rayN http
    [10808, 'socks5h'],  // v2rayN socks
    [1080, 'socks5h'],   // 通用 socks
    [8889, 'http'],
]

/** 探测常见本地代理端口（返回第一个能连上的；**标注来源是"探测"**，不是系统配置） */
export async function probeLocalProxyPorts(timeoutMs = 250) {
    for (const [port, kind] of LOCAL_PROXY_PORTS) {
        const ok = await new Promise((resolve) => {
            const sock = netConnect({ host: '127.0.0.1', port })
            const done = (v) => { try { sock.destroy() } catch { /* ignore */ } ; resolve(v) }
            sock.setTimeout(timeoutMs, () => done(false))
            sock.once('connect', () => done(true))
            sock.once('error', () => done(false))
        })
        if (ok) return { url: `${kind}://127.0.0.1:${port}`, override: [], source: `probed port ${port}` }
    }
    return null
}

/** 从 PAC 文本里抠代理字面量（**不执行 JS**：代理软件生成的 PAC 里通常就有 `PROXY 127.0.0.1:7890`） */
export function proxyFromPacText(text) {
    const http = /PROXY\s+([\w.\-]+:\d+)/i.exec(text)
    const socks = /SOCKS5?\s+([\w.\-]+:\d+)/i.exec(text)
    const bare = /(127\.0\.0\.1|localhost):(\d{2,5})/.exec(text)
    if (http) return { url: `http://${http[1]}`, override: [], source: 'PAC (PROXY 字面量)' }
    if (socks) return { url: `socks5h://${socks[1]}`, override: [], source: 'PAC (SOCKS 字面量)' }
    if (bare) return { url: `http://${bare[1]}:${bare[2]}`, override: [], source: 'PAC (本地端口)' }
    return null
}

/** 拉 PAC 文本（直连；PAC 通常就是本机地址） */
function fetchPacText(pacUrl, timeoutMs = 3000) {
    return new Promise((resolve) => {
        let u
        try { u = new URL(pacUrl) }
        catch { return resolve(null) }
        const fn = u.protocol === 'https:' ? httpsRequest : httpRequest
        const req = fn({ method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`, timeout: timeoutMs }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            res.on('error', () => resolve(null))
        })
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
        req.on('error', () => resolve(null))
        req.end()
    })
}

/** 环境变量代理（大小写都认） */
export function getEnvProxy() {
    const pick = (name) => process.env[name] ?? process.env[name.toLowerCase()]
    const raw = pick('HTTPS_PROXY') ?? pick('ALL_PROXY') ?? pick('HTTP_PROXY')
    if (!raw) return null
    const no = pick('NO_PROXY') ?? ''
    return { url: raw, override: no.split(',').map((s) => s.trim()).filter(Boolean), source: 'env' }
}

/**
 * **直连/绕过**（定案，用户明确否掉了"逐条维护直连清单"的做法）：
 *
 * `auto` 就**老实跟随系统代理**，不做任何按域名的自作聪明 —— 代理若在 **PAC/规则模式**，
 * 究竟直连还是走代理由**代理自己**决定（代理软件的规则表比我们手写清单靠谱得多）；若是**全局模式**，
 * 那就全走代理。需要绕过某次下载时（地址本就可达、或实测走代理反而更慢 —— 视你的网络而定）**显式**给
 * `proxy: 'direct'`；环境变量 `NO_PROXY / no_proxy` 也照常生效（标准行为，零配置）。
 */
const isBypassed = (host, override) => {
    if (override.length === 0) return false
    const h = String(host).toLowerCase()
    for (const raw of override) {
        const pat = raw.toLowerCase()
        if (pat === '<local>' && (h === 'localhost' || h.startsWith('127.') || h === '::1')) return true
        if (pat === '*') return true
        if (pat.startsWith('.')) { if (h === pat.slice(1) || h.endsWith(pat)) return true }
        // `*.example.com` / `*example.com` 这类通配写法也要认（用户手写清单的常见写法）
        else if (pat.startsWith('*.')) { const tail = pat.slice(1); if (h.endsWith(tail) || h === pat.slice(2)) return true }
        else if (pat.startsWith('*')) { if (h.endsWith(pat.slice(1))) return true }
        else if (h === pat || h.endsWith(`.${pat}`)) return true
    }
    return false
}

/**
 * "强制直连"的写法。**对外只宣传 `direct`** —— `none` 在别处常表示"不指定"，和 `auto` 容易混淆
 * （上下文一长就会把两者记混）；`none`/`off`/`false` 作为**历史别名**继续接受，老会话里的参数不会失效。
 */
export const DIRECT_OPTIONS = ['direct', 'none', 'off']
export const isDirectOption = (option) => option === false || DIRECT_OPTIONS.includes(String(option ?? '').trim().toLowerCase())

/**
 * 归一化代理设置。
 * @param {string|false|null|undefined} option `'auto'`(默认) / `'direct'` / `'http://127.0.0.1:7890'` / `'socks5h://…'`
 *        （`'none'` / `'off'` / `false` 是 `'direct'` 的别名，仍然可用）
 * @returns {{kind:'none'|'http'|'socks5', host?:string, port?:number, auth?:{user:string,pass:string}, remoteDns?:boolean, override?:string[], source:string}}
 */
export function resolveProxy(option, host = null) {
    const want = option === undefined || option === null || option === '' ? 'auto' : option
    if (isDirectOption(want)) return { kind: 'none', source: 'explicit direct' }
    let spec = null
    if (want === 'auto' || want === true) spec = getSystemProxy() ?? getEnvProxy()
    else spec = { url: String(want), override: [], source: 'explicit' }
    if (spec === null) return { kind: 'none', source: 'no proxy configured' }
    if (host !== null && isBypassed(host, spec.override ?? [])) return { kind: 'none', source: `bypass (${spec.source})` }
    let u
    try { u = new URL(spec.url) }
    catch { return { kind: 'none', source: `unparsable proxy ${maskCredentials(spec.url)}` } }
    const scheme = u.protocol.replace(':', '').toLowerCase()
    const kind = scheme.startsWith('socks') ? 'socks5' : 'http'
    const port = u.port ? Number(u.port) : (kind === 'socks5' ? 1080 : 8080)
    const auth = u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined
    return {
        kind,
        host: u.hostname,
        port,
        ...(auth ? { auth } : {}),
        ...(kind === 'socks5' ? { remoteDns: scheme === 'socks5h' } : {}),
        override: spec.override ?? [],
        source: spec.source,
    }
}

/**
 * **异步**代理解析（`auto` 的完整链路）：显式 → 注册表固定代理 → **PAC 里的代理字面量** → 环境变量 → **探测常见本地端口**。
 *
 * 为什么要异步：PAC 需要拉取、端口需要 TCP 探测（用户机器实测：本机代理软件用 **PAC 模式**
 * （`AutoConfigURL` 有值而 `ProxyEnable=0`），只读注册表固定代理会"检测不到"，但端口 7890 明明在监听）。
 * 结果带 `source`，并在工具输出里如实回显，避免"以为是直连其实走了代理"这类误解。
 * @param {string|false|null|undefined} option
 * @param {string|null} host 目标主机（用于 bypass 判定）
 */
export async function resolveProxyAsync(option, host = null) {
    const want = option === undefined || option === null || option === '' ? 'auto' : option
    if (!(want === 'auto' || want === true)) return resolveProxy(option, host)
    // `auto` 不做任何按域名的自作聪明：代理若在 PAC/规则模式，直连还是走代理由**代理自己**决定；
    // 全局模式就全走代理。要绕过就显式 `proxy: 'direct'`（地址本就可达、或实测走代理更慢的情况）。
    const cacheKey = `auto|${host ?? ''}`
    const hitCache = proxyCache.get(cacheKey)
    if (hitCache !== undefined && Date.now() - hitCache.at < PROXY_CACHE_MS) return hitCache.value

    const sys = getSystemProxy()
    let spec = null
    if (sys !== null && typeof sys.url === 'string' && sys.url !== '') spec = sys
    if (spec === null) {
        // PAC：先拉文本，再从里面抠 `PROXY host:port`（不执行 JS）
        const pacUrl = sys?.pacUrl ?? (getSystemProxy()?.pacUrl ?? null)
        if (pacUrl !== null) {
            const text = await fetchPacText(pacUrl)
            if (text !== null) {
                const fromPac = proxyFromPacText(text)
                if (fromPac !== null) spec = { ...fromPac, override: sys?.override ?? [] }
            }
        }
    }
    if (spec === null) {
        const env = getEnvProxy()
        if (env !== null) spec = env
    }
    if (spec === null) {
        // 最后一招：探测常见本地代理端口（明确标注来源，用户也能看出来这不是系统配置）
        const probed = await probeLocalProxyPorts()
        if (probed !== null) spec = probed
    }
    const value = spec === null ? { kind: 'none', source: 'no proxy configured' } : resolveProxy(spec.url, host)
    // `resolveProxy` 只吃 URL 字符串 ⇒ 来源说明与 **bypass 列表**会丢；这里补回来：PAC 模式下系统的
    // ProxyOverride 仍要生效，否则访问 127.0.0.1/localhost 会被塞进代理（自测/本地服务会莫名失败）
    let finalValue = value
    if (spec !== null) {
        // 系统的 `ProxyOverride` **和** 环境变量 `NO_PROXY`（大小写都认）都要生效 ——
        // 以前只有"代理来自环境变量"时才看 NO_PROXY，走 代理软件（注册表/PAC）时用户的 NO_PROXY 被无视
 // （修：用户明确要求"有些站点只走直连"）。
        const envNo = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const override = [...(Array.isArray(spec.override) ? spec.override : []), ...envNo]
        if (host !== null && override.length > 0 && isBypassed(host, override)) {
            finalValue = { kind: 'none', source: `bypass (${spec.source ?? 'system'}${envNo.length > 0 ? ' / NO_PROXY' : ''})`, override }
        }
        else {
            finalValue = { ...value, source: spec.source ?? value.source, override }
        }
    }
    proxyCache.set(cacheKey, { at: Date.now(), value: finalValue })
    return finalValue
}

const proxyCache = new Map()
const PROXY_CACHE_MS = 30_000

/**
 * **网络故障分类 + 给用户的下一步建议**（由真实网络环境驱动，例如：
 * "某些站点直连经常解析失败、偶尔能连但速度不理想" —— 具体取决于你的网络）。
 *
 * 失败信息不能只说 `fetch failed`：要能分清 **DNS 污染/解析失败**（`ENOTFOUND`/`EAI_AGAIN`）、
 * **连不上**（`ECONNREFUSED`/`ETIMEDOUT`/`EHOSTUNREACH`）、**TLS 被干扰/重置**（`ECONNRESET`/`EPROTO`）、
 * **代理本身有问题**（407/代理拒绝），并给出可执行的出路（先查网络/DNS，其次显式 `proxy:` 指定你的代理）。
 */
export function classifyNetError(error, { proxyKind = 'none' } = {}) {
    const code = String(error?.code ?? '')
    const message = error instanceof Error ? error.message : String(error ?? '')
    // 归一化：调用方可能把**原始选项**传进来（`direct`/`none`/`off`/`false` 都表示直连）
    const isProxy = !(proxyKind === 'none' || isDirectOption(proxyKind))
    if (/ENOTFOUND|EAI_AGAIN|EAI_FAIL|getaddrinfo|DNS/i.test(`${code} ${message}`)) return { kind: 'dns', code, message, isProxy }
    // ⚠️ 我们的超时文案是**中文**（`请求超时（30000 ms 内没有完成）` / `代理请求超时` / `CONNECT … 超时`）⇒ 必须也匹配「超时」，
 // 否则会掉进 unknown 分支、连“下一步怎么办”都不给（另一个会话在 HF 上踩到：只回一句超时，没有任何出路建议 ✗）。
    if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|timeout|超时/i.test(`${code} ${message}`)) return { kind: 'connect', code, message, isProxy }
    if (/ECONNRESET|EPROTO|ERR_SSL|CERT_|socket hang up|TLS/i.test(`${code} ${message}`)) return { kind: 'tls', code, message, isProxy }
    if (/代理/.test(message)) return { kind: 'proxy', code, message, isProxy }
    return { kind: 'unknown', code, message, isProxy }
}

/** 把分类结果翻成"下一步怎么办"，返回若干行（空数组 ⇒ 不需要额外建议） */
export function diagnoseNetError(error, { proxyKind = 'none', proxySource = null, url = '' } = {}) {
    const info = classifyNetError(error, { proxyKind })
    // 「是否直连」统一判：`none`/`off`/`false` 都算 `direct` 的别名（见 isDirectOption）
    const direct = proxyKind === 'none' || isDirectOption(proxyKind)
    const host = (() => { try { return new URL(url).host } catch { return url } })()
    const lines = []
    if (info.kind === 'dns') {
        lines.push(`  诊断：**域名解析失败**（${info.code || 'DNS'}）—— ${host}${/github/i.test(host) ? ' 若你的网络对域名解析有干扰（常见于 DNS 污染）' : ''}`)
        lines.push(direct
            ? '  出路：本机没检测到可用代理 ⇒ ① 先查网络/DNS 本身（换网络、或改用加密 DNS/DoH 后重试）；② 若你另有可用代理，可显式传 `proxy:"http://…"`／`proxy:"socks5h://…"`；有本地代理软件的话，也可打开它的「系统代理」（或 TUN 模式）再重试 —— **代理软件在跑但没设系统代理时，auto 探测不到它，必须显式传地址**'
            : `  出路：代理已启用（${proxyKind}${proxySource ? `，来源 ${proxySource}` : ''}）却解析失败 ⇒ 代理侧解析也失败了，换个节点/规则再试`)
    }
    else if (info.kind === 'connect') {
        lines.push(`  诊断：**连不上**（${info.code || 'timeout'}）`)
        lines.push(direct
 // ⚠️ 实测：`proxy:'direct'` 在 huggingface.co / GitHub 这类站点上**基本必然超时**。
            ? '  出路（按概率排序）：① **改传 `proxy:"auto"`（或直接省略 proxy）** —— auto 是“有代理就走代理、没装代理就是直连”，两种环境都安全；② 若你**装了代理软件但它没设「系统代理」**（代理只在本地端口监听），`auto` 探测不到它 ⇒ **显式传地址**（如 `proxy:"http://127.0.0.1:7890"`，端口按你的实际改），或在代理软件里打开「系统代理」开关；③ 若你**确知**该地址可直连（LAN/本机等你已确认能直连的地址），`direct` 本就没错，那就查 DNS/网络本身；④ `probe` 会回显“代理 …（来源 …）”，可用来确认到底走没走代理'
            : `  出路：代理已启用（${proxyKind}）但仍连不上 ⇒ 检查节点是否可用，或换端口/节点`)
    }
    else if (info.kind === 'tls') {
        lines.push(`  诊断：**TLS/连接被重置**（${info.code || 'reset'}）—— 典型的链路干扰特征`)
        lines.push(direct ? '  出路：若你有可用代理，显式传 `proxy:"<你的代理>"` 试试；或改用加密 DNS' : '  出路：代理侧被重置 ⇒ 换节点再试')
    }
    else if (info.kind === 'proxy') {
        lines.push('  诊断：**代理本身拒绝/不可用**')
        lines.push('  出路：若你在用代理软件，确认它运行、端口对不对（`probe` 会显示 auto 探测到的代理与来源）；也可用 `proxy:"direct"` 直连对照')
    }
    // 兜底：分类不出来时也必须给“下一步”（以前这里什么都不给 ⇒ 只有一句超时，用户/模型只能猜 ✗）
    else {
        lines.push(`  诊断：**请求未完成**（${info.code || 'unknown'}）—— 未归类到 DNS/连接/TLS`)
        lines.push(direct
            ? '  出路：① 反而**别**急着改直连 —— `proxy` 省略（auto）最安全：有代理就走代理、没代理就是直连；② 若你装了代理软件但它**没设「系统代理」**，auto 探测不到 ⇒ 显式传地址（如 `proxy:"http://127.0.0.1:7890"`）；③ **确知可直连**的地址（LAN/本机等你已确认能直连的地址）再用 `direct`'
            : `  出路：代理已启用（${proxyKind}）⇒ 换节点/端口重试，或用 \`proxy:"direct"\` 对照测试`)
    }
    return lines
}

/** 代理是否可用（TCP 能连上）；`probe:true` 时用来提前给出"代理没开"的明确错误。 */
export function pingProxy(proxy, timeoutMs = 1200) {
    if (proxy.kind === 'none') return Promise.resolve(true)
    return new Promise((resolve) => {
        const sock = netConnect({ host: proxy.host, port: proxy.port })
        const done = (ok) => { try { sock.destroy() } catch { /* ignore */ } ; resolve(ok) }
        sock.setTimeout(timeoutMs, () => done(false))
        sock.once('connect', () => done(true))
        sock.once('error', () => done(false))
    })
}

/** SOCKS5 握手（无认证 + 用户名/密码），返回已连到目标的裸 socket */
export function socks5Connect(proxy, targetHost, targetPort, timeoutMs = 15000, signal = null) {
    return new Promise((resolve, reject) => {
        // 远程解析（socks5h）时把域名交给代理解析；否则本地解析成 IP 再发
        const sendHost = proxy.remoteDns ? null : targetHost
        const socket = netConnect({ host: proxy.host, port: proxy.port })
        const fail = (error) => { try { socket.destroy() } catch { /* ignore */ } ; reject(error instanceof Error ? error : new Error(String(error))) }
        const onAbort = () => fail(new Error('aborted'))
        if (signal) {
            if (signal.aborted) return fail(new Error('aborted'))
            signal.addEventListener('abort', onAbort, { once: true })
        }
        socket.setTimeout(timeoutMs, () => fail(new Error(`SOCKS5 连接 ${proxy.host}:${proxy.port} 超时`)))
        socket.once('error', fail)
        let stage = 'greeting'
        let buf = Buffer.alloc(0)
        const lookupAndSend = () => {
            // 本地解析域名（仅 socks5://，非 socks5h）
            import('node:dns').then(({ lookup }) => {
                lookup(sendHost, { all: false }, (error, address, family) => {
                    if (error) return fail(error)
                    sendConnectRequest(address, family === 6 ? 4 : 1)
                })
            }).catch(fail)
        }
        const sendConnectRequest = (address, atyp) => {
            stage = 'connect'
            const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(targetPort)
            const hostBuf = atyp === 1
                ? Buffer.from(address.split('.').map(Number))
                : atyp === 4
                    ? ipv6ToBuffer(address)
                    : Buffer.concat([Buffer.from([address.length]), Buffer.from(address, 'utf8')])
            socket.write(Buffer.concat([Buffer.from([5, 1, 0, atyp]), hostBuf, portBuf]))
            buf = Buffer.alloc(0)
        }
        socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk])
            if (stage === 'greeting') {
                if (buf.length < 2) return
                if (buf[0] !== 5) return fail(new Error('SOCKS5 协议不匹配'))
                if (buf[1] === 0xFF) return fail(new Error('SOCKS5 代理拒绝所有认证方式'))
                if (buf[1] === 2) {
                    // RFC1929 用户名/密码
                    if (!proxy.auth) return fail(new Error('SOCKS5 代理要求账号密码（在 proxy 里写成 socks5://user:pass@host:port）'))
                    stage = 'auth'
                    buf = Buffer.alloc(0)
                    const u = Buffer.from(proxy.auth.user, 'utf8')
                    const p = Buffer.from(proxy.auth.pass, 'utf8')
                    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]))
                    return
                }
                stage = 'greeting-done'
                buf = Buffer.alloc(0)
                if (proxy.remoteDns) sendConnectRequest(targetHost, 3)
                else lookupAndSend()
                return
            }
            if (stage === 'auth') {
                if (buf.length < 2) return
                if (buf[1] !== 0) return fail(new Error('SOCKS5 账号密码被拒'))
                stage = 'greeting-done'
                buf = Buffer.alloc(0)
                if (proxy.remoteDns) sendConnectRequest(targetHost, 3)
                else lookupAndSend()
                return
            }
            if (stage === 'connect') {
                if (buf.length < 5) return
                if (buf[1] !== 0) {
                    const why = { 1: '通用失败', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒', 6: 'TTL 超时', 7: '命令不支持', 8: '地址类型不支持' }[buf[1]] ?? `code ${buf[1]}`
                    return fail(new Error(`SOCKS5 CONNECT 失败：${why}`))
                }
                const atyp = buf[3]
                const need = atyp === 1 ? 4 + 4 + 2 : atyp === 4 ? 4 + 16 + 2 : 4 + 1 + buf[4] + 2
                if (buf.length < need) return
                const rest = buf.subarray(need)
                socket.removeAllListeners('data')
                socket.setTimeout(0)
                if (signal) signal.removeEventListener('abort', onAbort)
                if (rest.length > 0) socket.unshift(rest)
                resolve(socket)
            }
        })
        // 问候：无认证 + 用户名密码（若提供）
        socket.once('connect', () => socket.write(proxy.auth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0])))
    })
}

function ipv6ToBuffer(address) {
    const parts = address.split('::')
    const head = parts[0] ? parts[0].split(':') : []
    const tail = parts[1] ? parts[1].split(':') : []
    const full = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    const buf = Buffer.alloc(16)
    full.forEach((h, i) => buf.writeUInt16BE(parseInt(h || '0', 16), i * 2))
    return buf
}

/** 已经挂过 connect 监听的 socket（keep-alive 会复用同一 socket ⇒ 不能每个请求都往它身上加监听） */
const timingHooked = new WeakSet()

/**
 * 发一次请求（**不跟随重定向**）。返回 `{ status, headers, stream, timings }`。
 * `proxy` 为 `resolveProxy()` 的返回值；`range` 形如 `{ start, end }`（含端点）或字符串。
 */
export function requestOnce(opts) {
    const { url, method = 'GET', headers = {}, proxy = { kind: 'none' }, range = null, timeoutMs = 30000, signal = null } = opts
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const port = u.port ? Number(u.port) : (isHttps ? 443 : 80)
    const finalHeaders = {
        'User-Agent': DEFAULT_UA,
        Accept: '*/*',
        ...headers,
        ...(range === null ? {} : { Range: typeof range === 'string' ? range : `bytes=${range.start}-${range.end}` }),
    }
    const timings = { started: Date.now() }
    return new Promise((resolve, reject) => {
        const fail = (error) => reject(error instanceof Error ? error : new Error(String(error)))
        const onAbort = () => fail(new Error('aborted'))
        if (signal) {
            if (signal.aborted) return fail(new Error('aborted'))
            signal.addEventListener('abort', onAbort, { once: true })
        }
        const finish = (res) => {
            const stream = res
            const origEmit = stream.emit.bind(stream)
            stream.emit = (event, ...rest) => {
                if (event === 'response') timings.firstByte = Date.now() - timings.started
                return origEmit(event, ...rest)
            }
            resolve({ status: res.statusCode, headers: res.headers, stream: res, timings })
        }
        const common = {
            method,
            headers: finalHeaders,
            signal: signal ?? undefined,
            ...(isHttps ? { servername: u.hostname } : {}),
        }

        if (proxy.kind === 'none') {
            const fn = isHttps ? httpsRequest : httpRequest
            const req = fn({ ...common, hostname: u.hostname, port, path: `${u.pathname}${u.search}` }, finish)
            req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs} ms 内没有完成）`)))
            req.on('error', fail)
            req.on('socket', (s) => {
                // 只在"这次是新连接"且没挂过时挂一次（否则 keep-alive 复用 socket 会累积监听 ⇒
 // MaxListenersExceededWarning，夹具实测）
                if (s.connecting !== true || timingHooked.has(s)) return
                timingHooked.add(s)
                s.once('connect', () => { timings.tcp = Date.now() - timings.started })
            })
            req.end()
            return
        }

        if (proxy.kind === 'http' && !isHttps) {
            // http 目标走 HTTP 代理：绝对形式请求 + Proxy-Authorization
            const authHeader = proxy.auth
                ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64')}` }
                : {}
            const req = httpRequest({
                ...common,
                headers: { ...finalHeaders, ...authHeader, Host: u.host },
                hostname: proxy.host,
                port: proxy.port,
                path: u.href,
            }, finish)
            req.setTimeout(timeoutMs, () => req.destroy(new Error('代理请求超时')))
            req.on('error', fail)
            req.end()
            return
        }

        // https 目标 / SOCKS5：先建到目标的**裸 socket**（HTTP 代理走 CONNECT），再在其上跑 TLS 或明文
        const establish = proxy.kind === 'socks5'
            ? socks5Connect(proxy, u.hostname, port, timeoutMs, signal)
            : httpConnectTunnel(proxy, u.hostname, port, timeoutMs, signal, finalHeaders['User-Agent'])
        establish.then((socket) => {
            if (signal) signal.removeEventListener('abort', onAbort)
            if (!isHttps) {
                const req = httpRequest({ ...common, createConnection: () => socket, hostname: u.hostname, port, path: `${u.pathname}${u.search}` }, finish)
                req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
                req.on('error', fail)
                req.end()
                return
            }
            const tls = tlsConnect({ socket, servername: u.hostname, ALPNProtocols: ['http/1.1'] })
            tls.once('secureConnect', () => { timings.tls = Date.now() - timings.started })
            tls.once('error', fail)
            const req = httpsRequest({ ...common, createConnection: () => tls, hostname: u.hostname, port, path: `${u.pathname}${u.search}` }, finish)
            req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')))
            req.on('error', fail)
            req.end()
        }).catch(fail)
    })
}

/** HTTP 代理的 CONNECT 隧道（返回已连到目标的 socket） */
export function httpConnectTunnel(proxy, targetHost, targetPort, timeoutMs, signal, ua = DEFAULT_UA) {
    return new Promise((resolve, reject) => {
        const target = `${targetHost}:${targetPort}`
        const authHeader = proxy.auth
            ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64')}` }
            : {}
        const req = httpRequest({
            method: 'CONNECT',
            hostname: proxy.host,
            port: proxy.port,
            path: target,
            headers: { Host: target, 'User-Agent': ua, ...authHeader },
        })
        const fail = (error) => { try { req.destroy() } catch { /* ignore */ } ; reject(error instanceof Error ? error : new Error(String(error))) }
        req.setTimeout(timeoutMs, () => fail(new Error(`CONNECT ${target} 超时`)))
        req.once('error', fail)
        req.once('connect', (res, socket) => {
            if (res.statusCode !== 200) return fail(new Error(`代理拒绝 CONNECT ${target}：HTTP ${res.statusCode}${res.statusCode === 407 ? '（代理要认证）' : ''}`))
            if (signal) signal.removeEventListener('abort', () => fail(new Error('aborted')))
            resolve(socket)
        })
        req.end()
    })
}

/**
 * 跟随重定向的一次请求（默认 6 跳；`skipRedirects` 时不跟随）。
 * 注意：跨主机重定向**不带**自定义 Range（避免把上一段的 Range 用到别的资源上）。
 */
export async function fetchFollowing(opts) {
    const { url, headers = {}, proxyOption = 'auto', range = null, timeoutMs = 30000, signal = null, maxRedirects = MAX_REDIRECTS, method = 'GET' } = opts
    let cur = url
    const chain = []
    let currentHeaders = headers
    let strippedNote = null
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const proxy = await resolveProxyAsync(proxyOption, new URL(cur).hostname)
        const res = await requestOnce({ url: cur, method, headers: currentHeaders, proxy, range, timeoutMs, signal })
        if (REDIRECT_CODES.has(res.status) && res.headers.location) {
            chain.push({ from: cur, status: res.status })
            res.stream.resume() // 丢弃重定向响应体
            const next = new URL(res.headers.location, cur).href
            // 302/303 对 GET 保持 GET。
 // ⚠️ **跨站重定向要剥离敏感头**（审计发现）：以前"跨主机保持自定义头"，
            // 于是 `github.com → 任意第三方` 时会把用户的 `Cookie`/`Authorization` 一起送出去（凭证泄漏）。
            // 同站（同主机或互为子域，如 github.com ↔ objects.githubusercontent.com 之外的同 registrable 域）
            // 才保留 —— 很多站点确实靠 Referer/Cookie 才肯给下。
            if (!sameSite(new URL(cur).hostname, new URL(next).hostname)) {
                const kept = {}
                const dropped = []
                for (const [k, v] of Object.entries(currentHeaders ?? {})) {
                    if (SENSITIVE_HEADERS.has(k.toLowerCase())) { dropped.push(k); continue }
                    kept[k] = v
                }
                if (dropped.length > 0) {
                    currentHeaders = kept
                    strippedNote = `跨站重定向（${new URL(cur).hostname} → ${new URL(next).hostname}）⇒ 已剥离敏感头：${dropped.join(', ')}`
                }
            }
            cur = next
            continue
        }
        return { ...res, finalUrl: cur, proxy, redirects: chain, strippedNote }
    }
    throw new Error(`重定向超过 ${maxRedirects} 跳：${chain.map((c) => `${c.status}→`).join('')}${cur}`)
}

/** 敏感请求头：跨站重定向时不能带过去 */
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization'])

/**
 * **回显 URL 前先抹掉账号密码**（审计）：用户可能写 `socks5h://user:pass@host:port`，
 * 一旦解析失败/进诊断信息，原文会把密码带进会话记录 ⇒ 一律 `socks5h://***@host:port`。
 */
export function maskCredentials(text) {
    return String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1***@')
}

/** 同站判定：同一主机，或互为子域（`a.example.com` ↔ `example.com`）—— 只看后缀，够用且保守 */
function sameSite(a, b) {
    const x = String(a).toLowerCase().replace(/\.$/, '')
    const y = String(b).toLowerCase().replace(/\.$/, '')
    if (x === y) return true
    return x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

export { DEFAULT_UA }

/**
 * bash 的 HTTP 路由 —— 给设置页提供"有没有装 / 装一下"。
 *
 * 为什么走 HTTP：DSH 的浏览器半只有 `slots` / `configForms` / `locale` 这几个服务，**没有**
 * host↔client 的通用 RPC；第三方市场（dshmarket）也是用宿主 `webServer` 注册 `/dsh-market/*`
 * 路由、客户端 `fetch()` 调用。我们照这个已证实的路子做（0.2.2 内核里 `webServer` 与
 * `kind:'exact'` 路由都存在）。
 *
 * 安全：
 *  - 只注册**精确路径**，不碰宿主的 `/api` 前缀；
 *  - `install` 只接受 **POST**，且要求同源（浏览器跨站请求带 Origin，host 对不上就 403）；
 *  - 状态与安装结果都返回 JSON，`cache-control: no-store`（不要缓存"没装"）。
 */
import { bashStatus, startInstall, startRuntimeInstall } from './install.js'

export const STATUS_PATH = '/dsh-toolkit/bash/status'
export const INSTALL_PATH = '/dsh-toolkit/bash/install'
export const RUNTIME_INSTALL_PATH = '/dsh-toolkit/bash/runtime/install'
export const RUNTIME_STATUS_PATH = '/dsh-toolkit/bash/runtime/status'

function sendJson(response, status, payload) {
    try {
        response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(payload))
    }
    catch { /* 响应流已关闭 */ }
}

function sameOrigin(request) {
    const origin = request?.headers?.origin
    if (typeof origin !== 'string' || origin === '') return true // 同源 fetch 常常不带 Origin
    try {
        return new URL(origin).host === request.headers.host
    }
    catch {
        return false
    }
}

/** 读一个极小的 JSON body（安装请求只有一个 `source` 字段）。 */
function readJsonBody(request, limit = 4096) {
    return new Promise((resolve) => {
        const chunks = []
        let size = 0
        let done = false
        const settle = (value) => { if (!done) { done = true; resolve(value) } }
        try {
            request.on('data', (chunk) => {
                size += chunk.length
                if (size > limit) { settle(null); try { request.destroy?.() } catch { /* 已断开 */ } return }
                chunks.push(chunk)
            })
            request.on('end', () => {
                if (chunks.length === 0) return settle({})
                try {
                    settle(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                }
                catch {
                    settle(null)
                }
            })
            request.on('error', () => settle(null))
        }
        catch {
            settle(null)
        }
    })
}

/**
 * 挂路由。任何一步失败都只损失这两个路由（设置页退化成"没有安装按钮"），绝不影响工具注册。
 * @param {object} ctx cordis 上下文
 * @param {(line: string) => void} [beacon]
 */
export function mountBashRoutes(ctx, beacon = () => {}) {
    try {
        ctx.inject(['webServer'], (webCtx) => {
            let server
            try {
                server = webCtx.get('webServer')
            }
            catch {
                server = undefined
            }
            if (server === null || typeof server !== 'object' || typeof server.register !== 'function') {
                beacon('bash routes: webServer unavailable (install button disabled)')
                return
            }
            const routes = [
                {
                    kind: 'exact',
                    path: STATUS_PATH,
                    handler: (request, response) => {
                        if (request.method !== 'GET') return sendJson(response, 405, { error: 'GET only' })
                        sendJson(response, 200, bashStatus())
                    },
                },
                {
                    kind: 'exact',
                    path: INSTALL_PATH,
                    handler: async (request, response) => {
                        if (request.method !== 'POST') return sendJson(response, 405, { error: 'POST only' })
                        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin refused' })
                        const body = await readJsonBody(request)
                        if (body === null) return sendJson(response, 400, { started: false, error: 'body 不是合法 JSON（只接受 {"source":"mirror"|"github"}）' })
                        const source = typeof body?.source === 'string' && body.source !== '' ? body.source : 'mirror'
                        try {
                            const result = startInstall(source)
                            sendJson(response, result.started === true ? 202 : 200, result)
                        }
                        catch (error) {
                            sendJson(response, 500, { started: false, error: error instanceof Error ? error.message : String(error) })
                        }
                    },
                },
                {
                    kind: 'exact',
                    path: RUNTIME_STATUS_PATH,
                    handler: (request, response) => {
                        if (request.method !== 'GET') return sendJson(response, 405, { error: 'GET only' })
                        sendJson(response, 200, bashStatus().runtime)
                    },
                },
                {
                    kind: 'exact',
                    path: RUNTIME_INSTALL_PATH,
                    handler: async (request, response) => {
                        if (request.method !== 'POST') return sendJson(response, 405, { error: 'POST only' })
                        if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin refused' })
                        try {
                            const result = startRuntimeInstall()
                            sendJson(response, result.started === true ? 202 : 200, result)
                        }
                        catch (error) {
                            sendJson(response, 500, { started: false, error: error instanceof Error ? error.message : String(error) })
                        }
                    },
                },
            ]
            try {
                webCtx.effect(() => {
                    const disposers = routes.map((route) => {
                        try {
                            const dispose = server.register(route)
                            return typeof dispose === 'function' ? dispose : null
                        }
                        catch (error) {
                            beacon(`bash route ${route.path} FAILED: ${error instanceof Error ? error.message : String(error)}`)
                            return null
                        }
                    })
                    return () => {
                        for (const dispose of disposers) {
                            try { dispose?.() } catch { /* 释放失败不影响其它路由 */ }
                        }
                    }
                }, 'dsh-toolkit: bash routes')
                beacon('bash routes registered (/dsh-toolkit/bash/{status,install,runtime/status,runtime/install})')
            }
            catch (error) {
                beacon(`bash routes effect FAILED: ${error instanceof Error ? error.message : String(error)}`)
            }
        })
    }
    catch (error) {
        beacon(`bash routes inject FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
}

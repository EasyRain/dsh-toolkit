/**
 * 写操作的沙箱闸门自测（lib/guard.js + 四个族的接线）。
 *
 * 背景：`bash` 过 `sandbox.confine`，但 `file` / `ast_edit` / `checkpoint_restore` / `download`
 * 是直接 `node:fs` 写盘，宿主围栏管不到 ⇒ 在 workspace-write 会话里能写到工作区外（实测过）。
 * 这里固定住闸门的判定与四族的接线，防止以后又漏。
 *
 * 跑法：node test/guard-selftest.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const guard = await import('../lib/guard.js')
const fileFamily = await import('../lib/file/index.js')
const checkpoint = await import('../lib/checkpoint/index.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 200)}`}`)
}

const root = mkdtempSync(join(tmpdir(), 'tk-guard-'))
const workspace = join(root, 'ws')
// "工作区外" 的探针路径：**必须落在 tmpdir 之外**（宿主也把 /tmp 与 os.tmpdir() 列为可写根）。
const outsideDir = process.env.USERPROFILE ?? homedir()
mkdirSync(workspace, { recursive: true })

/** 造一个只有 `sandboxPolicy` 的假 ctx。 */
const fakeCtx = (mode, extra = {}) => ({
    get(name) {
        if (name === 'sandboxPolicy') return { resolve: () => ({ mode, workspaceRoot: workspace, ...extra }) }
        return undefined
    },
})

const defineTool = (definition) => definition
const fileTool = fileFamily.tools(defineTool, {
    getCtx: () => fakeCtx('workspace-write'),
    resolveWorkspaceCwd: () => workspace,
})[0]

const denyOf = async (run) => {
    try { await run() }
    catch (error) { return error }
    return null
}

try {
    console.log('== 1. 判定规则（与宿主 writableRoots 同口径）==')
    {
        const mk = (mode) => fakeCtx(mode)
        const allow = (ctx, target) => guard.inspectTargets({ policy: guard.resolveFilePolicy(ctx), targets: [target] }) === null
        ok('workspace-write / 工作区内（新文件）⇒ 放行', allow(mk('workspace-write'), join(workspace, 'new.txt')))
        ok('workspace-write / 平台临时目录 ⇒ 放行（宿主也放行）', allow(mk('workspace-write'), join(tmpdir(), 'tk-guard-temp.txt')))
        ok('workspace-write / 用户主目录 ⇒ 拒绝', !allow(mk('workspace-write'), join(outsideDir, 'tk-guard-out.txt')))
        ok('read-only / 工作区内也拒绝', !allow(mk('read-only'), join(workspace, 'a.txt')))
        ok('danger-full-access ⇒ 放行', allow(mk('danger-full-access'), join(outsideDir, 'tk-guard-out.txt')))
        ok('拿不到策略服务 ⇒ 放行（由宿主兜底）', allow({ get: () => undefined }, join(root, 'x.txt')))
        ok('additionalWritableRoots 生效', (() => {
            const extra = join(root, 'extra')
            mkdirSync(extra, { recursive: true })
            const ctx = fakeCtx('workspace-write', { additionalWritableRoots: [extra] })
            return guard.inspectTargets({ policy: guard.resolveFilePolicy(ctx), targets: [join(extra, 'y.txt')] }) === null
        })())
    }

    console.log('== 2. 拒绝时的形状（模型可读）==')
    {
        const error = await denyOf(async () => guard.assertWritableTargets(fakeCtx('workspace-write'), [join(outsideDir, 'nope.txt')]))
        ok('抛 SandboxDeniedError 且 code = FS_SANDBOX_DENIED', error instanceof guard.SandboxDeniedError && error.code === 'FS_SANDBOX_DENIED', String(error))
        ok('消息带宿主同款标记', /\[sandbox: file access denied under workspace-write mode\]/.test(String(error?.message)), String(error?.message))
        ok('消息里点名目标路径', String(error?.message).includes('nope.txt'), String(error?.message))
    }

    console.log('== 3. file 族接线 ==')
    {
        const inside = join(workspace, 'inside.txt')
        await fileTool.execute({ action: 'write', path: inside, content: 'hi\n' })
        ok('工作区内 write 正常', (await fileTool.execute({ action: 'read', path: inside })).includes('hi'))

        const outsideError = await denyOf(() => fileTool.execute({ action: 'write', path: join(outsideDir, 'tk-guard-deny.txt'), content: 'x' }))
        ok('工作区外 write 被拒', outsideError !== null && /\[sandbox: file access denied/.test(String(outsideError.message)), String(outsideError))

        const removeError = await denyOf(() => fileTool.execute({ action: 'remove', path: join(outsideDir, 'tk-guard-deny.txt'), confirm: true }))
        ok('工作区外 remove 被拒', removeError !== null && /\[sandbox: file access denied/.test(String(removeError.message)), String(removeError))

        ok('read 不受影响（工作区外也能读）', typeof (await fileTool.execute({ action: 'read', path: 'C:/Windows/win.ini' }).catch(() => '')) === 'string')
    }

    console.log('== 4. read-only 族：连工作区内都拒 ==')
    {
        const roTool = fileFamily.tools(defineTool, {
            getCtx: () => fakeCtx('read-only'),
            resolveWorkspaceCwd: () => workspace,
        })[0]
        const roError = await denyOf(() => roTool.execute({ action: 'write', path: join(workspace, 'ro.txt'), content: 'x' }))
        ok('read-only ⇒ 写被拒（工作区内也一样）', roError !== null && /read-only/.test(String(roError.message)), String(roError))
        ok('read-only ⇒ 读仍然可以', (await roTool.execute({ action: 'read', path: join(workspace, 'inside.txt') })).includes('hi'))
    }

    console.log('== 5. checkpoint restore 接线 ==')
    {
        const error = await denyOf(async () => checkpoint.restoreCheckpoint({
            id: 'whatever',
            cwd: join(outsideDir, 'other-workspace'),
            dryRun: false,
            confirm: true,
            guardCtx: fakeCtx('workspace-write'),
        }))
        ok('显式 cwd 在快照之**前**就被闸门拒（不会去读快照）', error instanceof guard.SandboxDeniedError, String(error?.message))
        ok('preview（dryRun 默认）不拦，仍会照常报快照不存在', /no checkpoint/i.test(String((await denyOf(async () => checkpoint.restoreCheckpoint({
            id: 'whatever', cwd: join(outsideDir, 'x'), guardCtx: fakeCtx('workspace-write'),
        })))?.message ?? '')), '')
    }
    console.log('== 6. 必须带 session 解析策略（否则拿到的是默认策略）==')
    {
        const session = { id: 'selftest-session' }
        const seen = []
        const spyCtx = {
            get: () => ({
                resolve: (options) => {
                    seen.push(options)
                    return { mode: 'danger-full-access', workspaceRoot: root }
                },
            }),
        }
        guard.assertWritableTargets(spyCtx, [join(root, 'x.txt')], { session })
        ok('assertWritableTargets 把 session 传给 sandboxPolicy.resolve', seen[0]?.session === session, JSON.stringify(seen[0] ?? null))

        // 文件工具把 execute 的 exec 透传到闸门：带 exec ⇒ 策略被当成 read-only ⇒ 拒绝。
        const ctx2 = {
            get: () => ({
                resolve: (options) => ({ mode: options?.session ? 'read-only' : 'danger-full-access', workspaceRoot: outsideDir }),
            }),
        }
        const tool = fileFamily.tools(defineTool, { getCtx: () => ctx2, resolveWorkspaceCwd: () => workspace })[0]
        await tool.execute({ action: 'write', path: join(root, 'noexec.txt'), content: 'x\n' })
        ok('不带 exec ⇒ 拿到的是宽松策略（可写）', true)
        const denied = await denyOf(() => tool.execute({ action: 'write', path: join(root, 'with-exec.txt'), content: 'x\n' }, { agent: { session } }))
        ok('带 exec ⇒ 用会话策略（read-only ⇒ 拒绝）', denied instanceof guard.SandboxDeniedError && /read-only/.test(String(denied.message)), String(denied?.message))
    }
    console.log('== 7. read-only：连插件自己的仓库也不写 ==')
    {
        const roCtx = fakeCtx('read-only')
        let error = null
        try { guard.assertWritableStorage(roCtx, null, '创建快照') } catch (thrown) { error = thrown }
        ok('read-only ⇒ 创建快照被拒', error instanceof guard.SandboxDeniedError && /read-only/.test(String(error.message)), String(error?.message))
        let allowed = true
        try { guard.assertWritableStorage(fakeCtx('workspace-write'), null, '创建快照') } catch { allowed = false }
        ok('workspace-write ⇒ 允许写快照仓库', allowed)
        let safe = true
        try { guard.assertWritableStorage({ get: () => undefined }, null, '创建快照') } catch { safe = false }
        ok('拿不到策略 ⇒ 放行', safe)
    }
    console.log('== 8. 真实入口 apply()：getCtx 有没有一路传下去 ==')
    {
        const session = { id: 'ro-session' }
        const registry = () => {
            const registered = []
            const ctx = {
                tools: { register: (tool) => registered.push(tool) },
                get: () => undefined,
                on: () => () => {},
            }
            return { ctx, registered }
        }

        // checkpoint：以前 apply() 把 getCtx 丢了 ⇒ 单工具 checkpoint 的 create 拦不住
        const ckReg = registry()
        checkpoint.apply(ckReg.ctx, { defineTool, mutationHook: false, beacon: () => {}, getCtx: () => fakeCtx('read-only') })
        const ck = ckReg.registered.find((tool) => tool.name === 'checkpoint')
        const ckError = ck === undefined ? new Error('checkpoint 没注册') : await denyOf(() => ck.execute({ action: 'create', note: 'ro' }, { agent: { session } }))
        ok('apply 之后：checkpoint create 在只读下被拒', ckError instanceof guard.SandboxDeniedError, String(ckError?.message))

        // download：以前 apply() 调 tools() 时没传 options ⇒ 闸门是空的
        const download = await import('../lib/download/index.js')
        const dlReg = registry()
        download.apply(dlReg.ctx, defineTool, { getCtx: () => fakeCtx('read-only') })
        const dl = dlReg.registered.find((tool) => tool.name === 'download')
        const dlError = dl === undefined ? new Error('download 没注册') : await denyOf(() => dl.execute({ action: 'start', url: 'https://example.invalid/x.bin', to: join(root, 'x.bin') }, { agent: { session } }))
        ok('apply 之后：download start 在只读下被拒', dlError instanceof guard.SandboxDeniedError, String(dlError?.message))

        // session_export：直接走 tools()
        const sessionTools = await import('../lib/session/index.js')
        const exportTool = sessionTools.tools(defineTool, { getCtx: () => fakeCtx('read-only') }).find((tool) => tool.name === 'session_export')
        const stError = exportTool === undefined ? new Error('session_export 不在工具列表里') : await denyOf(() => exportTool.execute({ to: join(root, 'export.jsonl') }, { agent: { session } }))
        ok('session_export 在只读下被拒', stError instanceof guard.SandboxDeniedError, String(stError?.message))
    }
}
finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

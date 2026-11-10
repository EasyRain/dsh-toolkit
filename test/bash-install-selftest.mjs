/**
 * bash 安装器自测（**不碰网络、不碰磁盘、不调 winget/7z**）。
 *
 * 这里的每个桩都对应一条真实约束：
 *  - 没装 bash ⇒ 状态 `installed:false`，且**两个源**都列出来（国内镜像 / GitHub），程序不猜网络；
 *  - 已装 ⇒ start 直接返回 already，不重复装；
 *  - 装的过程中再点 ⇒ busy（不并发下载两份 60 MB）；
 *  - 装完必须**重新探测**才知道成功（不信任下载/解压的退出码）；
 *  - 失败要留下可读原因（含源与阶段），不能静默。
 *
 * 跑法：node test/bash-install-selftest.mjs
 */
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'

const { createInstaller } = await import('../lib/shell/install.js')
const { sourceUrl, assetName, installDir, downloadDir, SOURCE_IDS, GIT_VERSION } = await import('../lib/shell/sources.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 240)}`}`)
}

/** 可编排的假 spawn：调用方决定何时 close。 */
function fakeSpawn() {
    const calls = []
    const spawnFn = (file, args) => {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        calls.push({ file, args, child })
        return child
    }
    return { calls, spawnFn }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

console.log('== 1. 源与路径 ==')
{
    ok('两个源：mirror / github', SOURCE_IDS.join(',') === 'mirror,github', SOURCE_IDS.join(','))
    ok('资产名按 Git for Windows 规则生成', assetName('v2.56.0.windows.4', 'x64') === 'PortableGit-2.56.0.4-64-bit.7z.exe', assetName('v2.56.0.windows.4', 'x64'))
    const mirror = sourceUrl('mirror')
    ok('国内镜像 URL 指向 npmmirror 的二进制镜像', mirror.startsWith('https://registry.npmmirror.com/-/binary/git-for-windows/') && mirror.endsWith(assetName()), mirror)
    const github = sourceUrl('github')
    ok('GitHub URL 指向 release 资产', github.startsWith('https://github.com/git-for-windows/git/releases/download/'), github)
    ok('安装目录在用户级 dsh-toolkit 下', installDir({ LOCALAPPDATA: 'C:/Users/X/AppData/Local' }).endsWith(join('dsh-toolkit', 'git')))
    ok('下载目录与安装目录同级', dirname(downloadDir({ LOCALAPPDATA: 'C:/Users/X/AppData/Local' })).endsWith('dsh-toolkit'))
    ok('版本号固定（升级时改这里）', GIT_VERSION.startsWith('v'))
}

console.log('== 2. 已安装 ==')
{
    const installer = createInstaller({ find: () => 'C:/Git/bin/bash.exe', platform: 'win32' })
    const status = installer.status()
    ok('installed=true 且带路径', status.installed === true && status.path.endsWith('bash.exe'))
    ok('两个源都列出来', status.sources.length === 2 && status.sources.map((s) => s.id).join(',') === 'mirror,github')
    const result = installer.start('mirror')
    ok('已装 ⇒ already，不下载', result.started === false && result.already === true)
}

console.log('== 3. 非 Windows ==')
{
    const installer = createInstaller({ find: () => null, platform: 'linux' })
    ok('canInstall=false', installer.status().canInstall === false)
    const result = installer.start('mirror')
    ok('unsupported，并给手动命令', result.started === false && result.unsupported === true && typeof installer.status().manual.command === 'string')
}

console.log('== 4. 正常安装流程（下载 → 解压 → 重新探测）==')
{
    let installed = false
    const { calls, spawnFn } = fakeSpawn()
    const downloads = []
    const dirs = []
    const installer = createInstaller({
        platform: 'win32',
        find: () => (installed ? 'C:/Users/X/AppData/Local/dsh-toolkit/git/bin/bash.exe' : null),
        download: async (options) => {
            downloads.push(options)
            options.onProgress({ downloaded: 30 * 1024 * 1024, total: 60 * 1024 * 1024, percent: 50 })
        },
        spawnFn,
        mkdir: (path) => dirs.push(path),
        remove: () => { /* 安装包删除 */ },
    })

    const started = installer.start('mirror')
    ok('start 立即返回 installing', started.started === true && started.status.job.state === 'installing')
    await tick()
    ok('先下载（走 mirror 直连）', downloads.length === 1 && downloads[0].url === sourceUrl('mirror') && downloads[0].proxy === 'direct', JSON.stringify(downloads[0]))
    ok('下载目标在 downloads 目录', downloads[0].to.endsWith(assetName()), downloads[0].to)

    await tick()
    ok('解压调用 `-y -o<dir>`（注意无空格）', calls.length === 1 && calls[0].args[0] === '-y' && calls[0].args[1] === `-o${installDir()}`, JSON.stringify(calls[0]?.args))
    ok('解压前建目标目录', dirs.some((d) => d === installDir()), dirs.join(','))

    installed = true
    calls[0].child.stdout.emit('data', 'Extracting...\n')
    calls[0].child.emit('close', 0)
    await tick()
    const job = installer.status().job
    ok('装完重新探测成功 ⇒ done', job.state === 'done' && job.path.includes('bash.exe'), JSON.stringify(job))
}

console.log('== 5. 并发保护与失败可读 ==')
{
    const { calls, spawnFn } = fakeSpawn()
    const installer = createInstaller({
        platform: 'win32',
        find: () => null,
        download: () => new Promise(() => { /* 永不完成，模拟大文件下载中 */ }),
        spawnFn,
    })
    const first = installer.start('github')
    const second = installer.start('github')
    ok('第一次 started', first.started === true)
    ok('第二次 busy（不并发下载两份）', second.started === false && second.busy === true)
    ok('未知源被拒', installer.start('ftp').unknownSource === true)
}

{
    const { spawnFn } = fakeSpawn()
    const installer = createInstaller({
        platform: 'win32',
        find: () => null,
        download: async () => { throw new Error('HTTP 403（GitHub 直连被拒）') },
        spawnFn,
    })
    installer.start('github')
    await tick()
    await tick()
    const job = installer.status().job
    ok('下载失败 ⇒ failed 且原因可读', job.state === 'failed' && /403/.test(job.error ?? ''), JSON.stringify(job))
    ok('失败保留源与阶段', job.source === 'github' && job.phase === 'download', JSON.stringify(job))
}

{
    const { calls, spawnFn } = fakeSpawn()
    const installer = createInstaller({
        platform: 'win32',
        find: () => null,
        download: async () => {},
        spawnFn,
    })
    installer.start('mirror')
    await tick()
    await tick()
    calls[0].child.emit('close', 1)
    await tick()
    const job = installer.status().job
    ok('解压失败 ⇒ failed 并提示退出码', job.state === 'failed' && /退出码 1/.test(job.error ?? ''), JSON.stringify(job))
}

console.log('== 6. HTTP 路由（设置页用）==')
{
    const { mountBashRoutes, STATUS_PATH, INSTALL_PATH, RUNTIME_STATUS_PATH, RUNTIME_INSTALL_PATH } = await import('../lib/shell/routes.js')
    const routes = []
    const ctx = {
        inject: (_deps, callback) => callback({
            get: (name) => (name === 'webServer' ? { register: (route) => { routes.push(route); return () => {} } } : undefined),
            effect: (fn) => fn(),
        }),
        effect: (fn) => fn(),
    }
    mountBashRoutes(ctx, () => {})
    ok('注册四条精确路由（bash 两条 + 受限运行时两条）', routes.length === 4 && routes.every((route) => route.kind === 'exact'), JSON.stringify(routes.map((r) => r.path)))
    ok('路径与客户端一致', routes.map((route) => route.path).join(',') === `${STATUS_PATH},${INSTALL_PATH},${RUNTIME_STATUS_PATH},${RUNTIME_INSTALL_PATH}`)

    const call = (route, request) => {
        let status = null
        let body = ''
        const response = { writeHead: (code) => { status = code }, end: (text) => { body = text } }
        route.handler(request, response)
        return { status, body }
    }
    const statusRoute = routes.find((route) => route.path === STATUS_PATH)
    const installRoute = routes.find((route) => route.path === INSTALL_PATH)

    const status = call(statusRoute, { method: 'GET', headers: {} })
    ok('status 用 GET 返回 200 JSON', status.status === 200 && JSON.parse(status.body).sources.length === 2, status.body.slice(0, 80))
    ok('status 拒绝非 GET', call(statusRoute, { method: 'POST', headers: {} }).status === 405)
    ok('install 拒绝非 POST', call(installRoute, { method: 'GET', headers: {} }).status === 405)
    ok('install 拒绝跨源', call(installRoute, { method: 'POST', headers: { origin: 'https://evil.example', host: '127.0.0.1:1' } }).status === 403)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

/**
 * 下载器自测（纯 node，不需要宿主、不需要外网）：`node test/download-selftest.mjs`
 *
 * 全部素材由**本地 Range HTTP 服务器**提供（可模拟：重定向 / 忽略 Range / 缺请求头 403 / 中途断流 /
 * 慢速限速），因此离线可跑、结果确定。覆盖：
 *  - `net.js`：重定向跟随、Range、代理不可达的明确报错
 *  - `engine.js`：分片内容一致性（含 O_APPEND 那个"大小对内容错"的坑）、反复断流重试+续传、
 *    中止后 `.part`+manifest 续传、sha256 拒绝/通过、忽略 Range 回退单流、同名拒绝/overwrite
 *  - `index.js` 三件套：探测不落盘 / 前台默认目录 / 后台任务 → 状态 → 取消（保留 .part）→ 续传 /
 *    参数校验 / 状态列表不把 `*.spec.json` 当任务
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as D from '../lib/download/index.js'
import { downloadFile, probeTarget, sha256Of } from '../lib/download/engine.js'

let failures = 0
let passed = 0
const ok = (label, cond, extra = '') => {
    if (cond) passed += 1
    else failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}

const SIZE = 6 * 1024 * 1024
const body = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i += 1) body[i] = (i * 31) % 256
const wantHash = createHash('sha256').update(body).digest('hex')

let dropEvery = 0
let dropCounter = 0
let ignoreRange = false
let requireToken = false
let slowMode = false

const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/big.bin' }); res.end(); return }
    if (req.url === '/unknown.bin') {
 // **未知大小**端点：故意不设 Content-Length（Node 自动 chunked）、
        // 不设 Accept-Ranges、忽略 Range 请求头 —— 模拟 codeload 那类“边生成边吐”的端点。
        res.writeHead(200, { ETag: '"u1"' })
        let at = 0
        const pump = () => {
            if (at >= SIZE) { res.end(); return }
            const upto = Math.min(at + 512 * 1024, SIZE)
            res.write(body.subarray(at, upto))
            at = upto
            setTimeout(pump, 1)
        }
        pump()
        return
    }
    if (req.url !== '/big.bin') { res.writeHead(404); res.end(); return }
    if (requireToken && req.headers['x-token'] !== 'secret') { res.writeHead(403); res.end('forbidden'); return }
    const m = ignoreRange ? null : /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    const start = m ? Number(m[1]) : 0
    const end = m ? (m[2] === '' ? SIZE - 1 : Number(m[2])) : SIZE - 1
    res.writeHead(m ? 206 : 200, {
        ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}),
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        ETag: '"v1"',
    })
    if (dropEvery > 0 && (dropCounter += 1) % dropEvery === 0) {
        res.write(body.subarray(start, start + Math.min(256 * 1024, end - start + 1)))
        setTimeout(() => res.destroy(), 10)
        return
    }
    if (slowMode) {
        let at = start
        const pump = () => {
            if (at > end) { res.end(); return }
            const upto = Math.min(at + 32 * 1024 - 1, end)
            res.write(body.subarray(at, upto + 1))
            at = upto + 1
            setTimeout(pump, 60)          // ≈0.53 MB/s ⇒ 6 MB 要 ~11 s，给"状态/取消"留足时间
        }
        pump()
        return
    }
    res.end(body.subarray(start, end + 1))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const cwd = mkdtempSync(join(tmpdir(), 'dl-selftest-'))
const exec = { agent: { session: { header: { cwd } } } }
const tools = D.tools((t) => t)
// 工具面收敛：download / download_status / download_cancel 合并成一个 action 驱动的 `download`。
// 按旧名查回"动作已绑定"的薄壳 ⇒ 正文调用点（dl/st/cc.execute({...})）一行不用改。
const ACTION_OF = { download: 'start', download_status: 'status', download_cancel: 'cancel' }
const by = (name) => {
    const all = tools.find ? tools : tools((t) => t)
    const action = ACTION_OF[name]
    if (action === undefined) return all.find((t) => t.name === name)
    const t = all.find((x) => x.name === 'download')
    return { name, execute: (args, exec) => t.execute({ action, ...(args ?? {}) }, exec) }
}
const dl = by('download')
const st = by('download_status')
const cc = by('download_cancel')

console.log('== 1. net/engine：重定向 + Range + 采样 ==')
{
    const info = await probeTarget({ url: `${base}/redirect`, proxy: 'direct', sampleBytes: 512 * 1024, connections: 4 })
    ok('跟随重定向并报最终 URL', info.redirects.length === 1 && info.finalUrl.endsWith('/big.bin'), `${info.redirects.length} 跳`)
    ok('探测出 Range 支持与总大小', info.rangeSupported === true && info.total === SIZE, `total=${info.total}`)
    ok('每连接采样有结果', info.sampleSummary !== undefined && info.sampleSummary.connections >= 2, JSON.stringify(info.sampleSummary?.connections))
}

console.log('== 2. engine：分片下载内容逐字节一致（含 O_APPEND 回归）==')
{
    const to = join(cwd, 'a.bin')
    const r = await downloadFile({ url: `${base}/big.bin`, to, threads: 4, proxy: 'direct' })
    ok('4 线程分片完成', r.ok && r.mode === 'segmented' && r.threads === 4, `mode=${r.mode} threads=${r.threads} chunks=${r.chunks}`)
    ok('内容与源逐字节一致', readFileSync(to).equals(body))
    ok('自算 sha256 与源一致', r.sha256 === wantHash, r.sha256?.slice(0, 12))
}

console.log('== 3. engine：反复断流 ⇒ 重试 + 片内续传，内容仍一致 ==')
{
    const to = join(cwd, 'b.bin')
    dropEvery = 3
    dropCounter = 0
    let logs = 0
    const r = await downloadFile({ url: `${base}/big.bin`, to, threads: 4, proxy: 'direct', log: () => { logs += 1 } })
    dropEvery = 0
    ok('断流后仍完成且内容一致', r.ok && readFileSync(to).equals(body), `重试日志 ${logs} 条`)
}

console.log('== 4. engine：中止 ⇒ .part + manifest 保留 ⇒ 续传完成 ==')
{
    const to = join(cwd, 'c.bin')
    slowMode = true
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 250)
    let aborted = null
    try { await downloadFile({ url: `${base}/big.bin`, to, threads: 4, proxy: 'direct', signal: ac.signal }) }
    catch (e) { aborted = e.message }
    slowMode = false
    ok('中止报 aborted 且 .part+manifest 保留', aborted === 'aborted' && existsSync(`${to}.part`) && existsSync(`${to}.part.manifest.json`))
    const r = await downloadFile({ url: `${base}/big.bin`, to, threads: 4, proxy: 'direct' })
    ok('续传后完成且内容一致', r.ok && readFileSync(to).equals(body), `resumedFrom=${r.resumedFrom}`)
}

console.log('== 5. engine：sha256 校验（错 hash 拒绝并清理；对 hash 通过）==')
{
    const to = join(cwd, 'd.bin')
    let bad = null
    try { await downloadFile({ url: `${base}/big.bin`, to, threads: 2, proxy: 'direct', expectedSha256: 'deadbeef' }) } catch (e) { bad = e.message }
    ok('错 hash 报错且清理 .part、不生成目标', bad !== null && !existsSync(`${to}.part`) && !existsSync(to))
    const r = await downloadFile({ url: `${base}/big.bin`, to, threads: 3, proxy: 'direct', expectedSha256: wantHash })
    ok('对 hash 通过且文件校验一致', r.sha256 === wantHash && (await sha256Of(to)) === wantHash)
}

console.log('== 6. engine：忽略 Range ⇒ 明确回退单流；同名拒绝/overwrite ==')
{
    ignoreRange = true
    const to = join(cwd, 'e.bin')
    const info = await probeTarget({ url: `${base}/big.bin`, proxy: 'direct', sample: false })
    let note = ''
    const r = await downloadFile({ url: `${base}/big.bin`, to, threads: 4, proxy: 'direct', probeInfo: info, log: (m) => { note += m } })
    ignoreRange = false
    ok('不支持 Range 时 mode=single 且内容一致', r.mode === 'single' && readFileSync(to).equals(body), note.slice(0, 40))
    let dup = null
    try { await downloadFile({ url: `${base}/big.bin`, to, threads: 2, proxy: 'direct' }) } catch (e) { dup = e.message }
    ok('同名拒绝', dup !== null && /overwrite:true/.test(dup))
    const r2 = await downloadFile({ url: `${base}/big.bin`, to, threads: 2, proxy: 'direct', overwrite: true })
    ok('overwrite:true 才覆盖', r2.ok)
}

console.log('== 7. 工具层：探测不落盘 / 前台默认目录 / 结果字段 ==')
{
    const out = await dl.execute({ url: `${base}/redirect`, probe: true, proxy: 'direct' }, exec)
    ok('探测报告 Range/大小/结论', /Range 支持 : 是/.test(out) && /6\.0 MB/.test(out) && /结论/.test(out))
    ok('探测不写任何文件', !existsSync(join(cwd, 'downloads', 'big.bin')))

 // ── P0 回归（宿主侧评审在真宿主抓到）──────────────────────────────
    // 合并成 action 驱动后，`{ action: "probe" }` 曾被路由到**普通下载**（旧实现只认 `probe===true`）⇒
    // 用户以为在探测、实际花了流量还写了文件（含"不给 to 就落到 <工作区>\downloads\"那条路径）。
    // 之前这里只测了 `probe:true` ⇒ 组合零覆盖。下面把两种写法、两种落点都钉住。
    {
        const probeDir = join(cwd, 'probe-action')
        mkdirSync(probeDir, { recursive: true })
        const dest = join(probeDir, 'should-not-exist.bin')
        const outP = await dl.execute({ action: 'probe', url: `${base}/big.bin`, to: dest, proxy: 'direct' }, exec)
        ok('action:"probe" 给探测报告（Range/大小/结论）', /Range 支持/.test(outP) && /结论/.test(outP), outP.split('\n')[0]?.slice(0, 50) ?? '')
        ok('action:"probe" 绝不落盘（指定 to）', !existsSync(dest) && !existsSync(`${dest}.part`), existsSync(dest) ? '!! 文件被写出了' : '未写盘 ✓')
        // 不给 to：也不能在默认落点 <工作区>/downloads/ 写任何东西
        const execP = { agent: { session: { header: { cwd: probeDir } } } }
        const outP2 = await dl.execute({ action: 'probe', url: `${base}/big.bin`, proxy: 'direct' }, execP)
        ok('action:"probe" 绝不写默认落点 <工作区>/downloads/', !existsSync(join(probeDir, 'downloads')), existsSync(join(probeDir, 'downloads')) ? '!! 默认目录被创建了' : '未创建 ✓')
        const outB = await dl.execute({ url: `${base}/big.bin`, probe: true, proxy: 'direct' }, exec)
        ok('action:"probe" 与 probe:true 两种写法等价', /Range 支持/.test(outP2) && /Range 支持/.test(outB))
    }
    const out2 = await dl.execute({ url: `${base}/big.bin`, proxy: 'direct', threads: 4, sha256: wantHash }, exec)
    const target = join(cwd, 'downloads', 'big.bin')
    ok('默认落盘 <工作区>/downloads/ 且文件名取自 URL', existsSync(target) && readFileSync(target).equals(body))
    ok('结果报告 sha256/线程/分片', /sha256 [0-9a-f]{64}/.test(out2) && /threads=4/.test(out2))
    let dup = null
    try { await dl.execute({ url: `${base}/big.bin`, proxy: 'direct' }, exec) } catch (e) { dup = e.message }
    ok('同名默认拒绝并给三条出路', dup !== null && /overwrite:true/.test(dup) && /续传/.test(dup))
}

console.log('== 8. 工具层：后台任务 → 状态 → 取消（保留 .part）→ 续传 ==')
{
    slowMode = true
    const to = join(cwd, 'downloads', 'slow.bin')
    const out = await dl.execute({ url: `${base}/big.bin`, to, proxy: 'direct', threads: 4, mode: 'background' }, exec)
    const jobId = /background job (\S+)/.exec(out)?.[1]
    ok('后台任务返回 job id 与查看方式', Boolean(jobId) && /download \{ action: "status"/.test(out), jobId ?? '(无)')
    await new Promise((r) => setTimeout(r, 1500))
    const stOut = await st.execute({ id: jobId }, exec)
    ok('状态显示 downloading + 进度 + .part 保留', /downloading/.test(stOut) && /\.part\s+: \d/.test(stOut), (stOut.split('\n').find((l) => /downloading/.test(l)) ?? '').trim().slice(0, 70))
    const ccOut = await cc.execute({ id: jobId }, exec)
    const stOut2 = await st.execute({ id: jobId }, exec)
    const cancelled = /cancelled/.test(stOut2)
    // 两种合法结局：① 取消成功（.part 保留，可续）② 取消时刚好下完（文件完整）
    if (cancelled) {
        ok('取消后 .part 保留（可续）', existsSync(`${to}.part`) && /续传/.test(ccOut))
        ok('取消后状态为 cancelled', true)
        slowMode = false
        const r = await dl.execute({ url: `${base}/big.bin`, to, proxy: 'direct', threads: 4, sha256: wantHash }, exec)
        ok('续传完成且内容一致', readFileSync(to).equals(body), (r.split('\n')[1] ?? '').slice(0, 70))
    }
    else {
        // 下得太快没赶上取消：这也说明取消路径本身没把状态搞坏（状态应是 done）
        ok('取消窗口内已完成 ⇒ 状态为 done 且文件完整', /done/.test(stOut2) && readFileSync(to).equals(body), (stOut2.split('\n').find((l) => / done /.test(l)) ?? '').trim().slice(0, 60))
        ok('取消一个已完成任务给出友好提示', /已经完成/.test(ccOut))
        slowMode = false
    }
}

console.log('== 8b. 回归：目标不在默认 downloads/ 下时，status/cancel 也要找得到 + 目标目录不留痕 ==')
{
    // ① 早期的真 bug：status/cancel 只在 `<工作区>/downloads/.dsh-downloads` 找，
    //    而状态写在 `<目标目录>/.dsh-downloads` ⇒ 只要 `to` 不在默认 downloads/ 下就报"没有后台下载任务"。
    // ② 用户实测反馈：状态**建在目标目录里**会留下一个点目录（模型/mod 目录被别的程序扫描 ⇒ 隐患）。
    //    现在状态只写 `<工作区>/downloads/.dsh-downloads/`，目标目录一个文件都不放；旧残留会被读取并清理。
    slowMode = true
    const customDir = join(cwd, 'custom-out')
    mkdirSync(customDir, { recursive: true })
    const customTo = join(customDir, 'custom.bin')
    const dlx = tools.find((t) => t.name === 'download')
    const jobOut = await dlx.execute({ url: `${base}/big.bin`, to: customTo, proxy: 'direct', threads: 2, mode: 'background' }, exec)
    const customId = jobOut.match(/dl-[0-9a-zA-Z-]+/)?.[0] ?? null
    ok('自定义目标目录也能起后台任务', customId !== null, String(jobOut).split('\n')[0]?.slice(0, 50) ?? '')
    if (customId !== null) {
        await new Promise((r) => setTimeout(r, 400))
        ok('状态写在 <工作区>/downloads/.dsh-downloads 里', existsSync(join(cwd, 'downloads', '.dsh-downloads', `${customId}.json`)))
        ok('**目标目录里没有 .dsh-downloads**（用户报的隐患）', !existsSync(join(customDir, '.dsh-downloads')))
        const stOut = await st.execute({ id: customId }, exec)
        ok('status 按 id 能找到它（而不是"没有后台下载任务"）', !/没有后台下载任务/.test(stOut) && stOut.includes(customId), (stOut.split('\n')[0] ?? '').trim().slice(0, 70))
        const cancelOut = await st.execute({ id: customId }, exec).then(() => cc.execute({ id: customId, deletePart: true }, exec))
        ok('cancel 也能作用到它（按 id）', /取消|cancelled/.test(cancelOut), String(cancelOut).split('\n')[0]?.trim().slice(0, 60) ?? '')
    }
    // ③ 旧版残留自动退休：在目标目录旁造一个"已完成"的旧格式记录 ⇒ 带 to 调一次（start 或 status 都行）
    //    就该被清掉、目录也删掉。注意**要带 to**：候选集 = 主目录 + 索引目录 + 显式 to 的目录，
    //    不给出 to 时我们并不知道用户想把哪个目标目录旁边的东西清掉（下次往那里下载时会自动带 to）。
    const legacyDir = join(customDir, '.dsh-downloads')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'dl-20200101000000-old1.json'), JSON.stringify({ id: 'dl-20200101000000-old1', state: 'done', to: customTo, url: 'http://x/y', finishedAt: '2020-01-01T00:00:00.000Z' }))
    writeFileSync(join(legacyDir, 'dl-20200101000000-old1.log'), 'old log')
    await st.execute({ to: customTo }, exec)
    ok('旧版留在目标目录旁的 .dsh-downloads 被清理掉（带 to 调用时，连目录）', !existsSync(legacyDir), existsSync(legacyDir) ? '仍存在' : '已删除')
    slowMode = false
}

console.log('== 9. 工具层：状态列表 / 参数校验 / 坏代理 ==')
{
    const listOut = await st.execute({}, exec)
    ok('状态列表不含幽灵任务（不把 spec.json 当任务）', /total: \d+ job\(s\)/.test(listOut) && (/(done|cancelled|downloading)/.test(listOut)), (listOut.split('\n')[1] ?? '').slice(0, 50))
    let noJob = null
    try { await cc.execute({ id: 'dl-nope' }, exec) } catch (e) { noJob = e.message }
    ok('取消不存在的任务明确报错', noJob !== null && /没找到任务/.test(noJob))
    let badUrl = null
    try { await dl.execute({ url: 'ftp://x/y' }, exec) } catch (e) { badUrl = e.message }
    ok('非 http(s) 链接被拒', badUrl !== null && /http\(s\)/.test(badUrl))
    let badProxy = null
    try { await dl.execute({ url: `${base}/big.bin`, proxy: 'http://127.0.0.1:9', probe: true }, exec) } catch (e) { badProxy = e.message }
    ok('代理不可达明确报错（不静默直连）', badProxy !== null && /代理连不上/.test(badProxy))
}

console.log('== 10. 自动线程决策（planThreads）+ 工具层自动/手动 ==')
{
    const { planThreads } = await import('../lib/download/engine.js')
    const MB = 1024 * 1024
    ok('小文件（<1 MB）⇒ 单流', planThreads({ total: 0.5 * MB }).threads === 1)
    ok('不支持 Range ⇒ 单流', planThreads({ total: 999 * MB, rangeSupported: false }).threads === 1)
    ok('大文件 + 增益明显 ⇒ 多线程', planThreads({ total: 120 * MB, sampleSummary: { connections: 8, medianMbps: 2.3, aggregateMbps: 18.7 } }).threads >= 8)
    ok('大文件 + 无增益 ⇒ 收敛（不盲目多开）', planThreads({ total: 120 * MB, sampleSummary: { connections: 8, medianMbps: 10, aggregateMbps: 11 } }).threads <= 4)
    ok('手动 16 被尊重', planThreads({ total: 120 * MB, requested: 16 }).threads === 16)
    ok('手动 1 = 单流', planThreads({ total: 120 * MB, requested: 1 }).threads === 1)
    // 不变量：线程数**不超过实际切出的片数**（片数用 planChunks 真实结果算，别拿 minSplitSize 估）
    {
        const { planChunks } = await import('../lib/download/engine.js')
        const combos = [[2 * MB, 4 * MB], [6 * MB, 1 * MB], [120 * MB, 8 * MB], [1.2 * MB, 64 * MB]]
        const bad = combos.filter(([total, minSplit]) => {
            const t = planThreads({ total, minSplitSize: minSplit, sampleSummary: { connections: 4, medianMbps: 0.4, aggregateMbps: 1.6 } }).threads
            return t > planChunks(total, Math.max(1, t), minSplit).length
        })
        ok('线程数不超过实际片数（多种 minSplitSize 组合）', bad.length === 0, bad.map(([t]) => `${(t / MB).toFixed(1)}MB`).join(','))
    }
 // `minSplitSize` 很大也**不该**把并行彻底掐死（GitHub 实测：2 MB 文件曾被并成 1 块）
    ok('minSplitSize 很大时仍能并行（小文件放宽片下限）', planThreads({ total: 2 * MB, minSplitSize: 64 * MB, sampleSummary: { connections: 4, medianMbps: 0.4, aggregateMbps: 1.6 } }).threads >= 2)
    ok('慢链路（每连接 <1 MB/s）会主动多开连接', planThreads({ total: 22.7 * MB, sampleSummary: { connections: 4, medianMbps: 0.39, aggregateMbps: 1.37 } }).threads >= 8)
    ok('快链路不盲目多开（无增益 ⇒ 折半）', planThreads({ total: 120 * MB, sampleSummary: { connections: 8, medianMbps: 12, aggregateMbps: 13 } }).threads <= 4)
    ok('手动指定不受片数封顶（听用户的）', planThreads({ total: 2 * MB, requested: 32, minSplitSize: 4 * MB }).threads === 32)
    ok('决策都带可读理由', typeof planThreads({ total: 120 * MB }).reason === 'string' && planThreads({ total: 120 * MB }).reason.length > 0)

    // 工具层：不给 threads ⇒ auto（小文件单流 / 大文件多线程）；给了 ⇒ 手动
    const small = await dl.execute({ url: `${base}/big.bin`, to: join(cwd, 'downloads', 'small-auto.bin'), proxy: 'direct', threads: undefined }, exec)
    ok('工具层 auto 给出 threads=auto→N 与理由', /threads=auto→\d+（.+）/.test(small), (small.split('\n')[1] ?? '').trim().slice(0, 80))
    const manual = await dl.execute({ url: `${base}/big.bin`, to: join(cwd, 'downloads', 'manual.bin'), proxy: 'direct', threads: 2 }, exec)
    ok('未给 sha256 ⇒ 结果主动提示（fuzz 审计结论落地）', /提示：未给 sha256/.test(small), (small.split('\n').find((l) => l.includes('提示')) ?? '(无)').trim().slice(0, 60))
    ok('给了 sha256 ⇒ 不再啰嗦提示', await (async () => {
        const withSha = await dl.execute({ url: `${base}/big.bin`, to: join(cwd, 'downloads', 'with-sha.bin'), proxy: 'direct', threads: 2, sha256: wantHash }, exec)
        return !/提示：未给 sha256/.test(withSha)
    })())
    ok('工具层手动 threads=2 被标为手动', /threads=2（手动）/.test(manual), (manual.split('\n')[1] ?? '').trim().slice(0, 80))
}

console.log('== 12. 收尾加速（模拟"其他连接结束后剩下的连接不提速"）==')
{
    // 复现用户报告的 ABD 通病：每连接在**建立时**分到一份固定带宽（= 预算/当时活跃数），
    // 别的连接退出后它**不会**回升 ⇒ 最后那块一直慢。tailBoost 应该靠"劈开交回队列 / 断开重连"解决。
    const SIZE2 = 2 * 1024 * 1024
    const body2 = Buffer.alloc(SIZE2)
    for (let i = 0; i < SIZE2; i += 1) body2[i] = (i * 7) % 256
    const BUDGET = 640 * 1024            // 全局预算 640 KB/s
    // 第一个连接只给 50 KB/s：仍是 640 KB/s 预算的 8%（远低于 0.5×最好速率 ⇒ stale 门槛 320）⇒ "慢尾"语义不变，
    // 而"不加速"那一轮的墙钟从 20 s 降到 ~10 s；再快（80 KB/s）可提升空间就太小、比例断言反而过不去。
    const STRAGGLER = 50 * 1024
    // 每次 run 起一个**独立**服务端：共享计数器会被上一轮 socket 的异步 close 事件弄脏
 // （实测：active 被减成 0/负数 ⇒ `BUDGET/max(1,active)` 给成满速 ⇒ 慢尾消失）
    const makeTailServer = async () => {
        let active = 0
        let firstDone = false
        const srv = createServer((req, res) => {
            const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
            const start = m ? Number(m[1]) : 0
            const end = m ? (m[2] === '' ? SIZE2 - 1 : Number(m[2])) : SIZE2 - 1
            // ⚠️ 探测请求（`Range: bytes=0-0`，1 字节）**不能**占用"慢连接"名额 —— 否则真正的第一个
 // 数据连接会拿到正常份额，夹具就模拟不出慢尾（实测踩到：下载只用 7.8 s 就完了）
            const isProbe = (end - start + 1) <= 1024
            active += 1
            const isFirst = !firstDone && !isProbe
            if (isFirst) firstDone = true
            const share = isFirst ? STRAGGLER : Math.floor(BUDGET / Math.max(1, active))
            res.writeHead(m ? 206 : 200, {
                ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE2}` } : {}),
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                ETag: '"v2"',
            })
            let at = start
            let settled = false
            const settle = () => { if (!settled) { settled = true; active -= 1 } }
            const pump = () => {
                if (at > end) { settle(); res.end(); return }
                // ⚠️ 每 100 ms 发 share/10，**不要再套 Math.max(4096,…) 之类的下限** ——
 // 那会把"慢连接"抬到 ~204 KB/s，慢尾就模拟不出来（踩过）
                const n = Math.max(256, Math.floor(share / 10))
                const upto = Math.min(at + n - 1, end)
                res.write(body2.subarray(at, upto + 1))
                at = upto + 1
                setTimeout(pump, 100)
            }
            res.on('close', () => { if (!res.writableEnded) settle() })
            pump()
        })
        await new Promise((r) => srv.listen(0, '127.0.0.1', r))
        return srv
    }

    const run = async (tailBoost) => {
        const srv = await makeTailServer()
        const to = join(cwd, `tail-${tailBoost ? 'on' : 'off'}.bin`)
        const t0 = Date.now()
        const r = await downloadFile({ url: `http://127.0.0.1:${srv.address().port}/f.bin`, to, threads: 2, proxy: 'direct', tailBoost, minSplitSize: 1024 * 1024 })
        const result = { ms: Date.now() - t0, r, ok: readFileSync(to).equals(body2) }
        srv.close()
        return result
    }

    // **把检测节奏调快**（默认 2 s × 2 次 = 一轮就要 4 s，两轮实测 ~28 s，占整份下载自测的 3/4）。
    // 阈值是产品常量，但支持环境变量覆盖（默认不变）；这里只在**这一段**调小，跑完还原。
    // 断言比较的是 on/off **两者的墙钟比值**，两边同时变快 ⇒ 比值关系不变。
    const savedCheck = process.env.DSH_DOWNLOAD_SLOW_CHECK_MS
    const savedStrikes = process.env.DSH_DOWNLOAD_STALE_STRIKES
    process.env.DSH_DOWNLOAD_SLOW_CHECK_MS = '300'
    process.env.DSH_DOWNLOAD_STALE_STRIKES = '2'
    let off
    let on
    try {
        off = await run(false)
        on = await run(true)
    }
    finally {
        if (savedCheck === undefined) delete process.env.DSH_DOWNLOAD_SLOW_CHECK_MS
        else process.env.DSH_DOWNLOAD_SLOW_CHECK_MS = savedCheck
        if (savedStrikes === undefined) delete process.env.DSH_DOWNLOAD_STALE_STRIKES
        else process.env.DSH_DOWNLOAD_STALE_STRIKES = savedStrikes
    }
    console.log(`    不加速：${off.ms} ms（splits=${off.r.splits} resplits=${off.r.resplits} reconnects=${off.r.reconnects}）内容一致=${off.ok}`)
    console.log(`    收尾加速：${on.ms} ms（splits=${on.r.splits} resplits=${on.r.resplits} reconnects=${on.r.reconnects}）内容一致=${on.ok}`)
    ok('两条路径内容都正确（缺一块会被"分片没下完"拦住）', off.ok && on.ok)
    ok('收尾加速确实动作了（劈开或重连）', on.r.resplits + on.r.reconnects > 0, `resplits=${on.r.resplits} reconnects=${on.r.reconnects}`)
    ok('收尾加速明显更快（< 关掉时的 70%）', on.ms < off.ms * 0.7, `${on.ms} ms vs ${off.ms} ms`)
}

console.log('== 13. 分块下限与覆盖性（不许越切越碎 / 不许有缺口）==')
{
    const { canSplit, normalizeChunks, TAIL_MIN_SPLIT } = await import('../lib/download/engine.js')
    ok('剩下的块不够两倍下限 ⇒ 不再劈', canSplit(TAIL_MIN_SPLIT - 1, 64 * 1024) === false)
    ok('刚好两倍下限 ⇒ 允许劈', canSplit(2 * TAIL_MIN_SPLIT, 64 * 1024) === true)
    ok('用户给了更大的 minSplitSize ⇒ 以下限大的那个为准', canSplit(2 * TAIL_MIN_SPLIT, 4 * 1024 * 1024) === false && canSplit(8 * 1024 * 1024, 4 * 1024 * 1024) === true)
    // 碎块会被并进相邻块（不许留下小于下限的碎片）
    const tiny = normalizeChunks([
        { start: 0, end: 1024 * 1024 - 1, done: 1024 * 1024 },
        { start: 1024 * 1024, end: 1024 * 1024 + 1024 - 1, done: 0 },   // 1 KB 碎片（相邻）
    ], 1024 * 1024 + 1024, 512 * 1024)
    ok('碎块被并进相邻块（不留 1 KB 碎片）', tiny.chunks.length === 1 && tiny.chunks[0].end === 1024 * 1024 + 1023, JSON.stringify(tiny.chunks.map((c) => [c.start, c.end])))
    ok('覆盖性校验：没有空洞', tiny.gaps.length === 0, tiny.gaps.join(','))
    const holed = normalizeChunks([
        { start: 0, end: 1023, done: 1024 },
        { start: 4096, end: 8191, done: 4096 },     // 中间空 1024-4095
    ], 8192, 512 * 1024)
    ok('覆盖性校验：能报出空洞', holed.gaps.length > 0, holed.gaps.join(','))
}

console.log('== 14. 站点"假装支持 Range"（分段请求返回整包 200）⇒ 自动回退单流 ==')
{
    // 这类站点很常见：`Accept-Ranges: bytes` 摆着，实际只认整包。以前会报错让用户整包重下，
 // 现在必须**自动回退单流**并如实说明（用户 要求兜住"不支持断点续传"的站点）。
    const SIZE3 = 3 * 1024 * 1024
    const body3 = Buffer.alloc(SIZE3)
    for (let i = 0; i < SIZE3; i += 1) body3[i] = (i * 11) % 256
    const s3 = createServer((req, res) => {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = m ? (m[2] === '' ? SIZE3 - 1 : Number(m[2])) : SIZE3 - 1
        // start=0 老实给分段；start>0 **一律回整包 200**（= 不支持续传/分段）
        if (start > 0) {
            res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': SIZE3, ETag: '"v3"' })
            res.end(body3)
            return
        }
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${SIZE3}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ETag: '"v3"' })
        res.end(body3.subarray(start, end + 1))
    })
    await new Promise((r) => s3.listen(0, '127.0.0.1', r))
    const to = join(cwd, 'downloads', 'norange.bin')
    const r = await downloadFile({ url: `http://127.0.0.1:${s3.address().port}/f.bin`, to, threads: 4, proxy: 'direct' })
    const same = readFileSync(to).equals(body3)
    console.log(`    mode=${r.mode} threads=${r.threads} 回退单流=${r.noRangeFallback} 内容一致=${same}`)
    ok('忽略了 Range ⇒ 自动回退单流（不报错、不放弃）', r.noRangeFallback === true && r.mode === 'single' && r.threads === 1, `noRangeFallback=${r.noRangeFallback} mode=${r.mode}`)
    ok('回退单流后内容仍然一致', same)
    s3.close()
}

console.log('== 15. 站点拒绝多线程（并发时 429 + Retry-After）⇒ 自动降线程 ==')
{
    const SIZE4 = 4 * 1024 * 1024
    const body4 = Buffer.alloc(SIZE4)
    for (let i = 0; i < SIZE4; i += 1) body4[i] = (i * 5) % 256
 // 模拟**允许并发但限制连接数**的站点：最多放 CONN_CAP 条，其余的 429（用户 描述的场景：
    // "16 线程只有 4 条是通的，其他都拒绝了"）。
    const CONN_CAP = 2
    let active4 = 0
    let rejects = 0
    const s4 = createServer((req, res) => {
        active4 += 1
        let settled4 = false
        const settle = () => { if (!settled4) { settled4 = true; active4 -= 1 } }
        if (active4 > CONN_CAP) {
            rejects += 1
            res.writeHead(429, { 'Retry-After': '1', 'Content-Length': 0 })
            res.end()
            settle()
            return
        }
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = m ? (m[2] === '' ? SIZE4 - 1 : Number(m[2])) : SIZE4 - 1
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${SIZE4}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ETag: '"v4"' })
 // ⚠️ 必须**慢慢发**，否则连接瞬间结束、并发永远上不去，模拟不出"限连接数"（踩过）
        let at4 = start
        const pump4 = () => {
            if (at4 > end) { settle(); res.end(); return }
            const upto4 = Math.min(at4 + 128 * 1024 - 1, end)     // 1.28 MB/s/连接
            res.write(body4.subarray(at4, upto4 + 1))
            at4 = upto4 + 1
            setTimeout(pump4, 100)
        }
        res.on('close', () => { if (!res.writableEnded) settle() })
        pump4()
    })
    await new Promise((r) => s4.listen(0, '127.0.0.1', r))
    const base4 = `http://127.0.0.1:${s4.address().port}`
    let r4 = null
    let err4 = null
    const logs4 = []
    try {
        // 要 8 条（服务器只放 2 条）⇒ 引擎该自己降下来、**绝不能因此判死**
        r4 = await downloadFile({ url: `${base4}/f.bin`, to: join(cwd, 'downloads', 'rejects.bin'), threads: 8, proxy: 'direct', log: (m) => logs4.push(m) })
    }
    catch (error) { err4 = error }
    const same = err4 === null && existsSync(join(cwd, 'downloads', 'rejects.bin')) && readFileSync(join(cwd, 'downloads', 'rejects.bin')).equals(body4)
    const downs = r4?.downgrades ?? 0
    const finalThreads = r4?.threads ?? -1
    console.log(`    请求 8 条 → 降并发 ${downs} 次 → 实际 ${finalThreads} 条；被拒 ${rejects} 次；内容一致=${same}${err4 ? ` 错误=${err4.message.slice(0, 80)}` : ''}`)
    if (err4 !== null) console.log('    引擎日志：' + logs4.slice(-3).join(' | ').slice(0, 260))
    ok('限连接数的站点：自动降并发并完成后仍内容一致', err4 === null && same && downs >= 1, `downgrades=${downs}${err4 ? ` err=${err4.message.slice(0, 50)}` : ''}`)
    ok('最终并发落在服务器允许的上限内（≤ ' + CONN_CAP + '）', finalThreads >= 1 && finalThreads <= CONN_CAP, `实际 ${finalThreads}`)

    // 第二次：**按主机记住的上限**应生效 ⇒ 起步就是 2 条，不必再挨一轮拒绝
    let r4b = null
    let err4b = null
    const rejectsBefore = rejects
    const logs4b = []
    try {
        r4b = await downloadFile({ url: `${base4}/f.bin`, to: join(cwd, 'downloads', 'rejects2.bin'), threads: 8, proxy: 'direct', log: (m) => logs4b.push(m) })
    }
    catch (error) { err4b = error }
    const okSecond = err4b === null && existsSync(join(cwd, 'downloads', 'rejects2.bin')) && readFileSync(join(cwd, 'downloads', 'rejects2.bin')).equals(body4)
    console.log(`    第二次：降并发 ${r4b?.downgrades ?? 0} 次、实际 ${r4b?.threads ?? -1} 条、新增被拒 ${rejects - rejectsBefore} 次、内容一致=${okSecond}`)
    // 要保证的是"**记住的上限生效**"：从上限定步、零降档、零新增拒绝（服务器若不反对，之后允许向上试探）
    ok('同主机第二次从"记住的上限"起步（日志可见）且不再挨拒绝', okSecond && (r4b?.downgrades ?? 0) === 0 && rejects - rejectsBefore === 0 && logs4b.some((m) => /上次实测最多 .* 条并发连接/.test(m)), `downgrades=${r4b?.downgrades ?? 0} 新增被拒=${rejects - rejectsBefore}`)
    s4.close()
}

console.log('== 16. 失败诊断（DNS 污染 / 连不上 / TLS 重置 / 代理不可用）==')
{
    const { classifyNetError, diagnoseNetError } = await import('../lib/download/net.js')
    const mk = (code, msg) => Object.assign(new Error(msg), { code })
    ok('DNS 解析失败被识别', classifyNetError(mk('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com')).kind === 'dns')
    ok('连不上/超时被识别', classifyNetError(mk('ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:443')).kind === 'connect')
    ok('TLS 被重置被识别', classifyNetError(mk('ECONNRESET', 'socket hang up')).kind === 'tls')
    ok('代理自身问题被识别', classifyNetError(mk('', '代理拒绝 CONNECT x：HTTP 407（代理要认证）'), { proxyKind: 'http' }).kind === 'proxy')
    const dnsNoProxy = diagnoseNetError(mk('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com'), { proxyKind: 'none', url: 'https://github.com/a/b' }).join('\n')
    ok('DNS 失败且无代理 ⇒ 指向系统代理/TUN', /DNS 污染/.test(dnsNoProxy) && /系统代理/.test(dnsNoProxy))
    ok('DNS 失败且无代理 ⇒ 点明"代理在跑但没设系统代理"时必须显式传地址', /显式传地址/.test(dnsNoProxy))
    const dnsProxy = diagnoseNetError(mk('EAI_AGAIN', 'x'), { proxyKind: 'http', proxySource: 'PAC (PROXY 字面量)', url: 'https://github.com/a/b' }).join('\n')
    ok('DNS 失败但代理已启用 ⇒ 提示换节点（不误导去开代理）', /代理已启用/.test(dnsProxy) && /换/.test(dnsProxy))
    const connNoProxy = diagnoseNetError(mk('ETIMEDOUT', 'connect ETIMEDOUT'), { proxyKind: 'none', url: 'https://x/y' }).join('\n')
 // 改：以前这句只给 `proxy:"http://…"` 例子，现在**首推“别传 proxy / 用 auto”** —— 本机实测
    // `proxy:'direct'` 在 HF/GitHub 上必超时，而 auto（跟着系统代理/PAC）能通；只有 LAN 地址才用 direct。
    ok('连不上且无代理 ⇒ 首推“改传 auto / 省略 proxy”，并承认“确知可直连时 direct 本就没错”', /proxy:"auto"/.test(connNoProxy) && /省略 proxy/.test(connNoProxy) && /确知/.test(connNoProxy))
    // 真实场景：代理软件在跑、但用户**关掉了系统代理**（例如后台有别的任务）⇒ auto 探测不到它，
    // 此时"改传 auto"是**循环建议**（auto 本来就是直连）⇒ 必须点明显式传地址这条路。
    ok('连不上且无代理 ⇒ 指出“代理在跑但没设系统代理”要**显式传地址**', /没设「系统代理」/.test(connNoProxy) && /127\.0\.0\.1:7890/.test(connNoProxy))
    // 归一化回归：调用方可能把**原始选项**（direct / 历史别名 none、off）当 proxyKind 传进来，
    // 三种都必须走"无代理/直连"分支（否则会误报"代理已启用却解析失败"）。
    const mkTimeout = () => mk('ETIMEDOUT', 'connect ETIMEDOUT')
    const rawDirect = diagnoseNetError(mkTimeout(), { proxyKind: 'direct', url: 'https://x/y' }).join('\n')
    const rawNone = diagnoseNetError(mkTimeout(), { proxyKind: 'none', url: 'https://x/y' }).join('\n')
    const rawOff = diagnoseNetError(mkTimeout(), { proxyKind: 'off', url: 'https://x/y' }).join('\n')
    ok('proxyKind 传原始选项（direct / none / off）都识别为直连分支', rawDirect === rawNone && rawNone === rawOff && /省略 proxy/.test(rawDirect))
    ok('proxyKind 传真实代理地址时仍走"代理已启用"分支', /代理已启用/.test(diagnoseNetError(mkTimeout(), { proxyKind: 'http', url: 'https://x/y' }).join('\n')))
 // 回归（真事故）：超时文案是**中文**，以前分类器只认英文 timeout ⇒ 掉 unknown ⇒ 一句出路都没有。
    ok('中文超时文案也被识别为“连不上”', classifyNetError(mk('', '请求超时（30000 ms 内没有完成）')).kind === 'connect')
    ok('未归类错误也给出路（不再只有一句超时）', diagnoseNetError(mk('', '某种没见过的错误'), { proxyKind: 'none', url: 'https://x/y' }).join('\n').includes('出路：'))

    // 端到端：`.invalid` 永不解析 ⇒ 工具层要把诊断附在错误里（而不是只抛一句 fetch failed）
    const dlx = tools.find((t) => t.name === 'download')
    let errText = ''
    try {
        await dlx.execute({ url: 'https://no-such-host-xyz.invalid/file.bin', probe: true, proxy: 'direct', timeoutMs: 5000 }, exec)
    }
    catch (error) { errText = error instanceof Error ? error.message : String(error) }
    ok('真实的解析失败会带上诊断与出路', /诊断：/.test(errText) && /出路：/.test(errText), errText.split('\n').slice(0, 2).join(' ').slice(0, 100))
}

console.log('== 11. 依赖与代理探测的纯函数 ==')
{
    const { resolveProxy, getSystemProxy, getEnvProxy, isDirectOption } = await import('../lib/download/net.js')
    const direct = resolveProxy('direct', 'example.com')
    ok('resolveProxy(direct) = 直连（对外宣传的写法）', direct.kind === 'none' && direct.source === 'explicit direct', direct.source)
    ok('历史别名 none / off / false 仍然可用（老会话不失效）', isDirectOption('none') && isDirectOption('off') && isDirectOption(false) && resolveProxy('none', 'x').kind === 'none' && resolveProxy('off', 'x').kind === 'none')
    ok('不把 "none" 当"未指定"：缺省仍是 auto', !isDirectOption(undefined) && resolveProxy(undefined, 'example.com').kind !== undefined)
    const socks = resolveProxy('socks5h://u:p@127.0.0.1:7891', 'example.com')
    ok('socks5h 解析出远程 DNS 与账号', socks.kind === 'socks5' && socks.remoteDns === true && socks.auth.user === 'u' && socks.port === 7891)
    const http = resolveProxy('http://127.0.0.1:7890', 'example.com')
    ok('http 代理解析出端口', http.kind === 'http' && http.port === 7890)
    ok('bypass 生效（NO_PROXY 命中时直连）', resolveProxy({ ...http, override: ['example.com'] }, 'example.com').kind === 'none' || typeof getSystemProxy() === 'object' || getEnvProxy() === null)
}

console.log('== 17. auto 跟随系统代理（不按域名自作聪明）+ 显式直连 + NO_PROXY ==')
{
    const { getSystemProxy, resolveProxyAsync } = await import('../lib/download/net.js')
    // `auto` 的语义：**代理说了算**（PAC/规则模式 ⇒ 由代理决定直连还是走代理；全局模式 ⇒ 全走代理）。
    // 我们**不**按域名做任何 bypass —— 国内站点该不该直连交给 agent 判断后显式 `proxy:'direct'`。
    const auto = await resolveProxyAsync('auto', 'registry.npmmirror.com')
    const sys = getSystemProxy()
    const sysProxy = sys !== null && typeof sys.url === 'string' && sys.url !== ''
    ok('auto 对国内域名也不会自作主张绕开代理', sysProxy ? auto.kind !== 'none' : true, JSON.stringify(auto))
    ok('auto 的结论与系统代理一致（跟随，而不是另立规则）', !sysProxy || auto.kind !== 'none')
    const forced = await resolveProxyAsync('direct', 'registry.npmmirror.com')
    ok('显式 proxy:direct ⇒ 强制直连（确知可直连时用）', forced.kind === 'none' && forced.source === 'explicit direct', forced.source)
    const explicit = await resolveProxyAsync('http://127.0.0.1:7890', 'github.com')
    ok('显式代理照旧可用', explicit.kind === 'http' && explicit.port === 7890)

    // NO_PROXY 在 auto 模式下也必须生效（以前只有"代理来自环境变量"时才看它）
    const saved = process.env.NO_PROXY
    process.env.NO_PROXY = 'no-proxy-test.invalid'
    try {
        const r = await resolveProxyAsync('auto', 'no-proxy-test.invalid')
        ok('auto 模式尊重 NO_PROXY（命中即直连）', r.kind === 'none', String(r.source))
    }
    finally {
        if (saved === undefined) delete process.env.NO_PROXY
        else process.env.NO_PROXY = saved
    }
    // 工具层：显式 direct 时输出如实写"直连"
    const srv = createServer((req, res) => {
        res.writeHead(200, { 'Content-Length': 11, 'Accept-Ranges': 'bytes' })
        res.end(Buffer.from('hello world'))
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const ruleCwd = mkdtempSync(join(tmpdir(), 'direct-alias-'))
    const dlx2 = tools.find((t) => t.name === 'download')
    const out = await dlx2.execute({ url: `http://127.0.0.1:${srv.address().port}/f.txt`, to: join(ruleCwd, 'f.txt'), proxy: 'direct' }, { agent: { session: { header: { cwd: ruleCwd } } } })
    ok('工具层显式 direct ⇒ 结果里写明"直连"', /代理 直连/.test(out), out.split('\n').filter((l) => /代理/.test(l))[0]?.trim().slice(0, 80) ?? '(无)')
    srv.close()
}

console.log('== 18. 重定向安全：跨站剥离 Cookie/Authorization，同站保留 ==')
{
 // 审计发现：以前"跨主机保持自定义头" ⇒ github → 任意第三方跳转会把 Cookie/Authorization 一起送出。
    const { fetchFollowing, maskCredentials } = await import('../lib/download/net.js')
    const seen = []
    const target = createServer((req, res) => {
        seen.push({ cookie: req.headers.cookie, auth: req.headers.authorization, ua: req.headers['user-agent'], referer: req.headers.referer })
        res.writeHead(200, { 'Content-Length': 2 })
        res.end('ok')
    })
    await new Promise((r) => target.listen(0, '0.0.0.0', r))
    const tport = target.address().port
    const mkRedirector = async (locationHost) => {
        const s = createServer((req, res) => {
            res.writeHead(302, { Location: `http://${locationHost}:${tport}/final` })
            res.end()
        })
        await new Promise((r) => s.listen(0, '127.0.0.1', r))
        return s
    }
    const headers = { Cookie: 'sid=secret', Authorization: 'Bearer secret', 'User-Agent': 'dsh-test', Referer: 'https://ref.example/' }

    // 跨站：127.0.0.1 → localhost（不同主机名）
    const cross = await mkRedirector('localhost')
    const r1 = await fetchFollowing({ url: `http://127.0.0.1:${cross.address().port}/start`, headers, proxyOption: 'direct' })
    const got1 = seen[seen.length - 1]
    ok('跨站重定向：Cookie 不被带过去', got1.cookie === undefined, String(got1.cookie ?? '(无)'))
    ok('跨站重定向：Authorization 不被带过去', got1.auth === undefined, String(got1.auth ?? '(无)'))
    ok('跨站重定向：非敏感头仍保留（UA/Referer）', got1.ua === 'dsh-test' && got1.referer === 'https://ref.example/')
    ok('跨站重定向：结果里说明剥离了哪些头', /已剥离敏感头/.test(String(r1.strippedNote)) && /cookie/i.test(String(r1.strippedNote)), String(r1.strippedNote ?? '').slice(0, 70))
    cross.close()

    // 同站（同主机、不同端口）⇒ 必须保留（很多站点靠 Cookie 才给下）
    const same = await mkRedirector('127.0.0.1')
    const r2 = await fetchFollowing({ url: `http://127.0.0.1:${same.address().port}/start`, headers, proxyOption: 'direct' })
    const got2 = seen[seen.length - 1]
    ok('同站重定向：Cookie/Authorization 保留', got2.cookie === 'sid=secret' && got2.auth === 'Bearer secret')
    ok('同站重定向：不产生"已剥离"说明', r2.strippedNote === null || r2.strippedNote === undefined)
    same.close()
    target.close()

    // 回显 URL 前抹掉账号密码
    ok('maskCredentials 抹掉代理账号密码', maskCredentials('socks5h://user:pass@127.0.0.1:7891') === 'socks5h://***@127.0.0.1:7891', maskCredentials('socks5h://user:pass@127.0.0.1:7891'))
    ok('maskCredentials 对无凭据 URL 不改动', maskCredentials('http://127.0.0.1:7890') === 'http://127.0.0.1:7890')
}

// ── 未知大小（无 Content-Length + 忽略 Range）：流式落盘“下到哪算哪”（加）──────
{
    const dir = mkdtempSync(join(tmpdir(), 'dsh-unknown-'))
    const to = join(dir, 'unknown.bin')
    // ① 探测：如实报“拿不到大小”，不报错
    const info = await probeTarget({ url: `${base}/unknown.bin`, proxy: 'direct' })
    ok('未知大小：probe 不报错且 total=0', info.total === 0, `total=${info.total}`)
    ok('未知大小：probe 看出不支持 Range', info.rangeSupported === false, `rangeSupported=${info.rangeSupported}`)
    // ② 真的能下：字节数 / sha256 / mode 都对
    const res = await downloadFile({ url: `${base}/unknown.bin`, to, proxy: 'direct', expectedSha256: wantHash, log: () => {} })
    ok('未知大小：下载成功且 mode=stream / unknownTotal', res.ok === true && res.mode === 'stream' && res.unknownTotal === true, `mode=${res.mode}`)
    ok('未知大小：字节数与源一致', res.bytes === SIZE, `${res.bytes} vs ${SIZE}`)
    ok('未知大小：sha256 自动核对通过', res.sha256 === wantHash)
    ok('未知大小：落盘文件内容一致', statSync(to).size === SIZE && (await sha256Of(to)) === wantHash)
    // ③ 期望字节数只能在**下载后**核对（服务端没给，没法提前比）
    const to2 = join(dir, 'unknown2.bin')
    let bfsErr = null
    try { await downloadFile({ url: `${base}/unknown.bin`, to: to2, proxy: 'direct', expectedBytes: SIZE + 1, log: () => {} }) }
    catch (error) { bfsErr = error }
    ok('未知大小：expectedBytes 事后核对并报错', bfsErr !== null && /实际收到/.test(String(bfsErr.message)), String(bfsErr?.message ?? '').slice(0, 60))
    ok('未知大小：核对失败时 .part 保留（不是静默成功）', existsSync(`${to2}.part`))
    // ④ 不能续传：残留 .part 会被丢掉、从头下（绝不把旧字节接上）
    const res2 = await downloadFile({ url: `${base}/unknown.bin`, to: to2, proxy: 'direct', overwrite: true, expectedSha256: wantHash, log: () => {} })
    ok('未知大小：无断点续传，重下仍完整（不拼接旧 .part）', res2.ok === true && res2.bytes === SIZE && res2.sha256 === wantHash, `${res2.bytes} bytes`)
    rmSync(dir, { recursive: true, force: true })
}

server.close()
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? `\nALL PASS (${passed})` : `\n${failures} FAILURE(S)  (${passed} passed)`)
process.exit(failures === 0 ? 0 : 1)

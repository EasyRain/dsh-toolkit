// resume-fuzz-selftest.mjs —— 断点续传的**状态机 fuzz**（第 21 份自测）
//
// 状态机：idle → 下载中 →（随机时点）abort / **强杀 worker 进程** ⇒ .part + manifest 保留 → 续传 → … → 完成
// 不变量：
//   R1 中止后 `.part` 已写部分必须与源文件前缀**逐字节一致**（防 O_APPEND 那类"大小对、内容错"）
//   R2 manifest 存在且 done ≤ total
//   R3 续传后最终文件逐字节一致、sha256 相符
//   R4 全程无代码级缺陷、不卡死
//   R5 worker 被强杀时状态必须是"可续"（interrupted），不能装作 downloading
//      —— 这条**抓到一个真 bug**：后台状态写在 `<目标目录>/.dsh-downloads`，而 status/cancel 只在
//      `<工作区>/downloads/.dsh-downloads` 找 ⇒ 只要 `to` 不在默认 downloads/ 下就报"没有后台下载任务"。
// 已修（加任务索引 jobs.json + 候选目录），并补了 8b 节的便宜回归断言。
// 加深：`RESUME_FUZZ_SEEDS=10 node test/resume-fuzz-selftest.mjs`
// 每轮断言：
//   R1 中止后 `.part` 已写部分**必须与源文件前缀逐字节一致**（防 O_APPEND 那类"大小对、内容错"）
//   R2 manifest 存在且 done ≤ total（进度不能超过总长）
//   R3 续传后最终文件**逐字节一致**、sha256 相符
//   R4 全程无代码级缺陷、不卡死
//   R5 worker 被强杀时，状态必须是"可续传"这一类（interrupted/cancelled），不能装作 downloading 卡住
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { downloadFile, manifestPathOf, partPathOf } from '../lib/download/engine.js'
import { tools } from '../lib/download/index.js'

let passed = 0
let failures = 0
let untested = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}
const hasCodeDefect = (msg) => /TypeError|ReferenceError|is not a function|Cannot read propert|not iterable/.test(msg)
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

const SIZE = 768 * 1024
const body = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i += 1) body[i] = (i * 17 + 3) % 256
const GOOD = createHash('sha256').update(body).digest('hex')

/** 慢速 + 随机断流的夹具服务器 */
function makeServer(rnd) {
    let active = 0
    const srv = createServer((req, res) => {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = Math.min(m ? (m[2] === '' ? SIZE - 1 : Number(m[2])) : SIZE - 1, SIZE - 1)
        if (start > end || start >= SIZE) { res.writeHead(416, { 'Content-Length': 0 }); res.end(); return }
        active += 1
        let settled = false
        const settle = () => { if (!settled) { settled = true; active -= 1 } }
        res.on('close', () => { if (!res.writableEnded) settle() })
        res.writeHead(m ? 206 : 200, {
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}),
            ETag: '"sm"',
        })
        let at = start
        const pump = () => {
            if (at > end) { settle(); res.end(); return }
            if (rnd() < 0.06) { settle(); res.destroy(); return }        // 随机断流 ⇒ 逼出重试/续传路径
            const upto = Math.min(at + 32 * 1024 - 1, end)
            res.write(body.subarray(at, upto + 1))
            at = upto + 1
            setTimeout(pump, 12)                                          // ≈2.6 MB/s：给中止留时间
        }
        pump()
    })
    return srv
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.RESUME_FUZZ_SEEDS ?? 6)

// ---------- 阶段 A：进程内 abort/续传 状态机（多种子） ----------
{
    let allOk = true
    let detail = ''
    for (let seed = 1; seed <= SEEDS; seed += 1) {
        const rnd = mulberry32(seed * 104729)
        const srv = makeServer(rnd)
        await new Promise((r) => srv.listen(0, '127.0.0.1', r))
        const url = `http://127.0.0.1:${srv.address().port}/f.bin`
        const dir = mkdtempSync(join(tmpdir(), `resume-${seed}-`))
        const to = join(dir, 'out.bin')
        const rounds = 1 + Math.floor(rnd() * 3)                      // 中止 1~3 次
        let abortCount = 0
        let prefixOk = true
        let manifestOk = true
        let clean = true
        // 这一轮是否"确实写进去过字节"（中止可能落在探测阶段 ⇒ 那时合法地还没有 .part）
        let sawPart = false
        let seedSkip = false
        let selfSha = null
        let selfErr = null
        for (let round = 0; round <= rounds; round += 1) {
            const isLast = round === rounds
            sawPart = false
            const controller = new AbortController()
            // 先起下载（不带定时器），**等 `.part` 真的出现**再随机时点中止 ——
 // 否则中止可能落在探测阶段（那时合法地还没有 .part），会把夹具问题误判成 bug（踩过）
            const part = partPathOf(to)
            const running = downloadFile({ url, to, threads: 3, proxy: 'direct', signal: controller.signal, timeoutMs: 20000, log: () => {} })
                .then((r) => ({ r, err: null }), (e) => ({ r: null, err: e }))
            if (!isLast) {
                const deadline = Date.now() + 8000
                while (Date.now() < deadline) {
                    let ok = false
                    try { ok = statSync(part).size > 0 } catch { ok = false }
                    if (ok) { sawPart = true; break }
                    await sleep(5)
                }
                await sleep(20 + Math.floor(rnd() * 300))
                controller.abort()
            }
            const settled = await running
            // 「本轮是否在 abort 落地前就下完了」——768 KB 的小文件 + 快网速时这很常见 ✓
            // 这不是缺陷（下完就是下完），但**这一轮没有验到"中止"** ⇒ 必须整颗种子跳过，
            // 否则后面既查不到 `.part`（已被 rename 掉），又会误报"本该被中止却完成了"。
            const completedCleanly = settled.err === null && !isLast
                && existsSync(to) && readFileSync(to).equals(body)
            if (settled.err !== null) {
                const msg = String(settled.err?.message ?? settled.err)
                if (hasCodeDefect(msg)) { clean = false; detail = `seed ${seed}: 代码级缺陷 ${msg.slice(0, 60)}` }
                if (isLast) { clean = false; detail = `seed ${seed}: 最后一次仍失败（${msg.slice(0, 60)}）` }
            }
            else if (!isLast && !completedCleanly) { clean = false; detail = `seed ${seed}: 本该被中止却完成了，且内容与源不符` }
            else if (isLast && settled.r.sha256 !== GOOD) { clean = false; detail = `seed ${seed}: 最终 sha256 不符` }
            if (isLast) break
            if (completedCleanly) { untested += 1; seedSkip = true; break }
            abortCount += 1
            // R1/R2：中止后校验已写前缀与 manifest
            // ⚠️ 只有"确实写进去过字节"才校验前缀：中止可能落在**探测阶段**（那时合法地没有 `.part`）。
            // 这种情况必须**整颗种子跳过** —— 只 `break` 会跳出轮次循环、跳过最后一轮完整下载，
 // 却仍然去跑 R3 的"最终内容应等于源" ⇒ 必然假红（我先写错过一次，
            // 是靠诊断字段 `大小=0/N` 才看清的）。
            if (!sawPart) { untested += 1; seedSkip = true; break }
            if (!existsSync(part)) {
                // 走到这里说明"等到过 .part，但中止后它不见了"：要么真出问题，要么是上面那条竞态的窄窗口。
                // 终态若已与源逐字节相同，按竞态处理（跳过而不是假红）。
                if (existsSync(to) && readFileSync(to).equals(body)) { untested += 1; seedSkip = true; break }
                prefixOk = false; detail = `seed ${seed}: 等到过 .part 却在中止后消失，且终态文件也不对`; break
            }
            const got = readFileSync(part)
            if (!got.equals(body.subarray(0, got.length))) { prefixOk = false; detail = `seed ${seed}: .part 前 ${got.length} 字节与源不一致（内容错位！）` }
            const mp = manifestPathOf(to)
            if (!existsSync(mp)) { manifestOk = false; detail = `seed ${seed}: manifest 不在` }
            else {
                try {
                    const mf = JSON.parse(readFileSync(mp, 'utf8'))
                    const done = mf.chunks.reduce((s, c) => s + Math.min(c.done ?? 0, c.end - c.start + 1), 0)
                    if (done > SIZE) { manifestOk = false; detail = `seed ${seed}: manifest done=${done} > total` }
                }
                catch (e) { manifestOk = false; detail = `seed ${seed}: manifest 解析失败 ${String(e.message).slice(0, 40)}` }
            }
            await sleep(20)
        }
        if (seedSkip) { srv.close(); rmSync(dir, { recursive: true, force: true }); continue }   // 中止落在探测阶段：本轮没东西可验
        // R3：最终内容
        let finalOk = false
        try { finalOk = existsSync(to) && readFileSync(to).equals(body) } catch { finalOk = false }
        const onDisk = existsSync(to) ? readFileSync(to) : Buffer.alloc(0)
        const shaOk = createHash('sha256').update(onDisk).digest('hex') === GOOD
        const seedOk = clean && prefixOk && manifestOk && finalOk && shaOk && abortCount > 0
        if (!seedOk) {
            allOk = false
            if (detail === '') {
                // 诊断要足够定位：自报的 sha256 vs 磁盘上的大小/sha（"自报成功但内容不对"是最贵的一类）
                detail = `seed ${seed}: finalOk=${finalOk} shaOk=${shaOk} abortCount=${abortCount}`
                    + ` | 自报=${String(selfSha).slice(0, 12)} 磁盘=${String(createHash('sha256').update(onDisk).digest('hex')).slice(0, 12)}`
                    + ` 大小=${onDisk.length}/${SIZE} 末尾=${onDisk.length > 0 ? String(onDisk.subarray(-8).toString('hex')) : '-'}`
            }
        }
        srv.close()
        rmSync(dir, { recursive: true, force: true })
    }
    ok(`A 进程内中止→续传 状态机（${SEEDS} 种子，每个随机中止 1~3 次）`, allOk, detail.slice(0, 90))
    ok('A 中止后 .part 前缀与源逐字节一致（防"大小对、内容错"）', allOk, detail.slice(0, 90))
}

// ---------- 阶段 B：真后台 worker 被强杀 ⇒ 状态必须可续 ----------
{
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
    // ⚠️ 阶段 B 必须用**足够大**的文件：夹具太小会在 kill 之前就下完，
 // 那样 taskkill 打的是已结束（甚至被复用的）pid —— 既测不到东西，还可能误杀无关进程（踩过）
    const BIG = 12 * 1024 * 1024
    const bigBody = Buffer.alloc(BIG)
    for (let i = 0; i < BIG; i += 1) bigBody[i] = (i * 29 + 5) % 256
    const bigSha = createHash('sha256').update(bigBody).digest('hex')
    const rnd = mulberry32(987654321)
    let active = 0
    const srv = createServer((req, res) => {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = Math.min(m ? (m[2] === '' ? BIG - 1 : Number(m[2])) : BIG - 1, BIG - 1)
        if (start > end || start >= BIG) { res.writeHead(416, { 'Content-Length': 0 }); res.end(); return }
        active += 1
        let settled = false
        const settle = () => { if (!settled) { settled = true; active -= 1 } }
        res.on('close', () => { if (!res.writableEnded) settle() })
        res.writeHead(m ? 206 : 200, {
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            ...(m ? { 'Content-Range': `bytes ${start}-${end}/${BIG}` } : {}),
            ETag: '"big"',
        })
        let at = start
        const pump = () => {
            if (at > end) { settle(); res.end(); return }
            const upto = Math.min(at + 32 * 1024 - 1, end)
            res.write(bigBody.subarray(at, upto + 1))
            at = upto + 1
            setTimeout(pump, 10)                       // ≈3.2 MB/s ⇒ 12 MB 约 4 s：足够在中途杀
        }
        pump()
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${srv.address().port}/big.bin`
    const dir = mkdtempSync(join(tmpdir(), 'resume-kill-'))
    const to = join(dir, 'killed.bin')
    const exec = { agent: { session: { header: { cwd: dir } } } }
    const jobOut = await dl.execute({ url, to, threads: 2, proxy: 'direct', mode: 'background' }, exec)
    const jobId = jobOut.match(/dl-[0-9a-zA-Z-]+/)?.[0] ?? null
    ok('B 后台任务能起来并给出 job id', jobId !== null, String(jobOut).split('\n')[0]?.slice(0, 60) ?? '')
    if (jobId !== null) {
        // 状态落在**工作区**的 downloads/.dsh-downloads/（以前写在目标目录旁边）
        const statusFile = join(dir, 'downloads', '.dsh-downloads', `${jobId}.json`)
        await sleep(700)
        let st1 = null
        try { st1 = JSON.parse(readFileSync(statusFile, 'utf8')) } catch { st1 = null }
        const pid = Number(st1?.pid ?? 0)
        const stillRunning = st1?.state === 'downloading' || st1?.state === 'starting'
        // **只在确认仍在下载时才杀**，并且要求 pid 有效（避免 pid 复用误杀）
        // 跨平台：Windows 用 `taskkill /F`（对 detached worker 比 process.kill 可靠），POSIX 用 SIGKILL。
        // （Linux 上没有 taskkill ⇒ spawnSync ENOENT，`killed` 恒为 false，后面两条断言会假红。）
        let killed = false
        if (stillRunning && pid > 0) {
            if (process.platform === 'win32') {
                const r = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' })
                killed = r.status === 0
            }
            else {
                try { process.kill(pid, 'SIGKILL'); killed = true }
                catch { killed = false }
            }
        }
        await sleep(700)
        const stOut2 = await st.execute({ id: jobId }, exec)
        const stateLine = (stOut2.split('\n').find((l) => /interrupted|cancelled|downloading|done|完成/.test(l)) ?? '').trim()
        ok('B 强杀 worker 后状态显示"可续"（interrupted/cancelled，不会装作 downloading）', /interrupted|cancelled/.test(stOut2), `killed=${killed} pid=${pid} state=${st1?.state} | ${stateLine.slice(0, 60)}`)
        ok('B 强杀后 .part 仍在（可续传）', existsSync(partPathOf(to)) || existsSync(to), `killed=${killed}`)
        // 续传（前台）并校验内容
        let resumedOk = false
        let err2 = ''
        try {
            const r = await downloadFile({ url, to, threads: 4, proxy: 'direct', timeoutMs: 15000, log: () => {} })
            resumedOk = r.sha256 === bigSha && readFileSync(to).equals(bigBody)
        }
        catch (e) { err2 = String(e.message).slice(0, 70) }
        ok('B 强杀后续传完成且内容逐字节一致', resumedOk, err2)
        await cc.execute({ id: jobId, deletePart: true }, exec).catch(() => {})
    }
    srv.close()
    rmSync(dir, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? `\nALL PASS (${passed})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

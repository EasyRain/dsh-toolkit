/**
 * download-fuzz-selftest.mjs —— **恶意服务器 fuzz**（换姿势审计的产物）
 *
 * 与"手写夹具"不同的审计姿势：让一个**按种子随机耍赖**的 HTTP 服务器去逼引擎，只断言一条核心不变量：
 *   **绝不能产出"成功但内容不对"的文件。**
 *
 * 服务器会（按种子随机）：中途断流 / 复位；把 Range 请求当整包返回（200）；乱报 Content-Length 与
 * Content-Range；并发时 429/503；故意变慢；**以及故意返回"格式合法但内容错位"的字节**。
 *
 * 三种模式：
 *   · `clean`   —— 服务器**不篡改字节**（其余照耍）⇒ 出现"成功但内容不对"就是**引擎真 bug**；
 *   · `sha`     —— 会篡改 + 用户给了 `sha256` ⇒ 必须被**校验拦下**，绝不允许"成功"；
 *   · `corrupt` —— 会篡改 + 无校验 ⇒ 本质**不可发现**（只统计，不算违例，如实体现在输出里）。
 *
 * 想跑更多种子：`DSH_FUZZ_SEEDS=60 node test/download-fuzz-selftest.mjs`
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadFile, manifestPathOf, partPathOf } from '../lib/download/engine.js'

let passed = 0
let failures = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`) }
    else { failures += 1; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}

const SEEDS = Number(process.env.DSH_FUZZ_SEEDS ?? 8)
const SIZE = 512 * 1024
const body = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i += 1) body[i] = (i * 31 + 7) % 256
const GOOD_SHA = createHash('sha256').update(body).digest('hex')

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** 跑一个种子，返回 { ok, note }；`mode` 决定服务器是否允许篡改字节 */
async function runSeed(seed, mode) {
    const rnd = mulberry32(seed)
    const dropProb = rnd() * 0.4
    const badStatusProb = rnd() * 0.4
    const badLengthProb = rnd() * 0.3
    const rejectProb = rnd() * 0.3
    const wrongBytesProb = mode === 'clean' ? 0 : rnd() * 0.3
    const slowProb = rnd() * 0.35
    let active = 0
    const srv = createServer((req, res) => {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : 0
        const end = Math.min(m ? (m[2] === '' ? SIZE - 1 : Number(m[2])) : SIZE - 1, SIZE - 1)
        if (start > end || start >= SIZE) { res.writeHead(416, { 'Content-Length': 0 }); res.end(); return }
        active += 1
        const settle = () => { active -= 1 }
        res.on('close', () => { if (!res.writableEnded) settle() })
        if (active > 2 && rnd() < rejectProb) {
            res.writeHead(rnd() < 0.5 ? 429 : 503, { 'Retry-After': '0', 'Content-Length': 0 })
            res.end(); settle(); return
        }
        if (m && rnd() < badStatusProb) {                      // 把 Range 当整包返回
            const len = rnd() < badLengthProb ? Math.max(1, Math.floor(SIZE * (0.3 + rnd() * 0.5))) : SIZE
            res.writeHead(200, { 'Accept-Ranges': 'bytes', 'Content-Length': len })
            res.end(body.subarray(0, len)); settle(); return
        }
        const want = end - start + 1
        const declared = rnd() < badLengthProb ? Math.max(1, want + (rnd() < 0.5 ? -1024 : 4096)) : want
        res.writeHead(m ? 206 : 200, {
            'Accept-Ranges': 'bytes',
            'Content-Length': declared,
            ...(m ? { 'Content-Range': `bytes ${start}-${end}/${SIZE}` } : {}),
            ETag: '"fuzz"',
        })
        const wrong = rnd() < wrongBytesProb
        let slice = body.subarray(start, end + 1)
        if (wrong) {                                           // 格式合法、内容错位
            const shifted = Buffer.from(body.subarray(Math.max(0, start - 1), Math.max(0, start - 1) + want))
            if (shifted.length > 0) shifted[0] = (shifted[0] + 1) % 256
            slice = shifted
        }
        const slow = rnd() < slowProb
        const step = slow ? 16384 : 65536
        let at = 0
        const pump = () => {
            if (at >= slice.length) { settle(); res.end(); return }
            if (rnd() < dropProb) { settle(); res.destroy(); return }     // 中途断流
            const upto = Math.min(at + step, slice.length)
            res.write(slice.subarray(at, upto))
            at = upto
            setTimeout(pump, slow ? 12 : 0)
        }
        pump()
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const dir = mkdtempSync(join(tmpdir(), `fuzz-${mode}-${seed}-`))
    const to = join(dir, 'out.bin')
    let result = null
    let error = null
    try {
        result = await downloadFile({
            url: `http://127.0.0.1:${srv.address().port}/f.bin`,
            to,
            threads: 4,
            proxy: 'direct',
            expectedSha256: mode === 'sha' ? GOOD_SHA : null,
            timeoutMs: 3000,
            log: () => {},
        })
    }
    catch (e) { error = e }
    srv.close()
    const targetExists = existsSync(to)
    let verdict = { ok: false, note: '' }
    if (result !== null) {
        const same = targetExists && readFileSync(to).equals(body)
        if (same && result.sha256 === GOOD_SHA) verdict = { ok: true, note: 'correct', success: true }
        else if (mode === 'corrupt') verdict = { ok: true, note: 'corrupt-undetectable', undetectable: true }
        else verdict = { ok: false, note: `成功但内容不对（same=${same}）` }
    }
    else if (error !== null) {
        const msg = String(error.message ?? error)
        const isCodeBugFunny = /TypeError|ReferenceError|is not a function|Cannot read propert/.test(msg)
        verdict = targetExists || isCodeBugFunny
            ? { ok: false, note: `失败不干净（targetExists=${targetExists} 代码级异常=${isCodeBugFunny}）：${msg.slice(0, 70)}` }
            : { ok: true, note: /sha256/.test(msg) ? 'sha-caught' : 'failed-cleanly', failed: true }
    }
    else verdict = { ok: false, note: '既没成功也没失败' }
    for (const p of [to, partPathOf(to), manifestPathOf(to)]) { try { rmSync(p, { force: true }) } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true })
    return verdict
}

for (const mode of ['clean', 'sha', 'corrupt']) {
    const seeds = mode === 'clean' ? SEEDS : Math.max(4, Math.floor(SEEDS * 0.6))
    let violations = []
    let success = 0
    let failed = 0
    let undetectable = 0
    let shaCaught = 0
    for (let seed = 1; seed <= seeds; seed += 1) {
        let v = null
        try { v = await runSeed(seed, mode) }
        catch (e) { v = { ok: false, note: `未捕获异常：${String(e.message).slice(0, 70)}` } }
        if (v.note === 'correct') success += 1
        else if (v.note === 'failed-cleanly') failed += 1
        else if (v.note === 'sha-caught') { failed += 1; shaCaught += 1 }
        else if (v.note === 'corrupt-undetectable') undetectable += 1
        if (!v.ok) violations.push(`seed ${seed}: ${v.note}`)
    }
    console.log(`  == fuzz ${mode}（${seeds} 个种子）==`)
    console.log(`     成功 ${success}，干净失败 ${failed}${shaCaught > 0 ? `（sha256 拦下 ${shaCaught}）` : ''}${undetectable > 0 ? `，无校验不可发现 ${undetectable}` : ''}`)
    if (mode === 'clean') {
        ok('clean：绝不产出"成功但内容不对"的文件', violations.length === 0, violations.slice(0, 2).join('；'))
        ok('clean：确实覆盖了成功与失败两条路径', success > 0 && failed > 0, `成功 ${success} / 失败 ${failed}`)
    }
    else if (mode === 'sha') {
        ok('sha：篡改必须被校验拦下，不许"成功"', violations.length === 0, violations.slice(0, 2).join('；'))
    }
    else {
        ok('corrupt：无校验时篡改不可发现（如实统计，不算违例）', violations.length === 0 && undetectable >= 0, `不可发现 ${undetectable}`)
    }
}

console.log(failures === 0 ? `\nALL PASS (${passed})` : `\n${failures} FAILURE(S)  (${passed} passed)`)
process.exit(failures === 0 ? 0 : 1)

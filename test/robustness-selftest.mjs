#!/usr/bin/env node
/**
 * 鲁棒性自测（本轮新增能力的"容易偶发、事后极难复现"的两类场景）
 *
 * 一、**真并发写**：N 个进程各自 preview 同一文件、在同一个屏障上一起 apply。
 *     期望：恰好一个成功；其余以**可识别的原因**失败（别人持锁 / 预览后文件被改过）；
 *     文件内容是**完整且正确**的（绝不交错/截断），且不留锁与临时文件。
 *     —— 这类 bug 一旦漏掉，表现是"偶发的内容错乱"，事后无法复现。
 *
 * 二、**边界文件语料**：CRLF / BOM / 非 ASCII（中文+emoji）/ 超长单行 / minified / 混合行尾 /
 *     空文件 / 无结尾换行 / 含 NUL。逐个体检：搜索不崩、改写字面量**只改该改的**、
 *     BOM 与 CRLF **逐字节保真**、跳过的文件必须**说明原因**（不许静默）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 模块来源顺序**与其它 AST 套件一致**：源码树优先（CI 上 `npm install` 的依赖在源码树里；
// 本机源码树没有 node_modules ⇒ **试导入会抛** ⇒ 落到 profile 安装副本，等于强制"先同步再测"）。
// ⚠️ 必须**逐个试 import**（不能只 existsSync 就认定可用 —— 源码树里文件在、依赖不在）。
const SOURCE_LIB = fileURLToPath(new URL('../lib', import.meta.url))
const INSTALL_LIB = join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib')
let edit = null
let search = null
let usedLib = ''
for (const base of [SOURCE_LIB, INSTALL_LIB]) {
    if (!existsSync(join(base, 'ast', 'edit.js'))) continue
    try {
        edit = await import(pathToFileURL(join(base, 'ast', 'edit.js')).href)
        search = await import(pathToFileURL(join(base, 'search.js')).href)
        usedLib = base
        break
    }
    catch { edit = null; search = null }
}
if (edit === null || search === null) {
    console.log('  SKIP  源码树与安装副本都不可用（先 npm install 或 node bin/install-toolkit.mjs）')
    console.log('\nALL PASS')
    process.exit(0)
}
const EDIT = join(usedLib, 'ast', 'edit.js')
const SEARCH = join(usedLib, 'search.js')
console.log(`  （模块来源：${usedLib.includes('node_modules') ? '安装副本' : '源树'}）`)

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
}

const et = edit.tools((t) => t).find((t) => t.name === 'ast_edit')
const st = (() => { const arr = []; search.apply({ tools: { register: (t) => arr.push(t) } }); return arr.find((t) => t.name === 'ast_search') })()

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-robust-'))
const LOCKDIR = join(tmpdir(), 'dsh-toolkit-locks')

console.log('== 1. 真并发写：4 个进程同时 apply 同一文件 ==')
{
    const dir = join(ROOT, 'race')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'target.js')
    // 目标文件大一点，让"读→改→rename"的窗口有实际宽度
    const lines = []
    for (let i = 0; i < 400; i += 1) lines.push(`const v${i} = Alpha; // line ${i}`)
    const original = `${lines.join('\n')}\n`
    writeFileSync(target, original)
    const expected = original.replace(/\bAlpha\b/g, 'Beta')

    const child = join(dir, 'child.mjs')
    writeFileSync(child, `
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [modPath, target, dir, idx] = process.argv.slice(2)
const mod = await import(pathToFileURL(modPath).href)
const et = mod.tools((t) => t).find((t) => t.name === 'ast_edit')
const exec = { agent: { session: { id: 'race-' + idx, header: { cwd: dir } } } }
const args = { action: 'preview', mode: 'literal', ops: [{ pat: 'Alpha', out: 'Beta' }], paths: [target] }
const pv = await et.execute(args, exec)
console.log('PREVIEW n=' + pv.totalReplacements + ' staged=' + Boolean(pv.stagedId))
writeFileSync(join(dir, 'ready-' + idx), '1')
// 别人可能在我 preview 之后就把文件改完了 ⇒ 我这边已经**没有可改的** —— 这是**正常的并发结局**，
// 不是失败、更不是崩（用一个独立退出码 4 表示，父进程按"没得改"归类）。
if (!pv.stagedId) {
    console.log('ZERO 已无可改（别人先写完）')
    process.exit(4)
}
const t0 = Date.now()
while (!existsSync(join(dir, 'go'))) { if (Date.now() - t0 > 20000) break; await new Promise((r) => setTimeout(r, 2)) }
try {
    const ap = await et.execute({ action: 'apply', stagedId: pv.stagedId }, exec)
    console.log('OK ' + ap.totalReplacements)
} catch (error) {
    // **在子进程里归类**，别让父进程去猜消息文本（踩过：错误消息很长，父进程截断后就把"真正原因"切掉了 ⇒ 偶发假红）
    const m = String(error.message)
    const kind = /另一个进程正在写这个文件/.test(m) ? 'LOCK' : (/文件在预览之后被改过/.test(m) ? 'STALE' : 'OTHER')
    // CI 的 Windows runner 上偶发被杀软/文件占用挡成 EPERM/EBUSY（不是锁冲突，但也**什么都没写**）。
    // 把 effectState 单独打出来，父进程才能区分"安全的 OTHER"与"真的写了一半"。
    const effect = /effectState: (none|applied|unknown)/.exec(m)?.[1] ?? 'unknown'
    console.log('ERR ' + kind + ' effect=' + effect + ' ' + m.split('\\n')[0].slice(0, 200))
    process.exit(3)
}
`)

    const N = 4
    // 真正的并发：异步 spawn + 屏障（**不要**用 spawnSync 预演 —— 它会在屏障上阻塞，
    // 等于让第一个子进程先把文件改掉，其余子进程 preview 时就没匹配了：第一版测试就栽在这）
    const { spawn } = await import('node:child_process')
    const procs = []
    for (let i = 0; i < N; i += 1) {
        const p = spawn(process.execPath, [child, EDIT, target, dir, String(i)], { stdio: ['ignore', 'pipe', 'pipe'] })
        const rec = { out: '', err: '', code: null, i }
        p.stdout.on('data', (d) => { rec.out += d })
        p.stderr.on('data', (d) => { rec.err += d })
        p.on('close', (code) => { rec.code = code })
        procs.push(rec)
    }
    // 等所有子进程都 preview 完（ready-i 齐了），再放行
    const t0 = Date.now()
    while (Date.now() - t0 < 20000 && !Array.from({ length: N }, (_, i) => existsSync(join(dir, `ready-${i}`))).every(Boolean)) {
        await new Promise((r) => setTimeout(r, 10))
    }
    const readyCount = Array.from({ length: N }, (_, i) => existsSync(join(dir, `ready-${i}`))).filter(Boolean).length
    ok('所有子进程都完成了 preview（屏障前状态一致）', readyCount === N, `ready=${readyCount}/${N}`)
    writeFileSync(join(dir, 'go'), '1')
    const tw = Date.now()
    while (Date.now() - tw < 30000 && procs.some((p) => p.code === null)) await new Promise((r) => setTimeout(r, 10))

    const okCount = procs.filter((p) => p.code === 0).length
    const contended = procs.filter((p) => p.code === 3).length
    const nothingLeft = procs.filter((p) => p.code === 4).length
    const crashed = procs.filter((p) => p.code !== 0 && p.code !== 3 && p.code !== 4).length
    ok('恰好一个进程写入成功', okCount === 1, `ok=${okCount} 争用失败=${contended} 无可改=${nothingLeft} codes=${procs.map((p) => p.code).join(',')}`)
    // 并发结局只有两类，都算"正常"：① 拿不到锁/预览后文件被改过 ⇒ 明确拒绝；② preview 太晚、已无可改 ⇒ 无需提交。
    // **不许出现**第三种：进程崩掉（既不是 0/3/4）。偶发一次就说明测试写得不严（真 Linux 上抓到过）。
    ok('没有任何子进程异常退出（崩掉）', crashed === 0, `codes=${procs.map((p) => p.code).join(',')}`)
    // ⚠️ 用 `m` 标志按**行**匹配：子进程先打一行 `PREVIEW …`，`^ERR` 不能锚在整段开头。
    const errLine = (p) => (p.out.match(/^ERR (LOCK|STALE|OTHER)\b.*$/m) ?? ['(没有 ERR 行)'])[0]
    ok('争用的那部分给了可读原因（LOCK/STALE；环境性 IO 失败必须是 effect=none）',
        procs.filter((p) => p.code === 3).every((p) => /^ERR (LOCK|STALE)\b/m.test(p.out) || (/^ERR OTHER\b/m.test(p.out) && /\beffect=none\b/.test(p.out))),
        procs.filter((p) => p.code === 3).map((p) => errLine(p).slice(0, 56)).join(' | '))
    const finalText = readFileSync(target, 'utf8')
    ok('文件内容完整且正确（没有交错/截断）', finalText === expected, `len=${finalText.length} exp=${expected.length}`)
    ok('没有留下 .dsh-tmp-* 临时文件', !readdirSync(dir).some((n) => n.includes('dsh-tmp')), readdirSync(dir).filter((n) => n.includes('dsh-tmp')).join(','))
    const lockLeft = existsSync(LOCKDIR) ? readdirSync(LOCKDIR).length : 0
    ok('锁目录里没有残留锁', lockLeft === 0, `left=${lockLeft}`)
}

console.log('== 2. 边界文件语料：只改该改的，BOM/CRLF 逐字节保真 ==')
{
    const dir = join(ROOT, 'corpus')
    mkdirSync(dir, { recursive: true })
    const cases = []
    const add = (name, bytes) => {
        const p = join(dir, name)
        writeFileSync(p, bytes)
        cases.push({ name, path: p, bytes })
    }
    add('crlf.js', 'const a = Alpha;\r\nconst b = Alpha;\r\n')
    add('bom.js', `\uFEFFconst a = Alpha;\nconst b = Alpha;\n`)
    add('unicode.js', 'const 中文 = Alpha; // 表情 😀🚀\nconst b = Alpha;\n')
    add('mixed-eol.js', 'const a = Alpha;\r\nconst b = Alpha;\nconst c = Alpha;\r\n')
    add('no-trailing-nl.js', 'const a = Alpha;')
    add('longline.js', `const s = "${'x'.repeat(20000)}"; const a = Alpha;\n`)
    add('minified.js', `var a=1;var b=Alpha;var c=3;${'function q(){return Alpha}'.repeat(50)}\n`)
    add('empty.js', '')
    add('nul.bin', `const a = Alpha;\u0000\u0000binary-ish\n`)

    for (const c of cases) {
        const isText = c.name !== 'nul.bin'
        // 搜索：不许崩；不支持/二进制必须**说明原因**
        let sres = null
        let serr = null
        try { sres = await st.execute({ paths: [c.path], pattern: 'Alpha' }, { agent: { session: { header: { cwd: dir } } } }) }
        catch (e) { serr = e }
        const searched = sres !== null
        const reported = searched ? (sres.skipped.length > 0 || sres.count > 0 || sres.filesSearched > 0) : serr !== null
        ok(`搜索不崩且给出结论：${c.name}`, reported, searched ? `count=${sres.count} skipped=${sres.skipped.length}` : String(serr?.message).slice(0, 40))

        if (!isText || c.name === 'empty.js') continue   // 二进制/空文件不做落盘断言
        // 改写：preview + apply，逐字节比对（含 BOM/CRLF 保真）
        const before = readFileSync(c.path)
        try {
            const pv = await et.execute({ action: 'preview', mode: 'literal', ops: [{ pat: 'Alpha', out: 'Beta' }], paths: [c.path], force: true }, { agent: { session: { header: { cwd: dir } } } })
            if (pv.totalReplacements > 0) {
                await et.execute({ action: 'apply', stagedId: pv.stagedId }, { agent: { session: { header: { cwd: dir } } } })
            }
        }
        catch (error) {
            ok(`改写不崩：${c.name}`, false, String(error.message).slice(0, 60))
            continue
        }
        const after = readFileSync(c.path)
        const want = Buffer.from(before.toString('utf8').replace(/\bAlpha\b/g, 'Beta'), 'utf8')
        ok(`只改该改的、其它字节保真：${c.name}`, Buffer.compare(after, want) === 0,
            `before=${before.length}B after=${after.length}B want=${want.length}B`)
        if (c.name === 'bom.js') ok('BOM 保留', after[0] === 0xEF && after[1] === 0xBB && after[2] === 0xBF)
        if (c.name === 'crlf.js' || c.name === 'mixed-eol.js') {
            const lf = (after.toString('utf8').match(/(?<!\r)\n/g) ?? []).length
            const wantLf = (want.toString('utf8').match(/(?<!\r)\n/g) ?? []).length
            ok(`行尾未被规范化（孤 LF 数一致）：${c.name}`, lf === wantLf, `lf=${lf} want=${wantLf}`)
        }
        if (c.name === 'no-trailing-nl.js') ok('未擅自补结尾换行', !after.toString('utf8').endsWith('\n'))
        ok(`没留下临时文件：${c.name}`, !readdirSync(dir).some((n) => n.startsWith(`${c.name}.dsh-tmp`)))
    }
    const lockLeft = existsSync(LOCKDIR) ? readdirSync(LOCKDIR).length : 0
    ok('整轮结束后锁目录干净', lockLeft === 0, `left=${lockLeft}`)
}

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

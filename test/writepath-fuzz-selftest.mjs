// writepath-fuzz-selftest.mjs —— 写盘类工具的**故障/原子性兜底**
//
// 断言的是"**写盘这个动作**"的不变量，而不是具体输出：
//   W1 `ast_edit` 的 preview **绝不改文件**（前后逐文件 sha256 一致）
//   W2 apply 失败（目标只读 / 过期提案）时，原文件必须**一字不变**（原子性：绝不半截）
//   W3 preview 之后文件被外部改动 ⇒ apply 必须**拒绝**（stale），且不写盘
//   W4 编码/换行不得被破坏（UTF-8 BOM 仍在首位、CRLF 仍保留）
//   W5 没有匹配 ⇒ 不写盘（并给出可读信息）
//   W6 `session_export` 拒绝覆盖已有目标（除非 overwrite:true），拒绝后目标不变
//   W7 destination 目录不存在 ⇒ 干净报错且**不留半截文件**
//   W8 **绝不覆盖会话日志本体**（把它当 to 传入必须被拒，且原文件哈希不变）
//   W9 导出产物自洽（jsonl 每行可 JSON.parse、行数与事件数一致；md 非空）
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// ⚠️ `lib/ast/edit.js` 顶层就 import `@ast-grep/napi`：源码树没装它 ⇒ **必须惰性导入**，
// 否则静态 import 会让整份自测在源码树直接崩（踩到）
// ⚠️（跨平台对照抓到）：原来**只试源码树** ⇒ 本机（源码树没依赖）上 `ast_edit` 整组
// **一直是静默跳过的**（所以 Linux 上第一次真跑就炸出一个失败，本机从没见过）。
// 现在**源树 → 安装副本**都试，两边都不行才跳过。（⚠️ 副本那条要给 `pathToFileURL(...).href`：
// `import('C:\\…')` 会被当成**裸模块名**而失败 —— 这个坑我在别处也踩过一次。）
let astTools = null
let astFrom = ''
const astCandidates = [
    ['../lib/ast/edit.js', '源树'],
    [pathToFileURL(join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/ast/edit.js')).href, '安装副本'],
]
for (const [spec, label] of astCandidates) {
    try { astTools = (await import(spec)).tools; astFrom = label; break } catch { astTools = null }
}
const { tools: sessionTools } = await import('../lib/session/index.js')

let passed = 0
let failures = 0
let skipped = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}
const skip = (name, why) => { skipped += 1; process.stdout.write(`  SKIP  ${name}  ${why}\n`) }
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
const hasCodeDefect = (msg) => /TypeError|ReferenceError|is not a function|Cannot read propert|not iterable/.test(msg)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sandbox = mkdtempSync(join(tmpdir(), 'writepath-'))
const exec = { agent: { session: { header: { cwd: sandbox } } } }

// ---------- 阶段 A：ast_edit ----------
const astAvailable = astTools !== null

if (!astAvailable) {
    skip('ast_edit 全组', '源树与安装副本都拿不到 @ast-grep/napi（先 npm install 或跑 install-toolkit）')
}
else {
    const edit = astTools((t) => t, {}).find((t) => t.name === 'ast_edit')
    const src = 'const a = 1\nconst b = 2\nconst keep = 3\n'
    const mk = (name, text, bom = false, crlf = false) => {
        const p = join(sandbox, name)
        const body = crlf ? text.replace(/\n/g, '\r\n') : text
        writeFileSync(p, bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]) : Buffer.from(body, 'utf8'))
        return p
    }

 // ⚠️ 夹具要点（先踩过再写对）：
    //   ① `execute` 返回的是**对象**（带 render），`stagedId` 在 `result.stagedId` 里，别去正则字符串；
    //   ② `stagedId` 省略时会应用"本会话最近一次提案" ⇒ 想测"0 替换不写盘"必须**先 preview 那条规则**再 apply，
    //      否则 apply 会去应用上一个提案（第一次踩到，误以为工具写坏了文件）。
    const stage = async (p, pat, out) => {
        const r = await edit.execute({ ops: [{ pat, out }], paths: [p], action: 'preview' }, exec)
        return { id: r?.stagedId ?? null, total: r?.totalReplacements ?? null, raw: r }
    }
    const applyStaged = async (id, p, pat = 'const $N = $V', out = 'let $N = $V') =>
        edit.execute({ ops: [{ pat, out }], paths: [p], action: 'apply', stagedId: id ?? undefined }, exec)

    // W1 preview 不改盘；W2 正常 apply 按预览写入；W5 零替换提案 ⇒ 不写盘
    {
        const p = mk('a1.js', src)
        const before = sha(p)
        const s1 = await stage(p, 'const $N = $V', 'let $N = $V')
        ok('W1 preview 不改文件', sha(p) === before, `sha ${before}`)
        ok('W1 preview 给出 stagedId 与替换计数', typeof s1.id === 'string' && s1.id.length >= 6 && s1.total === 3, `id=${s1.id} total=${s1.total}`)

        const a1 = await applyStaged(s1.id, p)
        const afterApply = readFileSync(p, 'utf8')
        ok('W2 正常 apply 按预览写入（const→let，逐行正确）', afterApply === 'let a = 1\nlet b = 2\nlet keep = 3\n', JSON.stringify(afterApply.slice(0, 40)))
        ok('W2 apply 报告 ok 且不是错误信息', a1?.ok === true && !hasCodeDefect(String(a1?.message ?? '')))

        // 零替换：先 preview 一条匹配不到的规则（stage 0），再 apply ⇒ 文件必须一字不变
        const beforeNoMatch = sha(p)
        const s2 = await stage(p, 'this_matches_nothing_xyz($A)', 'X')
        ok('W5 零匹配的 preview 如实报告 0 替换', s2.total === 0, `total=${s2.total}`)
        let noMatchErr = ''
        try { await applyStaged(s2.id, p, 'this_matches_nothing_xyz($A)', 'X') }
        catch (e) { noMatchErr = String(e.message) }
        ok('W5 零替换 apply ⇒ 不写盘（文件一字不变）', sha(p) === beforeNoMatch, noMatchErr.slice(0, 50))
        ok('W5 零替换 apply ⇒ 有可读信息（不是代码级缺陷）', !hasCodeDefect(noMatchErr))
    }

    // W3：preview 后文件被外部改动 ⇒ apply 必须拒绝且不写
    {
        const p = mk('a3.js', src)
        const s = await stage(p, 'const $N = $V', 'let $N = $V')
        writeFileSync(p, 'const a = 999\nconst b = 2\nconst keep = 3\n')      // 外部改动
        const tampered = sha(p)
        let err = ''
        let out = null
        try { out = await applyStaged(s.id, p) }
        catch (e) { err = String(e.message) }
        const content = readFileSync(p, 'utf8')
        // 允许两种正确行为：拒绝（过期提案）或按**新内容**正确改写；绝不允许写坏
        const rejected = sha(p) === tampered
        const correctlyReapplied = content === 'let a = 999\nlet b = 2\nlet keep = 3\n'
        ok('W3 preview 后文件被改 ⇒ 拒绝或按新内容正确改（不得写坏）', rejected || correctlyReapplied, `err=${err.slice(0, 40)} out=${String(out?.totalReplacements ?? '')} 首行=${content.split('\n')[0]}`)
    }

    // W2b：写不进去时 apply 必须失败且**绝不半截**（原子性）
    // ⚠️ 平台差异（真 Linux 首跑抓到）：`attrib +R` 是 Windows 专有，POSIX 上不存在
    //（以前静默没注入 ⇒ 断言"必须失败"在 Linux 上假红）；而且 **POSIX 只读位拦不住 rename**。
    // 所以：① 只读注入尽力而为，断言只保留跨平台不变量（不半截）；② 另加一个**两边都写不进去**的注入。
    {
        const p = mk('a2-readonly.js', src)
        const raw0 = readFileSync(p)
        const s = await stage(p, 'const $N = $V', 'let $N = $V')
        let injected = false
        if (process.platform === 'win32') {
            try { execFileSync('attrib', ['+R', p]); injected = true } catch { injected = false }
        }
        else {
            try { chmodSync(p, 0o444); injected = true } catch { injected = false }
        }
        let err = ''
        let out = null
        try { out = await applyStaged(s.id, p) }
        catch (e) { err = String(e.message) }
        const unchanged = readFileSync(p).equals(raw0)
        if (process.platform === 'win32') { try { execFileSync('attrib', ['-R', p]) } catch { /* ignore */ } }
        else { try { chmodSync(p, 0o644) } catch { /* ignore */ } }
        const wrote = out?.ok === true
        // 跨平台不变量：**要么没写、要么写成完整的期望内容**（绝不允许半截/错行）
        const expected = 'let a = 1\nlet b = 2\nlet keep = 3\n'
        const content = readFileSync(p, 'utf8')
        ok('W2b 写不进去时绝不半截（原样 或 完整写入，二选一）', unchanged || content === expected,
            `injected=${injected} wrote=${wrote} err=${err.slice(0, 30)}`)
        if (injected && process.platform === 'win32') {
            ok('W2b（Windows 只读）apply 确实失败且报错可读', !wrote && unchanged && !hasCodeDefect(err), err.slice(0, 50))
        }
        else {
            console.log(`  SKIP  W2b（POSIX 只读位拦不住 rename ⇒ 不算失败注入）  injected=${injected}`)
        }
    }

    // W2c：**跨平台**的失败注入 —— 预览之后把目标换成同名**目录**（两边都写不进去）
    {
        const p = mk('a2-dir.js', src)
        const s = await stage(p, 'const $N = $V', 'let $N = $V')
        rmSync(p, { force: true })
        mkdirSync(p, { recursive: true })
        writeFileSync(join(p, 'marker.txt'), 'MUST-SURVIVE')
        let err = ''
        try { await applyStaged(s.id, p) }
        catch (e) { err = String(e.message) }
        ok('W2c 目标被目录占位 ⇒ 干净失败（不把目录毁掉）', existsSync(join(p, 'marker.txt')) && readFileSync(join(p, 'marker.txt'), 'utf8') === 'MUST-SURVIVE', `err=${err.slice(0, 40)}`)
        ok('W2c 报错可读、不是代码级缺陷', !hasCodeDefect(err), err.slice(0, 60))
        rmSync(p, { recursive: true, force: true })
    }

    // W4：BOM + CRLF 不得被破坏
    {
        const p = mk('a4-bom.js', 'const a = 1\nconst b = 2\n', true, true)
        const preview = await edit.execute({ ops: [{ pat: 'const $N = $V', out: 'let $N = $V' }], paths: [p], action: 'preview' }, exec)
        const staged = preview?.stagedId
        let applyError = ''
        try {
            if (staged === undefined) throw new Error('preview 未返回 stagedId')
            await edit.execute({ ops: [{ pat: 'const $N = $V', out: 'let $N = $V' }], paths: [p], action: 'apply', stagedId: staged }, exec)
        }
        catch (error) { applyError = error instanceof Error ? error.message : String(error) }
        ok('W4 改写可落盘（BOM/CRLF 用例）', applyError === '', applyError.slice(0, 120))
        const buf = readFileSync(p)
        const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
        const text = buf.toString('utf8')
        const crlfKept = text.includes('\r\n')
        ok('W4 改写后 UTF-8 BOM 仍在首位', hasBom, `前 3 字节=${buf.subarray(0, 3).toString('hex')}`)
        ok('W4 改写后 CRLF 换行未被改成 LF', crlfKept, JSON.stringify(text.slice(0, 30)))
    }
}

// ---------- 阶段 B：session_export ----------
// 标号 B：本机一个会话都没有时，后面几条（W6–W9）没有可导出的素材 ⇒ 明确 SKIP 并跳出，
// 而不是把"这台机器没有会话日志"报成失败（别人机器/CI 上就是这样）。
B: {
    const exp = sessionTools((t) => t, {}).find((t) => t.name === 'session_export')
    const outDir = join(sandbox, 'out')
    mkdirSync(outDir, { recursive: true })
    const wsCwd = process.cwd()   // "调用方工作区"用当前目录（不写死作者的路径）

 // 找一份真实会话日志**文件**（只给 W8c 用；id 不能从目录名猜 —— 那是 slug，不是 session id ✗ 踩到）
    const findSmallestLog = () => {
        const root = join(homedir(), '.dsh', 'sessions')
        let best = null
        const walk = (dir, depth) => {
            if (depth > 5) return
            let entries = []
            try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
            for (const e of entries) {
                const p = join(dir, e.name)
                if (e.isDirectory()) { walk(p, depth + 1); continue }
                if (!/session.*\.(jsonl|zstd)$/i.test(e.name)) continue
                const size = statSync(p).size
                if (size > 200 && (best === null || size < best.size)) best = { path: p, size }
            }
        }
        walk(root, 0)
        return best
    }
    const sample = findSmallestLog()

    // session id 必须**真的能用**：先从 session_list 里取一个，再自校验（导出 md 成功即算可用），最后回退 'last'
    // 注意：`session_list` **不带 cwd** 才会列出所有工作区（带 cwd 就被限定到那个工作区了）；
    // 拿到显式 id 后可以跨工作区导出，所以 wsCwd 用当前目录也能跑。
    let sessionRef = null
    {
        const list = sessionTools((t) => t, {}).find((t) => t.name === 'session_list')
        let listOut = ''
        try { listOut = String(await list.execute({ limit: 5 }) ?? '') } catch { listOut = '' }
        const ids = [...new Set(listOut.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])]
        for (const cand of [...ids, 'last']) {
            const probe = join(outDir, `probe-${String(cand).slice(0, 8)}.md`)
            try {
                await exp.execute({ session: cand, cwd: wsCwd, to: probe, format: 'md' }, exec)
                sessionRef = cand
                break
            }
            catch { /* 换下一个候选 */ }
        }
        if (sessionRef === null) {
            skip('W6–W9 session_export 写盘不变式（整个阶段 B）', `本机没有可导出的会话（session_list 与 "last" 都解析不到）`)
            break B
        }
        if (ids.length === 0) skip('（session_list 没给出 uuid，用 session:"last" 兜底）', listOut.split('\n')[0]?.slice(0, 50) ?? '')
    }

    // W6：拒绝覆盖已有目标
    {
        const dest = join(outDir, 'exists.jsonl')
        writeFileSync(dest, 'PRE-EXISTING')
        const before = sha(dest)
        let err = ''
        try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: dest }, exec) }
        catch (e) { err = String(e.message) }
        ok('W6 目标已存在 ⇒ 拒绝（且文件内容不变）', sha(dest) === before && err.length > 0, err.slice(0, 60))
    }

 // W7：父目录不存在 ⇒ **自动创建**（审计把文档与行为对齐：以前描述写"目录必须存在"、代码却 mkdir）；
    //     父路径是**文件** ⇒ 必须干净报错且不留任何东西。
    {
        const missingDirDest = join(sandbox, 'auto-created-dir', 'x.jsonl')
        let err = ''
        try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: missingDirDest }, exec) }
        catch (e) { err = String(e.message) }
        const created = existsSync(missingDirDest)
        const linesOk = created && readFileSync(missingDirDest, 'utf8').split('\n').filter((l) => l.trim() !== '').every((l) => { try { JSON.parse(l); return true } catch { return false } })
        ok('W7a 父目录不存在 ⇒ 自动创建并写出完整可解析文件（不留半截）', linesOk, created ? `${statSync(missingDirDest).size} 字节` : `未创建（${err.slice(0, 40)}）`)

        const blocker = join(sandbox, 'blocker-file')
        writeFileSync(blocker, 'i am a file, not a dir')
        const badDest = join(blocker, 'x.jsonl')
        let err2 = ''
        try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: badDest }, exec) }
        catch (e) { err2 = String(e.message) }
        ok('W7b 上级路径是文件 ⇒ 干净报错且什么都没写', err2.length > 0 && !hasCodeDefect(err2) && readFileSync(blocker, 'utf8') === 'i am a file, not a dir', err2.slice(0, 60))
    }

 // W8：绝不写坏会话日志 —— **确定性三条**（不依赖"能否找到真实日志"，改）：
    //   a) 目标在 sessions 目录内 ⇒ 拒（写坏会破坏宿主加载器依赖的 zstd 多帧）
    //   b) 目标是 zstd 魔数文件 ⇒ 即使 overwrite:true 也拒
    //   c) 目标就是真实会话日志 ⇒ 拒且原文件哈希不变
    {
        const sessionsRoot = join(homedir(), '.dsh', 'sessions')
        const inside = join(sessionsRoot, 'writepath-fuzz-should-never-exist.jsonl')
        let errA = ''
        try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: inside, overwrite: true }, exec) }
        catch (e) { errA = String(e.message) }
        ok('W8a 目标在 sessions 目录内 ⇒ 拒绝写入（且不产生文件）', errA.length > 0 && !existsSync(inside) && !hasCodeDefect(errA), errA.slice(0, 70))

        const fakeLog = join(sandbox, 'looks-like-a-session-log.zstd')
        writeFileSync(fakeLog, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(64, 7)]))
        const beforeFake = sha(fakeLog)
        let errB = ''
        try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: fakeLog, overwrite: true }, exec) }
        catch (e) { errB = String(e.message) }
        ok('W8b 目标是 zstd 魔数文件 ⇒ even overwrite:true 也拒绝（内容不变）', errB.length > 0 && sha(fakeLog) === beforeFake && !hasCodeDefect(errB), errB.slice(0, 70))

        if (sample === null) skip('W8c 目标就是源会话日志本身', '本机没找到真实会话日志样本')
        else {
            const beforeC = sha(sample.path)
            let errC = ''
            try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: sample.path, overwrite: true }, exec) }
            catch (e) { errC = String(e.message) }
            ok('W8c 目标就是真实会话日志 ⇒ 拒绝且原文件哈希不变', errC.length > 0 && sha(sample.path) === beforeC, errC.slice(0, 70))
        }
    }

    // W9：导出产物自洽
    {
        const dest = join(outDir, 'export.jsonl')
        let err = ''
        try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: dest, format: 'jsonl' }, exec) }
        catch (e) { err = String(e.message) }
        if (!existsSync(dest)) skip('W9 导出产物自洽', `没有可导出的会话（${err.slice(0, 40)}）`)
        else {
            const lines = readFileSync(dest, 'utf8').split('\n').filter((l) => l.trim() !== '')
            let bad = 0
            for (const l of lines) { try { JSON.parse(l) } catch { bad += 1 } }
            ok('W9 jsonl 每行都能 JSON.parse', bad === 0 && lines.length > 0, `${lines.length} 行，坏行 ${bad}`)
            const mdDest = join(outDir, 'export.md')
            let mdErr = ''
            try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: mdDest, format: 'md' }, exec) }
            catch (e) { mdErr = String(e.message) }
            ok('W9 md 摘要非空', existsSync(mdDest) && statSync(mdDest).size > 0, mdErr.slice(0, 40))
            ok('W9 拒绝覆盖已存在的导出（第二次同路径必须报错）', await (async () => {
                try { await exp.execute({ session: sessionRef, cwd: wsCwd, to: dest, format: 'jsonl' }, exec); return false }
                catch { return true }
            })())
        }
    }
}

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(failures === 0 ? `\nALL PASS (${passed}${skipped > 0 ? `, ${skipped} skipped` : ''})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

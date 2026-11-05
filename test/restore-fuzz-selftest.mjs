// restore-fuzz-selftest.mjs —— `checkpoint_restore`（唯一真正写回工作区的工具）故障注入（第 24 份自测，）
//
// 这是**风险最高**的一条路径：它会把文件写回工作区、还能删文件。断言：
//   R1 默认只预览：`confirm` 之前**绝不写盘**（前后逐文件 sha256 一致）
//   R2 confirm 后内容必须与快照一致；快照里"只记哈希（not-stored）"的文件**不许被写、也不许被删**
//   R3 失败不留半截：目标只读 / 路径被目录占位 ⇒ 干净报告，文件与目录都**一字不变**
//   R4 `files:[…]` 局部还原只动指定文件（其它保持现状）
//   R5 `pruneExtra` 在**跨工作区**时必须被拒，且目标工作区不受影响
//   R6 journal 往返：还原覆盖掉的版本能用 `checkpoint_journal_restore` 取回来
//   R7 还原后 `checkpoint_diff` 应报"无差异"（端到端闭环）
//
// 存储用官方 `DSH_TOOLKIT_CHECKPOINTS` 重定向到临时目录，并自保：ROOT 不在临时目录就拒绝运行。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const wsRoot = mkdtempSync(join(tmpdir(), 'restore-ws-'))
const fakeStore = mkdtempSync(join(tmpdir(), 'restore-store-'))
process.env.DSH_TOOLKIT_CHECKPOINTS = fakeStore
const { tools, ROOT } = await import('../lib/checkpoint/index.js')
if (!ROOT.toLowerCase().startsWith(tmpdir().toLowerCase())) {
    process.stderr.write(`拒绝运行：ROOT 不在临时目录里 -> ${ROOT}\n`)
    process.exit(2)
}

let passed = 0
let failures = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}
const hasCodeDefect = (msg) => /TypeError|ReferenceError|is not a function|Cannot read propert|not iterable/.test(msg)
const shaOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
const treeFingerprint = (root) => {
    const out = new Map()
    const walk = (dir, rel = '') => {
        let entries = []
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
            const p = join(dir, e.name)
            const r = rel === '' ? e.name : `${rel}/${e.name}`
            if (e.isDirectory()) { out.set(r, 'dir'); walk(p, r) }
            else { try { out.set(r, shaOf(p)) } catch { out.set(r, 'unreadable') } }
        }
    }
    walk(root)
    return out
}
const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

// 工具面收敛：checkpoint_* 七个合并成 action 驱动的 `checkpoint`；按旧名查回绑定动作的薄壳
const ACTION_OF = {
    checkpoint_create: 'create',
    checkpoint_list: 'list',
    checkpoint_diff: 'diff',
    checkpoint_restore: 'restore',
    checkpoint_journal: 'journal',
    checkpoint_journal_restore: 'journal_restore',
    checkpoint_prune: 'prune',
}
const by = (name) => {
    const all = tools((t) => t, {})
    const action = ACTION_OF[name]
    if (action === undefined) return all.find((t) => t.name === name)
    const t = all.find((x) => x.name === 'checkpoint')
    return { name, execute: (args, exec) => t.execute({ action, ...(args ?? {}) }, exec) }
}
const createTool = by('checkpoint_create')
const restoreTool = by('checkpoint_restore')
const diffTool = by('checkpoint_diff')
const journalRestoreTool = by('checkpoint_journal_restore')

/** 造一个工作区 + 一份快照；返回 { ws, id, files } */
async function makeSnapshot(tag) {
    const ws = join(wsRoot, `ws-${tag}`)
    mkdirSync(join(ws, 'sub'), { recursive: true })
    writeFileSync(join(ws, 'a.txt'), 'A1-content')
    writeFileSync(join(ws, 'sub', 'b.txt'), 'B1-content')
    writeFileSync(join(ws, 'big.bin'), 'BIG-original-' + 'x'.repeat(2000))
    const exec = { agent: { session: { header: { cwd: ws } } } }
    // maxCopyBytes 调小 ⇒ big.bin 走"只记哈希（not-stored）"分支（确定性，且不用真造 MB 级文件）
    const out = String(await createTool.execute({ cwd: ws, note: `restore-fuzz-${tag}`, maxCopyBytes: 512 }, exec))
    const id = out.match(/ck-[0-9a-zA-Z-]+/)?.[0] ?? null
    return { ws, id, exec }
}

// ---------- R1/R2/R7：预览不写盘 → confirm 还原 → diff 无差异 ----------
{
    const { ws, id, exec } = await makeSnapshot('basic')
    ok('快照创建成功并能拿到 id', id !== null, String(id))
    if (id !== null) {
        // 改动工作区：改 a、删 b、加 extra、改 big（big 在快照里只记哈希）
        writeFileSync(join(ws, 'a.txt'), 'A2-MODIFIED')
        rmSync(join(ws, 'sub', 'b.txt'), { force: true })
        writeFileSync(join(ws, 'extra.txt'), 'EXTRA-new')
        writeFileSync(join(ws, 'big.bin'), 'BIG-CHANGED-' + 'y'.repeat(2000))

        const beforePreview = treeFingerprint(ws)
        const preview = String(await restoreTool.execute({ id }, exec))
        ok('R1 默认（只预览）绝不写盘', same(beforePreview, treeFingerprint(ws)))
        ok('R1 预览给出计划（含将被还原的文件）', /a\.txt/.test(preview) && /(plan|还原|preview)/i.test(preview), preview.split('\n').slice(0, 2).join(' ').slice(0, 80))

        const result = String(await restoreTool.execute({ id, confirm: true }, exec))
        ok('R2 confirm 后 a.txt 回到快照内容', readFileSync(join(ws, 'a.txt'), 'utf8') === 'A1-content', readFileSync(join(ws, 'a.txt'), 'utf8').slice(0, 20))
        ok('R2 快照里存在的 b.txt 被还原', existsSync(join(ws, 'sub', 'b.txt')) && readFileSync(join(ws, 'sub', 'b.txt'), 'utf8') === 'B1-content')
        ok('R2 快照外的 extra.txt 默认不被删（pruneExtra 未开）', existsSync(join(ws, 'extra.txt')))
        ok('R2 只记哈希的 big.bin **不被写**（保持我改后的内容）', readFileSync(join(ws, 'big.bin'), 'utf8').startsWith('BIG-CHANGED-'), readFileSync(join(ws, 'big.bin'), 'utf8').slice(0, 14))
        ok('R2 报告里如实说明 not-stored（不假装还原了）', /not-stored|hash only|只记哈希/i.test(result), result.split('\n').find((l) => /not-stored|hash/i.test(l))?.trim().slice(0, 70) ?? '(未见说明)')

        const diffAfter = String(await diffTool.execute({ id }, exec))
        // 还原后 diff 只应剩"本就无法还原/快照外"的差异（big.bin 只记哈希、extra.txt 是快照外新增），
 // 被还原的 a.txt / sub/b.txt **不许再出现在差异里**（修正断言：原来我错写成"必须无差异"）
        const aLine = diffAfter.split('\n').find((l) => /(^|\s)a\.txt\b/.test(l)) ?? ''
        const bLine = diffAfter.split('\n').find((l) => /sub[\\/]b\.txt/.test(l)) ?? ''
        const aChanged = /[~+-]\s*a\.txt/.test(aLine)
        const bChanged = /[~+-]\s*sub[\\/]b\.txt/.test(bLine)
        ok('R7 还原后被还原的文件不再出现在差异里（a.txt / sub/b.txt）', !aChanged && !bChanged, `a=[${aLine.trim().slice(0, 30)}] b=[${bLine.trim().slice(0, 30)}]`)
    }
}

// ---------- R3：失败不留半截（只读文件 / 目录占位） ----------
{
    const { ws, id, exec } = await makeSnapshot('fail')
    if (id !== null) {
        const ro = join(ws, 'a.txt')
        const restoredA = readFileSync(ro, 'utf8')          // 快照里存的就是这个内容
        writeFileSync(ro, 'A2-BEFORE-FAIL')
        const beforeRo = readFileSync(ro, 'utf8')
        // ⚠️ 平台差异（真 Linux 首跑抓到）：`attrib +R` 是 **Windows 专有**，Linux 上它不存在
        // ⇒ 根本没注入失败；而且 **POSIX 的只读位拦不住 rename**（关键在目录写权限）⇒ 那里还原会成功。
        // 所以这里：注入尽力而为，**断言只保留跨平台不变量 —— 绝不半截**（要么没写、要么完整还原）。
        let injected = false
        if (process.platform === 'win32') {
            try { execFileSync('attrib', ['+R', ro]); injected = true } catch { /* ignore */ }
        }
        else {
            try { chmodSync(ro, 0o444); injected = true } catch { /* ignore */ }
        }
        let err = ''
        try { await restoreTool.execute({ id, confirm: true, files: ['a.txt'] }, exec) }
        catch (e) { err = String(e.message) }
        const afterRo = readFileSync(ro, 'utf8')
        if (process.platform === 'win32') { try { execFileSync('attrib', ['-R', ro]) } catch { /* ignore */ } }
        else { try { chmodSync(ro, 0o644) } catch { /* ignore */ } }
        ok('R3 目标只读 ⇒ 绝不半截（内容要么原样、要么完整还原）',
            afterRo === beforeRo || afterRo === restoredA,
            `injected=${injected} err=${err.slice(0, 40)} len=${afterRo.length}`)
        ok('R3 失败信息可读（不吞错、不代码级缺陷）', !hasCodeDefect(err), err.slice(0, 50))

        // 目录占位：快照里有 sub/b.txt，但把 b.txt 换成同名**目录**（含一个文件）⇒ 不得破坏该目录内容
        const bPath = join(ws, 'sub', 'b.txt')
        rmSync(bPath, { force: true, recursive: true })
        mkdirSync(bPath, { recursive: true })
        writeFileSync(join(bPath, 'inside.txt'), 'I-MUST-SURVIVE')
        let err2 = ''
        try { await restoreTool.execute({ id, confirm: true, files: ['sub/b.txt'] }, exec) }
        catch (e) { err2 = String(e.message) }
        const survived = existsSync(join(bPath, 'inside.txt')) && readFileSync(join(bPath, 'inside.txt'), 'utf8') === 'I-MUST-SURVIVE'
        ok('R3 路径被目录占位 ⇒ 干净报告且目录内容不被破坏', survived && !hasCodeDefect(err2), `err=${err2.slice(0, 50)}`)
    }
}

// ---------- R4：files 局部还原只动指定文件 ----------
{
    const { ws, id, exec } = await makeSnapshot('partial')
    if (id !== null) {
        writeFileSync(join(ws, 'a.txt'), 'A2-PARTIAL')
        writeFileSync(join(ws, 'sub', 'b.txt'), 'B2-PARTIAL')
        await restoreTool.execute({ id, confirm: true, files: ['a.txt'] }, exec)
        ok('R4 files:[a.txt] ⇒ a.txt 还原', readFileSync(join(ws, 'a.txt'), 'utf8') === 'A1-content')
        ok('R4 files:[a.txt] ⇒ b.txt **保持现状**（没被动）', readFileSync(join(ws, 'sub', 'b.txt'), 'utf8') === 'B2-PARTIAL')
    }
}

// ---------- R5：pruneExtra 跨工作区必须被拒 ----------
{
    const { ws, id, exec } = await makeSnapshot('cross')
    if (id !== null) {
        const other = join(wsRoot, 'ws-other')
        mkdirSync(other, { recursive: true })
        writeFileSync(join(other, 'keep-me.txt'), 'KEEP')
        const beforeOther = treeFingerprint(other)
        let err = ''
        try { await restoreTool.execute({ id, cwd: other, confirm: true, pruneExtra: true }, exec) }
        catch (e) { err = String(e.message) }
        ok('R5 跨工作区 + pruneExtra ⇒ 拒绝', /pruneExtra/.test(err) && !hasCodeDefect(err), err.slice(0, 70))
        ok('R5 被拒时目标工作区一字不动', same(beforeOther, treeFingerprint(other)))
    }
}

// ---------- R6：journal 往返（把被还原覆盖掉的版本取回来） ----------
{
    const { ws, id, exec } = await makeSnapshot('journal')
    if (id !== null) {
        const target = join(ws, 'a.txt')
        writeFileSync(target, 'A2-I-WANT-THIS-BACK')
        await restoreTool.execute({ id, confirm: true, files: ['a.txt'] }, exec)
        ok('R6 还原确实覆盖了 a.txt', readFileSync(target, 'utf8') === 'A1-content')
        let jErr = ''
        // 故意**不给 cwd**：默认基准应当是"调用方会话工作区"（原来退化成 process.cwd() ⇒ 正常回滚会被误拒）
        try { await journalRestoreTool.execute({ path: target, confirm: true }, exec) }
        catch (e) { jErr = String(e.message) }
        ok('R6 journal 能把被覆盖的版本取回来（还原动作前留了底）', readFileSync(target, 'utf8') === 'A2-I-WANT-THIS-BACK', jErr.slice(0, 60))
    }
}

rmSync(wsRoot, { recursive: true, force: true })
rmSync(ROOT, { recursive: true, force: true })
process.stdout.write(failures === 0 ? `\nALL PASS (${passed})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

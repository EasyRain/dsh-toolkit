/**
 * file 工具**写半边**自测：CAS、原子写、hunk 唯一/不重叠、编码与 BOM/CRLF 保真、复制/移动/删除/建目录、工具形状。
 *
 * 这些都是"改坏了很难发现"的地方：
 *  - CAS 失效能挡住"读到旧内容再覆盖"；
 *  - edit 命中多处/重叠时**整单失败**，绝不猜；
 *  - GB18030 不能编码 ⇒ 拒绝编辑，而不是悄悄改编码；
 *  - remove 默认只预览。
 *
 * 跑法：node test/file-write-selftest.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { writeFileOp, editFileOp, copyFileOp, moveFileOp, removeFileOp, mkdirOp, statOp, currentRevision, replaceInFileOp } = await import('../lib/file/write.js')
const { tools } = await import('../lib/file/index.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 240)}`}`)
}

const dir = mkdtempSync(join(tmpdir(), 'tk-file-write-'))
try {
    console.log('== 1. write + CAS ==')
    const a = join(dir, 'a.txt')
    const first = writeFileOp({ path: a, content: 'hello\nworld\n', expectedRevision: 'absent' })
    ok('新建（absent）成功并回 revision', first.ok === true && /^[0-9a-f]{64}$/.test(first.revision), JSON.stringify(first))
    ok('内容落盘', readFileSync(a, 'utf8') === 'hello\nworld\n')

    const again = writeFileOp({ path: a, content: 'x', expectedRevision: 'absent' })
    ok('已存在时 absent 被拒（CAS）', again.ok === false && /已存在/.test(again.message), String(again.message))

    const wrong = writeFileOp({ path: a, content: 'x', expectedRevision: 'deadbeef'.padEnd(64, '0') })
    ok('错误 revision 被拒', wrong.ok === false && /CAS 失败/.test(wrong.message), String(wrong.message))

    const good = writeFileOp({ path: a, content: 'second\n', expectedRevision: first.revision })
    ok('按 revision 覆盖成功', good.ok === true && readFileSync(a, 'utf8') === 'second\n', JSON.stringify(good))
    ok('新 revision 已变化', good.revision !== first.revision)

    const loose = writeFileOp({ path: a, content: 'loose\n' })
    ok('不给 revision 直接覆盖', loose.ok === true && readFileSync(a, 'utf8') === 'loose\n')

    console.log('== 2. edit：唯一命中 / 不重叠 / 编码保真 ==')
    const b = join(dir, 'b.txt')
    writeFileSync(b, 'alpha\nbeta\ngamma\n', 'utf8')
    const rev = currentRevision(b)
    const edited = editFileOp({ path: b, edits: [{ oldText: 'beta', newText: 'BETA' }], expectedRevision: rev })
    ok('唯一命中替换成功', edited.ok === true && readFileSync(b, 'utf8') === 'alpha\nBETA\ngamma\n', JSON.stringify(edited))
    ok('edit 回执带 revision', /^[0-9a-f]{64}$/.test(edited.revision))

    const dup = editFileOp({ path: b, edits: [{ oldText: 'a', newText: 'A' }] })
    ok('命中多处被拒（要求唯一）', dup.ok === false && /命中多处/.test(dup.message), String(dup.message))
    const missing = editFileOp({ path: b, edits: [{ oldText: 'zzz', newText: 'Z' }] })
    ok('找不到 oldText 被拒', missing.ok === false && /找不到/.test(missing.message), String(missing.message))

    const c = join(dir, 'c.txt')
    writeFileSync(c, 'abc', 'utf8')
    const overlap = editFileOp({ path: c, edits: [{ oldText: 'ab', newText: 'X' }, { oldText: 'bc', newText: 'Y' }] })
    ok('区间重叠被拒', overlap.ok === false && /重叠/.test(overlap.message), String(overlap.message))

    const bomCrlf = join(dir, 'bom-crlf.txt')
    writeFileSync(bomCrlf, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n', 'utf8')]))
    const bomEdit = editFileOp({ path: bomCrlf, edits: [{ oldText: 'two', newText: 'TWO' }] })
    const bomBytes = readFileSync(bomCrlf)
    ok('edit 保留 BOM 与 CRLF', bomEdit.ok === true && bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf && bomBytes.includes(Buffer.from('\r\n')))
    ok('edit 内容正确', bomBytes.toString('utf8').includes('TWO\r\n'))

    const gbk = join(dir, 'gbk.txt')
    writeFileSync(gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]))
    const gbkEdit = editFileOp({ path: gbk, edits: [{ oldText: '你好', newText: '您好' }] })
    ok('GB18030 拒绝编辑（不悄悄改编码）', gbkEdit.ok === false && /GB18030/.test(gbkEdit.message), String(gbkEdit.message))

    console.log('== 3. copy / move / remove / mkdir / stat ==')
    const src = join(dir, 'src.txt')
    writeFileSync(src, 'payload', 'utf8')
    const dst = join(dir, 'dst.txt')
    ok('copy 成功', copyFileOp({ path: src, to: dst }).ok === true && readFileSync(dst, 'utf8') === 'payload')
    ok('copy 到已存在（默认不覆盖）被拒', copyFileOp({ path: src, to: dst }).ok === false)
    ok('copy 带 overwrite 成功', copyFileOp({ path: src, to: dst, overwrite: true }).ok === true)

    const moved = join(dir, 'moved.txt')
    const mv = moveFileOp({ path: dst, to: moved })
    ok('move 成功且源消失', mv.ok === true && existsSync(moved) && !existsSync(dst), JSON.stringify(mv))

    const preview = removeFileOp({ path: moved })
    ok('remove 默认只预览', preview.ok === true && preview.dryRun === true && existsSync(moved), JSON.stringify(preview))
    const removed = removeFileOp({ path: moved, confirm: true })
    ok('remove confirm 后真删', removed.ok === true && !existsSync(moved))

    const sub = join(dir, 'nested', 'deep')
    ok('mkdir 递归建目录', mkdirOp({ path: sub }).ok === true && statSync(sub).isDirectory())
    ok('删除目录不带 recursive 被拒', removeFileOp({ path: join(dir, 'nested'), confirm: true }).ok === false)
    ok('删除目录带 recursive + confirm 成功', removeFileOp({ path: join(dir, 'nested'), recursive: true, confirm: true }).ok === true)

    const st = statOp({ path: src })
    ok('stat 返回大小/时间/revision', st.ok === true && st.size === 7 && st.isFile === true && /^[0-9a-f]{64}$/.test(st.revision), JSON.stringify(st))

    console.log('== 4. replace（字面批量替换，默认只预览）==')
    {
        const repl = join(dir, 'repl')
        mkdirSync(repl, { recursive: true })
        const a = join(repl, 'a.txt')
        writeFileSync(a, 'foo bar foo\nbaz foo\n', 'utf8')
        writeFileSync(join(repl, 'b.txt'), 'nothing here\n', 'utf8')
        writeFileSync(join(repl, 'bin.dat'), Buffer.from([0x00, 0x66, 0x6f, 0x6f]))

        const preview = replaceInFileOp({ path: a, pattern: 'foo', replacement: 'FOO' })
        ok('默认 dryRun：报 3 处 + 行号，但不写盘', preview.ok === true && preview.dryRun === true && preview.matches === 3 && preview.lines[0] === 1 && readFileSync(a, 'utf8').includes('foo'), JSON.stringify(preview))
        const applied = replaceInFileOp({ path: a, pattern: 'foo', replacement: 'FOO', dryRun: false })
        ok('dryRun:false 才写盘并回 revision', applied.ok === true && readFileSync(a, 'utf8') === 'FOO bar FOO\nbaz FOO\n' && /^[0-9a-f]{64}$/.test(applied.revision), JSON.stringify(applied))
        ok('二进制跳过', replaceInFileOp({ path: join(repl, 'bin.dat'), pattern: 'foo' }).skipped === true)
        ok('空 pattern 被拒', replaceInFileOp({ path: a, pattern: '', dryRun: false }).ok === false)

        const tool = tools((def) => def, { resolveWorkspaceCwd: () => dir })[0]
        const text = await tool.execute({ action: 'replace', paths: [repl], pattern: 'FOO', replacement: 'X' })
        ok('工具级 replace 默认预览并列出命中文件', /dryRun=true/.test(text) && /a\.txt: 3 处/.test(text), text)
        const written = await tool.execute({ action: 'replace', paths: [repl], pattern: 'FOO', replacement: 'X', dryRun: false })
        ok('工具级 dryRun:false 写盘', /已写入/.test(written) && readFileSync(a, 'utf8') === 'X bar X\nbaz X\n', written)
    }

    console.log('== 5. 工具形状 ==')
    {
        const seen = []
        const def = tools((d) => { seen.push(d); return d }, { resolveWorkspaceCwd: () => 'D:/DshWorkSpace/Addons' })[0]
        ok('只注册 1 个工具', seen.length === 1)
        ok('名字是 file', def.name === 'file')
        ok('action 是唯一必填且含 9 个动作', def.parameters.action.required === true && def.parameters.action.enum.length === 9, JSON.stringify(def.parameters.action.enum))
        ok('9 个动作都写进了描述', def.parameters.action.enum.every((item) => def.description.includes(item)))
        ok('关键参数齐全', ['path', 'paths', 'ranges', 'encoding', 'content', 'edits', 'pattern', 'replacement', 'dryRun', 'expectedRevision', 'to', 'overwrite', 'recursive', 'confirm'].every((key) => key in def.parameters), Object.keys(def.parameters).join(','))
        ok('有 output.schema 与 render', def.output?.schema !== undefined && typeof def.output?.render === 'function')
    }
}
finally {
    rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

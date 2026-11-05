/**
 * file diff 自测：单 hunk 修剪、分页、BOM/CRLF/尾换行差异、只读。
 * 跑法：node test/file-diff-selftest.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { tools } = await import('../lib/file/index.js')
const { diffFileOp } = await import('../lib/file/diff.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 240)}`}`)
}

const dir = mkdtempSync(join(tmpdir(), 'tk-file-diff-'))
try {
    const def = tools((tool) => tool, { resolveWorkspaceCwd: () => dir })[0]
    const run = (args) => def.execute({ action: 'diff', ...args })

    console.log('== 1. 相同内容 ==')
    {
        const p = join(dir, 'same.txt')
        writeFileSync(p, 'a\nb\nc\n')
        const text = await run({ path: p, content: 'a\nb\nc\n' })
        ok('相同 ⇒ 明确说无改动', /内容相同/.test(text) && !/@@/.test(text), text)
        ok('带 old/new 哈希与行数', /old=[0-9a-f]{12}/.test(text) && /new=[0-9a-f]{12}/.test(text), text)
    }

    console.log('== 2. 中间一行改动 ⇒ 单 hunk + 上下文 ==')
    {
        const p = join(dir, 'mid.txt')
        writeFileSync(p, 'a\nb\nc\nd\ne\nf\n')
        const text = await run({ path: p, content: 'a\nb\nC\nd\ne\nf\n' })
        ok('输出 @@ hunk 头', /@@ -\d+,\d+ \+\d+,\d+ @@/.test(text), text)
        ok('旧行以 - 开头、新行以 + 开头', /\n-c\n/.test(text) && /\n\+C\n/.test(text), text)
        ok('修剪后不重复上下文之外的行', !/^-a$/.test(text) && !/^-f$/.test(text), text)
    }

    console.log('== 3. 分页 ==')
    {
        const p = join(dir, 'page.txt')
        const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
        writeFileSync(p, `${oldLines.join('\n')}\n`)
        const next = oldLines.map((line) => `${line} changed`).join('\n') + '\n'
        const first = await run({ path: p, content: next, limit: 5, offset: 0, context: 0 })
        ok('首页给 nextOffset', /nextOffset=5/.test(first), first)
        const second = await run({ path: p, content: next, limit: 5, offset: 5, context: 0 })
        ok('第二页内容不同且继续', /nextOffset=10/.test(second) && second !== first, second.slice(0, 120))
        const last = await run({ path: p, content: next, limit: 1000, offset: 0, context: 0 })
        ok('一页装完时不再给 nextOffset', !/nextOffset=/.test(last) && /hunk 共 \d+ 行/.test(last), last.slice(-80))
    }

    console.log('== 4. BOM / CRLF / 尾换行 ==')
    {
        const bom = join(dir, 'bom.txt')
        writeFileSync(bom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('a\nb\n')]))
        const bomText = await run({ path: bom, content: 'a\nb\n' })
        ok('BOM 文件：行相同但提示 BOM', /BOM/.test(bomText) && !/@@/.test(bomText), bomText)

        const crlf = join(dir, 'crlf.txt')
        writeFileSync(crlf, 'a\r\nb\r\n')
        const crlfText = await run({ path: crlf, content: 'a\nb\n' })
        ok('CRLF 文件：行相同但字节不同', /字节不同/.test(crlfText), crlfText)

        const tail = join(dir, 'tail.txt')
        writeFileSync(tail, 'a\nb\n')
        const tailText = await run({ path: tail, content: 'a\nb' })
        ok('尾换行差异被指出', /结尾换行/.test(tailText) && !/@@/.test(tailText), tailText)
    }

    console.log('== 5. 错误与只读 ==')
    {
        const missing = await run({ path: join(dir, 'nope.txt'), content: 'x' })
        ok('文件不存在 ⇒ 明确报错', /读不到文件/.test(missing), missing)
        const noContent = await run({ path: join(dir, 'nope.txt') })
        ok('缺 content ⇒ 明确报错', /要给 content/.test(noContent), noContent)
        const p = join(dir, 'readonly.txt')
        writeFileSync(p, 'x\n')
        const before = await run({ path: p, content: 'y\n' })
        ok('diff 不改文件（写完读回仍是 x）', /@@/.test(before) && (await import('node:fs')).readFileSync(p, 'utf8') === 'x\n')
        const direct = diffFileOp({ path: p, content: 'z\n', limit: 1 })
        ok('直接调用也返回分页字段', direct.ok === true && direct.total >= 1 && typeof direct.nextOffset === 'number', JSON.stringify(direct).slice(0, 120))
    }
}
finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

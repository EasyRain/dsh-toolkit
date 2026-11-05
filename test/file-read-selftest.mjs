/**
 * file_read 自测 —— 编码探测、多区间、多文件隔离、二进制、截断、stat。
 *
 * 重点覆盖真实踩点：
 *  - 本工作区的 MC 模组文本大量是 GB18030，宿主 read 会读成乱码
 *  - BOM 必须剥掉，否则第一行会多一个不可见字符
 *  - 一个文件失败不能拖垮其它文件
 *  - 二进制不能被当成文本硬塞
 *
 * 跑法：node test/file-read-selftest.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

/** 最小 stored（不压缩）zip 写入器：只为造一个 .docx 测试样本，不引依赖。 */
function buildStoredZip(entries) {
    const chunks = []
    const central = []
    let offset = 0
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8')
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
        const crc = crc32(data) >>> 0
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(name.length, 26)
        chunks.push(local, name, data)
        const cd = Buffer.alloc(46)
        cd.writeUInt32LE(0x02014b50, 0)
        cd.writeUInt16LE(20, 4)
        cd.writeUInt16LE(20, 6)
        cd.writeUInt32LE(crc, 16)
        cd.writeUInt32LE(data.length, 20)
        cd.writeUInt32LE(data.length, 24)
        cd.writeUInt16LE(name.length, 28)
        cd.writeUInt32LE(offset, 42)
        central.push(cd, name)
        offset += 30 + name.length + data.length
    }
    const directory = Buffer.concat(central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(directory.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...chunks, directory, eocd])
}

const { readOne, decodeBuffer, parseRange, renderReport, hexPreview, LIMITS } = await import('../lib/file/read.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 240)}`}`)
}

const dir = mkdtempSync(join(tmpdir(), 'tk-file-read-'))
const write = (name, data) => {
    const path = join(dir, name)
    writeFileSync(path, data)
    return path
}

try {
    console.log('== 1. 编码探测 ==')
    const utf8 = write('utf8.txt', '第一行\n第二行\n第三行\n')
    {
        const r = readOne(utf8)
        ok('普通 UTF-8 中文', r.ok === true && r.encoding === 'utf8' && r.lines[0].line === '第一行', JSON.stringify({ enc: r.encoding, first: r.lines?.[0] }))
        ok('行号从 1 开始', r.lines[0].number === 1 && r.lines[2].number === 3)
        ok('末尾换行不多切一个空行', r.stat.lines === 3, String(r.stat.lines))
    }

    const bom = write('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM\n第二行\n', 'utf8')]))
    {
        const r = readOne(bom)
        ok('UTF-8 BOM 被剥掉', r.ok === true && r.lines[0].line === '带BOM' && !r.lines[0].line.includes('\uFEFF'), JSON.stringify(r.lines?.[0]))
        ok('BOM 记为依据', r.encodingReason === 'BOM', String(r.encodingReason))
    }

    const utf16 = write('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('宽字符\n第二行\n', 'utf16le')]))
    {
        const r = readOne(utf16)
        ok('UTF-16LE 解码', r.ok === true && r.encoding === 'utf16le' && r.lines[0].line === '宽字符', JSON.stringify(r.lines?.[0]))
    }

    // "你好\n世界\n" 的 GB18030 字节：c4 e3 ba c3 0a ca c0 bd e7 0a
    const gbk = write('gbk.txt', Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xca, 0xc0, 0xbd, 0xe7, 0x0a]))
    {
        const r = readOne(gbk)
        ok('GB18030 自动识别', r.ok === true && r.encoding === 'gb18030' && r.lines[0].line === '你好' && r.lines[1].line === '世界', JSON.stringify({ enc: r.encoding, lines: r.lines?.map((l) => l.line) }))
    }

    console.log('== 2. 区间 ==')
    {
        const r = readOne(utf8, { ranges: ['2-3'] })
        ok('"2-3" 只给第 2、3 行', r.lines.length === 2 && r.lines[0].number === 2 && r.lines[1].line === '第三行', JSON.stringify(r.lines))
        const multi = readOne(utf8, { ranges: ['1', '3-3'] })
        ok('多段合并', multi.lines.map((l) => l.number).join(',') === '1,3', JSON.stringify(multi.lines.map((l) => l.number)))
        const tail = readOne(utf8, { ranges: ['2-999'] })
        ok('区间越过文件末尾不报错', tail.lines.length === 2 && tail.lines[1].number === 3)
        ok('部分读取 ⇒ complete=false 且给 nextOffset', readOne(utf8, { ranges: ['1-2'] }).complete === false && readOne(utf8, { ranges: ['1-2'] }).nextOffset === 3)
        let threw = null
        try { parseRange('abc') } catch (error) { threw = error instanceof Error ? error.message : String(error) }
        ok('非法区间给出可读错误', typeof threw === 'string' && /行号从 1 开始/.test(threw), String(threw))
        let reversed = null
        try { parseRange('5-2') } catch (error) { reversed = String(error) }
        ok('结束行小于起始行被拒', typeof reversed === 'string' && /小于起始行/.test(reversed), String(reversed))
    }

    console.log('== 3. 二进制 ==')
    const bin = write('bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x41, 0x42]))
    {
        const r = readOne(bin)
        ok('识别为二进制并给 hex', r.ok === true && r.binary === true && /^00000000  /m.test(r.hex), JSON.stringify(r.note))
        ok('hex 预览含可读列', /00000000  00 01 02/.test(r.hex))
    }
    ok('hexPreview 模板正确', /^00000000  4d 5a/.test(hexPreview(Buffer.from([0x4d, 0x5a]))))

    console.log('== 4. 截断与上限 ==')
    {
        const big = write('big.txt', Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n'))
        const r = readOne(big, { maxBytes: 200 })
        ok('超过 maxBytes 标记 truncated', r.ok === true && r.stat.truncated === true, JSON.stringify(r.stat))
        const wide = readOne(big)
        ok('默认 1 MB 下 2000 行全读', wide.lines.length === 2000, String(wide.lines.length))
    }

    console.log('== 5. 逐文件隔离与错误 ==')
    {
        const missing = join(dir, 'nope.txt')
        const bad = readOne(missing)
        ok('不存在的文件返回 error 而不是抛', bad.ok === false && /读不到/.test(bad.error), String(bad.error))
        const asDir = readOne(dir)
        ok('目录被明确拒绝', asDir.ok === false && /目录/.test(asDir.error), String(asDir.error))
        const good = readOne(utf8)
        const text = renderReport([bad, good])
        ok('一个失败不影响另一个（报告里两块都在）', /nope\.txt" ===\n!! /.test(text) && /第一行/.test(text), text.split('\n').slice(0, 4).join(' / '))
    }

    console.log('== 6. stat 只返回元数据 ==')
    {
        const r = readOne(utf8, { stat: true })
        ok('stat=true 不返回行内容', r.ok === true && r.stat.size > 0 && r.lines === undefined, JSON.stringify(Object.keys(r)))
    }

    console.log('== 7. 渲染格式（ops 式紧凑协议）==')
    {
        const single = readOne(utf8)
        const text = renderReport([single])
        ok('带编码/大小与行号区间', /encoding=utf8/.test(text) && /\d+ B/.test(text) && /\(Lines 1-3 of 3\)/.test(text))
        ok('行号格式 `N| ` + 正文', /^1\| 第一行$/m.test(text), text.split('\n').slice(0, 3).join(' / '))
        ok('末尾带 revision 与 complete', /\[revision=[0-9a-f]{64}; end of file; complete=true\]/.test(text), text.split('\n').slice(-1)[0])
        ok('读取结果本身也带 revision', /^[0-9a-f]{64}$/.test(single.revision ?? ''))
        const partial = renderReport([readOne(utf8, { ranges: ['1-2'] })])
        ok('未到末尾 ⇒ more lines / nextOffset', /more lines; nextOffset=3\]/.test(partial), partial.split('\n').slice(-1)[0])
    }

    console.log('== 7b. 转义、行内截断、Base 共享 ==')
    {
        const tricky = write('tricky.txt', 'a\tb\\c\nx\u0001y\n')
        const text = renderReport([readOne(tricky)])
        ok('制表/反斜杠/控制字符被转义', /1\| a\\tb\\\\c/.test(text) && /2\| x\\u0001y/.test(text), text)

        const longLine = 'x'.repeat(3000)
        const longFile = write('long.txt', `${longLine}\nsecond\n`)
        const lr = readOne(longFile)
        ok('超长行被切到 maxLineChars 并标 truncatedInLine', lr.truncatedInLine === true && lr.lines[0].line.length === LIMITS.maxLineChars)
        ok('行内截断是独立事实：到末尾仍 complete=true、不产生 nextOffset', lr.complete === true && lr.nextOffset === undefined, JSON.stringify({ complete: lr.complete, next: lr.nextOffset }))

        const second = write('utf8b.txt', '第四行\n第五行\n')
        const shared = renderReport([readOne(utf8), readOne(second)])
        ok('同一目录共享 [Base: ...]', /^\[Base: /.test(shared) && /=== FILE: "utf8\.txt"/.test(shared) && /=== FILE: "utf8b\.txt"/.test(shared), shared.split('\n')[0])
    }

    console.log('== 8. 常量 ==')
    ok('默认上限 1 MB / 总预算 2 MB / 20 文件 / 20 段', LIMITS.maxBytes === 1024 * 1024 && LIMITS.totalBytes === 2 * 1024 * 1024 && LIMITS.maxFiles === 20 && LIMITS.maxRanges === 20)
    ok('单行上限 2000 字符', LIMITS.maxLineChars === 2000)

    console.log('== 9. docx 与 pdf ==')
    {
        const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
            + '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>'
            + '<w:p><w:r><w:t>第二段 &amp; 转义</w:t></w:r><w:r><w:tab/><w:t>尾</w:t></w:r></w:p>'
            + '</w:body></w:document>'
        const docx = join(dir, 'sample.docx')
        writeFileSync(docx, buildStoredZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf8') }]))
        const docxRead = readOne(docx)
        ok('docx 提取段落并还原转义/制表', docxRead.ok === true && docxRead.encoding === 'docx' && docxRead.lines[0].line === '第一段' && docxRead.lines[1].line === '第二段 & 转义\t尾', JSON.stringify(docxRead.lines))
        ok('docx 也回 revision', /^[0-9a-f]{64}$/.test(docxRead.revision ?? ''))
        const docxRange = readOne(docx, { ranges: ['2'] })
        ok('docx 的 ranges 按段落算', docxRange.lines.length === 1 && docxRange.lines[0].number === 2)

        const pdf = write('fake.pdf', Buffer.from('%PDF-1.4\n'))
        const pdfRead = readOne(pdf)
        ok('pdf 明确拒绝并指路 office', pdfRead.ok === false && /PDF/.test(pdfRead.error), pdfRead.error)

        // xlsx：workbook + rels + sharedStrings + 一个 sheet（共享字符串 / 数字 / 行号）
        const xlsx = join(dir, 'sample.xlsx')
        writeFileSync(xlsx, buildStoredZip([
            { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
            { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
            { name: 'xl/sharedStrings.xml', data: '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>' },
            { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>' },
        ]))
        const xlsxRead = readOne(xlsx)
        const xlsxTextAll = xlsxRead.lines.map((line) => line.line).join('\n')
        ok('xlsx 提取工作表/共享字符串/数字', xlsxRead.ok === true && xlsxRead.encoding === 'xlsx'
            && xlsxTextAll.includes('[Sheet: Sheet1]') && xlsxTextAll.includes('1: A1=姓名  B1=张三') && xlsxTextAll.includes('2: A2=42'), xlsxTextAll)

        // pptx：按 slide 序号提取 <a:t>
        const pptx = join(dir, 'sample.pptx')
        writeFileSync(pptx, buildStoredZip([
            { name: 'ppt/slides/slide1.xml', data: '<p:sld xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>标题一</a:t></a:r></a:p><a:p><a:r><a:t>第二行</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
        ]))
        const pptxRead = readOne(pptx)
        const pptxTextAll = pptxRead.lines.map((line) => line.line).join('\n')
        ok('pptx 按页提取 <a:t> 文本', pptxRead.ok === true && pptxRead.encoding === 'pptx'
            && pptxTextAll.includes('[slide 1]') && pptxTextAll.includes('标题一') && pptxTextAll.includes('第二行'), pptxTextAll)
    }
}
finally {
    rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

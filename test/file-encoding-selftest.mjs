/**
 * 编码兼容性自测（v0.10.0：Big5 / Shift_JIS / EUC-KR / EUC-JP / windows-1251 / iso-8859-1）。
 *
 * 背景：以前只有 `BOM → 严格 UTF-8 → 严格 GB18030`。GB18030 的字节空间几乎覆盖所有双字节组合，
 * 于是 Big5 的「中文測試」会被"成功"解成「いゅ代刚」（replacements=0，静默出错）。现在：
 *   - 自动模式把所有能严格解开的 CJK 候选都试一遍，按"常见字比例 + 脚本匹配"打分；
 *   - 分差太小、或最好的候选也说不通时，回执里明确提示歧义；
 *   - 单字节编码（windows-1251 / iso-8859-1）不进自动候选，只能显式指定；
 *   - `edit` / `replace` 遇到这些"能读不能原样写回"的编码一律拒绝（Node 没有编码器）。
 *
 * 跑法：node test/file-encoding-selftest.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = await import('../lib/file/read.js')
const write = await import('../lib/file/write.js')
const fileFamily = await import('../lib/file/index.js')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond || extra === '' ? '' : `   <- ${String(extra).slice(0, 200)}`}`)
}

const root = mkdtempSync(join(tmpdir(), 'tk-encoding-'))
const defineTool = (definition) => definition
const tool = fileFamily.tools(defineTool, { resolveWorkspaceCwd: () => root })[0]

/** 手工字节：Big5「中文測試」/ GBK「中文测试」/ Shift_JIS「テスト」/ EUC-KR「테스트」/ windows-1251「Привет」 */
const FIXTURES = {
    big5: Buffer.from([0xA4, 0xA4, 0xA4, 0xE5, 0xB4, 0xFA, 0xB8, 0xD5]),
    gbk: Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4]),
    sjis: Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]),
    euckr: Buffer.from([0xC5, 0xD7, 0xC0, 0xCC, 0xD5, 0xC1]),
    cp1251: Buffer.from([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2]),
}

try {
    console.log('== 1. 显式指定：每种编码都能读对 ==')
    {
        const expect = {
            big5: '中文測試',
            gbk: '中文测试',
            sjis: 'テスト',
            cp1251: 'Привет',
        }
        for (const [name, buffer] of Object.entries(FIXTURES)) {
            if (name === 'euckr') continue
            const encoding = name === 'gbk' ? 'gb18030' : (name === 'sjis' ? 'shift_jis' : (name === 'big5' ? 'big5' : 'windows-1251'))
            const decoded = read.decodeBuffer(buffer, encoding)
            ok(`显式 ${encoding} → ${JSON.stringify(expect[name])}`, decoded.text === expect[name] && decoded.replacements === 0, JSON.stringify(decoded.text))
        }
    }

    console.log('== 2. 自动探测：按内容挑对编码 ==')
    {
        const cases = [
            ['big5', 'big5', '中文測試'],
            ['gbk', 'gb18030', '中文测试'],
            ['sjis', 'shift_jis', 'テスト'],
        ]
        for (const [name, encoding, text] of cases) {
            const decoded = read.decodeBuffer(FIXTURES[name])
            ok(`自动 ${name} → ${encoding}`, decoded.encoding === encoding && decoded.text === text, `${decoded.encoding} ${JSON.stringify(decoded.text)}`)
        }
    }

    console.log('== 3. UTF-8 / BOM / 纯 ASCII 不受影响 ==')
    {
        ok('UTF-8 中文照常', read.decodeBuffer(Buffer.from('中文测试', 'utf8')).encoding === 'utf8')
        const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')])
        ok('UTF-8 BOM', read.decodeBuffer(bom).encoding === 'utf8')
        ok('纯 ASCII 走 UTF-8（不进候选）', read.decodeBuffer(Buffer.from('hello')).encoding === 'utf8')
    }

    console.log('== 4. 不确定时要明说（不能静默猜）==')
    {
        // 足够长、但都是生僻字（不在常见表里）⇒ 评分低 ⇒ 应提示歧义
        const weak = Buffer.alloc(40, 0)
        for (let i = 0; i < 40; i += 1) { weak[i * 2] = 0xA1; weak[i * 2 + 1] = 0x40 + (i % 0x3F) }
        const decoded = read.decodeBuffer(weak)
        ok('低分候选 ⇒ ambiguous=true', decoded.ambiguous === true, JSON.stringify(decoded.reason))
        ok('reason 里给出候选列表', Array.isArray(decoded.candidates) && decoded.candidates.length > 1, JSON.stringify(decoded.candidates))
    }

    console.log('== 5. 工具层：歧义提示进回执 ==')
    {
        const target = join(root, 'big5.txt')
        writeFileSync(target, FIXTURES.big5)
        const out = await tool.execute({ action: 'read', path: target, encoding: 'big5' })
        ok('显式 big5 读到正确中文', out.includes('中文測試'), out.slice(0, 160))
        const auto = await tool.execute({ action: 'read', path: target })
        ok('自动模式命中 big5（不再误判成 GB18030）', /encoding=big5/.test(auto), auto.slice(0, 160))
    }

    console.log('== 6. 编辑/替换：能读不能原样写回的一律拒绝 ==')
    {
        const big5File = join(root, 'edit-big5.txt')
        writeFileSync(big5File, FIXTURES.big5)
        const edited = write.editFileOp({ path: big5File, edits: [{ oldText: '中文', newText: '英文' }] })
        ok('edit 拒绝 Big5 文件', edited.ok === false && /big5/.test(edited.message), JSON.stringify(edited))

        const replaced = write.replaceInFileOp({ path: big5File, pattern: '中文', replacement: '英文', dryRun: false })
        ok('replace 拒绝 Big5 文件', replaced.ok === false && /big5/.test(replaced.message), JSON.stringify(replaced))

        const gbkFile = join(root, 'edit-gbk.txt')
        writeFileSync(gbkFile, FIXTURES.gbk)
        const gbkEdit = write.editFileOp({ path: gbkFile, edits: [{ oldText: '测试', newText: '试验' }] })
        ok('edit 拒绝 GB18030 文件（原有行为不变）', gbkEdit.ok === false && /gb18030/.test(gbkEdit.message), JSON.stringify(gbkEdit))

        const utf8File = join(root, 'edit-utf8.txt')
        writeFileSync(utf8File, '中文测试\n', 'utf8')
        const utf8Edit = write.editFileOp({ path: utf8File, edits: [{ oldText: '测试', newText: '试验' }] })
        ok('UTF-8 文件照常可编辑', utf8Edit.ok === true, JSON.stringify(utf8Edit))
    }

    console.log('== 7b. 大文件采样：探测只看前 64 KB，整份只解码一次 ==')
    {
        // 200 KB 的 Big5：样本足以判定，且不能因为"只看了前 64 KB"就判错
        const unit = FIXTURES.big5
        const big = Buffer.alloc(unit.length * 12500)
        for (let i = 0; i < 12500; i += 1) unit.copy(big, i * unit.length)
        const decoded = read.decodeBuffer(big)
        ok('200 KB Big5 仍判为 big5', decoded.encoding === 'big5', decoded.encoding)
        ok('整份解码正确（首尾都对）', decoded.text.startsWith('中文測試') && decoded.text.endsWith('中文測試'), decoded.text.slice(-6))
        ok('无替换字符', decoded.replacements === 0, String(decoded.replacements))
    }

    console.log('== 7c. 采样盲区：英文表头 + 后面的 CJK ==')
    {
        const head = Buffer.from('log header line\n'.repeat(4200))       // > 64 KB 纯 ASCII
        const unit = FIXTURES.big5
        const tail = Buffer.alloc(unit.length * 4000)
        for (let i = 0; i < 4000; i += 1) unit.copy(tail, i * unit.length)
        const mixed = Buffer.concat([head, tail])
        const decoded = read.decodeBuffer(mixed)
        ok('ASCII 表头 + Big5 正文 ⇒ 仍判为 big5（不按样本瞎猜）', decoded.encoding === 'big5', decoded.encoding)
        ok('尾部内容正确', decoded.text.endsWith('中文測試'), decoded.text.slice(-6))
    }

    console.log('== 7d. 证据不足就别喊歧义（3 个字符说明不了什么）==')
    {
        const tiny = read.decodeBuffer(Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0A]))
        ok('3 字符的 Shift_JIS 不报歧义', tiny.ambiguous === undefined, JSON.stringify(tiny.reason))
        ok('但仍判对编码与内容', tiny.encoding === 'shift_jis' && tiny.text.startsWith('テスト'), `${tiny.encoding} ${JSON.stringify(tiny.text)}`)
        ok('空文件不抛错（走 UTF-8 快路径）', read.decodeBuffer(Buffer.alloc(0)).encoding === 'utf8')
    }

    console.log('== 9. 截断读取（maxBytes 小于文件）仍按文件开头判断编码 ==')
    {
        const big5File = join(root, 'trunc-big5.txt')
        const unit = FIXTURES.big5
        const many = Buffer.alloc(unit.length * 4000)
        for (let i = 0; i < 4000; i += 1) unit.copy(many, i * unit.length)
        writeFileSync(big5File, many)
        const cut = read.readOne(big5File, { maxBytes: 200 })
        ok('Big5 大文件 + maxBytes=200 ⇒ 仍报 big5（不按 200 字节猜）', cut.encoding === 'big5', cut.encoding)
        ok('截断标记仍然正确', cut.truncated === true, String(cut.truncated))
        // 回归：正文必须来自**展示窗口**，不能把 64 KB 探测样本当成内容（实测曾返回全部 4000 行）
        ok('只返回展示窗口内的行（不泄露探测样本）', cut.lines.length > 0 && cut.lines.length < 100, String(cut.lines.length))
        ok('stat.lines 与展示窗口一致', cut.stat.lines === cut.lines.length, String(cut.stat.lines))

        const mixedFile = join(root, 'trunc-mixed.txt')
        writeFileSync(mixedFile, Buffer.concat([Buffer.from('log header line\n'.repeat(4200)), many]))
        const mixedCut = read.readOne(mixedFile, { maxBytes: 200 })
        ok('ASCII 表头 + Big5 正文 + 小窗口 ⇒ 仍报 big5', mixedCut.encoding === 'big5', mixedCut.encoding)

        const utf8File = join(root, 'trunc-utf8.txt')
        writeFileSync(utf8File, '中文测试\n'.repeat(2000), 'utf8')
        ok('UTF-8 大文件 + 小窗口 ⇒ 仍是 utf8', read.readOne(utf8File, { maxBytes: 200 }).encoding === 'utf8')
    }

    console.log('== 10. 无 BOM 的 UTF-16（Windows 工具偶尔会写）==')
    {
        const text = 'hello world 中文 test\n'
        const le = Buffer.from(text, 'utf16le')
        const be = Buffer.alloc(le.length)
        le.copy(be)
        be.swap16()

        ok('UTF-16LE 无 BOM ⇒ 认出 utf16le', read.decodeBuffer(le).encoding === 'utf16le', read.decodeBuffer(le).encoding)
        ok('UTF-16BE 无 BOM ⇒ 认出 utf16be', read.decodeBuffer(be).encoding === 'utf16be', read.decodeBuffer(be).encoding)
        ok('内容解码正确（LE）', read.decodeBuffer(le).text === text, JSON.stringify(read.decodeBuffer(le).text))

        const leFile = join(root, 'nobom-utf16le.txt')
        writeFileSync(leFile, le)
        const one = read.readOne(leFile, {})
        ok('readOne 不再把它当二进制（给 hex）', one.encoding === 'utf16le' && Array.isArray(one.lines), JSON.stringify(one.encoding))
        ok('行内容正确', one.lines[0].line === 'hello world 中文 test', JSON.stringify(one.lines[0]?.line))

        const binFile = join(root, 'real-binary.dat')
        writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 4, 0, 5, 0, 6, 0, 7]))
        ok('真二进制仍然给 hex（不被 UTF-16 规则吞掉）', read.readOne(binFile, {}).encoding === undefined, String(read.readOne(binFile, {}).encoding))
    }

    console.log('== 8. 未知编码名要明确报错（不静默回退）==')
    {
        let error = null
        try { read.decodeBuffer(FIXTURES.gbk, 'koi8-r') } catch (thrown) { error = thrown }
        ok('不支持的 encoding ⇒ 抛错并列出可用值', error !== null && /不支持的 encoding/.test(String(error.message)), String(error?.message))
    }
}
finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1

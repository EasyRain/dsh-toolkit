/**
 * AST 只读工具自测：node test/ast-search-selftest.mjs
 *
 * ⚠️ 需要 `@ast-grep/napi`（只随 profile 的 node_modules 安装），解析顺序：源树 → desktop 副本 → probe 副本。
 *
 * 这些工具此前**没有任何测试覆盖**（上游代码 + 我们的 3 处改动都没被验证过）。本文件锁住：
 *  - 三个 dump 格式、两个上限（max_nodes / max_depth）与**截断原因的正确措辞**（上游一律写成 "at depth N"）；
 *  - 搜索的匹配/上限/裁剪/参数校验；
 *  - `ast_test_rule`：**0 命中返回空数组而不是报错**（上游会 throw，表现为"工具执行失败"）；
 *    **`$$$ARGS` 只捕获 1 个节点时也出现在 `multi` 里**（上游用 `> 1` 过滤 ⇒ 该捕获在输出中完全消失）；
 *  - `ast_grep_help` 的 `full` 只返回 `## ast-rules` 那一节（并入 TOOLKIT.md 之后的行为）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const here = new URL('.', import.meta.url)
const candidates = [
    new URL('../lib/search.js', here),
    pathToFileURL(join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/search.js')),
    pathToFileURL(join(homedir(), '.dsh/profiles/_probe-toolkit/node_modules/dsh-toolkit/lib/search.js')),
]
let mod
let used = ''
for (const url of candidates) {
    try { mod = await import(url.href); used = url.href; break }
    catch { /* try next */ }
}
if (!mod) {
    console.log('  SKIP: 无法解析 @ast-grep/napi（源树与安装副本都不可用）')
    process.exit(0)
}
console.log(`  （模块来源：${used.includes('node_modules') ? used.split('node_modules/')[1].split('/lib')[0] + ' 安装副本' : '源树'}）`)

let failures = 0
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }
const throws = async (fn) => { try { await fn(); return null } catch (e) { return e.message } }

// 捕获注册的工具（search.apply 走 ctx.tools.register）
const tools = []
mod.apply({ tools: { register: (t) => tools.push(t) } })
const by = (n) => tools.find((t) => t.name === n)
const render = (name, value) => by(name).output.render({}, value).map((p) => p.text).join('\n')

console.log('== 0. 注册 ==')
ok('注册了 3 个只读工具（帮助已移出本模块；ast_edit 在 ast/edit.js）', tools.length === 3, tools.map((t) => t.name).join(','))
ok('名字符合预期（三个都带 ast_ 前缀 ⇒ 同一命名空间）', tools.map((t) => t.name).sort().join(',') === 'ast_dump_tree,ast_search,ast_test_rule')

console.log('== 1. ast_dump_tree ==')
{
    const dump = by('ast_dump_tree')
    const cst = await dump.execute({ code: 'const a = 1;', language: 'typescript' })
    ok('cst 有内容', cst.startsWith('Debug CST:') && cst.includes('lexical_declaration'), cst.split('\n')[1]?.slice(0, 40) ?? '')
    const ast = await dump.execute({ code: 'const a = 1;', language: 'typescript', format: 'ast' })
    ok('ast 只列具名节点', ast.startsWith('Debug AST:') && !ast.includes('"const"'))
    const pat = await dump.execute({ code: 'const $A = $B;', language: 'typescript', format: 'pattern' })
    ok('pattern 显示 kind + text', pat.includes('const $A = $B;'), pat.split('\n')[1]?.slice(0, 40) ?? '')
    ok('非法 format 报错', (await throws(() => dump.execute({ code: 'a', language: 'typescript', format: 'nope' }))) !== null)
    const capped = await dump.execute({ code: 'function f() { const a = 1; const b = 2; }', language: 'typescript', max_nodes: 5 })
    ok('max_nodes 触发的提示说的是 max_nodes（上游会误报成 depth）', /max_nodes=5/.test(capped) && !/at depth/.test(capped), capped.split('\n').pop()?.slice(0, 60) ?? '')
    const deep = await dump.execute({ code: 'a(b(c(d(e(f(g(1)))))))', language: 'javascript', max_depth: 3 })
    ok('max_depth 触发的提示说的是 max_depth', /max_depth=3/.test(deep), deep.split('\n').pop()?.slice(0, 60) ?? '')
    ok('超长源码报错', (await throws(() => dump.execute({ code: 'x'.repeat(2_000_001), language: 'javascript' }))) !== null)
}

console.log('== 2. ast_search ==')
{
    const search = by('ast_search')
    const r = await search.execute({ source: 'foo(a); foo(b); bar(c);', pattern: 'foo($A)', language: 'javascript' })
    ok('命中计数与内容', r.count === 2 && r.matches.length === 2, `count=${r.count}`)
    ok('行号是 1-based', r.matches[0].range.start.line === 1, JSON.stringify(r.matches[0].range.start))
    const cap = await search.execute({ source: 'foo(a); foo(b); foo(c);', pattern: 'foo($A)', language: 'javascript', capture_names: ['A'] })
    ok('capture_names 回传捕获（数组，含 kind/range）', cap.matches[0].captures.A?.[0]?.text === 'a' && cap.matches[0].captures.A[0].kind === 'identifier', JSON.stringify(cap.matches[0].captures.A))
    const lim = await search.execute({ source: 'foo(a); foo(b); foo(c);', pattern: 'foo($A)', language: 'javascript', max_matches: 2 })
    ok('max_matches 生效且 count 仍是总数', lim.matches.length === 2 && lim.count === 3 && lim.truncated === true, `count=${lim.count} shown=${lim.matches.length}`)
    const clip = await search.execute({ source: 'foo("' + 'x'.repeat(50) + '");', pattern: 'foo($A)', language: 'javascript', max_match_chars: 10 })
    ok('max_match_chars 裁剪并标记', clip.matches[0].truncated === true && clip.matches[0].text.length === 10)
    ok('大写入参校验：language 非法', (await throws(() => search.execute({ source: 'a', pattern: 'a', language: 'brainfuck' }))) !== null)
    ok('pattern 为空报错', (await throws(() => search.execute({ source: 'a', pattern: '', language: 'javascript' }))) !== null)
    ok('capture_names 小写被拒', /uppercase/.test((await throws(() => search.execute({ source: 'foo(a)', pattern: 'foo($A)', language: 'javascript', capture_names: ['a'] }))) ?? ''))
    ok('capture_names 超过 20 个被拒', (await throws(() => search.execute({ source: 'a', pattern: 'a', language: 'javascript', capture_names: Array.from({ length: 21 }, (_, i) => `X${i}`) }))) !== null)
    const zero = await search.execute({ source: 'nothing here', pattern: 'foo($A)', language: 'javascript' })
    ok('0 命中是正常结果（count=0，不抛错）', zero.count === 0 && zero.matches.length === 0)

 // **回归护栏（MCMOD 复核抓到的真回归）**：`paths` + `capture_names` 曾 100% 抛
    // `node.getMultipleMatches is not a function`（captures 构造里把字符串当 node 传）——
    // 内联模式有覆盖、`paths` 模式**零覆盖**，所以这里补上这个组合。
    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-paths-cap-'))
    writeFileSync(join(dir, 'a.js'), 'foo(a);\nfoo(bb);\nconst other = 1;\n')
    try {
        const viaPaths = await search.execute({ paths: [join(dir, 'a.js')], pattern: 'foo($A)', capture_names: ['A'] })
        ok('paths + capture_names 可用（曾 TypeError）', viaPaths.count === 2 && viaPaths.matches[0].captures.A?.[0]?.text === 'a',
            `count=${viaPaths.count} cap=${JSON.stringify(viaPaths.matches[0]?.captures?.A?.[0]?.text)}`)
        ok('paths 结果带 file/line/column', typeof viaPaths.matches[0].file === 'string' && viaPaths.matches[0].line >= 1, JSON.stringify({ f: viaPaths.matches[0].file, l: viaPaths.matches[0].line }))
        ok('paths 模式报告扫描文件数', viaPaths.filesSearched === 1 && viaPaths.filesWithHits === 1, `searched=${viaPaths.filesSearched} hits=${viaPaths.filesWithHits}`)
        // 目录 + glob 也走一遍（语言按扩展名判定）
        const viaGlob = await search.execute({ paths: [join(dir, '*.js')], pattern: 'foo($$$ARGS)', capture_names: ['ARGS'] })
        ok('paths 支持 glob 且自动判定语言', viaGlob.count >= 2 && Array.isArray(viaGlob.matches[0].captures.ARGS), `count=${viaGlob.count}`)
        ok('source 与 paths 同给报错', (await throws(() => search.execute({ source: 'foo(a);', paths: [dir], pattern: 'foo($A)', language: 'javascript' }))) !== null)
        // 依赖目录：**默认跳过，但必须说出来**（静默漏文件比搜得慢危险）—— 另有两条逃生门
        mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
        writeFileSync(join(dir, 'node_modules', 'dep', 'b.js'), 'foo(hidden);\n')
        const skippedNM = await search.execute({ paths: [dir], pattern: 'foo($A)' })
        ok('默认跳过 node_modules 并**如实回报**跳过数', skippedNM.nodeModulesSkipped === 1 && skippedNM.count === 2, `skipped=${skippedNM.nodeModulesSkipped} count=${skippedNM.count}`)
        const skippedText = search.output.render({}, skippedNM).map((c) => c.text).join('')
        ok('输出里说明"跳过了什么、怎么带上"', /已跳过 1 个 node_modules 目录/.test(skippedText) && /include_vendored:true/.test(skippedText))
        const vendored = await search.execute({ paths: [dir], pattern: 'foo($A)', include_vendored: true })
        ok('include_vendored:true 就连依赖一起搜', vendored.count === 3 && vendored.nodeModulesSkipped === 0, `count=${vendored.count}`)
        const explicitNM = await search.execute({ paths: [join(dir, 'node_modules')], pattern: 'foo($A)' })
        ok('显式写 node_modules 路径 ⇒ 自动放行（不用记开关）', explicitNM.count === 1 && explicitNM.nodeModulesSkipped === 0, `count=${explicitNM.count}`)
        // 分页：每页 500 文件（MAX_PATH_FILES）。造 501 个文件 ⇒ 第 1 页应报 limitReached + nextOffset=500，
        // 第 2 页（offset:500）搜剩下那个、不再给 nextOffset，且**两页文件集合不重不漏**。
        const pageDir = mkdtempSync(join(tmpdir(), 'dsh-paths-page-'))
        try {
            const N = 501
            for (let i = 0; i < N; i += 1) writeFileSync(join(pageDir, `f${String(i).padStart(4, '0')}.js`), 'foo(paged);\n')
            const p1 = await search.execute({ paths: [pageDir], pattern: 'foo($A)', max_matches: 200 })
            ok('第 1 页只搜 500 个文件并报 limitReached', p1.filesSearched === 500 && p1.limitReached === true && p1.offset === 0, `searched=${p1.filesSearched}`)
            ok('第 1 页给出 nextOffset=500（而不是只说"被截断"）', p1.nextOffset === 500, `nextOffset=${p1.nextOffset}`)
            const p1Text = search.output.render({}, p1).map((c) => c.text).join('')
            ok('输出里明确"怎么取下一页"', /offset:500/.test(p1Text) && /还有更多/.test(p1Text))
            const p2 = await search.execute({ paths: [pageDir], pattern: 'foo($A)', offset: p1.nextOffset, max_matches: 200 })
            ok('第 2 页搜剩下的 1 个文件、不再给 nextOffset', p2.filesSearched === 1 && p2.limitReached === false && p2.nextOffset === undefined, `searched=${p2.filesSearched} next=${p2.nextOffset}`)
            // 不重不漏：两页合计 501 个文件、各 1 处命中（用 count/filesWithHits 判，**不是** matches ——
            // matches 受 max_matches 限制，那是"页内命中截断"，与"文件分页"是两件事）
            ok('两页合计 = 501 个文件各 1 处（不重不漏）', p1.count === 500 && p1.filesWithHits === 500 && p2.count === 1 && p2.filesWithHits === 1,
                `p1=${p1.count}/${p1.filesWithHits} p2=${p2.count}/${p2.filesWithHits}`)
            ok('页内命中超 max_matches 时报 truncated（与文件分页分开报）', p1.truncated === true && p2.truncated === false, `p1.truncated=${p1.truncated}`)
            ok('offset 超过文件总数 ⇒ 空页且不报错', (await search.execute({ paths: [pageDir], pattern: 'foo($A)', offset: 10_000 })).count === 0)
        }
        finally { rmSync(pageDir, { recursive: true, force: true }) }
        // text_mode：默认 `line` 只给首行（多行节点是最贵的一种），`node` 才是旧行为，`none` 完全不给
        const multi = join(dir, 'multi.js')
        writeFileSync(multi, 'function big() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n')
        const bigPat = 'function big() { $$$BODY }'
        const lineMode = await search.execute({ paths: [multi], pattern: bigPat })
        ok('默认 text_mode=line：多行节点只给首行（无换行）', !String(lineMode.matches[0]?.text ?? '').includes('\n') && String(lineMode.matches[0]?.text).startsWith('function big()'), JSON.stringify(lineMode.matches[0]?.text?.slice(0, 40)))
        ok('压成一行时如实标 truncated（别被当成节点全文）', lineMode.matches[0].truncated === true)
        const nodeMode = await search.execute({ paths: [multi], pattern: bigPat, text_mode: 'node' })
        ok('text_mode:"node" = 整段原文（含换行，旧行为）', String(nodeMode.matches[0]?.text ?? '').includes('\n') && nodeMode.matches[0].truncated === false)
        const noneMode = await search.execute({ paths: [multi], pattern: bigPat, text_mode: 'none' })
        ok('text_mode:"none" 不给 text 字段（只要 file/line/kind）', noneMode.matches[0].text === undefined && noneMode.matches[0].kind === 'function_declaration')
        ok('没要 capture_names 时不输出空 captures 字段', lineMode.matches[0].captures === undefined)
        const withCap = await search.execute({ paths: [multi], pattern: bigPat, capture_names: ['BODY'] })
        ok('要了 capture_names 才输出 captures', Array.isArray(withCap.matches[0].captures?.BODY))
        ok('非法 text_mode 落回默认 line（不报错）', (await search.execute({ paths: [multi], pattern: bigPat, text_mode: 'bogus' })).matches[0].truncated === true)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log('== 3. ast_test_rule ==')
{
    const test = by('ast_test_rule')
    const yaml1 = 'id: demo\nlanguage: javascript\nrule:\n  pattern: foo($A)\n'
    const r1 = await test.execute({ code: 'foo(x); bar(y);', yaml: yaml1 })
    ok('命中 1 处', Array.isArray(r1) && r1.length === 1, JSON.stringify(r1).slice(0, 80))
    ok('single 捕获有 A', r1[0].metaVariables.single.A?.text === 'x', JSON.stringify(r1[0].metaVariables.single))
    ok('ruleId/severity 回显', r1[0].ruleId === 'demo' && r1[0].severity === 'hint')

    // 回归：$$$ARGS 只捕获 1 个节点时必须出现在 multi 里（上游用 >1 过滤 ⇒ 消失）
    const yamlMulti1 = 'id: m1\nlanguage: javascript\nrule:\n  pattern: foo($$$ARGS)\n'
    const r2 = await test.execute({ code: 'foo(only);', yaml: yamlMulti1 })
    ok('$$$ARGS 捕获 1 个节点时出现在 multi', Boolean(r2[0].metaVariables.multi.ARGS) && r2[0].metaVariables.multi.ARGS.length === 1, JSON.stringify(r2[0].metaVariables.multi))
    const r3 = await test.execute({ code: 'foo(a, b);', yaml: yamlMulti1 })
    ok('$$$ARGS 捕获 2 个参数时 multi 有内容', (r3[0].metaVariables.multi.ARGS ?? []).some((x) => x.text === 'a') && (r3[0].metaVariables.multi.ARGS ?? []).some((x) => x.text === 'b'), JSON.stringify((r3[0].metaVariables.multi.ARGS ?? []).map((x) => x.text)))
    const r4 = await test.execute({ code: 'foo();', yaml: yamlMulti1 })
    ok('$$$ARGS 捕获 0 个时仍是"命中但无捕获"', r4.length === 1 && Object.keys(r4[0].metaVariables.multi).length === 0)

    // 回归：0 命中不是错误
    const empty = await test.execute({ code: 'nothing matches here', yaml: yaml1 })
    ok('0 命中返回空数组（不抛错）', Array.isArray(empty) && empty.length === 0)
    const rendered = render('ast_test_rule', empty)
    ok('0 命中时 renderer 给出可操作建议', /No matches/.test(rendered) && /stopBy: end/.test(rendered), rendered.slice(0, 70))
    // 渲染改成"一行/命中"（原先是原样打上游 JSON：一条命中 ≈331 tok，而它要回答的只是"命中了什么"）
    const oneLine = render('ast_test_rule', r1)
    ok('有命中时 renderer 给一行/命中（区间 + 元变量，不是整段 JSON）',
        /demo @ STDIN 1:1-1:\d+ · foo\(x\)/.test(oneLine) && /\[A=x\]/.test(oneLine) && !/"ruleId"/.test(oneLine),
        oneLine.slice(0, 90))

    ok('YAML 非法报错', (await throws(() => test.execute({ code: 'a', yaml: 'rule: [' }))) !== null)
    ok('缺 id 报错', (await throws(() => test.execute({ code: 'a', yaml: 'language: javascript\nrule:\n  pattern: a\n' }))) !== null)
    ok('language 非法报错', (await throws(() => test.execute({ code: 'a', yaml: 'id: x\nlanguage: nope\nrule:\n  pattern: a\n' }))) !== null)
    ok('缺 rule 对象报错', (await throws(() => test.execute({ code: 'a', yaml: 'id: x\nlanguage: javascript\nrule: 1\n' }))) !== null)
    ok('code 为空报错', (await throws(() => test.execute({ code: '', yaml: yaml1 }))) !== null)
}

// 4. 原 `ast_grep_help` 已并入 toolkit_help（工具面收敛）：
//    这里只断言"AST 模块不再自带帮助工具"，规则主题本身由 lib/help/index.js 提供
//    （主题↔文档的漂移检查在 help-topics-selftest.mjs / 取回行为在 toolkit-help 侧）。
console.log('== 4. ast_grep_help 已移出本模块（并入 toolkit_help）==')
{
    ok('AST 模块不再注册 ast_grep_help', by('ast_grep_help') === undefined)
    const { HELP_TOPICS, HELP_SOURCE } = await import('../lib/ast/help-topics.js')
    ok('规则主题表仍是零依赖数据（供合并后的帮助工具用）', Object.keys(HELP_TOPICS).length === 7 && HELP_SOURCE.license === 'MIT', Object.keys(HELP_TOPICS).join(','))
    const helpMod = await import('../lib/help/index.js')
    const merged = helpMod.tools((t) => t).find((t) => t.name === 'toolkit_help')
    const atomic = String(await merged.execute({ topic: 'atomic' }, { agent: { session: { header: { cwd: process.cwd() } } } }))
    ok('合并后的 toolkit_help 能取到 atomic 规则小节', /原子规则/.test(atomic), atomic.split('\n')[0]?.slice(0, 44) ?? '')
    ok('并回显上游出处（MIT + commit）', /上游出处（MIT）/.test(atomic) && /ast-grep-mcp/.test(atomic))
    let unknown = ''
    try { await merged.execute({ topic: 'nope' }, {}) } catch (e) { unknown = String(e.message) }
    ok('未知主题报错', unknown.includes('unsupported help topic') || unknown.includes('可用'), unknown.slice(0, 60))
}

console.log('== 5. 文档新鲜度（help 读的是合并后的 TOOLKIT.md）==')
{
    const docPath = join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/docs/TOOLKIT.md')
    let doc = ''
    try { doc = readFileSync(docPath, 'utf8') } catch { doc = '' }
    ok('副本里的 TOOLKIT.md 已是中文版 ast-rules', doc === '' || doc.includes('### 3. 原子规则：基本匹配构件'), doc === '' ? '(副本 docs 缺失，已跳过)' : '')
}

console.log('== 6. action:"diff"：文件 vs 拟写入内容（只读，不落盘）==')
{
    // 这一段原先在 ast-edit-selftest 里（工具还叫 ast_edit 的 action）；按"diff 属于只读侧"的定名搬过来了。
    const search = by('ast_search')
    const dir = mkdtempSync(join(tmpdir(), 'ast-diff-'))
    try {
        const D = join(dir, 'a.js')
        writeFileSync(D, 'const a = 1\nconst b = 2\nconst c = 3\n')
        const show = async (args) => {
            const callArgs = { action: 'diff', ...args }
            const v = await search.execute(callArgs)
            return { v, text: search.output.render(callArgs, v).map((c) => c.text).join('') }
        }
        const same = await show({ paths: [D], content: 'const a = 1\nconst b = 2\nconst c = 3\n' })
        ok('内容相同 ⇒ identical 且报"无差异"', same.v.diff?.identical === true && /No differences/.test(same.text))
        ok('内容相同 ⇒ added/removed 都是 0、before/after revision 相等',
            same.v.diff?.added === 0 && same.v.diff?.removed === 0 && same.v.diff?.before?.revision === same.v.diff?.after?.revision)
        ok('diff **绝不写盘**', readFileSync(D, 'utf8') === 'const a = 1\nconst b = 2\nconst c = 3\n')

        const one = await show({ paths: [D], content: 'const a = 1\nconst b = 2\nconst c = 4\n' })
        ok('改一行 ⇒ +1 −1，给出 hunk 头与 -/+ 行',
            one.v.diff?.added === 1 && one.v.diff?.removed === 1 && /@@ -3 \+3 @@/.test(one.text) && /-const c = 3/.test(one.text) && /\+const c = 4/.test(one.text))
        ok('改一行 ⇒ 路径只出现一次（不是每行都带路径）', (one.text.match(/a\.js/g) ?? []).length === 1)
        ok('改一行 ⇒ after.revision = 拟写入内容的 sha256', one.v.diff?.after?.revision === createHash('sha256').update('const a = 1\nconst b = 2\nconst c = 4\n', 'utf8').digest('hex'))

        // CRLF 文件 vs LF 内容：行尾差异**不能**被当成"每行都改了"
        const C = join(dir, 'crlf.js')
        writeFileSync(C, 'const a = 1\r\nconst b = 2\r\n')
        const crlf = await show({ paths: [C], content: 'const a = 1\nconst b = 3\n' })
        ok('CRLF 文件 + LF 内容、只改一行 ⇒ 只报 1 处（行尾已归一）', crlf.v.diff?.added === 1 && crlf.v.diff?.removed === 1, `+${crlf.v.diff?.added}/-${crlf.v.diff?.removed}`)
        ok('行尾差异会被点明（不是悄悄吞掉）', /crlf/.test(crlf.text) && /lf/.test(crlf.text))
        const eolOnly = await show({ paths: [C], content: 'const a = 1\nconst b = 2\n' })
        ok('正文相同、仅行尾不同 ⇒ eolOnly=true 且说清"正文未变"',
            eolOnly.v.diff?.eolOnly === true && eolOnly.v.diff?.identical === false && /仅行尾不同/.test(eolOnly.text))

        // BOM：比较正文，但 revision 按"写进去之后的字节"算
        const B = join(dir, 'bom.js')
        writeFileSync(B, `\uFEFFconst x = 1\n`)
        const bom = await show({ paths: [B], content: 'const x = 2\n' })
        ok('BOM 文件 ⇒ 只报正文那一处改动（不是整文件）', bom.v.diff?.added === 1 && bom.v.diff?.removed === 1)
        ok('BOM 文件 ⇒ 标出"保留 BOM"', /保留 BOM/.test(bom.text) && bom.v.diff?.before?.bom === true)

        // 参数护栏
        let err = null
        try { await show({ paths: [D, C], content: 'x\n' }) } catch (e) { err = e }
        ok('给两个文件 ⇒ 明确报错（只比较一个）', err !== null && /只比较\*\*一个\*\*文件/.test(err.message), String(err?.message ?? '').slice(0, 50))
        err = null
        try { await show({ paths: [D] }) } catch (e) { err = e }
        ok('缺 content ⇒ 明确报错', err !== null && /需要 `content`/.test(err.message))
        err = null
        try { await show({ paths: [join(dir, 'nope.js')], content: 'x\n' }) } catch (e) { err = e }
        ok('文件不存在 ⇒ 报"找不到"（而不是装作没差异）', err !== null && /找不到要比较的文件/.test(err.message))
        err = null
        try { await search.execute({ action: 'bogus', pattern: 'x' }) } catch (e) { err = e }
        ok('未知 action ⇒ 明确报错并列出可用值', err !== null && /unknown action bogus/.test(err.message) && /grep \| diff/.test(err.message))
        ok('不传 action 时仍然是 grep（默认值默认不变，旧调用不受影响）', (await search.execute({ source: 'const a = 1;', pattern: 'const $A = $B;', language: 'javascript' })).count === 1)

        // ── 6b. 写盘一致性（最强不变量）：diff 报的 after.revision 必须就是"真写进去之后的字节" ──
        {
            const W = join(dir, 'writeback.js')
            writeFileSync(W, 'one\ntwo\nthree\n')
            const plan = 'one\nTWO\nthree\n'
            const d = await show({ paths: [W], content: plan })
            writeFileSync(W, plan)   // 真写进去
            const realRev = createHash('sha256').update(readFileSync(W)).digest('hex')
            ok('after.revision == 真写进去之后的 sha256', d.v.diff?.after?.revision === realRev, `${d.v.diff?.after?.revision?.slice(0, 12)} vs ${realRev.slice(0, 12)}`)
            const again = await show({ paths: [W], content: plan })
            ok('写完再 diff ⇒ identical（闭环）', again.v.diff?.identical === true)

            // BOM：文件带 BOM 时，after.revision 要按"BOM + content"算
            const WB = join(dir, 'writeback-bom.js')
            writeFileSync(WB, '\uFEFFa\nb\n')
            const dB = await show({ paths: [WB], content: 'a\nB\n' })
            writeFileSync(WB, '\uFEFFa\nB\n')
            const realRevB = createHash('sha256').update(readFileSync(WB)).digest('hex')
            ok('BOM 文件 ⇒ after.revision 也按"BOM + content"算', dB.v.diff?.after?.revision === realRevB, `${dB.v.diff?.after?.revision?.slice(0, 12)} vs ${realRevB.slice(0, 12)}`)
        }

        // ── 6c. 无副作用：只读、不落锁、不留临时文件 ──
        {
            const S = join(dir, 'side-effect.js')
            writeFileSync(S, 'x = 1\ny = 2\n')
            const beforeBytes = readFileSync(S)
            const beforeMtime = statSync(S).mtimeMs
            await new Promise((r) => setTimeout(r, 12))
            await show({ paths: [S], content: 'x = 1\ny = 9\n' })
            ok('diff 不改文件（字节 + mtime 都不动）', readFileSync(S).equals(beforeBytes) && statSync(S).mtimeMs === beforeMtime)
            ok('diff 不在目录里留临时文件/锁', !readdirSync(dir).some((n) => /dsh-tmp|\.lock$/.test(n)))
        }

        // ── 6d. 极端输入：空内容 / 空文件 / 无结尾换行 / 纯空白 / CRLF 内容 / emoji / 超长单行 / NUL ──
        {
            const E = join(dir, 'edge-empty.js')
            writeFileSync(E, 'a\nb\nc\n')
            const wipe = await show({ paths: [E], content: '' })
            ok('content 为空 ⇒ 报全部删除（不是"无差异"）', wipe.v.diff?.removed === 3 && wipe.v.diff?.identical === false && wipe.v.diff?.after?.lineCount === 0)

            const EMPTY = join(dir, 'edge-both-empty.js')
            writeFileSync(EMPTY, '')
            const both = await show({ paths: [EMPTY], content: '' })
            ok('空文件 + 空 content ⇒ identical', both.v.diff?.identical === true)

            const N = join(dir, 'edge-nonl.js')
            writeFileSync(N, 'a\nb\n')
            const noNl = await show({ paths: [N], content: 'a\nb' })
            // 行 diff 看不见"结尾换行"的差异 ⇒ 以前会误报"无差异"，但 after.revision 已经变了（写前预览会误导）
            ok('只差结尾换行 ⇒ 单独报 tailOnly，且**不**说"无差异"',
                noNl.v.diff?.tailOnly === true && noNl.v.diff?.identical === false && /结尾换行/.test(noNl.text), noNl.text.slice(0, 70))

            const WS2 = join(dir, 'edge-ws.js')
            writeFileSync(WS2, 'a\nb\n')
            const ws = await show({ paths: [WS2], content: 'a\nb  \n' })
            ok('纯空白改动也会报出来（不静默判等）', ws.v.diff?.identical === false && ws.v.diff?.added === 1)

            const LF = join(dir, 'edge-lf.js')
            writeFileSync(LF, 'a\nb\n')
            const crlfContent = await show({ paths: [LF], content: 'a\r\nb\r\n' })
            ok('文件 LF、content 是 CRLF ⇒ 只报"行尾不同"（eolOnly）', crlfContent.v.diff?.eolOnly === true && crlfContent.v.diff?.identical === false)

            const U = join(dir, 'edge-unicode.js')
            writeFileSync(U, '中文 😀\n')
            const uni = await show({ paths: [U], content: '中文 🚀\n' })
            ok('emoji / 中文 ⇒ 正常 1 处、字节数按 UTF-8 算', uni.v.diff?.added === 1 && uni.v.diff?.after?.bytes === Buffer.byteLength('中文 🚀\n', 'utf8'))

            const LONG = join(dir, 'edge-long.js')
            writeFileSync(LONG, `${'x'.repeat(20_000)}\n`)
            const longLine = await show({ paths: [LONG], content: `${'x'.repeat(20_000)}y\n` })
            ok('2 万字符单行 ⇒ 仍只有 1 处、不崩', longLine.v.diff?.added === 1 && longLine.v.diff?.removed === 1)

            const NUL = join(dir, 'edge-nul.js')
            writeFileSync(NUL, 'a\nb\n')
            let nulErr = null
            let nulResult = null
            try { nulResult = await show({ paths: [NUL], content: 'a\u0000b\n' }) } catch (e) { nulErr = e }
            ok('content 里带 NUL ⇒ 不崩（要么正常给出 diff、要么明确报错）', nulErr === null ? nulResult.v.diff !== undefined : /Error|不支持|binary/i.test(nulErr.message))
        }

        // ── 6e. 大 diff 的截断与"近似对齐"标记 ──
        {
            const BIG = join(dir, 'edge-big.js')
            writeFileSync(BIG, Array.from({ length: 400 }, (_, i) => `old line ${i}`).join('\n') + '\n')
            const big = await show({ paths: [BIG], content: Array.from({ length: 400 }, (_, i) => `new line ${i}`).join('\n') + '\n' })
            ok('超 240 行 diff ⇒ truncated=true 且正文给出"另有 N 行未展示"', big.v.truncated === true && /另有 \d+ 行未展示/.test(big.text))

            const APPROX = join(dir, 'edge-approx.js')
            const n = 2_100
            writeFileSync(APPROX, Array.from({ length: n }, (_, i) => `a${i}`).join('\n') + '\n')
            const approx = await show({ paths: [APPROX], content: Array.from({ length: n - 100 }, (_, i) => `b${i}`).join('\n') + '\n' })
            ok('中间窗口过大 ⇒ approximate=true（不假装做过真正的行对齐）', approx.v.diff?.approximate === true && /近似对齐/.test(approx.text))
        }

        // ── 6f. 确定性与路径形态 ──
        {
            const P = join(dir, 'path-form.js')
            writeFileSync(P, 'k = 1\n')
            const a1 = await show({ paths: [P], content: 'k = 2\n' })
            const a2 = await show({ paths: [P], content: 'k = 2\n' })
            ok('同一调用两次 ⇒ 渲染逐字节一致（可复现）', a1.text === a2.text)
            const twice = await show({ paths: [P, P], content: 'k = 2\n' })
            ok('同一个文件写两遍 ⇒ 去重后照常工作（不报"两个文件"）', /path-form\.js$/.test(String(twice.v.diff?.path)), String(twice.v.diff?.path))
            const fwd = await show({ paths: [P.replace(/\\/g, '/')], content: 'k = 2\n' })
            ok('正斜杠路径也能用', /path-form\.js$/.test(String(fwd.v.diff?.path)), String(fwd.v.diff?.path))
        }
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

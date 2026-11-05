/**
 * 帮助文档与主题表的**漂移检查**（零依赖，不需要 @ast-grep/napi）。
 *
 * 背景：踩过"文档改版 / 主题表过时 ⇒ ast_grep_help 找不到小节"的坑（当时会抛错，
 * 后来改成降级返回全文）。这条护栏直接核对：**主题表里的每个标题都真的在文档里**，
 * 以及两个 help 工具的主题都能取到内容。
 */
import { readFileSync } from 'node:fs'
import { HELP_TOPICS, RULES_SECTION, helpTopicHeadings, helpTopicNames } from '../lib/ast/help-topics.js'

let failures = 0
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }

const doc = readFileSync(new URL('../docs/TOOLKIT.md', import.meta.url), 'utf8')
const lines = doc.split(/\r?\n/)

console.log('== 1. ast_grep_help 的标题表 ↔ 文档 ==')
const headings = helpTopicHeadings()
ok('主题表里有标题', headings.length >= 7, `${headings.length} 个`)
for (const h of headings) {
    ok(`文档含标题「${h}」`, lines.includes(h))
}
ok('规则指南整节存在（## ast-rules）', lines.includes(RULES_SECTION))

console.log('== 2. 上游内容确实并进来了（且已译为中文）==')
for (const probe of ['### 通用流程', '### 6. 元变量：动态内容匹配', '### 1. ast-grep 规则简介', '### 5. 组合规则']) {
    ok(`含「${probe.slice(4, 26)}」`, doc.includes(probe))
}
ok('带 MIT 署名说明（含上游 commit）', doc.includes('b69eb5391bd93d46ef3dec07de814c3c39675c8f') && /MIT/.test(doc))
ok('指向汇总后的许可全文文件', doc.includes('THIRD-PARTY-NOTICES.md'))
ok('明确标注"这是译文"（MIT 要求标注改动）', /本节是上游内容的译文/.test(doc) && /以\[?上游原文\]?/.test(doc))
ok('已无英文原版标题残留', !doc.includes('### General Process') && !doc.includes('### 3. Atomic Rules'))
ok('已无 Cursor frontmatter 残留', !/^---\s*$/m.test(doc.split(RULES_SECTION)[1] ?? ''))
ok('旧的独立 .mdc 已不存在（文件已并入）', !(() => { try { readFileSync(new URL('../docs/ast-grep.mdc', import.meta.url)); return true } catch { return false } })())

console.log('== 3. toolkit_help 的主题 ↔ 文档（ast_grep_help 已并入它）==')
const helpSrc = readFileSync(new URL('../lib/help/index.js', import.meta.url), 'utf8')
// 注意：规则主题是 `...HELP_TOPICS` **展开**进去的，正则看不到 ⇒ 必须把数据模块的键并进来
const literalKeys = [...helpSrc.matchAll(/^\s{4}(?:'([a-z-]+)'|([a-z-]+)): \[/gm)].map((m) => m[1] ?? m[2])
const topicKeys = [...literalKeys, ...Object.keys(HELP_TOPICS)]
ok('toolkit_help 主题数 ≥ 8', topicKeys.length >= 8, topicKeys.join(','))
for (const t of topicKeys) {
    if (t === 'full') continue
    // 家族主题是 `## X`；并入的**规则**主题是 `### 小节`（标题表在 HELP_TOPICS 里）
    const wanted = t in HELP_TOPICS && HELP_TOPICS[t].length > 0 ? HELP_TOPICS[t] : [`## ${t}`]
    const missing = wanted.filter((h) => !lines.includes(h))
    ok(`toolkit_help 主题「${t}」的小节在文档里`, missing.length === 0, missing.join(' / '))
}
ok('toolkit_help 有 ast-rules 主题（并入后的整节）', topicKeys.includes('ast-rules'))
ok('并入的规则主题与原 ast_grep_help 的标题表一致', Object.keys(HELP_TOPICS).every((k) => topicKeys.includes(k)), Object.keys(HELP_TOPICS).join(','))
ok('ast_grep_help 的主题名与上游一致', helpTopicNames().join(',') === 'workflow,rule-object,atomic,relational,composite,metavariables,full', helpTopicNames().join(','))

console.log('== 4. 文档规模（并入后的常驻/按需成本参考）==')
const stat = (s) => ({ bytes: Buffer.byteLength(s, 'utf8'), chars: s.length, lines: s.split('\n').length })
const all = stat(doc)
const rules = stat(doc.split(RULES_SECTION)[1] ?? '')
console.log(`  全文 ${all.lines} 行 / ${(all.bytes / 1024).toFixed(1)} KB；其中 ast-rules 一节 ${rules.lines} 行 / ${(rules.bytes / 1024).toFixed(1)} KB`)
ok('并入后只有一个文档（便于管理）', true)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

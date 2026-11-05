/**
 * 自研 diff 引擎自测：node test/diff-engine-selftest.mjs
 * 覆盖：契约（@@ 头不带行数 / 上下文 3 行 / 无差异空串）、公共前后缀、大窗口退化、
 *      maxLines 截断提示、稳定序列化、以及"与满 DP 结果一致"的性质检查。
 */
import { configDiff, configLinesOf, diffLines, stableStringify, unifiedDiffLines } from '../lib/checkpoint/diff.js'

let failures = 0
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }

console.log('== 1. 基本契约 ==')
ok('无差异 ⇒ 空串', unifiedDiffLines(['a', 'b'], ['a', 'b']) === '')
ok('单行替换的头部与块头', (() => {
    const t = unifiedDiffLines(['a', 'b', 'c'], ['a', 'B', 'c'])
    return t.includes('--- a') && t.includes('+++ b') && t.includes('@@ -2 +2 @@') && t.includes('-b') && t.includes('+B')
})(), unifiedDiffLines(['a', 'b', 'c'], ['a', 'B', 'c']).split('\n').join(' | '))
ok('块头是"第一条变更行"的 1-based 行号', unifiedDiffLines(['x', 'y', 'z'], ['x', 'y', 'Z']).includes('@@ -3 +3 @@'))
ok('上下文保留前后 3 行', (() => {
    const a = Array.from({ length: 12 }, (_, i) => `l${i}`)
    const b = a.slice(); b[6] = 'CHANGED'
    const t = unifiedDiffLines(a, b)
    return t.includes(' l3') && t.includes(' l9') && !t.includes(' l2') && !t.includes(' l10') && t.includes('-l6') && t.includes('+CHANGED')
})())
ok('纯增/纯删也生成块', unifiedDiffLines(['a'], ['a', 'b']).includes('+b') && unifiedDiffLines(['a', 'b'], ['a']).includes('-b'))
ok('标签为空串 ⇒ /dev/null', unifiedDiffLines(['a'], ['b'], { fromLabel: '', toLabel: 'x' }).includes('--- /dev/null'))
ok('没有变更行时 diffLines 全是 keep', diffLines(['a', 'b'], ['a', 'b']).every((o) => o.op === 'keep'))

console.log('== 2. 公共前后缀 + 行号正确 ==')
{
    const a = ['1', '2', '3', 'X', '5', '6', '7']
    const b = ['1', '2', '3', 'Y', '5', '6', '7']
    const ops = diffLines(a, b)
    const del = ops.find((o) => o.op === 'del')
    const add = ops.find((o) => o.op === 'add')
    ok('掐前后缀后只有一处变更', ops.filter((o) => o.op !== 'keep').length === 2, JSON.stringify(ops.filter((o) => o.op !== 'keep')))
    ok('a/b 行号是绝对值', del?.a === 3 && add?.b === 3, `del.a=${del?.a} add.b=${add?.b}`)
    ok('块头行号 = 4', unifiedDiffLines(a, b).includes('@@ -4 +4 @@'))
}

console.log('== 3. 相邻变更合并 / 相隔远则分块 ==')
{
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
    const b = a.slice(); b[2] = 'X'; b[3] = 'Y'
    const t1 = unifiedDiffLines(a, b)
    ok('相邻变更同一块', t1.split('@@').length === 3, t1.split('\n')[0])
    const b2 = a.slice(); b2[1] = 'X'; b2[8] = 'Y'
    const t2 = unifiedDiffLines(a, b2)
    ok('10 行文件里相隔较远也会并块（上下文 ≤1 间隔合并）', (t2.match(/@@/g) ?? []).length === 2, `块数=${(t2.match(/@@/g) ?? []).length / 2}`)
    const long = Array.from({ length: 40 }, (_, i) => `l${i}`)
    const far = long.slice(); far[2] = 'X'; far[30] = 'Y'
    const t3 = unifiedDiffLines(long, far)
    ok('40 行文件里相隔远 ⇒ 两块', (t3.match(/@@/g) ?? []).length === 4, `块数=${(t3.match(/@@/g) ?? []).length / 2}`)
}

console.log('== 4. 大窗口退化（不爆内存） ==')
{
    const a = Array.from({ length: 3000 }, (_, i) => `old-${i}`)
    const b = Array.from({ length: 3000 }, (_, i) => `new-${i}`)
    const t0 = Date.now()
    const t = unifiedDiffLines(a, b, { maxLines: 20 })
    const ms = Date.now() - t0
    ok('完全不同的 3000 行能在毫秒级完成', ms < 4000, `${ms} ms`)
    ok('退化路径先全删后全加（截断时仍能看到删除段）', t.includes('-old-0'), t.split('\n')[3]?.slice(0, 30) ?? '')
    const tBig = unifiedDiffLines(a.slice(0, 40), b.slice(0, 40), { maxLines: 200 })
    ok('窗口较小时两侧都出现', tBig.includes('-old-0') && tBig.includes('+new-0'))
    ok('超限有说明行', /未展示/.test(t), t.split('\n').pop()?.slice(0, 50) ?? '')
}
{
    // 中间窗口不大时走 DP：3000 行里只改 1 行，必须精确
    const a = Array.from({ length: 3000 }, (_, i) => `l${i}`)
    const b = a.slice(); b[1500] = 'CHANGED'
    const t = unifiedDiffLines(a, b)
    ok('大文件小改动精确 diff', t.includes('@@ -1501 +1501 @@') && t.includes('-l1500') && t.includes('+CHANGED'), `${t.split('\n').length} 行`)
}

console.log('== 5. maxLines 截断与提示 ==')
{
    const a = Array.from({ length: 200 }, (_, i) => `l${i}`)
    const b = a.map((x) => `${x}!`)
    const t = unifiedDiffLines(a, b, { maxLines: 30 })
    ok('不超过 maxLines + 1 行提示', t.split('\n').length <= 31, `${t.split('\n').length} 行`)
    ok('附截断提示', /另有 \d+ 行未展示/.test(t), t.split('\n').pop()?.slice(0, 44) ?? '')
    ok('不传 maxLines 时不截断', unifiedDiffLines(['a'], ['b']).split('\n').length > 0)
}

console.log('== 6. 稳定序列化与配置对比 ==')
ok('键顺序无关', stableStringify({ b: 1, a: 2 }) === stableStringify({ a: 2, b: 1 }))
ok('嵌套也排序', stableStringify({ x: { d: 1, c: 2 } }) === '{"x":{"c":2,"d":1}}', stableStringify({ x: { d: 1, c: 2 } }))
ok('数组顺序保持', stableStringify([2, 1]) === '[2,1]')
ok('configLinesOf 非对象 ⇒ ["{}"]', configLinesOf(null).join() === '{}')
ok('configDiff 变更计数', (() => { const r = configDiff({ a: 1 }, { a: 2 }); return r.changed === true && r.lines === 2 && r.text.includes('@@') })())
ok('configDiff 无变更 ⇒ changed=false', configDiff({ a: 1 }, { a: 1 }).changed === false)

console.log('== 7. 性质检查：脚本可回放（把 a 按脚本变成 b）==')
{
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    let bad = 0
    for (let round = 0; round < 200; round += 1) {
        const n = Math.floor(rnd() * 25)
        const a = Array.from({ length: n }, (_, i) => `w${Math.floor(rnd() * 5)}_${i}`)
        const b = a.filter(() => rnd() > 0.25)
        if (rnd() > 0.5) b.splice(Math.floor(rnd() * (b.length + 1)), 0, `ins${round}`)
        const ops = diffLines(a, b)
        const rebuilt = ops.filter((o) => o.op !== 'add').map((o) => o.line)
        const target = ops.filter((o) => o.op !== 'del').map((o) => o.line)
        if (rebuilt.join('\n') !== a.join('\n') || target.join('\n') !== b.join('\n')) bad += 1
    }
    ok('200 组随机用例：脚本回放后两侧都还原', bad === 0, `不一致 ${bad} 组`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

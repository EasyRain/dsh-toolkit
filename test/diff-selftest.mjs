/**
 * diff 规模/正确性自测：node test/diff-selftest.mjs
 * 重点证明 session_diff 不再是指数级/二次方的 LCS —— 旧实现在本机最大一对会话上需要 107 亿格 ≈41 GB。
 */
import * as S from '../lib/session/index.js'

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}

// 事件工厂：key = `${type}|${role}|||${turn}.${step}`，用 n 控制 key 是否相同
const ev = (type, role, text, n, turn = 1) => ({
    type, seq: n, time: 0,
    data: { role, turn, step: n, message: { role, content: [{ type: 'text', text }] } },
})

console.log('== correctness ==')
{
    const A = [ev('assistant/message', 'assistant', 'one', 1), ev('assistant/message', 'assistant', 'two', 2), ev('assistant/message', 'assistant', 'three', 3)]
    const B = [ev('assistant/message', 'assistant', 'one', 1), ev('assistant/message', 'assistant', 'TWO-CHANGED', 2), ev('assistant/message', 'assistant', 'four', 4)]
    const d = S.diffEvents(A, B, 10)
    ok('changed detected', d.counts.changed === 1, JSON.stringify(d.counts))
    ok('removed detected', d.counts.removed === 1)
    ok('added detected', d.counts.added === 1)
    ok('changed carries both texts', d.changed[0].a === 'two' && d.changed[0].b === 'TWO-CHANGED')
}
{
    // 重复 key：正序配对，多出来的算 removed
    const A = [ev('step/start', 'x', 'a', 5), ev('step/start', 'x', 'b', 5), ev('step/start', 'x', 'c', 5)]
    const B = [ev('step/start', 'x', 'a', 5), ev('step/start', 'x', 'b', 5)]
    const d = S.diffEvents(A, B, 10)
    ok('duplicate keys pair in order', d.counts.changed === 0 && d.counts.removed === 1 && d.counts.added === 0, JSON.stringify(d.counts))
}
{
    // 交错：B 中间多一条
    const A = [ev('t', 'r', '1', 1), ev('t', 'r', '3', 3)]
    const B = [ev('t', 'r', '1', 1), ev('t', 'r', '2', 2), ev('t', 'r', '3', 3)]
    const d = S.diffEvents(A, B, 10)
    ok('interleaved insert is "added"', d.counts.added === 1 && d.counts.removed === 0 && d.counts.changed === 0, JSON.stringify(d.counts))
}

console.log('== scale (旧 LCS 实现需要 169870*63206*4B ≈ 41 GB，必然 OOM) ==')
{
    const n = 169870
    const m = 63206
    const A = new Array(n)
    for (let i = 0; i < n; i++) A[i] = ev('assistant/message', 'assistant', `a${i}`, i)
    const B = new Array(m)
    for (let j = 0; j < m; j++) B[j] = ev('assistant/message', 'assistant', j % 5 === 0 ? `b${j}` : `a${j}`, j)   // 20% 文本不同
    const before = process.memoryUsage().heapUsed
    const t0 = Date.now()
    const d = S.diffEvents(A, B, 5)
    const ms = Date.now() - t0
    const grew = (process.memoryUsage().heapUsed - before) / 1048576
    console.log(`  ${n} x ${m} events -> ${ms} ms, heap +${grew.toFixed(1)} MB, counts=${JSON.stringify(d.counts)}`)
    ok('finishes fast (< 5 s)', ms < 5000, `${ms} ms`)
    ok('bounded memory (< 400 MB growth)', grew < 400, `${grew.toFixed(1)} MB`)
    ok('counts are plausible', d.counts.a === n && d.counts.b === m && d.counts.removed === n - m)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

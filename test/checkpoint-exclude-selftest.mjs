/**
 * checkpoint 排除/大文件行为自测：node test/checkpoint-exclude-selftest.mjs [workspaceForWalk]
 * 覆盖：排除模式匹配、.dsh-checkpoint-ignore、createCheckpoint 的 exclude + 复制预算、
 *       大文件"仅哈希"与 restore 的 not-stored 报告、prune 的 drop。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    createCheckpoint,
    listCheckpoints,
    loadCheckpoint,
    makeExcluder,
    pruneCheckpoints,
    readIgnorePatterns,
    restoreCheckpoint,
    walkWorkspace,
} from '../lib/checkpoint/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = process.env.DSH_TOOLKIT_TEST_DIR ?? join(tmpdir(), 'dsh-toolkit-selftest')
const WS = join(root, '_ck-exclude-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, 'src'), { recursive: true })
mkdirSync(join(WS, 'refs', 'uk'), { recursive: true })
mkdirSync(join(WS, 'game-data'), { recursive: true })
mkdirSync(join(WS, 'docs', 'x'), { recursive: true })
writeFileSync(join(WS, 'src', 'a.lua'), 'return { x = 1 }\n')
writeFileSync(join(WS, 'src', 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 65))
writeFileSync(join(WS, 'refs', 'uk', 'cache.sqlite'), Buffer.alloc(2 * 1024 * 1024, 66))
writeFileSync(join(WS, 'game-data', 'index.db'), 'y'.repeat(1024))
writeFileSync(join(WS, 'docs', 'x', 'note.md'), 'doc\n')
writeFileSync(join(WS, 'debug.log'), 'log\n')
writeFileSync(join(WS, '.dsh-checkpoint-ignore'), '# comment\n*.log\n')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}
const dirBytes = (d) => {
    let sum = 0
    for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        sum += e.isDirectory() ? dirBytes(p) : statSync(p).size
    }
    return sum
}

console.log('== 排除模式 ==')
{
    const m = makeExcluder(['refs', 'docs/*', '*.log', 'game-data/index.db'])
    ok('裸名匹配任意层级的同名段', m('refs\\uk\\cache.sqlite') === true)
    ok('不误伤普通源码', m('src\\a.lua') === false)
    ok('通配 *.log', m('debug.log') === true)
    ok('路径前缀 docs/*', m('docs\\x\\note.md') === true)
    ok('路径模式 game-data/index.db', m('game-data\\index.db') === true)
    ok('模式表为空时全部放行', makeExcluder([])('anything') === false)
}

console.log('== 工作区忽略文件 ==')
{
    ok('.dsh-checkpoint-ignore 被读出（# 注释跳过）', readIgnorePatterns(WS).join(',') === '*.log', JSON.stringify(readIgnorePatterns(WS)))
    const walked = walkWorkspace(WS, { exclude: ['refs', 'game-data'] })
    const rels = walked.map((f) => f.rel.replace(/\\/g, '/')).sort()
    ok('walkWorkspace 应用排除', !rels.some((r) => r.startsWith('refs/') || r.startsWith('game-data/')), rels.join(','))
    ok('walkWorkspace 报告排除计数', walked.excluded >= 2, `excluded=${walked.excluded}`)
}

console.log('== createCheckpoint：排除 + 大文件仅哈希 ==')
let rec = null
let rec2 = null
{
    rec = createCheckpoint({ cwd: WS, note: 'exclude+hash-only' })
    ok('忽略文件生效（debug.log 不在清单）', !rec.manifest.some((f) => f.rel.endsWith('debug.log')))
    ok('显式排除为空时 refs/ 仍在内（靠忽略文件）', rec.manifest.some((f) => f.rel.includes('refs')), rec.manifest.map((f) => f.rel).join(','))
    rec2 = createCheckpoint({ cwd: WS, note: 'exclude big dirs', exclude: ['refs', 'game-data'] })
    ok('exclude 参数把 refs/game-data 排除', !rec2.manifest.some((f) => /^(refs|game-data)/.test(f.rel.replace(/\\/g, '/'))))
    ok('排除计数被记录', rec2.excluded >= 2, `excluded=${rec2.excluded}`)
    ok('排除模式被记录', rec2.excludePatterns.includes('refs') && rec2.excludePatterns.includes('*.log'), JSON.stringify(rec2.excludePatterns))
    const huge = rec2.manifest.find((f) => f.rel.endsWith('huge.bin'))
    ok('3 MB 文件标记 stored=false（仅哈希）', huge !== undefined && huge.stored === false, JSON.stringify(huge))
    ok('小文件标记 stored=true', rec2.manifest.find((f) => f.rel.endsWith('a.lua'))?.stored === true)
    ok('hashOnly 计数正确', rec2.hashOnly === 1, `hashOnly=${rec2.hashOnly}`)
    const storeBytes = dirBytes(rec2.dir)
    ok('快照体积远小于工作区（大目录被排除、大文件不复制）', storeBytes < 200 * 1024, `${(storeBytes / 1024).toFixed(0)} KB`)
    ok('copiedBytes 只计实际复制的文件', rec2.copiedBytes < 100 * 1024, `${rec2.copiedBytes} B`)
    const detail = rec2.excludedDetail ?? []
    ok('excludedDetail 报每个被排除目录的体积', detail.some((d) => d.rel.replace(/\\/g, '/') === 'refs' && d.bytes >= 2 * 1024 * 1024), JSON.stringify(detail))
    ok('keptDirs 报剩余最大目录（供用户决定还该排除什么）', Array.isArray(rec2.keptDirs) && rec2.keptDirs.length > 0 && typeof rec2.keptDirs[0].dir === 'string', JSON.stringify(rec2.keptDirs))
}

console.log('== restore：not-stored 与斜杠方向 ==')
{
    const p1 = restoreCheckpoint({ id: rec2.id, files: ['src/huge.bin'], dryRun: true })
    ok('仅哈希的文件报 not-stored（正斜杠）', p1.plan[0].action.startsWith('not-stored'), JSON.stringify(p1.plan))
    const p2 = restoreCheckpoint({ id: rec2.id, files: ['src\\huge.bin'], dryRun: true })
    ok('反斜杠过滤同样认得', p2.plan[0].action.startsWith('not-stored'), JSON.stringify(p2.plan))
    const p3 = restoreCheckpoint({ id: rec2.id, files: ['src/nope.md'], dryRun: true })
    ok('真不存在的条目仍报 missing-in-snapshot', p3.plan[0].action === 'missing-in-snapshot', JSON.stringify(p3.plan))
    writeFileSync(join(WS, 'src', 'a.lua'), 'return { x = 999 } -- modified\n')
    const written = restoreCheckpoint({ id: rec2.id, files: ['src/a.lua'], dryRun: false, confirm: true })
    ok('小文件可以真回滚', written.wrote === 1, JSON.stringify(written).slice(0, 120))
    ok('回滚后内容确实还原', readFileSync(join(WS, 'src', 'a.lua'), 'utf8') === 'return { x = 1 }\n')
}

console.log('== prune：drop 定点删除 ==')
{
    const r = pruneCheckpoints(20, [rec.id])
    ok('drop 删掉指定 id', r.dropped.includes(rec.id), JSON.stringify(r.dropped))
    ok('列表里不再有它', !listCheckpoints(50).some((x) => x.id === rec.id))
    let gone = false
    try { loadCheckpoint(rec.id) }
    catch { gone = true }
    ok('loadCheckpoint 报找不到', gone)
    pruneCheckpoints(20, [rec2.id])
}

rmSync(WS, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

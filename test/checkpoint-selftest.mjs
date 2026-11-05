/**
 * checkpoint/journal 核心自测（纯 node，不需要宿主）：node test/checkpoint-selftest.mjs
 * 全程在系统临时目录（`DSH_TOOLKIT_TEST_DIR` 可覆盖）下的沙盒里跑，不碰真实工作区与 ~/.dsh。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
// 沙盒放系统临时目录（`DSH_TOOLKIT_TEST_DIR` 可覆盖）—— 不再依赖仓库外的作者目录布局
const sandbox = join(process.env.DSH_TOOLKIT_TEST_DIR ?? join(tmpdir(), 'dsh-toolkit-selftest'), '_ck-selftest')
process.env.DSH_TOOLKIT_CHECKPOINTS = sandbox.replace(/\\/g, '/')
const CK = await import('../lib/checkpoint/index.js')

const ROOT = process.env.DSH_TOOLKIT_CHECKPOINTS
if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
const WS = join(ROOT, 'ws')
mkdirSync(join(WS, 'sub'), { recursive: true })
mkdirSync(join(WS, 'node_modules', 'junk'), { recursive: true })
writeFileSync(join(WS, 'a.txt'), 'line1\nline2\nline3\n')
writeFileSync(join(WS, 'sub', 'b.md'), '# title\n\nbody\n')
writeFileSync(join(WS, 'node_modules', 'junk', 'x.js'), 'excluded\n')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}

console.log('== createCheckpoint ==')
const rec = CK.createCheckpoint({ cwd: WS, note: 'selftest' })
ok('files counted', rec.files === 2, `files=${rec.files}`)
ok('node_modules excluded', !rec.manifest.some((f) => f.rel.includes('node_modules')))

console.log('== diff ==')
writeFileSync(join(WS, 'a.txt'), 'line1\nCHANGED\nline3\nline4\n')
writeFileSync(join(WS, 'new.txt'), 'brand new\n')
rmSync(join(WS, 'sub', 'b.md'))
const d = CK.diffCheckpoint({ id: rec.id, cwd: WS, maxDiffs: 2 })
ok('added detected', d.added.includes('new.txt'), d.added.join(','))
ok('removed detected', d.removed.some((r) => r.endsWith('b.md')), d.removed.join(','))
ok('changed detected', d.changed.includes('a.txt'), d.changed.join(','))
ok('unified diff produced', d.diffs.some((x) => x.text.includes('+CHANGED')), (d.diffs[0]?.text ?? '').split('\n')[0])

console.log('== restore preview ==')
const p1 = CK.restoreCheckpoint({ id: rec.id, cwd: WS })
ok('preview writes nothing', p1.dryRun === true && p1.wrote === 0)
ok('extra files reported', p1.extraCount === 1, `extra=${p1.extraCount}`)
ok('plan has overwrite+create', p1.plan.some((p) => p.action === 'overwrite') && p1.plan.some((p) => p.action === 'create'))

console.log('== restore confirm ==')
const p2 = CK.restoreCheckpoint({ id: rec.id, cwd: WS, dryRun: false, confirm: true })
ok('two files written', p2.wrote === 2, `wrote=${p2.wrote}`)
ok('content restored', readFileSync(join(WS, 'a.txt'), 'utf8') === 'line1\nline2\nline3\n')
ok('deleted file recreated', existsSync(join(WS, 'sub', 'b.md')))
ok('extra file kept', existsSync(join(WS, 'new.txt')))

console.log('== journal ==')
const e1 = CK.capturePreImage(join(WS, 'a.txt'), { trigger: 'fs/write-intent', sessionKey: 'selftest' })
writeFileSync(join(WS, 'a.txt'), 'totally different\n')
// 显式给 cwd = 沙盒根（该文件就在它里面）：否则"调用方工作区"= 进程当前目录，
// 从别处跑这个自测时文件会被判成"在工作区之外"而拒绝
const jr = CK.journalRestore({ path: join(WS, 'a.txt'), sessionKey: 'selftest', dryRun: false, confirm: true, cwd: ROOT })
ok('journal rollback', jr.action === 'overwrite' && readFileSync(join(WS, 'a.txt'), 'utf8') === 'line1\nline2\nline3\n')
ok('duplicate capture skipped', CK.capturePreImage(join(WS, 'a.txt'), { trigger: 'fs/write-intent', sessionKey: 'selftest' }) === null)

console.log('== prune ==')
for (let i = 0; i < 3; i++) CK.createCheckpoint({ cwd: WS, note: `n${i}` })
const before = CK.listCheckpoints(99).length
const pr = CK.pruneCheckpoints(2)
ok('prune keeps exactly 2', pr.kept === 2 && CK.listCheckpoints(99).length === 2, `before=${before} removed=${pr.removed.length} kept=${pr.kept}`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

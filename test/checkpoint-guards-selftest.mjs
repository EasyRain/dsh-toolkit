/**
 * checkpoint 守卫自测：node test/checkpoint-guards-selftest.mjs
 * 覆盖体检发现的几类"静默错"：不存在的 cwd、歧义 id 前缀、相对 cwd、清单上限/体积上限的提示、
 * 原子写索引、list 显示体积。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = process.env.DSH_TOOLKIT_TEST_DIR ?? join(tmpdir(), 'dsh-toolkit-selftest')
// 测试隔离：ROOT 是模块导入时按环境变量算的，所以必须先设好再动态 import（否则会动真实 store）
const STORE = join(root, '_ck-guards-store')
process.env.DSH_TOOLKIT_CHECKPOINTS = STORE
rmSync(STORE, { recursive: true, force: true })
const { ROOT, capturePreImage, createCheckpoint, diffCheckpoint, journalRestore, estimateCheckpoint, listCheckpoints, listJournal, loadCheckpoint, pruneCheckpoints, restoreCheckpoint, tools, walkWorkspace } = await import('../lib/checkpoint/index.js')

const WS = join(root, '_ck-guards-ws')
rmSync(WS, { recursive: true, force: true })
mkdirSync(join(WS, 'inner'), { recursive: true })
writeFileSync(join(WS, 'a.txt'), 'one\n')

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}
const mine = () => listCheckpoints(200).filter((r) => r.cwd === WS || r.cwd?.startsWith(WS))

const list = tools((t) => t, { resolveWorkspaceCwd: () => WS })
// 工具面收敛：checkpoint_* 七个 ⇒ 一个 action 驱动的 `checkpoint`；这里按旧名绑定动作，
// 后面所有 `create.execute({...})` 之类的调用点保持原样（薄壳把 action 补进去）。
const bindAction = (name, action) => {
    const t = list.find((x) => x.name === 'checkpoint')
    return { name, execute: (args, exec) => t.execute({ action, ...(args ?? {}) }, exec) }
}
const create = bindAction('checkpoint_create', 'create')
const restore = bindAction('checkpoint_restore', 'restore')
const prune = bindAction('checkpoint_prune', 'prune')
const show = bindAction('checkpoint_list', 'list')
const exec = { agent: { session: { header: { cwd: WS } } } }

console.log('== 1. 不存在的 cwd 必须报错（以前静默建空快照）==')
let badCwd = null
try { await create.execute({ cwd: 'D:/definitely/not/here', note: 'x' }, exec) }
catch (e) { badCwd = e.message }
ok('cwd 不存在时抛错', badCwd !== null && /不存在/.test(badCwd), (badCwd ?? '').slice(0, 60))
ok('库层同样拒绝（直接调用）', (() => { try { createCheckpoint({ cwd: 'D:/definitely/not/here' }); return false } catch { return true } })())

console.log('== 2. 歧义 id 前缀必须报错（破坏性操作不能猜）==')
writeFileSync(join(WS, 'a.txt'), 'two\n')
const c1 = (await create.execute({ note: 'first' }, exec)).split(/\s+/)[1]
writeFileSync(join(WS, 'a.txt'), 'three\n')
const c2 = (await create.execute({ note: 'second' }, exec)).split(/\s+/)[1]
let ambiguous = null
try { loadCheckpoint('ck-') }
catch (e) { ambiguous = e.message }
ok('歧义前缀抛错并列候选', ambiguous !== null && /匹配到 \d+ 个快照/.test(ambiguous) && ambiguous.includes(c1.slice(0, 8)), (ambiguous ?? '').slice(0, 80))
ok('精确 id 仍可用', loadCheckpoint(c1).rec.id === c1)
let ambRestore = null
try { await restore.execute({ id: 'ck-' }, exec) }
catch (e) { ambRestore = e.message }
ok('restore 也拒绝歧义前缀', ambRestore !== null && /匹配到/.test(ambRestore))

console.log('== 3. 相对 cwd 以调用方会话工作区为基准 ==')
const rel = await create.execute({ cwd: 'inner', note: 'relative' }, exec)
ok('相对 cwd 被解析成会话工作区下的目录', rel.includes('checkpoint ') && /workspace: 0 files/.test(rel), rel.split('\n')[1])

console.log('== 4. list 显示体积（200 MB 那种一眼看得出）==')
const shown = await show.execute({ limit: 5 })
// 格式随 E-M6 改动：现在同时给"占盘实际大小"与"复制内容大小"（以前只加 copiedBytes，与 store 实测差几个数量级）
ok('list 带 ws / 占盘 / copied 体积', /ws [\d.]+ MB \/ 占盘 [\d.]+ (KB|MB) \(copied [\d.]+ (KB|MB)\)/.test(shown), shown.split('\n')[2] ?? '')
ok('list 头部给出占用合计（含 store 实际占用）', /store 实际占用 [\d.]+ (KB|MB)；其中快照复制内容 [\d.]+ (KB|MB)/.test(shown), shown.split('\n')[0])

console.log('== 5. walkWorkspace 上限计数（不再静默丢弃）==')
const big = join(WS, 'big.bin')
writeFileSync(big, Buffer.alloc(2048, 65))
const walked = walkWorkspace(WS, { maxBytes: 1024 })
ok('超总量上限的文件被计数', walked.overCap >= 1 && walked.overCapBytes >= 2048, `overCap=${walked.overCap} bytes=${walked.overCapBytes}`)
rmSync(big, { force: true })

console.log('== 6. 索引是原子写（临时文件不留残渣、能正常读回）==')
const idx = join(ROOT, 'index.json')
ok('index.json 可解析', (() => { try { JSON.parse(readFileSync(idx, 'utf8')); return true } catch { return false } })())
const leftovers = readdirSync(ROOT).filter((f) => f.endsWith('.tmp'))
ok('没有 .tmp 残渣', leftovers.length === 0, leftovers.join(','))

console.log('== 7. prune drop 定点删除 ==')
const relId = rel.split(/\s+/)[1]
const dropped = pruneCheckpoints(20, [c1, c2, relId])
ok('drop 生效', dropped.dropped.includes(c1) && dropped.dropped.includes(c2) && dropped.dropped.includes(relId), JSON.stringify(dropped.dropped))
const c3 = (await create.execute({ note: 'keep me' }, exec)).split(/\s+/)[1]
pruneCheckpoints(20, [c3])
ok('本工作区的快照已清空', mine().length === 0, `left=${mine().length}`)
ok('工作区目录已清理', (() => { rmSync(WS, { recursive: true, force: true }); return !existsSync(WS) })())

console.log('== 8. 跨工作区：告警 + pruneExtra 拒绝 ==')
{
    const A = join(root, '_ck-guards-A')
    const B = join(root, '_ck-guards-B')
    for (const d of [A, B]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
    writeFileSync(join(A, 'f.txt'), 'A\n')
    writeFileSync(join(B, 'f.txt'), 'B\n')
    const ca = createCheckpoint({ cwd: A, note: 'A' })
    const cb = createCheckpoint({ cwd: B, note: 'B' })
    ok('跨工作区 diff 有告警', Boolean(diffCheckpoint({ id: ca.id, other: cb.id }).warning))
    ok('跨工作区 restore 有告警', Boolean(restoreCheckpoint({ id: ca.id, cwd: B, files: ['f.txt'], dryRun: true }).warning))
    let refused = null
    try { restoreCheckpoint({ id: ca.id, cwd: B, dryRun: false, confirm: true, pruneExtra: true }) }
    catch (e) { refused = e.message }
    ok('pruneExtra 跨工作区被拒绝', refused !== null && /pruneExtra/.test(refused), (refused ?? '').slice(0, 60))
    ok('同工作区内 pruneExtra 不受影响', (() => { try { restoreCheckpoint({ id: ca.id, cwd: A, dryRun: true, pruneExtra: true }); return true } catch { return false } })())
    pruneCheckpoints(50, [ca.id, cb.id])
    for (const d of [A, B]) rmSync(d, { recursive: true, force: true })
}

console.log('== 9. journal 跨 bucket 可读（留底按 DSH_SESSION_ID 分桶，读侧不能只认 default）==')
{
    const D = join(root, '_ck-guards-j')
    mkdirSync(D, { recursive: true })
    const f = join(D, 'j.txt')
    writeFileSync(f, 'v1\n')
    const entry = capturePreImage(f, { sessionKey: 'other-bucket' })
    ok('写入非默认 bucket', entry !== null && entry.id !== undefined)
    const found = listJournal({ path: f })
    ok('默认查询能跨 bucket 找到', found.length > 0 && found[0].bucket === 'other-bucket', JSON.stringify(found.slice(0, 1).map((e) => e.bucket)))
    ok('指定 bucket 也能查', listJournal({ sessionKey: 'other-bucket', path: f }).length === 1)
    writeFileSync(f, 'v2\n')
    // 显式给 cwd=工作区根：否则"调用方工作区"= 当前目录（在插件目录里跑就会被边界校验拒绝）
    ok('journalRestore 默认能预览', journalRestore({ path: f, dryRun: true, cwd: root }).dryRun === true)
 // （借鉴 dsh-ops "Model inputs never select an authority mode."）：
    // 跨工作区写盘需要**运维方开关**，模型单传 allowOutside 不再够用。
    const outsideCwd = join(root, '_ck-guards-other-ws')
    mkdirSync(outsideCwd, { recursive: true })
    const needFlag = (() => { try { journalRestore({ path: f, dryRun: true, cwd: outsideCwd, allowOutside: true }); return null } catch (e) { return String(e.message) } })()
    ok('allowOutside 单传不再够用（要运维开关）', needFlag !== null && /DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES/.test(needFlag), String(needFlag).slice(0, 70))
    ok('未传 allowOutside 时仍给"显式传参"的提示（旧文案保留）', (() => { try { journalRestore({ path: f, dryRun: true, cwd: outsideCwd }); return false } catch (e) { return /allowOutside: true/.test(String(e.message)) } })())
    process.env.DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES = '1'
    ok('运维开关打开后才放行（且 dryRun 不写盘）', journalRestore({ path: f, dryRun: true, cwd: outsideCwd, allowOutside: true }).dryRun === true)
    delete process.env.DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES
    rmSync(outsideCwd, { recursive: true, force: true })
    rmSync(D, { recursive: true, force: true })
}

console.log('== 9b. estimate 只估算不落盘 / presetExclude 生效（评审建议 4）==')
{
    const D = join(root, '_ck-estimate')
    const store = join(root, '_ck-estimate-store')
    rmSync(D, { recursive: true, force: true })
    mkdirSync(join(D, 'src'), { recursive: true })
    mkdirSync(join(D, 'build', 'junk'), { recursive: true })
    writeFileSync(join(D, 'src', 'a.txt'), 'aaaa\n')
    writeFileSync(join(D, 'build', 'junk', 'b.txt'), 'bbbb\n')
    writeFileSync(join(D, 'c.log'), 'log\n')
    const before = existsSync(store) ? readdirSync(store).length : 0
    const plain = estimateCheckpoint({ cwd: D })
    const preset = estimateCheckpoint({ cwd: D, presetExclude: true })
    // 注意：`build`/`node_modules`/`.git` 等由内置 EXCLUDE_DIRS 恒定排除 ⇒ 只断言"有内容且被统计"
    ok('estimate 返回文件数/字节数', plain.files >= 2 && plain.bytes > 0, `files=${plain.files} bytes=${plain.bytes}（内置已排除 build/）`)
    ok('presetExclude 把 build/*.log 排掉（文件数变少）', preset.files < plain.files, `${preset.files} < ${plain.files}`)
    ok('estimate 不写任何快照', (existsSync(store) ? readdirSync(store).length : 0) === before, `store 条目 ${before}`)
    ok('estimate 的 note 说明用了哪些排除', /预设排除|排除模式/.test(preset.note), preset.note.slice(0, 50))
    rmSync(D, { recursive: true, force: true })
}

console.log('== 10. 空清单要告警（全被排除时快照没有意义）==')
{
    const E = join(root, '_ck-guards-empty')
    mkdirSync(E, { recursive: true })
    writeFileSync(join(E, 'only.txt'), 'x\n')
    const e = await create.execute({ cwd: E, note: 'all excluded', exclude: ['*'] }, exec)
    ok('全部被排除时输出告警', /清单是空的/.test(e), e.split('\n').find((l) => l.includes('⚠')) ?? '(no warning)')
    pruneCheckpoints(50, [e.split(/\s+/)[1]])
    rmSync(E, { recursive: true, force: true })
}

console.log('== 11. 复制预算 maxCopyBytes / maxCopyTotal / maxFiles（Darktide 复核表里唯一未实测的一格）==')
{
    const B = join(root, '_ck-guards-budget')
    rmSync(B, { recursive: true, force: true })
    mkdirSync(join(B, 'sub'), { recursive: true })
    const big = join(B, 'big.bin')
    const small = join(B, 'small.txt')
    writeFileSync(big, Buffer.alloc(200 * 1024, 65))
    writeFileSync(small, 'v1\n')
    writeFileSync(join(B, 'sub', 'a.txt'), 'a\n')
    writeFileSync(join(B, 'sub', 'b.txt'), 'b\n')

    const CAP = 50 * 1024
    const rec = createCheckpoint({ cwd: B, note: 'budget', maxCopyBytes: CAP })
    const bigEntry = rec.manifest.find((f) => f.rel === 'big.bin')
    ok('超单文件上限 ⇒ stored:false', bigEntry?.stored === false)
    ok('仍保留 hash（diff 才能用）', typeof bigEntry?.hash === 'string' && bigEntry.hash.length === 64)
    ok('复制量不超 maxCopyBytes', rec.copiedBytes <= CAP, `copied=${rec.copiedBytes}`)
    ok('降级归类为「超单文件上限」', rec.hashOnlyDetail?.overPerFile === 1 && rec.hashOnlyDetail?.overBudget === 0, JSON.stringify(rec.hashOnlyDetail))
    ok('记录里写下生效上限', rec.limits?.maxCopyBytes === CAP, JSON.stringify(rec.limits))

    writeFileSync(big, Buffer.alloc(200 * 1024, 66))
    writeFileSync(small, 'v2\n')
    const d = diffCheckpoint({ id: rec.id })
    ok('未存内容的文件也能判定 changed', d.changed.includes('big.bin'), JSON.stringify(d.changed))
    ok('未改动文件不算 changed', !d.changed.includes('sub/a.txt'))

    const plan = restoreCheckpoint({ id: rec.id, dryRun: true })
    ok('plan 标 not-stored (hash only)', plan.plan.find((p) => p.rel === 'big.bin')?.action === 'not-stored (hash only)')
    const done = restoreCheckpoint({ id: rec.id, dryRun: false, confirm: true })
    ok('只回滚可写文件（wrote=1）', done.wrote === 1, `wrote=${done.wrote}`)
    ok('小文件真的回滚了', readFileSync(small, 'utf8') === 'v1\n')
    ok('大文件没被写回（内容保持现状）', readFileSync(big)[0] === 66)

    // 预算不足必须告警：旧条件是 copiedBytes >= maxCopyTotal，遇到"一个大文件超过剩余预算"时永不触发 ⇒ 静默降级
    const recBudget = createCheckpoint({ cwd: B, note: 'budget hit', maxCopyBytes: 1024 * 1024, maxCopyTotal: 4096 })
    ok('预算降级被计数', recBudget.hashOnlyDetail?.overBudget >= 1, JSON.stringify(recBudget.hashOnlyDetail))
    ok('预算用尽给出告警', typeof recBudget.copyBudgetHit === 'string' && /复制预算用尽/.test(recBudget.copyBudgetHit), recBudget.copyBudgetHit ?? '(none)')
    ok('告警里带被降级的文件数', /已降级/.test(recBudget.copyBudgetHit ?? ''))

    const recCap = createCheckpoint({ cwd: B, note: 'file cap', maxFiles: 2 })
    ok('文件数上限给出告警', typeof recCap.skipped === 'string' && /文件数上限/.test(recCap.skipped), recCap.skipped ?? '(none)')

    const t = bindAction('checkpoint_create', 'create')   // 见文件顶部：合并后按 action 分派的原工具薄壳
    const outCap = await t.execute({ cwd: B, note: 'tool cap', maxCopyBytes: CAP, maxFiles: 4 }, exec)
    ok('输出按实际上限措辞（50 KB，不是写死 >1 MB）', /hash-only：1 超过单文件上限 50 KB/.test(outCap), outCap.split('\n').find((l) => l.includes('workspace:')) ?? '')
    const outBudget = await t.execute({ cwd: B, note: 'tool budget', maxCopyBytes: 1024 * 1024, maxCopyTotal: 4096 }, exec)
    ok('输出含复制预算告警与降级数', /复制预算用尽/.test(outBudget) && /已降级/.test(outBudget), outBudget.split('\n').find((l) => l.includes('复制预算')) ?? '(missing)')
    const outMax = await t.execute({ cwd: B, note: 'tool maxfiles', maxFiles: 2 }, exec)
    ok('输出含文件数上限告警', /文件数上限/.test(outMax), outMax.split('\n').find((l) => l.includes('文件数上限')) ?? '(missing)')

    pruneCheckpoints(0, listCheckpoints(200).filter((r) => r.cwd === B || r.cwd?.startsWith(B)).map((r) => r.id))
    rmSync(B, { recursive: true, force: true })
}

// ── 索引自愈（审计新增）──────────────────────────────────────────────
// 旧行为：index.json 损坏/丢失 ⇒ readIndex 的 catch 直接返回 [] ⇒ checkpoint_list 显示"0 个快照"，
// 而快照目录都还在，用户会以为"我的快照全没了"。现在改为从磁盘重建 + 收养孤儿目录。
console.log('== 索引自愈 ==')
{
    const HW = join(root, '_ck-guards-heal-ws')
    rmSync(HW, { recursive: true, force: true })
    mkdirSync(HW, { recursive: true })
    writeFileSync(join(HW, 'a.txt'), 'hello\n')

    const rec1 = createCheckpoint({ cwd: HW, note: 'heal-1' })
    ok('造快照成功', typeof rec1.id === 'string' && rec1.id.startsWith('ck-'))

    rmSync(join(ROOT, 'index.json'), { force: true })
    let healed = listCheckpoints(200)
    ok('索引缺失后仍能看到快照（从磁盘重建）', healed.some((r) => r.id === rec1.id), JSON.stringify(healed.map((r) => r.id)))
    ok('索引被自动重建', existsSync(join(ROOT, 'index.json')))

    writeFileSync(join(ROOT, 'index.json'), '{ not json at all', 'utf8')
    healed = listCheckpoints(200)
    ok('索引损坏后仍能看到快照', healed.some((r) => r.id === rec1.id))
    ok('损坏文件被改名保留', readdirSync(ROOT).some((f) => f.startsWith('index.json.bad-')))

    const rec2 = createCheckpoint({ cwd: HW, note: 'heal-2' })
    const idxPath = join(ROOT, 'index.json')
    const parsed = JSON.parse(readFileSync(idxPath, 'utf8'))
    writeFileSync(idxPath, JSON.stringify(parsed.filter((r) => r.id !== rec2.id), null, 2), 'utf8')
    healed = listCheckpoints(200)
    ok('孤儿快照被收养（目录在、索引里没有）', healed.some((r) => r.id === rec2.id), JSON.stringify(healed.map((r) => r.id)))
    ok('收养结果写回索引', JSON.parse(readFileSync(idxPath, 'utf8')).some((r) => r.id === rec2.id))
    ok('重复读取不产生重复条目', listCheckpoints(200).length === healed.length)

    pruneCheckpoints(0, [rec1.id, rec2.id])
    rmSync(HW, { recursive: true, force: true })
}

// ── 审计 E：5 类数据安全问题（子代理审计发现，全部有最小复现）──────────
// H1 索引重复记录 ⇒ prune keep:N 只留一半（**真删数据**；我加的"孤儿收养"引入的回归）
// H2 pruneExtra 删掉"用户排除、从未进快照"的文件   H3 部分落盘无回滚
// H4 回滚静默覆盖快照之后的改动                     H5 未存原文的大文件被报成 binary
console.log('== 审计E：索引去重 / pruneExtra 排除 / 预检 / 外部改动 / hash-only 文案 ==')
{
    const EW = join(root, '_ck-e-ws')
    rmSync(EW, { recursive: true, force: true })
    mkdirSync(EW, { recursive: true })
    writeFileSync(join(EW, 'a.txt'), 'one\n')
    writeFileSync(join(EW, 'b.txt'), 'two\n')
    writeFileSync(join(EW, '.dsh-checkpoint-ignore'), 'refs\n')

    for (let i = 0; i < 8; i += 1) {
        writeFileSync(join(EW, 'a.txt'), `one ${i}\n`)
        createCheckpoint({ cwd: EW, note: `e${i}` })
    }
    const idxPath = join(ROOT, 'index.json')
    const recs = JSON.parse(readFileSync(idxPath, 'utf8'))
    const dirCount = () => readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('ck-')).length
    ok('H1 8 个快照 ⇒ 索引 8 条、无重复', recs.length === 8, `索引 ${recs.length}`)
    ok('H1 索引条数 == 磁盘目录数', recs.length === dirCount(), `${recs.length} vs ${dirCount()}`)
    pruneCheckpoints(4, [])
    ok('H1 prune keep:4 后磁盘剩 4 个目录（旧版只剩 2）', dirCount() === 4, `剩 ${dirCount()}`)
    const dupIdx = JSON.parse(readFileSync(idxPath, 'utf8'))
    writeFileSync(idxPath, JSON.stringify([...dupIdx, dupIdx[0], dupIdx[1]], null, 2), 'utf8')
    ok('H1b 手工重复索引被读时去重', listCheckpoints(50).length === dupIdx.length)
    ok('H1b 去重结果写回索引', JSON.parse(readFileSync(idxPath, 'utf8')).length === dupIdx.length)

    mkdirSync(join(EW, 'refs'), { recursive: true })
    writeFileSync(join(EW, 'refs', 'big.txt'), 'reference data\n')
    writeFileSync(join(EW, 'refs', 'another.txt'), 'more\n')
    const snapI = createCheckpoint({ cwd: EW, note: 'ignore' })
    writeFileSync(join(EW, 'a.txt'), 'changed\n')
    const rI = restoreCheckpoint({ id: snapI.id, dryRun: false, confirm: true, pruneExtra: true })
    ok('H2 被排除的 refs/ 不被 pruneExtra 删除（旧版会删光）', existsSync(join(EW, 'refs', 'big.txt')) && existsSync(join(EW, 'refs', 'another.txt')))
    ok('H2 受保护文件计入 ignoredFromPrune、不计入 pruned', rI.ignoredFromPrune >= 2 && rI.pruned === 0, `ignored=${rI.ignoredFromPrune} pruned=${rI.pruned}`)

    writeFileSync(join(EW, 'a.txt'), 'pre A\n')
    writeFileSync(join(EW, 'b.txt'), 'pre B\n')
    const snapP = createCheckpoint({ cwd: EW, note: 'preflight' })
    writeFileSync(join(EW, 'a.txt'), 'modified A\n')
    rmSync(join(EW, 'b.txt'), { force: true })
    mkdirSync(join(EW, 'b.txt'), { recursive: true }) // 目录占位 ⇒ 回滚 b.txt 必失败
    let preErr = null
    try { restoreCheckpoint({ id: snapP.id, dryRun: false, confirm: true }) } catch (e) { preErr = e.message }
    ok('H3 预检失败时抛错并声明"未写入任何文件"', preErr !== null && /未写入任何文件/.test(preErr), (preErr ?? '').slice(0, 40))
    ok('H3 没有部分落盘（a.txt 保持用户改动）', readFileSync(join(EW, 'a.txt'), 'utf8') === 'modified A\n')
    rmSync(join(EW, 'b.txt'), { recursive: true, force: true })
    writeFileSync(join(EW, 'b.txt'), 'pre B\n')

    writeFileSync(join(EW, 'a.txt'), 'snapshot content\n')
    const snapM = createCheckpoint({ cwd: EW, note: 'modified' })
    writeFileSync(join(EW, 'a.txt'), 'EXTERNAL EDIT\n')
    const prevM = restoreCheckpoint({ id: snapM.id })
    ok('H4 plan 标出 changedSinceSnapshot', prevM.plan.find((p) => p.rel === 'a.txt')?.changedSinceSnapshot === true)
    ok('H4 modifiedCount 回传', prevM.modifiedCount === 1 && prevM.modifiedSince.includes('a.txt'))

    writeFileSync(join(EW, 'big.txt'), `huge\n${'x'.repeat(200 * 1024)}\n`)
    const snapH = createCheckpoint({ cwd: EW, note: 'hash-only', maxCopyBytes: 1024 })
    const manH = JSON.parse(readFileSync(join(snapH.dir, 'manifest.json'), 'utf8'))
    ok('H5 大文件记为 stored:false', (manH.manifest ?? []).find((f) => f.rel === 'big.txt')?.stored === false)
    writeFileSync(join(EW, 'big.txt'), `changed\n${'y'.repeat(200 * 1024)}\n`)
    const dH = diffCheckpoint({ id: snapH.id, maxDiffs: 5 })
    const tH = (dH.diffs.find((x) => x.rel === 'big.txt') ?? {}).text ?? ''
    ok('H5 diff 说"快照未存原文"而不是 binary', /快照未存原文/.test(tH) && !/binary/.test(tH), tH.slice(0, 36))

    pruneCheckpoints(0, listCheckpoints(200).map((r) => r.id))
    rmSync(EW, { recursive: true, force: true })
}

rmSync(STORE, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

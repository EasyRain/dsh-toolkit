/**
 * session 工具自测：node test/session-tools-selftest.mjs
 * 覆盖：`last` 的语义（按**调用方会话工作区**解析，而不是全局最新）、显式 id 不受 cwd 限制、
 *      session_list 默认列全部、坏帧提示、session_export 的坏帧提示。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../lib/session/index.js'

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}
const list = tools((t) => t, {})
// 成对合并：session_peek/session_grep → session_read、session_catalog → session_list{kind:"subagents"}
// 这里按旧名查回"模式已绑定"的薄壳，正文调用点不改。
const BIND = { session_peek: 'session_read', session_grep: 'session_read', session_catalog: 'session_list' }
const by = (n) => {
    const real = BIND[n] ?? n
    const t = list.find((x) => x.name === real)
    if (t === undefined) return undefined
    const extra = n === 'session_catalog' ? { kind: 'subagents' } : {}
    return { name: real, output: t.output, description: t.description, parameters: t.parameters, execute: (args, exec) => t.execute({ ...extra, ...(args ?? {}) }, exec) }
}
const execFor = (cwd) => ({ agent: { session: { header: { cwd } } } })

const all = await by('session_list').execute({ limit: 200 })
const rows = all.split('\n').slice(2).filter((l) => l.trim() !== '')
// 机器上可能**一个会话都没有**（干净/Linux/CI 环境）⇒ 那时断言"空库也给表头与总数"，而不是假装有行
const totalSessions = Number(/total: (\d+) session/.exec(all)?.[1] ?? -1)
if (totalSessions === 0) {
    ok('session_list 空库时仍给 root/total 表头与说明', /sessions root:/.test(all) && /no session logs under/.test(all), rows[0]?.slice(0, 60) ?? '')
}
else {
    ok('session_list 默认列出全部工作区', rows.length > 0 && new Set(rows.map((r) => r.split(/\s+/).pop())).size >= 1, `${rows.length} rows`)
}
const addonsRow = rows.find((r) => r.includes('--D-DshWorkSpace-Addons--'))
const darktideRow = rows.find((r) => r.includes('--D-DshWorkSpace-Darktide--'))
if (Boolean(addonsRow) && Boolean(darktideRow)) ok('能找到两个工作区的会话', true); else console.log('  SKIP  本机没有这两个工作区（不是失败）')

// 显式 id / 裸 uuid 不受 cwd 限制（修：以前会先撞上"该工作区没有会话日志"，而错误信息恰恰叫人
// "显式给 session id"）。这几条**不依赖作者的工作区** —— 只要这台机器上有任意一个会话就能验。
{
    const firstId = (rows[0] ?? '').split(/\s+/)[0]
    if (!/^session-[0-9a-f-]{36}$/.test(firstId)) {
        console.log('  SKIP  本机一个会话都没有（显式 id 两条无从验证，不是失败）')
    }
    else {
        const emptyCwd = mkdtempSync(join(tmpdir(), 'dsh-toolkit-nosess-'))
        const read = by('session_read')
        const byExplicit = await read.execute({ session: firstId, cwd: emptyCwd, tail: 1 }, execFor(emptyCwd))
        ok('显式 id 在"没有会话日志的工作区"里照样解析（不被 cwd 拦下）', byExplicit.length > 0, byExplicit.split('\n')[0]?.slice(0, 60) ?? '')
        const bare = firstId.replace(/^session-/, '')
        const byBare = await read.execute({ session: bare, tail: 1 }, execFor(emptyCwd))
        ok('裸 uuid（不带 session- 前缀）也认', byBare.length > 0 && !/no session matching/.test(byBare), byBare.split('\n')[0]?.slice(0, 60) ?? '')
        rmSync(emptyCwd, { recursive: true, force: true })
    }
}

if (addonsRow && darktideRow) {
    const addonsId = addonsRow.split(/\s+/)[0]
    const darktideId = darktideRow.split(/\s+/)[0]
    const peek = by('session_peek')
    const fromAddons = await peek.execute({ session: 'last', tail: 1 }, execFor('D:/DshWorkSpace/Addons'))
    const fromDarktide = await peek.execute({ session: 'last', tail: 1 }, execFor('D:/DshWorkSpace/Darktide'))
    ok('last 在 Addons 视角解析到 Addons 会话', fromAddons.startsWith(addonsId), fromAddons.split(/\s+/)[0])
    ok('last 在 Darktide 视角解析到 Darktide 会话', fromDarktide.startsWith(darktideId), fromDarktide.split(/\s+/)[0])
    ok('两个视角解析到不同会话（多工作区不再串台）', !fromAddons.startsWith(darktideId) && !fromDarktide.startsWith(addonsId))
 // `last` 的解析依据必须打在输出里，否则"本会话恰好全局最新"时无法判定作用域（Darktide 卡在这里）
    ok('输出写明 last 的解析依据', /last 按调用方工作区解析|last = 全局最新/.test(fromDarktide), fromDarktide.split('［')[1]?.slice(0, 80) ?? '(no bracket)')
    ok('依据行给出对照或明说无法区分', /全局最新是|无法区分作用域|last = 全局最新/.test(fromDarktide))
    const noExecPeek = await by('session_peek').execute({ session: 'last', tail: 1 }, {})
    ok('拿不到调用方工作区时明说未按工作区限定', /未按工作区限定/.test(noExecPeek), noExecPeek.split('［')[1]?.slice(0, 60) ?? '(no bracket)')

    // 显式 id 不应被 cwd 限制
    const explicit = await peek.execute({ session: darktideId, tail: 1 }, execFor('D:/DshWorkSpace/Addons'))
    ok('显式 id 可跨工作区读取', explicit.startsWith(darktideId), explicit.split(/\s+/)[0])

    // 显式 cwd 仍然有效
    const byCwd = await peek.execute({ session: 'last', cwd: 'D:/DshWorkSpace/Darktide', tail: 1 }, execFor('D:/DshWorkSpace/Addons'))
    ok('显式 cwd 覆盖会话默认', byCwd.startsWith(darktideId), byCwd.split(/\s+/)[0])

    // 坏帧提示：正常日志不应出现告警；导出也应能跑
    ok('正常日志不报坏帧', !/解码失败/.test(fromAddons), fromAddons.split('\n')[0].slice(0, 80))
    const out = mkdtempSync(join(tmpdir(), 'dsh-toolkit-sess-'))
    const to = join(out, 'export.jsonl')
    const exported = await by('session_export').execute({ session: addonsId, to, format: 'jsonl' }, execFor('D:/DshWorkSpace/Addons'))
    ok('session_export 正常导出', /exported \d+ events/.test(exported), exported.split('\n')[0].slice(0, 80))
    rmSync(out, { recursive: true, force: true })

    // grep 也要能用（并带上工作区解析）
    const grep = await by('session_grep').execute({ pattern: 'tools/pre-execute', session: 'last', limit: 1 }, execFor('D:/DshWorkSpace/Addons'))
    ok('session_grep 可用', grep.length > 0, grep.split('\n')[0].slice(0, 80))
}

console.log('== 审计修复回归（子代理审计，全部有最小复现）==')
{
    const { slugOf, catastrophicHint, textOf, deepTextOf, decodeNotes } = await import('../lib/session/index.js')

    // H5：宿主 slug 对空格/逗号用 ~XXXX 转义（旧实现折成 '-' ⇒ 含空格的工作区永远找不到会话）
    ok('slugOf 与宿主一致（空格 → ~0020）', slugOf('C:\\Program Files\\nodejs') === '--C-Program~0020Files-nodejs--', slugOf('C:\\Program Files\\nodejs'))
    ok('slugOf 逗号 → ~002C', slugOf('D:\\a\\Warhammer 40,000 X') === '--D-a-Warhammer~002040~002C000~0020X--', slugOf('D:\\a\\Warhammer 40,000 X'))
    ok('slugOf 普通路径不变', slugOf('D:\\DshWorkSpace\\Addons') === '--D-DshWorkSpace-Addons--')

    // H1：流式分片的正文在 data.texts 里，必须可见（旧键表漏掉 ⇒ 44%~71% 事件内容 grep 不到）
    const streamEvent = { type: 'reasoning-chunks', data: { turn: 1, step: 1, texts: ['the p ck file', 'is the latest'] } }
    ok('textOf 认得 data.texts（流式分片）', /latest/.test(textOf(streamEvent.data)), JSON.stringify(textOf(streamEvent.data)))
    ok('deepTextOf 同样能取到（grep 用）', /latest/.test(deepTextOf(streamEvent)))

    // H2：灾难性回溯护栏（旧实现让工具永久挂死：实测 300 s 未返回）
    ok('识别嵌套量词 (a+)+$', catastrophicHint('(a+)+$') !== null, String(catastrophicHint('(a+)+$')))
    ok('识别 (a|a)+', catastrophicHint('(a|a)+') !== null)
    ok('正常 pattern 不误报', catastrophicHint('tools/pre-execute') === null && catastrophicHint('foo.*bar') === null)

    // M7/M8/L16：坏帧/坏行/空文件/非 UTF-8 都必须外显，不能静默 0 events
    ok('空文件告警', decodeNotes({ frames: 0, bad: 0, badLines: 0, bytes: 0, text: '' }).some((n) => /文件是空的/.test(n)))
    ok('非 zstd 告警', decodeNotes({ frames: 0, bad: 0, badLines: 0, bytes: 100, text: 'x' }).some((n) => /不是会话日志/.test(n)))
    ok('坏行告警', decodeNotes({ frames: 1, bad: 0, badLines: 2, bytes: 100, text: 'x' }).some((n) => /无法解析/.test(n)))
    ok('非 UTF-8 告警', decodeNotes({ frames: 1, bad: 0, badLines: 0, bytes: 100, text: 'a\uFFFDb' }).some((n) => /U\+FFFD/.test(n)))

    // H4：导出目标保护 —— 拒绝覆盖会话日志 / 已存在文件需 overwrite
    const exp = await by('session_export')
    const listOut = await by('session_list').execute({ limit: 1 })
    const idMatch = /([0-9a-f]{8}-[0-9a-f-]{27}|session-[0-9a-f-]{36})/.exec(listOut)
    if (idMatch) {
        let msg = null
        try {
            await exp.execute({ session: idMatch[1], to: join(tmpdir(), 'dsh-guard-test.jsonl'), overwrite: true })
            // 第一次可能成功创建；再写一次不同内容也应允许（overwrite:true），但要确认没有覆盖会话日志目录里的东西
        }
        catch (e) { msg = e.message }
        ok('导出到临时目录可用', msg === null, (msg ?? '').slice(0, 60))
        let guard = null
        // ⚠️ 用 homedir() 而不是 `process.env.USERPROFILE` —— Linux 上后者是 undefined，
        // `join(undefined, …)` 会抛 TypeError（断言会假红）。目标目录在两种平台上都对应"~/.dsh/sessions"。
        try { await exp.execute({ session: idMatch[1], to: join(join(homedir(), '.dsh', 'sessions'), 'nope.jsonl') }) }
        catch (e) { guard = e.message }
        ok('拒绝写入会话日志目录', guard !== null && /拒绝写入会话日志目录|不存在|ENOENT/.test(guard), (guard ?? '').slice(0, 60))
    } else {
        ok('（没取到会话 id，跳过导出目标断言）', true)
    }

    // M13/M14：尾读与流式必须与"全量解码"**逐条等价**（这类内存优化最容易在边界上出错）
    const { decodeSessionFile, decodeSessionTail, scanEvents, diffDigests, diffEvents, resolveSessionFile } = await import('../lib/session/index.js')
    const listAll = await by('session_list').execute({ limit: 1 })
    const id2 = /([0-9a-f]{8}-[0-9a-f-]{27}|session-[0-9a-f-]{36})/.exec(listAll)?.[1]
    if (id2) {
        let sfile = null
        try { sfile = resolveSessionFile(id2)?.file ?? resolveSessionFile(id2) ?? null } catch { /* 需要 cwd 时会抛 */ }
        // ⚠️ 只对「小文件」做全量解码：本机 44 MB 的会话解一遍峰值可到 GB 级，8 路并行时会把
        // 提交内存（commit）吃满、把宿主进程带走（实测崩了两次）。大文件改由合成语料覆盖。
        const tooBig = typeof sfile === 'string' && statSync(sfile).size > 4 * 1024 * 1024
        if (tooBig) {
            ok(`（本机最新会话 ${(statSync(sfile).size / 1048576).toFixed(1)} MB > 4 MB：跳过「全量解码等价性」断言 —— 大文件全解码会吃满 commit）`, true)
        }
        else if (typeof sfile === 'string') {
            const full = decodeSessionFile(sfile)
            const allLines = full.text.split('\n').filter((l) => l.trim() !== '')
            const tail = decodeSessionTail(sfile, 5)
            ok('尾读取到的是**最后 5 行**（与全量解码一致）', JSON.stringify(tail.lines) === JSON.stringify(allLines.slice(-5)), `tail=${tail.lines.length} all=${allLines.length} frames=${tail.frames}/${tail.decodedFrames}`)
            const seen = []
            const stat = scanEvents(sfile, (ev, index) => seen.push(index))
            ok('流式扫描的事件数与全量解码的行数一致', stat.events === allLines.length, `${stat.events} vs ${allLines.length}`)
            ok('流式扫描的序号连续（1..N）', seen.length === 0 || (seen[0] === 1 && seen[seen.length - 1] === seen.length), `${seen[0]}..${seen[seen.length - 1]}`)
            const asEvents = allLines.map((l) => JSON.parse(l))
            const oldWay = diffEvents(asEvents, asEvents, 5)
            ok('diffDigests 与旧 diffEvents 在自比时结论一致（added/removed/changed 全 0）', oldWay.counts.added === 0 && oldWay.counts.removed === 0 && oldWay.counts.changed === 0)
            const digests = []
            scanEvents(sfile, (ev) => { const p = ev?.data ?? ev; digests.push({ key: String(ev?.type ?? '') + '|' + String(ev?.seq ?? ''), text: String(p?.message ?? '').slice(0, 200) }) })
            const dg = diffDigests(digests, digests, 5)
            ok('diffDigests 自比也是全 0', dg.counts.added === 0 && dg.counts.removed === 0 && dg.counts.changed === 0, JSON.stringify(dg.counts))
        }
        else ok('（没解析到会话文件路径，跳过尾读等价性断言）', true)
    } else {
        ok('（没取到会话 id，跳过尾读等价性断言）', true)
    }
}

// --- 新能力（2026-10-24）：谓词 / 重列 / 索引缓存 / 跨会话检索 / 缺号假阳性 -------------
// 用**合成会话**在临时 DSH_HOME 里跑：真库不能当断言依据（会随用户使用变化）。
console.log('\n== 谓词 / 重列 / 缓存 / 跨会话检索（合成语料） ==')
{
    const zlib = await import('node:zlib')
    const fs = await import('node:fs')
    const sandbox = mkdtempSync(join(tmpdir(), 'dsh-session-new-'))
    const home = join(sandbox, 'home')
    const sessions = join(home, 'sessions')
    const state = join(sandbox, 'state')
    const oldHome = process.env.DSH_HOME
    const oldState = process.env.DSH_TOOLKIT_STATE_DIR
    process.env.DSH_HOME = home
    process.env.DSH_TOOLKIT_STATE_DIR = state

    /** 写一份多帧 zstd 会话日志（每帧若干事件，模拟真实 append-only 写入） */
    const writeLog = (slug, id, events, perFrame = 3) => {
        const dir = join(sessions, slug, id)
        fs.mkdirSync(dir, { recursive: true })
        const file = join(dir, 'session.v4.jsonl.zstd')
        const frames = []
        for (let i = 0; i < events.length; i += perFrame) {
            const text = events.slice(i, i + perFrame).map((e) => JSON.stringify(e)).join('\n') + '\n'
            frames.push(zlib.zstdCompressSync(Buffer.from(text, 'utf8')))
        }
        fs.writeFileSync(file, Buffer.concat(frames))
        return file
    }
    const base = (type, seq, extra = {}) => ({ type, seq, time: 1_790_000_000_000 + seq * 1000, data: extra })
    const slugA = '--D-Work-A--'
    const slugB = '--D-Work-B--'

    // ① 空会话：4 个事件、无 user/assistant
    writeLog(slugA, 'session-empty-1', [base('session', 1, { cwd: 'D:\\Work\\A' }), base('session/end-seed', 2), base('turn/start', 3), base('turn/end', 4)])
    // ② 正常会话：有消息与标题
    writeLog(slugA, 'session-normal-1', [
        base('session', 1, { cwd: 'D:\\Work\\A' }),
        base('user/message', 2, { text: 'needle 在这里' }),
        base('assistant/message', 3, { text: '收到' }),
        base('session/title', 4, { title: '正常会话标题' }),
        base('turn/start', 5), base('turn/end', 6),
    ])
    // ③ 子代理会话：seq 稀疏（15 → 40）
    writeLog(slugA, 'session-subagent-1', [
        base('session', 15, { cwd: 'D:\\Work\\A', origin: 'subagent', parentSession: 'session-normal-1', delegationDepth: 1 }),
        base('user/message', 40, { text: 'needle 子代理' }),
    ])
    // ④ 顶层会话"缺号"（1 → 9）：**不许**被当成坏日志 —— 早期日志与子代理日志的 seq 分别是宿主全局计数与父会话计数
    writeLog(slugB, 'session-gap-1', [
        base('session', 1, { cwd: 'D:\\Work\\B' }),
        base('user/message', 9, { text: 'needle 缺号' }),
    ])
    // ④b 真的坏日志：正常帧之后再塞一段"只解不开的帧"（魔数对、载荷坏）⇒ torn
    const tornFile = writeLog(slugB, 'session-torn-1', [base('session', 1, { cwd: 'D:\\Work\\B' }), base('user/message', 2, { text: 'half' })])
    fs.appendFileSync(tornFile, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]))
    // ⑤ 命中很多的会话，验证"每会话上限"
    writeLog(slugB, 'session-many-1', [
        base('session', 1, { cwd: 'D:\\Work\\B' }),
        ...Array.from({ length: 8 }, (_, i) => base('user/message', i + 2, { text: `needle ${i}` })),
    ])

    try {
        const empty = await by('session_list').execute({ where: { empty: true }, fields: ['id', 'events', 'integrity'], limit: 50 })
        ok('where.empty 只命中结构空会话', /session-empty-1/.test(empty) && !/session-normal-1/.test(empty), empty.split('\n').slice(2).join(' | ').slice(0, 120))
        // 这一次是全块里**第一次**触到重列 ⇒ 必须是真解码（后面的调用都应命中缓存）
        ok('首次重列会解码（说明里有"本次解码 N 个"）', /本次解码 [1-9]/.test(empty), (empty.match(/本次解码.*?ms/) ?? [''])[0])

        const first = await by('session_list').execute({ fields: ['id', 'events', 'turns', 'title'], limit: 50 })
        ok('fields 触发重列并给出 events/turns', /session-normal-1[\s\S]*events=6/.test(first), first.split('\n').find((l) => l.includes('normal')) ?? '')
        ok('title 从 session/title 事件取到', /title="正常会话标题"/.test(first))
        const second = await by('session_list').execute({ fields: ['id', 'events'], limit: 50 })
        ok('第二次命中缓存（本次解码 0 个）', /本次解码 0 个/.test(second), (second.match(/本次解码.*?ms/) ?? [''])[0])

        // seq 缺号**不是**健康信号（真数据推翻过：子代理用父会话计数、早期日志用宿主全局计数）
        const integ = await by('session_list').execute({ fields: ['id', 'integrity'], limit: 50 })
        ok('seq 缺号的顶层会话仍判 ok（缺号 ≠ 坏日志）', /session-gap-1[\s\S]*integrity=ok/.test(integ), integ.split('\n').filter((l) => l.includes('gap-1')).join('').slice(0, 100))
        ok('子代理会话也判 ok', /session-subagent-1[\s\S]*integrity=ok/.test(integ))
        const torn = await by('session_list').execute({ where: { integrity: 'torn' }, fields: ['id', 'integrity'], limit: 50 })
        ok('坏帧的会话判 torn 并被谓词筛出', /session-torn-1[\s\S]*integrity=torn/.test(torn), torn.split('\n').slice(2).join(' | ').slice(0, 100))
        let gapsRejected = false
        try { await by('session_list').execute({ where: { integrity: 'gaps' } }) }
        catch (e) { gapsRejected = /只能.*ok \/ torn \/ unreadable/.test(String(e?.message ?? e)) }
        ok('integrity:"gaps" 被引导拒绝（不是静默空结果）', gapsRejected)

        const search = await by('session_read').execute({ pattern: 'needle', scope: 'all', limit: 50, maxHitsPerSession: 2 })
        ok('scope=all 跨会话检索按会话分组', /session-normal-1/.test(search) && /session-many-1/.test(search) && /session-gap-1/.test(search), search.split('\n')[0].slice(0, 120))
        // 4 个会话有命中：normal 1 + subagent 1 + gap 1 + many 8→2 ⇒ 5 行（首行是 `search /needle/i …`，要排除）
        const needleLines = search.split('\n').filter((l) => /^\s+\d+\s{2}/.test(l) && l.includes('needle'))
        ok('maxHitsPerSession=2 生效（many 的 8 命中只出 2 行；总命中 5 行）', needleLines.length === 5, `命中行 ${needleLines.length}`)
        ok('分组头给出"显示 N / 共 M"', /2 of 8 match/.test(search), (search.match(/\d+ of \d+ match\(es\)/g) ?? []).join(','))

        const ws = await by('session_read').execute({ pattern: 'needle', scope: 'workspace', cwd: 'D:\\Work\\B', limit: 20 })
        ok('scope=workspace 只扫该工作区', /session-many-1/.test(ws) && !/session-normal-1/.test(ws), ws.split('\n')[0].slice(0, 120))

        let rejected = false
        try { await by('session_read').execute({ scope: 'all', tail: 3 }) } catch { rejected = true }
        ok('scope=all 不带 pattern 会被拒绝', rejected)

        const page1 = await by('session_list').execute({ limit: 2, fields: ['id'] })
        const page2 = await by('session_list').execute({ limit: 2, offset: 2, fields: ['id'] })
        const idOf = (t) => t.split('\n').slice(2).filter((l) => l.startsWith('session-')).join('|')
        ok('offset 分页不重复', idOf(page1) !== '' && idOf(page2) !== '' && idOf(page1) !== idOf(page2), `${idOf(page1).slice(0, 30)} vs ${idOf(page2).slice(0, 30)}`)

        // --- 姿势：错用必须"清晰报错"，不许静默错 / 静默空（判据同 postures-selftest）---
        const bad = async (fn, pattern, label) => {
            try { await fn(); ok(label, false, '没有报错（静默接受）') }
            catch (error) { ok(label, pattern.test(String(error?.message ?? error)), String(error?.message ?? error).slice(0, 80)) }
        }
        await bad(() => by('session_list').execute({ where: [] }), /where 必须是对象/, '姿势：where 给数组 ⇒ 报错而不是"标了 filtered 却没筛"')
        await bad(() => by('session_list').execute({ where: { empty: 'yes' } }), /where\.empty 必须是 boolean/, '姿势：where.empty 给字符串 ⇒ 报错')
        await bad(() => by('session_list').execute({ where: { olderThanDays: 'abc' } }), /必须是 number/, '姿势：olderThanDays 给 NaN ⇒ 报错（否则比较恒 false，静默空）')
        await bad(() => by('session_list').execute({ where: { olderThanDays: -5 } }), /非负有限数/, '姿势：olderThanDays 给负数 ⇒ 报错')
        await bad(() => by('session_list').execute({ where: { minBytes: 100, maxBytes: 10 } }), /区间反了/, '姿势：minBytes > maxBytes ⇒ 报错并说明永远筛不出东西')
        await bad(() => by('session_list').execute({ fields: 'id' }), /必须是字符串数组/, '姿势：fields 给字符串 ⇒ 报错')
        await bad(() => by('session_list').execute({ fields: ['bogus'] }), /fields 不认识 bogus/, '姿势：fields 有未知列 ⇒ 报错并列出可用列')
        await bad(() => by('session_list').execute({ sort: 'bogus' }), /sort 只能是/, '姿势：sort 给未知值 ⇒ 报错')
        await bad(() => by('session_read').execute({ pattern: 'needle', scope: 'all', session: 'session-a' }), /不接受 session/, '姿势：scope=all 又给 session ⇒ 报错')
        await bad(() => by('session_read').execute({ pattern: '(a+)+$', scope: 'all' }), /灾难性回溯/, '姿势：跨会话也拦灾难性回溯')
        const gFlags = await by('session_read').execute({ pattern: 'needle', flags: 'gi', scope: 'all', limit: 5 })
        ok('姿势：跨会话带 g 标志会剥掉并说明', /flags 里的 g\/y 已剥掉/.test(gFlags), gFlags.split('\n').slice(-1)[0].slice(0, 80))
    }
    finally {
        if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
        if (oldState === undefined) delete process.env.DSH_TOOLKIT_STATE_DIR; else process.env.DSH_TOOLKIT_STATE_DIR = oldState
        rmSync(sandbox, { recursive: true, force: true })
    }
}


// --- 多帧语义回归（Node 26）：一次解压会从偏移解到缓冲区末尾，逐偏移调用会重复/平方级 ---
console.log('\n== 多帧解码（Node 26 语义） ==')
{
    const zlib = await import('node:zlib')
    const fs = await import('node:fs')
    const mod = await import('../lib/session/index.js')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-multiframe-'))
    const f = join(dir, 'session.v4.jsonl.zstd')
    const events = Array.from({ length: 7 }, (_, i) => ({ type: 'user/message', seq: i + 1, time: 1, data: { text: `e${i}` } }))
    const frames = []
    for (let i = 0; i < events.length; i += 2) frames.push(zlib.zstdCompressSync(Buffer.from(events.slice(i, i + 2).map((e) => JSON.stringify(e)).join('\n') + '\n')))
    fs.writeFileSync(f, Buffer.concat(frames)) // 4 帧 / 7 事件
    try {
        const full = mod.decodeSessionFile(f)
        const lines = full.text.split('\n').filter((l) => l.trim() !== '')
        ok('多帧全解不重复（7 事件 ⇒ 7 行，而不是 7+5+3+1）', lines.length === 7, `lines=${lines.length} frames=${full.frames}`)
        let n = 0
        const stat = mod.scanEvents(f, () => { n += 1 })
        ok('逐帧扫描计数与全解一致', stat.events === 7 && n === 7, `${stat.events}/${n}`)
        const tail = mod.decodeSessionTail(f, 3)
        ok('尾读取到全解的最后 3 行', JSON.stringify(tail.lines) === JSON.stringify(lines.slice(-3)), `tail=${tail.lines.length}`)
        let refused = false
        try { mod.decodeSessionFile(f, { maxBytes: 1 }) } catch { refused = true }
        ok('全解超过 maxBytes 会被拒绝（大文件必须走逐帧路径）', refused)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

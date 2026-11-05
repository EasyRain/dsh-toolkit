/**
 * table_diff 自测：node test/tablediff-selftest.mjs [darktideRoot]
 * 覆盖：多格式适配器 / 投影（key、value、多字段 key、点路径）/ 值模式与记录模式 / 键映射 / 规模 / 真实数据。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordsFrom } from '../lib/tablediff/adapters.js'
import { listZipEntries, readZipEntry } from '../lib/tablediff/zip.js'
import { DEFAULT_KEY_FIELDS, VALUE_HINTS, buildKeyMap, diffRecords, diffSqliteLarge, diffTables, expandGlob, globBaseOf, project, tools } from '../lib/tablediff/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const sandbox = join(process.env.DSH_TOOLKIT_TEST_DIR ?? join(tmpdir(), 'dsh-toolkit-selftest'), '_tablediff-selftest')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// --- 迷你 zip 写手（**只写 stored**、零依赖）：多处 fixture 共用 -----------------
const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        t[n] = c >>> 0
    }
    return t
})()
const crc32 = (buf) => {
    let c = 0xFFFFFFFF
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
}
const makeZip = (file, entries) => {
    const chunks = []
    const central = []
    let offset = 0
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name, 'utf8')
        const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
        const crc = crc32(data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0, 8)           // method = stored
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(nameBuf.length, 26)
        chunks.push(local, nameBuf, data)
        const cen = Buffer.alloc(46)
        cen.writeUInt32LE(0x02014b50, 0)
        cen.writeUInt16LE(20, 4)
        cen.writeUInt16LE(20, 6)
        cen.writeUInt16LE(0, 10)
        cen.writeUInt32LE(crc, 16)
        cen.writeUInt32LE(data.length, 20)
        cen.writeUInt32LE(data.length, 24)
        cen.writeUInt16LE(nameBuf.length, 28)
        cen.writeUInt32LE(offset, 42)
        central.push(Buffer.concat([cen, nameBuf]))
        offset += local.length + nameBuf.length + data.length
    }
    const centralBuf = Buffer.concat(central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    writeFileSync(file, Buffer.concat([...chunks, centralBuf, eocd]))
}

let failures = 0
const ok = (label, cond, extra = '') => {
    if (!cond) failures++
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}
const load = async (spec, opts) => await recordsFrom(spec, opts)

console.log('== adapters ==')
{
    writeFileSync(join(sandbox, 'a.lua'), `local g = {\n  terms = {\n    { en = "Melee", uk = "Ближній бій", ["zh-cn"] = "近战" },\n    { en = "Ranged", uk = "Дальній бій", ["zh-cn"] = "远程" },\n  },\n}\nreturn g\n`)
    const lua = await load(join(sandbox, 'a.lua'))
    ok('lua: local X = {...} return X', lua.stats.records === 2, `records=${lua.stats.records}`)
    const p = project(lua.records, { keyField: 'en', valueField: 'uk' })
    ok('lua projection en->uk', p.map.get('Melee') === 'Ближній бій', JSON.stringify(p.map.get('Melee')))

    writeFileSync(join(sandbox, 'a.json'), JSON.stringify([{ key: 'k1', value: 'v1' }, { key: 'k2', value: 'v2' }]))
    ok('json array of records', (await load(join(sandbox, 'a.json'))).stats.records === 2)
    writeFileSync(join(sandbox, 'a.jsonl'), '{"id":"k1","text":"v1"}\n{"id":"k2","text":"v2"}\n')
    ok('jsonl', (await load(join(sandbox, 'a.jsonl'))).stats.records === 2)
    writeFileSync(join(sandbox, 'a.csv'), 'key,value\nk1,v1\nk2,"v2, x"\n')
    const csv = await load(join(sandbox, 'a.csv'))
    ok('csv header keeps quoted comma', project(csv.records, {}).map.get('k2') === 'v2, x', JSON.stringify(project(csv.records, {}).map.get('k2')))
    writeFileSync(join(sandbox, 'a.tsv'), 'id\ttext\nk1\tv1\n')
    ok('tsv', (await load(join(sandbox, 'a.tsv'))).stats.records === 1)
    writeFileSync(join(sandbox, 'a.po'), 'msgid "k1"\nmsgstr "v1"\n\nmsgid "k2"\nmsgstr ""\n"v2"\n\n')
    ok('po with continuation', project((await load(join(sandbox, 'a.po'))).records, {}).map.get('k2') === 'v2')
    writeFileSync(join(sandbox, 'a.properties'), '# c\n[ui]\nstart = Start\nquit: Quit\n')
    const props = await load(join(sandbox, 'a.properties'))
    ok('properties with sections', props.stats.records === 2 && project(props.records, {}).map.get('ui.start') === 'Start', JSON.stringify([...project(props.records, {}).map]))
    writeFileSync(join(sandbox, 'a.conf'), 'K1=v1\nK2 = v2\n')
    ok('env/conf key=value', (await load(join(sandbox, 'a.conf'))).stats.records === 2)
    writeFileSync(join(sandbox, 'a.yaml'), 'k1: v1\nk2:\n  value: v2\n')
    const y = await load(join(sandbox, 'a.yaml'))
    ok('yaml parses (or module unavailable in the workspace source tree)', y.stats.records > 0 || /unavailable/.test(y.stats.note ?? ''), `records=${y.stats.records} note=${y.stats.note ?? ''}`)
    writeFileSync(join(sandbox, 'noext'), 'A=1\nB=2\n')
    const guessed = await load(join(sandbox, 'noext'))
    ok('unknown extension is guessed', guessed.stats.records === 2, `format=${guessed.stats.format}`)
}

console.log('== sqlite adapter ==')
try {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = join(sandbox, 'terms.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('create table terms (term_key text, uk text, zh text)')
    const ins = db.prepare('insert into terms values (?,?,?)')
    ins.run('Loc_Melee', 'Ближній бій', '近战')
    ins.run('Loc_Ranged', 'Дальній бій', '远程')
    db.close()
    const t = await load(`${dbPath}#terms`)
    ok('sqlite table read', t.stats.records === 2, `records=${t.stats.records} note=${t.stats.note ?? ''}`)
    const p = project(t.records, { keyField: 'term_key', valueField: 'uk' })
    ok('sqlite projection', p.map.get('Loc_Melee') === 'Ближній бій')
    const q = await load(dbPath, { query: 'select term_key as k, zh as v from terms' })
    ok('sqlite custom query', project(q.records, { keyField: 'k', valueField: 'v' }).map.get('Loc_Ranged') === '远程')
}
catch (e) {
    console.log('  (sqlite test skipped: ' + e.message + ')')
}

console.log('== projection & diff modes ==')
{
    // 通用性守卫：默认候选只含通用名；领域/项目专属名（en、loc_keys、uk…）必须靠 keyHints/valueHints 扩展
    ok('默认 key 候选不含领域专属名', !DEFAULT_KEY_FIELDS.includes('en') && !DEFAULT_KEY_FIELDS.includes('loc_keys') && !DEFAULT_KEY_FIELDS.includes('term_key'), DEFAULT_KEY_FIELDS.join(','))
    ok('默认 value 候选不含语言码', !VALUE_HINTS.includes('uk') && !VALUE_HINTS.includes('zh') && !VALUE_HINTS.includes('en'), VALUE_HINTS.join(','))
    const hinted = project([{ en: 'Melee', uk: 'Ближній бій' }, { en: 'Ranged', uk: 'Дальній бій' }], { keyHints: ['en'], valueHints: ['uk'] })
    ok('keyHints/valueHints 能扩展自动识别（不改代码）', hinted.map.get('Melee') === 'Ближній бій' && hinted.stats.keyFields[0] === 'en', JSON.stringify([...hinted.map]))
    const noHint = project([{ en: 'Melee', uk: 'Ближній бій' }], { valueField: 'uk' })
    ok('不给 hints 就不会误猜 en 当 key（回退成索引键）', noHint.map.has('#1'), [...noHint.map.keys()].join(','))

    const A = project([{ id: 'a', locale: 'uk', text: 'old' }, { id: 'a', locale: 'zh', text: '旧' }], { keyField: 'id+locale', valueField: 'text' })
    const B = project([{ id: 'a', locale: 'uk', text: 'new' }, { id: 'a', locale: 'zh', text: '旧' }], { keyField: 'id+locale', valueField: 'text' })
    ok('multi-field key', A.map.has('a+uk') && A.map.has('a+zh'), [...A.map.keys()].join(','))
    const d = diffTables(A.map, B.map, { limit: 5, showValues: true })
    ok('values mode: 1 changed', d.counts.changed === 1 && d.counts.added === 0, JSON.stringify(d.counts))
    ok('values mode carries word diff', d.changed[0].diff.minus === 'old' && d.changed[0].diff.plus === 'new')

    // 记录模式：不传 valueField ⇒ 逐字段比较
    const RA = project([{ key: 'r1', uk: 'Ближній', zh: '近战' }], {})
    const RB = project([{ key: 'r1', uk: 'Ближній бій', zh: '近战' }], {})
    const rd = diffRecords(RA.map, RB.map, { limit: 5 })
    ok('records mode reports the changed field only', rd.changed.length === 1 && rd.changed[0].fields.length === 1 && rd.changed[0].fields[0].field === 'uk', JSON.stringify(rd.changed[0]?.fields?.map((f) => f.field)))
}

console.log('== key mapping (join-ish) ==')
{
    const mapRows = [{ term: 'Melee', loc: 'Loc_Melee' }, { term: 'Ranged', loc: 'Loc_Ranged' }]
    const built = buildKeyMap(mapRows, 'term', 'loc')
    const km = built.map
    ok('buildKeyMap', km.get('Melee') === 'Loc_Melee', JSON.stringify([...km]))
    ok('buildKeyMap 报告行数/多行键', built.rows === 2 && built.multiCount === 0 && built.mode === 'last', JSON.stringify({ rows: built.rows, multi: built.multiCount, mode: built.mode }))
    // 一对多：term -> 多个 loc key（term_map.csv 的真实形状）
    const many = buildKeyMap([{ en: 'Blaze', key: 'loc_p1' }, { en: 'Blaze', key: 'loc_m2' }, { en: 'Blaze', key: 'loc_m3' }], 'en', 'key', 'all')
    ok('mapMode=all 展开一个键到全部目标', Array.isArray(many.map.get('Blaze')) && many.map.get('Blaze').length === 3, JSON.stringify(many.map.get('Blaze')))
    ok('多行键被计数', many.multiCount === 1, `multi=${many.multiCount}`)
    const first = buildKeyMap([{ en: 'Blaze', key: 'loc_p1' }, { en: 'Blaze', key: 'loc_m2' }], 'en', 'key', 'first')
    ok('mapMode=first 取首行', first.map.get('Blaze') === 'loc_p1', String(first.map.get('Blaze')))
    const last = buildKeyMap([{ en: 'Blaze', key: 'loc_p1' }, { en: 'Blaze', key: 'loc_m2' }], 'en', 'key', 'last')
    ok('mapMode=last 取末行（旧行为）', last.map.get('Blaze') === 'loc_m2', String(last.map.get('Blaze')))
    const ours = new Map([['Melee', 'Ближній бій'], ['Ranged', 'Дальній бій']])
    const remapped = new Map([...ours].map(([k, v]) => [km.get(k) ?? k, v]))
    const community = new Map([['Loc_Melee', 'Ближній бій'], ['Loc_Ranged', 'Дальній бій (community)']])
    const d = diffTables(remapped, community, { limit: 5 })
    ok('after remap the diff is meaningful', d.counts.changed === 1 && d.counts.added === 0 && d.counts.removed === 0, JSON.stringify(d.counts))
}

console.log('== scale: 3.7k x 12k keys (nested loop = 44M comparisons) ==')
{
    const A = project(Array.from({ length: 3700 }, (_, i) => ({ key: `Loc_${i}`, value: `value ${i}` })), {})
    const B = project(Array.from({ length: 12000 }, (_, i) => ({ key: `Loc_${i + 200}`, value: i % 3 === 0 ? `VALUE ${i + 200}` : `value ${i + 200}` })), {})
    const t0 = Date.now()
    const d = diffTables(A.map, B.map, { limit: 5 })
    const ms = Date.now() - t0
    console.log(`  3700 x 12000 -> ${ms} ms, counts=${JSON.stringify(d.counts)}`)
    ok('hash join is fast (< 200 ms)', ms < 200, `${ms} ms`)
}

console.log('== sqlite large-scale SQL join fallback (threshold lowered to exercise it) ==')
{
    const { DatabaseSync } = await import('node:sqlite')
    const mk = (file, rows) => {
        const p = join(sandbox, file)
        const db = new DatabaseSync(p)
        db.exec('create table t (k text, v text)')
        const ins = db.prepare('insert into t values (?,?)')
        for (const [k, v] of rows) ins.run(k, v)
        db.close()
        return `${p}#t`
    }
    const specA = mk('bigA.sqlite', [['k1', 'a1'], ['k2', 'a2'], ['k3', 'a3']])
    const specB = mk('bigB.sqlite', [['k1', 'a1'], ['k2', 'B2'], ['k4', 'b4']])
    const skipped = await diffSqliteLarge(specA, specB, { threshold: 100 })
    ok('below threshold -> null (Map path is faster)', skipped === null, String(skipped))
    const r = await diffSqliteLarge(specA, specB, { threshold: 1, limit: 5 })
 // via 改名 `sqlite-indexed-join`：实测，直接 FULL OUTER JOIN（键列无索引）会退化成
    // 嵌套扫描 —— 20 万 × 20 万跑了 9 分钟没结束（同步 SQLite 调用，JS 定时器插不进去 ⇒ 宿主被冻住）
    ok('above threshold -> indexed SQL join runs', r !== null && r.via === 'sqlite-indexed-join', JSON.stringify(r?.via))
    ok('SQL join counts match the Map path', r.counts.added === 1 && r.counts.removed === 1 && r.counts.changed === 1, JSON.stringify(r.counts))
    ok('SQL join 只取 limit 行（计数仍是真实总数）', r.added.length <= 5 && r.removed.length <= 5 && r.changed.length <= 5)
    ok('SQL join 带出键/值列名（输出里能说明用了哪两列）', typeof r.keyCols?.a === 'string' && typeof r.valueCols?.a === 'string', JSON.stringify({ k: r.keyCols, v: r.valueCols }))

 // F6 / F7 / F9（审计第四轮）
    const twoTable = (() => {
        const p = join(sandbox, 'two.sqlite')
        const db = new DatabaseSync(p)
        db.exec('create table loc (k text, v text)')
        db.exec('create table empty_ish (x text)')
        const ins = db.prepare('insert into loc values (?,?)')
        for (const [k, v] of [['k1', 'a1'], ['k2', 'a2']]) ins.run(k, v)
        db.exec("insert into empty_ish values ('y')")
        db.close()
        return p
    })()
    // F9：`#table(k,v)` 里的列名要当默认键/值列（以前括号被正则吃掉、静默忽略）
    const f9 = await recordsFrom(`${twoTable}#loc(k,v)`, {})
    ok('F9 #table(k,v) 解析出 keyHint/valueHint', f9.stats.keyHint === 'k' && f9.stats.valueHint === 'v', JSON.stringify({ k: f9.stats.keyHint, v: f9.stats.valueHint }))
    // F6：指定了表就不该再对库内每张表 count(*)（实测 800 万行的库因此从 202 ms 降到只看一张表）
    const f6 = await recordsFrom(`${twoTable}#loc`, {})
    ok('F6 指定表时只探测那一张（tables 长度 1，不是全库清单）', Array.isArray(f6.stats.tables) && f6.stats.tables.length === 1 && f6.stats.tables[0].name === 'loc', JSON.stringify(f6.stats.tables?.map((t) => t.name)))
    ok('F6 指定表时不再产生"自动选表"提示', !f6.stats.note, String(f6.stats.note))
    const f6b = await recordsFrom(twoTable, {})
    ok('F6 不指定时才列全库并自动选表', Array.isArray(f6b.stats.tables) && f6b.stats.tables.length === 2 && /自动选了/.test(f6b.stats.note ?? ''), String(f6b.stats.note).slice(0, 60))
    // F7：`query` 与 `#table` 同时给 ⇒ 必须说清谁生效（以前 source 仍写 #table，用户以为跑的是表）
    const f7 = await recordsFrom(`${twoTable}#loc`, { query: 'select k, v from loc' })
    ok('F7 query 覆盖 #table 时明确说明', /被忽略/.test(f7.stats.note ?? ''), String(f7.stats.note).slice(0, 70))
    ok('F7 source 反映实际执行的是 query', /#query/.test(f7.stats.source), f7.stats.source)
    // F8：接线条件 —— 普通 sqlite 路径 + 无投影时才走 SQL join（有 glob/映射/过滤仍走哈希连接）
    const tdTool = tools((x) => x, {}).find((x) => x.name === 'table_diff')
    const f8out = await tdTool.execute({ a: specA, b: specB }, { agent: { session: { header: { cwd: sandbox } } } })
    ok('F8 小表时不走 SQL join（阈值未达）', !/indexed-join/.test(f8out), f8out.split('\n')[2]?.slice(0, 50))
}

console.log('== audit: edge cases (BOM / non-UTF8 / directory / flat object / 0 records) ==')
{
    // 扁平对象：最常见的"键值表 JSON"写法，必须一条一个条目（以前被当成一条记录 ⇒ diff 无意义）
    writeFileSync(join(sandbox, 'flat.json'), JSON.stringify({ k1: 'v1', k2: 'v2' }))
    const flat = await load(join(sandbox, 'flat.json'))
    ok('扁平 JSON 对象 → 一条一个条目', flat.stats.records === 2 && flat.records[0].key === 'k1', JSON.stringify(flat.records[0]))

    // BOM：Windows 上很常见，JSON.parse 见到 \uFEFF 会抛
    writeFileSync(join(sandbox, 'bom.json'), `\uFEFF${JSON.stringify({ k1: 'v1' })}`)
    const bom = await load(join(sandbox, 'bom.json'))
    ok('带 BOM 的 JSON 能解析', bom.stats.records === 1, `records=${bom.stats.records}`)

    // 非 UTF-8（GBK）：解出来是乱码，必须主动提示而不是静默
    writeFileSync(join(sandbox, 'gbk.csv'), Buffer.from([0x6b, 0x2c, 0x76, 0x0a, 0xb2, 0xe2, 0xca, 0xd4, 0x2c, 0xd6, 0xb5, 0x0a]))
    const gbk = await load(join(sandbox, 'gbk.csv'))
    ok('非 UTF-8 文件给出编码告警', /不是 UTF-8|U\+FFFD/.test(gbk.stats.note ?? ''), gbk.stats.note ?? '(none)')

    // 目录当来源 ⇒ 明确告诉他用 glob
    let dirErr = ''
    try { await load(sandbox) }
    catch (e) { dirErr = e.message }
    ok('目录当来源时提示用 glob', /是目录/.test(dirErr) && /glob/.test(dirErr), dirErr.slice(0, 70))

    // 标量自动收敛 ⇒ 必须回传 valueField，否则工具会走整行模式并对字符串做 Object.keys
    const p = project([{ key: 'k1', value: 'v1' }], {})
    ok('标量收敛会把 valueField 回传', p.stats.valueField === 'value' && p.stats.scalarAuto === true, JSON.stringify(p.stats))
}

console.log('== tool layer (what the host actually calls) ==')
{
    const list = tools((t) => t)
    ok('table_diff + table_peek exposed', list.map((t) => t.name).sort().join(',') === 'table_diff,table_peek', list.map((t) => t.name).join(','))
    ok('every tool has description + parameters + output', list.every((t) => typeof t.description === 'string' && t.parameters && t.output))
    const by = (n) => list.find((t) => t.name === n)

    // mapA：用 properties 格式当映射表（term -> Loc_*），验证跨命名空间对照
    writeFileSync(join(sandbox, 'map.properties'), 'Melee=Loc_Melee\nRanged=Loc_Ranged\n')
    const a = join(sandbox, 'ours.json')
    writeFileSync(a, JSON.stringify([{ en: 'Melee', uk: 'Ближній бій' }, { en: 'Ranged', uk: 'Дальній бій' }]))
    const b = join(sandbox, 'theirs.json')
    writeFileSync(b, JSON.stringify([{ loc_keys: ['Loc_Melee'], handle_func: 'Ближній бій' }, { loc_keys: ['Loc_Ranged'], handle_func: 'Дальній бій (community)' }]))
    const out = await by('table_diff').execute({
        a, keyFieldA: 'en', valueFieldA: 'uk',
        b, keyFieldB: 'loc_keys[0]', valueFieldB: 'handle_func',
        mapA: join(sandbox, 'map.properties'), limit: 5,
    })
    ok('tool output header shows hash join + mapA 命中率行', out.includes('hash join O(N+M)') && /mapA .*命中 \d+\/\d+/.test(out), out.split('\n').slice(3, 5).join(' | '))
    ok('mapA remap makes the diff meaningful', out.includes('changed=1') && out.includes('Дальній бій'), out.split('\n').slice(-1)[0])

 // mapA 全不命中时必须告警（Darktide 的坑：静默输出"看起来正常"的统计）
    const missOut = await by('table_diff').execute({
        a, keyFieldA: 'en', valueFieldA: 'uk',
        b, keyFieldB: 'loc_keys[0]', valueFieldB: 'handle_func',
        mapA: b, limit: 3,
    })
    ok('mapA 命中 0 时明确告警', /命中 0\/\d+/.test(missOut) && missOut.includes('⚠'), missOut.split('\n').find((l) => l.includes('mapA')))

    // glob ↔ glob：把同目录下两个 JSON 合并成一个键空间
    writeFileSync(join(sandbox, 'pack1.json'), JSON.stringify([{ key: 'k1', value: 'v1' }]))
    writeFileSync(join(sandbox, 'pack2.json'), JSON.stringify([{ key: 'k2', value: 'v2' }, { key: 'k1', value: 'v1-dup' }]))
    const globOut = await by('table_diff').execute({ a: join(sandbox, 'pack*.json'), b: join(sandbox, 'pack1.json'), limit: 5 })
    ok('glob 合并多个文件', globOut.includes('files=2') && globOut.includes('合并 2 个文件'), globOut.split('\n').find((l) => l.includes('合并')))
    ok('glob 报告重复键', globOut.includes('重复键 1 个'), globOut.split('\n').find((l) => l.includes('重复键')))

    // SQLite 不给 #table ⇒ 列出表名+行数+候选字段
    const dbPath = join(sandbox, 'listing.sqlite')
    {
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(dbPath)
        db.exec('create table empty_names (a text)')
        db.exec('create table real_terms (hash text, key text, value text)')
        db.prepare('insert into real_terms values (?,?,?)').run('AA', 'loc_x', 'текст')
        db.close()
    }
    const peekDb = await by('table_peek').execute({ source: dbPath })
    ok('sqlite 未给 #table 时列出库内表', peekDb.includes('tables in this database') && peekDb.includes('real_terms') && peekDb.includes('empty_names'), peekDb.split('\n').slice(0, 3).join(' | '))
    ok('自动选行数最多的表（不是字母序第一张）', peekDb.includes('real_terms') && peekDb.includes('records=1'), peekDb.split('\n')[1])

    // 整行模式（不给 valueField）⇒ 逐字段；标量值走 (value) 伪字段，不能按字符比较
    const recA = join(sandbox, 'recA.json')
    writeFileSync(recA, JSON.stringify([{ key: 'r1', uk: 'Ближній', zh: '近战' }]))
    const recB = join(sandbox, 'recB.json')
    writeFileSync(recB, JSON.stringify([{ key: 'r1', uk: 'Ближній бій', zh: '近战' }]))
    const recOut = await by('table_diff').execute({ a: recA, b: recB, limit: 5 })
    ok('whole-record mode reports per-field changes', recOut.includes('mode=records') && recOut.includes('uk:') && recOut.includes('field(s)'), recOut.split('\n').slice(-3).join(' | '))

    // 0 记录 ⇒ 置顶告警（否则会被读成 no differences）
    writeFileSync(join(sandbox, 'emptyobj.json'), '{}')
    const zeroOut = await by('table_diff').execute({ a: join(sandbox, 'emptyobj.json'), b: recA, limit: 2 })
    ok('0 记录时置顶告警', zeroOut.includes('⚠⚠') && zeroOut.includes('0 条记录'), zeroOut.split('\n').find((l) => l.includes('⚠⚠')))

    // only / filter —— 只影响"展示哪一段"，计数必须是真实总数（否则 only=added 时三个计数全 0、看起来像没有差异）
    const onlyOut = await by('table_diff').execute({ a: recA, b: recB, only: 'added', limit: 5 })
    ok('only=added 只展示 added 段，但计数仍是真实总数', onlyOut.includes('只展示了 added 段') && onlyOut.includes('changed=1'), onlyOut.split('\n').find((l) => l.startsWith('mode=')))

    // table_peek
    const peek = await by('table_peek').execute({ source: join(sandbox, 'noext'), limit: 2 })
    ok('table_peek reports format/records/fields', peek.includes('records=2') && peek.includes('record fields:'), peek.split('\n').slice(0, 3).join(' | '))

    // 相对路径 ⇒ 必须按"会话工作区"解析，而不是宿主进程的 cwd（那是 profile 目录）
    const relTools = tools((t) => t, { resolveWorkspaceCwd: () => sandbox })
    const relPeek = await relTools.find((t) => t.name === 'table_peek').execute({ source: 'noext' })
    ok('relative path resolves against the session workspace', relPeek.includes('records=2'), relPeek.split('\n')[1])
    const relDiff = await relTools.find((t) => t.name === 'table_diff').execute({ a: 'ours.json', keyFieldA: 'en', valueFieldA: 'uk', b: 'theirs.json', keyFieldB: 'loc_keys[0]', valueFieldB: 'handle_func', mapA: 'map.properties', limit: 3 })
    ok('relative a/b/mapA all resolve', relDiff.includes('records=2') && relDiff.includes('changed=1'), relDiff.split('\n')[5])

    // 实测得到的真实来源：exec.agent.session.header.cwd（不依赖 resolveWorkspaceCwd）
    const execTools = tools((t) => t, {})
    const exec = { agent: { session: { header: { cwd: sandbox } } } }
    const exPeek = await execTools.find((t) => t.name === 'table_peek').execute({ source: 'noext' }, exec)
    ok('relative path resolves from exec.agent.session.header.cwd', exPeek.includes('records=2'), exPeek.split('\n')[1])
    const exDiff = await execTools.find((t) => t.name === 'table_diff').execute({ a: 'ours.json', keyFieldA: 'en', valueFieldA: 'uk', b: 'theirs.json', keyFieldB: 'loc_keys[0]', valueFieldB: 'handle_func', mapA: 'map.properties', limit: 3 }, exec)
    ok('a/b/mapA resolve from the calling session cwd', exDiff.includes('changed=1'), exDiff.split('\n')[5])

 // 相对 glob：基目录也必须按调用方会话 cwd 解析（Darktide 报的 bug：相对 glob 匹配不到任何文件）
    ok('globBaseOf 取第一个通配符之前的目录', globBaseOf('refs/a/b/part*.lua') === 'refs/a/b/' && globBaseOf('plain.json') === 'plain.json', globBaseOf('refs/a/b/part*.lua'))
    const relGlob = await execTools.find((t) => t.name === 'table_diff').execute({ a: 'pack*.json', b: 'pack1.json', limit: 3 }, exec)
    ok('相对 glob 能展开（基目录走会话 cwd）', relGlob.includes('files=2') && relGlob.includes('合并 2 个文件'), relGlob.split('\n').find((l) => l.includes('合并')))
    const missingGlob = await execTools.find((t) => t.name === 'table_diff').execute({ a: 'nope/*.json', b: 'pack1.json', limit: 3 }, exec)
    ok('glob 0 命中时醒目告警 + 回显基目录', missingGlob.includes('⚠⚠') && missingGlob.includes('基目录'), missingGlob.split('\n').find((l) => l.includes('没匹配到')))

 // 0 数据时的"结论行"必须被替换掉：以前告警夹在中间、底部仍打印 no differences（复查发现，
    // 正是 Darktide 当初踩的"读成没有差异"）。三条不变量一起锁住。
    const both0 = await execTools.find((t) => t.name === 'table_diff').execute({ a: 'nope/*.json', b: 'nope2/*.json', limit: 3 }, exec)
    ok('两侧 0 文件时告警置顶（第 0 行）', both0.split('\n')[0].startsWith('⚠⚠'), both0.split('\n')[0].slice(0, 50))
    ok('两侧 0 文件时不写 no differences', !both0.includes('no differences') && both0.includes('无法比较'))
    const one0 = await execTools.find((t) => t.name === 'table_diff').execute({ a: 'pack1.json', b: 'nope2/*.json', limit: 3 }, exec)
    ok('单侧 0 文件同样替换结论行', one0.split('\n')[0].startsWith('⚠⚠') && !one0.includes('no differences'), one0.split('\n')[0].slice(0, 46))

 // records 模式的 added/removed 值以前会被插成 `[object Object]`（Darktide 实测报的）
    writeFileSync(join(sandbox, 'objA.json'), JSON.stringify({ k1: { a: 1, b: 2, c: 3, d: 4, e: 5 }, k2: { x: 'old' } }))
    writeFileSync(join(sandbox, 'objB.json'), JSON.stringify({ k1: { a: 1, b: 2, c: 3, d: 4, e: 5 }, k3: { x: 'new', y: 1 } }))
    const objOut = await by('table_diff').execute({ a: join(sandbox, 'objA.json'), b: join(sandbox, 'objB.json'), limit: 5 })
    ok('records 模式不打印 [object Object]', !objOut.includes('[object Object]'), objOut.split('\n').find((l) => l.includes('only in B')) ?? '')
    ok('records 模式 added 给字段摘要', objOut.includes('+ k3 = {x=new, y=1}'), objOut.split('\n').find((l) => l.startsWith('+')) ?? '')
    ok('records 模式 removed 给字段摘要', objOut.includes('- k2 = {x=old}'), objOut.split('\n').find((l) => l.startsWith('-')) ?? '')
    const objNoVal = await by('table_diff').execute({ a: join(sandbox, 'objA.json'), b: join(sandbox, 'objB.json'), limit: 5, showValues: false })
    ok('showValues=false 时 records 只给键（不带值）', objNoVal.includes('+ k3') && !objNoVal.includes('{x=new') && !objNoVal.includes('[object Object]'))
}

console.log('== real corpus (optional: node test/tablediff-selftest.mjs <workspace-dir>) ==')
{
    const root = process.argv[2]
    if (root === undefined) {
        console.log('  SKIP  未给出本地真实语料目录（不是失败）；给了目录就会跑这几条')
    }
    else {
    const oursNew = `${root}/repos/auto_translate/translations/glossary.lua`
    const oursOld = `${root}/.dtsrc/v024/translations/glossary.lua`
    const community = `${root}/refs/localizations/ukrainian-3.2.2/UkrainianLocalization/scripts/mods/UkrainianLocalization/UkrainianLocalization_ukr_term.lua`
    try {
        const t0 = Date.now()
        const A = await load(oursNew)
        const B = await load(oursOld)
        const C = await load(community)
        const parseMs = Date.now() - t0
        const ukA = project(A.records, { keyField: 'en', valueField: 'uk' })
        const ukB = project(B.records, { keyField: 'en', valueField: 'uk' })
        const com = project(C.records, { keyField: 'loc_keys[0]', valueField: 'handle_func' })
        const d = diffTables(ukA.map, ukB.map, { limit: 3, showValues: true })
        const ms = Date.now() - t0
        console.log(`  glossary(new) records=${A.stats.records}  glossary(v024) records=${B.stats.records}  community records=${C.stats.records}`)
        console.log(`  parse ${parseMs} ms; diff(new vs v024, uk) => ${JSON.stringify(d.counts)}`)
        console.log(`  sample: ${JSON.stringify(d.changed[0] ?? d.added[0] ?? d.removed[0] ?? null).slice(0, 180)}`)
        ok('real files parsed into >500 records', A.stats.records > 1000 && B.stats.records > 500, `A=${A.stats.records} B=${B.stats.records}`)
        ok('community file parsed', C.stats.records > 100, `C=${C.stats.records}`)
        ok('real parse+diff under 3 s', ms < 3000, `${ms} ms`)
    }
    catch (e) {
        console.log('  (skipped: ' + e.message + ')')
    }
    }
}

// == zip/jar + TOML 适配器（新增：MC 模组跟版对比用）==
console.log('== zip/jar 与 TOML 适配器 ==')
{

    const jarA = join(sandbox, 'v1.jar')
    const jarB = join(sandbox, 'v2.jar')
    makeZip(jarA, [
        ['META-INF/mods.toml', 'modLoader="javafml"\n[[mods]]\nmodId="hojojutsu"\nversion="1.2.3"\n'],
        ['assets/x/lang/en_us.json', '{"a":"1","b":"2"}\n'],
        ['data/x/recipes/r.json', '{"type":"x"}\n'],
        ['io/x/A.class', '\u0000\u0001binaryish'],
    ])
    makeZip(jarB, [
        ['META-INF/mods.toml', 'modLoader="javafml"\n[[mods]]\nmodId="hojojutsu"\nversion="1.2.4"\n'],
        ['assets/x/lang/en_us.json', '{"a":"1","b":"2","c":"3"}\n'],
        ['data/x/recipes/r.json', '{"type":"x"}\n'],
        ['data/x/recipes/new.json', '{"type":"y"}\n'],
    ])

    const listA = await recordsFrom(jarA, {})
    const listB = await recordsFrom(jarB, {})
    ok('jar 清单：格式=zip 且条目数对得上', listA.stats.format === 'zip' && listA.stats.records === 4 && listB.stats.records === 4, `${listA.stats.records}/${listB.stats.records}`)
    ok('jar 清单：记录带 path/size/crc32/method', typeof listA.records[0].path === 'string' && typeof listA.records[0].crc32 === 'string' && listA.records[0].method === 0, JSON.stringify(listA.records[0]).slice(0, 70))
    const dList = diffTables(new Map(listA.records.map((r) => [r.path, r.crc32])), new Map(listB.records.map((r) => [r.path, r.crc32])))
    ok('两个 jar 的条目差异：新增/删除/改动都对', dList.counts.added === 1 && dList.counts.removed === 1 && dList.counts.changed === 2, JSON.stringify(dList.counts))
    ok('DEFAULT_KEY_FIELDS 含 path（jar 清单自动拿 path 当键）', DEFAULT_KEY_FIELDS.includes('path'))

    const tomlA = await recordsFrom(`${jarA}#entry:META-INF/mods.toml`, {})
    const tomlB = await recordsFrom(`${jarB}#entry:META-INF/mods.toml`, {})
    ok('#entry:TOML 解析成功且 source 记的是条目', tomlA.stats.format === 'toml' && tomlA.stats.records >= 3 && /#entry:META-INF\/mods\.toml$/.test(tomlA.stats.source), tomlA.stats.source.slice(-46))
    const tDiff = diffTables(new Map(tomlA.records.map((r) => [r.key, r.value])), new Map(tomlB.records.map((r) => [r.key, r.value])))
    ok('#entry:TOML 能看出 version 1.2.3 → 1.2.4', tDiff.counts.changed === 1 && tDiff.changed[0].key === 'mods.0.version', JSON.stringify(tDiff.changed[0] ?? tDiff.counts))
    const langA = await recordsFrom(`${jarA}#entry:assets/x/lang/en_us.json`, {})
    ok('#entry:JSON 自动按条目扩展名选格式', langA.stats.format === 'json' && langA.stats.records === 2, JSON.stringify(langA.stats.records))
    let binErr = null
    try { await recordsFrom(`${jarA}#entry:io/x/A.class`, {}) }
    catch (e) { binErr = e.message }
    ok('二进制条目被明确拒绝（并指向反编译）', binErr !== null && /二进制/.test(binErr), (binErr ?? '').slice(0, 60))
    let missErr = null
    try { await recordsFrom(`${jarA}#entry:nope.txt`, {}) }
    catch (e) { missErr = e.message }
    ok('条目不存在时给出可操作提示', missErr !== null && /没有条目/.test(missErr), (missErr ?? '').slice(0, 50))

    const tomlFile = join(sandbox, 'mods.toml')
    writeFileSync(tomlFile, [
        '# 注释',
        'modLoader = "javafml"',
        'loaderVersion = "[47,)"',
        '[[mods]]',
        'modId = "hojojutsu"',
        'version = "1.2.4"',
        'authors = ["Zershyan"]',
        'description = """多行',
        '描述"""',
        '[[dependencies.hojojutsu]]',
        'modId = "neoforge"',
        'type = "required"',
        'versionRange = "[21.1,)"',
        '',
    ].join('\n'), 'utf8')
    const tRec = await recordsFrom(tomlFile, {})
    const tMap = new Map(tRec.records.map((r) => [r.key, r.value]))
    ok('TOML：顶层键', tMap.get('modLoader') === 'javafml' && tMap.get('loaderVersion') === '[47,)', `${tMap.get('modLoader')}/${tMap.get('loaderVersion')}`)
    ok('TOML：数组表的索引键', tMap.get('mods.0.modId') === 'hojojutsu' && tMap.get('mods.0.version') === '1.2.4', String(tMap.get('mods.0.modId')))
    ok('TOML：数组值', tMap.get('mods.0.authors') === '["Zershyan"]', String(tMap.get('mods.0.authors')))
    ok('TOML：多行字符串', /多行/.test(String(tMap.get('mods.0.description'))), String(tMap.get('mods.0.description')).slice(0, 24))
    ok('TOML：嵌套数组表', tMap.get('dependencies.hojojutsu.0.modId') === 'neoforge' && tMap.get('dependencies.hojojutsu.0.type') === 'required', String(tMap.get('dependencies.hojojutsu.0.modId')))
    ok('TOML：注释被忽略', ![...tMap.keys()].some((k) => k.includes('注释')))
}

// == 混淆映射适配器（MC 跟版时"这版把哪些符号改名了"）==
console.log('== mappings（Mojang/SRG/TSRG/Tiny）==')
{
    const mojangA = join(sandbox, 'map-a.txt')
    const mojangB = join(sandbox, 'map-b.txt')
    writeFileSync(mojangA, [
        '# (c) test',
        'com.example.Foo -> abc:',
        '    # {"fileName":"Foo.java","id":"sourceFile"}',
        '    1:2:void method_1(int) -> a',
        '    3:3:double getTime() -> b',
        '    java.lang.String field_1 -> c',
        'com.example.Bar -> abd:',
        '    9:9:void gone() -> a',
        // 桥接方法：**同名同参数、只有返回类型不同**（真实 Mojang 映射里存在；只按 (args) 做键会撞）
        '    11:12:java.lang.Object bridge(int) -> a',
        '    13:14:java.lang.String bridge(int) -> b',
        '',
    ].join('\n'), 'utf8')
    writeFileSync(mojangB, [
        '# (c) test',
        'com.example.Foo -> xyz:',
        '    1:2:void method_1(int) -> a',
        '    4:4:double getTime() -> b',
        '    java.lang.String field_1 -> c',
        'com.example.Baz -> abd:',
        '',
    ].join('\n'), 'utf8')

    const rA = await recordsFrom(mojangA, {})
    const rB = await recordsFrom(mojangB, {})
    ok('Mojang：按内容嗅探认出（扩展名是 .txt）', rA.stats.format === 'mappings:mojang' && rB.stats.format === 'mappings:mojang', rA.stats.format)
    const kindsA = rA.records.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {})
    ok('Mojang：class/field/method 都解析出来', kindsA.class === 2 && kindsA.field === 1 && kindsA.method === 5, JSON.stringify(kindsA))
    ok('Mojang：重载方法用签名区分（键带 desc 与返回类型）', rA.records.some((r) => r.key === 'com.example.Foo.method_1(int):void'), JSON.stringify(rA.records.map((r) => r.key).slice(0, 4)))
    // 桥接方法：同名同参数、仅返回类型不同 ⇒ 必须产生**两个不同键**（真实 Mojang 映射实测：不带返回类型会有 100+ 重复键）
    const bridgeKeys = rA.records.filter((r) => r.key.includes('.bridge(int)')).map((r) => r.key)
    ok('Mojang：桥接方法（仅返回类型不同）不被覆盖', bridgeKeys.length === 2 && new Set(bridgeKeys).size === 2, JSON.stringify(bridgeKeys))
    const dMap = diffTables(new Map(rA.records.map((r) => [r.key, r.value])), new Map(rB.records.map((r) => [r.key, r.value])))
    ok('两版映射：类改名 + 方法消失/新增都能看出来', dMap.counts.changed === 1 && dMap.counts.removed === 4 && dMap.counts.added === 1, JSON.stringify(dMap.counts))
    ok('mappings 的 note 会说明左右方向（避免看反）', /左=可读名，右=混淆名/.test(rA.stats.note), rA.stats.note.slice(0, 40))

    const tsrg2 = join(sandbox, 'joined.tsrg')
    writeFileSync(tsrg2, [
        'tsrg2 obf srg id',
        'a net/minecraft/src/C_1_ 100',
        '\ta f_2_ 200',
        '\t\tstatic',
        '\tm_3_ (I)V m_3_ 300',
        '\tm_4_ (I)V m_4_ 301',
        '',
    ].join('\n'), 'utf8')
    const rT = await recordsFrom(tsrg2, {})
    const tMap2 = new Map(rT.records.map((r) => [r.key, r.value]))
    ok('TSRG2：识别为 tsrg2 且命名空间写进 note', rT.stats.format === 'mappings:tsrg2' && /obf\|srg\|id/.test(rT.stats.note), rT.stats.note.slice(0, 60))
    ok('TSRG2：**跳过数字 id 列**，取 srg（键=混淆名，值=可读名）', tMap2.get('a') === 'net/minecraft/src/C_1_' && tMap2.get('a.a') === 'f_2_', `${tMap2.get('a')} / ${tMap2.get('a.a')}`)
    ok('TSRG2：方法（带描述符）解析正确', tMap2.get('a.m_3_(I)V') === 'm_3_', String(tMap2.get('a.m_3_(I)V')))
    ok('TSRG2：访问修饰行（多一层缩进）被跳过', rT.records.length === 4, String(rT.records.length))

    const srg = join(sandbox, 'forge.srg')
    writeFileSync(srg, [
        'PK: net/minecraft/src/',
        'CL: aaa net/minecraft/src/Foo',
        'FD: aaa/field_1 net/minecraft/src/Foo/field_1',
        'MD: aaa/method_1 (I)V net/minecraft/src/Foo/method_1 (I)V',
        '',
    ].join('\n'), 'utf8')
    const rS = await recordsFrom(srg, {})
    const sMap = new Map(rS.records.map((r) => [r.key, r.value]))
    ok('SRG：CL/FD/MD 三类都解析', rS.stats.format === 'mappings:srg' && sMap.get('aaa') === 'net/minecraft/src/Foo' && sMap.get('aaa/method_1(I)V') === 'net/minecraft/src/Foo/method_1(I)V', JSON.stringify([...sMap.entries()].slice(0, 3)))

    const tiny = join(sandbox, 'yarn.tiny')
    writeFileSync(tiny, [
        'tiny\t2\t0\tofficial\tintermediary\tnamed',
        'c\taaa\tnet/minecraft/Foo',
        '\tf\tLjava/lang/String;\tfield_1\tvalue',
        '\tm\t(I)V\tmethod_1\tsetValue',
        '',
    ].join('\n'), 'utf8')
    const rY = await recordsFrom(tiny, {})
    const yMap = new Map(rY.records.map((r) => [r.key, r.value]))
    ok('Tiny v2：类/字段/方法都解析', rY.stats.format === 'mappings:tiny2' && yMap.get('aaa') === 'net/minecraft/Foo' && yMap.get('aaa.method_1(I)V') === 'setValue' && yMap.get('aaa.field_1') === 'value', JSON.stringify([...yMap.entries()].slice(0, 3)))
    ok('Tiny v2：命名空间写进 note', /intermediary\|named/.test(rY.stats.note), rY.stats.note.slice(0, 60))

    const plain = join(sandbox, 'plain.txt')
    writeFileSync(plain, 'hello\nworld\n', 'utf8')
    const rP = await recordsFrom(plain, {})
    ok('普通 .txt 不会被误认成映射', rP.stats.format !== 'mappings:mojang', rP.stats.format)

    // 映射适配器宣告 valueField ⇒ table_diff 默认走**值模式**（"名字对名字"），而不是逐字段记录模式
    const tdMap = tools((x) => x, {}).find((x) => x.name === 'table_diff')
    const mapOut = await tdMap.execute({ a: mojangA, b: mojangB }, { agent: { session: { header: { cwd: sandbox } } } })
    ok('映射对比默认走值模式（key=key value=value）', /mode=values/.test(mapOut) && /value=value/.test(mapOut), (mapOut.split('\n')[1] ?? '').trim().slice(0, 60))
}

// == 回归护栏（新适配器会不会把**以前修过的问题**带回来）==
console.log('== 回归：新格式 × 老修复点 ==')
{
    const ex = { agent: { session: { header: { cwd: sandbox } } } }
    const tds = tools((x) => x, {}).find((x) => x.name === 'table_diff')
    const pks = tools((x) => x, {}).find((x) => x.name === 'table_peek')

    // ① 相对路径由**工具层**解析（基准 = 调用方会话工作区），新格式也必须走这条
    makeZip(join(sandbox, 'rel.jar'), [['META-INF/mods.toml', 'modLoader="javafml"\n[[mods]]\nmodId="a"\nversion="1.0"\n']])
    writeFileSync(join(sandbox, 'rel.toml'), 'modLoader = "javafml"\n[[mods]]\nmodId = "a"\n', 'utf8')
    writeFileSync(join(sandbox, 'rel.map.txt'), 'com.a.Foo -> abc:\n    1:1:void go() -> a\n', 'utf8')
    const relJar = await tds.execute({ a: 'rel.jar', b: 'rel.jar', keyField: 'path' }, ex)
    ok('① 相对 jar 路径可用（会话工作区）', /format=zip/.test(relJar), (relJar.split('\n')[1] ?? '').trim().slice(0, 56))
    const relEntry = await tds.execute({ a: 'rel.jar#entry:META-INF/mods.toml', b: 'rel.jar#entry:META-INF/mods.toml' }, ex)
    ok('① 相对 jar#entry: 可用', /format=toml/.test(relEntry), (relEntry.split('\n')[1] ?? '').trim().slice(0, 56))
    const relToml = await tds.execute({ a: 'rel.toml', b: 'rel.toml' }, ex)
    ok('① 相对 TOML 可用', /format=toml/.test(relToml), (relToml.split('\n')[1] ?? '').trim().slice(0, 56))
    const relMap = await tds.execute({ a: 'rel.map.txt', b: 'rel.map.txt' }, ex)
    ok('① 相对映射 .txt 可用（内容嗅探）', /format=mappings:mojang/.test(relMap), (relMap.split('\n')[1] ?? '').trim().slice(0, 56))

    // ② 坏输入必须报错，不能静默 0
    writeFileSync(join(sandbox, 'fake.jar'), 'plain text', 'utf8')
    let fakeErr = null
    try { await tds.execute({ a: 'fake.jar', b: 'fake.jar' }, ex) } catch (e) { fakeErr = e.message }
    ok('② 假 jar → 明确报错', fakeErr !== null && /不是 zip\/jar|EOCD/.test(fakeErr), (fakeErr ?? '').replace(/\s+/g, ' ').slice(0, 56))

    // ③ jar 内非 UTF-8 条目 → 带编码提示的可操作错误（不是裸 SyntaxError）
    const bad = Buffer.from([0x7B, 0x22, 0xB0, 0xA1, 0x22, 0x7D])
    makeZip(join(sandbox, 'badenc.jar'), [['assets/a/lang/zh.json', bad]])
    let encErr = null
    try { await pks.execute({ source: 'badenc.jar#entry:assets/a/lang/zh.json' }, ex) } catch (e) { encErr = e.message }
    ok('③ jar 内非 UTF-8 → 有编码提示', encErr !== null && /U\+FFFD|替换字符/.test(encErr) && !/^SyntaxError/.test(encErr), (encErr ?? '').replace(/\s+/g, ' ').slice(0, 70))

    // ④ zip 炸弹：声明解压后超上限 ⇒ 秒拒（不读、不解压）
    const bomb = join(sandbox, 'bomb.jar')
    makeZip(bomb, [['big.txt', 'tiny']])
    // 手动把该条目的"声明解压大小"改成 100 MB（central directory + local header 两处）
    {
        const raw = readFileSync(bomb)
        const cen = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
        const loc = raw.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        raw.writeUInt32LE(100 * 1024 * 1024, cen + 24)
        raw.writeUInt32LE(100 * 1024 * 1024, loc + 22)
        writeFileSync(bomb, raw)
    }
    let bombErr = null
    const t0 = Date.now()
    try { await tds.execute({ a: 'bomb.jar#entry:big.txt', b: 'bomb.jar#entry:big.txt' }, ex) } catch (e) { bombErr = e.message }
    ok('④ 声明 100 MB 的条目 → 秒拒并说明上限', bombErr !== null && /超过单条目上限|上限/.test(bombErr) && Date.now() - t0 < 2000, `${Date.now() - t0}ms ${(bombErr ?? '').replace(/\s+/g, ' ').slice(0, 60)}`)

    // ⑤ 同名 zip 条目 ⇒ 重复键告警（老修复点：单文件内重复键必须外显）
    makeZip(join(sandbox, 'dup.jar'), [['x.txt', 'one\n'], ['x.txt', 'two\n']])
    const dupOut = await tds.execute({ a: 'dup.jar', b: 'dup.jar' }, ex)
    ok('⑤ 同名 zip 条目 → 重复键告警', /重复键/.test(dupOut), (dupOut.split('\n').find((l) => l.includes('重复键')) ?? '').slice(0, 54))

    // ⑥ 按文件大小分档：小包整包读；大包只读"尾部 + 中央目录"。**两条路径结果必须完全一致**。
    const jarPath = join(sandbox, 'rel.jar')
    const whole = listZipEntries(jarPath)
    const bounded = listZipEntries(jarPath, { wholeReadLimit: 0 })
    const sameEntries = whole.entries.length === bounded.entries.length
        && whole.entries.every((x, i) => x.path === bounded.entries[i].path && x.size === bounded.entries[i].size
            && x.crc32 === bounded.entries[i].crc32 && x.compressed === bounded.entries[i].compressed && x.localOff === bounded.entries[i].localOff)
    ok('⑥ 整包读与大包有界读结果完全一致', sameEntries, `${whole.entries.length} vs ${bounded.entries.length}`)
    ok('⑥ 大包路径说明"只读了尾部与中央目录"', /中央目录/.test(bounded.stats.note ?? ''), (bounded.stats.note ?? '').slice(0, 62))
    ok('⑥ 有界路径下取单个条目仍可用', (readZipEntry(jarPath, 'META-INF/mods.toml')?.length ?? 0) > 0)
}

// == 未知扩展名的内容嗅探（重写）+ 内联侧 `text:`（评审建议 5）==
console.log('== 嗅探与内联侧（text:）==')
{
    const sniffDir = join(sandbox, 'sniff')
    mkdirSync(sniffDir, { recursive: true })
    const ex = { agent: { session: { header: { cwd: sniffDir } } } }
    const tds = tools((x) => x, {}).find((x) => x.name === 'table_diff')
    const pks = tools((x) => x, {}).find((x) => x.name === 'table_peek')

    // 旧实现只试 json → properties → csv ⇒ TOML/YAML/JSONL 会被**静默**当成 properties（给出看似正常的错 diff）
    const cases = [
        ['jsonl', '{"k":"a","v":1}\n{"k":"b","v":2}\n'],
        ['json', '{"a":1,"b":2}'],
        ['toml', 'x = 1\n[t]\ny = 2\n'],
        ['yaml', 'x: 1\nt:\n  y: 2\n'],
        ['properties', 'a=1\nb: 2\n'],
        ['lua', 'return {\n  a = 1,\n}\n'],
        ['csv', 'k,v\na,1\nb,2\n'],
    ]
    for (const [want, body] of cases) {
        const p = join(sniffDir, 'unknown.txt')
        writeFileSync(p, body, 'utf8')
        const r = await recordsFrom(p, {})
        if (want === 'yaml') {
            // ⚠️ 源码树里**没有** `yaml` 包（依赖只装在 profile 副本）⇒ 这一条在源码树会降级。
            // 降级可以，但**必须点名**（否则会被当成"这文件就是 properties"）。
            // 注意：降级时 `stats.format` 仍是 'yaml'，所以不能用 format 判可用性，要看 records/note。
            const y = await recordsFrom(p, { format: 'yaml' })
            const yamlAvailable = y.stats.records > 0 && !/unavailable|不可用/.test(y.stats.note ?? '')
            if (yamlAvailable) ok('嗅探：yaml 被正确识别（扩展名未知）', r.stats.format === 'yaml', `识别成 ${r.stats.format}`)
            else ok('嗅探：yaml 模块不可用时明确点名（不静默当 properties）', /yaml 模块不可用已跳过/.test(r.stats.note ?? ''), (r.stats.note ?? '').slice(0, 70))
            continue
        }
        ok(`嗅探：${want} 被正确识别（扩展名未知）`, r.stats.format === want, `识别成 ${r.stats.format} records=${r.stats.records} skipped=${r.stats.skipped ?? 0}`)
    }
    {
        const p = join(sniffDir, 'unknown.txt')
        writeFileSync(p, 'x = 1\n[t]\ny = 2\n', 'utf8')
        const r = await recordsFrom(p, {})
        ok('嗅探回显 "format guessed as X"（并点名其它候选）', /format guessed as toml/.test(r.stats.note ?? ''), (r.stats.note ?? '').slice(0, 70))
    }

    // 内联侧：`text:<内容>` —— 不必先落临时文件
    writeFileSync(join(sniffDir, 'live.toml'), 'x = 1\n[t]\ny = 2\n', 'utf8')
    const inlineVsFile = await tds.execute({ a: 'text:x = 1\n[t]\ny = 3', b: 'live.toml', format: 'toml' }, ex)
    ok('内联 text: vs 真实文件能看出差异', /changed=1/.test(inlineVsFile) && /format=toml/.test(inlineVsFile), (inlineVsFile.split('\n').find((l) => l.includes('mode=')) ?? '').slice(0, 60))
    const inlineVsInline = await tds.execute({ a: 'text:{"a":1,"b":2}', b: 'text:{"a":1,"b":3}' }, ex)
    ok('内联 vs 内联（自动嗅探 json）', /mode=values/.test(inlineVsInline) && /changed=1/.test(inlineVsInline), (inlineVsInline.split('\n').find((l) => l.includes('mode=')) ?? '').slice(0, 60))
    const peekInline = await pks.execute({ source: 'text:x = 1\n[t]\ny = 2\n' }, ex)
    ok('table_peek 也支持 text:（对称）', /format=toml/.test(peekInline), peekInline.split('\n').slice(1, 2).join('').trim().slice(0, 60))
    let emptyInline = null
    try { await tds.execute({ a: 'text:   ', b: 'live.toml', format: 'toml' }, ex) }
    catch (e) { emptyInline = e.message }
    ok('空 text: 明确报错（不是静默空表）', emptyInline !== null && /没有内容/.test(emptyInline), (emptyInline ?? '').slice(0, 60))
    const absPath = await tds.execute({ a: join(sniffDir, 'live.toml'), b: join(sniffDir, 'live.toml') }, ex)
 // 表头只回显 `<inline: N 字符>`，**不喷全文**（MCMOD 复核建议 5 的跟进）
    const longInline = `text:${JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, `v${i}`])))}`
    const longOut = await tds.execute({ a: longInline, b: longInline }, ex)
    ok('内联侧表头只回显长度（不喷全文）', /<inline: \d+ 字符>/.test(longOut) && !/k29/.test(longOut.split('\n').slice(0, 3).join('')), longOut.split('\n')[0].trim().slice(0, 40))
    ok('真实绝对路径不会被误当内联（只在开头匹配 text:）', /format=toml/.test(absPath) && /files=1/.test(absPath), absPath.split('\n')[1]?.trim().slice(0, 56))
}

rmSync(sandbox, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

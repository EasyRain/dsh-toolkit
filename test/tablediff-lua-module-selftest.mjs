/**
 * tablediff-lua-module-selftest.mjs —— 「模块化 Lua」+「值归一化」+「多列一次比」
 * （Darktide 工作区提案 P1/P2/P3 的**自带夹具**回归；不依赖别的工作区）
 *
 * 提案背景：本地化/配置类 mod 最常见的写法是
 *   local data = { ["loc_key"] = { en = ..., ["zh-cn"] = ... } }   ← 数据
 *   for … do table.insert(out, …) end                              ← 运行时拼数组
 *   return out                                                     ← 不是字面量表
 * 旧读取器只认顶层 `return {…}` ⇒ 这类文件**静默**返回 1 条 `__expr`（看起来像"只有一条数据"）。
 *
 * 本文件断言：
 *   L1 模块化 Lua 能读出数据表（records / 键 / 语言字段；`en = …` 与 `["zh-tw"] = …` 两种键都要认）
 *   L2 多个候选表 ⇒ 选**顶层键最多**的，并在 note 里说明选了哪张、还有哪些候选
 *   L3 `table=` 显式指定（含"不存在就报错"）
 *   L4 **读不出表时必须报错**（不许再静默降级成 1 条 `__expr`）
 *   L5 顶层就是字面量表 ⇒ 行为与以前完全一致（不产生 note）
 *   L6 单行内联 `return {…}` 也要被嗅探成 lua（以前要求 `{` 独占一行）
 *   N1 归一化：numbers / placeholders / skeleton / tokens；标记 `{#color(…)}` 里的数字不算数值
 *   N2 语序差异**不再是差异**（集合语义），但"少一个占位符/少一行数值"仍然是差异
 *   N3 ordered:true 才位置敏感
 *   D1 工具层端到端：同一文件两侧按列比；normalize=skeleton 让 changed 降下来
 *   D2 多列一次比（valueFields）；与 valueField 同给要报错
 *   D3 table_peek 能预览归一化结果与 table= 的选表说明
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../lib/tablediff/index.js'
import { luaRecords } from '../lib/tablediff/adapters.js'
import { normalizeText, NORMALIZE_MODES } from '../lib/tablediff/normalize.js'

let passed = 0
let failures = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}
const throws = (fn) => { try { fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) } }
const rejects = async (fn) => { try { await fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) } }

const sandbox = mkdtempSync(join(tmpdir(), 'td-lua-module-'))
const list = tools((t) => t, {})
const diff = list.find((t) => t.name === 'table_diff')
const peek = list.find((t) => t.name === 'table_peek')
const exec = { agent: { session: { header: { cwd: sandbox } } } }
const write = (name, text) => { const p = join(sandbox, name); writeFileSync(p, text); return p }

// ---- 教科书式的「模块化 Lua」（提案 §1 的形状，缩成一个可断言的小样本）----
const MODULE_LUA = `
local mod = get_mod("Example")
local Utils = mod.get_utils()
local create_template = Utils.create_template

local curios_localizations = {
	["loc_a"] = { en = "A {ammo} 50%", ["zh-cn"] = "甲 {ammo} 50%", ["zh-tw"] = "甲甲" },
	["loc_b"] = { en = "Heal {hp} for 20", ["zh-cn"] = "治疗" },
	["loc_c"] = { en = "C", ["zh-tw"] = "丙" },
}

local localization_templates = {}
for loc_key, locales in pairs(curios_localizations) do
	for locale, text in pairs(locales) do
		table.insert(localization_templates, create_template(loc_key, {loc_key}, {locale}, loc_text(text)))
	end
end
return localization_templates
`

console.log('== L1 模块化 Lua：能读出数据表 ==')
{
    const r = luaRecords(MODULE_LUA)
    ok('L1 records = 3（旧实现是 1 条 __expr）', r.stats.records === 3, `records=${r.stats.records}`)
    ok('L1 键是 loc_*（__luaKey）', r.records.map((x) => x.__luaKey).join(',') === 'loc_a,loc_b,loc_c', r.records.map((x) => x.__luaKey).join(','))
    ok('L1 两种键写法都认（en=… 与 ["zh-tw"]=…）', r.records[0].en === 'A {ammo} 50%' && r.records[0]['zh-tw'] === '甲甲' && r.records[0]['zh-cn'] === '甲 {ammo} 50%', JSON.stringify(r.records[0]).slice(0, 90))
    ok('L1 缺的语言就是缺（不补空串）', !('ru' in r.records[0]) && !('zh-cn' in r.records[2]))
    ok('L1 note 说明选了哪张表', /curios_localizations/.test(String(r.stats.note)) && /最大的字面量表/.test(String(r.stats.note)), String(r.stats.note).slice(0, 76))
}

console.log('== L2 多候选：选键最多的，并列出其它候选 ==')
{
    const p = write('multi.lua', `
local small = { k1 = { en = "1" }, k2 = { en = "2" } }
local big = { k1 = { en = "1" }, k2 = { en = "2" }, k3 = { en = "3" } }
return os.time()
`)
    const r = luaRecords(readFileSync(p, 'utf8'))
    ok('L2 选到 big（3 键）', r.stats.records === 3, `records=${r.stats.records}`)
    ok('L2 note 同时给出其它候选与指定方法', /small\(2\)/.test(String(r.stats.note)) && /table=/.test(String(r.stats.note)), String(r.stats.note).slice(0, 90))
}

console.log('== L3 table= 显式指定 ==')
{
    const text = `
local a = { k1 = { en = "1" }, k2 = { en = "2" } }
local b = { k1 = { en = "1" }, k2 = { en = "2" }, k3 = { en = "3" } }
return os.time()
`
    const ra = luaRecords(text, { table: 'a' })
    ok('L3 table=a ⇒ 读到 a（2 条）', ra.stats.records === 2, `records=${ra.stats.records}`)
    ok('L3 note 写明是按 table= 读的', /按 table="a" 读取/.test(String(ra.stats.note)), String(ra.stats.note).slice(0, 60))
    const err = throws(() => luaRecords(text, { table: 'nope' }))
    ok('L3 table= 指向不存在的表 ⇒ 报错并列出候选', err !== null && /big|b\(3/.test(err), String(err).slice(0, 92))
}

console.log('== L4 读不出表 ⇒ 必须报错（不许静默降级）==')
{
    const err = throws(() => luaRecords('local x = 1\nprint("hi")\nreturn x'))
    ok('L4 无字面量表 ⇒ 抛错', err !== null, String(err).slice(0, 70))
    ok('L4 错误里说清原因与出路', /没有可读的字面量表/.test(String(err)) && /format=/.test(String(err)), String(err).slice(0, 120))
}

console.log('== L5 顶层字面量表：行为不变 ==')
{
    const r = luaRecords('return { ["k1"] = { en = "x", ["zh-cn"] = "y" } }')
    ok('L5 records 正确且没有 fallback note', r.stats.records === 1 && r.stats.note === null, `records=${r.stats.records} note=${String(r.stats.note)}`)
    const empty = luaRecords('local data = { k1 = { en = "1" } }\nreturn {}')
    ok('L5 顶层是空表 ⇒ 回退到 data 并说明', empty.stats.records === 1 && /data/.test(String(empty.stats.note)), String(empty.stats.note).slice(0, 70))
}

console.log('== L6 单行内联 return {…} 也要嗅探成 lua ==')
{
    const r = await peek.execute({ source: 'text:return { ["k"] = { en = "x" } }' }, exec)
    ok('L6 format=lua（以前会被判成 properties）', /format=lua/.test(String(r)), String(r).split('\n')[1]?.slice(0, 70) ?? '')
}

console.log('== L7 函数调用的字面实参必须算进文本（Darktide 复测 #2）==')
{
 // 调用实参以前被整段丢掉 ⇒ `CNumb("0","n_0_rgb")` 变空 ⇒ normalize=numbers 系统性漏报
    const text = `
local t = {
  ["k1"] = { en = "b " .. CNumb("0","n_0_rgb") .. "|" .. CNumb("20","n_20_rgb"), ["zh-cn"] = "前 " .. CNumb("0","n_0_rgb") },
  ["k2"] = { en = CKWord("Bleed","bleed_key"), ["zh-cn"] = "流血" },
  ["k3"] = { en = loc_text("hello") .. " world", ["zh-cn"] = "世界" },
}
return t
`
    const byKey = Object.fromEntries(luaRecords(text).records.map((r) => [r.__luaKey, r]))
    ok('L7 纯数字实参被取到（0|20）', byKey.k1.en.includes('0|20'), JSON.stringify(byKey.k1.en))
    ok('L7 "键样子"的实参被丢掉（n_0_rgb 不出现）', !byKey.k1.en.includes('n_0_rgb'))
    ok('L7 首实参是单词也保留（Bleed）', byKey.k2.en === 'Bleed', JSON.stringify(byKey.k2.en))
    ok('L7 单实参调用取到内容（hello world）', byKey.k3.en === 'hello world', JSON.stringify(byKey.k3.en))
    ok('L7 归一化 numbers 里真的出现数字', normalizeText(byKey.k1.en, 'numbers') === '0,20', normalizeText(byKey.k1.en, 'numbers'))
}

console.log('== L8 选中"非数据表"要报错，不许静默 1 条 ==')
{
    // (a) 复刻 TALENTS_Modular.lua：只有表达式赋值 + 空表 ⇒ 要么报错，要么 0 条；**绝不能**给 1 条哨兵记录
    const modLike = `
local Utils = mod.get_utils()
local Dot_green = Utils.Dot_green
local CNote = Utils.CNote
local out = {}
for k, v in pairs(Utils.tables) do table.insert(out, v) end
return out
`
    let recs = null
    let err = null
    try { recs = luaRecords(modLike).stats.records } catch (e) { err = String(e.message) }
    ok('L8a 无数据表的模块 ⇒ 报错或 0 条（不得 1 条哨兵）', err !== null || recs === 0, err !== null ? `报错 ✓` : `records=${recs}`)

    // (b) 字面量表但值全是运行时表达式（哨兵）⇒ 必须报错（这是"看起来有数据"的坑）
    const sentinelOnly = `
local t = { a = Utils.alpha, b = Utils.beta }
return t
`
    const err2 = throws(() => luaRecords(sentinelOnly))
    ok('L8b 表里全是运行时表达式 ⇒ 报错（不返回 __expr 记录）', err2 !== null && /不是数据表|字面量表/.test(err2), String(err2).slice(0, 100))
}

console.log('== L9 glob：`**/` 必须匹配 0 层 ==')
{
    const dir = join(sandbox, 'globcase')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'top.lua'), 'return { ["a"] = { en = "1" } }')
    writeFileSync(join(dir, 'sub', 'deep.lua'), 'return { ["b"] = { en = "2" } }')
    // ⚠️ glob 是 table_diff 的能力（table_peek 按设计只吃单个来源）
    const glob = join(dir, '**', '*.lua')
    const out = String(await diff.execute({ a: glob, b: glob, keyField: '__luaKey', limit: 3 }, exec))
    ok('L9 `dir/**/*.lua` 同时吃到顶层与子目录（合并 2 个文件）', /合并 2 个文件/.test(out), out.split('\n').find((l) => /合并|只匹配/.test(l))?.slice(0, 90) ?? '(无 note)')
    const single = String(await diff.execute({ a: join(dir, 'sub', '*.lua'), b: join(dir, 'sub', '*.lua'), keyField: '__luaKey', limit: 2 }, exec))
    ok('L9 glob 只匹配到 1 个文件时会提示写窄了', /只匹配到 1 个文件/.test(single), single.split('\n').find((l) => /只匹配/.test(l))?.slice(0, 80) ?? '(无提示)')
}

console.log('== L10 glob 里读不出的文件：跳过 + 点名（单个文件则硬失败）==')
{
    const dir = join(sandbox, 'skipcase')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ok.lua'), 'return { ["a"] = { en = "1" }, ["b"] = { en = "2" } }')
    writeFileSync(join(dir, 'bad.lua'), 'local x = 1\nreturn x')   // 读不出（会抛错）
    const out = String(await diff.execute({ a: join(dir, '*.lua'), b: join(dir, '*.lua'), keyField: '__luaKey', limit: 2 }, exec))
    ok('L10 glob 里坏文件被跳过（比对仍完成）', /mode=values|mode=records/.test(out), out.split('\n').find((l) => /mode=/.test(l))?.slice(0, 60) ?? '')
    ok('L10 跳过必须**点名**（不许静默）', /跳过了 1 个读不出的文件/.test(out) && /bad\.lua/.test(out), out.split('\n').find((l) => /跳过/.test(l))?.slice(0, 90) ?? '(无提示)')
    const single = await rejects(() => diff.execute({ a: join(dir, 'bad.lua'), b: join(dir, 'bad.lua') }, exec))
    ok('L10 单个显式文件读不出 ⇒ 仍然硬失败', single !== null && /读不出/.test(single), String(single).slice(0, 80))
}

console.log('== L11 数据表前面的 helper 函数不得让整张表读不到（Darktide 第三轮）==')
{
 // `local function …` 曾让扫描走进函数体、被体内的 `return {}` 打断 ⇒ 函数之后的数据表全丢。
    // 这是"先写几个 helper 再写数据表"的常见形状，四个变体都必须能读到 2 条。
    const variants = {
        '平凡函数': 'local function load(x)\n\treturn x\nend',
        'if 里 return {}': 'local function load(x)\n\tif not x then\n\t\treturn {}\n\tend\n\treturn x\nend',
        'pcall 嵌套函数': 'local function load(x)\n\tlocal ok, r = pcall(function() return x end)\n\tif ok and r then return r end\n\treturn {}\nend',
        'for 循环 + do': 'local function load(t)\n\tfor k, v in pairs(t) do\n\t\tif v == nil then return {} end\n\tend\n\treturn t\nend',
    }
    for (const [name, fn] of Object.entries(variants)) {
        const text = `${fn}\n\nlocal data = {\n\t["k1"] = { en = "one", ru = "odin" },\n\t["k2"] = { en = "two", ru = "dva" },\n}\n\nreturn data\n`
        let recs = -1
        let err = null
        try { recs = luaRecords(text).stats.records } catch (e) { err = String(e.message) }
        ok(`L11 helper（${name}）之后的数据表仍能读到 2 条`, recs === 2, err !== null ? `报错: ${err.slice(0, 60)}` : `records=${recs}`)
    }
    // 函数之后的数据表也要能用 table= 显式指定
    const withTable = 'local function f() return {} end\nlocal data = { ["a"] = { en = "1" } }\nreturn f()\n'
    const r = luaRecords(withTable, { table: 'data' })
    ok('L11 `table=` 也能命中函数之后的数据表', r.stats.records === 1, `records=${r.stats.records}`)
}

console.log('== N1 归一化基础 ==')
{
    const t = 'Deal {dmg} damage for 5s at 50%  {#color(255, 35, 5)}red{#reset()}'
    ok('N1 numbers 只留数值且忽略标记里的数字', normalizeText(t, 'numbers') === '5,50%', normalizeText(t, 'numbers'))
    ok('N1 placeholders 只留占位符名', normalizeText(t, 'placeholders') === 'dmg', normalizeText(t, 'placeholders'))
    ok('N1 skeleton 形如 ph[…] num[…] seg=/bullet=', /^ph\[dmg\] num\[5,50%\] seg=1 bullet=0$/.test(normalizeText(t, 'skeleton')), normalizeText(t, 'skeleton'))
    ok('N1 tokens 生效（小写去重排序）', normalizeText('Deal deal DAMAGE', 'tokens') === 'damage|deal', normalizeText('Deal deal DAMAGE', 'tokens'))
    ok('N1 raw 就是原文（默认，向后兼容）', normalizeText(t, 'raw') === t && normalizeText(t) === t)
    ok('N1 非法模式报错', throws(() => normalizeText(t, 'nope')) !== null, NORMALIZE_MODES.join('/'))
}

console.log('== N2 语序无关；缺占位符/缺数值仍是差异 ==')
{
    const en = 'Deal {dmg} damage for 5s'
    const zhOrder = '持续 5 秒造成 {dmg} 伤害'          // 纯语序不同
    const zhMissing = '造成伤害'                        // 少了 {dmg} 与 5
    ok('N2 纯语序 ⇒ skeleton 相同（不再算 changed）', normalizeText(en, 'skeleton') === normalizeText(zhOrder, 'skeleton'), normalizeText(zhOrder, 'skeleton'))
    ok('N2 少占位符 ⇒ skeleton 不同', normalizeText(en, 'skeleton') !== normalizeText(zhMissing, 'skeleton'))
    ok('N2 少一行数值 ⇒ numbers 不同（保留重复项）', normalizeText('1 2 3', 'numbers') !== normalizeText('1 3', 'numbers'))
}

console.log('== N3 ordered=true 才位置敏感 ==')
{
    ok('N3 集合语义下 a,b 与 b,a 相同', normalizeText('{a} {b}', 'placeholders') === normalizeText('{b} {a}', 'placeholders'))
    ok('N3 ordered 下两者不同', normalizeText('{a} {b}', 'placeholders', { ordered: true }) !== normalizeText('{b} {a}', 'placeholders', { ordered: true }))
}

console.log('== D1 工具层端到端：同文件按列比 + 骨架让 changed 降下来 ==')
{
    const p = write('glossary.lua', MODULE_LUA.replace('local localization_templates = {}', 'local localization_templates = {}'))
    const raw = String(await diff.execute({ a: p, b: p, keyField: '__luaKey', valueFieldA: 'en', valueFieldB: 'zh-cn', limit: 9 }, exec))
    const skel = String(await diff.execute({ a: p, b: p, keyField: '__luaKey', valueFieldA: 'en', valueFieldB: 'zh-cn', normalize: 'skeleton', limit: 9 }, exec))
    const rawChanged = Number(/changed=(\d+)/.exec(raw)?.[1] ?? -1)
    const skelChanged = Number(/changed=(\d+)/.exec(skel)?.[1] ?? -1)
    ok('D1 原文对比：两条都算 changed', rawChanged === 2, `raw changed=${rawChanged}`)
    ok('D1 骨架对比：纯语序那条不再算 changed', skelChanged === 1, `skeleton changed=${skelChanged}`)
    ok('D1 报告里回显 normalize 模式（不许让人以为比的是原文）', /已按 normalize=skeleton 归一化后比较/.test(skel), skel.split('\n').find((l) => /normalize=/.test(l))?.slice(0, 80) ?? '(未回显)')
}

console.log('== D2 多列一次比 ==')
{
    const p = write('cols.lua', MODULE_LUA)
    const out = String(await diff.execute({ a: p, b: p, keyField: '__luaKey', valueFields: ['en:zh-cn', 'en:zh-tw'], limit: 3 }, exec))
    ok('D2 两组结果分段输出', /### 1\/2  en → zh-cn/.test(out) && /### 2\/2  en → zh-tw/.test(out), out.split('\n')[0]?.slice(0, 50) ?? '')
    const q = String(await diff.execute({ a: p, b: p, keyField: '__luaKey', valueFields: 'en:zh-cn,en:zh-tw', limit: 3 }, exec))
    ok('D2 也接受逗号分隔字符串', /### 2\/2/.test(q))
    const conflict = await rejects(() => diff.execute({ a: p, b: p, valueField: 'en', valueFields: ['en:zh-cn'] }, exec))
    ok('D2 与 valueField 同给 ⇒ 报错', conflict !== null && /不能同时给/.test(conflict), String(conflict).slice(0, 70))
}

console.log('== D3 table_peek 预览归一化与选表 ==')
{
    const p = write('peek.lua', MODULE_LUA)
    const out = String(await peek.execute({ source: p, valueField: 'en', normalize: 'skeleton', limit: 2 }, exec))
    ok('D3 头部回显 normalize=skeleton', /normalize: skeleton/.test(out), out.split('\n').slice(0, 5).join(' | ').slice(0, 100))
    ok('D3 note 说明选表来源', /curios_localizations/.test(out), out.split('\n').find((l) => /note:/.test(l))?.slice(0, 80) ?? '(无 note)')
    const perr = await rejects(() => peek.execute({ source: p, table: 'nope' }, exec))
    ok('D3 table= 不存在时 peek 也报错', perr !== null && /没有这张字面量表/.test(String(perr)), String(perr).slice(0, 80))
}

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(failures === 0 ? `\nALL PASS (${passed})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

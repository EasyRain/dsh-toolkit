// tablediff-fuzz-selftest.mjs —— table_diff / table_peek 的**性质化 fuzz + 恶意语料**（第 19 份自测）
//
// 姿势：不断言"某输入产生某输出"（那是例子驱动），而是断言**性质**：
//   P1 **变异必被发现**：B = A 的一处已知改动（改值/加键/删键/重命名）⇒ 必须报出那处，**绝不能**说 "no differences"；
//   P2 **没变不得误报**：A 与 A 自己比 ⇒ 必须恰好 "no differences"；
//   H1 **畸形输入不得抛代码级缺陷**（TypeError/Cannot read property/is not a function）—— 要报错也得是人话；
//   H2 **畸形输入不得卡死**（每个用例限时 15 s）。
// 语料含：截断的 JSON/Lua/TOML、重复键、NUL 字节、UTF-16 带 BOM、1 MB 单行、200 层嵌套、Lua 循环引用、
// 非 UTF-8 字节、CRLF、PO 转义；边界含：文件不存在、把目录当输入。
// 加深：`TD_FUZZ_SEEDS=20 node test/tablediff-fuzz-selftest.mjs`；源码树没装 `yaml` 时自动 SKIP 该格式。
//
// 与已有 tablediff 自测（例子驱动）不同，这里断言两条**性质**：
//   P1 **变异必被发现**：把 B 造造成 A 的一处已知改动 ⇒ 必须报出那处，且**绝不能**说 "no differences"
//   P2 **没变不得误报**：A 与 A 自己比 ⇒ 必须恰好 "no differences"
// 外加畸形语料（截断/编码错乱/NUL/深嵌套/重复键/循环引用/超长行…）：
//   H1 不得抛"代码级缺陷"（TypeError/Cannot read property/is not a function）—— 要报错也得是人话
//   H2 不得卡死（每个用例限时）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../lib/tablediff/index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'td-fuzz-'))
const exec = { agent: { session: { header: { cwd: sandbox } } } }
let passed = 0
let failures = 0
const ok = (name, cond, detail = '') => {
    if (cond) { passed += 1; process.stdout.write(`  PASS  ${name}${detail ? `  ${detail}` : ''}\n`) }
    else { failures += 1; process.stdout.write(`  FAIL  ${name}${detail ? `  ${detail}` : ''}\n`) }
}
const by = (name) => tools((t) => t, {}).find((t) => t.name === name)
const diffTool = by('table_diff')
const peekTool = by('table_peek')

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length]

// ---- 生成/序列化（覆盖多种格式；yaml/sqlite 缺依赖时自动跳过）----
const nasties = ['', ' ', 'a"b', "a'b", 'a\\b', 'a\nb', 'a,b', 'a\tb', '中文', '😀', '#hash', '=eq', 'true', 'null', '123', '-1', 'k=v', 'a;b', '[x]', '{{y}}']
function genTable(rnd, n) {
    const t = {}
    for (let i = 0; i < n; i += 1) {
        const key = `k${i}${rnd() < 0.2 ? '_中' : ''}`
        t[key] = pick(rnd, nasties) + (rnd() < 0.5 ? String(Math.floor(rnd() * 1000)) : '')
    }
    return t
}
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
const serializers = {
    json: (t) => JSON.stringify(t, null, 2),
    jsonl: (t) => Object.entries(t).map(([k, v]) => JSON.stringify({ key: k, value: v })).join('\n'),
    csv: (t) => `key,value\n${Object.entries(t).map(([k, v]) => `"${k.replace(/"/g, '""')}","${v.replace(/"/g, '""')}"`).join('\n')}\n`,
    tsv: (t) => `key\tvalue\n${Object.entries(t).map(([k, v]) => `${k}\t${v}`).join('\n')}\n`,
    toml: (t) => Object.entries(t).map(([k, v]) => `${k} = "${esc(v)}"`).join('\n') + '\n',
    lua: (t) => `return {\n${Object.entries(t).map(([k, v]) => `  ["${k}"] = "${esc(v)}",`).join('\n')}\n}\n`,
    properties: (t) => Object.entries(t).map(([k, v]) => `${k}=${v.replace(/\n/g, '\\n')}`).join('\n') + '\n',
    po: (t) => Object.entries(t).map(([k, v]) => `msgid "${esc(k)}"\nmsgstr "${esc(v)}"\n`).join('\n'),
    yaml: (t) => Object.entries(t).map(([k, v]) => `${k}: "${esc(v)}"`).join('\n') + '\n',
}

/** 造一处已知改动；返回 {table, kind, key} */
function mutate(rnd, t) {
    const keys = Object.keys(t)
    const kind = pick(rnd, ['change', 'add', 'remove', 'rename'])
    const out = { ...t }
    if (kind === 'add') { const k = `new${Math.floor(rnd() * 9999)}`; out[k] = 'added-value'; return { table: out, kind, key: k } }
    const key = pick(rnd, keys)
    if (kind === 'remove') { delete out[key]; return { table: out, kind, key } }
    if (kind === 'rename') { const nk = `${key}_r${Math.floor(rnd() * 99)}`; out[nk] = out[key]; delete out[key]; return { table: out, kind, key: nk, oldKey: key } }
    out[key] = `${out[key]}-CHANGED`
    return { table: out, kind, key }
}

const hasCodeDefect = (msg) => /TypeError|ReferenceError|is not a function|Cannot read propert|undefined is not|Unexpected token 'u'|not iterable/.test(msg)

async function withTimeout(promise, ms) {
    let timer = null
    try {
        return await Promise.race([
            promise,
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`__TIMEOUT__${ms}`)), ms) }),
        ])
    }
    finally { if (timer !== null) clearTimeout(timer) }
}

// ---- 阶段 1：性质 P1/P2（多格式 × 多种子）----
const SEEDS = Number(process.env.TD_FUZZ_SEEDS ?? 6)
const formats = Object.keys(serializers)
const skippedFormats = []
for (const fmt of formats) {
    if (fmt === 'yaml') {
        try { await import('yaml') }
        catch { skippedFormats.push('yaml（源码树没装 yaml，安装副本里会跑到）'); continue }
    }
    const rnd = mulberry32(fmt.length * 7919)
    let p1 = 0
    let p2 = 0
    let problems = []
    for (let s = 0; s < SEEDS; s += 1) {
        const n = 3 + Math.floor(rnd() * 12)
        const a = genTable(rnd, n)
        const { table: b, kind, key, oldKey } = mutate(rnd, a)
        const pa = join(sandbox, `a-${fmt}-${s}.${fmt}`)
        const pb = join(sandbox, `b-${fmt}-${s}.${fmt}`)
        writeFileSync(pa, serializers[fmt](a))
        writeFileSync(pb, serializers[fmt](b))
        // P2：自己跟自己比 ⇒ 必须"无差异"（防误报）
        const sameOut = await withTimeout(diffTool.execute({ a: pa, b: pa }, exec), 15000)
        if (!/no differences/.test(sameOut)) problems.push(`${fmt}#${s} 自身比较却报差异`)
        else p2 += 1
        // P1：B 是 A 的一处已知改动 ⇒ 必须报出那一刻，且绝不能"无差异"
        const out = await withTimeout(diffTool.execute({ a: pa, b: pb }, exec), 15000)
        // rename 在 diff 里必然体现为"旧键消失 + 新键出现"（工具没有身份信息，这是**正确**表现）；
        // 其他 kind 用各自标记。
        const okReported = kind === 'add' ? out.includes(`+ ${key}`)
            : kind === 'remove' ? out.includes(`- ${key}`)
                : kind === 'rename' ? (out.includes(`- ${oldKey}`) && (out.includes(`+ ${key}`) || out.includes(`~ ${key}`)))
                    : (out.includes(`~ ${key}`) || out.includes(`~ "${key}"`))
        if (/no differences/.test(out)) problems.push(`${fmt}#${s} 改了 ${kind} ${key} 却报 no differences`)
        else if (!okReported) problems.push(`${fmt}#${s} 改了 ${kind} ${key}${oldKey ? `（旧键 ${oldKey}）` : ''}，输出里没体现出这处改动`)
        else p1 += 1
        // 确定性：同一输入两次输出一致
        const out2 = await withTimeout(diffTool.execute({ a: pa, b: pb }, exec), 15000)
        if (out2 !== out) problems.push(`${fmt}#${s} 两次输出不一致（不确定性）`)
    }
    ok(`P1 变异必被发现 [${fmt}]`, p1 === SEEDS, problems.slice(0, 2).join('；'))
    ok(`P2 自身比较不得误报 [${fmt}]`, p2 === SEEDS, problems.slice(0, 2).join('；'))
    if (problems.length > 0) for (const p of problems.slice(0, 6)) process.stdout.write(`         · ${p}\n`)
}
if (skippedFormats.length > 0) process.stdout.write(`  SKIP  未覆盖格式：${skippedFormats.join('、')}\n`)

// ---- 阶段 2：畸形语料（H1 不抛代码级缺陷；H2 不卡死）----
const deep = (() => { let s = '1'; for (let i = 0; i < 200; i += 1) s = `{"a":${s}}`; return s })()
const corpus = {
    'empty.json': '',
    'space.json': '   \n\t ',
    'truncated.json': '{"a": 1, "b": ',
    'dup-keys.json': '{"k": "1", "k": "2"}',
    'bad-jsonl.jsonl': '{"key":"a","value":"1"}\n{"key":\n{"key":"c","value":"3"}\n',
    'unterminated-csv.csv': 'key,value\n"a","1\n"b","2"\n',
    'nul.json': '{"a":"1\u0000b"}',
    'utf16.toml': '\uFEFFa = "1"\n',
    'huge-number.json': '{"a": 1e400, "b": -1e400}',
    'deep.json': deep,
    'cycle.lua': 'local t = {}\nt.self = t\nreturn t\n',
    'weird.toml': 'a = "1"\na = "2"\nb = \n[[c]]\n',
    'nonutf8.csv': 'key,value\n\xff\xfe\xfd,"1"\n',
    'longline.json': `{"a":"${'x'.repeat(1024 * 1024)}"}`,
    'crlf.properties': 'a=1\r\nb=2\r\n',
    'escapes.po': 'msgid "a\\n\\"b"\nmsgstr ""\n',
}
{
    let defects = []
    let timeouts = []
    let checkable = 0
    for (const [name, text] of Object.entries(corpus)) {
        const p = join(sandbox, name)
        if (name === 'utf16.toml') writeFileSync(p, Buffer.from(text, 'utf16le'))
        else writeFileSync(p, text, 'utf8')
        for (const [label, fn] of [['peek', () => peekTool.execute({ source: p }, exec)], ['diff-self', () => diffTool.execute({ a: p, b: p }, exec)]]) {
            try {
                const out = await withTimeout(fn(), 15000)
                if (typeof out !== 'string' || out.length === 0) defects.push(`${name}/${label} 返回空`)
                else checkable += 1
            }
            catch (error) {
                const msg = String(error?.message ?? error)
                if (msg.includes('__TIMEOUT__')) { timeouts.push(`${name}/${label}`); continue }
                if (hasCodeDefect(msg)) defects.push(`${name}/${label} 代码级缺陷：${msg.slice(0, 80)}`)
                else checkable += 1      // 明确的业务错误是可接受的
            }
        }
    }
    ok('H1 畸形输入不产生代码级缺陷（TypeError/Cannot read…）', defects.length === 0, defects.slice(0, 3).join('；'))
    ok('H2 畸形输入不卡死（每个用例 <15s）', timeouts.length === 0, timeouts.slice(0, 3).join('；'))
    ok('畸形语料确实被跑到了（不是空转）', checkable >= Object.keys(corpus).length, `可判定 ${checkable} 次`)
}

// ---- 阶段 3：不存在/目录 等边界必须"报错而非乱答" ----
{
    const missing = await (async () => {
        try { return { out: await withTimeout(diffTool.execute({ a: join(sandbox, 'nope.json'), b: join(sandbox, 'nope2.json') }, exec), 15000) } }
        catch (error) { return { err: String(error?.message ?? error) } }
    })()
    ok('文件不存在 ⇒ 明确报错（不装作"无差异"）', missing.err !== undefined && !hasCodeDefect(missing.err), (missing.err ?? missing.out ?? '').slice(0, 70))
    const dirAsFile = await (async () => {
        try { return { out: await withTimeout(peekTool.execute({ source: sandbox }, exec), 15000) } }
        catch (error) { return { err: String(error?.message ?? error) } }
    })()
    ok('把目录当输入 ⇒ 明确报错（不产生代码级缺陷）', dirAsFile.err !== undefined ? !hasCodeDefect(dirAsFile.err) : typeof dirAsFile.out === 'string', (dirAsFile.err ?? '').slice(0, 70))
}

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(failures === 0 ? `\nALL PASS (${passed})\n` : `\n${failures} FAILURE(S)  (${passed} passed)\n`)
process.exit(failures === 0 ? 0 : 1)

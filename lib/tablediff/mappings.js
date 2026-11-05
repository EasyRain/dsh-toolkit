/**
 * lib/tablediff/mappings.js —— **零依赖**的混淆映射读取（新增；起因：MC 模组跟版时要看
 * "上游/官方这版把哪些符号改了名"，而映射文件是 4~10 MB 的专用文本格式，用普通文本 diff 完全没法读）。
 *
 * 支持四种真实格式（都在本机 MCMOD 的真实文件上核对过结构）：
 *  1. **Mojang / ProGuard**（`client-<ver>-mappings.txt`）：
 *         com.mojang.blaze3d.Blaze3D -> eza:
 *             12:13:void process(java.lang.String,float) -> a
 *             21:22:double getTime() -> b
 *     左 = **可读名**，右 = 混淆名（方法名可能重复，所以键里带签名）。
 *  2. **TSRG2**（NeoForm `joined.tsrg` / MCP `mcp_config-*-mappings.txt`）：
 *         tsrg2 obf srg id
 *         a net/minecraft/src/C_252363_ 252363
 *         	a f_252495_ 252495
 *         	<clinit> ()V <clinit> 253140
 *         		static              ← 访问修饰行，跳过
 *     左 = 混淆名，右 = 可读名。
 *  3. **经典 SRG**：`CL:` / `FD:` / `MD:` / `PK:` 行。
 *  4. **Tiny（Yarn/Fabric）**：v1（`CLASS`/`FIELD`/`METHOD` 制表分隔）与 v2（`tiny\t2\t0\t…` 头）。
 *
 * 输出记录：`{ key, value, kind, owner, desc }` ——
 *  - `key` = 文件里**第一列**（原样，便于"这版它叫什么"），
 *  - `value` = 映射后的名字，
 *  - `kind` = class / field / method（可用 `filter` 只比某一类）。
 * ⚠️ 两种方向不同（Mojang 左可读、SRG/TSRG/Tiny 左混淆），`stats.note` 会写明，避免看反。
 */

/** 去掉 ProGuard 成员行里的行号区间与访问修饰，返回 `{ type, name, args, mapped }` */
function parseProguardMember(line) {
    let s = line.trim()
    s = s.replace(/\s+#.*$/, '') // 尾随注释
    const arrow = s.lastIndexOf(' -> ')
    if (arrow < 0) return null
    const mapped = s.slice(arrow + 4).trim()
    let left = s.slice(0, arrow).trim()
    left = left.replace(/^\d+:\d+:/, '') // 12:13: 行号区间
    left = left.replace(/^(public|private|protected|static|final|abstract|synchronized|native|transient|volatile)\s+/g, '')
    const paren = left.indexOf('(')
    if (paren >= 0) {
        const close = left.indexOf(')', paren)
        const head = left.slice(0, paren)
        const args = close > paren ? left.slice(paren + 1, close) : ''
        const spacing = head.lastIndexOf(' ')
        const type = spacing < 0 ? '' : head.slice(0, spacing).trim()
        const name = (spacing < 0 ? head : head.slice(spacing + 1)).trim()
        return { kind: 'method', name, desc: `(${args})`, type, mapped }
    }
    const spacing = left.lastIndexOf(' ')
    if (spacing < 0) return null
    return { kind: 'field', name: left.slice(spacing + 1).trim(), type: left.slice(0, spacing).trim(), mapped }
}

/** TSRG2 成员：第二列以 `(` 开头 ⇒ 方法（带 JVM 描述符），否则字段 */
function parseTsrg2Member(line, pick) {
    const parts = line.replace(/\t+$/, '').split(/\s+/).filter((x) => x !== '')
    if (parts.length === 0) return null
    const first = parts[0]
    const second = parts[1]
    const isMethod = second !== undefined && second.startsWith('(')
    // ⚠️ 索引换算（实测踩过）：`pick` 是**命名空间表**里的下标，而这里的 `names` 是"名字之后的所有列"：
    // 字段行 = `<名字(obf)> <ns2> <ns3>…` ⇒ names[0] 就是命名空间 1；方法行只多一列描述符 ⇒ 同样 names[0]。
    // 所以两者都用 `pick - 1`（以前方法用 pick ⇒ 取到 `id` 列的数字，实测得到 `300` 这种没意义的值）。
    const nsIndex = Math.max(0, pick - 1)
    if (isMethod) {
        const names = parts.slice(2)
        return { kind: 'method', name: first, desc: second, mapped: names[nsIndex] ?? names[names.length - 1] ?? '' }
    }
    if (second === undefined) return { kind: 'field', name: first, desc: '', mapped: first }
    const names = parts.slice(1)
    return { kind: 'field', name: first, desc: '', mapped: names[nsIndex] ?? names[names.length - 1] }
}

/**
 * 选哪个命名空间当"可读名"。TSRG2 常见头是 `obf srg id` —— 直接取最后一列会拿到**纯数字的 id**
 * （实测 MCP/NeoForm 的真文件：取到 `252363` 这种毫无意义的值）。所以优先按名字挑，其次挑最后一个
 * 非纯数字列，最后才退回最后一列。
 */
function pickNamespace(spaces) {
    const preferred = ['named', 'mojang', 'official', 'srg', 'mcp', 'intermediary', 'yarn']
    for (const want of preferred) {
        const i = spaces.indexOf(want)
        if (i >= 0) return i
    }
    for (let i = spaces.length - 1; i >= 1; i -= 1) if (!/^\d+$/.test(spaces[i])) return i
    return Math.max(1, spaces.length - 1)
}

export function mappingsRecords(text, opts = {}) {
    const fmt = String(opts.mappingsFormat ?? 'auto').toLowerCase()
    const lines = String(text).split(/\r?\n/)
    const records = []

    // --- 判定子格式 -----------------------------------------------------------
    let sub = fmt !== 'auto' ? fmt : null
    if (sub === null) {
        for (const line of lines.slice(0, 400)) {
            const t = line.replace(/\s+$/, '')
            if (t === '' || t.startsWith('#')) continue
            if (/^tiny\t/.test(t)) { sub = 'tiny2'; break }
            if (/^v1\t/.test(t)) { sub = 'tiny1'; break }
            if (/^tsrg2\b/.test(t)) { sub = 'tsrg2'; break }
            if (/^(PK|CL|FD|MD): /.test(t)) { sub = 'srg'; break }
            if (/^\S+ -> \S+:?$/.test(t)) { sub = 'mojang'; break }
            if (/^CLASS\t/.test(t)) { sub = 'tiny1'; break }
            break // 第一行有内容但不是任何已知头 ⇒ 交给下面的兜底
        }
    }
    if (sub === null) sub = 'tsrg1'

    const note = []
    let namespaceLabel = ''
    let currentClass = ''

    if (sub === 'mojang') {
        for (const raw of lines) {
            if (raw === '' || raw.startsWith('#')) continue
            const indent = /^\s/.test(raw)
            if (!indent) {
                const m = /^(\S+)\s+->\s+(\S+):?$/.exec(raw.trim())
                if (m === null) continue
                currentClass = m[1]
                records.push({ key: m[1], value: m[2].replace(/:$/, ''), kind: 'class', owner: '', desc: '' })
                continue
            }
            if (currentClass === '') continue
            const mem = parseProguardMember(raw)
            if (mem === null) continue
            // ⚠️ 键里**必须带返回类型**（实测：Mojang 官方映射里存在参数完全相同、仅返回类型不同的
            // 方法 —— 桥接/合成方法。只带 `(args)` 会让后者覆盖前者，重复键护栏当场报了出来）。
            const sig = mem.kind === 'method' ? `${mem.desc}:${mem.type || '?'}` : ''
            const key = `${currentClass}.${mem.name}${sig}`
            records.push({ key, value: mem.mapped, kind: mem.kind, owner: currentClass, desc: mem.desc ?? '' })
        }
        note.push('Mojang/ProGuard 格式：**左=可读名，右=混淆名**（方法名可能重复，键里带参数签名）')
    }
    else if (sub === 'tsrg2' || sub === 'tsrg1') {
        const header = sub === 'tsrg2' ? lines.find((l) => /^tsrg2\b/.test(l)) : null
        const spaces = header === null ? ['obf', 'named'] : header.trim().split(/\s+/).slice(1)
        const pick = pickNamespace(spaces)
        namespaceLabel = `${spaces.join('|')}（取 ${spaces[pick] ?? '最后一列'}）`
        for (const raw of lines) {
            const line = raw.replace(/\s+$/, '')
            if (line === '' || line.startsWith('#') || /^tsrg2\b/.test(line)) continue
            const indent = /^\t/.test(line) ? (line.match(/^\t+/) ?? [''])[0].length : 0
            if (indent === 0) {
                const parts = line.split(/\s+/).filter((x) => x !== '')
                // 类行：`obf named [more]`；TSRG2 里可能是 `class obf named`（少见）
                const start = parts[0] === 'class' ? 1 : 0
                currentClass = parts[start]
                const tokens = parts.slice(start)
                records.push({ key: currentClass, value: tokens[pick] ?? tokens[tokens.length - 1], kind: 'class', owner: '', desc: '' })
                continue
            }
            if (indent >= 2) continue // 访问修饰 / start-end 行
            if (currentClass === '') continue
            const mem = parseTsrg2Member(line.trim(), pick)
            if (mem === null) continue
            const key = mem.kind === 'method' ? `${currentClass}.${mem.name}${mem.desc}` : `${currentClass}.${mem.name}`
            records.push({ key, value: mem.mapped, kind: mem.kind, owner: currentClass, desc: mem.desc ?? '' })
        }
        note.push(`TSRG${sub === 'tsrg2' ? '2' : ''} 格式：命名空间 ${namespaceLabel}；**左=第一列（通常混淆名），右=上表所选列的可读名**`)
    }
    else if (sub === 'srg') {
        for (const raw of lines) {
            const line = raw.trim()
            if (line === '' || line.startsWith('#')) continue
            const m = /^(PK|CL|FD|MD):\s+(.+)$/.exec(line)
            if (m === null) continue
            const [, tag, rest] = m
            if (tag === 'PK') continue
            if (tag === 'CL') {
                const [obf, named] = rest.split(/\s+/)
                records.push({ key: obf, value: named ?? '', kind: 'class', owner: '', desc: '' })
            }
            else if (tag === 'FD') {
                const [obf, named] = rest.split(/\s+/)
                records.push({ key: obf, value: named ?? '', kind: 'field', owner: obf.split('/').slice(0, -1).join('/'), desc: '' })
            }
            else {
                // MD: obf/name (desc)ret named/name (desc)ret
                const md = /^(\S+)\s+(\([^)]*\)\S+)\s+(\S+)\s+(\([^)]*\)\S+)$/.exec(rest)
                if (md === null) continue
                records.push({ key: `${md[1]}${md[2]}`, value: `${md[3]}${md[4]}`, kind: 'method', owner: md[1].split('/').slice(0, -1).join('/'), desc: md[2] })
            }
        }
        note.push('SRG 格式：**左=混淆名，右=可读名**（FD/MD 前缀区分字段与方法）')
    }
    else if (sub === 'tiny2' || sub === 'tiny1') {
        for (const raw of lines) {
            if (raw === '' || raw.startsWith('#')) continue
            const parts = raw.replace(/^\t+/, '').split('\t')  // 行首制表（Tiny 的成员行都是缩进的）
            if (sub === 'tiny2') {
                if (/^tiny\t/.test(raw)) { namespaceLabel = parts.slice(3).join('|'); continue }
                const tag = parts[0]
                if (tag === 'c') {
                    currentClass = parts[1]
                    records.push({ key: parts[1], value: parts[parts.length - 1], kind: 'class', owner: '', desc: '' })
                }
                else if (tag === 'f' || tag === 'm') {
                    // Tiny v2：`f <desc> <names…>` / `m <desc> <names…>`。
                    // ⚠️ 上一步已剥掉行首制表 ⇒ `parts[0]=tag`、`parts[1]=desc`、名字从 `parts[2]` 起。
                    const desc = parts[1] ?? ''
                    const name = parts[2] ?? ''
                    const key = currentClass === '' ? name : `${currentClass}.${name}${tag === 'm' ? desc : ''}`
                    records.push({ key, value: parts[parts.length - 1], kind: tag === 'm' ? 'method' : 'field', owner: currentClass, desc })
                }
                continue
            }
            const tag = parts[0]
            if (tag === 'v1') { namespaceLabel = parts.slice(1).join('|'); continue }
            if (tag === 'CLASS') {
                currentClass = parts[1]
                records.push({ key: parts[1], value: parts[parts.length - 1], kind: 'class', owner: '', desc: '' })
            }
            else if (tag === 'FIELD' || tag === 'METHOD') {
                const desc = tag === 'METHOD' ? (parts[2] ?? '') : ''
                const name = tag === 'METHOD' ? (parts[3] ?? '') : (parts[2] ?? '')
                const key = `${parts[1]}.${name}${desc}`
                records.push({ key, value: parts[parts.length - 1], kind: tag === 'METHOD' ? 'method' : 'field', owner: parts[1], desc })
            }
        }
        note.push(`Tiny（Yarn）v${sub === 'tiny2' ? 2 : 1} 格式：命名空间 ${namespaceLabel || '(未声明)'}；**左=混淆名，右=可读名**`)
    }

    const counts = { class: 0, field: 0, method: 0 }
    for (const r of records) counts[r.kind] += 1
    return {
        records,
        stats: {
            format: `mappings:${sub}`,
            records: records.length,
            skipped: 0,
            note: `${note.join('；')}（class ${counts.class} / field ${counts.field} / method ${counts.method}；用 filter 可只比某一类）`,
            source: null,
            keyFields: ['key'],
            valueField: 'value',
            mappingsKind: sub,
        },
    }
}

/** 内容嗅探：这个文本像不像映射文件（供 `.txt` 之类的未知扩展名自动识别） */
export function looksLikeMappings(headText) {
    const head = String(headText).slice(0, 4096)
    if (/^tiny\t/m.test(head)) return true
    if (/^v1\t/m.test(head)) return true
    if (/^tsrg2\b/m.test(head)) return true
    if (/^(PK|CL|FD|MD): /m.test(head)) return true
    if (/^\S+ -> \S+:?$/m.test(head)) return true
    return false
}

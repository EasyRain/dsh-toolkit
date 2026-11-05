/**
 * 行级 diff —— **本工作区自研**（零依赖，纯函数）。
 *
 * 由来：之前这里用的是 vendor 自上游的 `vendor/diff.mjs`（Apache-2.0）。为了让插件
 * 全部是自有代码（便于开源发布与长期维护），按**既有调用契约**重写，并修掉原实现的一个弱点：
 * 它按"配置快照只有几十行"设计，用满 O(n·m) 的 DP 表；而 `checkpoint_diff` 对大源码文件也会走
 * 这里，几千行的文件会吃掉上百 MB 内存。新实现先掐掉公共前后缀，再对剩余窗口做**有界** DP，
 * 窗口过大时退化为"整段替换"（对完全不同的文件这本身就是正确输出）。
 *
 * 契约（`lib/checkpoint/index.js` 依赖，勿轻改）：
 *  - `diffLines(a, b)` → `Array<{op:'keep'|'del'|'add', line:string, a?:number, b?:number}>`
 *    （a/b 为 0-based 行号；keep 两侧都有）
 *  - `unifiedDiffLines(a, b, {fromLabel,toLabel,maxLines})` → unified diff 文本，无差异返回 `''`
 *    · 头：`--- <from>` / `+++ <to>`（标签为空串时写 `/dev/null`）
 *    · 块头：`@@ -<oldStart> +<newStart> @@`（两侧各自**第一条变更行**的 1-based 行号，不带行数）
 *    · 上下文：变更行前后各 3 行；相邻块（间隔 ≤1）合并
 *    · `maxLines`：超出时截断并在末尾追加一行说明（默认不截断）
 *  - `stableStringify` / `configLinesOf` / `configDiff`：配置快照对比（键顺序无关）
 */

/** 递归按键排序的稳定 JSON 序列化（配置对比基线：与键插入顺序无关）。 */
export function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 配置快照 → 可 diff 的行（非对象视为空对象）。 */
export function configLinesOf(config) {
    if (config === null || typeof config !== 'object') return ['{}']
    return stableStringify(config).split('\n')
}

const asLines = (x) => (Array.isArray(x) ? x.map(String) : String(x ?? '').split('\n'))

/** 有界 DP 的窗口上限（cells）：超过就整段替换，避免大文件爆内存。 */
const MAX_DP_CELLS = 4_000_000

/**
 * 行序列 → 编辑脚本（默认参数与调用方契约一致）。
 * 先掐公共前后缀，再对齐中间窗口；DP 的取舍规则固定（删除优先），保证输出稳定可复现。
 */
export function diffLines(aInput, bInput) {
    const a = asLines(aInput)
    const b = asLines(bInput)
    const n = a.length
    const m = b.length

    // 1) 公共前后缀（文件 diff 的绝大多数场景在这里就结束了）
    let pre = 0
    while (pre < n && pre < m && a[pre] === b[pre]) pre += 1
    let suf = 0
    while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf += 1

    const ops = []
    for (let i = 0; i < pre; i += 1) ops.push({ op: 'keep', line: a[i], a: i, b: i })

    const midN = n - pre - suf
    const midM = m - pre - suf
    if (midN > 0 || midM > 0) {
        if (midN * midM > MAX_DP_CELLS) {
            // 中间窗口过大：整段替换（诚实且内存安全）。
            // ⚠️ **必须让"这是近似结果"可被发现**（审计 E-M4）：实测 3000 行文件只在头尾各改 1000 行、
            // 中间 1000 行完全相同，也会因为 midN·midM = 1000×1000 … 被整段当"全删全加"，
            // 而输出看起来像一次干净 diff ⇒ 用户会以为中间那一千行真的被改过。
            ops.approximate = { reason: 'dp-limit', midN, midM, cells: midN * midM, limit: MAX_DP_CELLS }
            for (let i = 0; i < midN; i += 1) ops.push({ op: 'del', line: a[pre + i], a: pre + i })
            for (let j = 0; j < midM; j += 1) ops.push({ op: 'add', line: b[pre + j], b: pre + j })
        }
        else {
            // 2) 中间窗口的 LCS DP（表格沿行回放生成脚本，内存 O(midN·midM)）
            const table = Array.from({ length: midN + 1 }, () => new Uint32Array(midM + 1))
            for (let i = midN - 1; i >= 0; i -= 1) {
                for (let j = midM - 1; j >= 0; j -= 1) {
                    table[i][j] = a[pre + i] === b[pre + j]
                        ? table[i + 1][j + 1] + 1
                        : Math.max(table[i + 1][j], table[i][j + 1])
                }
            }
            let i = 0
            let j = 0
            while (i < midN && j < midM) {
                if (a[pre + i] === b[pre + j]) {
                    ops.push({ op: 'keep', line: a[pre + i], a: pre + i, b: pre + j })
                    i += 1
                    j += 1
                }
                else if (table[i + 1][j] >= table[i][j + 1]) {
                    ops.push({ op: 'del', line: a[pre + i], a: pre + i })
                    i += 1
                }
                else {
                    ops.push({ op: 'add', line: b[pre + j], b: pre + j })
                    j += 1
                }
            }
            while (i < midN) ops.push({ op: 'del', line: a[pre + i], a: pre + i++ })
            while (j < midM) ops.push({ op: 'add', line: b[pre + j], b: pre + j++ })
        }
    }

    for (let k = 0; k < suf; k += 1) {
        const i = n - suf + k
        ops.push({ op: 'keep', line: a[i], a: i, b: m - suf + k })
    }
    return ops
}

/**
 * 行级 unified diff。无差异返回空串；`maxLines` 超限时截断并附一行说明。
 */
export function unifiedDiffLines(aInput, bInput, opts = {}) {
    const a = asLines(aInput)
    const b = asLines(bInput)
    const ops = diffLines(a, b)
    if (!ops.some((op) => op.op !== 'keep')) return ''

    const fromLabel = opts.fromLabel ?? 'a'
    const toLabel = opts.toLabel ?? 'b'
    const out = []
    out.push(`--- ${fromLabel === '' ? '/dev/null' : fromLabel}`)
    out.push(`+++ ${toLabel === '' ? '/dev/null' : toLabel}`)

    // 连续变更行 ± 前后各 3 行上下文；相邻区块（间隔 ≤1）合并成同一块
    const near = (index) => {
        const from = Math.max(0, index - 3)
        const to = Math.min(ops.length, index + 4)
        for (let k = from; k < to; k += 1) if (ops[k].op !== 'keep') return true
        return false
    }
    const hunks = []
    let current = null
    for (let index = 0; index < ops.length; index += 1) {
        if (!near(index)) continue
        if (current === null || index > current.end + 1) {
            current = { start: index, end: index, lines: [] }
            hunks.push(current)
        }
        else current.end = index
        const op = ops[index]
        current.lines.push({ text: `${op.op === 'keep' ? ' ' : op.op === 'del' ? '-' : '+'}${op.line}`, op })
    }

    const maxLines = Number.isFinite(opts.maxLines) ? Number(opts.maxLines) : Infinity
    // 预算**包含** `---`/`+++` 两行表头：这样"最多 maxLines 行 + 一行提示"是字面成立的
    let emitted = out.length
    let truncated = 0
    for (const hunk of hunks) {
        const first = hunk.lines.find((entry) => entry.op.op !== 'keep')
        if (first === undefined) continue
        const oldStart = (first.op.a ?? first.op.b ?? 0) + 1
        const newStart = (first.op.b ?? first.op.a ?? 0) + 1
        const header = `@@ -${oldStart} +${newStart} @@`
        if (emitted >= maxLines) { truncated += 1 + hunk.lines.length; continue }
        out.push(header)
        emitted += 1
        for (const entry of hunk.lines) {
            if (emitted >= maxLines) { truncated += 1; continue }
            out.push(entry.text)
            emitted += 1
        }
    }
    if (truncated > 0) out.push(`… 另有 ${truncated} 行未展示（用 maxDiffs/files 收窄范围，或直接看文件）`)
    // **近似结果必须外显**（审计 E-M4）：中间窗口超限时是"整段删+整段加"，并没有真正做行对齐
    if (ops.approximate) {
        out.push(`⚠ 近似 diff：中间窗口 ${ops.approximate.midN}×${ops.approximate.midM} = ${ops.approximate.cells} 超过 DP 上限 ${ops.approximate.limit} ⇒ 这一段按"整段删 + 整段加"输出（其中**未改动**的行也会显示成 -/+；要看真实逐行差异请对该文件单独 diff，或缩小快照范围）`)
    }
    return out.join('\n')
}

/** 两段配置快照的 diff 摘要。 */
export function configDiff(from, to) {
    const a = configLinesOf(from)
    const b = configLinesOf(to)
    const text = unifiedDiffLines(a, b)
    if (text === '') return { changed: false, lines: 0, text: '' }
    const lines = diffLines(a, b).filter((op) => op.op !== 'keep').length
    return { changed: true, lines, text }
}

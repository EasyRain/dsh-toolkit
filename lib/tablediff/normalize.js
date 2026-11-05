/**
 * 值归一化投影 —— 让"两份文本是否结构一致"可比较（Darktide 工作区提案 P2）。
 *
 * 为什么需要：翻译/配置场景里两侧文本**本来就该不同**（中英语序天然不同），直接比原文得到的
 * `changed=97/97` 没有任何信息量。归一化把文本压成"骨架"再比：占位符、数值、分段与项目符号。
 *
 * 设计成**通用能力**（不绑任何游戏/项目）：
 *   - 任何"带占位符与数值的文本"都适用（本地化、配置模板、通知文案…）；
 *   - **标记 vs 占位符** 的判别规则统一为一条：`{#...}` 是**富文本标记**（整段忽略），
 *     其余 `{name}` / `{name:...}` 是**占位符**（只取 name）。Darktide 的 `{#color(255, 35, 5)}` /
 *     `{#reset()}` 因此不会污染数值提取，而 `{ammo}` / `{time}` 仍能被看见。
 *
 * 语义要点（与提案一致）：
 *   - `numbers` / `placeholders` / `tokens` 默认**按集合比**（语序是噪声）—— 但**保留重复项**并排序，
 *     因为"英文表少了一行数值"这类真信号正是靠重复项体现的；
 *   - `ordered: true` 才做**位置敏感**比较；
 *   - `raw` 是默认值，行为与以前完全一致（向后兼容）。
 */

export const NORMALIZE_MODES = Object.freeze(['raw', 'numbers', 'placeholders', 'skeleton', 'tokens'])

/** 去掉富文本标记 `{#...}`（不嵌套）。占位符 `{name}` 原样保留。 */
export function stripMarkup(text) {
    return String(text ?? '').replace(/\{#[^{}]*\}/g, '')
}

const NUM_RE = /-?\d+(?:[.,]\d+)?%?/g
const PH_RE = /\{([A-Za-z_][A-Za-z0-9_.-]*)(?::[^{}]*)?\}/g
const TOKEN_RE = /[A-Za-z0-9_]+|[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g
/** 项目符号行首：`-`、`•`、`*`、`·`、`–`、`—`（允许前导空白） */
const BULLET_RE = /^\s*[-•*·–—]/gm

/** 数值排序：按数值大小，而不是字典序（`10` 要排在 `9` 之后） */
function sortNumeric(list) {
    return [...list].sort((a, b) => {
        const na = Number(String(a).replace(/%$/, '').replace(',', '.'))
        const nb = Number(String(b).replace(/%$/, '').replace(',', '.'))
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
        return String(a).localeCompare(String(b))
    })
}

/**
 * 把一段文本归一化成可比较的骨架字符串。
 * @param {string} text
 * @param {'raw'|'numbers'|'placeholders'|'skeleton'|'tokens'} mode
 * @param {{ordered?: boolean}} [opts]
 */
export function normalizeText(text, mode = 'raw', opts = {}) {
    const ordered = opts?.ordered === true
    const src = String(text ?? '')
    if (mode === 'raw' || mode === undefined || mode === null) return src
    const clean = stripMarkup(src)

    const collect = (re) => [...clean.matchAll(re)].map((m) => (m[1] !== undefined ? m[1] : m[0]))
    const shape = (list) => (ordered ? list : sortNumeric(list)).join(',')

    if (mode === 'numbers') return shape(collect(NUM_RE))
    if (mode === 'placeholders') return shape(collect(PH_RE))
    if (mode === 'tokens') {
        const list = collect(TOKEN_RE).map((t) => t.toLowerCase())
        return ordered ? list.join('|') : [...new Set(list)].sort().join('|')
    }
    if (mode === 'skeleton') {
        const nums = shape(collect(NUM_RE))
        const phs = shape(collect(PH_RE))
        const segments = clean.split(/\r?\n/).filter((l) => l.trim() !== '').length
        const bullets = (clean.match(BULLET_RE) ?? []).length
        return `ph[${phs}] num[${nums}] seg=${segments} bullet=${bullets}`
    }
    throw new Error(`unknown normalize mode ${JSON.stringify(mode)}；可用：${NORMALIZE_MODES.join(' / ')}`)
}

/**
 * 对"任意投影结果"归一化：字符串/数字直接归一化；对象/数组逐**顶层标量字段**归一化
 * （记录模式 = 不给 valueField 时走这条；嵌套对象原样留给 textOfAny，不做深挖以免误伤）。
 */
export function normalizeAny(value, mode = 'raw', opts = {}) {
    if (mode === 'raw' || mode === undefined || mode === null) return value
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return normalizeText(value, mode, opts)
    if (typeof value === 'number' || typeof value === 'boolean') return normalizeText(String(value), mode, opts)
    if (Array.isArray(value)) return value.map((v) => normalizeAny(v, mode, opts))
    if (typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) {
            out[k] = (v === null || v === undefined || typeof v === 'object') ? v : normalizeAny(v, mode, opts)
        }
        return out
    }
    return value
}

/** 给 CLI/工具层做参数校验：非法模式要早报错（而不是静默当 raw） */
export function assertNormalizeMode(mode) {
    if (mode === undefined || mode === null || mode === '') return 'raw'
    const m = String(mode)
    if (!NORMALIZE_MODES.includes(m)) throw new Error(`normalize 只支持：${NORMALIZE_MODES.join(' / ')}（收到 ${JSON.stringify(mode)}）`)
    return m
}

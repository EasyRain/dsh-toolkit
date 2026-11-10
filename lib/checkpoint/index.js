/**
 * lib/checkpoint —— 我们自己的 checkpoint / rewind 核心（宿主侧，无 Web UI）
 *
 * 两套东西：
 *  1) 显式快照（checkpoint_*）：整工作区文件 + 当前会话日志 + 配置小文件，存到
 *     ~/.dsh/checkpoints/dsh-toolkit/<id>/，可 diff（对当前状态或两份快照之间）与预览式回滚。
 *  2) 变更前自动留底（journal_*）：监听宿主 fs 层的写/改意图事件（fs/write-intent /
 *     fs/edit-intent），在文件被改写前把**那一个文件的原文**留底 —— 便宜、每次都跑得起，
 *     覆盖官方 edit/write 与任何走 fs 层的改写工具。上限 200 条/会话，自动淘汰最旧。
 *
 * 引擎：unified diff 用**自研**的 `lib/checkpoint/diff.js`（；此前是 vendor 自上游的
 * Apache-2.0 实现，为便于开源发布与长期维护已全部换掉）。本文件只依赖 node: + 该 diff 模块，
 * 所以宿主内外都能跑（可离线自测）。
 */
import { createHash } from 'node:crypto'
import { assertWritableStorage, assertWritableTargets } from '../guard.js'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { configDiff, stableStringify, unifiedDiffLines } from './diff.js'
// 跨工作区写盘的**运维方开关**（参数只能收窄、不能放大权限 —— 见 lib/policy.js）
import { outsideWritesAllowed, outsideWritesRefusal } from '../policy.js'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const ROOT = process.env.DSH_TOOLKIT_CHECKPOINTS || join(HOME, 'checkpoints', 'dsh-toolkit')
const INDEX = join(ROOT, 'index.json')
const JOURNAL = join(ROOT, 'journal')

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'out', '.next', '__pycache__'])
const MAX_HASH_BYTES = 8 * 1024 * 1024 // 超过 8 MB 只记 size/mtime，不算哈希（8 MB 以内的大 .lua/.md 仍能进 diff）
const MAX_COPY_BYTES = 1024 * 1024 // 单个文件超过 1 MB 只记哈希、不复制进快照（工作区里常有几十 MB 的参考资料）
const MAX_COPY_TOTAL = 50 * 1024 * 1024 // 快照复制总量上限
const IGNORE_FILE = '.dsh-checkpoint-ignore' // 工作区根目录的忽略清单（每行一个模式，# 注释）
const MAX_FILES = 5000
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const JOURNAL_MAX = 200
const JOURNAL_MAX_FILE_BYTES = 20 * 1024 * 1024 // 留底单文件上限（超过就只记一条 skipped 记录，不再静默）
const MUTATION_TOOLS = new Set(['write', 'edit', 'multi_edit', 'ast_edit', 'apply_patch', 'notebook_write', 'insert'])
/** 从工具参数里挑出要改的文件路径（只认常见字段名，避免误伤）。 */
function pathsInArgs(value, depth = 0) {
    const out = []
    if (depth > 4 || value === null || typeof value !== 'object') return out
    for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'string' && /^(file_?path|path|target|file)$/i.test(k)) out.push(v)
        else if (Array.isArray(v) && /^(paths?|files?)$/i.test(k)) out.push(...v.filter((x) => typeof x === 'string'))
        else if (typeof v === 'object') out.push(...pathsInArgs(v, depth + 1))
    }
    return out
}
const DIFF_MAX_LINES = 400

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const shortId = (n = 12) => createHash('sha1').update(`${Date.now()}-${Math.random()}-${process.hrtime.bigint()}`).digest('hex').slice(0, n)

function ensureDir(p) { mkdirSync(p, { recursive: true }) }

/**
 * 读索引，并**自愈**：
 *  1) 索引缺失或损坏（JSON 解析失败）时不再直接返回空 —— 旧行为会让 `checkpoint_list` 显示"0 个快照"，
 * 而快照目录其实都还在，用户会以为"我的快照全没了"（审计发现）。现在改为**从磁盘重建**，
 *     并把损坏文件改名保留（`index.json.bad-<时间戳>`）便于事后查看。
 *  2) 目录里存在但**索引里没有**的 `ck-*`（写完目录、还没来得及写索引就崩溃；或手工编辑过索引）⇒ 收养。
 * 代价：每次读索引多一次 `readdirSync(ROOT)`（快照数很少），换来"快照不会莫名消失"。
 */
function readIndex() {
    let records = []
    let corrupted = false
    try {
        const parsed = JSON.parse(readFileSync(INDEX, 'utf8'))
        if (Array.isArray(parsed)) records = parsed
        else corrupted = true
    }
    catch {
        if (existsSync(INDEX)) corrupted = true // 文件不存在（首次使用）不算异常
    }

    const orphans = []
    try {
        for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith('ck-')) continue
            if (records.some((r) => r && r.id === entry.name)) continue
            try {
                const rec = JSON.parse(readFileSync(join(ROOT, entry.name, 'manifest.json'), 'utf8'))
                if (rec && rec.id) orphans.push(rec)
            }
            catch { /* 目录里没有可用清单：忽略 */ }
        }
    }
    catch { /* ROOT 还不存在 */ }

    // ⚠️ 必须**去重**：同一 id 只能有一条。历史上有两条来源会造成重复 ——
    //  (a) createCheckpoint 先写 manifest、再走本函数 ⇒ 刚建的目录被当"孤儿"收养一次，
    //      之后 createCheckpoint 又 push 一次 ⇒ 索引里同一个快照两条；
    //  (b) 手改索引 / 旧版本留下的重复。
    // 重复记录的后果不是"显示难看"：`prune keep:N` 是按**记录数**保留的，磁盘目录只有一半
 // ⇒ 请求保留 4 个实际只剩 2 个目录（**真删数据**，子代理审计实测）。
    const rawCount = records.length
    records = dedupeById(records)
    if (orphans.length > 0 || corrupted || records.length !== rawCount) {
        if (corrupted) {
            try { renameSync(INDEX, `${INDEX}.bad-${Date.now()}`) }
            catch { /* 改名失败不影响下面重建 */ }
        }
        const merged = dedupeById([...records, ...orphans])
            .sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')))
        try { writeIndex(merged) }
        catch { /* 只读介质等：内存里仍然可用 */ }
        return merged
    }
    return records
}

/** 按 id 去重（保留首次出现的那条，丢掉后面的重复） */
function dedupeById(records) {
    const seen = new Set()
    const out = []
    for (const r of records) {
        if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue
        seen.add(r.id)
        out.push(r)
    }
    return out
}

function writeIndex(records) {
    ensureDir(ROOT)
    writeJsonAtomic(INDEX, records)
}

/** 原子写 JSON：先写 .tmp 再 rename —— 直接覆盖时若中途崩溃会留下半个文件，
 *  readIndex 的 catch 会退化成"0 个快照"，等于把索引全丢了（目录还在但没人认得）。 */
function writeJsonAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 读工作区根的 .dsh-checkpoint-ignore（每行一个模式，# 注释） */
export function readIgnorePatterns(cwd) {
    const out = []
    try {
        for (const line of readFileSync(join(resolve(cwd), IGNORE_FILE), 'utf8').split('\n')) {
            const s = line.trim()
            if (s !== '' && !s.startsWith('#')) out.push(s)
        }
    }
    catch { /* 没有忽略文件也正常 */ }
    return out
}

/**
 * 模式 → 匹配器。无 '/' 的模式匹配任意层级的同名段（`deps` 命中最外层 deps/ 及其下所有内容）；
 * 含 '/' 的模式按相对路径前缀匹配（`deps/vendor`）；支持 `*` 简单通配（`*.log`、`docs/*`）。
 */
export function makeExcluder(patterns = []) {
    const segRes = []
    const pathRes = []
    for (const raw of patterns) {
        const p = String(raw).trim().replace(/^\.\//, '').replace(/[\\/]+$/, '')
        if (p === '') continue
        const rx = new RegExp('^' + p.split('*').map(escRe).join('[^/\\\\]*') + '$')
        if (p.includes('/') || p.includes('\\')) pathRes.push(rx)
        else segRes.push(rx)
    }
    if (segRes.length === 0 && pathRes.length === 0) return () => false
    return (rel) => {
        const parts = String(rel).replace(/\\/g, '/').split('/')
        if (segRes.some((re) => parts.some((x) => re.test(x)))) return true
        for (let i = 1; i <= parts.length; i++) {
            const prefix = parts.slice(0, i).join('/')
            if (pathRes.some((re) => re.test(prefix))) return true
        }
        return false
    }
}

/** 遍历工作区（跳过 EXCLUDE_DIRS / 排除模式 / 超量文件），返回 [{rel, abs, size, mtime, hash?}]
 *  数组上附带 `.excluded`（被排除的条目数）与 `.patterns`（生效的排除模式）。 */
/** 量一个被排除的子树有多大（有上限，避免在超大目录上耗时间） */
/** 目录真实占用（审计 E-M6：checkpoint_list 以前只累加 copiedBytes，与实际占盘差几个数量级） */
/**
 * 两份快照（或"快照 vs 当前"）之间的**配置**对比（审计 E-L2：配置留底以前每次 create 都复制，
 * 但 restore/diff 从不使用 ⇒ 纯占体积。这里让它真正可用）。
 * 返回 null 表示两边都没有配置留底；否则 { changed, text, compared }。
 */
function configDiffBetween(id, otherId) {
    const a = loadCheckpoint(id)
    const aCfg = a?.rec?.configs ?? []
    let bCfg = []
    if (otherId !== null) {
        const b = loadCheckpoint(otherId)
        bCfg = b?.rec?.configs ?? []
    }
    else {
        // 与当前 ~/.dsh 下的同名文件比（"快照 vs 现在"）
        for (const c of aCfg) {
            const current = join(HOME, c.name)
            if (existsSync(current)) bCfg.push({ name: c.name, from: current })
        }
    }
    if (aCfg.length === 0 && bCfg.length === 0) return null
    const readCfg = (c) => {
        try { return readFileSync(c.from, 'utf8') }
        catch { return '' }
    }
    const byName = new Map(bCfg.map((c) => [c.name, c]))
    const parts = []
    let changed = 0
    let compared = 0
    for (const c of aCfg) {
        const b = byName.get(c.name)
        if (b === undefined) continue
        compared += 1
        const diff = configDiff(stableStringify(parseMaybeJson(readCfg(c))), stableStringify(parseMaybeJson(readCfg(b))))
        if (diff.changed) { changed += 1; parts.push(`--- ${c.name} ---`, diff.text) }
    }
    return { changed: changed > 0, text: parts.join('\n'), compared }
}

/** 能解析成 JSON 就解析（配置多为 JSON），否则按原文本；配合 stableStringify 做键顺序无关比较 */
function parseMaybeJson(text) {
    try { return JSON.parse(text) }
    catch { return text }
}
function dirBytes(dir) {
    let total = 0
    const walk = (d) => {
        let entries = []
        try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
            const p = join(d, e.name)
            if (e.isDirectory()) walk(p)
            else { try { total += statSync(p).size } catch { /* 忽略 */ } }
        }
    }
    walk(dir)
    return total
}
function measureDir(abs, cap = { files: 200000, bytes: 4 * 1024 * 1024 * 1024 }) {
    let files = 0
    let bytes = 0
    const stack = [abs]
    while (stack.length > 0) {
        const dir = stack.pop()
        let entries = []
        try { entries = readdirSync(dir, { withFileTypes: true }) }
        catch { continue }
        for (const e of entries) {
            const p = join(dir, e.name)
            if (e.isDirectory()) { stack.push(p); continue }
            if (!e.isFile()) continue
            try { bytes += statSync(p).size }
            catch { /* ignore */ }
            files++
            if (files >= cap.files || bytes >= cap.bytes) return { files, bytes, capped: true }
        }
    }
    return { files, bytes, capped: false }
}

/** `third_party` 这类顶层目录名（用于统计"还留着的大目录"） */
const topDirOf = (rel) => {
    const norm = String(rel).replace(/\\/g, '/')
    const i = norm.indexOf('/')
    return i < 0 ? '(root files)' : norm.slice(0, i)
}

export function walkWorkspace(cwd, limits = {}) {
    const maxFiles = limits.maxFiles ?? MAX_FILES
    const maxBytes = limits.maxBytes ?? MAX_TOTAL_BYTES
    const root = resolve(cwd)
    const matcher = makeExcluder(limits.exclude ?? [])
    const files = []
    const excludedDetail = []
    let total = 0
    let excluded = 0
    let overCap = 0
    let overCapBytes = 0
    const stack = [root]
    while (stack.length > 0 && files.length < maxFiles) {
        const dir = stack.pop()
        let entries = []
        try { entries = readdirSync(dir, { withFileTypes: true }) }
        catch { continue }
        for (const e of entries) {
            const abs = join(dir, e.name)
            const rel = relative(root, abs)
            if (e.isDirectory()) {
                if (EXCLUDE_DIRS.has(e.name)) { excluded++; continue }
                if (matcher(rel)) {
                    excluded++
                    const m = measureDir(abs)
                    excludedDetail.push({ rel, files: m.files, bytes: m.bytes, capped: m.capped })
                    continue
                }
                stack.push(abs)
                continue
            }
            if (!e.isFile()) continue
            if (matcher(rel)) {
                excluded++
                try { excludedDetail.push({ rel, files: 1, bytes: statSync(abs).size, capped: false }) }
                catch { /* ignore */ }
                continue
            }
            let st
            try { st = statSync(abs) }
            catch { continue }
            if (total + st.size > maxBytes) {
                // 超出总量上限：静默丢弃会让人以为"工作区就这么大"，所以计数并在记录里报出来
                overCap++
                overCapBytes += st.size
                continue
            }
            total += st.size
            const item = { rel, abs, size: st.size, mtime: Math.round(st.mtimeMs) }
            if (st.size <= MAX_HASH_BYTES) {
                try {
                    item.hash = sha256(readFileSync(abs))
                }
                catch { /* 读不到就不算哈希 */ }
            }
            files.push(item)
            if (files.length >= maxFiles) break
        }
    }
    files.excluded = excluded
    files.excludedDetail = excludedDetail
    files.overCap = overCap
    files.overCapBytes = overCapBytes
    files.patterns = limits.exclude ?? []
    return files
}

// --- 显式快照 ---------------------------------------------------------------

// DSH 自身的配置文件（各版本命名略有差异，存在才收）；第三方插件的配置文件**不写死**
// —— 由运维方用 `DSH_TOOLKIT_CONFIG_FILES` 指定（多个用 ';' 或换行分隔，绝对路径或 $DSH_HOME 下的相对名）。
const CORE_CONFIG_NAMES = ['settings.yaml', 'settings.yaml.imported', 'settings.json']
const extraConfigFiles = () => String(process.env.DSH_TOOLKIT_CONFIG_FILES ?? '')
    .split(/[;\n]+/).map((s) => s.trim()).filter(Boolean)

const configFilesOf = () => {
    const out = []
    for (const name of [...CORE_CONFIG_NAMES, ...extraConfigFiles()]) {
        const p = isAbsolute(name) ? name : join(HOME, name)
        if (existsSync(p)) out.push(p)
    }
    const profiles = join(HOME, 'profiles')
    if (existsSync(profiles)) {
        for (const prof of readdirSync(profiles)) {
            for (const f of ['package.json', 'pnpm-workspace.yaml']) {
                const p = join(profiles, prof, f)
                if (existsSync(p)) out.push(p)
            }
        }
    }
    return out
}

/** 打一个整工作区快照；sessionFile 可选（由调用方用 session 工具解析后传入） */
/** 预设排除（可选开关 `presetExclude: true`，大规模工作区评审建议）：给大工作区（构建产物很多的那种）用 */
export const PRESET_EXCLUDES = ['build', '.gradle', '.gradle-home', '.gradle-dist', 'node_modules', '.git', 'run', '*.log', '*.jar', '*.tmp']

/** 只**估算**不落盘（`estimate: true`）：大工作区先看清规模再决定要不要建快照 */
export function estimateCheckpoint({ cwd = process.cwd(), exclude = [], presetExclude = false, maxFiles = null } = {}) {
    if (!existsSync(cwd)) throw new Error(`cwd 不存在：${resolve(cwd)}（检查路径；相对路径以调用方会话工作区为基准）`)
    const patterns = [...readIgnorePatterns(cwd), ...(presetExclude ? PRESET_EXCLUDES : []), ...exclude]
    const started = Date.now()
    // 估算**默认不限文件数**（默认 5000 会把 `files=5000` 显示成"总数"，误导人；这里宁可贵一点也要真实）
    const files = walkWorkspace(cwd, { exclude: patterns, maxFiles: maxFiles === null ? 1_000_000 : maxFiles })
    const capped = files.length >= (maxFiles === null ? 1_000_000 : maxFiles)
    let bytes = 0
    let copyable = 0
    let copyableBytes = 0
    let hashOnlyCount = 0
    for (const f of files) {
        bytes += f.size
        if (f.size <= MAX_COPY_BYTES && copyableBytes + f.size <= MAX_COPY_TOTAL) { copyable += 1; copyableBytes += f.size }
        else hashOnlyCount += 1
    }
    return {
        cwd: resolve(cwd),
        files: files.length,
        bytes,
        copyable,
        copyableBytes,
        hashOnly: hashOnlyCount,
        excludedPatterns: patterns,
        capped,
        ms: Date.now() - started,
        note: `${presetExclude ? `已应用预设排除：${PRESET_EXCLUDES.join(', ')}；` : ''}${patterns.length === 0 ? '没有排除模式 —— 大工作区建议加 exclude 或根目录 .dsh-checkpoint-ignore' : `已应用 ${patterns.length} 条排除模式`}`,
    }
}

export function createCheckpoint({ cwd = process.cwd(), note = '', kind = 'manual', sessionFile = null, sessionId = null, exclude = [], presetExclude = false, estimate = false, maxFiles = null, maxCopyBytes = MAX_COPY_BYTES, maxCopyTotal = MAX_COPY_TOTAL } = {}) {
    if (estimate === true) return { estimate: estimateCheckpoint({ cwd, exclude, presetExclude, maxFiles }) }
    if (!existsSync(cwd)) throw new Error(`cwd 不存在：${resolve(cwd)}（检查路径；相对路径以调用方会话工作区为基准）`)
    // id 用 48 bit 熵（旧版 24 bit：同毫秒+后缀碰撞会**覆盖目录**并留下两条同 id 记录，
    // 而 loadCheckpoint 取第一条 ⇒ 回滚到错的快照内容）。另外同 id 目录已存在时换一个再试。
    let id = `ck-${stamp()}-${shortId(12)}`
    for (let attempt = 0; attempt < 5 && existsSync(join(ROOT, id)); attempt += 1) id = `ck-${stamp()}-${shortId(12)}`
    const dir = join(ROOT, id)
    ensureDir(join(dir, 'workspace'))
    const patterns = [...readIgnorePatterns(cwd), ...(presetExclude ? PRESET_EXCLUDES : []), ...exclude]
    const files = walkWorkspace(cwd, { exclude: patterns, ...(maxFiles === null ? {} : { maxFiles }) })
    const manifestFiles = []
    let copiedBytes = 0
    let hashOnly = 0
    let overPerFile = 0            // 因单个文件超过 maxCopyBytes 而只记哈希
    let overPerFileBytes = 0
    let overBudget = 0             // 因 maxCopyTotal 预算不足而只记哈希（**这类的计数以前是缺失的**）
    let overBudgetBytes = 0
    let copyFailed = 0
    for (const f of files) {
        // 大文件（或超出复制预算）只记哈希：diff 仍准确，但快照里没有原文可回滚
        const fitsPerFile = f.size <= maxCopyBytes
        const fitsBudget = copiedBytes + f.size <= maxCopyTotal
        if (fitsPerFile && fitsBudget) {
            const dest = join(dir, 'workspace', f.rel)
            ensureDir(dirname(dest))
            try {
                copyFileSync(f.abs, dest)
                copiedBytes += f.size
                manifestFiles.push({ rel: f.rel, size: f.size, mtime: f.mtime, hash: f.hash ?? null, stored: true })
                continue
            }
            catch { copyFailed++ }
        }
        else if (!fitsPerFile) {
            overPerFile++
            overPerFileBytes += f.size
        }
        else {
            overBudget++
            overBudgetBytes += f.size
        }
        hashOnly++
        manifestFiles.push({ rel: f.rel, size: f.size, mtime: f.mtime, hash: f.hash ?? null, stored: false })
    }
    // 会话日志
    const session = { file: null, bytes: 0, frames: null }
    if (sessionFile && existsSync(sessionFile)) {
        ensureDir(join(dir, 'session'))
        const dest = join(dir, 'session', 'session.v4.jsonl.zstd')
        copyFileSync(sessionFile, dest)
        session.file = dest
        session.bytes = statSync(dest).size
        session.id = sessionId
    }
    // 配置
    const configs = []
    for (const p of configFilesOf()) {
        const dest = join(dir, 'config', p.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '__'))
        ensureDir(dirname(dest))
        try {
            copyFileSync(p, dest)
            configs.push({ from: p, name: dest.split(sep).pop() })
        }
        catch { /* 跳过 */ }
    }
    const record = {
        id,
        time: new Date().toISOString(),
        kind,
        note: String(note).slice(0, 500),
        cwd: resolve(cwd),
        dir,
        files: manifestFiles.length,
        bytes: manifestFiles.reduce((s, f) => s + f.size, 0),
        copiedBytes,
        hashOnly,
        hashOnlyDetail: { overPerFile, overPerFileBytes, overBudget, overBudgetBytes, copyFailed },
        excluded: files.excluded ?? 0,
        excludedDetail: (files.excludedDetail ?? []).sort((a, b) => b.bytes - a.bytes).slice(0, 12),
        overCap: files.overCap ?? 0,
        overCapBytes: files.overCapBytes ?? 0,
        keptDirs: (() => {
            const byDir = new Map()
            for (const f of manifestFiles) {
                const d = topDirOf(f.rel)
                byDir.set(d, (byDir.get(d) ?? 0) + f.size)
            }
            return [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([dir, bytes]) => ({ dir, bytes }))
        })(),
        excludePatterns: patterns,
        limits: { maxCopyBytes, maxCopyTotal, maxFiles: maxFiles ?? MAX_FILES },
        skipped: files.length >= (maxFiles ?? MAX_FILES) ? `清单被文件数上限截断（${maxFiles ?? MAX_FILES} 个）—— 提高 maxFiles 或多排除一些目录` : null,
        // 预算用尽要看"**被降级**的文件数"，不能只看 copiedBytes：一个大文件超过剩余预算时 copiedBytes 可能很小，
 // 旧条件（copiedBytes >= maxCopyTotal）于是永不触发 ⇒ 降级静默发生（端到端复测发现）。
        copyBudgetHit: (overBudget > 0 || copiedBytes >= maxCopyTotal)
            ? `复制预算用尽（上限 ${(maxCopyTotal / 1048576).toFixed(1)} MB）${overBudget > 0 ? `：${overBudget} 个文件 / ${(overBudgetBytes / 1048576).toFixed(2)} MB 已降级为"只记哈希"（无法回滚）` : ''}—— 可用 maxCopyTotal 调大`
            : null,
        session,
        configs,
        manifest: manifestFiles,
    }
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    // **upsert**：不要盲目 push。readIndex 的"孤儿收养"会把刚刚写下的这个目录当成孤儿收进索引，
    // 再 push 一次就会让同一个快照在索引里出现两条 —— 而 `prune keep:N` 按记录数保留，
 // 磁盘目录只有一半 ⇒ 请求保留 4 个实际只剩 2 个（**真删数据**，子代理审计实测）。
    const records = readIndex().filter((r) => r && r.id !== record.id)
    records.push({ ...record, manifest: undefined })
    writeIndex(records)
    return record
}

export function listCheckpoints(limit = 20) {
    return readIndex().slice(-limit).reverse()
}

export function loadCheckpoint(id) {
    const records = readIndex()
    // 精确匹配优先；否则前缀匹配 —— **多个匹配必须报错**：这是破坏性操作的前置查询，
 // 静默取第一个会让人以为操作的是 A，实际动的是 B（体检发现）。
    const exact = records.find((r) => r.id === id)
    const matches = exact !== undefined ? [exact] : records.filter((r) => r.id.startsWith(id))
    if (matches.length === 0) throw new Error(`no checkpoint matching "${id}" (${records.length} on disk) —— 参数按 **id 前缀**匹配，尾段查不到属正常；用 checkpoint_list 取完整 id`)
    if (matches.length > 1) throw new Error(`"${id}" 匹配到 ${matches.length} 个快照，请给更长的前缀：${matches.slice(0, 5).map((r) => r.id).join(', ')}`)
    const rec = matches[0]
    let manifest = rec
    try {
        manifest = JSON.parse(readFileSync(join(rec.dir, 'manifest.json'), 'utf8'))
    }
    catch { /* 退化为索引记录 */ }
    return { rec, manifest, files: manifest.manifest ?? [] }
}

/** 快照 vs 当前状态（或另两份快照之间）的文件级 diff */
export function diffCheckpoint({ id, other = null, cwd = null, maxDiffs = 5 }) {
    const base = loadCheckpoint(id)
    const baseDir = join(base.rec.dir, 'workspace')
    const A = new Map(base.files.map((f) => [f.rel, f]))
    const otherLoaded = other ? loadCheckpoint(other) : null
    const target = otherLoaded ? otherLoaded.files : walkWorkspace(cwd ?? base.rec.cwd)
    const targetDir = otherLoaded ? join(otherLoaded.rec.dir, 'workspace') : null
    const B = new Map(target.map((f) => [f.rel, f]))
    const added = []
    const removed = []
    const changed = []
    for (const [rel, b] of B) {
        const a = A.get(rel)
        if (!a) { added.push(rel); continue }
        const sameHash = a.hash && b.hash ? a.hash === b.hash : a.size === b.size && a.mtime === b.mtime
        if (!sameHash) changed.push(rel)
    }
    for (const rel of A.keys()) if (!B.has(rel)) removed.push(rel)
    const diffs = []
    for (const rel of changed.slice(0, maxDiffs)) {
        const aPath = join(baseDir, rel)
        const bPath = targetDir ? join(targetDir, rel) : join(resolve(cwd ?? base.rec.cwd), rel)
        try {
            const aText = readFileSync(aPath, 'utf8')
            const bText = readFileSync(bPath, 'utf8')
            const text = unifiedDiffLines(aText.split('\n'), bText.split('\n'), {
                fromLabel: `${id}:${rel}`,
                toLabel: other ? `${other}:${rel}` : `now:${rel}`,
                // 上限交给 diff 自己：它会附一行"另有 N 行未展示"，而不是静默截断
                maxLines: DIFF_MAX_LINES,
            })
            diffs.push({ rel, text })
        }
        catch {
            // 说清**真实原因**：以前一律写 "(binary or unreadable — sizes differ)"，
            // 而最常见的原因是"这个文件超过复制上限，快照里根本没存原文"（只记了 hash/size）
 // —— 报成 binary 会让人以为文件坏了（子代理审计发现）。
            const hashOnly = [A.get(rel), B.get(rel)].some((f) => f && f.stored === false)
            diffs.push({
                rel,
                text: hashOnly
                    ? '(快照未存原文：该文件超过复制上限（只记了 size/hash），内容无法逐行对比 —— 看 hash 是否一致即可判断有没有变)'
                    : '(binary or unreadable — sizes differ)',
            })
        }
    }
    return {
        id: base.rec.id,
        other,
        cwd: base.rec.cwd,
        warning: otherLoaded && resolve(otherLoaded.rec.cwd) !== resolve(base.rec.cwd)
            ? `⚠ 这两个快照来自不同工作区（${base.rec.cwd} vs ${otherLoaded.rec.cwd}）—— 比较的是相对路径，结果可能没有意义`
            : null,
        added,
        removed,
        changed,
        diffs,
    }
}

/** 预览式回滚：dryRun=true 只报告；confirm=true 才写盘 */
export function restoreCheckpoint({ id, files = null, cwd = null, dryRun = true, confirm = false, pruneExtra = false, guardCtx = null, guardSession = null }) {
    // 调用方显式给了目标目录：**先过闸门再碰快照**（写不进去就没必要读快照）。
    if (dryRun !== true && typeof cwd === 'string' && cwd !== '') assertWritableTargets(guardCtx, [resolve(cwd)], { session: guardSession })
    const { rec, files: snapshotFiles } = loadCheckpoint(id)
    const baseDir = join(rec.dir, 'workspace')
    const target = resolve(cwd ?? rec.cwd)
    const crossWorkspace = target !== resolve(rec.cwd)
    // 跨工作区写回是允许的（显式给 cwd 就是意图），但必须提示；而 pruneExtra 在跨工作区时**必须拒绝** ——
    // 它会删除"目标目录里快照中不存在"的文件，指错目录就是删别人一棵树。
    if (pruneExtra && crossWorkspace) {
        throw new Error(`pruneExtra 会删除目标目录中"快照里不存在"的文件，而目标目录与快照记录的工作区不同：${target} ≠ ${rec.cwd}。请显式传 cwd=${rec.cwd}，或去掉 pruneExtra`)
    }
    // 真正写盘（confirm）时过沙箱闸门：快照写回可能落在工作区之外，不能绕开宿主策略。
    if (dryRun !== true) assertWritableTargets(guardCtx, [target], { session: guardSession })
    const warning = crossWorkspace
        ? `⚠ 目标目录与快照记录的工作区不同：${target} ≠ ${rec.cwd}（快照内容是相对路径，写回会落到前者）`
        : null
    const normRel = (p) => String(p).replace(/\\/g, '/')
    const byRel = new Map(snapshotFiles.map((f) => [normRel(f.rel), f]))
    const wanted = files && files.length > 0 ? files : snapshotFiles.map((f) => f.rel)
    const plan = []
    const modifiedSince = []
    for (const rel of wanted) {
        const meta = byRel.get(normRel(rel))
        if (meta && meta.stored === false) { plan.push({ rel, action: 'not-stored (hash only)' }); continue }
        const src = join(baseDir, rel)
        if (!existsSync(src)) { plan.push({ rel, action: meta ? 'not-stored (hash only)' : 'missing-in-snapshot' }); continue }
        const dst = join(target, rel)
        if (!existsSync(dst)) plan.push({ rel, action: 'create' })
        else {
            let same = false
            let changedSince = false
            try {
                const dstBuf = readFileSync(dst)
                same = readFileSync(src).equals(dstBuf)
 // **是否被外部改过**：拿快照清单里的 size/hash 与当前文件比（审计：以前完全不校验，
                // 于是"回滚"会静默覆盖用户在此期间做的修改，用户看不到任何提示）
                if (!same && meta) {
                    const curHash = sha256(dstBuf)
                    changedSince = meta.hash ? curHash !== meta.hash : (meta.size !== undefined && dstBuf.length !== meta.size)
                }
            }
            catch { same = false }
            if (changedSince) modifiedSince.push(rel)
            plan.push({ rel, action: same ? 'unchanged' : 'overwrite', changedSinceSnapshot: changedSince })
        }
    }
    const snapSet = new Set(snapshotFiles.map((f) => f.rel))
    const ignorePatterns = [...readIgnorePatterns(target), ...(Array.isArray(rec.excludePatterns) ? rec.excludePatterns : [])]
    const isIgnored = (rel) => {
        const segs = normRel(rel).split('/')
        return ignorePatterns.some((p) => {
            const pat = String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
            if (pat === '') return false
            // 含 `/` ⇒ 路径前缀；含 `*` ⇒ 按末段通配；裸名 ⇒ **任意层级的同名段**
 // （与 checkpoint_create 的 exclude 语义一致；审计发现这里漏了"首段"）
            if (pat.includes('/')) return normRel(rel) === pat || normRel(rel).startsWith(pat + '/')
            if (pat.includes('*')) {
                const rx = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
                return rx.test(segs[segs.length - 1])
            }
            return segs.includes(pat)
        })
    }
    // ⚠️ pruneExtra 的删除名单**必须**先过排除规则：`.dsh-checkpoint-ignore` 以前只在 create 时生效，
 // 于是"我排除了某个大目录、从没进过快照" ⇒ 回滚一次把参考资料全删了（子代理审计实测）。
    const extra = [...new Set(walkWorkspace(target).map((f) => f.rel))]
        .filter((rel) => !snapSet.has(rel) && !isIgnored(rel))
    const skippedByIgnore = [...new Set(walkWorkspace(target).map((f) => f.rel))]
        .filter((rel) => !snapSet.has(rel) && isIgnored(rel))
    if (dryRun || confirm !== true) {
        return {
            id: rec.id, dryRun: true, wrote: 0, plan, warning,
            modifiedSince: modifiedSince.slice(0, 20), modifiedCount: modifiedSince.length,
            extraFiles: extra.slice(0, 20), extraCount: extra.length,
            ignoredFromPrune: skippedByIgnore.length,
            hint: 'pass confirm: true to actually write',
        }
    }
    // **写盘前预检**：所有目标先试建临时文件，有一个不行就整体不写（旧实现是写一半再抛错，
 // 工作区停在中间状态且用户不知道哪些已经写了 —— 审计）。
    const pending = plan.filter((p) => p.action === 'create' || p.action.startsWith('overwrite'))
    const unwritable = []
    const tmpFor = (rel) => join(target, `${rel}.dsh-restore-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    for (const p of pending) {
        const dst = join(target, p.rel)
        const tmp = tmpFor(p.rel)
        try {
            ensureDir(dirname(dst))
            if (existsSync(dst)) {
                // 目标被目录占位 / 只读 / 被独占打开 —— 都要在**写任何文件之前**发现
                if (!statSync(dst).isFile()) throw new Error('目标是目录，不是文件')
                const fd = openSync(dst, 'r+')
                closeSync(fd)
            }
            writeFileSync(tmp, '')
            rmSync(tmp, { force: true })
        }
        catch (e) {
            unwritable.push(`${p.rel}: ${e && e.message ? e.message : String(e)}`)
        }
    }
    if (unwritable.length > 0) {
        throw new Error(`回滚预检失败，**未写入任何文件**（先把这些问题处理掉再重试）：\n${unwritable.slice(0, 5).join('\n')}${unwritable.length > 5 ? `\n… 另有 ${unwritable.length - 5} 个` : ''}`)
    }
    let wrote = 0
    const failed = []
    for (const p of pending) {
        const dst = join(target, p.rel)
        const tmp = tmpFor(p.rel)
        try {
            // ⚠️ 回滚会**覆盖**目标文件；覆盖前必须留底（journal），否则"用快照回滚"会把用户更新的内容
 // 永久吃掉、journal 也救不回来 —— 故障注入审计发现的缺口（restore 自己没走留底路径）。
            if (existsSync(dst)) capturePreImage(dst, { trigger: 'checkpoint/restore' })
            copyFileSync(join(baseDir, p.rel), tmp)
            renameSync(tmp, dst) // 逐文件原子：要么旧内容要么新内容，不会半个文件
            wrote++
        }
        catch (e) {
            try { rmSync(tmp, { force: true }) } catch { /* 清理失败无所谓 */ }
            failed.push(`${p.rel}: ${e && e.message ? e.message : String(e)}`)
            break // 预检过了还失败（磁盘满/权限变了）：停下，别继续制造不一致
        }
    }
    let pruned = 0
    if (pruneExtra) {
        for (const rel of extra) {
            try {
                const abs = join(target, rel)
                // 同理：这些文件**不在快照里**，删掉就真没了 ⇒ 删之前留底（比覆盖更不可逆）
                if (existsSync(abs)) capturePreImage(abs, { trigger: 'checkpoint/restore-prune' })
                rmSync(abs, { force: true }); pruned++
            }
            catch { /* 跳过 */ }
        }
    }
    if (failed.length > 0) {
        return {
            id: rec.id, dryRun: false, wrote, pruned, plan, warning, failed,
            partial: true,
            hint: `写入中途失败（已成功 ${wrote} 个文件），工作区处于**部分回滚**状态；处理掉失败原因后重新 preview + confirm 即可续做`,
            modifiedSince: modifiedSince.slice(0, 20), modifiedCount: modifiedSince.length,
            extraFiles: extra.slice(0, 20), extraCount: extra.length, ignoredFromPrune: skippedByIgnore.length,
        }
    }
    return {
        id: rec.id, dryRun: false, wrote, pruned, plan, warning,
        modifiedSince: modifiedSince.slice(0, 20), modifiedCount: modifiedSince.length,
        extraFiles: extra.slice(0, 20), extraCount: extra.length, ignoredFromPrune: skippedByIgnore.length,
    }
}

export function pruneCheckpoints(keep = 20, drop = []) {
    let records = readIndex()
    const dropped = []
    if (drop.length > 0) {
        // **前缀必须先解析成唯一 id**：以前直接 `r.id.startsWith(d)` ⇒ `drop:["ck-2"]` 会命中所有
        // 以 ck-2 开头的快照（实测 4 个全删）。这与 loadCheckpoint 的"歧义必须报错"策略也不一致。
        const targets = new Set()
        for (const d of drop) {
            const key = String(d)
            if (records.some((r) => r.id === key)) { targets.add(key); continue }
            const hits = records.filter((r) => r.id.startsWith(key))
            if (hits.length === 0) throw new Error(`drop 里的 "${key}" 匹配不到任何快照`)
            if (hits.length > 1) {
                throw new Error(`drop 里的 "${key}" 匹配到 ${hits.length} 个快照，请给更长的前缀（避免一次删掉多个）：${hits.slice(0, 5).map((r) => r.id).join(', ')}`)
            }
            targets.add(hits[0].id)
        }
        const keepRecs = []
        for (const r of records) {
            if (targets.has(r.id)) {
                try { rmSync(r.dir, { recursive: true, force: true }) }
                catch { /* 跳过 */ }
                dropped.push(r.id)
            }
            else keepRecs.push(r)
        }
        records = keepRecs
    }
    if (records.length <= keep) {
        writeIndex(records)
        return { removed: [...dropped], dropped, kept: records.length }
    }
    const removed = records.slice(0, records.length - keep)
    for (const r of removed) {
        try { rmSync(r.dir, { recursive: true, force: true }) }
        catch { /* 跳过 */ }
    }
    writeIndex(records.slice(records.length - keep))
    return { removed: removed.map((r) => r.id), kept: keep }
}

// --- 变更前自动留底（journal） ----------------------------------------------

function journalDirFor(sessionKey) {
    return join(JOURNAL, String(sessionKey || 'default').replace(/[^A-Za-z0-9_.-]/g, '_'))
}

/** 留底被跳过的记录（审计 E-M3：>20 MB 的文件以前**静默** return null，用户以为"留底过了"） */
export const journalSkips = []

/** 读某个 bucket（或全部）里"没留底"的记录（审计 E-M3） */
function readJournalSkips(sessionKey = null, onlyPath = null) {
    const out = []
    const buckets = sessionKey === null ? journalBuckets() : [String(sessionKey).replace(/[^A-Za-z0-9_.-]/g, '_')]
    for (const bucket of buckets) {
        try {
            const list = JSON.parse(readFileSync(join(JOURNAL, bucket, 'skipped.json'), 'utf8'))
            if (!Array.isArray(list)) continue
            for (const s of list) {
                if (onlyPath !== null && s.path !== resolve(onlyPath)) continue
                out.push({ ...s, bucket })
            }
        }
        catch { /* 没有该文件/坏 JSON：忽略 */ }
    }
    return out.slice(0, 20)
}

/** 在文件被改写前留一份原文；已留过同一内容则跳过。返回条目或 null */
export function capturePreImage(absPath, { trigger = 'fs/write-intent', sessionKey = 'default' } = {}) {
    try {
        const p = resolve(absPath)
        if (!existsSync(p)) return null
        const st = statSync(p)
        if (!st.isFile()) return null
        if (st.size > JOURNAL_MAX_FILE_BYTES) {
            // 太大不复制，但**记下来**（checkpoint_journal 会把它列出来，说明为什么没留底）
            const note = { path: p, size: st.size, limit: JOURNAL_MAX_FILE_BYTES, time: new Date().toISOString(), trigger, reason: 'too-large' }
            journalSkips.push(note)
            while (journalSkips.length > 50) journalSkips.shift()
            try {
                const dir = journalDirFor(sessionKey)
                ensureDir(dir)
                writeJsonAtomic(join(dir, 'skipped.json'), journalSkips.filter((s) => s.path === p || s.reason === 'too-large').slice(-20))
            }
            catch { /* 记录失败不影响主流程 */ }
            return null
        }
        const buf = readFileSync(p)
        const hash = sha256(buf)
        const dir = journalDirFor(sessionKey)
        ensureDir(dir)
        const index = join(dir, 'index.json')
        let entries = []
        try { entries = JSON.parse(readFileSync(index, 'utf8')) }
        catch { entries = [] }
        if (entries.some((e) => e.hash === hash && e.path === p)) return null
        const id = `${stamp()}-${shortId(6)}`
        const dest = join(dir, `${id}.bin`)
        writeFileSync(dest, buf)
        const entry = { id, path: p, trigger, time: new Date().toISOString(), size: st.size, hash, blob: dest }
        entries.push(entry)
        while (entries.length > JOURNAL_MAX) {
            const drop = entries.shift()
            try { rmSync(drop.blob, { force: true }) }
            catch { /* 跳过 */ }
        }
        writeJsonAtomic(index, entries)
        return entry
    }
    catch {
        return null
    }
}

/** 留底 bucket 列表（留底时按 DSH_SESSION_ID 派生 bucket，读侧必须能跨 bucket 找） */
function journalBuckets() {
    try {
        return readdirSync(JOURNAL, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    }
    catch { return [] }
}

/**
 * 读留底条目。`sessionKey` 不给（null）时**扫描所有 bucket** —— 以前默认只读 'default'，
 * 而写入侧的 bucket 是按 `DSH_SESSION_ID` 派生的，宿主一旦设了那个变量就会"留了底却查不到"。
 */
export function listJournal({ sessionKey = null, limit = 30, path: filterPath = null } = {}) {
    const dirs = sessionKey === null || sessionKey === undefined
        ? journalBuckets().map((b) => join(JOURNAL, b))
        : [journalDirFor(sessionKey)]
    const all = []
    for (const dir of dirs) {
        try {
            const entries = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
            const bucket = dir === journalDirFor(sessionKey) && sessionKey ? String(sessionKey) : dir.split(/[\\/]/).pop()
            for (const e of entries) all.push({ ...e, bucket })
        }
        catch { /* 没有这个 bucket */ }
    }
    let out = all
    if (filterPath) out = out.filter((e) => resolve(e.path) === resolve(filterPath))
    out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)) // 新的在前
    return out.slice(0, limit)
}

export function journalRestore({ path: target, id = null, sessionKey = null, dryRun = true, confirm = false, cwd = null, allowOutside = false, guardCtx = null, guardSession = null }) {
    const entries = listJournal({ sessionKey, limit: JOURNAL_MAX, path: target })
    const entry = id ? entries.find((e) => e.id === id || e.id.startsWith(id)) : entries[0]
    if (!entry) throw new Error(`no journal pre-image for ${target}`)
    // **边界校验**：留底里存的是绝对路径，以前直接写回 ⇒ 可以把**工作区之外**的文件按留底覆盖
 // （子代理审计实测）。默认只允许写回调用方工作区内的路径。
 // （借鉴 dsh-ops 的 "Model inputs never select an authority mode."）：
    // `allowOutside` 从"充分条件"降为**必要条件** —— 跨工作区写盘还要运维方在宿主环境里开
    // `DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES=1`（模型无法设置宿主环境变量）⇒ 参数不能再放大权限。
    const base = resolve(cwd ?? process.cwd())
    const abs = resolve(entry.path)
    const inside = abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep)
    if (!inside) {
        if (allowOutside !== true) {
            throw new Error(`拒绝写回工作区之外的文件：${abs}（调用方工作区是 ${base}）。确实要写就显式传 allowOutside: true`)
        }
        if (!outsideWritesAllowed()) throw outsideWritesRefusal(abs, base)
    }
    if (dryRun !== true) assertWritableTargets(guardCtx, [entry.path], { session: guardSession })
    let action = 'overwrite'
    try {
        if (!existsSync(entry.path)) action = 'create'
        else if (readFileSync(entry.path).equals(readFileSync(entry.blob))) action = 'unchanged'
    }
    catch { /* 保持 overwrite */ }
    if (dryRun || confirm !== true) return { dryRun: true, entry, action, outsideWorkspace: !inside, hint: 'pass confirm: true to actually write' }
    ensureDir(dirname(entry.path))
    copyFileSync(entry.blob, entry.path)
    return { dryRun: false, entry, action, wrote: 1, outsideWorkspace: !inside }
}

// --- 工具注册 ---------------------------------------------------------------

const textOutput = () => ({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
})


/** JSON Schema -> defineTool value-schema dialect ({ field: { type, required, ... } }). */
function toValueSchema(jsonSchema) {
    const out = {}
    const required = new Set(jsonSchema?.required ?? [])
    for (const [key, value] of Object.entries(jsonSchema?.properties ?? {})) {
        out[key] = { ...value }
        if (required.has(key)) out[key].required = true
    }
    return out
}

/** defineTool wrapper: keeps our readable JSON Schema, emits the dialect the host validates. */

export function tools(defineTool, options = {}) {
    const { resolveSessionFile = null, resolveWorkspaceCwd = null } = options
    // 默认工作区：优先**调用方会话**的 cwd（exec.agent.session.header.cwd，实测可用），
    // 其次"最新会话"，最后 process.cwd()（那是 profile 目录，多工作区下会选错）。
    const execCwd = (exec) => {
        try {
            const cwd = exec?.agent?.session?.header?.cwd
            return typeof cwd === 'string' && cwd !== '' ? cwd : null
        }
        catch { return null }
    }
    const defaultCwd = (exec) => {
        const fromExec = execCwd(exec)
        if (fromExec !== null) return fromExec
        try {
            const cwd = resolveWorkspaceCwd?.()
            if (typeof cwd === 'string' && cwd !== '') return cwd
        }
        catch { /* fall through */ }
        return process.cwd()
    }
    /** 用户显式给的 cwd：相对路径同样以调用方会话工作区为基准（与 table_diff 的路径解析一致） */
    const resolveUserCwd = (p, exec) => {
        if (typeof p !== 'string' || p === '') return p
        if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(p)) return p
        const bases = [execCwd(exec)]
        try { bases.push(resolveWorkspaceCwd?.() ?? null) } catch { /* ignore */ }
        for (const base of bases) {
            if (typeof base === 'string' && base !== '') {
                const cand = resolve(base, p)
                if (existsSync(cand)) return cand
            }
        }
        return p
    }
    const tool = (def) => defineTool({ ...def, parameters: toValueSchema(def.parameters) })
    const sessionOf = (cwd) => {
        try {
            const s = resolveSessionFile?.(cwd)
            return s ? { file: s.file, id: s.id } : { file: null, id: null }
        }
        catch { return { file: null, id: null } }
    }
 // ⚠️ 工具面收敛（7→1）：这七个定义**不再单独注册**，而是作为下面那个
    // `checkpoint`（action 驱动）的**内部实现** —— execute 与 render 全部原样复用，业务逻辑一行没改。
    const legacy = [
        ({
            name: 'checkpoint_create',
            description: 'Capture a manual checkpoint of the current workspace (tracked text files) + the current session log + small config files. Returns the checkpoint id used by checkpoint_diff / checkpoint_restore.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    note: { type: 'string', description: 'Short note describing why this checkpoint exists (max 500 chars).' },
                    cwd: { type: 'string', description: 'Workspace root to snapshot (default: the calling session workspace).' },
                    exclude: { type: 'array', items: { type: 'string' }, description: 'Extra exclude patterns: bare name = that segment anywhere; with "/" = path prefix; "*" globs allowed. The workspace-root .dsh-checkpoint-ignore is always read too.' },
                    presetExclude: { type: 'boolean', description: 'Also apply a preset ignore list for big workspaces (build/.gradle/node_modules/.git/run/*.log/*.jar/*.tmp). Default false. Big reference/data dirs you keep under your own names still need exclude or .dsh-checkpoint-ignore.' },
                    estimate: { type: 'boolean', description: 'Only ESTIMATE (walk + report files/bytes/copyable) without writing a snapshot. Use it first on a multi-GB workspace.' },
                    maxCopyBytes: { type: 'number', description: 'Files larger than this are recorded by hash only (default 1 MB). Those still diff correctly but CANNOT be restored.' },
                    maxCopyTotal: { type: 'number', description: 'Total copied bytes (default 50 MB); beyond it files are hash-only too.' },
                    maxFiles: { type: 'number', description: 'Cap on manifest entries (default 5000); the output warns when it truncates.' },
                },
            },
            output: textOutput(),
            async execute(args, exec) {
                assertWritableStorage(typeof options?.getCtx === 'function' ? options.getCtx() : null, exec?.agent?.session, '创建快照')
                const cwd = args?.cwd ? resolveUserCwd(args.cwd, exec) : defaultCwd(exec)
                const s = sessionOf(cwd)
                const rec = createCheckpoint({
                    cwd,
                    note: args?.note ?? '',
                    kind: 'manual',
                    sessionFile: s.file,
                    sessionId: s.id,
                    exclude: Array.isArray(args?.exclude) ? args.exclude : [],
                    presetExclude: args?.presetExclude === true,
                    estimate: args?.estimate === true,
                    ...(typeof args?.maxCopyBytes === 'number' ? { maxCopyBytes: args.maxCopyBytes } : {}),
                    ...(typeof args?.maxCopyTotal === 'number' ? { maxCopyTotal: args.maxCopyTotal } : {}),
                    ...(typeof args?.maxFiles === 'number' ? { maxFiles: args.maxFiles } : {}),
                })
 // `estimate: true`：只估算、不落盘（大工作区先看清规模 —— MCMOD 评审建议 4）
                if (rec.estimate !== undefined) {
                    const e = rec.estimate
                    const mb2 = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`
                    return [
                        'checkpoint estimate（**没有写任何快照**）',
                        `  workspace: ${e.cwd}`,
                        `  files=${e.files}  total=${mb2(e.bytes)}  可复制=${e.copyable} (${mb2(e.copyableBytes)})  只记哈希=${e.hashOnly}`,
                        `  排除模式: ${e.excludedPatterns.length === 0 ? '(无)' : `${e.excludedPatterns.slice(0, 12).join(', ')}${e.excludedPatterns.length > 12 ? ' …' : ''}`}`,
                        `  遍历耗时 ${e.ms} ms —— ${e.note}`,
                        '  要真建快照就去掉 estimate:true（大工作区可先加 presetExclude:true）',
                    ].join('\n')
                }
                const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`
                const size = (b) => (b >= 1024 * 1024 ? mb(b) : `${(b / 1024).toFixed(0)} KB`)
                const hd = rec.hashOnlyDetail ?? {}
                const hashBits = []
                if (hd.overPerFile) hashBits.push(`${hd.overPerFile} 超过单文件上限 ${size(rec.limits?.maxCopyBytes ?? 1048576)}`)
                if (hd.overBudget) hashBits.push(`${hd.overBudget} 超出复制预算`)
                if (hd.copyFailed) hashBits.push(`${hd.copyFailed} 复制失败`)
                const excludeLines = (rec.excludedDetail ?? []).map((d) => `    ${d.rel}${d.capped ? '+' : ''}  ${mb(d.bytes)}, ${d.files} files`)
                const keptLines = (rec.keptDirs ?? []).filter((d) => d.bytes > 1024 * 1024).map((d) => `${d.dir} (${mb(d.bytes)})`)
                return [
                    `checkpoint ${rec.id}`,
                    `  workspace: ${rec.files} files, ${mb(rec.bytes)}  (copied ${mb(rec.copiedBytes)}${rec.hashOnly ? `, ${rec.hashOnly} file(s) hash-only${hashBits.length ? `：${hashBits.join('，')}` : ''}` : ''})`,
                    `  excluded : ${rec.excluded}${excludeLines.length ? '' : (rec.excludePatterns?.length ? `  [${rec.excludePatterns.join(', ')}]` : '')}`,
                    ...excludeLines,
                    keptLines.length > 0 ? `  largest kept dirs: ${keptLines.join(', ')}  ← 想再省就加进 exclude 或 .dsh-checkpoint-ignore` : '',
                    rec.skipped ? `  ⚠ ${rec.skipped}` : '',
                    rec.copyBudgetHit ? `  ⚠ ${rec.copyBudgetHit}` : '',
                    rec.overCap ? `  ⚠ 另有 ${rec.overCap} 个文件（${mb(rec.overCapBytes)}）因总量上限（200 MB）未纳入清单 —— 提高 maxFiles/排除更多目录` : '',
                    rec.files === 0 ? `  ⚠ 清单是空的${rec.excluded > 0 ? `（${rec.excluded} 个条目全被排除模式挡掉）` : '（工作区里没有可纳入的文件）'} —— 这个快照回滚不了任何东西` : '',
                    `  session  : ${rec.session?.id ?? '(none)'} ${rec.session?.bytes ? mb(rec.session.bytes) : ''}`,
                    `  config   : ${rec.configs.length} file(s)`,
                    `  dir      : ${rec.dir}`,
                ].filter(Boolean).join('\n')
            },
        }),

        ({
            name: 'checkpoint_list',
            description: 'List checkpoints on disk (newest first) with how much each one actually occupies, plus the size of the automatic pre-image journal. NOTE: prune/keep work across ALL workspaces (the store is global) — use checkpoint_prune {drop:[…]} to delete one specific snapshot.',
            parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'number', description: 'Max rows (default 20).' } } },
            output: textOutput(),
            async execute(args) {
                const rows = listCheckpoints(args?.limit ?? 20)
                const j = listJournal({ limit: 5 })
                const mb = (b) => `${((b ?? 0) / 1024 / 1024).toFixed(1)} MB`
                const size = (b) => (b >= 1024 * 1024 ? mb(b) : `${((b ?? 0) / 1024).toFixed(0)} KB`)
                // **真实占用 = 快照目录的实际字节数**（审计 E-M6：以前只累加 copiedBytes，实测汇总 30 B
                // 而 store 实际 1,084,986 B —— 差在"只记哈希不复制"的文件与 config 留底上，这个数字误导人）
                const withStore = rows.map((r) => ({ ...r, storeBytes: dirBytes(join(ROOT, r.id)) }))
                const copiedTotal = withStore.reduce((s, r) => s + (r.copiedBytes ?? 0), 0)
                const storeTotal = dirBytes(ROOT)
                const head = [
                    `checkpoints: ${readIndex().length} in ${ROOT}  (store 实际占用 ${mb(storeTotal)}；其中快照复制内容 ${mb(copiedTotal)})`,
                    `journal (last pre-images): ${j.length ? j.map((e) => `${e.time.slice(11, 19)} ${e.path}`).join(' | ') : 'none'}`,
                ]
                if (rows.length === 0) return head.join('\n')
                // 带上体积：200 MB 那种快照要一眼看得出来（之前只能靠手测/看目录）
                return [...head, ...withStore.map((r) => `${r.id}  ${r.time.slice(0, 19).replace('T', ' ')}  ${r.kind}  ${r.files} files  ws ${mb(r.bytes)} / 占盘 ${size(r.storeBytes)} (copied ${size(r.copiedBytes)})  ${r.note || ''}`.trimEnd())].join('\n')
            },
        }),

        ({
            name: 'checkpoint_diff',
            description: 'Diff a checkpoint against the current workspace (or against another checkpoint): added / removed / changed file lists plus unified diffs of the first few changed text files.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', description: 'Checkpoint id or id prefix.' },
                    other: { type: 'string', description: 'Optional second checkpoint id to compare against instead of the live workspace.' },
                    cwd: { type: 'string', description: 'Workspace root for the live comparison (default: the checkpoint record cwd).' },
                    maxDiffs: { type: 'number', description: 'How many changed files get a unified diff (default 5).' },
                },
                required: ['id'],
            },
            output: textOutput(),
            async execute(args, exec) {
 // **对照树默认 = 快照记录里的 workspace**（MCMOD 宿主侧实测 P1：以前对照
                // "当前工作区"时这里硬塞了调用方会话工作区，把记录里的 cwd 覆盖掉 ⇒ 子目录做的快照会
                // 拿整个工作区去比，输出 `added=2960` 这种**看似正常、实则完全错**的数字）。
                const d = diffCheckpoint({ id: args.id, other: args.other ?? null, cwd: args?.cwd ? resolveUserCwd(args.cwd, exec) : null, maxDiffs: args?.maxDiffs ?? 5 })
                const out = [
                    `checkpoint ${d.id}${d.other ? ` vs ${d.other}` : ' vs current workspace'}`,
                    `added=${d.added.length} removed=${d.removed.length} changed=${d.changed.length}`,
                ]
                // 对照树与"本次会话工作区"不同时置顶说明（否则数字容易被当成"当前工作区的差异"）
                if (!d.other && d.cwd) {
                    const sessionCwd = defaultCwd(exec)
                    if (sessionCwd && resolve(sessionCwd) !== resolve(d.cwd)) {
                        out.splice(1, 0, `⚠ 对照树 = 快照记录的 \`${d.cwd}\`，**不是**本次会话工作区 \`${sessionCwd}\`；要对照当前工作区请显式传 cwd`)
                    }
                }
                if (d.warning) out.splice(1, 0, d.warning)
                // **配置留底不再只是占体积**（审计 E-L2）：加 configs:true 就比两份快照的配置（键顺序无关）
                if (args?.configs === true) {
                    const cfg = configDiffBetween(d.id, d.other ?? null)
                    if (cfg !== null) {
                        out.push('', '=== config（键顺序无关）===')
                        out.push(cfg.changed ? cfg.text : `配置无差异（对比了 ${cfg.compared} 份留底）`)
                    }
                }
                if (d.added.length) out.push('', '--- added ---', ...d.added.slice(0, 30).map((r) => `+ ${r}`))
                if (d.removed.length) out.push('', '--- removed ---', ...d.removed.slice(0, 30).map((r) => `- ${r}`))
                if (d.changed.length) out.push('', '--- changed ---', ...d.changed.slice(0, 30).map((r) => `~ ${r}`))
                for (const dd of d.diffs) out.push('', `=== ${dd.rel} ===`, dd.text)
                return out.join('\n')
            },
        }),

        ({
            name: 'checkpoint_restore',
            description: 'Restore workspace files from a checkpoint. ALWAYS previews first (dryRun default true); pass confirm: true to actually write. Files that exist now but not in the snapshot are only reported, unless pruneExtra is true.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', description: 'Checkpoint id or id prefix.' },
                    files: { type: 'array', items: { type: 'string' }, description: 'Limit the restore to these workspace-relative paths.' },
                    cwd: { type: 'string', description: 'Workspace root to restore into (default: the checkpoint record cwd).' },
                    dryRun: { type: 'boolean', description: 'Preview only (default true).' },
                    confirm: { type: 'boolean', description: 'Must be true to write files.' },
                    pruneExtra: { type: 'boolean', description: 'Also delete files that did not exist in the snapshot (default false). Refused when the target cwd differs from the checkpoint\'s own workspace.' },
                },
                required: ['id'],
            },
            output: textOutput(),
            async execute(args, exec) {
                const r = restoreCheckpoint({
                    id: args.id,
                    files: args?.files ?? null,
                    cwd: args?.cwd ? resolveUserCwd(args.cwd, exec) : null,
                    dryRun: args?.confirm === true ? false : args?.dryRun !== false,
                    confirm: args?.confirm === true,
                    pruneExtra: args?.pruneExtra === true,
                    guardCtx: typeof options?.getCtx === 'function' ? options.getCtx() : null,
                    guardSession: exec?.agent?.session ?? null,
                })
                const plan = r.plan.map((p) => `  ${p.action.padEnd(20)} ${p.rel}`)
                const lines = [
                    `checkpoint ${r.id} ${r.dryRun ? '(preview)' : `(wrote ${r.wrote} file(s)${r.pruned ? `, pruned ${r.pruned}` : ''})`}`,
                    r.warning ?? '',
                ]
 // **被外部改过的文件必须外显**：以前回滚会静默覆盖用户期间的修改（审计）
                if (r.modifiedCount > 0) {
                    lines.push(`⚠ 有 ${r.modifiedCount} 个文件在快照之后被改过，回滚会**覆盖这些改动**：${r.modifiedSince.join(', ')}${r.modifiedCount > r.modifiedSince.length ? ' …' : ''}`)
                }
                if (r.ignoredFromPrune > 0) {
                    lines.push(`（${r.ignoredFromPrune} 个文件按 .dsh-checkpoint-ignore / exclude 保护，**不会被 pruneExtra 删除**）`)
                }
                // **部分落盘必须外显**：预检失败 ⇒ 一个都没写；中途失败 ⇒ 已写 N 个并停下
                if (r.failed && r.failed.length > 0) {
                    lines.push(`⚠ 写入中途失败（已成功 ${r.wrote} 个）：${r.failed.join('; ')}`)
                }
                lines.push(
                    ...plan.slice(0, 60),
                    r.extraCount ? `\nfiles present now but absent in the snapshot: ${r.extraCount}${r.pruneExtra ? '' : ' (kept; pass pruneExtra: true to delete)'}` : '',
                    r.dryRun ? `\n${r.hint}` : (r.partial ? `\n${r.hint}` : ''),
                )
                return lines.filter(Boolean).join('\n')
            },
        }),

        ({
            name: 'checkpoint_journal',
            description: 'List the automatic pre-image journal (one entry per file that was about to be written/edited). Use checkpoint_journal_restore to roll a single file back to its pre-image.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sessionKey: { type: 'string', description: 'Journal bucket. Omit to search ALL buckets (recommended: captures are bucketed by DSH_SESSION_ID when the host sets it).' },
                    path: { type: 'string', description: 'Only entries for this file.' },
                    limit: { type: 'number', description: 'Max rows (default 30).' },
                },
            },
            output: textOutput(),
            async execute(args) {
                const rows = listJournal({ sessionKey: args?.sessionKey ?? null, limit: args?.limit ?? 30, path: args?.path ?? null })
                // **未留底的文件要点名**（审计 E-M3）：以前 >20 MB 静默跳过，用户以为"已经留底了"
                const skips = readJournalSkips(args?.sessionKey ?? null, args?.path ?? null)
                const skipNote = skips.length === 0
                    ? []
                    : ['', `⚠ 有 ${skips.length} 个文件**没有留底**（超过 ${JOURNAL_MAX_FILE_BYTES / 1048576} MB 上限），改动它们前请自行备份：`,
                        ...skips.slice(-10).map((s) => `  ${(s.size / 1048576).toFixed(1)} MB  ${s.time.slice(11, 19)}  ${s.path}`)]
                // 措辞要点名**为什么**没有：新建文件（本来就没有 pre-image）≠ 钩子没生效
 // （MCMOD 实测：原措辞让人误判钩子没装上）
                if (rows.length === 0) {
                    const p = args?.path ? `\`${args.path}\` ` : ''
                    return `${p}没有 pre-image —— 该文件是新建的（没有旧内容可留），或它没有经过宿主 fs 层（如外部程序写入）。钩子本身是生效的：` +
                        `用 write/edit 覆盖**已存在**的文件时会留下 tools/pre-execute:* 条目。${skipNote.join('\n')}`
                }
                return [...rows.map((e) => `${e.id}  ${e.time.slice(11, 19)}  ${(e.size / 1024).toFixed(1)} KB  ${e.trigger}  [${e.bucket}]  ${e.path}`), ...skipNote].join('\n')
            },
        }),

        ({
            name: 'checkpoint_journal_restore',
            description: 'Restore ONE file from its newest (or a given) journal pre-image. Previews first; pass confirm: true to write.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', description: 'Absolute path of the file to roll back.' },
                    id: { type: 'string', description: 'Journal entry id/prefix (default: newest for that path).' },
                    sessionKey: { type: 'string', description: 'Journal bucket. Omit to search ALL buckets (recommended).' },
                    dryRun: { type: 'boolean', description: 'Preview only (default true).' },
                    confirm: { type: 'boolean', description: 'Must be true to write.' },
                    cwd: { type: 'string', description: 'Workspace that the rollback is allowed to write inside (default: the calling session workspace).' },
                    allowOutside: { type: 'boolean', description: 'Confirm writing OUTSIDE the workspace (default false). Necessary but NOT sufficient: the operator must also set DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES=1 in the host environment (a tool argument can never widen authority).' },
                },
                required: ['path'],
            },
            output: textOutput(),
            async execute(args, exec) {
                const r = journalRestore({
                    path: args.path,
                    id: args?.id ?? null,
                    sessionKey: args?.sessionKey ?? null,
                    dryRun: args?.confirm === true ? false : args?.dryRun !== false,
                    confirm: args?.confirm === true,
 // ⚠️ 故障注入审计发现：这里以前**不转发 cwd** ⇒ journalRestore 的边界校验退化成
                    // `process.cwd()`（宿主自己的目录），于是**回滚会话工作区里的文件也会被"拒绝写回工作区之外"**。
                    // 现在默认用调用方会话工作区，显式 cwd 可覆盖。
                    cwd: typeof args?.cwd === 'string' && args.cwd !== '' ? resolveUserCwd(args.cwd, exec) : defaultCwd(exec),
                    allowOutside: args?.allowOutside === true,
                    guardCtx: typeof options?.getCtx === 'function' ? options.getCtx() : null,
                    guardSession: exec?.agent?.session ?? null,
                })
                const e = r.entry
                return [
                    `journal ${e.id}  ${e.trigger}  ${(e.size / 1024).toFixed(1)} KB  ${e.time.slice(0, 19).replace('T', ' ')}`,
                    `  file  : ${e.path}`,
                    `  action: ${r.action}${r.dryRun ? ' (preview — pass confirm: true to write)' : ' (done)'}`,
                ].join('\n')
            },
        }),

        ({
            name: 'checkpoint_prune',
            description: 'Keep only the newest N checkpoints and delete the rest; optionally delete specific ids via drop (useful when one snapshot is huge). Journal is capped automatically.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    keep: { type: 'number', description: 'How many to keep (default 20).' },
                    drop: { type: 'array', items: { type: 'string' }, description: 'Checkpoint ids (or id prefixes) to delete explicitly, regardless of keep.' },
                },
            },
            output: textOutput(),
            async execute(args) {
                const r = pruneCheckpoints(args?.keep ?? 20, Array.isArray(args?.drop) ? args.drop : [])
                if (r.removed.length === 0) return `nothing to prune (${r.kept} checkpoint(s))`
                const parts = [`removed ${r.removed.length}: ${r.removed.join(', ')}`, `kept ${r.kept}`]
                if (r.dropped?.length) parts.push(`dropped by id: ${r.dropped.join(', ')}`)
                return parts.join('\n')
            },
        }),
    ]

 // ── 合并成**一个** action 驱动的工具（工具面收敛 7→1）──────────────────────────
    // 为什么这样合：七个动词的参数面高度重叠（id/cwd/dryRun/confirm/limit…），分开注册等于把同一份
    // schema 抄七遍（实测 5,340 字符）。合并后模型只看到一个入口，仍然按 action 走同一套内部实现。
    // 代价与对策：分开时"给 list 传 id"是**不可能**的（参数不存在），合并后可能 ⇒ 这里逐 action 校验
    // 必填参数与"不该出现的参数"，把错误在做任何事**之前**就报清楚（原来靠宿主 schema 拦，现在靠这里拦）。
    const ACTION_OF = {
        create: 'checkpoint_create',
        list: 'checkpoint_list',
        diff: 'checkpoint_diff',
        restore: 'checkpoint_restore',
        journal: 'checkpoint_journal',
        journal_restore: 'checkpoint_journal_restore',
        prune: 'checkpoint_prune',
    }
    const PARAMS_OF = {
        create: ['note', 'cwd', 'exclude', 'presetExclude', 'estimate', 'maxFiles', 'maxCopyBytes', 'maxCopyTotal'],
        list: ['limit'],
        diff: ['id', 'other', 'cwd', 'maxDiffs'],
        restore: ['id', 'files', 'cwd', 'dryRun', 'confirm', 'pruneExtra'],
        journal: ['sessionKey', 'path', 'limit'],
        journal_restore: ['path', 'id', 'sessionKey', 'dryRun', 'confirm', 'cwd', 'allowOutside'],
        prune: ['keep', 'drop'],
    }
    const REQUIRED_OF = { diff: ['id'], restore: ['id'], journal_restore: ['path'] }
    const implOf = (action) => legacy.find((t) => t.name === ACTION_OF[action]) ?? null
    const merged = tool({
        name: 'checkpoint',
        description: [
            'Snapshot / inspect / roll back a workspace, plus the automatic pre-image journal. One tool: `action` picks the verb (default list).',
            'Verbs: `create` (snapshot; estimate:true only walks and reports), `list`, `diff` (a snapshot vs the live workspace, or two snapshots),',
            '`restore` (ALWAYS previews first — files stay untouched until confirm:true), `prune`, `journal` (automatic pre-images), `journal_restore` (roll ONE file back).',
            'Every parameter description is prefixed with the action it belongs to; parameters that do not belong to the chosen action are rejected, not ignored.',
        ].join(' '),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', enum: Object.keys(ACTION_OF), description: 'Which verb to run. Default: list (read-only).' },
                note: { type: 'string', description: 'create: short note describing why this checkpoint exists (max 500 chars).' },
                cwd: { type: 'string', description: 'create/restore/diff/journal_restore: workspace root (default: the calling session workspace).' },
                exclude: { type: 'array', items: { type: 'string' }, description: 'create: extra exclude patterns. A bare name matches that segment anywhere; one containing "/" is a path prefix; "*" globs work.' },
                presetExclude: { type: 'boolean', description: 'create: also apply the preset ignore list for big workspaces (build/.gradle/node_modules/.git/…).' },
                estimate: { type: 'boolean', description: 'create: only ESTIMATE (walk + report files/bytes/copyable) — writes nothing.' },
                maxFiles: { type: 'number', description: 'create: cap on manifest entries (default 5000); the output warns when it truncates.' },
                maxCopyBytes: { type: 'number', description: 'create: files larger than this are recorded by hash only (default 1 MB) — those diff correctly but CANNOT be restored.' },
                maxCopyTotal: { type: 'number', description: 'create: total copied bytes (default 50 MB); beyond it files are hash-only too.' },
                limit: { type: 'number', description: 'list: max rows (default 20). journal: max pre-images (default 30).' },
                id: { type: 'string', description: 'diff/restore: checkpoint id or id prefix (REQUIRED). journal_restore: optional pre-image id/prefix (default newest for that path).' },
                other: { type: 'string', description: 'diff: optional second snapshot id; omit to compare against the live workspace.' },
                maxDiffs: { type: 'number', description: 'diff: how many changed files get a unified diff (default 5).' },
                files: { type: 'array', items: { type: 'string' }, description: 'restore: limit the restore to these workspace-relative paths.' },
                dryRun: { type: 'boolean', description: 'restore/journal_restore: preview only (default true while confirm is not set).' },
                confirm: { type: 'boolean', description: 'restore/journal_restore: MUST be true to actually write files.' },
                pruneExtra: { type: 'boolean', description: 'restore: also delete files that did not exist in the snapshot (refused when the target workspace differs from the snapshot’s).' },
                path: { type: 'string', description: 'journal/journal_restore: filter by / roll back this absolute file path.' },
                sessionKey: { type: 'string', description: 'journal: journal bucket. Omit to search ALL buckets (recommended).' },
                allowOutside: { type: 'boolean', description: 'journal_restore: confirm writing OUTSIDE the workspace (default false). Also requires the operator switch DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES=1 — arguments cannot widen authority.' },
                drop: { type: 'array', items: { type: 'string' }, description: 'prune: checkpoint ids (or id prefixes) to delete explicitly.' },
                keep: { type: 'number', description: 'prune: keep only the newest N (default 20).' },
            },
        },
        output: {
            schema: { type: 'string' },
            // render 也委派给被选中的那个原工具 —— 它们的 render 各有细节（有的把数组拼行），必须保真
            render(args, value) {
                const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'list'
                const t = implOf(action)
                return t?.output?.render ? t.output.render(args, value) : [{ type: 'text', text: Array.isArray(value) ? value.join('\n') : String(value) }]
            },
        },
        async execute(args, exec) {
            const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'list'
            const target = implOf(action)
            if (target === null) throw new Error(`未知 action ${JSON.stringify(args?.action)}；可用：${Object.keys(ACTION_OF).join(' / ')}`)
            for (const key of REQUIRED_OF[action] ?? []) {
                if (args?.[key] === undefined || args[key] === null || args[key] === '') throw new Error(`action "${action}" 需要参数 ${key}（例如 { action: "${action}", ${key}: "…" }）`)
            }
            const allowed = new Set([...(PARAMS_OF[action] ?? []), 'action'])
            const strays = Object.keys(args ?? {}).filter((k) => !allowed.has(k))
            if (strays.length > 0) {
                throw new Error(`action "${action}" 不接受参数 ${strays.map((s) => JSON.stringify(s)).join(', ')}（该 action 可用：${(PARAMS_OF[action] ?? []).join(', ') || '无'}）`)
            }
            return await target.execute(args, exec)
        },
    })
    return [merged]
}

/** 注册工具 + 变更前留底钩子 + /checkpoint /rewind 命令（全部可选降级） */
export async function apply(ctx, { defineTool, resolveSessionFile = null, resolveWorkspaceCwd = null, mutationHook = true, beacon = () => {}, getCtx = null } = {}) {
    const list = tools(defineTool, { resolveSessionFile, resolveWorkspaceCwd, getCtx })
    for (const t of list) ctx.tools.register(t)
    beacon(`checkpoint: ${list.length} tools registered`)

    if (mutationHook) {
        const capture = (p, trigger) => {
            try {
                const e = capturePreImage(p, { trigger, sessionKey: process.env.DSH_SESSION_ID || 'default' })
                if (e) beacon(`journal captured ${trigger} ${p}`)
            }
            catch { /* 留底失败绝不影响写入 */ }
        }
        try {
            ctx.on('fs/write-intent', (target, _actor, next) => { if (typeof target === 'string') capture(target, 'fs/write-intent'); return next() }, { prepend: true })
            ctx.on('fs/edit-intent', (target, _actor, next) => { if (typeof target === 'string') capture(target, 'fs/edit-intent'); return next() }, { prepend: true })
            // 核心 write/edit 工具不会发 fs/*-intent（实测 journal 为空），必须再挂 tools/pre-execute，
            // 从参数里把要改的文件挑出来留底 —— 与上游 dsh-checkpoint-rewind 的做法一致。
            ctx.on('tools/pre-execute', (exec, next) => {
                try {
                    const name = String(exec?.name ?? exec?.toolName ?? '')
                    if (MUTATION_TOOLS.has(name)) {
                        const args = exec?.args ?? exec?.arguments ?? exec?.input ?? {}
                        for (const p of pathsInArgs(args)) capture(p, `tools/pre-execute:${name}`)
                    }
                }
                catch { /* 留底失败绝不影响工具执行 */ }
                return next()
            }, { prepend: true })
            beacon('checkpoint: fs mutation hooks installed')
        }
        catch (error) {
            beacon(`checkpoint: fs hooks unavailable (${error instanceof Error ? error.message : String(error)})`)
        }
    }

    // 命令是可选能力：优先用 ctx.inject 等 'commands' 服务就绪（cordis 惯用法，插件不会因服务缺席而 pending），
    // 服务已在场时直接注册；两条路都不通就只留信标。
    const registerCommands = (c) => {
        c.commands.register({
                name: 'checkpoint',
                description: 'Capture a manual checkpoint, list checkpoints, or diff two of them.',
                input: { hint: '[note <text> | list | diff <a> <b>]' },
                async handler(invocation) {
                    const raw = String(invocation?.input ?? invocation?.args ?? '').trim()
                    // 命令没有 tools 那样的 exec 上下文：从 invocation 里尽力找会话 cwd，找不到就用"最新会话工作区"
                    // （旧代码直接 process.cwd()，那是 **profile 目录** —— 多工作区时会快照错地方）
                    const cwd = (() => {
                        const guesses = [
                            invocation?.session?.header?.cwd,
                            invocation?.agent?.session?.header?.cwd,
                            invocation?.sessionCwd,
                            invocation?.cwd,
                            invocation?.context?.session?.header?.cwd,
                        ]
                        for (const g of guesses) if (typeof g === 'string' && g !== '') return g
                        try {
                            const w = resolveWorkspaceCwd?.()
                            if (typeof w === 'string' && w !== '') return w
                        }
                        catch { /* ignore */ }
                        return process.cwd()
                    })()
                    if (raw.startsWith('list') || raw === '') {
                        const rows = listCheckpoints(10)
                        return rows.length === 0 ? 'no checkpoints yet' : rows.map((r) => `${r.id}  ${r.time.slice(0, 19).replace('T', ' ')}  ${r.files} files  ${(r.bytes / 1024 / 1024).toFixed(1)} MB (copied ${((r.copiedBytes ?? 0) / 1024 / 1024).toFixed(1)} MB)  ${r.note}`).join('\n')
                    }
                    if (raw.startsWith('diff ')) {
                        const [, a, b] = raw.split(/\s+/)
                        const d = diffCheckpoint({ id: a, other: b ?? null, cwd: b ? null : cwd })
                        return `checkpoint ${d.id}${d.other ? ` vs ${d.other}` : ' vs current'}: added=${d.added.length} removed=${d.removed.length} changed=${d.changed.length}`
                    }
                    // 非法子命令**报错**而不是当备注：以前 `/checkpoint foo` 会静默建一个 note=foo 的快照
                    // （也会误建快照：用户以为打错了不会有副作用）。只有 `note <text>` 与自由文本被当备注。
                    const looksLikeCommand = /^[a-z-]+$/.test(raw) && !['list', 'note', 'diff'].includes(raw) && raw !== ''
                    if (looksLikeCommand) {
                        throw new Error(`未知子命令 "${raw}"；可用：/checkpoint（建快照）、/checkpoint note <文字>、/checkpoint list、/checkpoint diff <a> <b>`)
                    }
                    const note = raw.startsWith('note ') ? raw.slice(5) : raw
                    const s = (() => { try { return resolveSessionFile?.(cwd) } catch { return null } })()
                    const rec = createCheckpoint({ cwd, note, kind: 'manual', sessionFile: s?.file ?? null, sessionId: s?.id ?? null })
                    return `checkpoint ${rec.id}: ${rec.files} files, ${(rec.bytes / 1024 / 1024).toFixed(2)} MB${rec.session?.id ? `, session ${rec.session.id}` : ''}`
                },
            })
            c.commands.register({
                name: 'rewind',
                description: 'Preview or perform a rollback: rewind [preview] <id> | rewind latest | rewind <id> confirm',
                input: { hint: '[preview] <id-prefix | latest> [confirm]' },
                async handler(invocation) {
                    const raw = String(invocation?.input ?? invocation?.args ?? '').trim()
                    const parts = raw.split(/\s+/).filter(Boolean)
                    const preview = parts.includes('preview') || !parts.includes('confirm')
                    const idPart = parts.find((p) => p !== 'preview' && p !== 'confirm') ?? null
                    const rows = listCheckpoints(50)
                    // `latest` 只在**预览**时允许省略：`/rewind confirm`（不带 id）会直接按最新快照真写盘 ——
 // 用户看不到自己要回滚到哪一个（子代理审计）。要写盘就必须点名。
                    if (idPart === null && !preview) {
                        const top = rows.slice(0, 3).map((r) => `${r.id}  ${r.time.slice(0, 19).replace('T', ' ')}  ${r.note}`)
                        return `拒绝执行：\`/rewind confirm\` 必须指明要回滚到哪个快照（不带 id 会静默按最新快照写盘）。\n最近的快照：\n${top.join('\n') || '(无)'}\n用法：/rewind <id|latest> confirm`
                    }
                    const id = (idPart ?? 'latest') === 'latest' ? rows[0]?.id : idPart
                    if (!id) return 'no checkpoints yet'
                    const r = restoreCheckpoint({ id, dryRun: preview, confirm: parts.includes('confirm') })
                    const head = `rewind ${r.id} ${r.dryRun ? '(preview)' : `(wrote ${r.wrote})`}: ${r.plan.filter((p) => p.action !== 'unchanged').length} file(s) affected`
                    const warn = r.modifiedCount > 0 ? `\n⚠ 有 ${r.modifiedCount} 个文件在快照之后被改过，回滚会覆盖这些改动：${r.modifiedSince.slice(0, 5).join(', ')}` : ''
                    return [head + warn, ...r.plan.filter((p) => p.action !== 'unchanged').slice(0, 20).map((p) => `  ${p.action} ${p.rel}`)].join('\n')
                },
            })
        beacon('checkpoint: /checkpoint + /rewind commands registered')
    }
    try {
        if (typeof ctx.inject === 'function')
            ctx.inject(['commands'], (c) => { if (c.commands && typeof c.commands.register === 'function') registerCommands(c) })
        else {
            // 退路：读取未 inject 的服务属性本身会抛（cordis），必须包住。
            let c = null
            try { c = ctx.commands }
            catch { c = null }
            if (c && typeof c.register === 'function')
                registerCommands(ctx)
            else
                beacon('checkpoint: commands service absent - /checkpoint and /rewind not registered')
        }
    }
    catch (error) {
        beacon(`checkpoint: commands unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
    return list.length
}

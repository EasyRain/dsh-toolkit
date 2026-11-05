/**
 * 文档加载器：**按 mtime 失效**的缓存（`toolkit_help` 与 `ast_grep_help` 共用）。
 *
 * 为什么不是"读一次存一辈子"：这两个工具读的都是 `docs/TOOLKIT.md` 这种**纯数据**，
 * 而我们的工作方式就是"改文档 → 立刻再问一次工具"。
 * 旧实现（审计发现）在首次读入后**永不刷新**：
 *  - 改了文档，工具仍返回旧内容，直到重启宿主（很容易误以为"改没生效"）；
 *  - 首次读**失败**（docs 还没同步）也会被当成空文档缓存一辈子 —— 之后文件补上了也永远读不到。
 * 现在每次调用做一次 `statSync`：文件变化了就重读；"缺失"状态也会在文件出现后自动恢复。
 *
 * ⚠️ 只比 `mtimeMs` **不够**（实测踩到）：Windows 上"改完文档立刻再问工具"常常落在
 * 同一个毫秒刻度里 ⇒ 看起来 mtime 没变 ⇒ 不重读，等于修复失效。所以改用
 * **bigint 纳秒 mtime + size 双信号**（`statSync(u, {bigint:true})` 的 `mtimeNs`），
 * 同刻度写入靠 size 变化兜底，两个都没变就当没改。
 */
import { readFileSync, statSync } from 'node:fs'

const MISSING = 'missing'

/** 默认 stat：拿纳秒级 mtime + 字节数（老 Node 不支持 bigint 时回退 mtimeMs） */
function statStamp(url) {
    const st = statSync(url, { bigint: true })
    const m = st.mtimeNs !== undefined ? String(st.mtimeNs) : String(st.mtimeMs)
    return `${m}:${st.size}`
}

/**
 * @param {URL|string} url 文档路径
 * @param {{read?:Function, stat?:Function}} [io] 便于自测注入假 IO（stat 返回字符串戳或 Stats）
 */
export function createDocLoader(url, io = {}) {
    const read = io.read ?? ((u) => readFileSync(u, 'utf8'))
    const stat = io.stat ?? ((u) => statStamp(u))
    let text = ''
    let error = null
    let stamp = null // null = 还没读过；字符串 = 已缓存的指纹；'missing' = 上次读时文件不存在

    return {
        /** 取文档文本；读不到返回空串（调用方负责降级，不抛） */
        load() {
            let current = MISSING
            try {
                const s = stat(url)
                current = typeof s === 'string' ? s : `${s.mtimeNs ?? s.mtimeMs}:${s.size}`
            }
            catch { current = MISSING }
            if (stamp === current) return text // 指纹未变（含"仍然缺失"）：直接用缓存
            stamp = current
            try {
                text = read(url)
                error = null
            }
            catch (e) {
                text = ''
                error = e instanceof Error ? e.message : String(e)
            }
            return text
        },
        /** 最近一次读取失败的原因（成功时为 null） */
        error() { return error },
    }
}

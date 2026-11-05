/**
 * file —— 一个工具，八个动作：read / stat / write / edit / copy / move / remove / mkdir。
 *
 * 为什么收敛成一个：与 checkpoint（7 动作）、download（4 动作）同一思路 —— 文件操作是同一件事的不同动词，
 * 拆成 8 个工具只会让常驻 schema 变贵、还让模型在多工具之间犹豫。语义参考 dsh-ops 的
 * `ops_read_files` / `ops_inspect_local_file` / `ops_write_file` / `ops_edit_file` / `stat|copy|move|remove`
 * （MIT，`Copyright (c) 2026 T-Auto and the dsh-ops contributors`；出处见包根 `THIRD-PARTY-NOTICES.md`），
 * 实现为纯 JS（ops 的核心在 Rust worker 里，不能直接复用）。
 *
 * 与宿主自带 `read` / `write` 的差异（也就是这个工具存在的理由）：
 *  - **编码**：BOM / 严格 UTF-8 / GB18030 回退，并回报依据（宿主 read 假定 UTF-8，GBK 文本全是乱码）；
 *  - **多文件 + 多区间**：一次读完一个模块的 6 个语言文件；
 *  - **二进制**给 hex 预览而不是乱码；
 *  - **CAS**：`expectedRevision`（sha256 或 `absent`）+ 原子写，避免"读到旧内容再覆盖"。
 */
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { LIMITS, readOne, renderReport } from './read.js'
import { copyFileOp, editFileOp, mkdirOp, moveFileOp, removeFileOp, renderOpResult, statOp, writeFileOp } from './write.js'

export const ACTIONS = ['read', 'stat', 'write', 'edit', 'copy', 'move', 'remove', 'mkdir']

const ENCODINGS = ['auto', 'utf8', 'utf16le', 'utf16be', 'gb18030']

export function tools(defineTool, options = {}) {
    const workspace = typeof options.resolveWorkspaceCwd === 'function' ? options.resolveWorkspaceCwd : () => null
    const baseDir = () => {
        try {
            const cwd = workspace()
            if (typeof cwd === 'string' && cwd !== '') return cwd
        }
        catch { /* 拿不到就用进程 cwd */ }
        return process.cwd()
    }
    const absolute = (file) => (isAbsolute(file) ? file : resolvePath(baseDir(), file))

    return [
        defineTool({
            name: 'file',
            description:
                'File operations in one tool, selected by `action`: read (default) reads text with encoding detection ' +
                '(BOM / strict UTF-8 / strict GB18030 fallback), multiple files and line ranges, with a hex preview for binary files; ' +
                'every read returns the whole-file revision (sha256) plus complete/nextOffset for continuation and truncatedInLine for over-long lines; ' +
                'stat returns size/mtime/revision; write creates or replaces a whole file (UTF-8, optional BOM) with an optional ' +
                'CAS expectedRevision (sha256, or "absent" to create only); edit applies unique, non-overlapping oldText→newText hunks ' +
                'and preserves the original encoding and BOM; copy and move take a destination `to`; remove previews by default and ' +
                'needs confirm:true to delete (directories need recursive:true); mkdir creates directories. ' +
                'All writes are atomic (temp file + rename) and every write/edit returns the new revision for the next CAS. ' +
                'Bounded: 1 MB per file by default and 2 MB total per call, at most 20 files / 20 ranges / 4000 lines.',
            parameters: {
                action: { type: 'string', enum: ACTIONS, required: true, description: 'What to do: read (default) / stat / write / edit / copy / move / remove / mkdir.' },
                path: { type: 'string', description: 'Target file or directory (relative paths resolve against the session workspace).' },
                paths: { type: 'array', items: { type: 'string' }, description: 'Several files to read at once (max 20); read only.' },
                ranges: { type: 'array', items: { type: 'string' }, description: 'Line ranges for read, applied to every file: ["1-40","120"], 1-based and inclusive.' },
                encoding: { type: 'string', enum: ENCODINGS, description: 'read: auto (default) probes BOM → strict UTF-8 → strict GB18030; or force utf8 / utf16le / utf16be / gb18030.' },
                maxBytes: { type: 'integer', description: `read: bytes per file before truncating (default ${LIMITS.maxBytes}, max ${LIMITS.hardMaxBytes}).` },
                content: { type: 'string', description: 'write: the entire new file content (UTF-8).' },
                bom: { type: 'boolean', description: 'write: prepend a UTF-8 BOM.' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            oldText: { type: 'string', required: true, description: 'Exact text to find; must occur exactly once.' },
                            newText: { type: 'string', required: true, description: 'Replacement text (may be empty to delete).' },
                        },
                        required: ['oldText', 'newText'],
                    },
                    description: 'edit: list of {oldText,newText}; each must be unique and must not overlap.',
                },
                expectedRevision: { type: 'string', description: 'write/edit: CAS token — the sha256 returned by a previous call, or "absent" to require a new file.' },
                to: { type: 'string', description: 'copy/move: destination path (same workspace base as path).' },
                overwrite: { type: 'boolean', description: 'copy/move: allow replacing an existing destination (default false).' },
                recursive: { type: 'boolean', description: 'remove: allow deleting a directory tree; mkdir: create parents (default true).' },
                confirm: { type: 'boolean', description: 'remove: actually delete; without it remove only reports what would be deleted.' },
                createParents: { type: 'boolean', description: 'write/copy/move: create missing parent directories (default true).' },
            },
            output: {
                schema: { type: 'string', description: 'read: per-file blocks with encoding/size/lines and numbered lines. Other actions: one line with action/ok/path/bytes/revision, plus a message on failure.' },
                render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            async execute(args) {
                const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'read'
                if (!ACTIONS.includes(action)) throw new Error(`未知 action：${JSON.stringify(action)}；可用：${ACTIONS.join(', ')}`)
                const rawPath = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : null

                if (action === 'read') {
                    const many = Array.isArray(args?.paths) ? args.paths.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : []
                    const files = many.length > 0 ? many : (rawPath === null ? [] : [rawPath])
                    if (files.length === 0) throw new Error('read 要给 path 或 paths')
                    if (files.length > LIMITS.maxFiles) throw new Error(`一次最多读 ${LIMITS.maxFiles} 个文件（给了 ${files.length}）；请分批`)
                    const ranges = Array.isArray(args?.ranges) && args.ranges.length > 0 ? args.ranges : null
                    if (ranges !== null && ranges.length > LIMITS.maxRanges) throw new Error(`ranges 最多 ${LIMITS.maxRanges} 段（给了 ${ranges.length}）`)
                    // 多文件共享一份总预算：否则 20 个 1 MB 文件足以把上下文撑爆。
                    const requested = Math.min(Math.max(256, Number(args?.maxBytes) || LIMITS.maxBytes), LIMITS.hardMaxBytes)
                    let remaining = LIMITS.totalBytes
                    const results = files.map((file) => {
                        const target = absolute(file)
                        if (remaining <= 256) return { ok: false, path: target, error: `输出预算（${LIMITS.totalBytes} B）已用尽；分批读，或用更小的 maxBytes` }
                        const result = readOne(target, { ranges, encoding: args?.encoding, maxBytes: Math.min(requested, remaining) })
                        if (result.ok === true && result.stat) remaining -= Math.min(result.stat.size, requested)
                        return result
                    })
                    return renderReport(results, { maxBytes: requested })
                }

                if (rawPath === null) throw new Error(`${action} 要给 path`)
                const path = absolute(rawPath)
                const to = typeof args?.to === 'string' && args.to.trim() !== '' ? absolute(args.to.trim()) : null

                switch (action) {
                    case 'stat':
                        return renderOpResult(statOp({ path }))
                    case 'write':
                        if (args?.content === undefined) throw new Error('write 要给 content（整文件内容）')
                        return renderOpResult(writeFileOp({ path, content: args.content, expectedRevision: args?.expectedRevision, bom: args?.bom === true, createParents: args?.createParents !== false }))
                    case 'edit':
                        return renderOpResult(editFileOp({ path, edits: args?.edits, expectedRevision: args?.expectedRevision }))
                    case 'copy':
                        return renderOpResult(copyFileOp({ path, to, overwrite: args?.overwrite === true, createParents: args?.createParents !== false }))
                    case 'move':
                        return renderOpResult(moveFileOp({ path, to, overwrite: args?.overwrite === true, createParents: args?.createParents !== false }))
                    case 'remove':
                        return renderOpResult(removeFileOp({ path, recursive: args?.recursive === true, confirm: args?.confirm === true }))
                    case 'mkdir':
                        return renderOpResult(mkdirOp({ path, recursive: args?.recursive !== false }))
                    default:
                        throw new Error(`未知 action：${action}`)
                }
            },
        }),
    ]
}

export function apply(ctx, defineTool, options = {}) {
    const list = tools(defineTool, options)
    for (const tool of list) ctx.tools.register(tool)
    return list.length
}

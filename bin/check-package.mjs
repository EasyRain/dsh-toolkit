#!/usr/bin/env node
/**
 * check-package —— 校验「可发布面」的**声明与磁盘一致**（CI 门 + 本地巡检）。
 *
 * 每一条都对应我们真踩过的坑（插件卡片连错三轮）：
 *   · `exports` 没导出卡片素材 ⇒ 文件在、也同步了，却 `ERR_PACKAGE_PATH_NOT_EXPORTED` ✗
 *   · `locale/*.json` 结构写成扁平 ⇒ 卡片只能回退显示包名 ✗（真实形状是嵌套 `meta.{title,description}`）
 *   · `THIRD-PARTY-NOTICES.md` / `LICENSE` 从没进同步面 ⇒ 安装副本缺发布必需文件 ✗
 *   · `cordis.patch.yml` 的 `id` 与入口 `export const name` 不一致 ⇒ 用户按 id 覆盖 config 静默失效 ✗
 *
 * 用法：node bin/check-package.mjs          （退出码 1 = 有 FAIL）
 * 纯 Node 内置模块、零依赖；不写任何文件。
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => relative(ROOT, p).split(sep).join('/')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const exists = (p) => existsSync(join(ROOT, p))

// ── package.json ────────────────────────────────────────────────────────────
let pkg = null
try { pkg = JSON.parse(read('package.json')) }
catch (error) { check('package.json 可解析', false, error.message) }
if (pkg) {
    check('package.json 可解析', true)
    for (const field of ['name', 'version', 'type', 'exports', 'main', 'license', 'icon']) {
        check(`字段 ${field} 存在`, pkg[field] !== undefined, String(pkg[field] ?? ''))
    }
    check('type 是 module（cordis ESM-first）', pkg.type === 'module')
    check('engines.node 已声明', Boolean(pkg.engines?.node), pkg.engines?.node)
    check('dsh.bundle.patch 已声明', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh?.bundle?.patch)
    check('keywords 含生态约定项 dsh-plugin', (pkg.keywords ?? []).includes('dsh-plugin'))
    check('meta 或 locale 提供卡片标题', Boolean(pkg.meta?.title) || exists('locale/zh.json'))

    // main / exports 目标必须真在磁盘上（exports 是"文件在却读不到"的经典现场）
    if (typeof pkg.main === 'string') check(`main 目标存在（${pkg.main}）`, exists(pkg.main))
    const exportTargets = []
    const walkExports = (v) => {
        if (typeof v === 'string') exportTargets.push(v)
        else if (v && typeof v === 'object') for (const x of Object.values(v)) walkExports(x)
    }
    walkExports(pkg.exports)
    for (const target of exportTargets) {
        if (target.includes('*')) {
            const dir = target.slice(0, target.indexOf('*')).replace(/\/$/, '')
            const any = exists(dir) && readdirSync(join(ROOT, dir)).length > 0
            check(`exports 通配目标有文件（${target}）`, any, dir)
        }
        else check(`exports 目标存在（${target}）`, exists(target))
    }
    // 卡片素材必须**可从包外解析**（我们的坑：只导出 "." ⇒ 卡片读不到 locale/icon）
    for (const need of ['./locale/*.json', './package.json']) {
        const hit = exportTargets.some((t) => t === need)
        check(`exports 导出卡片素材 ${need}`, hit, exportTargets.join(' '))
    }

    // files 清单里的东西都要在
    for (const entry of pkg.files ?? []) {
        check(`files 条目存在（${entry}）`, exists(entry.replace(/\/$/, '')))
    }

    // 图标：存在、体积、扩展名
    if (typeof pkg.icon === 'string') {
        const ok = exists(pkg.icon)
        check(`icon 文件存在（${pkg.icon}）`, ok)
        if (ok) {
            const size = statSync(join(ROOT, pkg.icon)).size
            check('icon ≤ 256 KiB', size <= 256 * 1024, `${size} B`)
            check('icon 是 SVG/PNG/JPEG/WebP', /\.(svg|png|jpe?g|webp)$/i.test(pkg.icon), pkg.icon)
        }
    }

    // ── bundle patch：id 必须等于入口 export const name（否则按 id 覆盖 config 静默失效）
    const patchPath = pkg.dsh?.bundle?.patch
    if (typeof patchPath === 'string' && exists(patchPath)) {
        const yaml = read(patchPath)
        let YAMLmod = null
        try { YAMLmod = (await import('yaml')).default } catch { YAMLmod = null }
        if (YAMLmod === null) check('patch YAML 可解析（跳过：本环境没有 yaml 模块，如源码树）', true, 'skipped')
        else {
            try { YAMLmod.parse(yaml); check('patch YAML 可解析', true) }
            catch (error) { check('patch YAML 可解析', false, String(error.message).split('\n')[0]) }
        }
        const ids = [...yaml.matchAll(/^\s*-\s*id:\s*([^\s#]+)/gm)].map((m) => m[1])
        const names = [...yaml.matchAll(/^\s*name:\s*([^\s#]+)/gm)].map((m) => m[1])
        check('patch 至少有一个 insert 行', ids.length > 0, ids.join(','))
        const entryFile = typeof pkg.main === 'string' && exists(pkg.main) ? pkg.main : null
        if (entryFile) {
            const src = read(entryFile)
            const m = src.match(/export const name\s*=\s*['"]([^'"]+)['"]/)
            const pluginName = m ? m[1] : null
            check('入口导出了 export const name', pluginName !== null, String(pluginName))
            if (pluginName !== null && ids.length === 1) {
                check(`patch 的 id 与入口 name 一致（${pluginName}）`, ids[0] === pluginName, `id=${ids[0]}`)
            }
        }
        check('patch 行的 name 与包名一致或指向子路径导出', names.every((n) => n === pkg.name || n.startsWith(`${pkg.name}/`)), names.join(','))
    }

    // ── 同步面覆盖：发布/卡片要用的文件都必须在 bin/install-toolkit.mjs 的清单里
    try {
        const cli = read('bin/install-toolkit.mjs')
        const dirs = (cli.match(/const DIRS = \[([^\]]*)\]/) ?? [])[1] ?? ''
        const files = (cli.match(/const FILES = \[([^\]]*)\]/) ?? [])[1] ?? ''
        const covered = (entry) => {
            const clean = entry.replace(/\/$/, '')
            return dirs.includes(`'${clean}'`) || files.includes(`'${clean}'`)
        }
        for (const entry of pkg.files ?? []) {
            check(`同步面覆盖 files 条目（${entry}）`, covered(entry), `DIRS=[${dirs}] FILES=[${files}]`)
        }
        for (const need of [patchPath, pkg.icon].filter((x) => typeof x === 'string')) {
            check(`同步面覆盖 ${need}`, covered(need.replace(/^\.\//, '')))
        }
    }
    catch (error) { check('bin/install-toolkit.mjs 可读（同步面可核对）', false, error.message) }

    // ── 发布面不得带开发日期（口径：时间线只留在 CHANGELOG 与维护者工作区的 LOG 里）
 // 读者不需要按日期追历史；"（修）""…起新增""基线重冻说明（日期）"这类一律不写。
    try {
        const dated = []
        const scan = [
            ['README.md', read('README.md')],
            ['README.zh-CN.md', read('README.zh-CN.md')],
            ['package.json', read('package.json')],
            [patchPath, read(patchPath.replace(/^\.\//, ''))],
            ...(exists('docs') ? readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => [`docs/${f}`, read(`docs/${f}`)]) : []),
        ]
        for (const [name, text] of scan) {
            for (const m of String(text).matchAll(/20\d\d-\d\d-\d\d/g)) {
                dated.push(`${name}: …${String(text).slice(Math.max(0, m.index - 20), m.index + 24).replace(/\s+/g, ' ')}…`)
            }
        }
        check('发布文档/元数据里没有开发日期（时间线只留 CHANGELOG）', dated.length === 0, dated.slice(0, 3).join(' | ') || '0 处')

        // 源码注释同样不记时间；但**引号里的日期是数据**（如 `const BUILD = '2026-10-17T…'` 版本戳），一律放过
        const walkSource = (dir) => {
            const out = []
            for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
                const rel = `${dir}/${entry.name}`
                if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...walkSource(rel)) }
                else if (/\.(js|mjs)$/.test(entry.name)) out.push(rel)
            }
            return out
        }
        const sourceDated = []
        for (const rel of ['lib', 'bin', 'scripts'].flatMap((dir) => (exists(dir) ? walkSource(dir) : []))) {
            const text = read(rel)
            for (const m of text.matchAll(/20\d\d-\d\d-\d\d/g)) {
                const i = m.index
                if (i > 0 && /['"`]/.test(text[i - 1])) continue
                sourceDated.push(`${rel}: …${text.slice(Math.max(0, i - 16), i + 18).replace(/\s+/g, ' ')}…`)
            }
        }
        check('源码注释里没有开发日期（引号内的日期=数据，放过）', sourceDated.length === 0, sourceDated.slice(0, 3).join(' | ') || '0 处')
    }
    catch (error) { check('发布面日期扫描可执行', false, error.message) }

    // ── locale：必须是嵌套 meta.{title,description}（扁平结构卡片读不到）
    if (exists('locale')) {
        for (const f of readdirSync(join(ROOT, 'locale')).filter((x) => x.endsWith('.json'))) {
            try {
                const j = JSON.parse(read(`locale/${f}`))
                check(`locale/${f} 有 meta.title`, typeof j.meta?.title === 'string', String(j.meta?.title ?? '').slice(0, 30))
                check(`locale/${f} 有 meta.description`, typeof j.meta?.description === 'string', String(j.meta?.description ?? '').slice(0, 40))
            }
            catch (error) { check(`locale/${f} 可解析`, false, error.message) }
        }
        const langs = readdirSync(join(ROOT, 'locale'))
        check('同时提供 zh 与 en', langs.includes('zh.json') && langs.includes('en.json'), langs.join(','))
    }
}

const failed = results.filter((r) => !r.ok)
for (const r of results) {
    if (!r.ok) console.log(`  FAIL  ${r.name}${r.detail ? `  ${r.detail}` : ''}`)
}
console.log(`  ---- check-package: ${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 项失败` : '（声明与磁盘一致）'}`)
process.exit(failed.length === 0 ? 0 : 1)

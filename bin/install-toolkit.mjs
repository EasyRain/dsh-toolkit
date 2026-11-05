#!/usr/bin/env node
/**
 * install-toolkit —— 把本插件的源码同步进 profile 的安装副本，并**逐文件哈希校验**。
 *
 * 为什么需要它（AGENTS.md 铁律 #8）：`pnpm add/install file:…` **不会**刷新
 * `profiles/<名>/node_modules/<包>` 里的拷贝（lockfile 条目没变就不动），只能手抄；
 * 手抄漏一个文件/抄到旧版本，就会表现成"改了没生效"——实测过（源 10:01:59 / 副本 10:00:34）。
 *
 * 用法：
 *   node bin/install-toolkit.mjs                     # 同步所有已存在的 profile 副本，然后校验
 *   node bin/install-toolkit.mjs --verify            # 只校验，不写任何文件（巡检/CI 用）
 *   node bin/install-toolkit.mjs --profiles <name>[,<name>…]   # 只同步指定 profile（缺省=所有已存在的副本）
 *   node bin/install-toolkit.mjs --source <另一个检出目录>
 *   node bin/install-toolkit.mjs --prune-extras      # 顺带删掉副本里"源码已不存在"的文件（见下）
 *
 * 护栏：拷贝**之前**先对 `lib/` 与 `scripts/` 下每个 `.js` 跑 `node --check`，任何一个
 * 解析不过就拒绝同步（有过"语法坏文件被抄进两个副本 ⇒ 宿主启动后所有工具消失"的事故）。
 * 反向检查：副本里多出来的文件（源码已删除）会被列出并计为差异；`--prune-extras` 才会真的删。
 *
 * 退出码：0 = 一致（或已同步成功）；1 = 语法闸门拦住 / 校验发现差异（含副本多出文件）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE = join(HERE, '..')

/** 同步面：目录 + 单文件。刻意**不含** `.git`、`node_modules`、临时探针。 */
const DIRS = ['lib', 'test', 'docs', 'scripts', 'locale']
const FILES = ['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'THIRD-PARTY-NOTICES.md', 'LICENSE']

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const source = value('--source') ?? DEFAULT_SOURCE
const verifyOnly = flag('--verify')
const pruneExtras = flag('--prune-extras')
const only = (value('--profiles') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const listFiles = (root, rel = '') => {
    const abs = join(root, rel)
    if (!existsSync(abs)) return []
    const out = []
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) out.push(...listFiles(root, child))
        else if (entry.isFile()) out.push(child)
    }
    return out
}

// 源清单（相对路径 → 绝对路径）
const manifest = new Map()
for (const file of FILES) if (existsSync(join(source, file))) manifest.set(file, join(source, file))
for (const dir of DIRS) for (const rel of listFiles(source, dir)) manifest.set(rel, join(source, rel))
if (manifest.size === 0) {
    console.error(`x 源目录里没找到任何可同步的文件：${source}`)
    process.exit(1)
}

// 目标副本：显式给定，或扫描 profile 下已存在的安装副本
const profilesRoot = join(homedir(), '.dsh', 'profiles')
const targets = []
if (only.length > 0) {
    for (const name of only) targets.push({ name, dir: join(profilesRoot, name, 'node_modules', 'dsh-toolkit') })
}
else {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = join(profilesRoot, entry.name, 'node_modules', 'dsh-toolkit')
        if (existsSync(join(dir, 'package.json'))) targets.push({ name: entry.name, dir })
    }
}

// 源自身要合法（顺带护栏：package.json 必须能解析）
try { JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) }
catch (error) { console.error(`x 源 package.json 不能解析：${error.message}`); process.exit(1) }

// --- 语法闸门（必须在**拷贝之前**跑）-------------------------------------------
// 事故：一个语法坏掉的文件被抄进了两个安装副本，而 `lib/index.js` 是宿主
// **静态 import** 的 ⇒ 宿主一启动整段（甚至整个插件）就没了。旧流程是"先抄再检查"，
// 所以这里改成：先把要同步的 `.js` 全部 `node --check` 一遍，任何一个不过就**拒绝同步**。
const SYNTAX_ROOTS = ['lib', 'scripts']
const parseFailures = []
for (const [rel, abs] of manifest) {
    if (!rel.endsWith('.js')) continue
    if (!SYNTAX_ROOTS.some((root) => rel.startsWith(`${root}/`))) continue
    const result = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
    if (result.status !== 0) {
        const first = String(result.stderr ?? result.error?.message ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? 'parse failed'
        parseFailures.push(`${rel}  ->  ${first}`)
    }
}
if (parseFailures.length > 0) {
    console.error(`x 语法闸门拦住：${parseFailures.length} 个文件解析不过，**一个文件都没同步**（铁律 #8 的护栏）`)
    for (const line of parseFailures) console.error(`    ${line}`)
    process.exit(1)
}
console.log(`语法闸门：${SYNTAX_ROOTS.join('/')} 下的 .js 全部通过 node --check`)

if (targets.length === 0) {
    console.error(`x 没找到任何安装副本（在 ${profilesRoot} 下扫描 */node_modules/dsh-toolkit）`)
    process.exit(1)
}

let drift = 0
const rows = []
for (const target of targets) {
    if (!existsSync(join(target.dir, 'package.json'))) {
        rows.push({ profile: target.name, state: '副本不存在', copied: 0, same: 0, missing: 0, extras: 0 })
        continue
    }
    let copied = 0; let same = 0; let missing = 0
    for (const [rel, abs] of manifest) {
        const dst = join(target.dir, rel)
        if (existsSync(dst) && sha(dst) === sha(abs)) { same += 1; continue }
        missing += 1
        if (verifyOnly) continue
        mkdirSync(dirname(dst), { recursive: true })
        // ⚠️ **原子替换**（铁律 #5）：先写同目录临时名再 rename。宿主的热重载随时可能读到这些文件，
        // 直接 `copyFileSync` 覆盖会让它读到"半个文件"或"半新半旧的树" —— 信标里那些
        // `apply FAILED: Cannot find package …` 就是这么来的（每次同步会触发一连串 volatile refresh）。
        const tmp = `${dst}.tmp${process.pid}`
        try {
            copyFileSync(abs, tmp)
            renameSync(tmp, dst)
        }
        catch (error) {
            try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
            throw error
        }
        copied += 1
    }
    // 反向检查：副本里"源码已经没有"的文件（旧流程只比清单内的文件 ⇒ 源码删掉的文件会永远留在副本里，
 // 发布面一变小，副本就还是旧的。把一份维护者笔记移出发布面时暴露了这个盲点）。
    const extras = []
    for (const dir of DIRS) for (const rel of listFiles(target.dir, dir)) if (!manifest.has(rel)) extras.push(rel)
    for (const entry of readdirSync(target.dir, { withFileTypes: true })) {
        if (entry.isFile() && !manifest.has(entry.name)) extras.push(entry.name)
    }
    if (extras.length > 0 && pruneExtras && !verifyOnly) {
        for (const rel of extras) rmSync(join(target.dir, rel), { force: true })
    }
    if (missing > 0 || (extras.length > 0 && !(pruneExtras && !verifyOnly))) drift += 1
    rows.push({ profile: target.name, state: verifyOnly ? (missing === 0 && extras.length === 0 ? '一致' : '有差异') : (missing === 0 && extras.length === 0 ? '已一致' : '已同步'), copied, same, missing, extras: extras.length, extraSample: extras.slice(0, 2) })
}

const width = Math.max(7, ...rows.map((r) => r.profile.length))
console.log(`源：${source}`)
console.log(`同步面：${manifest.size} 个文件（${DIRS.join('/')} + ${FILES.length} 个单文件）`)
console.log(`${'profile'.padEnd(width)}  状态      相同  差异  本次复制  副本多出`)
for (const r of rows) {
    console.log(`${r.profile.padEnd(width)}  ${r.state.padEnd(8)} ${String(r.same).padStart(5)} ${String(r.missing).padStart(5)} ${String(r.copied).padStart(9)} ${String(r.extras).padStart(9)}`)
}
const extraRows = rows.filter((r) => r.extras > 0)
const pruned = pruneExtras && !verifyOnly
if (extraRows.length > 0) {
    console.log(pruned
        ? '\n✓ 已删除副本里"源码已不存在"的文件：'
        : '\n! 副本里有源码已经不存在的文件（源码删文件后没有反向清理）：')
    for (const r of extraRows) console.log(`    ${r.profile}: ${r.extras} 个（例：${r.extraSample.join(', ')}）`)
    if (!pruned) console.log('  要删掉它们就加 --prune-extras 重跑（只删同步面目录/根下的多余文件）。')
}
if (verifyOnly && drift > 0) {
    console.log('\nx 有副本落后于源码 => 改完源码必须同步（铁律 #8）。去掉 --verify 重跑即可同步。')
    process.exit(1)
}
if (!verifyOnly && drift > 0) console.log('\n✓ 已同步。源码改动要在宿主里**关再开**（或重启）才生效（作者资料 SKILL.md:221）。')
else if (!verifyOnly) console.log('\n✓ 全部一致，无需改动。')

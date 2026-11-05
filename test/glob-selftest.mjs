/**
 * glob 收集与 gitignore 子集自测（零依赖，不需要宿主、不需要 @ast-grep/napi）：
 *   node test/glob-selftest.mjs
 *
 * 覆盖 审计改动：
 *  - `maxFiles` **只统计匹配模式的文件**（回归：目录里 200 个 .js + maxFiles=200 时 `*.ts` 一个都收不到）；
 *  - `.gitignore` **逐目录作用域**（子目录里的 .gitignore 现在生效，模式相对它自己的目录）；
 *  - glob 语法：`**`、`*`、`?`、`{a,b}`、`[...]`、绝对路径、`node_modules` 规则、隐藏文件、目录不存在。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { collectFiles, globToRegex, hasGlobMagic, compileIgnorePattern, isIgnored } from '../lib/glob.js'

let failures = 0
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`) }

const ROOT = join(process.cwd(), '_glob-selftest-tmp')
const write = (rel, text = 'x') => {
    const abs = join(ROOT, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
}
const rels = (files) => files.map((f) => relative(ROOT, f).replace(/\\/g, '/')).sort()
const collect = (paths, opts = {}) => collectFiles(paths, { cwd: ROOT, maxFiles: 500, ...opts })

console.log('== 1. glob → 正则 ==')
ok('globToRegex 的 **/*.ts 命中两层与一层', globToRegex('src/**/*.ts').test('src/a/b.ts') && globToRegex('src/**/*.ts').test('src/b.ts'))
ok('* 不跨目录', !globToRegex('src/*.ts').test('src/a/b.ts'))
ok('? 匹配单字符', globToRegex('a?.ts').test('ab.ts') && !globToRegex('a?.ts').test('a.ts'))
ok('{a,b} 展开', globToRegex('*.{ts,js}').test('x.js') && globToRegex('*.{ts,js}').test('x.ts') && !globToRegex('*.{ts,js}').test('x.py'))
ok('[abc] 字符类', globToRegex('a[bc].ts').test('ab.ts') && !globToRegex('a[bc].ts').test('ad.ts'))
ok('hasGlobMagic 判定', hasGlobMagic('a/*.ts') && hasGlobMagic('a/{x,y}') && !hasGlobMagic('a/b.ts'))

console.log('== 2. gitignore 规则编译 ==')
{
    const p = (line) => compileIgnorePattern(line)
    ok('注释与空行忽略', p('# x') === null && p('   ') === null)
    ok('裸名字匹配任意层级', isIgnored([{ base: '/w', rules: [p('node_modules')] }], '/w/a/node_modules/x.js'))
    ok('不以 / 开头也能命中末段', isIgnored([{ base: '/w', rules: [p('*.log')] }], '/w/deep/a.log'))
    ok('含 / 的模式锚定', isIgnored([{ base: '/w', rules: [p('/dist')] }], '/w/dist/x.js') && !isIgnored([{ base: '/w', rules: [p('/dist')] }], '/w/a/dist/x.js'))
    ok('结尾 / 只匹配目录', isIgnored([{ base: '/w', rules: [p('build/')] }], '/w/build', true) && !isIgnored([{ base: '/w', rules: [p('build/')] }], '/w/build', false))
    ok('! 取反后匹配者胜', !isIgnored([{ base: '/w', rules: [p('*.log'), p('!keep.log')] }], '/w/keep.log') && isIgnored([{ base: '/w', rules: [p('*.log'), p('!keep.log')] }], '/w/other.log'))
    ok('跨树路径不判定', !isIgnored([{ base: '/w/sub', rules: [p('*.log')] }], '/w/other/a.log'))
    ok('多作用域叠加（子目录自己的规则）', isIgnored([{ base: '/w', rules: [p('*.tmp')] }, { base: '/w/src', rules: [p('gen')] }], '/w/src/gen/a.ts'))
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

console.log('== 3. 目录收集与跳过规则 ==')
write('src/a.ts')
write('src/readme.md')
write('src/deep/b.ts')
write('src/.hidden.ts')
write('.git/config')
write('node_modules/pkg/index.ts')
write('dist/out.ts')
write('.gitignore', 'dist\n*.log\n')
write('src/.gitignore', 'gen\n')
write('src/gen/skipped.ts')
write('src/keep.log')
{
    const r = await collect(['.'])
    const got = rels(r.files)
    ok('包含隐藏文件', got.includes('src/.hidden.ts'))
    ok('跳过 .git', !got.some((f) => f.startsWith('.git/')))
    ok('跳过 node_modules', !got.some((f) => f.includes('node_modules')))
    ok('根 .gitignore 生效（dist 被排除）', !got.some((f) => f.startsWith('dist/')))
    ok('**.log 被排除但保留其它', !got.some((f) => f.endsWith('.log')) && got.includes('src/a.ts'))
    ok('**子目录里的 .gitignore 生效**（src/gen 被排除）', !got.some((f) => f.includes('src/gen/')), got.filter((f) => f.includes('gen')).join(',') || '（无）')
    ok('搜到的东西计数 > 0', r.searchedCount > 0, `searchedCount=${r.searchedCount}`)
    ok('未触顶', r.limitReached === false)
}

console.log('== 4. glob 收集 ==')
{
    const r = await collect(['src/**/*.ts'])
    const got = rels(r.files)
    ok('** 收全（含深层）', got.includes('src/a.ts') && got.includes('src/deep/b.ts'), got.join(','))
    ok('不跨出 src', got.every((f) => f.startsWith('src/')))
    const one = await collect(['src/*.ts'])
    ok('单层 * 只收当前层', rels(one.files).join(',') === 'src/a.ts,src/.hidden.ts'.split(',').sort().join(','), rels(one.files).join(','))
    const abs = await collect([join(ROOT, 'src', '**', '*.ts').replace(/\\/g, '/')])
    ok('绝对路径 glob 可用', rels(abs.files).length >= 2, rels(abs.files).join(','))
    const brace = await collect(['src/**/*.{ts,md}'])
    const braceGot = rels(brace.files)
    ok('{a,b} 在收集路径上也生效（两条分支都收到）', braceGot.includes('src/readme.md') && braceGot.includes('src/a.ts'), braceGot.join(','))
}

console.log('== 5. maxFiles 只算匹配文件（本次修复的回归点）==')
{
    const many = join(ROOT, 'many')
    mkdirSync(many, { recursive: true })
    for (let i = 0; i < 30; i += 1) writeFileSync(join(many, `f${String(i).padStart(2, '0')}.js`), 'x')
    write('many/target.ts')
    const r = await collect(['many/*.ts'], { maxFiles: 5 })
    ok('maxFiles 很小也能收到匹配的 .ts（旧实现会 0 个）', r.files.length === 1 && r.files[0].endsWith('target.ts'), `收了 ${r.files.length} 个`)
    const r2 = await collect(['many/*.js'], { maxFiles: 5 })
    ok('不匹配的文件不计入上限、且触顶要外显', r2.files.length === 5 && r2.limitReached === true, `收了 ${r2.files.length} limitReached=${r2.limitReached}`)
}

console.log('== 6. 其它边界 ==')
{
    const none = await collect(['does/not/exist'])
    ok('路径不存在不报错', none.files.length === 0)
    const single = await collect(['src/a.ts'])
    ok('单文件直接收', rels(single.files).join(',') === 'src/a.ts')
    const nm = await collect(['node_modules'])
    ok('显式提到 node_modules 时会进去', rels(nm.files).some((f) => f.includes('node_modules')), rels(nm.files).join(',') || '（空）')
    const dup = await collect(['src/a.ts', 'src/a.ts', 'src'])
    ok('重复输入不产生重复文件', new Set(dup.files).size === dup.files.length)
}

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * AST 语言表（**自研**）：文件扩展名 → `@ast-grep/napi` 的 Lang，并注册动态语言。
 *
 * 为什么需要它：旧的改写引擎把文件交给外部 `ast-grep` CLI，**由 CLI 自己按扩展名判语言**；
 * 改成进程内 NAPI 后，语言必须由我们显式给出（`parse(lang, text)`）。
 *
 * 动态语言的注册是**进程级全局**的，`lib/search.js` 也在注册同一批包 —— 两边共用同一个
 * `Symbol.for(...)` 作为"已注册"标记，重复注册是空操作（不会互相踩）。
 *
 * ⚠️ 两个实测结论（子代理审计 D-8 + 管理员模式下的复测）：
 *  1. `registerDynamicLanguage` 是**全有或全无**：混进一个不合法条目 ⇒ 抛错且整批都不注册；
 *  2. 它**只有第一次调用生效**：先注册 `{json}` 成功，再注册 `{python}` 会被忽略（python 仍不可用）。
 *     ⇒ 所以不能"逐个 register 包在 try/catch 里"（那样只有第一个语言能用）。
 * 正确做法：**逐个 `import()` 验证（失败的剔除）+ 一次性批量 register**。这样既保住"一个坏包
 * 不影响其它语言"，也符合 API 的一次性语义。
 */
import { Lang, parse, registerDynamicLanguage } from '@ast-grep/napi'

/** 语言名 → 加载器（包名与 `registerDynamicLanguage` 的键必须一致） */
const LANG_MODULES = {
    angular: () => import('@ast-grep/lang-angular'),
    bash: () => import('@ast-grep/lang-bash'),
    bicep: () => import('@ast-grep/lang-bicep'),
    c: () => import('@ast-grep/lang-c'),
    cpp: () => import('@ast-grep/lang-cpp'),
    csharp: () => import('@ast-grep/lang-csharp'),
    dart: () => import('@ast-grep/lang-dart'),
    elixir: () => import('@ast-grep/lang-elixir'),
    'glimmer-javascript': () => import('@ast-grep/lang-glimmer-javascript'),
    'glimmer-typescript': () => import('@ast-grep/lang-glimmer-typescript'),
    go: () => import('@ast-grep/lang-go'),
    haskell: () => import('@ast-grep/lang-haskell'),
    java: () => import('@ast-grep/lang-java'),
    json: () => import('@ast-grep/lang-json'),
    kotlin: () => import('@ast-grep/lang-kotlin'),
    lua: () => import('@ast-grep/lang-lua'),
    markdown: () => import('@ast-grep/lang-markdown'),
    php: () => import('@ast-grep/lang-php'),
    python: () => import('@ast-grep/lang-python'),
    ruby: () => import('@ast-grep/lang-ruby'),
    rust: () => import('@ast-grep/lang-rust'),
    scala: () => import('@ast-grep/lang-scala'),
    sql: () => import('@ast-grep/lang-sql'),
    swift: () => import('@ast-grep/lang-swift'),
    toml: () => import('@ast-grep/lang-toml'),
    yaml: () => import('@ast-grep/lang-yaml'),
}

/** 加载失败的包（原生二进制缺失、postinstall 未批准、版本漂移…） */
export const languageLoadErrors = []
const DYNAMIC = {}
for (const [name, load] of Object.entries(LANG_MODULES)) {
    try {
        const mod = await load()
        const m = mod?.default ?? mod
        if (!m || typeof m.libraryPath !== 'string') throw new Error('模块形状不对（没有 libraryPath）')
        DYNAMIC[name] = m
    }
    catch (error) {
        languageLoadErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
}

// 与 lib/search.js 共用同一个标记：谁先加载谁注册，另一个是空操作。
// **一次性批量注册**能加载成功的那些（API 只有第一次调用生效 + 全有或全无，见文件头说明）。
const REGISTRATION_KEY = Symbol.for('dsh-ast-grep.dynamic-language-apis.v1')
const registered = (globalThis[REGISTRATION_KEY] ??= new WeakSet())
export const languageRegistrationErrors = []
if (!registered.has(parse)) {
    const names = Object.keys(DYNAMIC)
    if (names.length > 0) {
        try {
            registerDynamicLanguage(DYNAMIC)
        }
        catch (error) {
            // 批量仍失败（例如某个包 import 成功但注册期才报错）⇒ 逐个剔除重试**不可能**
            // （API 只有第一次生效），所以只能记录并让对应扩展名退化为 unknown language。
            for (const name of names) languageRegistrationErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    registered.add(parse)
}

/** 加载失败或注册失败的语言名（这些扩展名会退化成 "unknown language"，而不是让整族失效） */
export function failedLanguages() {
    return [...new Set([...languageLoadErrors.map((e) => e.split(':')[0]), ...languageRegistrationErrors.map((e) => e.split(':')[0])])]
}

/** 供诊断：语言包的加载/注册问题原文 */
export function languageProblems() {
    return [...languageLoadErrors, ...languageRegistrationErrors]
}

const NAMED = {
    javascript: Lang.JavaScript,
    tsx: Lang.Tsx,
    typescript: Lang.TypeScript,
    css: Lang.Css,
    html: Lang.Html,
}

/** 内置（非动态）语言 */
const BASE = {
    js: NAMED.javascript, mjs: NAMED.javascript, cjs: NAMED.javascript, jsx: NAMED.javascript,
    ts: NAMED.typescript, mts: NAMED.typescript, cts: NAMED.typescript,
    tsx: NAMED.tsx, css: NAMED.css, html: NAMED.html, htm: NAMED.html,
}

/** 动态语言（键名与 `registerDynamicLanguage` 里的名字一致） */
const BY_EXT = {
    py: 'python', pyi: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin', kts: 'kotlin',
    swift: 'swift',
    rb: 'ruby',
    php: 'php',
    cs: 'csharp',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    scala: 'scala',
    lua: 'lua',
    json: 'json', jsonc: 'json',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
    sql: 'sql',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    ex: 'elixir', exs: 'elixir',
    hs: 'haskell',
    dart: 'dart',
    md: 'markdown', markdown: 'markdown',
    bicep: 'bicep',
    hbs: 'glimmer-javascript',
    // Angular 的组件模板与 Glimmer 的 TS 版本没有稳定扩展名约定，保守起见不猜
    // 审计 D-附 补：json5 走 json、mdx 走 markdown（jsonl 是"每行一个 JSON"，与 json 解析器语义不同，故意不猜）
    json5: 'json',
    mdx: 'markdown',
}

/** 大写即 C++ 的约定扩展名（`.C` / `.H` / `.HPP` …） */
const UPPER_CPP = new Set(['C', 'H', 'HPP', 'HXX', 'CC', 'CPP', 'CXX'])

/** 扩展名 → Lang；未知返回 null（调用方应跳过并提示，而不是瞎猜） */
export function langForFile(file) {
    const m = String(file).match(/\.([A-Za-z0-9]+)$/)
    if (!m) return null
    const raw = m[1]
    // **大小写约定优先**（审计 D-附）：`.C`/`.H`/`.HPP` 在 C/C++ 生态里是 C++；以前先 toLowerCase
    // ⇒ `.C` 被当 C 解析，C++ 语法直接 parse 失败、文件被静默跳过。
    if (UPPER_CPP.has(raw)) return Lang.cpp
    const ext = raw.toLowerCase()
    // 用 hasOwn 守卫：`a.constructor` 这类扩展名以前会命中 Object.prototype（拿到 Object 构造函数），
 // 结果是 "parse failed" 而不是 "unknown language"（子代理审计 D-13）
    if (Object.hasOwn(BASE, ext)) return BASE[ext]
    if (!Object.hasOwn(BY_EXT, ext)) return null
    const name = BY_EXT[ext]
    return Lang[name] ?? name
}

/** 供诊断：某个扩展名对应的语言是否**注册失败**（那样它会被当成 unknown language 跳过） */
export function isLanguageUnavailable(ext) {
    const name = Object.hasOwn(BY_EXT, String(ext).toLowerCase()) ? BY_EXT[String(ext).toLowerCase()] : null
    return name !== null && failedLanguages().includes(name)
}

/** 供自测/诊断：已知扩展名的数量与清单 */
export function knownExtensions() {
    return [...Object.keys(BASE), ...Object.keys(BY_EXT)].sort()
}

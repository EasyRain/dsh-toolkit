/**
 * `ast_grep_help` 的主题映射表（**零依赖**，便于自测做"文档↔标题"漂移检查）。
 *
 * 内容来源：上游 `ast-grep-mcp` 的规则指南（MIT）。**并入** `docs/TOOLKIT.md` 的
 * `## ast-rules` 一节，并**译为中文**（代码/属性名/YAML 示例保持原文；见该节开头的署名与说明）。
 *
 * ⚠️ 动 `docs/TOOLKIT.md` 里那节的标题，就必须同步这里的字符串 ——
 * `test/help-topics-selftest.mjs` 会逐个核对，找不到就报错（这是 那次
 * "文档与主题表漂移"踩坑后加的护栏）。
 */

/** `## ast-rules` 整节（`full` 主题用它） */
export const RULES_SECTION = '## ast-rules'

/** 主题 → 该主题包含的小节标题（精确匹配文档中的整行；标题已随译文汉化） */
export const HELP_TOPICS = Object.freeze({
    workflow: ['### 通用流程', '### 写规则的技巧', '### 规则开发流程'],
    'rule-object': [
        '### 1. ast-grep 规则简介',
        '### 2. 规则对象的结构',
    ],
    atomic: ['### 3. 原子规则：基本匹配构件'],
    relational: ['### 4. 关系规则：上下文与层级匹配'],
    composite: ['### 5. 组合规则：条件的逻辑组合'],
    metavariables: ['### 6. 元变量：动态内容匹配'],
    full: [],
})

/** 上游出处（回显给用户，便于自查版本） */
export const HELP_SOURCE = Object.freeze({
    url: 'https://github.com/ast-grep/ast-grep-mcp/blob/main/ast-grep.mdc',
    commit: 'b69eb5391bd93d46ef3dec07de814c3c39675c8f',
    license: 'MIT',
 /**：内容已并入本插件的 docs/TOOLKIT.md（## ast-rules 一节），并译为中文 */
    mergedInto: 'docs/TOOLKIT.md#ast-rules',
    translated: true,
})

/** 供自测/诊断：所有被主题引用的小节标题 */
export function helpTopicHeadings() {
    return [...new Set(Object.values(HELP_TOPICS).flat())]
}

/** 供自测/诊断：主题名列表 */
export function helpTopicNames() {
    return Object.keys(HELP_TOPICS)
}

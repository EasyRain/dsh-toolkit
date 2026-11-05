# docs/

本目录是**插件自带的按需帮助素材**，由 `toolkit_help` 一个工具取用（不进会话常驻上下文）：

| 文件 | 来源 | 谁在用 |
|---|---|---|
| [`TOOLKIT.md`](TOOLKIT.md) | **本仓库自写**，但其中 `## ast-rules` 一节是**上游内容**（见下） | `toolkit_help` 一个工具取用（`ast_grep_help` 已并入它）。主题 14 个：家族 `overview` / `table-diff` / `checkpoint` / `session` / `ast` / `ast-rules` / `gotchas` / `full` + 规则 `workflow` / `rule-object` / `atomic` / `relational` / `composite` / `metavariables` |
| （许可全文） | 上游 | `## ast-rules` 一节的 MIT 许可全文已汇总到包根 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) §1.2 |

## `## ast-rules` 一节的来源与规则

- 取自 [`ast-grep-mcp`](https://github.com/ast-grep/ast-grep-mcp) 的规则指南（**MIT**，commit `b69eb5391bd93d46ef3dec07de814c3c39675c8f`）。
- **并入本文件并译为中文**（原先是一个独立的 `ast-grep.mdc`，为便于统一管理而合并）。改动共三处：
  ① 去掉 Cursor 用的 YAML frontmatter、标题整体降一级（`#`/`##` → `###`，`###` → `####`）以便嵌在 `## ast-rules` 之下；
  ② **全文译为中文**（**代码块、属性名、YAML 示例保持英文原样**）；
  ③ 清理了一处排版残留。
  **语义以上游原文为准** —— 该节开头的引用块里给了上游链接、commit 与许可全文；MIT 义务（保留署名 + 标注改动）已满足。
- ⚠️ **动这一节的标题**必须同步 `lib/ast/help-topics.js` 里的 `HELP_TOPICS`（标题已随之汉化）；`test/help-topics-selftest.mjs` 会逐个核对标题是否还在（这是"文档与主题表漂移"踩坑后加的护栏）。
- 要**更新上游内容**：取回上游 `ast-grep.mdc` → 按上面三条规则转换并翻译 → 替换 `## ast-rules` 整节 → 同步 `help-topics.js`（若标题有变）→ 更新 `HELP_SOURCE` 的 commit 与包根 `THIRD-PARTY-NOTICES.md`。

来源、改动与许可全文的**唯一汇总处**是包根 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)。

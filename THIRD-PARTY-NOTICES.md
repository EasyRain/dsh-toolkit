# 第三方声明（Third-Party Notices）

本仓库（`dsh-toolkit`）以 **MIT** 发布，见 [`LICENSE`](LICENSE)（Copyright (c) 2026 EasyRain）。

**本文件是本仓库所有第三方内容的唯一汇总处**：逐项来源、我们的改动、以及**逐字保留的许可全文**。
（MIT 的义务是"保留版权与许可声明 + 标注修改"；把这些集中在这里，同时在各文件的头部/开头保留指向本文件的说明。）

---

## 一、随仓库分发（打包进去的）—— 共 3 处

| 本仓库路径 | 上游 | 版本 / commit | 许可 | 我们的改动 |
|---|---|---|---|---|
| [`lib/search.js`](lib/search.js) | `dsh-ast-grep`（npm） | `0.1.0` | MIT（© 2026 lujunjiehhh）→ [见 §1.1](#11-dsh-ast-grep-libsearchjs) | **有修改**，见下 |
| [`docs/TOOLKIT.md`](docs/TOOLKIT.md) 的 **`## ast-rules` 一节** | [`ast-grep-mcp`](https://github.com/ast-grep/ast-grep-mcp) 的规则指南 | commit `b69eb5391bd93d46ef3dec07de814c3c39675c8f` | MIT（© 2024 Herrington Darkholme）→ [见 §1.2](#12-ast-grep-mcp-docstoolkitmd-的-ast-rules-一节) | **有修改**，见下 |
| [`lib/file/*`](lib/file/)、[`lib/shell/bash.js`](lib/shell/bash.js) | [`dsh-ops`](https://github.com/T-Auto/dsh-ops) | `0.4.4`（dist）+ `0.5.0-alpha3`（源码） | MIT（© 2026 T-Auto and the dsh-ops contributors）→ [见 §1.3](#13-dsh-ops--libfile-与-libshellbashjs-的语义与-schema) | **实现重写**，仅复用契约/语义 |

### 1.1 `dsh-ast-grep` → `lib/search.js`

- **改动**：① 帮助文档改为**懒加载**（上游在模块导入期 `readFileSync`，文件缺失会让整个插件 import 失败）；② 帮助小节找不到时**降级返回全文 + 提示**（上游会 `throw`）；③ 其余（工具名、参数 schema、`search`/`dumpTree`/`testRule` 逻辑、语言注册表）与上游一致。
- **许可全文**：

```text
MIT License

Copyright (c) 2026 lujunjiehhh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.2 `ast-grep-mcp` → `docs/TOOLKIT.md` 的 `## ast-rules` 一节

- **改动**：① 由独立文件 `ast-grep.mdc` **并入** `docs/TOOLKIT.md`（去掉 Cursor 用的 YAML frontmatter、标题整体降一级）；② **全文译为中文**（代码块、属性名、YAML 示例保持英文原样）；③ 清理一处排版残留。**语义以上游原文为准**（链接与 commit 见该节开头的引用块）。
- **许可全文**：

```text
MIT License

Copyright (c) 2024 Herrington Darkholme

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.3 `dsh-ops` → `lib/file/*` 与 `lib/shell/bash.js` 的**语义与 schema**

- **改了哪些**：`dsh-ops` 的文件工具核心在 **Rust worker**（`native/crates/*`）里，纯 JS 插件无法复用 ⇒ **实现全部重写**；
  复用的只有**工具契约与语义**：`read_files` 的多文件 / 多区间 / 编码探测、`inspect_local_file` 的二进制（hex）处理、
  `write_file` / `edit_file` 的 `expectedRevision` CAS 与原子写、`stat/copy/move/remove` 的参数与失败语义，
  以及"失败返回可读原因、不抛裸异常"的约定。`bash` 的规格来自 ② 线的移交单，**不是** ops 代码。
- **许可全文**：

```text
MIT License

Copyright (c) 2026 T-Auto and the dsh-ops contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 二、历史沿革：曾经并入、现已移除

早期版本还并入了另外两处上游代码。**已从本仓库删除** —— 原因不是许可冲突（MIT 与 Apache-2.0 都允许合规并入），而是为了减少维护面与依赖：

| 曾经包含 | 上游 | 许可 | 现状 |
|---|---|---|---|
| `lib/edit/*`（8 个文件） | `dsh-ast-edit-tool@0.1.6` | MIT | **已删除** → 自研 [`lib/ast/edit.js`](lib/ast/edit.js)（进程内 `@ast-grep/napi`） |
| `lib/checkpoint/vendor/diff.mjs` + `LICENSE` + `UPSTREAM.md` | `dsh-checkpoint-rewind@0.6.24` | Apache-2.0 | **已删除** → 自研 [`lib/checkpoint/diff.js`](lib/checkpoint/diff.js)。**故本仓库当前不含 Apache-2.0 代码** |

> 在 git 历史里仍能看到这些文件，它们只存在于更早的提交中。

---

## 三、本仓库其余部分均为自研

`lib/checkpoint/*`、`lib/session/*`、`lib/tablediff/*`、`lib/ast/*`、`lib/glob.js`、`lib/help/*`、`lib/file/*`、`lib/shell/*`、`lib/deps.js`、`lib/errors.js`、`lib/index.js`、`docs/TOOLKIT.md`（除 `## ast-rules` 一节）、`test/*`。

---

## 四、运行时依赖（不随本仓库分发，各自携带许可）

| 依赖 | 许可 |
|---|---|
| `@ast-grep/napi` | MIT |
| `@ast-grep/lang-*`（31 个语言包） | ISC |
| `yaml` | ISC |
| `zod` | MIT |
| `@deepseek-ai/schemastery`（peer，可选） | 见其自身包内声明 |

---

## 五、致谢

- [ast-grep](https://ast-grep.github.io/)（`@ast-grep/*`）—— 本插件的 AST 检索与改写能力都建立在它之上；
- `dsh-ast-grep` / `dsh-ast-edit-tool` / [`dsh-checkpoint-rewind`](https://github.com/PerryLink/dsh-checkpoint-rewind) —— 早期版本分别提供了 AST 只读工具面、改写工具与 diff 引擎；
- [`ast-grep-mcp`](https://github.com/ast-grep/ast-grep-mcp) —— `toolkit_help` 的 **ast-grep 规则主题**来源（现为中文译本，取回时正文里回显出处）。

## 下载器（`lib/download/`）的**设计来源**（未复制代码，仅借鉴模型）

本插件的下载器是**自研零依赖实现**；下列项目只用于**借鉴设计与语义**，其代码**没有被复制**。
若将来移植其中任何代码片段，会在此处补上对应许可证与归属（Apache-2.0/MIT 均允许，需保留声明）。

| 项目 | 许可证 | 借鉴了什么 |
|---|---|---|
| aria2（https://aria2.github.io/manual/en/html/aria2c.html） | GPLv2 | **只借鉴语义**（GPL 代码不可并入 MIT）：`--split` / `--min-split-size`（小于 2×SIZE 不分片）/ `--max-connection-per-server` / piece 选择器 / `--lowest-speed-limit`（掉慢连接）/ `--checksum` / `--continue` / `--dry-run` / `--remote-time` / 代理与请求头语义 |
| AB Download Manager（https://github.com/amir1376/ab-download-manager） | **Apache-2.0** | 引擎结构参照：分片与**动态拆分**（`part/PartSplitSupport`）、分片状态持久化（`db/PartListFileStorage`）、稀疏预分配与分片数学（`utils/SparseFile`、`SplitToRange`）、系统代理/PAC（`connection/proxy/*`）、失败模式（`PartTooManyError`/`ServerPartIsNotTheSameAsWeExpect`/`FileChanged`/`NoSpaceInStorage`）；其 CHANGELOG 的实战坑清单见 `docs/DOWNLOAD.md` §4 |
| bezzad/Downloader（https://github.com/bezzad/Downloader） | MIT | `DownloadPackage` = 保存 **chunk positions** 作为断点状态的思路 |
| node-downloader-helper（https://www.npmjs.com/package/node-downloader-helper） | MIT | 行为/API 参考（override 策略、progress 事件、`resumeFromFile` 状态对象）；**注意它只做单流**，未集成 |
| Gopeed（https://github.com/GopeedLab/gopeed） | GPLv3 | 仅了解其多分块引擎思路（不作代码参考） |
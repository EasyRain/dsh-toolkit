# dsh-toolkit

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）桌面端用的**自有宿主插件**：一个插件，七族 15 个工具 —— 表 diff、AST 结构检索/改写、会话日志、快照与回滚、下载（这三者由 `action` 驱动）、bash 执行器、文件读写（`file`，10 个动作，含 `diff` 改前预览），外加一个按需帮助。
>
> A host-side plugin for the DSH desktop app. [English →](README.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-40%20suites%20passing-brightgreen.svg)](#开发)

## 它解决什么

| 你的问题 | 用哪个工具 |
|---|---|
| 两张表/两个包/两份导出有什么不同（词表、语术、配置、CSV、SQLite） | `table_diff`（先 `table_peek` 看它被读成了什么） |
| 这种**语法结构**在哪、想按结构改写 | `ast_search`（只读）/ `ast_edit`（改写：preview → apply） |
| 以前那次会话里怎么定的 / 两个会话差在哪 | `session_list` / `session_read` / `session_diff` / `session_export` |
| 改动前先存一份、改坏了要回滚 | `checkpoint`（`create` → `diff` → `restore`，默认只预览） |
| 这插件怎么用 / 有什么坑 | `toolkit_help`（按需取，不占常驻上下文） |

**设计上最在意的两件事**：

1. **绝不嵌套遍历** —— 表 diff 一律哈希连接 `O(N+M)`（起因：早先用 Python 嵌套比语术表 = 3,700 万次比较，最后靠 SQLite 才救回来）；
2. **静默错比崩溃更贵** —— 只要结果可能被误读，工具就把话说出来：0 结果会置顶 `⚠⚠` 并写"无法比较（**不是**没有差异）"；坏帧、复制预算降级、上限截断、歧义 id、跨工作区操作……一律**外显**，不猜。

## 工具一览（15）

- **表 diff（2）** `table_diff` / `table_peek` —— 自动识别 Lua / JSON / JSONL / CSV / TSV / PO / properties / YAML / TOML / zip-jar / mappings / SQLite（`node:sqlite`，支持 `path#table` 与自定义 SQL）；`a`/`b`/`mapA`/`mapB` 支持 glob 合并；键值投影支持点路径与 `+` 组合；记录模式下按字段结构化比较。
- **AST（4）** `ast_search` / `ast_dump_tree` / `ast_test_rule` / `ast_edit` —— 改写走**进程内** `@ast-grep/napi`（不需要外部二进制），preview → apply、过期校验、原子写。规则写作指南（原 `ast_grep_help`）已并入下面的 `toolkit_help`（主题 `workflow` / `rule-object` / `atomic` / `relational` / `composite` / `metavariables` / `ast-rules`）。
- **会话日志（4）** `session_list`（`kind:"sessions"` 列日志 / `"subagents"` 列子代理登记）/ `session_read`（给 `pattern` = 正则过滤，不给 = 看最后 N 条）/ `session_diff` / `session_export` —— 多帧 zstd 逐帧解码；`session_diff` 哈希对齐（不是 LCS）。
- **下载（1）** `download` —— **零依赖多线程下载器**，一个工具用 `action` 选动作：`start`（默认；先 `probe:true` 探 Range 与每连接吞吐）、`probe`（只探测不落盘）、`status`（进度/速度/分片，含"worker 已死但 `.part` 还在"⇒ 可续）、`cancel`（默认保留 `.part`）。`.part`+manifest 断点续传、sha256 校验、**系统代理自动探测**（注册表 → PAC → 环境变量 → 常见本地代理端口；**不需要装代理软件**，也可以 `proxy:"direct"` 强制直连）、自定义 headers/Cookie/Referer；默认落盘 `<工作区>/downloads/`，>32 MB 自动转后台
- **File（1）** `file` —— 一个工具十个动作：`read`（多文件 + 多区间；**编码探测** BOM → 严格 UTF-8 → 严格 GB18030；二进制给 hex 预览）、`stat`、**`diff`**（文件 vs 拟写入内容：单 hunk、分页、双哈希，只读）、`write`（**原子写**，可带 UTF-8 BOM）、`edit`（`oldText→newText` 必须**唯一命中且不重叠**，按原编码写回、保留 BOM/CRLF）、`copy` / `move`（默认不覆盖，跨卷退化为复制+删源）、`remove`（默认只预览，`confirm:true` 才删）、`mkdir`。`write`/`edit` 支持 **`expectedRevision` CAS**（sha256 或 `"absent"`），回执带新 revision。
- **Bash（1）** `bash`（Windows 专用）—— 用**本插件安装的 bash 运行时（Niubash）**跑 POSIX 命令行；执行交给宿主 `ctx.subprocess`（终止升级/输出预算/spill/管道由宿主管理）。尊重 `sandboxPolicy` + `sandbox.confine`，支持 `sandbox_permissions` 逐次升级（宿主审批，批准前不执行）；超时转后台（`promoted`），`run_in_background` 与宿主同名且**无默认执行超时**；结果按宿主 terminal 卡片契约输出（真实退出码/信号名），点停止能立即杀树。
- **checkpoint（1）** `checkpoint` —— 一个工具七个动作：`create`（快照，`estimate:true` 只估算）、`list`、`diff`、`restore`（**默认只预览**，要 `confirm:true` 才写盘）、`prune`、`journal`（写文件前的自动留底）、`journal_restore`（按留底回滚单个文件）；附 `/checkpoint`、`/rewind` 命令，以及 `fs/write-intent`、`fs/edit-intent`、`tools/pre-execute` 三个钩子。
- **帮助（1）** `toolkit_help` —— 主题：`overview` / `table-diff` / `checkpoint` / `session` / `ast` / `ast-rules` / `gotchas` / `full`，**外加并入的 ast-grep 规则主题** `workflow` / `rule-object` / `atomic` / `relational` / `composite` / `metavariables`（取回时附上游 MIT 出处）。

## 安装

这是一个 **host 插件**（不注入页面），装进某个 DSH profile。命令各平台一致，注释里给的是 Windows 路径写法：

```bash
# 1) 装进 profile（在 profile 目录里执行）
cd ~/.dsh/profiles/<你的profile>                  # Windows：cd $env:USERPROFILE\.dsh\profiles\<你的profile>
pnpm add github:EasyRain/dsh-toolkit              # 直接从 GitHub 装（现在就能用）
pnpm add dsh-toolkit                              # 发布到 npm 之后可用
pnpm add file:<path>/to/dsh-toolkit               # 从本地检出装（Windows：file:D:\path\to\dsh-toolkit）
# 默认源慢的话可加 --registry=https://registry.npmmirror.com

# 2) 在 profile 的 package.json 里把 "dsh-toolkit" 加进 dsh.profile.bundles
#    （写回时注意：JSON 必须无 BOM —— DSH 严格解析）

# 3) 重启 DSH，然后到「设置 → 工具集」按需开启各工具族
#    七族**默认全部关闭**；`toolkit_help` 常开且不可关闭。
```

> ⚠️ **改完源码必须手动同步进安装副本再重启**：`pnpm add/install file:...` **不会**刷新
> `profiles\<名>\node_modules\dsh-toolkit` 里的拷贝（lockfile 条目没变就不动），否则宿主跑的还是旧代码。

## 开发

```bash
# 日常：**改哪里测哪里**（默认工作方式；全量 130 s，定向只要几秒）
node scripts/test-changed.mjs            # 自上次全绿以来受影响的套件 + 秒级全局门
node scripts/test-changed.mjs --list     # 只列计划，不跑
node scripts/test-changed.mjs --all      # 强制全量（32 份）
node scripts/test-changed.mjs --rebaseline   # 全量绿了之后记录基线（不跑）
# 它做三件事：① 按**改动的文件**映射到受影响的套件；② 每次都跑一组**秒级全局门**
#   （docs-claims 发布面声明 / toolkit-help 的 schema 预算闸门 / output-contract 参数面钉子 / bin/check-package）
# ③ 先把源码同步进安装副本（自测导入的是副本）。**只有全绿才更新状态**，红过的那批下次还会跑。

node test/ast-edit-selftest.mjs         # 需要 @ast-grep/napi（源树或 profile 副本里都能找到）
node test/diff-engine-selftest.mjs
node test/checkpoint-guards-selftest.mjs
# 共 40 份 *-selftest.mjs，全部应打印 ALL PASS
# 全量并给出**可核对的总数**（改到公共面/发布面、或收尾时跑）：
#   node test/run-all.mjs   ->  TOTAL: 31 files, ~1150 passed, 0 failed, 0 non-zero exit
#   **默认并发**（按核数自适应 2–8 路；每份各自 mkdtemp 沙盒 ⇒ 互不干扰）：32 核机器上 31 s（串行 138 s）。
#   `--serial` 串行（排障）、`--jobs N` 指定路数、`--one <名字>` 只跑一份（`glob` 或 `glob-selftest.mjs` 都行）；
#   末尾会打印**每份用时**与"最慢三份"，慢在哪一眼可见。
#   ⚠️ 两份**必须独占**（不能用并发）：`tablediff-perf`（测吞吐）与 `robustness`（自己 spawn 子进程抢锁）。
# 说明：在插件根目录跑即可，各份自测**与自身位置无关**（工作区从 ~/.dsh/sessions 里挑真实存在的，
#       本机一个会话都没有时会打 SKIP 并算通过）。
#       断言总数会 **±1 浮动**（取决于"最新会话是否有 catalog 登记"）；**稳定判据是 0 failed / 0 非零退出**。
```

自测**不依赖宿主**：会话日志 / checkpoint / 表 diff / 自研 diff 引擎都是纯 `node:` 实现，可离线跑。

**平台**：**Windows 38 份全绿（0 failed）**；Linux 在 31 份时复跑过（**1205 条断言**，WSL2 Ubuntu 26.04.1 + Node 22.20），
新增的 `bash` 族在 Linux 用 `/bin/bash`、自测会自动跳过 Windows 专属断言，但**尚未在新版本上复跑** —— 差值全部来自**平台感知的分支**
（符号链接、只读注入、有没有本机会话日志）。**macOS 仍未验证**。
首次真 Linux 验证抓到的都是"把 Windows 的性质当成通用真理"的测试（`taskkill` / `env.TEMP` / `env.USERPROFILE` /
`attrib +R` / 大写路径可读 / 一条从没跑过的符号链接断言），另修了一个真产品问题：`table_diff` 传大小写不匹配的
普通路径时抛裸 Error（现在是有指引的 `ToolError`）。仓库里的 `.github/workflows/ci.yml` 还带一个
**ubuntu job（观测档，`continue-on-error`）**：干净检出 + `npm install` ⇒ 自测**从源码树**导入并真的跑起来；
等它连续几轮全绿就摘掉观测档。

### 目录结构

```
lib/
  index.js            插件入口（分段 try/catch，单段失败不影响其它段；有信标日志便于排查）
  ast/edit.js         ast_edit：进程内 @ast-grep/napi 改写引擎（preview → apply，原子写）
  ast/lang.js         扩展名 → Lang 映射 + 动态语言注册
  ast/help-topics.js  ast-grep 规则主题的小节表（与 docs/TOOLKIT.md 做漂移检查）
  glob.js             文件收集（glob + gitignore 子集，自研，零依赖）
  checkpoint/         checkpoint/rewind 核心 + 自研 unified diff
  session/            会话日志（多帧 zstd 逐帧解码）
  tablediff/          表 diff（适配器 → 投影 → 哈希连接）
  help/               toolkit_help（懒加载 docs/TOOLKIT.md）
  deps.js / errors.js
docs/TOOLKIT.md       按需帮助的正文（不进常驻上下文）
test/                 30 份自测
```

## 许可与署名

- 本仓库以 **MIT** 发布（[`LICENSE`](LICENSE)）。
- 仓库内**包含一处上游代码**：`lib/search.js`（取自 `dsh-ast-grep@0.1.0`，MIT，我们做过 3 处修改：帮助文档懒加载、小节缺失时降级、其余与上游一致）。
- `docs/TOOLKIT.md` 的 **`## ast-rules` 一节是上游 [`ast-grep-mcp`](https://github.com/ast-grep/ast-grep-mcp) 规则指南（MIT）的中文译本**：代码块、属性名与 YAML 示例保持英文原样，语义以上游原文为准。
- 来源、改动说明、**许可全文**与依赖许可清单，**统一汇总在 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)**。

## 说明

- 这是**个人自用为主**的插件：为日常的本地化/词表对比、会话考古、以及"改坏了要能回滚"而写；接口会随需要调整。
- 只在 DSH **宿主侧**运行，不改前端注入；存储位置 `~/.dsh/checkpoints/dsh-toolkit/`（**全局**，跨工作区共用索引）。
- **七族默认全部关闭**：装完到「设置 → 工具集」按需打开，开关**即时生效**（不用重启）；`toolkit_help` 始终可用，模型可以先问"哪些族启用了"再去用工具。
- 可选环境变量：`DSH_TOOLKIT_BEACON_DIR`（加载信标 `_toolkit-load.log` 的写入目录；缺省写 `$DSH_HOME/dsh-toolkit` 与系统临时目录）、`DSH_TOOLKIT_CHECKPOINTS`（快照存储位置）、`DSH_TOOLKIT_CONFIG_FILES`（额外纳入快照的配置文件，`;` 分隔）、`DSH_TOOLKIT_ALLOW_OUTSIDE_WRITES=1`（运维方开关：允许 `checkpoint` 写工作区之外）。
- 声明了 DSH 兼容范围 **`engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"`**：DSH 0.2.1 起，插件**激活**前会先看 `engines.dsh`（有它就**只看它**）；没有这个声明时，才看 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer。要求不满足会被拦下并提示装兼容版本（可用"版本豁免"临时放行，需显式接受风险）。

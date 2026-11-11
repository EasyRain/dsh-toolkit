# dsh-toolkit 使用说明（按需读取）

> 这份文档**不进**任何会话的常驻上下文；由 `toolkit_help` 工具按主题取回。
> 工具的参数级细节仍在各自 schema 里（宿主自动注入）；本文只放**schema 装不下的东西**：怎么选、怎么解读输出、踩过的坑。

## overview

七族 15 个工具，选哪个：

| 你的问题 | 用 |
|---|---|
| "这个词/这段文字在哪出现过" | 官方 `grep`（ripgrep）或终端 `rg` |
| "这种**语法结构**在哪、想按结构改写" | `ast_search`（只读）/ `ast_edit`（改写，需 preview→apply） |
| "以前那次会话里怎么定的 / 两个会话差在哪" | `session_read`（给 `pattern`）/ `session_diff` |
| "两张表/两个包/两份导出有什么不同"（词表、语术、配置、CSV/SQLite） | `table_diff`（先 `table_peek` 看它被读成了什么） |
| "改动前先存一份、改坏了要回滚" | `checkpoint action:"create"` → `checkpoint action:"diff"` → `checkpoint action:"restore"` |
| "要跑 POSIX 管道 / 引号老被 PowerShell 吃掉" | `bash`（自装的 bash 运行时；非交互、超时杀整棵进程树） |
| "文件可能是 GBK/GB18030、要一次读多段、要 CAS 写入" | `file`（read / write / edit / copy / move / remove / mkdir / stat） |

通用原则：**先用只读工具看清楚，再动写工具**；写工具一律先预览。

## shell

`bash` —— 用**本插件自己安装的 bash 运行时（Windows 上是 Niubash）**跑一行 POSIX 命令，拿回退出码、stdout、stderr（分开）。这是内核 0.2.2 移除 `ops_bash` 之后的替代：**不依赖 dsh-ops**；运行时是**可选安装项**（设置页一键下载，约 33 MB），不随插件包分发。

- **什么时候用它**：文本管道（`grep`/`sed`/`awk`/`sort`/`uniq`/`tr`）、通配、以及**引号会被 PowerShell 弄坏**的命令行。
  注册表/服务/ACL/计划任务/WMI ⇒ 走 `powershell.exe -NoProfile -Command "..."`（Windows 上宿主 `pwsh` 工具已被本族隐藏），别在 bash 里绕。
- **平台**：只在 **Windows** 启用。POSIX 上宿主自带 `bash`，本插件**整个 shell 族不可用**：`familyEnabled('shell')` 直接返回 false（不是注册后再让位），设置页该开关禁用并显示「宿主接管」；`apply()` 在非 win32 返回 0。也因此宿主 UI 会按内置映射把本工具显示成「运行命令」，而不是像 `ops_bash` 那样的通用「调用工具」。
- **非交互**：stdin 关闭，`read`/`sudo`/`ssh` 这类提示会挂到超时（默认 60 s，最大 600 s）。超时**杀整棵进程树**：先杀 MSYS 进程组（`kill -9 -<pgid>`），再用 `taskkill /T /F` 兜底 —— 只 `child.kill()` 会留孙进程；而 MSYS `fork` 出来的子进程连 `taskkill /T` 都抓不到（它的 Windows PPID 指向已退出的辅助进程），所以必须两路一起。
- **环境净化（照 ops）**：给子进程固定 `NO_COLOR=1`、`TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`、`LC_MESSAGES=C`、`LC_ALL=C.UTF-8` —— 没有 ANSI 序列、不会被 `less` 挂住、错误消息保持英文可解析；`C.UTF-8` 同时保证 `wc -m` 按**字符**而不是字节数中文。
- **超时 = 中途晋升**（照 ops 的 `promoted`）：前台命令到 `timeoutMs` 仍在跑时**不杀**，转成宿主后台任务，回执 `kind=promoted` + `jobId` + 已产生的部分输出；之后用 `job_output` 读、`job_kill` 停。没有 `jobs` 服务时才退回「杀整棵树 + `timedOut`」。
- **执行层（宿主托管）**：spawn/终止升级（PGID + taskkill）/输出预算/spill/管道生命周期全部交给 `ctx.subprocess.spawn`，本工具只负责"选 bash、组织 argv、渲染"；宿主服务缺失时明确报 `EXECUTOR_UNAVAILABLE`，不再有自建 spawn 后备。自测用同契约的本地替身（`test/support/local-subprocess.mjs`）。
- **退出码与信号**：回执给命令的**真实退出码**（0/1/2/127/128…）；Windows 上被信号杀掉的进程会以 `signal<<8` 形式返回（SIGTERM=3840、SIGKILL=2304 等），这里还原成 `signal=SIGTERM` 并显示 `[killed by signal: SIGTERM]`，同时保留 `rawExitCode`。
- **后台参数对齐宿主**：`run_in_background`（宿主同名，UI 据此显示后台卡片）；`background` 保留为**别名**。后台运行**不设执行超时**（除非显式给 `timeoutMs`），避免长任务被默认 60 s 杀掉。
- **terminal 卡片契约**（宿主客户端按原始事件解析）：`description` **必填**（缺了会被当成 persistent shell，卡片消失）；回执**最后一行**固定 `[exit code: N]` 或 `[killed by signal: X]` —— 客户端据此剥离状态头并显示退出码，否则永远显示 0。
- **逐次升级**（照 ops）：`sandbox_permissions`（`workspace-write`/`danger-full-access`）+ `justification`；只有比当前策略更宽才需要审批，走宿主 `approval.request`，**批准前绝不执行**，批准后复核策略没变（`AUTHORITY_CHANGED` 则作废）；失败码 `APPROVAL_INVALID`/`APPROVAL_UNAVAILABLE`/`APPROVAL_<OUTCOME>`。审批服务不可用时**不降级放行**。
- **生命周期收尾**：会话/agent 销毁（`session/disposed`/`agent/disposed`）时把还活着的任务 kill 掉 —— promoted 的后台命令不会在会话结束后残留。
- **可取消**（重要）：前台/后台命令**都会先登记成宿主 job**（后台任务列表里能看到，可以只停这一条而不结束会话）；正常结束自动移除，到点未完成则留在列表里（promoted）。宿主的 `exec.signal`（点「停止」/结束会话）会走两路杀进程树 + **主动关管道**（防止凭据管理器/ssh 搵着写端让 `close` 不触发），回执带 `[aborted]` + `failure: CANCELLED`。git 这类可能等凭据的命令固定 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`：需要凭据时**直接失败**，不会弹窗/挂住。
- **落盘上限**：spill 预算（默认 **64 MB**，可用 `maxSpillBytes` 调低）随 spawn 一起交给宿主；溢出时宿主标记 lossy，回执带 `truncated` 与 `spillPath`。
- **失败契约**（照 ops）：失败时回执追加 `[failure: CODE; effects: none|unknown; retry: never|after-input-change|after-config-change] nextAction`；常见 CODE：`EXECUTOR_UNAVAILABLE` / `SANDBOX_UNAVAILABLE` / `SANDBOX_DENIED` / `TIMEOUT` / `EXIT_NONZERO` / `CANCELLED` / `SPAWN_FAILED`。
- **输出**：默认上限 2 MB，超出置 `truncated:true`，并把**完整输出落盘**（回执给 `spillPath`，用 `file read` 分段看）；stdout/stderr 原样回显，不做转义，`ok` 只在退出码 0 且未超时时为真。**首行不带 bash 路径**（运行时已固定，只在 `includeDiagnostics` 的 `diagnostics: bash=…` 里给）；**空输出不占行**（哪一路没内容就不打那一段，也不再写 `(empty)`）；末行固定是 `[exit code: N]` 或 `[killed by signal: X]`（宿主 terminal 卡片靠它解析）。
- **参数面（与 ops_bash 对齐）**：`command` / `script_path`（跑现成 `.sh`，与 `command` 二选一）/ `description` / `cwd` / `workdir`（`cwd` 的别名，同时给时 `cwd` 优先）/ `timeoutMs` / `graceMs`（先温和终止，等这么久再强杀整棵树，默认 250 ms）/ `includeDiagnostics`。
- **后台任务**：`background:true` ⇒ 交给宿主 `jobs` 服务（`kind:'bash'`、`label`、`owner`、stdout/stderr 读取器），立刻回 `jobId`；之后用宿主的 `job_output` 读输出、`job_kill` 停。宿主没有 `jobs` 服务时**明确报错**（`ok=false`），不静默降级成前台。
- **沙箱**：会话策略不是 `danger-full-access` 时，整条 argv 会先过 `sandbox.confine(argv, policy, signal)`，用**它的** argv 起进程。**正常执行不再回显模式**（受限/非受限已是同一套行为）；只有真的被拒（`[sandbox: file access denied under <mode> mode]`）或运行器坏掉时才提示。
  **拿不到 `sandboxPolicy`/`sandbox.confine` 或 confinement 结果无效 ⇒ 直接拒绝执行（`SANDBOX_UNAVAILABLE`，命令根本没跑）**，绝不"先放过去再说"。`danger-full-access` 下不包装（与宿主同权限）。
  **Windows + 受限模式**：系统 Git Bash 起不来（MSYS 建信号管道被沙箱拒绝，`0xC0000142`）⇒ 需要一个**能在沙箱里跑的运行时**，再走 `sandbox.confine`。
  **只认我们自己的 Niubash**（`%LOCALAPPDATA%\dsh-toolkit\niubash\1.5.0`，或离线包自带的 `runtime/niubash/<版本>`）：设置页「Bash 执行器」下有两个安装按钮 ——「从国内加速安装」（GitHub 反代 `ghfast.top`，失败自动试 `gh-proxy.com`）与「从 GitHub 安装」（`/dsh-toolkit/bash/runtime/install`，约 33 MB）；归档 sha256 钉死，反代改一个字节就拒绝安装；
  归档 sha256 钉死，解包自带 tar.gz 读取（只写普通文件/目录/硬链接，拒绝绝对路径 / `..` / 符号链接），装完把 exe 的 size+mtime+sha256 记进标记，之后不再重复哈希 33 MB。
  **没装就不启用**（`EXECUTOR_UNAVAILABLE`，提示去下载），不回落系统 bash、也不借 dsh-ops —— 否则不同机器的行为不一致。
  **族按运行时刻关闭**：`apply()` 拿不到运行时 ⇒ 一个工具都不注册（等价于族被关）；设置页装完后安装器会回调立即挂载，**不用重启宿主**。设置页里运行时未安装时开关显示为「关且禁用」。
- **与 dsh-ops 的关系**：**完全独立** —— 运行时是我们自己安装/发布的 Niubash，不借 dsh-ops、也不使用它的 `ops_bash`。两个插件都启用时别同时开 shell 族（功能重叠）。
- **与 `ops_bash` 的差异**：**没有 persistent/PTY 会话**（交互式 `top`、进度条这类不该由本工具承担），也**不做 workspace 预处理**（ACL/临时目录归宿主）；其余能力已对齐：`sandbox_permissions` 逐次升级审批、超时晋升为后台（`promoted`）、前台任务登记为宿主 job、`failure{code,effectState,retry,nextAction}`、会话销毁时收尾活任务、terminal 卡片契约（真实退出码/信号名）。
- **选哪个 shell**：`pickBash()` **只认我们自己的 Niubash** —— 包内 `runtime/niubash/<版本>`（离线包）→ 用户级缓存（`%LOCALAPPDATA%\dsh-toolkit\niubash\<版本>`，设置页安装）；`DSH_TOOLKIT_BASH` 是**显式调试覆盖**（不是自动探测）。**系统 Git Bash 不参与选择**（`findBash()` 仅用于诊断展示），所以装了运行时前后行为一致，两种模式也用同一个 shell。`DSH_TOOLKIT_BASH_BACKEND` 已移除。
- **找不到 bash** ⇒ 明确报错并提示装 Git for Windows（或装受限运行时）；**绝不**自动下载。
- **没装 bash 时**：设置 → 工具集里「Bash 执行器」那行会给两个按钮 —— **从国内镜像安装**（npmmirror，直连，实测 60 MB / 2.7 s）、**从 GitHub 安装**（需要你自己能连 GitHub）。装的是**用户级 PortableGit**（`%LOCALAPPDATA%\dsh-toolkit\git`）：不需要管理员、不改系统 Git、装完删掉 60 MB 安装包；**没装好之前这个开关是禁用的**（工具仍注册，调用会返回明确错误，而不是静默失败）。
- **隐藏宿主 pwsh**（照 ops 的 "shell replacement"）：Windows 上开启本族、且 `findBash()` 找到 bash 时，按会话 `tools.restrict({ deny: ['pwsh','pwsh_persistent'] })` 把宿主自带的 PowerShell 工具藏起来 —— 只隐藏不卸载，会话销毁/插件卸载自动还原；**bash 不可用时不隐藏**（否则会话没有任何 shell）。POSIX 本来就只有 bash，不动。
- **已知限制**：无 PTY（`top`、进度条会乱）；Git 安装目录就是 MSYS 的 `/`（所以在 `C:\Program Files\Git` 里 `pwd` 输出 `/` 是**正确**的）；传给 Windows exe 的 `/xxx` 会被 MSYS 转换，必要时设 `MSYS_NO_PATHCONV=1`。
- **长脚本别硬塞进 `command`**：先用 `write` 落成 `.sh`，再 `bash path/to/script.sh` —— 少一层引号解析，中文/反斜杠/heredoc 都更稳。

## 沙箱与写操作（跨族）

`bash` 会把整条 argv 过 `sandbox.confine`；其它族的写操作是插件自己 `node:fs`，宿主围栏管不到，所以用 `lib/guard.js` 补齐：

- 规则与宿主 `writableRoots(policy)` 同口径：`read-only` 拒一切写；`workspace-write` 只允许 `workspaceRoot`、`additionalWritableRoots`、`/tmp`、`os.tmpdir()` 之内；`danger-full-access` 不拦；**拿不到策略服务则放行**（由宿主兜底）。
- 覆盖：`file`（write/edit/copy/move/remove/mkdir，以及 `replace` 真正落盘时按**收集到的具体文件**判，所以 glob 也绕不过去）、`ast_edit`（apply 落盘前；预览不受限）、`checkpoint` 的 `restore` 动作（显式 `cwd` 在碰快照**之前**就拦）、`download`（start 的 `to`）。
- 拒绝时的回执：抛 `FS_SANDBOX_DENIED`，消息里带 `[sandbox: file access denied under <mode> mode]` 与目标路径，**不会产生副作用**。
- 目标规范化用“父目录 realpath + 文件名”：新建文件不会因为 8.3 短名（`EASYRA~1`）与长名差异被误判成“不在可写根内”。

## file

`file` —— 一个工具十个动作：`read` / `stat` / **`diff`** / `write` / `edit` / `replace` / `copy` / `move` / `remove` / `mkdir`（不传 `action` 时按 `read`）。

- **read**：多文件（`path` / `paths`，最多 20）+ 每文件多区间（`ranges: ["1-40","120"]`，1 基含两端）。换行按编辑器语义切：**CRLF / LF / 孤立 CR 都算换行**（CR-only 文件不会被显示成一行）。
  **编码**：`BOM → 严格 UTF-8 → 多候选（GB18030 / Big5 / Shift_JIS / EUC-KR / EUC-JP）按"常见字比例 + 脚本匹配"打分选最像的**，并回报依据。为什么要多候选：GB18030 的字节空间几乎覆盖所有双字节组合，只试它会把 Big5 的「中文測試」解成「いゅ代刚」且 `replacements=0`（静默出错）。分差太小、或最好的候选也说不通时，回执会**明确提示歧义**并列出候选，此时显式传 `encoding`（`big5` / `shift_jis` / `euc-kr` / `euc-jp` / `gb18030` / `utf8` / `utf16le` / `utf16be` / `windows-1251` / `iso-8859-1`；单字节的只能显式用）。都解不开就有损显示并报"有 N 个 U+FFFD"。
  **能读不能原样写回**：除 UTF-8 / UTF-16 外 Node 没有编码器 ⇒ `edit` / `replace` 遇到这些文件一律拒绝（先转成 UTF-8，绝不悄悄改编码）。二进制（前 8 KB 有 NUL）给 **hex 预览**而不是乱码。OOXML 直接提取文本：`.docx` 按段落、`.xlsx` 按工作表/行（`A1=值`）、`.pptx` 按页（`<a:t>`），`encoding` 分别回 `docx`/`xlsx`/`pptx`，`ranges` 按提取后的行算；**都不做完整渲染**（样式/表格合并/图片/公式计算不处理，上限 5 表 / 500 行 / 100 页）。`.pdf` 明确拒绝并指向 `office` 技能。
- **读取回执（照抄 ops 的续读协议，实测好用）**：每次 read 都回 **`revision`**（整文件 sha256，可直接拿去做 `edit` 的 CAS，不必再读一遍）；
  末尾一行是续读提示 `[revision=…; more lines; nextOffset=41]` 或 `[revision=…; end of file; complete=true]`；
  **`truncatedInLine`** 表示"某行太长被切到 2000 字符"（与"文件没读完"是两回事，不产生 `nextOffset`）。
- **紧凑格式**：同一父目录的多个文件共享一行 `[Base: "D:\dir"]`，块头是 `=== FILE: "a.txt" (Lines 1-40 of 200) ===`；
  行号是 `N| `（不补空格），正文做**可逆转义**（`\` → `\\`、tab → `\t`、控制字符 → `\uXXXX`）—— 防止文件内容伪造出额外的行号/标题。
- **总预算**：单文件默认 1 MB，**一次调用合计 2 MB**（多文件共享；用尽后剩余文件直接报"预算用尽，分批读"）。
- **diff**：`path` + `content`（拟写入的完整内容）⇒ **只读预览**：按行做公共前缀/后缀修剪，只输出**一个替换 hunk**（不做最小 diff）；带 old/new sha256 与行数，`offset`/`limit`/`context` 分页（默认 100 行 / 3 行上下文）；**永不写盘**。三条边界（审计后补）：二进制文件**拒绝**（看内容用 `read` 的 hex）、旧文件超 **8 MB** 不做整文件 diff、**非 UTF-8 文件会明确警告「write 只写 UTF-8，落盘会整体重编码」**；换行差异按「文件 X → 写入 Y」具体说明。与 `table_diff`（两表按键比对）和 `ast_edit` 的 staged 预览不是一回事。
- **write**：整文件写 UTF-8（`bom:true` 加 BOM）；**原子写**（同目录临时文件 + rename）。
- **schema 契约（严格 provider）**：`required` 在任何层级都必须是**字符串数组**；`toJsonSchema` 会递归把属性里的布尔 `required: true` 上提到所属对象并删除，绝不泄露给 provider（否则中转站/new-api 会回 `Invalid schema for function 'file': true is not of type "array"`，整个会话 INVALID_REQUEST）。
- **edit**：若干 `{oldText,newText}`，**每段必须唯一命中、且互不重叠**，否则整单失败（不做部分应用）；**换行无关匹配**：文件与 `oldText` 先归一到 LF（CRLF / 孤立 CR 都算换行），命中后 `newText` 按文件主 EOL 写回；按原编码写回、保留 BOM。**GB18030 无法编码 ⇒ 明确拒绝**（先转 UTF-8，别悄悄改编码）。`dryRun` 只对 `replace`/`remove` 生效；`edit`/`write` 带 `dryRun:true` 会**明确拒绝**（之前会静默写盘）—— 预览改走 `action:"diff"`。
- **replace**：`pattern`（**字面**文本，不是正则）+ `replacement`，对 `path` / `paths`（文件 / 目录 / glob）批量替换；**默认只预览**（`dryRun:true`，报每个文件几处、在哪几行），要真写必须 `dryRun:false`。二进制跳过（UTF-16 按 BOM 识别、不会被误跳）；GB18030 文件命中会拒绝（先转 UTF-8）；一次最多扫 50 个文件。**行号按 CRLF / CR / LF 都算换行**；多行 `pattern` 在 CRLF 文件未命中时会提示改用 `edit`（那里是换行无关匹配）。
- **CAS**：`expectedRevision` 传上次回执里的 sha256，或 `"absent"` 表示"只新建" ⇒ 防"读到旧内容再覆盖"。冲突时回执带**当前** revision，照着重读再改。
- **copy / move**：`to` 与 `path` 同一基准；默认不覆盖（`overwrite:true` 才覆盖）；move 跨卷失败会退化成"复制 + 删源"并在回执里说明。
- **remove**：默认只**预览**（`dryRun`）；真删要 `confirm:true`，目录还要 `recursive:true`；盘根/家目录直接拒绝。
- **mkdir / stat**：递归建目录；stat 给大小 / mtime / revision。
- **失败回执带 `effectState`**（照 ops 的错误模型）：`none` = 没生效、可安全重试；`applied` = 部分已生效（例如复制成功但删源失败）；`unknown` = 可能写了一半（复制/删除中途失败），**先核对再重试**，别盲目重放。
- **与宿主 `read`/`write` 的分工**：编码不确定、要一次多区间/多文件、要 CAS 或原子写 ⇒ 用本工具；纯 UTF-8 单文件随手读，宿主 `read` 也一样。

## table-diff

**核心保证**：哈希连接 `O(N+M)`，绝不嵌套遍历 —— 37 万 × 14 万键也是毫秒级。**不要**为比两张表再写 Python 循环。

支持的输入（按扩展名自动识别，也可用 `format` 强制）：
`lua` / `json` / `jsonl` / `csv` / `tsv` / `po` / `properties`（`.env`/`.ini`）/ `yaml` / `toml` / `zip`（`.jar`）/ `mappings`（混淆映射，见下）/ `sqlite`。

- **`.jar` / `.zip`**（为 MC 模组跟版对比而做）：直接传 jar 路径 ⇒ 得到**条目清单**记录（`path` / `size` / `compressed` / `crc32` / `method`），两个版本一 diff 就知道哪些条目新增/删除/改动；写成 `mod.jar#entry:META-INF/mods.toml` 则把**单个条目当文本**解析（按条目扩展名自动选格式，于是 jar 里的语言文件/配方/`mods.toml` 都能直接比）。
- **`mappings`**：混淆映射文件，跟版时回答"这版把哪些符号改名了"。四种真实格式都认（**按内容嗅探**，所以 `client-<ver>-mappings.txt` 这种 `.txt` 也能自动识别）：
  - **Mojang / ProGuard**（`client-*-mappings.txt`）：`com.mojang.blaze3d.Blaze3D -> eza:` + 缩进的成员行；**左=可读名，右=混淆名**，方法键带 `(参数):返回类型`（真实映射里存在**同名同参数、仅返回类型不同**的桥接方法，不带返回类型会互相覆盖 —— 实测 100 多处重复键）。
  - **TSRG2**（NeoForm `joined.tsrg` / MCP `mcp_config-*-mappings.txt`）：头 `tsrg2 obf srg id`；**自动跳过纯数字的 `id` 列**取 `srg`（否则会取到 `252363` 这种没意义的值）。**左=混淆名，右=可读名**。
  - **经典 SRG**（`CL:`/`FD:`/`MD:`）与 **Tiny/Yarn**（v1 `CLASS/FIELD/METHOD`、v2 `tiny\t2\t0\t…` 头，成员行第 1 列是描述符）。
  - 记录带 `kind`（class/field/method）⇒ 用 `filter` 可只比某一类，例如只比方法：`table_diff … filter="^method" `（配合 `table_peek` 看键长什么样）。
  - 实测：Mojang `1.20.1` vs `1.21.1` 官方映射（104,048 vs 119,607 条）在真宿主里一次 diff 给出 added/removed/changed；解析 9.6 MB 文件约 100 ms（本机实测样例，耗时随机器而变）。
- **大包按文件大小分档读**：jar ≤ 64 MB 整包读（最快）；更大的包**只读尾部 64 KB + 中央目录那一段**（实测 19 MB 的包只读 301 KB 中央目录），完全不碰条目内容 ⇒ GB 级包也不吃内存；取单个条目同样只读它自己的字节区间。另有**单条目解压上限 64 MB**（防 zip 炸弹）与**中央目录上限 256 MB**。
- `.class`、图片等**二进制条目会被明确拒绝**并提示先反编译 —— 不会硬塞进文本解析。要看类结构请用反编译工具或专用 API-diff 脚本（本插件不做 `.class` 语义对比）。
- **`toml`**：`mods.toml` / `neoforge.mods.toml` 等。覆盖 `[table]` / `[[array of tables]]`（索引成 `deps.x.0.modId`）、点号键、`"""多行"""`、数组、内联表、注释；遇到不支持的语法会在输出里点名，而不是静默吞掉。

### 只看"两侧一致"的条目（`only=same`）
词表/多语言工作流最常问的是"**哪些还没翻**"（= 两侧值相同）——用 `table_diff {a, b, only: "same"}`，输出 `= key = value` 段；
`added/removed/changed` 计数照旧是真实总数（`only` 只影响**展示哪一段**）。
### 三条最容易踩的
1. **相对路径与 glob 的基准 = 调用方会话的工作区**（不是进程 cwd）。若结果里 `files=0`，先看顶部 `⚠⚠` 打出的"解析后绝对路径 / glob 基目录 / 调用方会话工作区"，九成是基准不对或路径写错。
2. **0 结果绝不能读成"没有差异"**：一侧 0 文件或 0 记录时，输出**第一行**就是 `⚠⚠ …`，底部写 `无法比较：…（不是"没有差异"）`。看到 `⚠⚠` 就先修输入，别下结论。
3. **glob 会把匹配到的多个文件合并成同一键空间**，并回显 `合并 N 个文件 → M 个键（重复键 K 个，后出现的覆盖前面的）`。重复键 K 很大时，说明你的 key 投影选错了（比如该用 `id+locale`）。

### 键与值的投影
- `keyField` / `valueField`：点路径，`+` 组合多字段（`id+locale`、`items[0]`）。不给 `valueField` ⇒ **整行逐字段对比**（records 模式）。
- 自动探测：键候选 `key/id/name/term/msgid/source/label/title`（+ `__luaKey`）；值候选 `value/text/msgstr/translation/target/trans/title/content/description`。
  探不中就加 `keyHints` / `valueHints` 把它们排到最前。
- records 模式下，若一条记录剥掉键字段后只剩一个"值字段"，会自动**收敛成标量**（并按值模式比较）—— 这是让 `{key,value}` 形状的表得到干净输出的机制。
- `only=added|removed|changed` **只影响展示哪一段**，三个计数**永远是真实总数**（所以 `only=changed` 时也能看到 added/removed 有多少）。

### 跨命名空间对照（mapA/mapB）
两边 key 不同名（术语表 vs 本地化表）时用映射表：
```
table_diff a=<术语表> b=<loc 表> mapA=<映射 csv/properties>
  mapAFrom=term mapATo=key  mapMode=all
```
- `mapMode`：`first`/`last`（默认，取首/末行）/`all`（一个键展开成多个目标，逐个比）。
- **必看回显的命中率**：`解析 N 行 → M 个映射键（多行键 K）命中 H/T (P%)`。命中 0 或 <5% 会告警 —— 这时结果"看起来正常"但毫无意义（我们为此白跑过两轮）。

### SQLite
- `path#table` 指定表；不给 `#table` 会**列出库内各表（名字/行数/列）并自动选行数最多的**（表多于 25 张时只列前 25）。
- `query` 可传自定义 SQL；超大结果会走 ATTACH + FULL OUTER JOIN 路径。

### 值归一化（`normalize`）—— 「翻译是否跟得上」只能这样比
- **问题**：翻译/多语言场景两侧文本**本来就该不同**，直接比原文得到 `changed=100%`，没有任何信息量。
- **用法**：`table_diff a=<同一文件> b=<同一文件> valueFieldA=en valueFieldB=zh-cn normalize=skeleton`
  - **`a` 与 `b` 可以是同一个文件** —— 配 `valueFieldA/B` 就是"一张多语言表按列对比"（最常用的姿势）。
  - `normalize`：`raw`（默认，行为不变）/ `numbers`（只留数值）/ `placeholders`（只留 `{name}` 的 name）/ `skeleton`（占位符 + 数值 + 分段数 + 项目符号数）/ `tokens`（词元）。
  - **默认按集合比**（语序差异是噪声，不算差异），但**保留重复项** —— "英文表少了一行数值"这种真信号仍看得见；要位置敏感就加 `ordered: true`。
  - **标记 vs 占位符**只有一条规则：`{#...}`（如 `{#color(255, 35, 5)}` / `{#reset()}`）是**富文本标记，整段忽略**；`{name}` / `{name:...}` 是占位符，只看 name。所以颜色码里的数字不会变成"数值差异"。
  - 输出里会回显 `已按 normalize=… 归一化后比较`（不说明就会被误读成"原文一致"）；`table_peek` 也能预览同一模式。
- **实测效果**（作者本机实测样例：某个本地化模组 15 个模块文件 / 2101 条记录，en vs zh-cn；换项目或换机器数字会不同）：原文 `changed=836` → 骨架 `changed=267`（**降 68%**），仅数值 `changed=6`；提案点名的"纯语序"样本不再出现，而两条**真·旧译文**仍被抓到。

### 一次比多列（`valueFields`）
- `valueFields: ["en:zh-cn","en:ru","en:zh-tw"]`（也接受逗号分隔字符串）⇒ 一次调用分段输出多组结果，每段标题写明 `1/3 en → zh-cn`。
- 每项形如 `A:B`（省略 `:` 表示两侧同字段）；与 `valueField`/`valueFieldA`/`valueFieldB` **不能同时给**（会互相覆盖，直接报错）。

### Lua：模块化写法的读取与 `table=`
- 本地化/配置类 mod 常见写法是"**先 local 一张大字面量表，再循环拼数组后 return**"：
  ```lua
  local data = { ["loc_key"] = { en = …, ["zh-cn"] = … } }
  for k, v in pairs(data) do table.insert(out, …) end
  return out                       -- ← 不是字面量表
  ```
- 顶层 `return` 不是字面量表时，读取器会**回退到文件内最大的字面量表**（按顶层键数排序，`local` 优先），并在 `note` 里说明选了哪张、还有哪些候选；用 **`table="<名字>"`** 可显式指定。
- **读不出数据表时直接报错**（以前会静默返回 1 条 `__expr` —— 看起来像"这文件只有一条数据"，整类任务被挡住）。两个判据：① 一个候选都没有；② 选中的表每条记录**只有运行时表达式字段**（`__expr`/`__fn`）。错误里说清原因，并提示 `table=` / `format=` 的出路（有候选就列出候选名与键数）。
- **数据表写在 helper 函数之后也能读到**（已修）：顶层 `local function load(x) … return {} … end` 这类函数会被**整块跳过**，函数之后的 `local data = {…}` 照常解析（"先写几个 helper 再写数据表"是常见形状；早期实现会走进函数体、被体内的 `return {}` 打断 ⇒ **整张表读不到**）。`table=` 同样能命中函数之后的表。
- 支持 `en = …` 与 `["zh-tw"] = …` 两种键写法；**缺的语言就是缺**（不补空串）。不执行任何 Lua（`get_mod` / `io_dofile` / `pairs` 一律不求值）⇒ 运行时才拼出来的表静态读不到，会明确报错而不是假装读到了。
- **函数调用的字面实参算进文本**（实测关键项）：`CNumb("0","n_0_rgb")` 取 `0`、`CKWord("Bleed","bleed_key")` 取 `Bleed`、`loc_text("hello")` 取 `hello`。规则：**保留第一个字面量**（它通常是内容，甚至就是一个单词）、**丢掉"键样子"的实参**（纯标识符/下划线，如 `n_0_rgb`）与空串。以前实参被整段丢掉 ⇒ 抽出的文本是 `"…||"`，`normalize=numbers` **系统性漏报**、真差异被判成 same。
- 单行内联 `text:return { ["k"]={…} }` 也能被嗅探成 `lua`（早期要求 `{` 独占一行，会被误判成 properties）。

### glob 的坑（`**/` 与"静默少文件"）
- **`**/` 匹配 0 层目录**：`Main_Modules/**/*.lua` 同时含 `Main_Modules/*.lua` 与 `Main_Modules/TALENTS/*.lua`（修正：以前 `**/` 被译成 `.*/`，那个斜杠要求至少一层 ⇒ **静默漏掉整层文件**）。
- **用了 glob 就始终回显解析到几个文件**：只匹配到 1 个会明确提示"确认不是写窄了"。
- **glob 里个别文件读不出不会打断整体**：跳过它并 `⚠⚠` **点名**（单个显式文件读不出则照旧硬失败 —— 那是明确要求）。

### 其它
- `filter`（键名正则）、`ci`/`trim`（值模式的键归一）、`limit`（每段展示上限，默认 50）。
- 编码：**BOM 会被自动剥掉**；检测到非 UTF-8（GBK 等，解出大量 `U+FFFD`）会提示先转码，否则 key/值带乱码。
- 文本来源 >300 MB 会被拒绝（先切分/用 glob 过滤/走 SQLite）；目录当来源会提示改用 glob。

## checkpoint

**存储**：`~/.dsh/checkpoints/dsh-toolkit/`（**全局**，跨工作区共用一个索引）。

### 关键语义
- `checkpoint action:"create"`：记录工作区清单 + 会话日志 + 配置文件。**排除机制**：`exclude` 参数（裸名 = 任意层级的同名段，含 `/` = 路径前缀，支持 `*.log` 通配）+ 工作区根的 `.dsh-checkpoint-ignore`（每行一个模式，`#` 注释）。
  带大参考资料（数据集、依赖缓存、资源文件等）的工作区**务必配它**（作者本机实测样例：不排除时快照约 200 MB，把那几个大目录排除后只剩几 MB；实际体积取决于你的工作区）。
  - **`estimate: true`**：**只走一遍并报告** `files / total / 可复制 / 只记哈希 / 耗时`，**不写任何快照** —— 多 GB 工作区先估一下再决定（作者本机实测样例：某个 15k 文件量级的工作区估到 15,060 文件 / 115 MB，其中 8,219 个只能记哈希；换机器会不同）。
  - **`presetExclude: true`**（新增，默认关）：追加一份预设排除（`build` / `.gradle*` / `node_modules` / `.git` / `run` / `*.log` / `*.jar` / `*.tmp`）。注意 `node_modules`/`.git`/`.cache`/`dist`/`build`/`out`/`.next`/`__pycache__` 等**本来就恒定排除**。
- **`checkpoint action:"diff"` / `checkpoint action:"restore"` 的对照树默认 = 快照记录里的工作区**（`rec.cwd`），不是"本次会话工作区"：
  - 子目录做的快照、在别处 diff 时，会**按记录的工作区**去比（数字才是对的）；
  - 若这次的会话工作区与记录不同，输出会**置顶提示**两个路径（避免把数字误读成"当前工作区的差异"）；要对照当前工作区请显式传 `cwd`。
- **大文件不复制**：> `maxCopyBytes`（默认 1 MB）或超出 `maxCopyTotal`（默认 50 MB）的文件**只记 size/mtime/hash**（`stored:false`）。
  - diff 仍**准确**（走哈希）；但 `restore` 对它们报 `not-stored (hash only)` 并**跳过**，即"回滚不了"。
  - 降级/截断**一定有告警**（`hashOnly：N 超过单文件上限 …` / `复制预算用尽：N 个文件已降级` / `清单被文件数上限截断` / `清单是空的`）。
- `checkpoint action:"restore"`：**默认只预览**，必须 `confirm: true` 才写盘；`files` 可限定只回滚部分路径。
- `pruneExtra`：删除"目标目录里快照中不存在"的文件 —— **跨工作区（目标 ≠ 快照记录的工作区）会被直接拒绝**（那等于删别人一棵树）。同工作区内正常。
- **id 前缀歧义会报错列候选**（不会猜一个），所以短前缀可能失败，给长一点即可。
- diff/restore **跨工作区会告警**（回显两个路径）；`checkpoint action:"diff" other:"<第二个快照>"` 若两个快照来自不同工作区也会告警（比较的是相对路径）。
- `checkpoint action:"prune" {keep: N}` 按时间保留 N 个；`{drop:[...]}` 定点删；**注意 keep/drop 是全局的**（会作用于所有工作区的快照）。
- `checkpoint action:"list"` 每行带 `ws X MB / copied Y MB`，一眼看出哪个快照占地方。

### 自动留底（journal）
- 宿主在 `write`/`edit`/`ast_edit` 等写操作**之前**自动把原文存进 journal（>20 MB 跳过，最多留 200 条）。
- 留底按会话分桶；`checkpoint action:"journal"` / `checkpoint action:"journal_restore"` **默认跨所有桶**查询（显式 `sessionKey` 才会限定），列表里 `[bucket]` 标明来源。
- 单文件回滚：`checkpoint action:"journal_restore" {path, confirm:true}`（先预览）。

### 命令
`/checkpoint [note <text> | list | diff <a> <b>]`、`/rewind [preview] <id|latest> [confirm]`。
命令没有工具那样的会话上下文，工作区 cwd 由"最新会话"推断（拿不到会回退进程目录）。

## download

**零依赖多线程下载器**（工具面收敛为**一个** `download`，`action` 选 `start` / `probe` / `status` / `cancel`）。

- **先探测再下载**：`download {url, probe:true}` 跟随重定向后报告**最终 URL / Range 是否支持 / 总大小 / 每连接吞吐 / 用的哪个代理**，
  并给出结论 —— **多连接只在"单连接被限速"时才有用**（有些代理会按连接限速，这是典型场景；CDN 上多开线程常常反而略慢）。
- **下载**：`download {url, to?, threads?, resume?, overwrite?, proxy?, headers?, cookie?, referer?, sha256?, mode?}`
  - **代理语义**：`auto`（默认）= **跟随系统代理** —— 代理若在 PAC/规则模式，哪些直连、哪些走代理**由代理自己决定**（本地代理软件的规则表比手写清单靠谱）；全局模式就全走代理。需要绕过某次下载（你已确知该地址可直连）就**显式** `proxy:'direct'`；环境变量 `NO_PROXY` 也生效。
  - **线程数默认自动**：不给 `threads` ⇒ 按 **大小档 × 实测每连接增益** 决定 ——
    档位是**递进值 `1 / 2 / 4 / 8 / 16`**（`<1 MB→1`、`<8 MB→2`、`<64 MB→4`、`<512 MB→8`、`≥512 MB→16`）；
    若探测显示多连接增益 `<1.8×`（瓶颈不在"每连接限速"）则**折半**；**慢链路**（多连接有效但每连接 <1 MB/s，例如经代理访问 GitHub 时）再 ×4（作者本机实测样例：20 MB 级文件 4 连接 3.8 MB/s → 16 连接 7.7 MB/s，速率随网络而变）；最后按"实际切出的片数"封顶。
    **自动最多 16 条**（32 太容易招服务器反感），**给数字即手动**（`1` = 单流，手动可到 32）。
    结果与 `probe` 都会写明依据：`threads=auto→8（大小档 8 + 探测显示多连接有效（合计 ≈ 4.1× 单连接））`。
  - **收尾加速**（默认开，`tailBoost:false` 可关）：多线程下载的经典毛病是"最后一段特别慢"——
    其他连接结束后，剩下的连接仍停留在旧的"带宽均分份额"上不回升（AB Download Manager 也有，用户的做法是暂停再继续）。
    本工具**自动做这件事**：某块速率低于"本任务见过的最好速率"（基准优先取探测到的每连接中位速率）且持续 2 次采样 ⇒
    **断开重连**（新连接会重新分到带宽）；若此刻还有空闲连接，顺手把剩余范围劈一半交回队列。
    实测：复现该场景下 **13.9 s → 7.2 s**（快 1.9×），日志里能看到 `收尾重连：…`。
  - **分块有硬下限**（用户要求"剩下的小块不能一直分"）：劈开必须满足两半都 ≥ `max(512 KB, minSplitSize)`；
    同一块最多劈 2 次、整包最多 2048 块；碎块会被**并进相邻块**，并且落盘前做**覆盖性校验**（有空洞/有片没下完 ⇒ 报错并保留 `.part`，绝不"静默成功"）。
  - **不支持断点续传的站点**：分段请求被忽略（返回整包 200）⇒ **自动回退单流**（清空重下并说明），不会让你手动整包重下；
    探测阶段就能看出 `Range 支持: 否` 时直接单流。
  - **限制连接数的站点**（"允许并发但只放 N 条"，例如要 16 条只有 4 条通）：被拒（403/429/503）⇒ **自动降并发并把该块放回队列**，
    **绝不因此判死整个下载**；`Retry-After` 会被遵守；**记住该主机的实测上限**，同主机下次直接从上限定步（不再挨拒绝）；
    下载过程中会保守地向上试探（近期没被拒 + 连续成功，最多 3 次），以探出真正的上限。
  - 默认落盘 **`<会话工作区>/downloads/`**（文件名取自 URL）；**同名默认拒绝**（给 `overwrite:true` 才覆盖；上次留下的 `.part` 会被**续传**）；
  - **模式**：`mode:'auto'`（默认）≤ 32 MB 前台跑完直接给结果，更大**自动转后台**并返回 job id；也可显式 `foreground` / `background`；
  - **续传**：数据在 `<to>.part`、进度在 `<to>.part.manifest.json`（每块 start/end/done）；续传前比对 `finalUrl/total/etag/last-modified`，**远端变了就重来**；
  - **慢片动态拆分**：某块持续低于 `lowestSpeedLimit`（默认 8 KB/s）⇒ 把它剩余范围劈开、后半段扔回队列给别的连接 ⇒ **卡住的连接不再拖住整包**；
  - **收尾**：长度校验 + **无条件自算 sha256**（给了 `sha256` 就比对，不符则删 `.part`）通过后才原子改名 —— 目标路径上不会出现半成品；
  - **代理**：`proxy:'auto'`（默认）＝ **探测到代理就用、没探测到就直连**（Windows 读注册表项与 PAC，其他平台读环境变量，另有常见本地端口兜底；若你使用本地代理软件，可在它里面打开"系统代理"开关）；也可显式给出你在用的代理，例如 `http://127.0.0.1:7890`（7890 是常见的 mixed 端口，不保证）或 `socks5h://user:pass@127.0.0.1:7891`（SOCKS5 远程解析+认证）；`proxy:'direct'` 强制直连。**代理连不上会明确报错，不会静默走直连**；
  - **请求头**：`headers:["K: V", …]` / `cookie` / `referer`（不少 CDN 缺 UA/Referer/Cookie 就 403）。
- **看进度**：`download action:"status" {id?|to?}` —— 速度/已下/剩余/分片/splits/代理，并识别"**worker 进程已不在但 `.part` 还在**"⇒ 报 `interrupted` 并提示可续。
- **取消**：`download action:"cancel" {id|to, deletePart?}` —— 写取消标志让 worker 优雅停（`.part`+manifest **默认保留**可续；`deletePart:true` 才删）。
- **不支持 Range 的服务器**：明确告知并**回退单流**，不会假装多线程。
- 设计来源（aria2 的语义、AB Download Manager 的引擎结构，均为借鉴非复制）与"实战失败模式清单"见 `docs/DOWNLOAD.md`。
## session

从多帧 zstd 会话日志里读历史（**要解析会话日志就用这些，别再写临时脚本**）。

- `session_list`：默认列**所有**工作区的会话（每行带 slug）；`cwd=` 只列该工作区。
  - **谓词筛选**：`where:{empty, noTitle, olderThanDays, minBytes, maxBytes, integrity}`（全部可选、AND）。`empty` = 无 user/assistant 消息且 ≤6 事件；`integrity` 取 `ok | torn | unreadable`。
  - **重列按需**：`fields:[...]` 里点 `events/turns/messages/title/integrity/lastUserAt` 才会解码日志（一次遍历，结果按**路径+大小+mtime**缓存到 `$DSH_HOME/dsh-toolkit/session-index.json`）。实测：全库 129 份 / 321 MB 首扫 **12.7 s**（最慢单份 3.6 s），命中缓存后只 stat（**0.8 ms**）⇒ **不要**把重列当默认列用。
  - `sort: mtime|bytes|events`（`events` 需要重列）、`offset` 分页。
  - ⚠️ **`integrity` 只报"坏帧"（`torn`）与"读不出事件"（`unreadable`），不报 `seq` 缺号** —— 这个判据被真数据推翻过：子代理会话的 seq 来自**父会话计数器**；早于 v4 的日志用的是**宿主全局**序号（实测一份 16.9 万事件的会话 seq 一路跳到 **2,494,494**，而它能完整解码、`session_read` 照常可用）；fork/seed 会话还会把父事件按原 seq 重放进前缀。按"缺号数"报坏只会得到几百万条噪音，所以传 `integrity:"gaps"` 会被**引导拒绝**。
- `session_read`（**给 `pattern` = 正则过滤事件；不给 = 看最后 `tail` 条**）/ `_diff` / `_export`：`session` 可给 id、id 前缀或 `last`。
  - **跨会话检索**：`scope:"workspace"|"all"`（默认 `"session"`）—— 按会话分组输出"显示 N / 共 M"，受 `limit`（总命中）与 `maxHitsPerSession`（默认 5）双上限 + **10 s 时间预算**约束，提前结束时必须外显原因。实测：本工作区 3 份 / 7.7 万事件 **2.9 s**；全库首扫 12.7 s ⇒ 先用 `scope:"workspace"` 或把 `pattern` 写窄。
  - **`last` 的语义 = "调用方会话工作区里最新的会话"**（不是全局最新）。输出首行方括号里会写明依据与对照：`［last 按调用方会话工作区解析：<cwd>；全局最新是 <id>@<slug>］`；若本会话恰好就是全局最新，它会**明说"此例无法区分作用域"**，别把它当验证结论。
  - 显式给 id **不受 cwd 限制**（可跨工作区读）；显式 `cwd` 会覆盖默认。
- **坏帧会外显**：`⚠ 有 N 帧解码失败（内容可能不完整）` —— 见到就别把结果当完整日志。
- `session_diff` 是**哈希对齐**（不是 LCS），十几万事件也是百毫秒级；`maxItems` 控制每段展示行数。
- `session_list {kind:"subagents"}`（已并入，原 session_catalog）：**子代理/catalog 登记表** —— 一次调用列出某会话派过的子代理：`childId` / `mode`(`one-shot`/`continuable`) / `label` / 创建时间 / 登记次数 / **子代理会话目录是否还在** / 体量 / **gc-backup 是否有备份**，末尾给"彻底丢失 N 个"的汇总与幽灵行告警。
  - 真实数据一眼看出问题：某父会话 17 个 child 全部不在 ⇒ 11 个能从 `~/.dsh/subagent-gc-backup` 救回，**6 个已彻底丢失**（App 里那句"幽灵子代理行"就是这么来的）。
  - 它是处置流程的**第一步**，替代每个会话现写解码脚本；旧脚本的两个坑它都避开了：把 catalog 事件当**快照数组**解析（真实形状是**一条事件一个 child**）、工作区 slug 硬编码。
  - ⚠️ **只读**。真要动会话日志，先看铁律 #1（断 `seq` ⇒ 会话再也打不开）。
- `session_export` 写 `.jsonl`（一行一事件）或 `.md`（可读摘要），目标目录必须已存在。

## ast

- 只读：`ast_search`、`ast_dump_tree`、`ast_test_rule`（YAML 规则）、`toolkit_help`（**写复杂规则前先取帮助**，规则主题 `workflow/rule-object/atomic/relational/composite/metavariables/full` 主题）。
  - `ast_search` 两种模式：
    - **内联**：`source` + `language` + `pattern`（只解析给你的文本）；
    - **文件**：`paths: ["src/**/*.java", "lib/"]` —— **语言按扩展名自动判定**（可用 `language` 覆盖），结果为 `file` + 1-based 行列 + 片段，用于回答"**这种结构在哪**"（扫描文件数上限 500，超过会 `limitReached`）。两种模式互斥（同给会报错）。
    - **0 命中时渲染会附"常见原因"**（pattern 不是完整节点 / 语言选错 / 把路径传给了 `source` / 该先看帮助），避免白跑一轮。
  - 输入有上限（内联源码 2M 字符、匹配数 ≤200、单条文本 ≤2 万字符、树节点 ≤5000、规则 YAML ≤200KB）。
  - **依赖目录默认不搜，但会明说**：`node_modules` 默认跳过（依赖目录多半是噪声），输出里会写"已跳过 N 个 node_modules 目录"。
    要连它一起搜就加 `include_vendored:true`；**或者把那个 node_modules 路径直接写进 `paths`**（显式写了就自动放行）。
    注意 `vendor/`、`dist/` **不**默认排除 —— Go / PHP 的 `vendor/` 是源码；要排除请写进工作区根的 `.gitignore`（遍历器会读）或用 glob 指定。
  - **跳过的文件有总数**：`skipped` 只列前 10 条明细，`skippedCount` 给**总数**（"跳过 300 个"和"跳过 10 个"不能长得一样）；
    差额超过明细条数时输出还会补一句"另有 N 个文件被跳过"。常见原因：扩展名不支持、单文件超过大小上限、读不了。
  - **`ast_search` 是只读工具的入口**（`action` 驱动，默认 `grep`）：`action:"grep"` = 上面说的结构化搜索；
    **`action:"diff"` = 整文件替换前先看一眼**（不落盘、不入栈）：给 `paths`（**恰好一个文件**）+ `content`（你要写进去的内容），
    返回 `[路径] +N −M 行  rev 旧 → 新` 表头 + unified diff（±3 行上下文、`@@` 块、超 240 行折叠）+ before/after 的字节数/行数/revision。
    **什么时候用它**：生成式/整文件重写（**没有 pattern 可跑**，`ast_edit.preview` 覆盖不到）；有 pattern 的改动仍用 `preview`（它还带残留护栏）。
    **三个保真细节**：① 比较前**行尾归一并另行说明**（CRLF 文件 vs LF 内容不会报"每行都改了"；正文相同、只有行尾不同会单独报 `eolOnly`）；
    ③ **只差结尾换行**也单独报 `tailOnly`（行 diff 看不见它，但真写下去会少/多一个换行 —— 以前这里会误报"无差异"）；
    ② **BOM 当文件元数据**：比较正文，但 `after.revision` 按"写进去之后的字节"算（所以和别的工具的 revision 口径一致）。
  - **一页 500 文件，超了可以续**：paths 模式每页最多搜 500 个文件（按路径排序，**顺序稳定**）。撞上限时结果里给 `limitReached: true` + **`nextOffset`**，
    输出还会写明"用 offset:N 接着搜"；把这个值传回 `offset` 就取下一页（**不重不漏**），没有下一页时不给该字段。
    注意区分两件事：**文件分页**（`limitReached`/`nextOffset`）与**页内命中截断**（`truncated`，由 `max_matches` 决定，默认 50、上限 200 —— 想一次看全就先调大它）。
  - **匹配文本默认只给首行**（`text_mode`）：`line`（默认）= 只给节点首行（多行节点会被压成一行并标 `truncated`）、`node` = 整段节点原文（旧行为）、`none` = 不给 `text`（只要 file/line/kind 的清单）。
    **为什么**：同一次查询（20 条命中）实测 **`line` 1,503 token vs `node` 2,395（−37%）、`none` 864（−64%）** —— 多行节点原文是这条工具里最贵的东西，而"这种结构在哪"通常只需要位置 + 首行。
    要看完整上下文/准备整段改写时再显式 `text_mode:"node"`；只统计数量就 `"none"`。没要 `capture_names` 时也不会输出空的 `captures` 字段。
- 改写：`ast_edit` —— **`paths` 必填**（缺省 = 整个会话工作目录，历史上因此误改过 200 个文件）。
  流程固定：`preview`（拿到 `stagedId`）→ **确认它回报的目标文件数** → `apply {stagedId}` 或 `reject {stagedId}`。
  apply 会**校验过期**（替换数/逐文件计数与预览不符、或文件已被改动 ⇒ 拒绝执行）；落盘是**原子写**（临时文件 + rename）；符号链接解到真实路径、POSIX 权限位保留。
  - **写入有独占锁**：落盘前先拿锁（`O_EXCL`），**持锁后再读 → 核 sha256 → 原子发布** —— 别人正好在这时写入不会被静默盖掉。
    锁文件按目标路径哈希放**系统临时目录**，**目标目录不会多出任何文件**；用完即删，超过 30 s 的陈旧锁（上次异常退出）会被抢一次；真有人持锁就明确报错。
  - **失败会说清"写没写进去"**：写盘阶段失败的错误里带 `effectState: none | applied | unknown`（`applied` 时列出已写入的文件，并提示"部分改写状态：修好原因后重新 preview + apply 续做"）。
  - **预览会折叠，但不会隐瞒**：改动小（≤ 12 处）逐处列 `-行:列 旧` / `+行:列 新`；改动大就改成**按文件汇总**（路径只出现一次、每文件列前 3 处、其余写"……其余 N 处未列出"），末行仍给 `共 N 处 / M 个文件`。
    要逐处核对就加 `previewDetail:"full"`；想更早折叠用 `previewDetail:"summary"`。**为什么**：逐处两行会随命中数线性增长（一次 3 文件 48 处 ≈ 4,951 字符 / 147 行，其中大半是重复路径），而预览的价值在"看清改什么"，不在"数行数"。
  ⚠️ **模板里用 `$$$BODY` 这类"整段变量"会把多行结构压成一行**（ast-grep 模板的固有行为，预览会用 `⚠ … 把多行结构压成一行` 点名）；只想改小片段就把模板写窄。
- **`ast_test_rule` 的输出是一行/命中**（`rule @ STDIN 行:列-行:列 · 命中文本 [A=a B=1]`）：值本身仍是上游 JSON，
  但渲染不再整段打印（实测一条命中 331 → **29 tok**）。0 命中会给可操作建议（先查 `pattern`/`kind`，用 `inside`/`has` 时加 `stopBy: end`）。
- 改写引擎是**进程内**的（`@ast-grep/napi` + 语言包），**不需要、也不认任何外部二进制或二进制路径配置**；未知扩展名的文件会被跳过并在结果里**说明**；`exec.signal` 支持中止（宿主不传也能跑）。

### 改名 / 全局文本替换：用 `mode:"literal"`，不要用 AST pattern
- **为什么**：AST pattern 只匹配**语法位置**。裸标识符 pattern `ResourceLocation` 能命中 `import`、类型声明、参数类型，却**命中不到限定/作用域用法** ——
  `X.foo()`、`X::m`（方法引用）、`instanceof X`（实测 Java：**6 处里只中 3 处**）。直接 apply 就是"新旧名混用"的**静默半成品**，只有编译才发现 ⇒ 比不改更危险。
- **怎么用**：`ast_edit { mode:"literal", ops:[{ pat:"ResourceLocation", out:"Identifier" }], paths:[...] }` —— 按 **token 边界**做字面替换，**一条规则覆盖 import / 限定名 / 方法引用 / instanceof**，任何文本文件都能改（不要求已知语言、不需语言包）。
  - `wordBoundary`（默认 `true`）：`Old` **不会**误伤 `OldSuffix`；要"纯子串替换"（连带改同前缀的名字，等价宿主 `replace_all`）就设 `wordBoundary:false`。
  - 边界只加在贴着单词字符的那一侧 ⇒ `import a.b.C;` 这种以 `;` 结尾的 pattern 也能匹配。
- **覆盖率 + 事后校验（默认就有，不必记参数）**：凡是能定义"应当消失的旧文本"的规则（literal 规则、单个标识符的 structural 规则、无元变量的字面 pattern），预览会打：
  `覆盖情况：规则 "ResourceLocation" → "Identifier"（structural）命中 3 / 全文出现 6` ＋ `⚠ 仍有 3 处未改到（A.java:4、A.java:5 …）`。
  - **apply 时残留 > 0 默认直接拒绝**（`force:true` 才强推）—— 这是"不许静默半成品"的硬闸门。
  - **0 命中但文本存在**时（例：`import a.b.C;` 作 structural pattern ⇒ 命中 0 / 全文 1）会点名"节点上下文不对"，并建议改用 literal。
  - 含元变量的规则（`const $A = $B;`）无法定义"旧文本"⇒ 会**明说未做覆盖统计**（别把"没警告"当成"已校验"）。
- **后置条件 `verify`（最通用的形态）**：`verify:[{ text:"ResourceLocation", expect:0 }]` —— 改写后该文本必须恰好出现 N 次（默认 0），**对含元变量的规则同样有效**；不满足则 apply 被拒（同样可用 `force` 推翻）。适合"删掉某 API 后不该再有它的调用"这类断言。
- **`import a.b.C;` 这类 pattern 的现状**：作为 **structural** pattern **匹配不到**（AST 里它是 statement/节点形态，与 pattern 的节点类型对不上）⇒ 命中 0 但文本存在，工具会点出来；要改 import 行就用 **literal 模式**（或只写标识符让 literal 去覆盖）。

## gotchas

- **`ast_edit` 的残留数只统计"原始文件里没被本次改写覆盖到的旧文本"**（口径已修正）：`残留 = 原文出现数 − 命中数`。所以"保留锚点"式改写（替换文本里含旧文本，例如在 `X` 前插一句、给集合加一项但保留原项）**不再**被误判成漏改；反过来，`X.foo()` / `X::m` / `instanceof X` 这类**原文里**存在、AST pattern 命中不到的限定用法**仍然**会被报出来并默认拒绝 apply —— 拒绝时先看它列出的行号（来自原始文件），确认无误再 `force:true`。

我们实际踩过、且在输出里有护栏的那些（看到提示照做即可）：

1. **0 结果 = 先修输入**：`table_diff` 的 `⚠⚠`、`files=0`、`records=0`，底部会给"无法比较"。绝不当成"没有差异"。
2. **相对路径基准 = 调用方会话工作区**；跨工作区读另一个工作区的文件请给绝对路径（跨树时 `.gitignore` 不生效是预期行为）。
3. **破坏性操作都会先预览**：`checkpoint action:"restore"`（`confirm:true`）、`checkpoint action:"journal_restore"`（`confirm:true`）、`ast_edit`（preview→apply）。别跳过预览。
4. **歧义/跨目标的危险操作会拒绝**：checkpoint id 前缀歧义、`pruneExtra` 跨工作区 —— 报错是设计，不是 bug。
5. **上限都可见**：文件数/复制预算/单文件大小/总量上限/展示条数，触发时一定有告警并给出数字。
6. **只在 journal 里的东西**：`checkpoint_*` 快照与 journal 是**全局**存储；`prune`/`keep` 会影响所有工作区，要精确删除用 `drop:[...]`。
7. **编码**：BOM 自动剥离；非 UTF-8 会告警；Windows 上别用 PowerShell 5.1 往返改 UTF-8 文本（会毁中文）。
8. **会话日志是追加式多帧 zstd，绝不编辑事件**（加载器校验 `seq` 连续性，删事件会让会话永久打不开）；要取内容用 `session_export`。
9. **没有 `expectedRevision` 的批量替换，别拿来改关键文件**：`ops_replace` 这类工具不带 CAS，预览与落盘之间文件可能已被改过（覆盖就没了）。改名 / 全局文本替换首选 `ast_edit {mode:"literal"}` —— 逐文件 sha256 + 独占锁 + `effectState`，预览里还会报「命中 N / 全文出现 M」。

## dsh-version-support

**本插件按"一份代码支持整条 0.2.x 线"设计**，`package.json` 里声明 `engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"`
（DSH 0.2.1 起，插件**激活**前会先看 `engines.dsh`：**有这个声明就只看它**；没有才看 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer；
不满足会以 `incompatible-version` **拦住安装与激活** —— 连 profile 启动都会 throw，除非对该"精确宿主版本"有豁免记录）。

> ⚠️ **比的是"内核"，不是桌面版本号**（实测更正）：DSH NEXT 的桌面壳是 `2.0.22-next`，但它内置的
> `@deepseek-ai/dsh`（内核，也就是 `dsh --version` 打印的 `0.2.2-rc.1`）才是 `engines.dsh` / peer / 豁免表比较的对象。
> 所以看到"桌面 2.x"**不要**去放宽区间 —— 曾一度改成 `<3.0.0-0`，那是拿桌面号比错了对象，已改回。
> 判据：`dsh --version`（= 内核版本）+ 插件管理器的 `incompatible with dsh <版本>` 日志。

- **族开关（默认全关）**：七族**默认全部关闭**，装完到「设置 → 工具集」按需开启（开关**即时生效**、不用重启；`toolkit_help` 常开且不可关）。**当前哪些族启用、怎么开**：问 `toolkit_help {topic:"families"}` —— 那段文案由代码生成、始终与实现一致，所以这里只指路、不复制一份（避免两处说法漂移）。
- **已实测的四条线**：`0.2.0-rc.2` / `0.2.1-rc.2` / `0.2.1-rc.4`（NEXT 2.0.21 内核）/ **`0.2.2-rc.1`（NEXT 2.0.22）**上均通过闸门，且**运行时**都验过（0.2.1：七段 `apply ok`、
  五族工具实测可用、设置开关 `applies:"live"`、checkpoint 的 `fs/write-intent`/`fs/edit-intent` 留底照常触发；0.2.2：七段 `apply ok`、六族工具逐一实调、31 套件全绿）。
  0.2.1 的破坏性变更（移除 `./invariant` 导出与 `@deepseek-ai/dsh-invariants`、输入区统计行拆成 `activity`/`usage`、
  工具展示去掉 `both`、子路径插件不再读独立 `package.json`）**本插件一条都没用到**；0.2.2 移除整组 `ops_bash`/`ops_read`/`ops_write`/`ops_grep`/`ops_glob`/`ops_discover_tools`
  **同样一条都没用到**（受影响的是 `dsh-ops`，与本插件无关）。
- **升级 DSH 前后怎么自查**：宿主版本一变，先确认 `engines.dsh` 的区间仍覆盖它；再重启看信标
  （`~/.dsh/dsh-toolkit/_toolkit-load.log`）里是否七段 `apply ok`、以及设置页的族开关是否还在、`applies` 是否仍为 `live`。
- **以后真要按版本分支时的写法**：优先**能力探测 + 回退**（例如 `ctx.get('invariants') === undefined` 时走旧路径），
  而不是硬比版本号；只有在没有可探测信号时才用 `@deepseek-ai/dsh-app-boot` 导出的 `getDshRuntimeVersion()` 比对。
  分支处必须写注释说明"这条分支为什么存在、在哪个宿主版本被引入/移除"。
- **插件生态的通用教训**（写给遇到同类问题的使用者）：对付费/第三方插件，**同一版本未必两条线通用** —— 有的版本为了适配新线会
  放弃旧线（声明精确版本区间而不是 `>=`）。升级宿主或插件前，先用目标版本跑一次兼容判定再决定钉哪个版本。

## ast-rules

> **本节是上游内容的译文**：原文取自 [`ast-grep-mcp`](https://github.com/ast-grep/ast-grep-mcp) 的规则指南（**MIT**，commit `b69eb5391bd93d46ef3dec07de814c3c39675c8f`，许可全文见包根 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)，Copyright (c) 2024 Herrington Darkholme）。
> 本插件对它做了三处改动：① 由独立文件 `ast-grep.mdc` **并入本文件**，并去掉 Cursor 用的 YAML frontmatter、标题整体降一级；② **译为中文**（代码、属性名、YAML 示例保持原文照抄）；③ 清理了一处排版残留。**语义以[上游原文](https://github.com/ast-grep/ast-grep-mcp/blob/main/ast-grep.mdc)为准**，如发现译文有歧义请对照原文。
> 规则主题的小节切片依赖下面的标题 ⇒ 动标题必须同步 `lib/ast/help-topics.js` 的 `HELP_TOPICS`（`test/help-topics-selftest.mjs` 会逐个核对，找不到就报错）。
> 其中「上游 MCP 工具用法」一节讲的是**上游 MCP** 的工具；本插件里对应的是 `ast_search` / `ast_test_rule` / `ast_dump_tree` / `ast_edit`。

### 用 ast-grep 搜索代码

你的任务是帮助用户编写 ast-grep 规则来搜索代码。用户会用自然语言提问，你把它翻译成 ast-grep 规则，然后借助工具开发规则、测试规则，最后在代码库里检索。

### 通用流程

1. 先准确理解用户的诉求：有歧义就问清楚，必要时让用户补充细节。
2. 写一段能体现该诉求的**最简单的示例代码**。
3. 写一条能匹配这段示例代码的 ast-grep 规则。
4. 用示例代码**测试**这条规则是否命中（本插件里用 `ast_test_rule`）：
   a. 不命中就删掉部分子规则，逐个排查不匹配的地方；
   b. 如果用了 `inside` / `has` 这类关系规则，务必带上 `stopBy: end`，确保搜索一直走到该方向的尽头。
5. 用规则去检索代码（本插件里用 `ast_search`）。

### 写规则的技巧

0. 关系规则**永远**带上 `stopBy: end`，确保搜索走到方向的尽头。

```yaml
has:
  pattern: await $EXPR
  stopBy: end
```

1. 用了关系规则却没命中时，先试着给它加上 `stopBy: end`。
2. 结构简单、不需要复杂匹配时（比如找函数调用、变量名）用 `pattern` 就够了。
3. 结构复杂、能拆成更小部件时用完整的 `rule`（比如"某个函数内部的调用"）。
4. `pattern` 不好使时，先用 `kind` 定位节点类型，再用 `has` / `inside` 描述结构关系。

### 规则开发流程

1. 把用户的诉求拆成若干小块。
2. 找出能匹配这些小块的字规则。
3. 用关系规则或组合规则把字规则拼成一条完整规则。
4. 规则不命中示例代码时，删掉部分子规则、逐个排查。
5. 用工具 dump AST 或 dump pattern（本插件里用 `ast_dump_tree`）。
6. 用示例代码测试规则。

### 上游 MCP 工具用法

> 本节讲的是**上游 ast-grep-mcp** 的工具；本插件里的对应关系见本节开头的说明 —— `ast_dump_tree` ↔ `ast_dump_tree`，`ast_test_rule` ↔ `ast_test_rule`。

上游 ast-grep-mcp 提供这些工具：

- `ast_dump_tree`：打印代码的 AST，用来调试和理解代码结构与模式。
- `ast_test_rule`：拿一段代码试规则，确认规则能命中。

### 规则文件格式

### ast-grep 规则文档（面向 AI 助手）

### 1. ast-grep 规则简介

ast-grep 规则是对 **AST（抽象语法树）节点**做匹配与过滤的声明式描述：你写下"一个 AST 节点要满足什么条件才算命中"，它就能做**结构化**的代码检索与分析。

#### 1.1 规则类别概览

为了模块化与表达力，规则分三类：

*   **原子规则（Atomic）**：按节点自身的属性匹配，比如代码模式（`pattern`）、节点类型（`kind`）、文本内容（`regex`）。
*   **关系规则（Relational）**：按目标节点与其它节点的位置/从属关系匹配（`inside`、`has`、`precedes`、`follows`）。
*   **组合规则（Composite）**：用逻辑运算（AND / OR / NOT）把别的规则拼起来（`all`、`any`、`not`、`matches`）。

### 2. 规则对象的结构

规则对象（通常是一段 YAML）是 ast-grep 识别与过滤 AST 节点的核心配置单元。

#### 2.1 总体结构与可选性

规则对象里**每个字段都是可选的**，但至少要有一个"正向"键（例如 `kind`、`pattern`）。

一个节点要命中某条规则，必须满足该规则对象里**所有**已定义字段 —— 也就是隐含的逻辑 AND。

如果规则里用了依赖"先前匹配结果"的元变量，建议显式写成 `all` 组合规则，以保证执行顺序。

**表 1：ast-grep 规则对象字段总览**

| 字段 | 类型 | 类别 | 作用 | 示例 |
| :--- | :--- | :--- | :--- | :--- |
| `pattern` | String 或 Object | 原子 | 按代码模式匹配 AST 节点。 | `pattern: console.log($ARG)` |
| `kind` | String | 原子 | 按节点类型名匹配。 | `kind: call_expression` |
| `regex` | String | 原子 | 用 Rust 正则匹配节点文本。 | `regex: ^[a-z]+$` |
| `nthChild` | number / string / Object | 原子 | 按在父节点子列表中的序号匹配。 | `nthChild: 1` |
| `range` | RangeObject | 原子 | 按字符级起止位置匹配。 | `range: { start: { line: 0, column: 0 }, end: { line: 0, column: 10 } }` |
| `inside` | Object | 关系 | 目标节点必须位于"匹配该子规则的节点"内部。 | `inside: { pattern: class $C { $$$ }, stopBy: end }` |
| `has` | Object | 关系 | 目标节点必须拥有匹配该子规则的后代节点。 | `has: { pattern: await $EXPR, stopBy: end }` |
| `precedes` | Object | 关系 | 目标节点必须出现在"匹配该子规则的节点"之前。 | `precedes: { pattern: return $VAL }` |
| `follows` | Object | 关系 | 目标节点必须出现在"匹配该子规则的节点"之后。 | `follows: { pattern: import $M from '$P' }` |
| `all` | Array<Rule> | 组合 | 所有子规则都命中才算命中。 | `all: [ { kind: call_expression }, { pattern: foo($A) } ]` |
| `any` | Array<Rule> | 组合 | 任一子规则命中即命中。 | `any: [ { pattern: foo() }, { pattern: bar() } ]` |
| `not` | Object | 组合 | 子规则不命中才算命中。 | `not: { pattern: console.log($ARG) }` |
| `matches` | String | 组合 | 被引用的工具规则命中即命中。 | `matches: my-utility-rule-id` |

### 3. 原子规则：基本匹配构件

原子规则按节点**自身的属性**匹配单个 AST 节点。

#### 3.1 `pattern`：字符串与对象两种写法

`pattern` 按代码模式匹配单个 AST 节点。

*   **字符串写法**：直接用 ast-grep 的模式语法（可含元变量）。
    *   例：`pattern: console.log($ARG)`
*   **对象写法**：模式有歧义或需要特定上下文时，用它做精细控制。
    *   `selector`：指定"解析出的模式里"具体要匹配哪一部分。
        ```yaml
        pattern:
          selector: field_definition
          context: class { $F }
        ```

    *   `context`：给出周边代码上下文，帮助正确解析。
    *   `strictness`：调整匹配算法（`cst` / `smart` / `ast` / `relaxed` / `signature`）。
        ```yaml
        pattern:
          context: foo($BAR)
          strictness: relaxed
        ```


#### 3.2 `kind`：按节点类型匹配

`kind` 按 `tree_sitter_node_kind` 名匹配节点类型（名字来自该语言的 Tree-sitter 语法）。适合直接锁定 `call_expression`、`function_declaration` 这类构造。

*   例：`kind: call_expression`

#### 3.3 `regex`：按文本匹配节点

`regex` 用 Rust 正则匹配 AST 节点的**整段文本**。它**不是**"正向"规则：只要文本满足正则就命中，不关心节点是什么结构类型。

#### 3.4 `nthChild`：按位置匹配节点

`nthChild` 按节点在父节点子列表中的序号（**从 1 开始**）查找，默认只数具名节点。

*   `number`：精确匹配第 n 个。例：`nthChild: 1`
*   `string`：用 An+B 公式描述位置。例：`2n+1`
*   `Object`：更精细的控制：
    *   `position`：`number` 或 An+B 字符串。
    *   `reverse`：`true` 表示从末尾开始数。
    *   `ofRule`：先用一条 ast-grep 规则过滤同级列表，再计数。

#### 3.5 `range`：按字符位置匹配节点

`range` 按节点的字符级起止位置匹配。`RangeObject` 有 `start` 与 `end`，各自带 **0 起算**的 `line`、`column`；`start` 包含、`end` 不包含。

### 4. 关系规则：上下文与层级匹配

关系规则按"目标节点相对于其它 AST 节点的位置"来过滤，可以带 `stopBy` 与 `field` 选项。

#### 4.1 `inside`：在某个父节点内部匹配

要求目标节点位于"匹配 `inside` 子规则的节点"内部。

*   例：

    ```yaml
        inside:
            pattern: class $C { $$$ }
            stopBy: end
    ```

#### 4.2 `has`：要求存在某个后代节点

要求目标节点拥有"匹配 `has` 子规则的后代节点"。

*   例：
    ```yaml
    has:
        pattern: await $EXPR
        stopBy: end
    ```

#### 4.3 `precedes` 与 `follows`：按先后顺序匹配

*   `precedes`：目标节点必须出现在"匹配该子规则的节点"**之前**。
*   `follows`：目标节点必须出现在"匹配该子规则的节点"**之后**。

两者都支持 `stopBy`，但**不支持** `field`。

#### 4.4 `stopBy` 与 `field`：细化关系搜索

*   `stopBy`：控制关系规则的搜索何时停止。
    *   `"neighbor"`（默认）：相邻节点不匹配就停。
    *   `"end"`：一直搜到该方向的尽头（`inside` 是根，`has` 是叶）。
    *   `Rule object`：遇到匹配给定规则的周边节点时停（含该节点本身）。
*   `field`：指定目标节点内"应该满足关系规则的那个子字段"。只对 `inside` 与 `has` 有效。

拿不准时**一律用 `stopBy: end`**。

### 5. 组合规则：条件的逻辑组合

组合规则用逻辑运算把原子规则与关系规则拼起来。

#### 5.1 `all`：合取（AND）

列表里**所有**子规则都命中才命中。它保证子规则的匹配顺序 —— 对元变量很重要。

*   例：
    ```yaml
    all:
     - kind: call_expression
     - pattern: console.log($ARG)
    ```


#### 5.2 `any`：析取（OR）

列表里**任一**子规则命中即命中。

*   例：
    ```yaml
    any:
     - pattern: console.log($ARG)
     - pattern: console.warn($ARG)
     - pattern: console.error($ARG)
    ```


#### 5.3 `not`：取反（NOT）

唯一的子规则**不**命中时才算命中。

*   例：
    ```yaml
    not:
     pattern: console.log($ARG)
    ```


#### 5.4 `matches`：复用工具规则

给一个规则 id 字符串，被引用的"工具规则"命中即命中。它让规则可以复用，也支持递归。

### 6. 元变量：动态内容匹配

元变量是模式里的占位符，用来匹配 AST 里**动态变化**的内容。

#### 6.1 `$VAR`：捕获单个具名节点

捕获一个具名节点。

*   **合法**：`$META`、`$META_VAR`、`$_`
*   **非法**：`$invalid`、`$123`、`$KEBAB-CASE`
*   **例**：`console.log($GREETING)` 能命中 `console.log('Hello World')`。
*   **复用**：`$A == $A` 能命中 `a == a`，但**不**命中 `a == b`。

#### 6.2 `$$VAR`：捕获单个匿名节点

捕获单个匿名节点（例如运算符、标点）。

*   **例**：要匹配 `a + b` 里的运算符，用 `$$OP`：
    ```yaml
    rule:
      kind: binary_expression
      has:
        field: operator
        pattern: $$OP
    ```


#### 6.3 `$$$MULTI_META_VARIABLE`：捕获多个节点

匹配**零个或多个** AST 节点（非贪婪）。适合参数/语句数量不定的场合。

*   **例**：`console.log($$$)` 能命中 `console.log()`、`console.log('hello')`、`console.log('debug:', key, value)`。
*   **例**：`function $FUNC($$$ARGS) { $$$ }` 能命中形参/语句数量各异的函数。

#### 6.4 非捕获元变量（`_VAR`）

以下划线开头的元变量（`_`）**不做捕获**：即使名字相同，也可以匹配不同内容，从而提升性能。

*   **例**：`$_FUNC($_FUNC)` 能命中 `test(a)` 与 `testFunc(1 + 1)`。

#### 6.5 元变量识别的注意事项

*   **语法要精确**：只认标准的元变量写法（`$A`、`$$B`、`$$$C`）。
*   **必须独占节点**：元变量文本必须是所在 AST 节点里的**唯一**内容。
*   **以下写法无效**：`obj.on$EVENT`、`"Hello $WORLD"`、`a $OP b`、`$jq`。

调试模式、可视化元变量匹配情况，用 [ast-grep playground](https://ast-grep.github.io/playground.html) 最方便。

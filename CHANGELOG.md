# dsh-toolkit 变更记录

> 只记"状态级"变更（工具增减、行为语义、破坏性修正）；逐条排查细节在
> 本机运维目录下的 `sessions\dsh-plugin\docs\2026-10-10-generic-diff\LOG.md`（不随包发布）。
> 改动流程：改源码 → 跑 `test/*-selftest.mjs` → **手动同步进 `~\.dsh\profiles\<名>\node_modules\dsh-toolkit`**（profile 的安装副本不会被 `pnpm install file:` 刷新 —— lockfile 条目没变就不动，所以只能手抄或跑 `bin/install-toolkit.mjs`）→ 重启宿主。

## 0.11.15 — 2026-11-14（审计 v0.9–v0.11.14：修 4 处，确认 3 处无误）

逐块过了一遍这段时间的改动（沙箱闸门、编码探测、流式哈希、schema DSL 兼容、job 生命周期、下载挂 job）。

**修的 4 处**

1. **下载取消与完成撞车会误报 killed** —— `settleFromStatus()` 先看 `cancelledReason` 再读终态，
   于是"刚好下完时点取消"会把一个**已完整**的下载报成 killed。改成先读终态：`done` 就是 completed。
2. **`jobs.start` 失败原因被吞** —— 前台登记失败后，晋升失败只回一句"宿主没有可用的 jobs 服务"。
   现在捕获真实原因（例如 `JOB_CONTROLLER_UNAVAILABLE`）并写进回执。
3. **晋升结算回调可能冒 unhandled rejection** —— `result.live.done.then(settleAndDrop)` 补 `.catch`。
4. **结算非幂等** —— 加了 `settledOnce`，重复结算不再重复 `jobs.remove`（后者会重试 40 次）。

顺带清掉两处过时注释（文件头还写着"用系统 Git for Windows"、job 注释还写着"结算时消费一次读"）。

**确认无误的 3 处**

- **闸门的路径基准**：`file` 在调用闸门前已把 `path`/`to` 转绝对、`replace` 用**收集到的文件**过闸，
  `download`/`session_export` 也是绝对路径 ⇒ 不存在"相对路径按 process.cwd 判错"的绕过。
- **`checkpoint` 的 `getCtx` 链路**：`apply → tools(defineTool, {getCtx}) → prune/create` 全程有值，
  `prune` 在只读会话确实被拒。
- **`guard.js` 的根比较**：`writableRoots` 用 realpath 键、`isUnderPath` 用"父目录 realpath + 名字"键，
  8.3 短名与长名混用不会误判。

新增 1 条回归（晋升失败回报真实原因）。全量 **40 套件 / 1,687 断言**通过；`check-package` 62/62；schema 不变（36,020 B）。

## 0.11.14 — 2026-11-14（把 `timeoutMs` 的真实语义写进参数描述）

行为不变，只修文档：参数说明原来写的是「Timeout in ms (default 60000)」，但前台的真实语义是
**"愿意阻塞多久，到点转后台"**，默认 10 秒（`promoteAfterMs`）。用户正是看着这句以为"有些命令不吃 10 秒规则"。

新的说明：

> How long to block before the command is promoted to a background job (foreground default 10000, max …);
> passing a larger value blocks longer, and with run_in_background it is the kill timeout instead.

schema：`shell` 2,414 → **2,577 B**，全量 **36,020 B**。全量 **40 套件 / 1,686 断言**通过；`check-package` 62/62。

## 0.11.13 — 2026-11-14（转后台的命令要收到完成通知）

核对了宿主的机制：`dsh-tool-jobs` 在 job 结算时会给 owner 投递一条
`user/message(source: tool-jobs)`（agent 忙 ⇒ `inject`，空闲且 delivery=wakeup ⇒ `followup` 直接起一轮），
**只有**三种情况不发：模型自己 `job_kill`、结算被存活 wait 收走（`awaited`）、teardown。

0.11.12 给前台命令挂了 waiter（抑制噪声），但**转后台后没有撤掉它** ⇒ 长命令跑完也收不到通知，
只能靠模型自己想起来轮询。这不是想要的语义。

- 转后台时 `waiterStopped = true` + `waiterAbort.abort()`（`jobs.wait` 收到 abort 会把 resolver 从
  `job.waitResolvers` 里删掉）⇒ 结算时 `awaited = false` ⇒ **完成通知正常发出**；
- 于是语义变成：**短命令静默、转后台的命令会主动通知、显式后台任务/下载也通知**。

新增回归：转后台时 waiter 被 abort。

全量 **40 套件 / 1,686 断言**通过；`check-package` 62/62；schema 不变（35,857 B）。

## 0.11.12 — 2026-11-14（用"存活 waiter"抑制完成通知，而不是消费读）

0.11.11 用 `jobs.read()` 想抑制完成通知，但查了宿主实现：

```js
this.emit({ type: "settled", job, cause, awaited: waitResolvers.length > 0 }, job.owner)
```

`awaited` 只取决于**结算瞬间是否还有 waiter**（`job_output { wait: true }` 走的就是 `wait()`）。
普通 `read` 不改变它 ⇒ 那条路不成立。

- 改为在登记 job 后挂一个 `jobs.wait(jobId, 30000, ownerId)`，超时未结算就**每隔 1 秒重挂**
  （用 `setTimeout` 而非立即重挂，避免"立即 resolve 的 wait"把事件循环饿死——测试里踩过，整条命令被拖到晋升）；
- 结算时 `waiterStopped = true`，不再重挂；随后移除 job。

全量 **40 套件 / 1,683 断言**通过；`check-package` 62/62；schema 不变（35,857 B）。


## 0.11.11 — 2026-11-14（前台命令一开始就登记 job：立刻可见、随时可停）

你说得对：既然 10 秒后终归要转后台，就没必要等到那一刻才让它出现在任务列表里。
之前的"10 秒后才登记"纯粹是为了避开 tool-jobs 的逐条完成通知，属于用**看不见**换**不吵**——不值得。

- 前台命令**一开始就登记** `kind:'bash'` 的宿主 job（owner = session id）：运行中立刻出现在「后台任务」里，
  随时能单停；超时晋升时**复用同一个 job**，不再重复登记。
- 噪声问题改用另一个办法解决：结算时**先消费一次读**（`jobs.read(jobId, ownerId)`）——
  tool-jobs 对"已被调用方收走的结算"不发通知，随后再 `jobs.remove` 把条目移掉。
  这样"看得见 + 可停 + 不吵"三者兼得。
- 10 秒晋升保留（它解决的是**工具调用阻塞**，不是可见性）：`timeoutMs` 可覆盖。

自测同步：前台 job 的 kind/owner、结算时消费读、结算后移除、异常路径也收尾。

全量 **40 套件 / 1,683 断言**通过；`check-package` 62/62；schema 不变（35,857 B）。

## 0.11.10 — 2026-11-14（下载任务收尾：结算后真的从列表移除 + 取消先礼后兵）

真机跑下载任务时发现两个小问题：

1. **结算后没从「后台任务」移除**：`jobs.remove(id, undefined)` 传的是无主 caller，而 job 有主
   （session id）⇒ `assertAccess` 判 `JOB_FOREIGN_SESSION` 抛错，被 catch 静默吞掉 ⇒ 完成的下载一直挂在列表里。
   改成传**同一个 ownerId**。
2. **取消后状态是 `interrupted` 而不是 `cancelled`**：之前写完 `.cancel` 立刻 `kill`，worker 来不及收尾。
   现在先写标志、**800 ms 后**再补刀（`child.exitCode === null` 才杀），worker 自己把状态写成 cancelled
   并保留 `.part`。

全量 **40 套件 / 1,681 断言**通过；`check-package` 62/62；schema 不变（35,857 B）。

## 0.11.9 — 2026-11-14（job 的 owner 要 session id，不是 Agent 对象）

0.11.6 / 0.11.8 里我按宿主文档的 `owner: exec.agent` 传了 **Agent 对象**，真机一跑就暴露：

```text
晋升后台失败（已终止命令）：session "[object Object]" has no live agent (background job owner must be live)
```

`JobSpec.owner` 的类型是 **SessionId**（`resolveOwner(session)` 拿它去查 live agent），
传对象只会被字符串化成 `"[object Object]"`。0.11.5 之前传的是 `exec.agent.session.id ?? exec.agent.id`，
那条路才是对的。

- `bash` 的晋升 job、`download` 的后台 job 都改回**字符串 session id**（缺 id 时不设 owner）；
- 两条回归改成断言 `owner === 's1'/'sess-dl-1'`（类型 + 取值都盯住，避免再"传错类型"）。

全量 **40 套件 / 1,681 断言**通过；`check-package` 62/62；schema 不变（35,857 B）。

## 0.11.8 — 2026-11-14（后台下载登记成宿主 job：看得见、停得掉、有进度）

以前后台下载只在**自己的**状态文件里跑（`downloads/.dsh-downloads/`），宿主的任务列表看不到，
用户也没法单独停 —— 只能等它跑完。

- `startBackground` 现在额外 `jobs.start({ kind: 'download', label: '<文件名> (大小)', owner: exec.agent })`：
  下载会出现在「后台任务」里，**可以直接点停止**；
- 进度边走边上报（`handle.updateProgress`，500 ms 读一次状态文件：百分比 / 已下 / 总量 / 状态）；
- 取消沿用原有的 `.cancel` 标志文件（worker 自己收尾、**保留 `.part` 以便续传**），再补一刀 `kill` 兜底；
- 结算后 1.5 s 自动从任务列表移除（完成通知已经发出，列表只留还在跑的下载）；
- 回执里多一行：`也出现在「后台任务」里（jobId=…），可直接在那里停止`。

没有 jobs 服务时一切照旧（行为不变）。

新增回归（5 条）：登记 kind/label/owner、回执提到任务列表、取消后 job 结算为 killed。

全量 **40 套件 / 1,681 断言**通过；`check-package` 62/62；schema 不变（35,857 B）。

## 0.11.7 — 2026-11-14（前台转后台阈值 20 s → 10 s）

按实际使用调整：**快命令几秒就跑完，长命令大多可预见**；真正需要"手动停"的，恰恰是
"几秒就该结束、却真的卡住了"的短命令 —— 20 秒对它太迟。

- `DEFAULTS.promoteAfterMs` 20,000 → **10,000**（`timeoutMs` 或 `DSH_TOOLKIT_PROMOTE_AFTER_MS` 仍可覆盖）；
- 工具描述同步为 "promoted after ~10 s"。

schema 不变（35,857 B；描述里只有数字变了）。全量 **40 套件 / 1,676 断言**通过；`check-package` 62/62。

## 0.11.6 — 2026-11-14（前台默认 20 秒转后台：长命令重新可单独停止）

0.11.5 把前台 job 全去掉之后，"单独停止某条命令"这个能力也跟着没了 —— 只剩停止整个会话。
但宿主 UI 的单个停止按钮挂在**任务列表**上（`jobs.kill(jobId, sessionId, 'cancelled by the user')`），
没有 job 就没有按钮。

折中：**前台命令默认 20 秒后自动转后台**（`DEFAULTS.promoteAfterMs`，`timeoutMs` 或环境变量
`DSH_TOOLKIT_PROMOTE_AFTER_MS` 可覆盖）：

- 短命令（<20 s）照旧原地跑完：不创建 job、无完成通知（不吵）；
- 长命令在 20 s 时转成**有主 job**：出现在「后台任务」里，可以**单独停止**；结束时一条通知（此时有用）；
- 晋升 job 的 `owner` 改传 **Agent 对象**（宿主文档写法 `owner: exec.agent`），不再传 id 字符串。

工具描述同步说明了这个行为。

schema：`shell` 2,290 → **2,414 B**，全量 **35,857 B**。
全量 **40 套件 / 1,676 断言**通过；`check-package` 62/62。

## 0.11.5 — 2026-11-14（前台不再创建 job；超时晋升改为"现场登记"）

你截图里那条：

```text
ok=false  kind=promoted
晋升后台失败（已终止命令）：宿主 jobs 服务拒绝登记
```

**不是**进程自己结束了——命令（`sleep 60; ls …`）当时还在跑，是我们把"登记 job / 晋升"的顺序搞错了。

根因：0.11.1 为了消掉 tool-jobs 的逐条通知，把前台 job 改成**无主**。但宿主的控制器是**按 scope 挂的**
（`servesOwner(undefined)` 只在**全局**控制器存在时才为真），所以无主前台 `jobs.start` 直接抛
`JOB_CONTROLLER_UNAVAILABLE`；我们把它 catch 掉并静默降级（`jobId = undefined`），于是超时那一刻
**没有 job 可以复用**，只能杀掉命令并报"拒绝登记"。也就是说：

- 前台"单条可停"其实从 0.11.1 起就失效了；
- 超时晋升从 0.11.1 起全部失败（命令被我们杀掉）。

修法（回归到最简单也最正确的形状）：

- **前台命令完全不创建 job**（取消仍由 `exec.signal` + 宿主停止按钮完成，整棵树照杀）；
- **只有真的超时**才现场登记一个**有主**的 job（`owner = session.id ?? agent.id`）包住已在运行的进程，
  返回 `kind=promoted jobId=…`；登记失败时回执里带上**真实原因**（不再统一说"拒绝登记"）；
- 顺带修掉信标里的假象：`namesOf(() => X.tools(defineTool, {}))` 之前用的是**未清洗**的 `defineTool`，
  会打印早已不存在的 `items.required` 报错（注册其实是好的）——现在诊断也用 `safeDefineTool`。

自测同步：前台"不登记 / 不移除"三条，晋升用例保留（断言 `jobs.start` 被调用且带 owner）。

全量 **40 套件 / 1,674 断言**通过；`check-package` 62/62；schema 不变（35,733 B）。

## 0.11.4 — 2026-11-14（DSL 还要求「带 properties 的对象显式声明 additionalProperties」）

0.11.3 让 `ast_edit` 通过了，但 `file` 换了一个新错：

```text
parameters.edits.items.additionalProperties must be explicitly true or false
```

宿主 rc.3 的 DSL 除了 `required` 的深度限制，还有一条：**任何带 `properties` 的对象节点都必须显式写
`additionalProperties: true|false`**（缺了就报上面那句）。我们从 asar 的 `authorError` 文案里把规则列全了：

- `type` 白名单（string/number/integer/boolean/null/array/object/json）
- 不能同时 `type` + `oneOf`；`oneOf` 至少 2 项
- `enum` 必须是**非空标量**数组
- 带 `properties` 的对象必须显式 `additionalProperties` 布尔
- 属性映射里的 `required` 只能是 `true`（不能 `false`/数组）
- 嵌套（深度 ≥2）不允许任何 `required`

- `stripNestedRequired` 现在同时给"带 properties 的对象"补 `additionalProperties: false`（收紧，不允许额外字段）；
- `output-contract` 新增一条 lint：把上述 DSL 规则逐条套在我们的 15 个工具参数上（`type`/`oneOf`/`enum`/`additionalProperties`），
  以后不用等宿主重启才能发现。

schema：`file` 4,728 → **4,729 B**，全量 **35,733 B**。
全量 **40 套件 / 1,675 断言**通过；`check-package` 62/62。

## 0.11.3 — 2026-11-14（嵌套 required 的真正位置：字段映射的深度）

0.11.2 把清洗挪到了 `defineTool` 之前，但重启后信标**仍然**报
`parameters.ops.items.required is not supported`。再查发现清洗函数本身漏了一种形状：

`ast_edit` / `file` 的 `parameters` 是**字段映射方言**（`{ 字段: {type, required:true} }`），
我原来的实现只递归 `properties` / `items` 这些 JSON Schema 关键字，**没有递归字段映射里的普通键**，
于是 `ops.items.required`、`verify.items.required` 原封不动地传给了宿主。

- 改成**按深度**的通用递归：`required` 只在深度 ≤ 1 保留（根对象的数组 + 字段映射里每个字段的布尔），
  更深的一律丢弃（数组 items 的对象及其 properties）；
- 用模拟宿主 rc.3 的 strict `defineTool`（深度 > 1 有 `required` 就抛）验证 `ast_edit` 与 `file`
  都能通过，且描述里没有 `[schema validation disabled: …]`。

schema：`ast` 8,487 → **8,483 B**、`file` 4,714 → **4,728 B**，全量 **35,732 B**。
全量 **40 套件 / 1,674 断言**通过；`check-package` 62/62。

## 0.11.2 — 2026-11-14（0.11.0 的修复放错了位置：register 阶段已经太晚）

0.11.0 把「去掉嵌套 required」放在了注册收口 `sanitizeDefinition`（`ctx.tools.register` 之前），
但各段的写法是 `ctx.tools.register(defineTool(def))` —— **`defineTool` 先跑**：它已经因为嵌套 required
抛错，退回「schema 校验被禁用」的兜底，register 再洗已经晚了（描述里那句
`[schema validation disabled: …]` 就是这么来的；0.11.1 重启后信标仍报 `defineTool rejected` 就是证据）。

- 把清洗前移到 `makeSafeDefineTool`：**defineTool 之前**先 `stripNestedRequired(tool.parameters)`；
- 兜底分支也补洗一次（`stripNestedRequired(toJsonSchema(...))`）；
- 新增回归：用一个「看到嵌套 required 就抛」的 strict defineTool 模拟宿主，断言不再抛错、描述没有污染后缀。

全量 **40 套件 / 1,674 断言**通过；`check-package` 62/62；schema 不变（35,732 B）。

## 0.11.1 — 2026-11-14（前台命令不再被宿主 tool-jobs 逐条注入完成通知）

宿主 0.2.23 起带了 **`@deepseek-ai/dsh-tool-jobs`**：它给每个**有 owner** 的已结算 job 注入一条
「上下文注入 · tool-jobs · … [status: …]」通知（这是给**后台任务**用的），并发布
`job_output` / `job_kill` / `job_list` 三个工具 + 一段 `tool:jobs` system section。

我们把**前台命令**也登记成有主 job（为了"单条可停"），于是每条命令都触发一条注入 —— 会话里肉眼可见
一大串噪声，纯属重复（命令结果本来就在回执里）。

- 前台 job 改为**不设 owner**（无主 job 仍然可被任何调用方 `read`/`kill`，`assertAccess` 对无主放行），
  因此宿主不再为它投递完成通知；后台任务与超时晋升仍带 owner（那时的通知才是有用的）。
- 结算后的移除改用 `caller = undefined`（与无主 job 一致）。
- 新增回归：前台 `jobs.start` 必须**没有** `owner`，同时仍登记为 job。

全量 **40 套件 / 1,671 断言**通过；`check-package` 62/62；schema 不变（35,732 B）。

## 0.11.0 — 2026-11-14（适配宿主 0.2.23-next / 内核 0.2.2-rc.3：参数 schema 的嵌套 required）

DSH 升到 app `2.0.23-next` + 内核 `0.2.2-rc.3`。新内核改用**自己的 value-schema DSL** 编译工具参数，
规则变成「**只有根节点**允许 `required: [...]`」；数组 items 的对象里再出现 `required` 会被判

```text
unsupported JSON schema: parameters.edits.items.required is not supported by the value schema DSL
```

⇒ `file` 与 `ast_edit` 的 `defineTool` 直接被拒，退化成"schema 校验被禁用"的兜底注册（描述后面拖着一句
`[schema validation disabled: …]`，宿主侧不再校验参数）。

- 注册收口新增 `stripNestedRequired()`：把**嵌套的 required 整段去掉**（不留布尔形式，也不猜宿主接受哪种），
  根节点的 `required: [...]` 保持原样。嵌套必填改由运行时校验 + 字段描述兜底
  （`edits` 的 oldText/newText、`ops` 的 pat/out、`verify` 的 text 都在描述里写明了）。
- 收紧自测契约：参数里**不允许出现任何嵌套 required**（新增 `test/schema-dsl-selftest.mjs`，14 条）；
  输出 schema 仍是原始 JSON Schema，维持"任何层级都是字符串数组"的旧契约。
- 顺带核对其它兼容面：`sandboxPolicy`（新键 `writableRootRegistration`，`resolve()` 形状不变）、
  `sandbox.confine`、`jobs`、`tools.restrict`、`commands` 均正常；`engines.dsh` 区间
  `>=0.2.0-rc.2 <0.3.0-0` 覆盖 rc.3，无需改动。

schema：去掉嵌套 required 后 `file` 4,761 → **4,714 B**、`ast` 8,528 → **8,487 B**，全量 **35,732 B**。

全量 **40 套件 / 1,668 断言**通过；`check-package` 62/62。

## 0.10.9 — 2026-11-11（审计 v0.9.0–0.10.8 的改动，修 5 个问题）

把这一段的 diff 逐块过了一遍（含真机复现），找到并修掉：

1. **截断读取会把 64 KB 探测样本当成正文**（最严重）。`maxBytes: 200` 读一个 36 KB 的 Big5 文件，
   返回了**全部 4000 行**、`stat.lines` 也是 4000 —— 因为选中编码后用 `chosen.text`（探测样本的解码结果）
   当返回值。现在正文一律来自 `body`（展示窗口），并新增「只返回展示窗口内的行」回归。
2. **`copy` 的闸门误判源路径**。写操作闸门对 `[path, to]` 同时判，`copy` 从工作区外**读**进来是合法读,
   却被当成越界拒绝。现在 `copy` 只判目标，`move`（会删源）判两侧，其余动作只判 `path`。
3. **`checkpoint prune` 没接闸门**：只读会话里删快照（删用户数据）是放行的。现在走 `assertWritableStorage`。
4. **进程级副作用在家族开关反复重装时重复挂载**：`mountJobCleanup` 与 `mountHostShellHiding` 每次
   `applyAll` 都新挂一对监听器（`ctx.on('agent/disposed')` 等），越积越多。现在用模块级标志只挂一次。
5. **探测读的短读没按实际字节数截断**：`readSync` 在慢盘/网络盘可能只返回一部分，缓冲区尾部是全 0，
   `isAsciiOnly()` 会误判、甚至被 `sniffUtf16WithoutBom` 当成 UTF-16。现在按实际读取长度切片。

顺带清掉 `lib/index.js` 里一段过时的注释（"用系统 Git for Windows，不下载任何东西"）。

新增 5 条回归（展示窗口行数、`stat.lines` 一致性、copy/move 两侧语义、prune 只读拒绝）。

全量 **1,654** 条断言通过；`check-package` 62/62；schema 不变（35,810 B）。

## 0.10.8 — 2026-11-11（借鉴 dsh-ops 0.5.4：revision 改流式哈希）

对照 dsh-ops 0.5.4 的改动逐条过了一遍，**值得借鉴的**是这两条：

- **`stat` / `copy` / `move` / `remove` 的 sha256 改成流式计算**（对应 ops：「no longer impose the 32 MiB
  whole-content buffer limit」）。我们之前是 `readFileSync` 整份读再哈希 ⇒ `stat` 一个 2 GB 文件会先分配 2 GB。
  现在固定 1 MB 缓冲循环读，内存恒定、无大小上限：实测 **64 MB 文件 35 ms、RSS 仅 +1.8 MB**。
  这条同时覆盖 CAS 校验（`expectedRevision`）用的同一个 `currentRevision()`。
- **工具描述补一句后台指引**（对应 ops：「Bash guidance requires background jobs for long-running/daemon
  starts and notes that `job_kill` terminates the job's process tree」）：`Long-running or daemon starts belong
  in run_in_background (job_kill ends that job's whole process tree)`。

**看过但不采纳**的：

- 「Niubash 选择阶段不再哈希载荷」—— 我们 0.10.x 起就只读一个 `.dsh-toolkit-niubash.json` 标记
  （size+mtime+sha256），本来就不哈希（0.05 ms/次），ops 是刚从"每次哈希 893 MiB"改过来。
- 「准备副本写到 DSH_HOME、禁止 shell 改自己的目录」—— 我们的载荷在用户级目录、标记只认 `niu.exe` 的
  size+mtime，shell 往 `winuxcmd/dev` 写东西不会让校验失效（0.5.1 就是踩了这个坑后改的），不需要再复制一份。
- 「prepared 版本退役 / cache reclaim / 多 profile pin 冲突」—— 我们只有一个固定版本目录，没有多 pin。
- 「官方 read/glob/grep 与 OPS 替代工具互斥声明」—— 我们不替换宿主工具，没有 `MODE_REPLACEMENT` 冲突。
- PTC / batch guidance / 预设注册那一整套 —— 与我们的定位无关。

schema：`shell` 2,185 → **2,290 B**，全量 **35,705 → 35,810 B**。

全量 **1,648** 条断言通过；`check-package` 62/62。

## 0.10.7 — 2026-11-11（设置页文案不再写 "Git Bash"）

运行时早就换成自装的 Niubash（0.8.0 起），但设置页「Bash 执行器」下面那行说明还写着
「bash（Git Bash：POSIX 管道/引号…）」，工具描述里也还有 `(Git Bash on Windows)`。

- 设置页与配置 schema 的族说明改成 **`bash（POSIX 管道/引号；超时杀整棵进程树）`**（中英同步）；
- 工具描述改成 `on Windows it uses the bash runtime you installed`；
- `README` / `README.zh-CN` / `docs/TOOLKIT.md` 里"用系统 Git Bash 跑"的说法一并改正
  （保留"系统 Git Bash 不参与选择"这类**事实性**说明，它们是对的）。

schema：`shell` 2,116 → **2,185 B**，全量 **35,636 → 35,705 B**。

全量 **1,646** 条断言通过；`check-package` 62/62。

## 0.10.6 — 2026-11-10（无 BOM 的 UTF-16 不再被当成二进制）

Windows 上有些工具会写**没有 BOM 的 UTF-16**（尤其 UTF-16LE）。以前这类文件在 `file read` 里
直接被 `looksBinary()` 判成二进制 ⇒ 只给 hex 预览，内容看不到。

- 新增 `sniffUtf16WithoutBom()`：按 **NUL 的奇偶分布**判断（utf16le 的低字节在前，NUL 都在奇数位，反之亦然），
  并要求"文本那半边确实像文本"（可打印 ASCII 或 ≥0x80）——避免把带 NUL 的二进制误判成 UTF-16。
- 判定顺序：**BOM → 无 BOM 的 UTF-16 → 严格 UTF-8 → CJK 多候选**；`readOne` 的二进制检查会先问它。
- 回归：UTF-16LE/BE 无 BOM 的文本能正确读出（不再给 hex）；真二进制仍给 hex。

全量 **1,646** 条断言通过；`check-package` 62/62；schema 不变（35,636 B）。

## 0.10.5 — 2026-11-10（后台/晋升回执教模型用 wait，而不是 sleep 轮询）

ops 有一整套 `job-wait-guidance`（往 system section 里塞提示，占常驻 token）。我们用零成本的做法：
**把提示写进回执本身**，模型当场就能看到。

- 后台回执：`用 job_output { id, wait: true } 等它结束（阻塞到完成或超时；不要用 sleep 轮询）`；
- 晋升（超时转后台）回执同样带这句，并顺手把 `--- stdout (partial) ---` / `--- stderr (partial) ---`
  的 `(empty)` 去掉（与 0.8.3 的回执口径一致：空流不占行）；
- 工具描述里补一句 `use job_output with wait:true instead of polling`。

回归：后台回执必须同时包含 `wait: true` 与「不要用 sleep 轮询」。

全量 **1,640** 条断言通过；`check-package` 62/62；schema 不变（35,636 B）。

## 0.10.4 — 2026-11-10（截断读取也报对方编码，不按前缀瞎猜）

真机验证时发现：`file read` 带小 `maxBytes` 读一个大 Big5 文件，回执写 `encoding=utf8`——
因为它只解码了展示用的那 200 字节（恰好是 ASCII 前缀），把"前缀是合法 UTF-8"当成了"整份是 UTF-8"。

- **判断编码与展示窗口解耦**：被 `maxBytes` 截断时，另读文件开头最多 **64 KB** 作为探测样本；
  若这段恰好是纯 ASCII（英文表头）而文件更长，再读最多 4 MB，避免"按前缀瞎猜"。
- UTF-8 的快路径也改成**在探测样本上验证**，而不是在被截断的展示字节上验证。
- 回归：Big5 大文件 + `maxBytes:200` ⇒ 仍报 `big5`；UTF-8 大文件 + 小窗口 ⇒ 仍报 `utf8`；
  `truncated` 标记不受影响。

全量 **1,638** 条断言通过；`check-package` 62/62；schema 不变（35,636 B）。

## 0.10.3 — 2026-11-10（小样本不喊歧义；Node 与 Electron 的 ICU 有差异）

真机上一条 7 字节的 Shift_JIS 一直报「候选难以区分」，而同一份代码在 Node 里不报。查清了：

- **Electron（宿主）与 Node 的 ICU 对非法 Big5 序列处理不同**：同一段 `83 65 83 58 83 67`，
  Node 的 `TextDecoder('big5')` 认为合法、Electron 认为非法 ⇒ 候选集合不同 ⇒ 打分与歧义判定不同。
  自测跑在 Node、宿主跑在 Electron，这类差异**只能靠真机发现**。
- 修法不依赖哪个 ICU 对：**证据不足就不喊**——候选文本里非 ASCII 字符少于 8 个时，不给歧义提示
  （几个字符本来就说明不了什么）。编码与内容判定不变（`テスト` 仍然判对）。

回归：3 字符的 Shift_JIS 不报歧义但内容正确；空文件走 UTF-8 快路径不抛错。

全量 **1,634** 条断言通过；`check-package` 62/62；schema 不变（35,636 B）。

## 0.10.2 — 2026-11-10（修采样盲区：英文表头 + 后面的中文会被判错）

真机验证 0.10.1 时抓到的**回归**：采样只看前 64 KB，如果这段恰好是纯 ASCII（日志/配置常见的
"几十 KB 英文表头，后面才是中文"），所有候选在样本上同分 ⇒ 退化成"谁排在前面谁赢"，
Big5 正文会被当成 GB18030。

- **样本是纯 ASCII 而全文不是合法 UTF-8** ⇒ 判定改看**整份**（上限 4 MB，避免超大文件反复解码）；
- **打分窗口从第一个非 ASCII 字符开始**取 2000 字符 —— 否则窗口里全是 ASCII，打分没有意义；
- 回归：`ASCII 表头 + Big5 正文` 必须判成 big5 且尾部内容正确。

顺带确认：0.10.1 的采样本身没问题（1 MB 非 UTF-8 仍 3–4 ms），这是"样本没代表性"的边界，
不是性能回退。

全量 **1,631** 条断言通过；`check-package` 62/62；schema 不变（35,636 B）。

## 0.10.1 — 2026-11-10（编码探测改成采样：1 MB 非 UTF-8 从 83 ms 降到 3 ms）

0.10.0 的多候选探测是**对整份内容**做 5 次解码 + 5 次逐字符打分：1 MB 非 UTF-8 文件要 ~83 ms，
10 MB 级就是几百毫秒。而编码是**全局属性**，看开头就够了。

- **探测采样**：只看前 **64 KB**（与 VS Code 的 `AUTO_ENCODING_GUESS_MAX_BYTES = 512 * 128` 同量级），
  候选解码用宽松模式并按"替换字符占比 > 0.5%" 排除（样本末尾截断最多产生 1–2 个替换字符，不影响判断）。
- **整份只解码一次**：选定编码后再对全文严格解码；样本之外如果有非法字节，退回有损并在回执里报数。
- **打分只看候选文本前 2000 字符**：脚本/常用字比例是统计属性，2000 字足够。
- 实测（1 MB）：UTF-8 0.5–0.9 ms（未变，走快路径）；GB18030 **83.4 → 3.2–4.0 ms**。
  200 KB Big5 仍判对且整份解码无替换字符。

参考的社区做法（顺带记在这里，免得以后重复调研）：
- **VS Code**：BOM 优先，之后用 `jschardet`（Mozilla universalchardet 的 JS 移植），**最多喂 64 KB**，最少 4 KB；
  猜出 `ascii`/`utf-16`/`utf-32` 直接忽略；支持用户配置候选编码列表。
- **Vim**：`fileencodings` 是**有序列表**，按顺序试，**第一个解开的就用**（`ucs-bom` 排在最前处理 BOM）。
- **Notepad++**：用 `uchardet`（Mozilla 模型统计法）。

我们取的是"Vim 的有序 + 一点统计打分"的折中：先按顺序试，能解开多个时用常见字比例与脚本匹配排序，
分不清就明确说"可能不是 X"，而不是假装确定。

全量 **1,629** 条断言通过；`check-package` 62/62；schema 不变（35,636 B）。

## 0.10.0 — 2026-11-10（`file read` 编码兼容：Big5 / 日文 / 韩文 / 西里尔）

`file read` 以前只有 `BOM → 严格 UTF-8 → 严格 GB18030`。问题不只是"支持得少"，而是**静默误解**：
GB18030 的字节空间几乎覆盖所有双字节组合，所以 Big5 的「中文測試」会被"成功"解成「いゅ代刚」，
`replacements=0`、没有任何警告。日文（Shift_JIS / EUC-JP）、韩文（EUC-KR）同理。

- **显式指定**：`encoding` 枚举扩到 `gb18030 / big5 / shift_jis / euc-kr / euc-jp / windows-1251 / iso-8859-1`
  （外加原有 `utf8 / utf16le / utf16be`）。显式值先严格解码，失败才用替换字符并计数；未知编码名直接报错，不静默回退。
- **自动探测**：UTF-8 失败后，把所有**能校验字节合法性**的 CJK 候选都试一遍（单字节编码不进自动候选，
  否则"任何字节都合法"会制造噪声），按「常见字比例 + 脚本匹配」打分选最像的：
  - 输出里出现假名而候选不是日文编码 ⇒ 扣分；出现韩文兼容用字母（ㄱㅏ…）而候选不是韩文 ⇒ 扣分；
  - 扩展 A 区、私用区、控制字符 ⇒ 扣分。
  实测：Big5/GBK/Shift_JIS 三类样本都能自动挑对。
- **不确定就明说**：分差太小、或最好的候选也说不通（例如把单字节西里尔文当 GB18030）时，
  回执加一行 `⚠ 编码可能不是 X（也能被 A / B 解开）`，并列出候选。
- **能读不能原样写回**：除 UTF-8 / UTF-16 外 Node 没有编码器 ⇒ `edit` / `replace` 对这些文件一律拒绝
  （以前只拒 GB18030），提示先转成 UTF-8，绝不悄悄改编码。
- 新增 `test/file-encoding-selftest.mjs`（22 条）：显式/自动、UTF-8 与 BOM 不受影响、歧义提示、
  工具层回执、编辑拒绝、未知编码名报错。

schema：`file` 4,475 → **4,761 B**（枚举与说明变长），全量 **35,350 → 35,636 B**。

## 0.9.6 — 2026-11-10（session_export 先问权限再干活）

CI 暴露出 0.9.5 新用例的环境依赖：`session_export` 的闸门放在"解析会话 / 读日志"之后，
而 CI 里没有会话日志 ⇒ 先报 `no session logs`，根本走不到权限判断。

- 把闸门提到 `execute` 最前面：**先判目标能不能写**（只读会话直接拒、工作区外按策略拒），
  再去做会话解析与日志解码。拒绝更快，也顺带省掉无谓的读盘。
- 这样用例在"没有任何会话日志"的机器上也能稳定验证权限判定。

全量 **1,607** 条断言通过；`check-package` 62/62；schema 不变（35,350 B）。

## 0.9.5 — 2026-11-10（闸门真的接上了：apply 没把 getCtx 传下去）

在真机上切到「仅查看（read-only）」实测时发现 **0.9.4 的补漏有两处没生效**，原因是接线而不是判定：

- `checkpoint.apply()` 解构参数后只把 `resolveSessionFile` / `resolveWorkspaceCwd` 传给了 `tools()`，
  **把 `getCtx` 丢了** ⇒ 单工具 `checkpoint` 的 `create` / `restore` / `journal_restore` 闸门全空；
- `download.apply()` 调的是 `tools(defineTool)`（**没传 options**）⇒ `download` 的 `to` 闸门也是空的。

修法：两个 `apply()` 都把 `getCtx` 透传到 `tools()`。

新回归走到**真实 `apply()` 入口**（而不是直接调 `tools()`）—— 这正是原来自测漏掉的一层：
apply 里少传一个字段，判定逻辑再对也拦不住。

- `apply` 之后 `checkpoint create` 在只读下被拒；
- `apply` 之后 `download start` 在只读下被拒；
- `session_export` 在只读下被拒。

全量 **1,607** 条断言通过；`check-package` 62/62；schema 不变（35,350 B）。

## 0.9.4 — 2026-11-10（补齐 read-only 模式）

宿主只有三种模式：`read-only` / `workspace-write` / `danger-full-access`。0.9.x 的闸门覆盖了后两种，
`read-only` 只覆盖到"写文件"这一层，还有三处会写盘：

- **`checkpoint` 的 `create`**：快照落在 `$DSH_HOME/checkpoints`，只读会话里既没用（`restore` 同样被拒）又占空间 ⇒ 现在直接拒；
- **`checkpoint` 的 `journal_restore`**：单文件回滚也是写盘，之前只做了"工作区边界"校验，没过策略 ⇒ 现在过闸门；
- **`session_export`**：导出会写目标文件，之前完全没过策略 ⇒ 现在过闸门（只读拒绝、工作区外按宿主策略）。

另外确认过的边界（不用改）：`file` 的 read/stat/diff、`ast_search`、`table_diff`、`session_*` 的读操作、
`checkpoint` 的 `list`/`diff` 在只读下本来就不写盘；`bash` 走 `sandbox.confine`，只读时由宿主围栏拦住写入。

新增 3 条回归（只读拒建快照 / workspace-write 允许 / 拿不到策略放行）。

全量 **1,604** 条断言通过；`check-package` 62/62；schema 不变（35,350 B）。

## 0.9.3 — 2026-11-10（受限会话也隐藏宿主 pwsh）

`mountHostShellHiding` 里有一条历史判断：**受限会话（read-only / workspace-write）保留 `pwsh`**，
理由是"Windows 的 MSYS bash 在沙箱里起不来，两个都藏就没有 shell 了"。现在不成立了 ——
受限模式跑的是我们自装的 Niubash，在沙箱里能正常工作；再留着 `pwsh` 只是让模型在两个 shell 之间犹豫。

- 去掉按会话策略的分支：只要 shell 族挂上了（⇒ 运行时可用的前提），就统一 deny `pwsh` / `pwsh_persistent`。
- 回归改成"受限会话也隐藏 pwsh"。

全量 **1,601** 条断言通过；`check-package` 62/62；schema 不变（35,350 B）。

## 0.9.2 — 2026-11-10（闸门必须带 session 解析策略）

v0.9.0/0.9.1 的闸门是拿 `sandboxPolicy.resolve()` **不带参数**问的，宿主这时返回的是**默认策略**：
`workspaceRoot` = profile 目录（`…\.dsh\profiles\desktop`），而不是本次会话的工作区。
后果：在 workspace-write 会话里，**工作区内的正常写入被误判成越界**并拒绝（实测 `D:\DshWorkSpace\Addons` 下写文件被拒）。

- `file` / `ast_edit` / `checkpoint`(restore) / `download` 现在都把 `execute(args, exec)` 里的
  `exec.agent.session` 传给闸门，`resolve({ session })` 才能拿到会话级策略（`workspaceRoot` = 会话工作区）。
- 新增 3 条回归：`assertWritableTargets` 确实把 `session` 透传给 `sandboxPolicy.resolve`；
  文件工具带/不带 `exec` 会得到不同策略（read-only vs 宽松）。
- 顺带记一笔：这是"**问宿主权限必须带上下文**"的又一处 —— 与 `sandbox.confine` 需要 `policy` 同源。

全量 **1,601** 条断言通过；`check-package` 62/62；schema 不变（35,350 B）。

## 0.9.1 — 2026-11-10（修正闸门自测的跨平台路径）

`guard-selftest` 里用 `process.env.USERPROFILE ?? root` 造“工作区外”路径 —— Linux 上没有 `USERPROFILE`，
退化成 tmpdir 下的目录，而 **tmpdir 本来就是可写根** ⇒ 误报 7 条失败（CI Ubuntu 红）。

- 改用 `homedir()`（Windows 是 `C:\Users\…`，Linux 是 `/home/runner`），两边都落在可写根之外；
- 注释说明为什么“工作区外”必须避开 tmpdir —— 宿主也把 `/tmp` 与 `os.tmpdir()` 算作可写根。

逻辑没变，只是测试路径选错了。

## 0.9.0 — 2026-11-10（写操作也遵守沙箱策略）

**修一个真缺口**：`bash` 会过 `sandbox.confine`（真正被关住），但 `file` / `ast_edit` / `checkpoint_restore` / `download`
是直接 `node:fs` 写盘，宿主自己的 fs 围栏（`@deepseek-ai/dsh-fs-sandbox`）管不到插件代码 —— 在 workspace-write 会话里
它们**能写到工作区之外**（实测：先在 `C:\Users\…` 写成功、再删成功，而同路径用 bash 写被拒）。

- 新增 `lib/guard.js`：与宿主同口径的 `writableRoots(policy)`（`workspaceRoot` + `additionalWritableRoots` + `/tmp` + `os.tmpdir()`），
  `read-only` 拒一切写，`workspace-write` 拒工作区外的目标，`danger-full-access` 不拦；拿不到策略服务则放行（由宿主兜底）。
  拒绝抛 `SandboxDeniedError`（`code = FS_SANDBOX_DENIED`），消息带宿主同款 `[sandbox: file access denied under <mode> mode]` 标记。
- 接线：`file`（write/edit/copy/move/remove/mkdir，以及 replace 真正落盘时按收集到的具体文件）、`ast_edit`（apply，预览不受限）、
  `checkpoint_restore`（显式 cwd 在碰快照**之前**就拦）、`download`（start 的 `to`）。
- 目标规范化用“父目录 realpath + 文件名”：新建文件不会因 8.3 短名/长名差异被误判成“不在可写根内”。
- 新增 `test/guard-selftest.mjs`（19 条）：判定规则、拒绝形状、`file`/`checkpoint` 接线、read-only 与 danger 边界。

全量 **1,598** 条断言通过；`check-package` 62/62；schema 不变（35,350 B）。

## 0.8.3 — 2026-11-10（精简回执：不再回显 bash 路径与沙箱模式）

运行时固定之后，回执里有三块信息变成了噪声：

- **首行不再带 `bash=<路径>`**：shell 已经是统一的，路径只在 `includeDiagnostics: true` 的 `diagnostics: bash=…` 里给。
- **不再每次都写 `[sandbox: <mode> / <enforcement>]`**：受限与非受限已经是同一套行为；只有真的被拒（`denied`）或运行器坏掉（`runnerFailed`）时才提示。
- **没有内容的流整段不出现**：以前空输出会写 `(empty)`，现在 stdout/stderr 哪个为空就不打哪一段（两者都空就只剩首行与末行的 `[exit code: N]`）。

现在的形状：

```text
ok=true  exitCode=0  timedOut=false  truncated=false  123ms
--- stdout ---
内容1
内容2
[exit code: 0]
```

末行的 `[exit code: N]` / `[killed by signal: X]` 保持不变（宿主 terminal 卡片靠它解析）。

## 0.8.2 — 2026-11-10（安装入口：国内加速源 + 去术语化文案）

- **两个下载源**：`mirror`（GitHub 反代 `ghfast.top`，失败自动试 `gh-proxy.com`）与 `github`（官方）。
  反代是第三方服务，但**归档 sha256 钉死** —— 改一个字节就拒绝安装，所以只影响可达性、不影响完整性。
  设置页对应两个按钮：「从国内加速安装」「从 GitHub 安装」；路由 `/dsh-toolkit/bash/runtime/install` 接受 `{"source":"mirror"|"github"}`（缺省 mirror）。
- **文案去术语化**：不再写「受限模式」「沙箱」「不需要 dsh-ops」这类措辞 —— bash 现在不分模式、由族开关控制，文案只说
  「还没有安装 bash 运行时（约 33 MB）。装好后即可在任意会话里使用 bash。」
- `EXECUTOR_UNAVAILABLE` 的提示同步收敛为「bash 运行时不可用（未安装或已损坏）→ 去设置页安装」，不再提 danger-full-access。
- 真机验证：`mirror` 11.4 s / `github` 4.2 s，两者都通过 sha256 校验并成功解包运行。

## 0.8.1 — 2026-11-10（运行时不在 ⇒ shell 族整个关闭，装好自动恢复）

- `apply()` 现在检查运行时：**没有就一个工具都不注册**（等价于族被关闭），不再出现"开关是开着的、
  调用才告诉你没运行时"这种状态。
- 缺运行时期间登记一个"装好就挂上"的回调：设置页下载完成 → 安装器回调 → **立即注册 bash**，不用重启宿主。
- 设置页：运行时未安装时开关显示为**关且禁用**（以前是"开但禁用"，既跑不了也关不掉）。
- 自测：新增 `apply()` 三条（无运行时 0 注册 / 有运行时 1 注册 / 重挂回调可执行与可清除），
  并把平台用例拆成"无运行时"与"有运行时"两条。

## 0.8.0 — 2026-11-10（统一 shell：只用我们自己的运行时）

**行为变化（有意的破坏性调整）**：`bash` 不再使用系统 Git Bash，也不再借用 dsh-ops 的运行时。
只认**我们自己的 Niubash**（`%LOCALAPPDATA%\dsh-toolkit
iubash\<版本>`，或离线包自带的
`runtime/niubash/<版本>`）；**没装就不启用**，设置页下载完成后才能用。

- 为什么：不同机器上的 bash 可能是 Git Bash / WSL / 各种魔改版，工具链与行为都不同；
  按"受限用 A、非受限用 B"更糟。统一到同一份已验证的运行时，两种模式体验才一致。
- `pickBash()` 只剩两个来源：显式 `DSH_TOOLKIT_BASH`（调试覆盖）→ 我们的 Niubash。
  `DSH_TOOLKIT_BASH_BACKEND` 已移除。`findBash()` 仅保留为诊断（"系统 Git Bash 在哪"），不参与选择。
- 没有运行时 ⇒ `EXECUTOR_UNAVAILABLE`（`effects: none`），回执直接提示去设置页下载。
- 清理：不再借用 dsh-ops（删掉探测与解析代码、以及过时的 `ops-runtime-selftest`）；
  `lib/shell/ops-runtime.js` 现在只回答"我们的运行时在哪"。
- 设置页：shell 行只显示运行时状态与「安装受限运行时」按钮；开关在有运行时前禁用（探测中不闪）。
- 自测：`bash` 相关用例通过 `bashPath` 显式指向系统 bash（调试覆盖），生产路径不受影响。

## 0.7.0 — 2026-11-10（运行时可选安装，装好后两种模式统一）

按使用者的口径校正：**运行时是可选安装项**（跟以前装 Git Bash 一样，用户点按钮才装），
但**装上之后，受不受限两种模式都用它** —— 用户机器上的 bash 可能是 Git Bash / WSL / 某个魔改版，
行为不一致；我们自己验证过的那个 shell 才是可控的。

- **不再随 npm 包发布载荷**（不做 prepack、`files` 不含 `runtime/`）：装插件时不会被塞 62 MB。
  `runtime/niubash/<版本>` 只保留给"离线包/内网镜像"自己塞载荷用，命中就零下载。
- **`pickBash()` 统一选 shell**：显式 `DSH_TOOLKIT_BASH` > 已装的 Niubash（包内 → 用户级缓存）> 系统 Git Bash。
  `DSH_TOOLKIT_BASH_BACKEND=git|niubash` 可强制后端；`findBash()` 仍只回答"系统 Git Bash 在哪"（设置页/安装流程用）。
- Niubash 的 `NIU_ROOT` / `PATH` 前缀随 spawn 注入（否则 niu 找不到自己的 winuxcmd 工具链）。
- 设置页：Git Bash 与受限运行时**有任意一个**就能打开 shell 族开关（以前只认 Git Bash，装了 Niubash 也开不了）。
- 回归：`pickBash` 三条（装了就用它 / 强制 git / 没装回落）、开关门禁两条。

## 0.6.1 — 2026-11-10（下载目录不能落在安装根下）

CI（Ubuntu）暴露的小问题：`installNiubash` 把归档下到 `%TEMP%`，Linux 上没有 `TEMP`/`TMP` 时退化成**安装根目录**，于是"哈希不符 ⇒ 未安装"这条失败路径会留下一个空的 `niubash/1.5.0` 目录 —— 看起来像装了一半。

- 改成在 `os.tmpdir()` 里 `mkdtemp` 一个独立工作目录放归档，结束时整目录删掉；
- 安装失败不再创建/留下安装根。

## 0.6.0 — 2026-11-10（不依赖 dsh-ops：自带受限运行时）

**方向修正**：dsh-toolkit 是独立插件，**没装 dsh-ops 才是常态**。此前 Windows 受限模式（workspace-write / read-only）完全依赖 dsh-ops 的受限运行时，等于把"最常见的场景"绑在一个可选包上。

- **新增 `lib/shell/niubash.js`**：自己下载 + 校验 + 解压 **Niubash 1.5.0**（原生 Windows shell，能直接在宿主沙箱里跑）。
  - 归档 **sha256 钉死**（`da28cdc4…`，32,931,587 B），校验不过直接丢弃、不安装；
  - 解包器是自带的 tar.gz 读取（不 spawn `tar`）：**只写普通文件/目录/硬链接**，拒绝绝对路径、`..`、符号链接，硬链接目标也做越界检查；
  - 装到用户级 `%LOCALAPPDATA%\dsh-toolkit
iubash.5.0`，先解到 staging 再原子换上去；
  - 校验结果写进 `.dsh-toolkit-niubash.json`（size + mtime + sha256），**之后不再重复哈希 33 MB**；exe 变了会自动重算。
- **解析顺序改为**：① 自己装的 Niubash → ② 借 dsh-ops（Niubash / 钉住 MSYS）→ ③ 都没有则 `EXECUTOR_UNAVAILABLE`（fail-closed）。② 只是"装了 dsh-ops 就省一次下载"的快捷方式。
- **设置页**新增「安装受限运行时」按钮（`/dsh-toolkit/bash/runtime/{status,install}`，约 33 MB，GitHub 源），bash 行下显示是否就绪；`bashStatus()` 里带 `runtime` 字段。
- 报错信息改为引导用户装运行时（不再说"去修 dsh-ops"）。
- 真机验证：下载 + 校验 + 解包 + 运行 **3.3 s**，`niu.exe -c 'echo/uname/gawk'` 全部正常。
- 新增 `test/niubash-selftest.mjs`（17 条）：解包、硬链接、越界/符号链接拒绝、哈希不符丢弃、标记缓存、以及"dsh-ops 不存在也能解析出运行时"。

## 0.5.1 — 2026-11-10（Niubash 用满一次就被判"不可信"）

实战发现：Niubash **第一次执行**会自己在载荷目录里建 `winuxcmd/dev`（运行时目录），而 dsh-ops 0.5.2 的整树校验只认"压缩包里出现过的目录" ⇒ 此后 `verifiedNiubash` **永远失败**（收据里的 `winuxcmd/dev` 只在 prepare 阶段创建，npm 包不带空目录）。表现就是：受限模式第一次能用，之后 `EXECUTOR_UNAVAILABLE`。

- 现在整树校验失败时，退一步只校验**真正被执行的东西**：`niu.exe` 的 sha256 必须等于收据里的 `executableSha256`（`integrity: 'executable'`），其余运行时目录不参与判定。安全性不打折——跑的就是这个 exe，哈希对不上照样拒绝并退回 MSYS。
- 新增两条回归：整树失败但 exe 哈希对得上 ⇒ 仍用 Niubash；exe 被改过 ⇒ 拒绝该载荷（退回 MSYS）。
- `ops-runtime-selftest` 的假包按真实布局生成了 `provenance.json` 与 `winuxcmd/dev/shm`，覆盖"跑过一次"的状态。

## 0.5.0 — 2026-11-10（对齐 dsh-ops 0.5.x：Niubash 后端 + 宿主 DSH 环境 + 参数级错误码）

读了 dsh-ops 0.5.2 的 bash 实现（Niubash 已取代 PortGit 成为默认 Windows 载荷），把值得我们学的四点落地：

- **受限运行时支持 Niubash**（关键兼容）：0.5.x 起 dsh-ops 的默认后端是 **Niubash 1.5.0**，钉住的 MSYS 降级为 legacy。
  `lib/shell/ops-runtime.js` 现在**按顺序探测**：`lib/niubash/runtime.js` 的 `niubashCandidates` + `verifiedNiubash`（首次在 `DSH_HOME/dsh-ops/shells/niubash-prepared/<hash>` 准备一份副本并复用）→ 失败再退回 `lib/bash-ipc.js` 的 `confinedBash`（0.4.x 的钉住 MSYS + IPC 补丁）→ 都没有则 `null`（调用方 fail-closed）。
  否则一旦升级到 0.5.x，受限模式（workspace-write / read-only）会直接 `EXECUTOR_UNAVAILABLE`。
- **注入宿主 `ctx.shellEnv`**（照 ops 的 `collect(exec)`）：子进程现在能拿到 `DSH_HOME` / `DSH_SHELL` / `DSH_SESSION_ID` / `DSH_PROFILE` 等宿主管辖变量，脚本可以识别"我在 DSH 里跑"。
- **参数错误的独立错误码**：`command`/`script_path` 冲突、脚本不存在、空命令等**未起进程**的失败现在报 `INVALID_BASH_ARGUMENT`（`effects: none`、`retry: after-input-change`），不再混进 `SPAWN_FAILED`。
- **`effectState` 更准**：区分"根本没起进程"（`none`）与"起了进程但结果未知"（`unknown`），照 ops 用 `process.started` 的思路。
- 新增 `test/ops-runtime-selftest.mjs`（8 条）：用假 dsh-ops 包钉住三条分支（Niubash 优先 / 校验失败退回 MSYS / 都没有 ⇒ null / 非 win32 ⇒ null）。

全量 **1,552** 条断言通过；`check-package` 62/62；schema 不变（35,350 B）。

## 0.4.5 — 2026-11-10（并发用例改成断言真不变量）

CI（Windows / Node 24）上 `robustness` 的并发写用例偶发 **四个进程全被拒**（`codes=3,3,3,3`）：文件仍是原文、没有被写坏，属于**安全的**并发结局，但"恰好一个成功"必然变红。

- 断言改为真正的安全不变量：**最多一个写成功**、文件只能是「原文」或「完整改完」（不能交错/半截）、有成功者时内容必须完整改完；
- 全员被拒时**自动重试一轮**（还原原文后重跑），把"环境抖动"与"锁机制真失效"分开；
- 保留原有断言：无子进程异常退出、争用方必须给 LOCK/STALE 或 `effect=none|unknown` 的 OTHER、无残留临时文件/锁。
- 仅测试改动，运行时行为不变。

## 0.4.4 — 2026-11-10（审计补漏：0 命中的原因要能到达模型）

- `file` 的 `replace` 工具级回执以前会把 **0 命中的文件整行丢掉** ⇒ 「二进制跳过」「多行 pattern 请用 edit」「GB18030 未命中」这些 module 层写好的提示**永远到不了模型**，模型只看到「0 个文件 / 0 处」而以为文件里真的没有。
- 现在把 0 命中的 `message` 汇总进回执（同一原因合并、每类最多列 3 个路径）。
- 回归：工具级 `replace` 扫目录（含 CRLF 文件 + 二进制）时，回执必须出现「请用 edit」与「二进制文件，跳过」。

## 0.4.3 — 2026-11-10（对 shell / file 新功能的审计修复）

审了一遍 0.4.0–0.4.2 新加的能力（套件绿但边界没覆盖），修了 7 处：

**`file diff`**
- **二进制文件不再输出乱码 hunk**：先看 BOM 再判 NUL，命中就拒绝并指向 `file read` 的 hex 预览。
- **旧文件加 8 MB 上限**（以前整文件读入内存，大文件会吃掉内存）。
- **编码差异说清**：GB18030 / UTF-16 文件即使“行内容相同”，也明说「write 只写 UTF-8，落盘会整体重编码」，不再笼统归因于“换行符或 BOM 差异”。
- 换行差异改为具体描述（文件 LF → 写入 CRLF），offset 越界/missing path/目录 给明确报错（不再静默返回空页）。

**`file` 的 `replace`**
- 行号按编辑器语义数（CRLF / CR / LF 都算换行，CR-only 文件不再全算第 1 行）。
- UTF-16 文件不再被当成二进制跳过（BOM 优先于 NUL 判定）。
- 多行 pattern 在 CRLF 文件未命中时，明确指向 `edit`（换行无关匹配）。

**`bash`**
- **执行器结算失败（`handle.done` reject）不再产生 unhandled rejection**（Node 15+ 会直接抛，可能打崩宿主）；现在归成结构化的 `SPAWN_FAILED` 并清掉定时器/轮询。
- 前台 `runBash` 抛异常时**也会收尾已登记的 job**（以前会永远挂在「后台任务」里）。

**审批**
- 当前模式不在可升级集合时 **拒绝**（不再因 `undefined < n` 比较而静默放行）。
- `sandbox_permissions` 与当前模式相同时**不再强制 `justification`**（对齐 ops 语义，不再拒绝合法调用）。
- 审批期间被取消 ⇒ 转成 `CANCELLED` 错误码，不再泄露 DOMException。

回归：diff 新增 6 条边界断言、replace 新增 3 条、bash 新增 3 条；全量 **1,535** 条通过。

## 0.4.2 — 2026-11-09（edit 换行无关匹配）

- **`file` 的 `edit` 现在换行无关**：匹配前把文件和 `oldText` 都归一到 LF（CRLF / 孤立 CR 都算换行），命中后按映射回原文件偏移，`newText` 再按文件**主 EOL** 写回。解决了“`read` 展示的是归一化后的行，模型照着写的 `oldText` 却因文件是 CRLF 而匹配不上”的报错（`oldText 在文件里找不到`）。
- 新增回归：CRLF 文件用 LF `oldText` 命中且写回仍是 CRLF；CR-only 文件按 CR 风格写回。

## 0.4.1 — 2026-11-09（换行语义修正）

- **`file` 的 `read` / `diff` 现在把孤立 `CR`（旧 Mac 换行）也当换行**：以前只按 `\r\n` / `\n` 切，CR-only 文件会被显示成一行、内容里的 `\r` 被转义成 `\u000d`，看起来就像“read 的换行和实际文件不一致”。现在与编辑器一致（CRLF / LF / 孤立 CR 都算换行），并补了 CR-only 与混合换行的回归断言。
- 宿主自带的 `read` 工具目前**仍**只认 `\n`（CR-only 文件显示为 1 行）；需要看真实行结构时用 `file(action:"read")`。

## 0.4.0 — 2026-11-06（shell 族 + `file diff` + 严格 provider 修复）

**🧩 新增 `shell` 族：`bash`（Windows 专用；`ops_bash` 的替代）**
- 执行交给宿主 `ctx.subprocess`：spawn / 终止升级（PGID + taskkill）/ 输出预算 / spill / 管道生命周期全由宿主管理，本插件只负责选 bash、组织 argv 与渲染；自建 spawn / pgid 文件 / taskkill 兜底已删除。
- 尊重 `sandboxPolicy` + `sandbox.confine`；新增 `sandbox_permissions` + `justification` 逐次升级：走宿主 `approval.request`，**批准前不执行**、批后复核（`AUTHORITY_CHANGED` 则作废）；审批不可用时不降级放行。
- 超时晋升为后台 `promoted`（不杀、不重跑）；前台命令登记为宿主 job（可单条停止，正常结束自动移除）；`run_in_background`（与宿主同名，`background` 为别名）**无默认执行超时**。
- 取消接宿主 `exec.signal`（点停止/结束会话 ⇒ 两路杀树 + 主动关管道）；子进程固定 `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never`，凭据过期会快速失败而不是挂住。
- 结果按宿主 terminal 卡片契约输出：`description` 必填、末行 `[exit code: N]` 或 `[killed by signal: SIGx]`；Windows 的 `signal<<8`（SIGTERM=3840 等）还原为信号名；`session/disposed` / `agent/disposed` 时收尾活任务。

**🧩 `file` 新增 `diff` 动作**
- `path` + `content` ⇒ 只读预览：公共前后缀按行修剪的**单个替换 hunk**，`offset`/`limit`/`context` 分页，old/new sha256 与行数；BOM / CRLF / 尾换行差异单独指出；永不写盘。
- `edit` / `write` 带 `dryRun:true` 现在**明确拒绝**（此前会静默写盘），预览统一走 `diff`。

**修复**
- 严格 provider（中转站 / new-api）因属性级布尔 `required: true` 拒绝整个请求（`true is not of type "array"`）：`toJsonSchema` 递归归一 + 回归断言（15 个工具的 parameters/output 里 `required` 必须是字符串数组）。
- 晋升任务的尾部输出丢失（进程结束前最后一块没有 flush）。
- 前台 job 在「后台任务」列表堆积「已结束」（`jobs.remove` 要求 owner + 终态，改为带 owner 重试）。
- Windows 信号退出码（`signal<<8`）显示为 3840 等数字，现还原为信号名。
- `ast_edit` / `file` 输出 schema 里的嵌套布尔 `required` 一并清洗。

**成本**
- 全量 schema **35,350 B**（`shell` 2,116 B、`file` 4,475 B）；常驻 **35,999 B ≈ 9,000 tok**；36 份自测 **1,516 条断言**。

## 0.3.0 — 2026-10-10（自研化：diff 引擎 + AST 改写引擎）

**🧩 新增 `file` 族：`file` 一个工具八个动作（2026-11-05，dsh-ops 文件族的替代）**
- 动作：`read` / `stat` / `write` / `edit` / `copy` / `move` / `remove` / `mkdir`（不传 `action` 按 `read`）。与 checkpoint/download 一样收敛成单工具，避免 8 份 schema 常驻。
- **read**：多文件（≤20）+ 多区间（`ranges:["1-40","120"]`）；编码探测 **BOM → 严格 UTF-8 → 严格 GB18030** 并回报依据（本工作区 MC 模组文本大量是 GBK）；二进制（前 8 KB 含 NUL）给 **hex 预览**；默认每文件 1 MB，超出提示用 ranges。
- **write / edit**：整文件 UTF-8（可带 BOM）；**原子写**（临时文件 + rename）；`edit` 的 `{oldText,newText}` 必须**唯一命中且互不重叠**，否则整单失败；按原编码写回、保留 BOM/CRLF；**GB18030 拒绝编辑**（不悄悄改编码）。
- **CAS**：`expectedRevision` = 上次回执的 sha256 或 `"absent"`；冲突回执带当前 revision。
- **copy / move**：默认不覆盖；move 跨卷退化为复制+删源并在回执说明。**remove**：默认只预览，`confirm:true` 才删（目录需 `recursive:true`），拒绝盘根/家目录。**mkdir / stat** 照常。
- 语义参考 **dsh-ops**（MIT，© 2026 T-Auto and the dsh-ops contributors；其实现是 Rust worker，本插件纯 JS 重写）⇒ 已在 `THIRD-PARTY-NOTICES.md` §1.3 保留许可全文并标注改动。
- **读取协议升级（同日，按 ops 的实战方案补）**：read 现在回 **整文件 revision**（读→改可直接 CAS）、**`complete`/`nextOffset`**（续读）、**`truncatedInLine`**（超长行被切到 2000 字符，与"没读完"分开）、**多文件共享 2 MB 总预算**、**`N|` 紧凑行号 + 可逆转义**、同目录 **`[Base: …]`**。**没有抄"上下文读取去重"**：它依赖宿主 `tools/result` + `llm/stream` 的证据链证明正文仍在最近一次请求里；拿不到这层证据就做，会在上下文压缩后悄悄吞内容。
- **`replace` 动作（同日，ops_replace 的替代）**：`pattern`（字面）+ `replacement`，对 `path`/`paths`（文件 / 目录 / glob）批量替换；**默认只预览**（`dryRun:true`），`dryRun:false` 才写；回执给命中处数、行号与写后 revision；二进制跳过、GB18030 命中拒绝、单次 ≤50 文件。
- **`read` 支持 `.docx` / `.xlsx` / `.pptx`（同日）**：`.docx` 按段落提取（还原 `&amp;` 等实体、`<w:tab/>`/`<w:br/>`）；`.xlsx` 读 sharedStrings + 每个工作表，输出 `[Sheet: 名称]` 与 `A1=值` 行（不计算公式，只给缓存值）；`.pptx` 按 `slideN.xml` 顺序提取 `<a:t>`。`ranges` 都按提取后的行算；**不做完整渲染**；`.pdf` 仍明确拒绝并指向 `office` 技能。
- **失败回执补 `effectState`（同日）**：`none` / `applied` / `unknown` —— 复制中途失败记 `unknown`，跨卷移动"复制成功但删源失败"记 `applied` 并明确写出，避免模型把"已经改了的东西"再改一遍。
- 成本：`file` 族 **3,182 B（796 tok）**；全量基线 29,783 → **32,987 B（+10.8%）**，已重冻。自测新增 `test/file-read-selftest.mjs`（28 条）与 `test/file-write-selftest.mjs`（26 条）⇒ **34 套件 + check-package 全绿，112.8 s**。

**🧩 新增 `shell` 族：`bash`（2026-11-05，内核 0.2.2 移除 `ops_bash` 后的自建替代）**
- 背景：内核 0.2.2-rc.1 把 `ops_bash` 整组移除 ⇒ `dsh-ops` 的 shell 组件直接报废（它包装的正是那个内核工具）。② 线先做了 `bash` 的规格与参考实现（12 项验收全过）并移交 ①；本插件复刻其行为、补上工具契约自测。
- 实现要点（四个实测坑，别"优化"）：`bash -c` 而不是 `-lc`（81 ms vs 206 ms，Git Bash 非登录 shell 的 PATH 里已有 coreutils）；超时用 `taskkill /T /F` 杀**整棵进程树**（`child.kill()` 只杀直接子进程，`sleep` 孙进程会把 promise 拖到 5 s+；POSIX 上改为 `detached` + 负 PID 杀进程组）；删掉继承的 `PWD`/`OLDPWD`（否则 `pwd` 说谎）；强制 `LC_ALL=C.UTF-8`（否则中文乱码）。
- 契约：参数 `command`（必填）/ `cwd`（缺省 = 会话工作区）/ `timeoutMs`（默认 60 s，最大 600 s）；返回头部（`ok` / `exitCode` / `timedOut` / `truncated` / 耗时 / bash 路径）+ **原样**的 stdout 与 stderr；输出上限 2 MB。找不到 bash ⇒ 明确报错并提示装 Git for Windows，**绝不自动下载**（ops 那 392 MB 的 PortableGit 就是这么来的）。
- 成本：`shell` 族 schema **1,043 B（261 tok）**（默认关闭 ⇒ 不用 bash 的会话一分不付）；全量基线 28,732 → **29,783 B（+3.66%）**，已按流程重冻（见 `docs/schema-measurement.md`）。
- 自测：新增 `test/bash-selftest.mjs`（28 条：12 项行为验收 + 工具形状/投影/平台分支）⇒ 全量 **32 套件 + check-package 全绿，110 s**。
- **超时收尾两处修复（同日，② 线验收带出）**：
  ① 原来只监听 `close` —— 孙进程占着 stdout 管道时 `close` 永不触发，`timeoutMs:2000` 被兜底定时器抬到 **4.2 s**；改为 `exit` 后给 100 ms 收尾（`close` 先到则立即收尾）。
  ② MSYS 的 `fork` 会让子进程的 **Windows PPID 指向已退出的辅助进程** ⇒ `taskkill /T`（按 PPID 遍历）抓不到 `sleep 45; echo done` 的 sleep，超时后它留在后台；改为运行时把 **MSYS 进程组号**写进临时文件，超时先 `kill -9 -<pgid>`、再用 `taskkill /T` 兜底。
  验收：`sleep 45` + `timeoutMs:2000` ⇒ **约 2.3 s 返回、零残留**（复合命令/管道/后台任务三组都验）；自测补「超时后检查残留进程」与后台任务两条断言。
- 文档：`docs/TOOLKIT.md` 新增 `## shell`（含四条限制：非交互/无 PTY/MSYS 根映射/路径转换）；README ×2、locale ×2、设置页文案同步为"六族 14 个工具 / 6 个开关"。
- **一键安装 + 开关自锁**：设置页「Bash 执行器」行右侧给**两个安装按钮**（国内镜像 npmmirror / GitHub 官方，**不做代理探测**，用户自己选）；装的是**用户级 PortableGit**（`%LOCALAPPDATA%\dsh-toolkit\git`，`PortableGit-*.7z.exe -y -o<dir>` 静默解压，实测 60 MB / 2.7 s 下载 + 11.7 s 解压），装完删安装包并**重新探测**（不信退出码）。
  宿主经 `webServer` 注册 `/dsh-toolkit/bash/{status,install}`（`install` 仅 POST + 同源校验）；客户端探测不到 bash 时**禁用该开关**并显示原因/按钮。实现：`lib/shell/{sources,install,routes}.js` + `lib/client.js`。
- **上游跟踪（同日）**：读到 dsh-ops 的 PR #653（`restrict()` 只能遮全局名，own-scope 注册遮不住）与 #659（外部所有的 workspace 只要已授予 `WRITE_OWNER` 就应放行）—— 前者对应我们的 `host-shell`，已给永久失败加去重（同一 agent 只记一次、不重试）；后者正是本机 `dsh-toolkit` 缺 Low 完整性标签的同类问题（外来所有者），报错与修法见 TOOLKIT。
- **修复：晋升任务的尾部输出丢失（同日）**：宿主路径靠 80 ms 轮询喂 job 缓冲，进程结束时最后一块没补交（实测 `promote-end` 丢）。结束/晋升时先 `flushChunks()` 再停轮询。
- **`edit`/`write` 的 `dryRun` 护栏（同日）**：`dryRun` 只对 `replace`/`remove` 生效；`edit`/`write` 等带 `dryRun:true` 时**明确拒绝**（之前会静默写盘），预览改走 `action:"diff"`。
- **修复：嵌套布尔 `required` 让严格 provider 全会话失败（2026-11-06）**：属性里的 `required: true` 被原样透传给 provider ⇒ 中转站/new-api 返回「true is not of type "array"」、整轮 `INVALID_REQUEST`（官方渠道宽松所以看不出）。现在 `toJsonSchema` 递归归一：任何层级的布尔 `required` 上提为数组；同时清掉 `file`/`ast_edit` 源码里的冗余布尔，并新增「所有工具 parameters + output 的 required 必须是数组」的回归断言。
- **`file` 新增 `diff`（同日）**：文件 vs 拟写入内容的只读预览——公共前缀/后缀按行修剪后**单个替换 hunk**（非最小 diff），带 old/new sha256 与行数，`offset`/`limit`/`context` 分页；BOM/CRLF/尾换行差异单独指出；永不写盘。
- **Windows 信号解码（同日）**：MSYS 把被杀编码成 `signal<<8`（SIGTERM=3840…）；现在还原为 `signal=SIGTERM` + `[killed by signal: SIGTERM]`，不再出现 3840 这种数字，并保留 `rawExitCode`。
- **后台参数对齐 + 无超时（同日）**：新增 `run_in_background`（宿主 UI 据此识别后台卡片），`background` 作为别名；后台任务不再套默认 60 s 超时（显式 `timeoutMs` 仍生效）。
- **执行层交给宿主（同日，#2 收口）**：删除自建 spawn / pgid 文件 / taskkill 兜底（约 200 行），全部交给 `ctx.subprocess.spawn`（终止升级/输出预算/spill/管道由宿主管理）；我们只留 argv 与渲染，自测改用同契约的本地替身。
- **terminal 卡片契约（同日）**：`description` 改为必填；回执末尾追加 `[exit code: N]`/`[killed by signal: X]`，让宿主客户端把 bash 结果渲染成 terminal 卡片并显示正确退出码（原来缺这行会永远显示 0）。
- **修复：前台命令在「后台任务」里堆积“已结束”（同日）**：宿主 `jobs.remove(id, caller)` 要求**已终态 + 正确 owner**；原来不带 owner、结算瞬间就调用，异常被吞 ⇒ 37 条残留。改为带 owner、50 ms 重试到终态。历史残留需手动「清空」，之后不再增长。
- **逐次升级审批（同日，照 ops）**：`bash` 新增 `sandbox_permissions`+`justification`；走宿主 `approval.request`，批准前不执行、批后复核（`AUTHORITY_CHANGED`），失败码 `APPROVAL_*`。
- **生命周期收尾（同日）**：`session/disposed`/`agent/disposed` 时 kill 还活着的任务（promoted 不再残留）。
- **前台命令登记为 job（同日）**：每条前台命令先 `jobs.start`（后台任务列表可见、可单独停止），正常结束 `jobs.remove`，到点未完成则变成 promoted 留在列表；配合 `exec.signal` 就能“停命令不中断会话”。
- **可取消 + git 非交互（同日，修 MCMOD 现场问题）**：前台/后台都接宿主的 `exec.signal`（停止/结束会话）⇒ 两路杀树 + 关管道，回执 `[aborted]` + `failure: CANCELLED`；`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`，`git push` 等不再卡在凭据弹窗里。
- **bash schema 压缩 + spill 上限 + 失败契约（同日）**：描述与参数说明瘦身，`bash` 2,580 → **1,604 B（-38%）**，全量 35,311 → **34,335 B（-976 B）**；spill 封顶 64 MB（`spillTruncated`）；失败追加 `failure{code,effectState,retry,nextAction}` 与 `[aborted]`。
- **中途晋升为后台（同日，照 ops 的 promoted）**：前台命令到 `timeoutMs` 仍未结束时**不杀**，改为转成宿主后台任务并回 `kind=promoted` + `jobId` + 已产生的部分输出；长任务不必取消重跑。无 `jobs` 服务时维持原行为（杀树 + `timedOut`）。
- **环境净化（同日，照 ops）**：子进程固定 `NO_COLOR`/`TERM=dumb`/`PAGER=cat`/`GIT_PAGER=cat`/`LC_MESSAGES=C`，`LC_ALL=C.UTF-8`；无 ANSI、不会被分页器挂住，中文仍按字符计数。
- **平台收口修正（同日）**：POSIX 上不再「注册后让位」，而是把 `shell` 族**直接判为不可用**（`familyEnabled` 返回 false），设置页开关禁用并提示「宿主自带 bash 接管」。Linux 上不需要本插件插一脚。
- **平台收口（同日）**：`bash` 只在 Windows 注册；POSIX 上宿主自带 `bash`，同名会撞车 ⇒ `apply()` 直接让位（返回 0）。顺带确认了宿主 UI 的工具标题机制：`TOOL_VARIANTS` 把 `bash`/`pwsh` 映射到「运行命令」，未知名字（如 `ops_bash`）落到「调用工具」。
- **沙箱闸门（同日）**：非 `danger-full-access` 会话现在必须过宿主 `sandboxPolicy.resolve` + `sandbox.confine`，用受限 argv 执行；拿不到 confinement 或结果无效 ⇒ **拒绝执行**（`SANDBOX_UNAVAILABLE`，命令未跑）。
  **Windows 受限模式**：系统 Git Bash 在沙箱里起不来（MSYS 信号管道被拒，`0xC0000142`）⇒ **复用 dsh-ops 的私有 MSYS**（`confinedBash()` + `@dsh-ops/bash-win32-x64`，首次约 174 MB 复制量）再走 `sandbox.confine`；dsh-ops 缺失时明确拒绝。受限会话**不再隐藏 pwsh**（否则一个 shell 都没有）。
  退出码非 0 且命中 `denialSignatures` ⇒ 回执标 `[sandbox: file access denied under <mode> mode]`。此前直接 `child_process` 起进程，在受限会话里等于绕过沙箱。
- **后台任务（同日）**：`background:true` 时把命令交给宿主 `jobs` 服务（`kind:'bash'`、label、owner、stdout/stderr 读取器），立即返回 `jobId`，由宿主 `job_output`/`job_kill` 接管；无 `jobs` 服务时明确报错。
  `runBash` 顺带支持 `signal` 取消与 `onChunk` 流回调（取消走与超时相同的两路杀进程树）。
- **参数面对齐 ops_bash（同日）**：补 `script_path`（跑现成 `.sh`，与 `command` 二选一）、`workdir`（`cwd` 别名）、`description`、`graceMs`、`includeDiagnostics`；
  输出超上限时不再静默丢弃，**完整输出落盘**并回 `spillPath`。差异仍写明：无后台/晋升任务（`jobId`）、无 PTY、不经宿主 sandbox/subprocess 服务。
- **隐藏宿主 `pwsh`（同日，照 ops 的 shell replacement）**：Windows 上开启 shell 族且检测到 bash ⇒ 按会话 `tools.restrict({ deny: ['pwsh','pwsh_persistent'] })`，只隐藏不卸载、会话销毁/插件卸载自动还原；**bash 不可用时不隐藏**。省掉两个 shell 工具的常驻 schema，也避免模型在两者之间犹豫。实现：`lib/shell/host-shell.js`。

**✅ 在 DSH NEXT 2.0.22 / 内核 0.2.2-rc.1 上复验通过（2026-11-05）**
- 不需要改代码：`engines.dsh = ">=0.2.0-rc.2 <0.3.0-0"` 原样覆盖 0.2.2-rc.1；真宿主七段 `apply ok`、六族工具逐一实调通过。
- 0.2.2 把 `ops_bash` / `ops_read` / `ops_write` / `ops_grep` / `ops_glob` / `ops_discover_tools` 整组从内核移除 —— 本插件从未使用，0 影响（`dsh-ops` 因此不可用，与本插件无关）。
- 自测：**31 套件 + `bin/check-package.mjs` 全绿，85.1 s**（Node 26，`--all`）；同步面 83 文件 0 差异。核查：`docs\2026-11-05-kernel-0.2.2-adapt\LOG.md`。
- ⚠️ 开发回路前提：会话文件策略须为 **danger-full-access** —— workspace-write 下嵌套 spawn+pipe 会 EPERM，`bin/install-toolkit.mjs` 与 `test-changed` 都会停在同步这一步（不是代码 bug）。

**🔴 兼容性修复：Node 26 改变了 zstd 多帧语义 ⇒ 我们的逐帧解码退化成 O(n²)，能把整机打崩（2026-10-30）**
- 起因：重装系统后宿主换成 **DSH NEXT 2.0.21**（Node **26**），跑全量自测从 30 s 变成 350 s，随后两次把 **64 GB 提交内存**吃满、宿主被系统杀掉。
- 根因：`zstdDecompressSync(buf.subarray(off))` 在 Node 22 上"解一帧就停"，在 **Node 26 上会从该偏移一直解到缓冲区末尾**。
  旧代码对每个帧偏移都调一次并把结果拼起来 ⇒ 第 k 帧被重复解 (n−k) 次：时间/内存都是 **O(n²)**（44 MB / 27,533 帧的会话足以吃满 64 GB）。
  症状极具欺骗性（先是"变慢/换页"，再是"驱动崩溃式重启"），一度被误判成磁盘/驱动问题。
- 修法：**按帧切片** —— 帧 k 的压缩字节 = `buf[off_k, off_{k+1})`，每次只解一帧；载荷内假魔数切断真帧时把边界后扩一帧重试（≤4 次）。
  另外给单帧解压加 `maxOutputLength = 64 MB`（假帧头声明巨大内容长度时变成普通解码失败，不再狂分配）。
- 实测（同一台机、同一个 44.6 MB 会话）：`scanEvents` **1133 ms / RSS 167 MB**（修复前分钟级 + 数十 GB）、`decodeSessionTail(5)` **18 ms**、
  `session_export` **1.5 s / RSS 203 MB / 输出 157.6 MB**。`decodeSessionFile` 增加 **32 MB 上限**（超限报错并指路 tail/pattern/export）。
- 自测侧同时补护栏：真实文件的"全量解码"与"真实导出"在 >4 MB 时 SKIP（改由合成语料覆盖），另加 4 条多帧回归（7 事件 4 帧不重复 / 扫描一致 / 尾读一致 / 超限拒绝）。
- 修复后全量：**31 份 / 1247 passed / 0 failed / 0 非零退出 / 54.8 s（2 路并发）**。核查报告：`docs\\2026-10-30-dsh-next-node26-compat\\LOG.md`。
- 同批：`dsh.client.inject` 补 `dsh-client-locale` / `dsh-client-ui-slots`（NEXT 的客户端包名）。
  **兼容性比的是内核版本**：NEXT 桌面壳是 2.0.21-next，但它内置的 `@deepseek-ai/dsh`（内核，也是 `dsh --version` 输出的那个）是 **0.2.1-rc.4** —— 闸门、`engines.dsh`、豁免表都按内核算，所以这里的区间保持 0.2.x 线（曾一度改宽到 `<3.0.0-0`，是拿桌面版本号比错了对象，已改回）。
**📚 会话族扩展：跨会话检索 + 列表谓词/重列 —— 合并进现有 2 个工具，0 新增（2026-10-24）**

- 需求来自 ② 的提案（`sessions\dsh-troubleshoot\docs\2026-10-24-session-tools-proposal\PROPOSAL.md`）；用户偏置是**能合并就别新增**。
  评估（`docs\2026-10-24-session-tools-eval\EVAL.md`）支持这个偏置：合并 +1,266 B（+4.62%），而按提案造 2 个新工具要 +1,456 B（对照组 description 还写得更短），且多 2 个动词。
- **`session_read` 加 `scope: session|workspace|all`**（默认 session）：`pattern` 的语义从"一个会话内"扩到"跨会话检索"，按会话分组输出「显示 N / 共 M」，
  双上限（`limit` 总命中 / `maxHitsPerSession` 每会话）+ **10 s 时间预算**，提前结束必须外显原因。实测：本工作区 3 份 / 7.7 万事件 **2.9 s**；全库首扫 12.7 s。
- **`session_list` 加 `where` / `fields` / `sort` / `offset`**：谓词 `empty / noTitle / olderThanDays / minBytes / maxBytes / integrity`；重列（events / turns / messages / title / integrity / lastUserAt）**按需**计算，
  结果按 **路径+大小+mtime** 缓存到 `$DSH_HOME/dsh-toolkit/session-index.json`（全库首扫 12.7 s → 命中缓存只 stat **0.8 ms**）。
- **`integrity` 语义（上线后按真数据两次修正）**：`seq` 在不同日志里是**三套计数** —— v4 顶层会话=会话内连续、子代理会话=父会话计数、
  早于 v4 的日志=**宿主全局计数**（实测一份 16.9 万事件的会话 seq 一路跳到 **2,494,494**，而它能完整解码、`session_read` 照常可用）。
  ⇒ **"缺号"根本不是健康信号**：`integrity` 只保留 `torn`（坏帧/坏行）与 `unreadable`（读不出事件），传 `gaps` 会被**引导拒绝**。
  教训：结构判据必须先在真实语料上跑一遍再暴露 —— 否则"体检"会稳定输出几百万条噪音，比不做更糟。
- **schema**：27,408 → **28,674 B（+4.62%）**，总闸门仍 PASS；`session_list` 1,073 → **2,277 B**（吸收了谓词与重列）⇒ 单件闸门**有记录地重冻** `baseline`/`current`；
  同时瘦身 `session_diff` / `session_export` 描述（−217 B）。真分词器 6,564 → **6,907 tok/轮（+343）**。
- 自测 +11 条（合成语料）：`where.empty`、重列与缓存命中、**"seq 缺号仍判 ok"与"坏帧判 torn"**、`gaps` 被引导拒绝、`scope=all` 分组与每会话上限、`scope=workspace`、无 `pattern` 拒绝、`offset` 分页。
- **姿势测试（把参数错用一遍；判据同 `postures`：清晰报错可接受，静默错/静默空必须修）**：
  探针 `sessions\dsh-plugin\docs\2026-10-24-session-tools-eval\postures-probe.mjs` 打出 **6 类静默失败**，已全部改成显式拒绝 ——
  `where` 给数组（标了 `[filtered]` 却什么都没筛）、`where.empty:"yes"`（字符串当布尔 ⇒ 静默不筛）、
  `olderThanDays:"abc"`（NaN 比较恒 false ⇒ **静默空结果**）、负年龄、`minBytes > maxBytes`（区间反了）、
  `fields:"id"`（字符串当数组 ⇒ 静默回落到默认列）、`fields:["bogus"]`（打出 `bogus=?`）、`sort`/`offset` 类型错。
  现在全部报错并列出可用值；`[filtered]` 只在 `where` 真有谓词时出现；空结果会回显"本轮的 where"；跨会话检索补了 `flags` 里 g/y 被剥掉的说明。自测 +11 条。
- ⚠️ 需要**重启宿主**才生效（宿主缓存宿主侧模块）。

**🛡️ 给 schema 加一道「用途底线」：压 token 可以，压掉"能用在什么地方"不行（2026-10-20）**
- 起因：讨论"schema 一压再压，token 是少了，但模型会不会根本不知道这工具能用在哪、于是完全不调用"。先把账摊开（DeepSeek 分词器）：
  常驻 6,545 tok 里 **参数说明 4,777（73%）**、**描述里的用途句 ~1,045（16%）**、原理 141（2%）、示例 **0**（早搬进 `toolkit_help`）
  ⇒ 继续压**必然先压到用途**，而可压的上限只有 2%。
- 新增 `test/schema-purpose-selftest.mjs`（49 条断言，0.3 s）：① 每个工具的描述必须命中登记过的**用途正则**；
  ② `action` 枚举里每个动作都要在描述里出现（枚举 = 模型的动词表，藏一个动作模型就想不到它）；
  ③ 每个参数都要有非空说明；④ 每个工具有**冻结的字节地板**（描述短 10% 即红）；⑤ 注册面必须与用途表完全一致（**加工具却不写"它能用在哪"直接红**）。
  已进 `scripts/test-changed.mjs` 的**每次必跑**全局门（与 docs-claims / toolkit-help / output-contract / check-package 并列）。
- 顺手补了唯一一处空说明：`ast_dump_tree.language`（`Parser for code（必填，裸片段不猜语言）`）。总量 27,321 → **27,408 B（+0.32%）**、真分词器 6,545 → **6,564 tok/轮（+19）**，在 +5% 预算内。
- 新增 `scripts/tool-usage.mjs` + `docs/tool-usage-baseline.json`：**调用率回看** —— 扫本工作区最近 N 份会话日志，
  按"每千次供应商请求"算每个工具被调了几次并与基线比，**归零或腰斩就告警**。把"压缩会不会害到可发现性"变成可观测，
  而不是靠印象（基线：8 份会话 / 10,382 请求；`ast_edit` 10.8、`download` 7.7、`table_diff` 2.7 / 千请求）。
- 顺带修了 Linux 自测运行器的一个真 bug：`wsl-selftest.sh` 里 `--log` / `--repeat` **不带值**时无条件 `shift 2`，
  dash 下直接报 `shift: can't shift that many`、整轮跑不起来 —— 现在缺值就按默认走。

**🔌 路由段"消失"的真因：宿主服务晚一步就绪（2026-10-20，重启后发现）**
- 现象：`~.dshdsh-toolkit_toolkit-load.log` 里同一台机器两次 boot —— 14:47 记 `routing section registered`、
  15:15 记 `systemPrompt.section unavailable; routing section skipped`。后者意味着**整个会话**都没有那段
  "任务 → 工具"的路由提示，而它正是"这工具能用在哪"的显式说明（可发现性，不是装饰）。
- 原因：`ctx.inject(['systemPrompt'], cb)` 的回调在启动早期就会跑，**服务对象在、`section()` 还没挂上**；
  我们是一次性判断 ⇒ 错过就永久跳过。
- 修复：`lib/routing.js` 新增 `retryRegister` —— 立刻试一次 → 失败按 150/600/2000 ms 重试 → 成功即停，
  全失败才记一次 `skipped (N attempts)`；`attempt` 抛异常按"还没就绪"处理（不许炸掉 apply）。
  信标现在带 `attempt N`，以后从日志就能看出它等了多久才拿到服务。
- 自测：`host-surface` 补 6 条断言（立刻成功 / 晚到两次后成功 / 全失败只报一次 / attempt 抛异常不外抛 / 用 delays[0]），
  注入调度器、不真等时间。

**🧪 换角度测 `diff`：抓到 1 个真 bug + 补 18 条断言；顺手把 `ast_test_rule` 的输出压了 91%（2026-10-20）**
- **新加的测试角度**（原来只测"正常路径"）：
  1. **写盘一致性**（最强不变量）：`diff` 报的 `after.revision` 必须等于"真写进去之后的 sha256" —— 普通文件与 **BOM 文件**各一条，写完再 diff 必须 `identical`（闭环）；
  2. **无副作用**：diff 前后文件**字节与 mtime 都不动**、目录里不留临时文件/锁；
  3. **极端输入**：`content` 为空（报全删）/ 空文件+空内容（identical）/ 无结尾换行 / 纯空白改动 / LF 文件 + CRLF 内容（`eolOnly`）/ emoji 与中文（字节数按 UTF-8）/ **2 万字符单行** / **`content` 里带 NUL**；
  4. **大 diff**：超 240 行 ⇒ `truncated` + "另有 N 行未展示"；**中间窗口过大 ⇒ `approximate: true`**（不假装做过行对齐）；
  5. **确定性与路径形态**：同一调用两次渲染逐字节一致；同一文件写两遍（去重后照常）；正斜杠路径；
  6. **参数护栏**（原有）。
- **抓到的真 bug**：只差**结尾换行**时，行引擎把它当成"增删一个空行"，于是我们走到普通 diff 分支、渲染出一行看不懂的 `+0 −1 行`；
  更早的版本甚至会直接说"无差异"，而 `after.revision` 明明变了 —— 对"写前预览"是误导。
  现在**按文本判**（`stripTrail` 相等 ⇒ `tailOnly`），单独报"仅结尾换行不同"，并且 `identical` 只在正文与行尾都相同时才为真。
- **`ast_test_rule` 的渲染压缩**：以前原样打印上游 JSON（一条命中 **331 tok**，含两套嵌套 range + `metaVariables` 三个空壳），
  现在一行/命中：`no-const @ STDIN 1:1-1:13 · const a = 1;  [A=a B=1]` ⇒ **29 tok（−91%）**；值本身仍是原 JSON。
- 顺带在 `schema-measurement.md` 里写明**口径边界**：预算只算 `{name, description, parameters}`，**不含 `output.schema`**
  （所以给输出加字段在预算里是零成本；真实 payload ≈ 紧凑字节 ×1.04）。

**🔤 AST 族命名对齐：`dump_syntax_tree` → `ast_dump_tree`、`test_match_code_rule` → `ast_test_rule`（2026-10-20）**
- **理由**：工具名是模型**选工具的第一信号**。`ast_search` / `ast_edit` 带前缀，另两个不带 ⇒ 看起来像别家的工具（用户原话：
  "从字面上完全看不出是 ast 家族的"）。现在四个统一：`ast_search` / `ast_edit` / `ast_dump_tree` / `ast_test_rule`（还顺手短了点）。
- **为什么不是合并**：实测合并成一个 `ast_debug`（`action: tree|rule`）只省 **~46 tok/轮**（205 → 179 的 13%），
  但会把模型会主动找的两个动词（`dump` / `rule`）藏进 action 里，**可发现性的损失大于省下的 token** ⇒ 只改名、不合并。
- **代价**：schema 总量 27,354 → **27,321 B（−0.12%）**、真分词器 6,552 → **6,545 tok/轮（−7）**，基本是零成本改名。
- 历史不用改：`docs/2026-10-*` 的记录与 CHANGELOG 里更早的条目保留旧名（那是当时的名字），本条就是"旧名→新名"的对照。

**🐛 改名后真宿主第一跑就抓到的坑：`required` 不能写"按 action 才需要"的参数（2026-10-20）**
- **现象**：`ast_search {action:"diff", paths, content}` 被宿主直接拒：`invalid arguments: missing required property "pattern"`。
- **原因**：宿主在**分派之前**按 schema 校验，而 `pattern` 还留在 `required: ['pattern']` 里（那是上游 `ast_grep_search` 的写法 ——
  grep 才需要它）。**action 驱动的工具不能用 schema 表达"按 action 才必填"**：要么全都不 required 由工具体内校验，
  要么拆成多个工具。我们的 `checkpoint`/`download` 早就是这么做的（"每个 action 的必填参数都在工具体内校验"），
  `ast_search` 只是漏了这一步。
- **修复**：去掉 schema 的 `required`；`grep` 缺 `pattern` 时在工具体内抛**带指引的** `ToolError`
  （"要比较文件与拟写入内容请用 action:\"diff\" + paths + content"）；`diff` 缺 `paths`/`content` 也有各自措辞。
- **为什么会漏到真机**：自测用**桩 `defineTool`** 直接调 `execute`，**绕过宿主那层 schema 校验** ——
  与上次 `additionalProperties` 那个回归是同一类盲区。
- **补了一道通用门**（`host-surface` 的形状契约）：**凡是参数里带 `action` 枚举的工具，`required` 最多只能是 `['action']`**。
  它同时盯着 `checkpoint`/`download`/`ast_edit`（现都通过），以后新增 action 驱动工具也逃不掉。

**🔤 `ast_grep_search` → `ast_search`，并把 `diff` 从 `ast_edit` 挪到只读侧（2026-10-20）**
- **改名理由**：工具名里带 `grep` 是把**引擎名**写进了 API（用户看到的是"结构化搜索"，不是 grep）；
  而 `diff` 明明**不改任何东西**，却挂在 `ast_edit` 下面 —— 名实不符。
- **现在的形状**：`ast_search` 是**只读**工具、`action` 驱动：
  - `action:"grep"`（**默认**，旧调用不用改）：就是原来的结构化搜索；
  - `action:"diff"`：与 `content` 比，给 unified diff + before/after revision，**不落盘、不入栈**。
  `ast_edit` 只留改写三件套 `preview | apply | reject`（`content` 参数随之移除）。
- **实现**：diff 的实现与渲染搬到家族内的新模块 `lib/ast/diff.js`（`diffAction` / `renderDiff`），
  这样 `lib/search.js` 的"上游 MIT 内容"边界不被搅浑；它仍复用 checkpoint 家族那个零依赖行 diff 引擎。
- **兼容性**：老名字**不再保留别名**（工具名是宿主侧注册键，双注册会白付一份常驻 token）。
  受影响的只有"按旧名写死的提示词/脚本"，本仓所有活文档、测试、`package.json`、`ci.yml` 已同步改名（86 处）；
  `docs/2026-10-1x-*` 的历史 LOG 与 CHANGELOG 里更早的条目**保持原样**（那是当时的记录，不改写历史）。

**⏱ 全量自测 138 s → 31 s（2026-10-20，4.5×）**
- **并发跑**：`test/run-all.mjs` 改成**默认并发**（按核数自适应 2–8 路；每份自测本来就用 `mkdtempSync` 自己的沙盒，互不共享路径）。
  实测 32 核机器：串行 138.1 s → 4 路 42 s → 8 路 **30.9 s**。`--serial` 保留（排障），`--jobs N` 指定路数，`--one <名字>` 既收 `glob` 也收 `glob-selftest.mjs`。
- **两份必须独占**（代码里显式列出，不是靠运气）：`tablediff-perf`（断言"不慢于 X"，负载一高就没意义）、
  `robustness`（自己 spawn 4 个子进程抢写锁，抢占结果受外部负载影响）。
  `resume-fuzz` 原本也独占，但它断言的"700 ms 后仍在下载"由**服务端限速**决定（并行不会提前结束）⇒ 已并入并发池（实测 3 轮 0 failed）。
- **每份用时**：汇总末尾打印"耗时 Ns（并发 M 路；最慢三份：…）"——以前只看得到计数，慢在哪全靠猜。
- **真凶定位**：`download` 单独就 38.6 s，其中 **~28 s 全在第 12 段「收尾加速」**（慢尾检测每 2 s 一次 × 连续 2 次 ⇒ 一轮 4 s）。
  两处改动把它压到 26 s：① 慢尾检测的两个阈值支持**环境变量覆盖**（`DSH_DOWNLOAD_SLOW_CHECK_MS` / `DSH_DOWNLOAD_STALE_STRIKES`，
  **默认值就是生产行为**，只在自测那一段调小并还原）；② 夹具里"慢连接"从 25 KB/s 提到 50 KB/s —— 仍是预算的 8%（stale 门槛 320 KB/s），
  但对照组从 20 s 降到 10 s。试过更激进的组合（80 KB/s + 100 ms 检测）能把套件压到 23 s，但 on/off 比值 67% **贴着 70% 阈值**，
  负载一高就会假红 ⇒ 退回余量更大的那组（比值 54%）。**快不是唯一目标，稳才是。**
- 顺带：`run-all` 失败时**打明细**（摘 `FAIL` 行与崩溃栈前几行），排障不必再单跑一遍。

**🔍 `ast_edit` 新增 `action:"diff"`：整文件替换前先看一眼（2026-10-20）**
- **补的是什么洞**：`preview` 只能预览**有 pattern 的改写**；生成式/整文件重写没有 pattern 可跑 ⇒ 之前只能先写再后悔。
  现在给 `paths`（**恰好一个文件**）+ `content`（准备写进去的内容），**不落盘、不入栈**，返回
  `[路径] +N −M 行  rev 旧 → 新` 表头 + unified diff（±3 行上下文、`@@` 块、超 240 行折叠）+ before/after 字节数/行数/revision。
- **两个保真细节**（都是实测踩出来的）：① **行尾先归一再比较** —— CRLF 文件与 LF 内容直接比会把**每一行**都算成"删了再加"
  （第一版就长这样，预览彻底失去意义）；正文相同、只有行尾不同时单独报 `eolOnly`，不吞掉"你其实只改了行尾"这件事。
  ② **BOM 当文件元数据**：比较正文，但 `after.revision` 按"写进去之后的字节"算（与其它工具的 revision 口径一致）。
- 复用 checkpoint 家族那个**零依赖的纯文本行 diff 引擎**（没有为一个动作再造第六个族）。
- 自测 +14 条（相同内容/改一行/hunk 与 `-`/`+` 行/路径只出现一次/after.revision 等于 sha256/CRLF 只报 1 处/`eolOnly`/BOM 保留/
  两个文件要报错/缺 content/文件不存在）。
- **顺带**：`ast_grep_search` 的 `skipped` 补 `skippedCount`（明细只列前 10 条 ⇒ 以前"跳过 300 个"和"跳过 10 个"看起来一样）。
- **并发测试又抓出两处**（都是"跑全量才出现"的那种）：
  1. **两处 CAS 的措辞不一致**：阶段 1 的检查说"文件在预览之后被改过，已拒绝写入"，而**持锁后**那次检查说
     "文件在这一瞬间又被改动了" ⇒ 从调用方看是同一件事，却只能认出一半（并发用例把失败归类时匹配不到，真 Linux 跑全量时假红）。
     现在两条路径统一措辞（后者补一句"持锁后又发现变化"）。
  2. **`test/run-all.mjs` 失败时不打明细**（以前只有一行汇总）⇒ 排障得再单跑一遍。现在失败会直接摘出 `FAIL` 行与崩溃栈前几行。
- **常驻代价（诚实记账）**：schema 26,898 → **27,201 B（+1.13%）**、`ast_edit` 4,640 → **4,767 B（+2.74%）**、
  真分词器 **6,429 → 6,515 tok/轮（+86）**。第一版 action 说明写长了是 +96 tok / `ast_edit` **+8.88%**（贴着 +10% 闸门），
  **压短说明后**才降到上面的数字 —— 闸门起作用的方式就是逼你先减字再加功能。基线随之重冻到 27,201 B。

**⚡ `scripts/test-changed.mjs`：改哪里测哪里（2026-10-19）**
- **起因**：全量 30 份要 **130 s**，改一行就跑一遍太费时间；但"只跑我改的那一个文件"又不安全 ——
  这几天真踩的坑**全是跨面的**：schema 预算闸门住在 `toolkit-help`、`ast_edit` 的覆盖洞藏在 `writepath-fuzz`、
  发布面漂移住在 `docs-claims`/`check-package`。
- **做法**：① 按**改动的文件**（内容 sha256 指纹，不看 mtime）映射到受影响套件；② **每次都跑一组秒级全局门**
  （`docs-claims` 发布面声明 / `toolkit-help` 的 schema 预算 / `output-contract` 参数面钉子 / `bin/check-package`，合计约 1.5 s）；
  ③ 改到**公共面/发布面**（`lib/index.js`、`deps`、`config-schema`、`configure`、`policy`、`routing`、`client.js`、`package.json`、
  `cordis.patch.yml`、共享夹具）⇒ **自动升级为全量**；④ 跑之前先把源码同步进安装副本（自测导入的是副本）。
  **只有全绿才更新状态文件**，红过的那批下次照跑。
- **实测**：改 `lib/search.js` ⇒ 7 份套件 + 1 个脚本、**6.1 s**（对比全量 130.2 s，21×）；无改动时只跑 3 份 + 1 个脚本。
- 入口：`node scripts/test-changed.mjs [--list|--all|--rebaseline|--jobs N|<路径…>]`；全量仍用 `node test/run-all.mjs`。

**🐧 第一次在真 Linux 上把整套自测跑通（2026-10-19，WSL2 Ubuntu / Node 22.20）**
- **怎么做到的**：`wsl --install`（新版 Windows 上没要求重启，自带 Ubuntu）→ 在 WSL 里用 npmmirror 的二进制镜像装
  一份 **Linux 版 Node**（不能用 `/mnt/c/...` 的 Windows node）→ 把源码拷进 **ext4**（`~/dsh-toolkit`，rename/锁/权限语义才真实）
  → `npm install`（30 个包，含 `@ast-grep/napi` 的 **linux 原生包**，能正常 `import`）→ `node test/run-all.mjs`。
  复现脚本留在 `backups/_wsl/`（`setup-node.sh` / `prep.sh` / `run-tests.sh`）。
- **结果**：`TOTAL: 30 files, 1085 passed, 6 skipped, 0 failed, 0 non-zero exit`（与 Windows 的 1131 条相比，
  差值全来自**平台感知的分支**：符号链接、只读注入、有无本机会话日志）。
- **首轮红了 6 份（8 条）+ 第二轮的 1 份 + 1 个偶发**，逐个查清后：**只有 1 处是真产品问题**，其余都是测试把
  "Windows 的性质"当成了通用真理 —— 这正是真机验证的价值：
  1. **产品**：`table_diff` 传一个**大小写不匹配**的普通路径时抛的是**裸 Error**（把整次调用崩掉）。现在改成带指引的
     `ToolError`：`file not found: <路径>（注意：本平台路径**大小写敏感** —— 在 Windows 上能读的大写路径在这里读不到）`。
  2. `test/resume-fuzz`：用 `taskkill`（Windows 专有）强杀 worker ⇒ POSIX 上改用 `process.kill(pid,'SIGKILL')`。
  3. `test/output-contract`：`env.TEMP ?? '.'`（Linux 没有 TEMP）⇒ 沙盒会落到仓库目录；改 `tmpdir()`。
  4. `test/session-tools`：`env.USERPROFILE`（Linux 上是 undefined）⇒ `join(undefined,…)` 抛 TypeError；改 `homedir()`。
  5. `test/restore-fuzz` + `test/writepath-fuzz`：失败注入用 `attrib +R`（Windows 专有），POSIX 上**静默没注入**
     而且**只读位拦不住 rename** ⇒ 改成"平台感知 + 保留跨平台不变量（绝不半截）"，另加一个两边都成立的注入
     （把目标换成同名**目录**）。
  6. `test/postures` P12：无条件断言"大写路径能读到" = **Windows 文件系统的性质** ⇒ 改成按平台分别断言
     （win32 能读；POSIX 断言**干净报错 + 大小写提示**，顺带把上面那个产品问题钉住）。
  7. **`ast_edit` 有一条断言从来没跑过**：它活在"符号链接分支"里，而 Windows 普通用户建不了符号链接 ⇒
     在 Linux 上第一次跑到就暴露出正则写的是 `searched`、而消息里是 `scanned`。**没跑过的断言会烂掉。**
  8. **两处模块来源的覆盖洞**（互补）：`writepath-fuzz` 只从源码树导入 ⇒ 本机（源码树没依赖）上 `ast_edit`
     整组**一直静默跳过**（所以它的一条失败本机从没见过）；`host-surface` 改成"源码树优先"后又反过来 ——
     源码树的 `lib/index.js` 能 import 但**注册不出 AST 族**（9 个工具）。统一成**谁注册出的工具多就用谁**，
     `writepath` 也补上副本兜底（本机 9 → **23** 条断言，覆盖变宽）。
  9. **一个偶发**：并发测试里"其他进程必须以锁/CAS 失败"太严 —— 若某进程 preview 得太晚（别人已写完），
     它本来就**没得改**（`no live staged proposal`），这是正常并发结局。现在用独立退出码 4 归类，
     并单独断言"没有任何子进程崩掉"。修完在 Linux 上连跑 5 次 0 失败。
- 顺带：`session_list` **空库也打表头**（`sessions root:` / `total: 0 session(s)` + 说明在哪里找）——
  以前只回一行，调用方（含自测）没法判读。

**🛡 新增"鲁棒性"自测：真并发写 + 边界文件语料（2026-10-19）**
- **① 真并发写**（最容易"偶发、事后无法复现"的一类）：4 个**子进程**各自 preview 同一文件，然后在同一个屏障上一起 `apply`。断言：
  **恰好一个成功**；其余以**可识别的原因**失败（别人持锁 / 预览后文件被改过 = 我们刚加的 CAS 陈旧检查）；
  文件内容**完整且正确**（无交错、无截断）；不留 `.dsh-tmp-*`、锁目录干净。
  实测 `codes=3,3,0,3`、3 个失败的报错都是"这个文件没有被写入"，文件 12,180 字节与期望逐字节一致。
- **② 边界文件语料**：CRLF / BOM / 非 ASCII（中文 + emoji）/ 2 万字符单行 / minified 单行 51 处 / 混合行尾 /
  空文件 / 无结尾换行 / 含 NUL —— 逐个体检：搜索不崩且有结论；literal 改写**只改该改的**（与 `replace(/\bX\b/g)` **逐字节相等**）；
  **BOM 保留**、**行尾不被规范化**（孤 LF 数一致）、**不擅自补结尾换行**；二进制与不支持的类型必须**说明原因**（不许静默）；无临时件与锁残留。
- 套件 `test/robustness-selftest.mjs` **0.4 秒**跑完（子进程 + 屏障，无外部依赖）。自测份数 29 → **30**（README ×2 / `package.json` / 工作区 AGENTS+MEMORY 同步，`docs-claims` 又当场拦下 4 处漂移）。
- **写屏障测试的坑（我自己踩的）**：**不要用 `spawnSync` 做"预演"** —— 它会在屏障上阻塞，等于让第一个子进程先把文件改掉，
  其余子进程 preview 时已经 0 匹配（报 `no live staged proposal`），看起来像产品 bug、其实是测试自造。用异步 `spawn` + 屏障文件。

**🧪 新增"不变量"自测：用独立路径验本轮四项新能力（2026-10-19）**
- **为什么另起一份**：2026-10-19 那个 `ast_edit` 注册失败暴露出"各份自测都在验自己实现的中间结果，**没能拦住跨层回归**"。
  `test/invariants-selftest.mjs` 改成**用独立路径给真相**，2 秒跑完（合成树 1,200 文件，不依赖本机路径）：
  - **分页不重不漏**：真相 = 把完整文件清单**按 400 个一批显式**扫（不经遍历器、不带 offset ⇒ 不触发分页），
    再与逐页之和对比 ⇒ `Σ每页 count == truth`、`Σ每页 filesWithHits == truth`、页间无重复命中、`nextOffset` 恰好接上、最后一页不再给。
  - **`text_mode` 与文件本身对齐**：`text` 必须等于**文件里该行该列**的内容（不是自证）；`line` == `node` 的首行；
    `truncated` 如实（多行 ⇒ true、单行 ⇒ false）；`none` 不给 text 但保留位置/kind；没要 `capture_names` 就不输出空 `captures`。
  - **确定性**：同查询两次结果逐字节一致（这是"翻页可信"的前提）。
  - **折叠不丢信息**：`perFileCount` 之和 == 报告总数；渲染里「列出 + 折叠」== 总数；`full` 的 `-/+` 行数 == 2×总数。
- **顺带核实的一个疑点**（不做成断言，但值得记）：同一棵树里 ripgrep 的 `require\(` 命中 92 个文件，而 AST `require($$$ARGS)` 只 15 个 ——
  拆开看**没有静默漏文件**：63 个在 node_modules（按设计跳过且**会回报跳过数**），范围内 29 个中 18 个的 `require(` 只出现在
  **注释 / 字符串 / 模板字符串**里（AST 正确地不当成调用，例如 build 脚本里 `"const { spawn } = require('node:child_process')"` 这种被生成的代码）。
  即：差距是**语义精度**换来的，不是丢文件。
- 自测份数 28 → **29**（README 徽章/文案、`package.json`、工作区 AGENTS/MEMORY 同步更新 —— `docs-claims` 当场拦下了那 4 处漂移）。

**🐛 修一个只在真宿主里暴露的回归：`ast_edit` 曾整个注册失败（2026-10-19）**
- **现象**：重启后信标里 `astEdit.apply FAILED: unsupported JSON schema: … additionalProperties must be a boolean` ⇒
  **会话里直接没有 `ast_edit`**（其余 12 个正常）。而当时 **1050 条自测全绿**。
- **根因**：① 预览折叠要把"每文件命中数"传给渲染层，于是在 **output schema** 里写了
  `perFileCount: { type:'object', additionalProperties: { type:'integer' } }` —— 宿主的 schema DSL **只收布尔**；
  ② **更深的原因**：自测用的是桩 `defineTool = (t) => t`，而**宿主的真校验器在 `app.asar` 里**，
  所以"schema 写成宿主不认的形状"在自测里**根本看不见**（这是覆盖面漏洞，不只是这一处笔误）。
- **修复**：`additionalProperties: true`；并新增 **schema 形状契约测试**（在 `host-surface-selftest` 里）：
  用**安装副本的入口**注册全部 13 个工具，遍历每个工具的 `parameters` 与 `output.schema`，钉住宿主两条已知硬规则 ——
  **`additionalProperties` 必须是布尔**、**`type` 必须是单个字符串（不支持联合类型）**。
  负向验证过：把违规写法放回去 ⇒ 立刻报红并指到 `ast_edit.output.schema.properties.perFileCount.additionalProperties`；还原 ⇒ 全绿。
- 教训：**"自测全绿"不等于"宿主收得下"** —— 凡是交给宿主的形状（工具 schema、补丁行、客户端导出），
  要么在真宿主里验一遍，要么把宿主的规则固化成契约测试。

**🔒 `ast_edit` 写入加独占锁 + 失败带 `effectState`（2026-10-19，照 dsh-ops 抄的两条）**
- **锁**：落盘前先拿独占锁（`fs.open(lockPath, 'wx')` = `O_EXCL`），**持锁之后再读 → 核 sha256 → 原子发布** ——
  关掉了"核对哈希"与"rename 落盘"之间的 TOCTOU 窗口（别人正好在这时写入会被我们静默盖掉）。
  锁文件按目标路径哈希命名、统一放**系统临时目录**（`<tmp>/dsh-toolkit-locks/`）⇒ **目标目录一个文件都不多**；
  用完在 `finally` 里删掉；**陈旧锁**（持锁进程崩了，>30 s）会被抢一次；真的有人持锁就明确报错而不是硬写。
- **`effectState`**：写盘阶段失败时，错误消息与错误对象上都带 `none` / `applied` / `unknown` —— 直接回答调用方最怕的问题"**到底写没写进去**"
  （`applied` 时同时列出已写入的文件，提示"部分改写状态，修好原因后重新 preview + apply 续做"）。
- 自测 +8 条：别人持锁 ⇒ 报错且文件未动且带 `effectState: none`；陈旧锁被抢过；用完即删；锁不在目标目录；
  第二个文件写不了时**预检就拦下**（比"写一半"好）；入口中止不写文件。
  ⚠️ **诚实标注**：`effectState: applied` 那条分支（真写到一半才失败）在自测里**无法稳定复现**（写盘预检会先拦），属防御性分支。

**🔬 `ast_grep_search` 的匹配文本默认只给首行（2026-10-19）**
- **问题**：每条命中都塞**整个节点的多行原文** ⇒ 同一次查询（20 条 `if ($COND) { $$$BODY }`）实测 **2,395 token ≈ 120/条**，
  而"这种结构在哪"本来只需要位置 + 首行。
- **现在**：`text_mode` 三档 —— `line`（**默认**，只给首行；多行节点压成一行并**如实标 `truncated`**）、
  `node`（整段原文 = 旧行为）、`none`（不给 `text`，只要 file/line/kind）。同一次查询实测：
  **`line` 1,503 tok（−37%）、`node` 2,395、`none` 864（−64%）**。顺带：没要 `capture_names` 时不再输出空 `captures` 字段。
- 自测 +7 条（默认只给首行/压行标 truncated/`node` 回整段/`none` 不给 text/空 captures 不输出/非法值落回默认）。
  schema：总 **+0.7%**、`ast_grep_search` **+8.7%**（仍在上限 +10% 内 —— 这次是**先去掉了重复的 `enum`** 才压住的）。

**📉 常驻 schema 瘦身：加了功能还比原来小（2026-10-19）**
- **为什么值得做**：工具 schema 是**每轮都付**的钱 —— 实测同一会话 51 个工具 = **14,520 tok/轮**，其中我们 13 个占 **6,513（44.9%）**，
  单工具均值 501 tok（对照 dsh-ops 的文件工具 192）。按既有设计意图（"别把一切塞进 schema"）压掉与文档重复的文字。
- **做法**：`download` 的工具级描述与 `proxy` 说明去掉与 `docs/DOWNLOAD.md` 重复的枚举（**−13.2%**）、
  `table_diff` 若干参数说明去掉示例与冗余措辞（−4.5%）、`ast_grep_search` 压紧（−2.0%）；
  例子/来龙去脉留在 `toolkit_help`、`docs/TOOLKIT.md`、`docs/DOWNLOAD.md`（本来就是给它们的地方）。
- **结果**：工具 schema **27,414 → 26,898 B（−1.9%）**、真分词器 **6,583 → 6,429 tok/轮（−154）**；
  而这一轮同时**新增了三个参数**（`ast_edit.previewDetail`、`ast_grep_search.include_vendored`、`ast_grep_search.offset`）。
- **baseline 向下重冻**到 26,898 B（此后增长从新地板算起）；`docs/schema-measurement.md` 的全部数字同步重算。
- **纪律**：自家的**单件 +10% 预算闸门**（在 `toolkit-help-selftest` 里）这一轮拦下过我两次 ——
  `ast_grep_search` 先 +19%、再 +10.7%，逼出"**加参数必须先压文字**"的做法。

**📄 `ast_grep_search` 撞上限后可以"接着搜"了（2026-10-19）**
- **问题**：paths 模式每页最多搜 **500 个文件**，撞上限只报 `limitReached: true` —— **续不了**（大仓里等于"只搜了前 500 个，剩下的不知道怎么办"）。
- **现在**：文件列表按路径**稳定排序**，`offset` 取下一页，结果里给 **`nextOffset`**，输出还写明"用 `offset:500` 接着搜"；
  没有下一页就不给该字段。**不重不漏**（自测用 501 个文件验证：第 1 页 500 个 + `nextOffset=500`、第 2 页 1 个、两页合计 501 处命中）。
- **两件事分开报**（以前容易混）：**文件分页**（`limitReached`/`nextOffset`）vs **页内命中截断**（`truncated`，由 `max_matches` 决定）。
- **顺手把这份 schema 压到基线以下**：新增 `offset`/`include_vendored` 两个参数的同时，把工具级描述与
  `source`/`paths`/`pattern`/`language` 的说明压紧（例如把"宿主 DSL 不支持联合类型"的来龙去脉留在代码注释与 TOOLKIT.md）
  ⇒ **2,064 → 2,022 B（-2.0%）**，加参数还净减 —— 因为**自家的单件 +10% 预算闸门当场拦下了 +19% 的那一版**。
- 自测 +7 条；`output-contract` 的参数面钉子同步登记 `offset`。

**🔍 依赖目录：跳过就说出来，并给显式开关（2026-10-19）**
- **先纠正一个误判**：我在对比 dsh-ops 时写过"`ast_grep_search` 不跳 node_modules，所以 500 文件上限被 vendor 吃光" ——
  动手时读代码发现 **`glob.js` 默认就跳过 `node_modules`**（`collectFiles` 还更聪明：**你显式在 `paths` 里写 node_modules 就自动放行**）。
  复核数据：测试用那棵树 1,741 个 `.js` 里只有 **209** 个在 node_modules 下 ⇒ 撞上限的是**非** vendor 文件。**那句论断不成立**，已在 TODO/LOG/工作区记忆里更正。
- **真正缺的两件事**（已补）：① 跳过了却**不说** ⇒ `collectFiles` 现在回报 `nodeModulesSkipped`，
  `ast_grep_search` 的输出写明"已跳过 N 个 node_modules 目录 …… 要一起搜就加 `include_vendored:true`，或把该路径直接写进 paths"；
  `ast_edit` 同样回报（逃生门 = 显式写文件路径）。② 没有显式开关 ⇒ 新增 `include_vendored`（`ast_grep_search`）。
- **有意不做的**：**不**默认排除 `vendor/`、`dist/` —— Go / PHP 的 `vendor/` 是**源码**不是依赖，默认排除会**静默漏掉真代码**；
  要排除请写进工作区根的 `.gitignore`（遍历器会读）或用 glob 明确指定。**静默漏文件比搜得慢危险得多**。
- 自测 +4 条（默认跳过并回报数量 / 输出里给出办法 / `include_vendored:true` 连依赖一起搜 / 显式路径自动放行）。
  schema：总 +1.8%、`ast_grep_search` **+8.6%**、`ast_edit` +7.3%（**自家预算闸门当场拦下过一版 +10.7%，压短说明后才放行**）。

**✂️ `ast_edit` 的预览会折叠（token 账里最贵的一项，2026-10-19）**
- **问题（实测）**：预览对**每一处**命中打两行 `-行:列 旧` / `+行:列 新`，而且**每处都重复完整路径** ⇒ 3 文件 48 处 = 4,951 字符 / 147 行；
  它**随命中数线性增长**（一次 500 处改名 ≈ 20k token，足以吃掉半个上下文窗口）。同类工具同任务的报告只要 ~330 token。
- **现在**：改动 ≤ **12 处**仍逐处列（小改动的手感不变）；更多就**按文件汇总** —— 路径只出现一次、每文件列前 3 处单行预览、
  其余写「……其余 N 处未列出」，末行照实给「共 N 处 / M 个文件」并提示怎么展开。实测同一场景 **4,951 → 约 900 字符**。
- **折叠但绝不隐瞒**：总数、每文件处数、折叠数都照实报；`previewDetail:"full"` 回到逐处、`"summary"` 更早折叠。
  ⚠️ 覆盖情况（命中 N / 全文出现 M）、残留警告、`stagedId`、目标文件数**一个都没少** —— 那些是判据，不是行数。
- 自测 +10 条（默认折叠/路径只出现一次/每文件处数/折叠数/末行总数/`full` 仍逐处/小改动仍逐处/`summary` 强制折叠），
  `output-contract-selftest` 的**参数面钉子**同步登记 `previewDetail`（这道门禁按设计拦下了"加参数没记账"）。
  schema 体积：总 27,414 → **27,742 B（+1.2%）**、`ast_edit` 4,324 → 4,640（**+7.3%**，仍在单件 +10% 内）。

**🗂 `download` 的状态与日志不再落在目标目录（2026-10-19）**
- **问题（用户实测报的）**：后台任务的状态与日志过去写在 `<目标文件所在目录>/.dsh-downloads/`，跑完还留着 ⇒
  在一个**会被别的程序扫描**的目录里多出一个点目录（实测：`ComfyUI-Shared\models\{diffusion_models,text_encoders,vae}\`
  各留了一个）。用户要求：目标目录**一个文件都不放**；状态与日志放工作区 `downloads/` 的**下级目录**，方便以后查。
- **现在**：统一放 **`<工作区>/downloads/.dsh-downloads/`**（`<id>.json` 结果记录 + `<id>.log` 日志 + `jobs.json` 索引）。
  记录与日志**保留**（随时可查、便于排查失败），只按 **200 条**上限滚动；`.spec.json` / `.cancel` 与孤儿文件随用随清。
- **旧版残留仍被管到**：候选目录 = 工作区目录 + 索引登记过的目录 + **旧版遗留目录**（工作区根、目标目录旁的 `.dsh-downloads`）。
  旧残留会被读取（旧任务照样能 `status`/`cancel`）并**自动退休**：终态记录就地清掉、目录空了连目录一起删。
  想清掉某目标目录旁的残留就用带 `to` 的调用（`status`/`cancel`/新下载都会自动带）。
- **顺带修一个 Windows 真 bug**：删空目录用的是 `rmSync(dir, { recursive: false })` —— Windows 上它对目录抛 `ERR_FS_EISDIR`
  （只负责 unlink 文件），异常又被 `catch {}` 吞掉 ⇒ **"删空目录"从来没生效过**。改用 `rmdirSync` 后一次通过。
- 自测 +3 条（状态确实在工作区 `downloads/.dsh-downloads`、**目标目录里没有 `.dsh-downloads`**、旧版残留带 `to` 调用时连目录清掉）；
  `resume-fuzz` 的强杀续传夹具同步改到新路径；`docs/DOWNLOAD.md` 的"状态目录与任务索引"一节重写。
  另清掉本机 4 处历史残留（ComfyUI 三个 models 子目录 + 工作区自己的一个空目录）。
- **失败出路补一个真实场景**：代理软件**在跑、但用户关掉了系统代理**（例如后台挂着别的任务时）⇒ `auto`（= 跟随系统代理）**探测不到它**，
  此时"改传 `proxy:"auto"` / 省略 proxy"是**循环建议**（auto 本来就是直连）。现在直连分支的**三处出路**（DNS 失败 / 连不上 / 未归类）
  都点明：**显式传地址**（如 `proxy:"http://127.0.0.1:7890"`，端口按实际改），或打开代理软件的「系统代理」开关。回归 +2 条。

**🔌 `download` 的直连写法 `none` → `direct`（2026-10-18）**
- **为什么改**：`none` 在别处常表示"**不**指定代理"，而 `auto` 正是"没指定时的默认（有代理就用）" —— 上下文一长，两者极易记混；`direct` 语义直白、不会读成"留空"。
- **兼容**：`direct` 是对外唯一宣传的写法；**`none` / `off` / `false` 保留为历史别名**，老会话/老提示词里的 `proxy:"none"` 继续可用（`isDirectOption()` 一处收口）。
- **顺带把"为什么是直连"说清楚**：`probe` / `start` / `status` 输出里，直连现在会写明原因 —— **显式指定 direct** / **NO_PROXY 或绕过规则命中** / **未发现系统/环境代理**。否则 "用户显式 direct" 和 "auto 没找到代理" 在结果里长得一模一样，改名等于白改。
- **修一处诊断不一致**：`classifyNetError` / `diagnoseNetError` 现在对**原始选项**做归一化 —— `proxyKind` 收到 `direct` / `none` / `off` 都走"直连"分支（以前只认 `'none'`，传 `direct` 会误报"代理已启用却解析失败"）。
- 回归 +4 条：`resolveProxy('direct')` 的来源标注、三个历史别名仍可用、**缺省仍是 `auto`（别把 direct 当默认）**、诊断归一化（`direct`/`none`/`off` 三者的出路文本必须一致，而真实代理地址仍走"代理已启用"分支）。文档同步：README ×2 / `docs/TOOLKIT.md` / `docs/DOWNLOAD.md`。

**🧹 发布前"去本机化"：用户可见文案与硬编码路径（2026-10-17）**
- **规则**：工具 `description` / 报错出路 / README / docs 里**不得把作者本机环境当普适真理**（有代理、装了某代理软件、某盘符、某工作区、国内网络、Windows 行为……）—— 一律条件式，实测数字带"本机样例"限定，并给"没装代理 / 其它平台 / 干净机器"留出正确说法。全仓只读审计出 **60 处**同类问题；判据与残留项的维护者笔记**不随包发布**（只存在于维护者工作区，避免把本机路径与内部待办带进发布件）。
- **报错出路**：`net.js` 的 DNS 失败不再默认"去开代理软件的系统代理"（先给**与代理无关**的出路，再说"若你另有可用代理"）；`engine.js` 的"代理连不上"不再断言"代理软件没开或端口不对"、不再把 `7890` 当默认端口；`tablediff` 的 UTF-16 提示改为平台中立（`iconv`/编辑器，PowerShell 作附注）。`session` 的 `cwd` 参数示例由作者工作区路径改为 `the project root you are working in`。
- **不再硬编码作者环境**：① 加载信标目录去掉 `D:/DshWorkSpace/...` ⇒ `DSH_TOOLKIT_BEACON_DIR` → `$DSH_HOME/dsh-toolkit`（自动建目录）→ 系统临时目录；② checkpoint 的恒定排除去掉 `backups`、预设排除去掉 `refs`（这类目录名交给工作区根的 `.dsh-checkpoint-ignore`，README 已写明）；③ 快照纳入的配置文件不再写死第三方插件名（`dsh-auto-memory.json` 等）⇒ DSH 自身的 `settings.yaml` 一族 + 新增 `DSH_TOOLKIT_CONFIG_FILES` 追加；④ `scripts/measure-schemas.mjs` 改为枚举 `~/.dsh/profiles/*`（不再写死 profile 名）。
- **自测可在干净机器上跑**：所有沙盒从"仓库外三层的 `backups`"改为**系统临时目录**（`DSH_TOOLKIT_TEST_DIR` 可覆盖）；`session-tools-selftest` 找不到那两个作者工作区就 **SKIP 而非 FAIL**；`tablediff-selftest` 的"真实语料"一段改为**显式传目录才跑**（不再默认 `D:/DshWorkSpace/Darktide`）。
- **`session_*` 的 id 解析两条修正**（2026-10-17，做上面"干净机器也能跑自测"时撞出来的真 bug）：① **显式 id/前缀不再被 `cwd` 挡下** —— 旧实现先按 cwd 收窄，收窄为空就抛"该工作区没有会话日志…显式给 session id"，可你明明已经给了 id（跨工作区读别人的会话时会莫名失败）；现在只要给了 id 就直接在全库解析。② 接受**裸 uuid**（`session_list` 打印的是 `session-<uuid>`，只带 uuid 那截以前报 `no session matching`）。`last` 的作用域语义**不变**（仍严格按调用方工作区解析，且不静默回退全局最新）。`test/session-tools-selftest.mjs` 新增 2 条回归断言（不依赖作者的工作区）。
- **声明 DSH 兼容范围**（2026-10-17）：`package.json` 的 `engines` 增加 **`dsh: ">=0.2.0-rc.2 <0.3.0-0"`**。为什么现在加：0.2.1 起宿主多了一道**版本兼容闸门** —— **有 `engines.dsh` 就只看它**（`peerDependencies` 全忽略），否则只看名字是 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer；不满足会以 `incompatible-version` **拦住安装与激活**。我们唯一的 peer 是 `@deepseek-ai/schemastery`（不在闸门名单里）⇒ 本来也不会被拦，显式声明是为了让意图可判、并在将来真的不兼容时**主动被拦住**而不是带病运行。上界必须写 `<0.3.0-0`：判定用 `semver.satisfies(rt, range, { includePrerelease: true })`，写成 `<0.3.0` 会**放过 `0.3.0-rc.1`**（实测）。
- **在 0.2.1-rc.2 真宿主上复验通过**（2026-10-17，升级当天）：七段 `apply ok`、5 个 volatile 族开关仍在且 `applies:"live"`、`checkpoint` 的 `fs/write-intent`/`fs/edit-intent` 留底照常触发（`journal` 里能看到新写入的留底）、五族工具（`session_read` / `checkpoint` / `table_peek` / `download status` / `ast_grep_search`）实测可用 ⇒ **一份代码同时支持 `0.2.0-rc.2` 与 `0.2.1-rc.2` 两条线**。0.2.1 的破坏性变更（移除 `./invariant` 与 `@deepseek-ai/dsh-invariants`、输入区 `stats` 拆成 `activity`/`usage`、工具展示去掉 `both`、子路径插件不读独立 `package.json`）**本插件一条都没用到**。跨版本策略与"以后真要分支时怎么写（优先能力探测 + 回退，而不是硬比版本号）"写进 `docs/TOOLKIT.md` 的 `## dsh-version-support`。
- **文档**：README ×2 补"**五族默认全关**，装完到设置里开启"（此前完全没写，用户装完会以为插件没生效）与各平台安装写法；CHANGELOG/TOOLKIT/DOWNLOAD/schema-measurement 的实测数字与具名软件统一改为条件式；顺带修掉 CHANGELOG 里 4 个不可见的转义残留字符（`\a`/`\v` 事故，吃掉过 `await`/`ast_edit`/`valueField`/`a.constructor` 的首字母）与 README 里 1 个孤立 `CR`（吃掉过 `restore` 的 `r`）。schema 常驻总量 **27,414 B**（较重冻前 +1.1%；按 `docs/schema-measurement.md` 的约定**重冻**了 baseline 与 current，两者现已逐字节一致）。

- **同步器加语法闸门 + 工作区安装脚本改为委派**（2026-10-17）：① `bin/install-toolkit.mjs` 现在**在拷贝之前**对 `lib/` 与 `scripts/` 下每个 `.js` 跑 `node --check`，任何一个解析不过就**拒绝同步并列出文件**（起因：2026-10-10 一个语法坏文件被抄进两个副本 ⇒ 宿主静态 import 失败 ⇒ 所有工具消失）。负向测试过：放一个坏文件 ⇒ verify/同步都 exit 1 且**副本里没有该文件**，删掉后 76/0 复原。② 工作区脚本 `tools\install-toolkit.ps1` 不再自己维护复制清单（它那份已过期：漏 `scripts/`、`locale/`、`icon.svg`，还在找早被删除的 `docs/ast-grep.mdc`、`lib/edit/index.js`、`fast-glob`/`ignore`/`zod`），改为**调用插件自带的同步器**并检查退出码 —— 单一事实来源；它自己只保留"从零装/修复"该做的事（宿主关闭检查、pnpm 残留清理、`dsh plugin add`、依赖与加载自检）。③ `files` 补 `scripts/`（文档里让人跑 `node scripts/measure-schemas.mjs`，之前它不在发布面里）⇒ `check-package` 58 → **60** 项通过；`npm pack` 预览：76 条目 / 0.42 MB（`scripts/` 已含、`bin/` 有意不含）。

- **发布面收口（2026-10-17）**：① 维护者笔记（去本机化审计的判据与剩余项）**移出发布件** —— 它含本机路径与内部待办，不值得进 npm 包/GitHub 首页；README/CHANGELOG 里改成自解释说明，不再指向它。② `bin/install-toolkit.mjs` 增加**反向检查**：副本里"源码已不存在"的文件会被列出并计为差异（`--prune-extras` 才真删）—— 一上线就抓出两处历史残留：`desktop` 里 1 个刚移走的笔记、`_probe-toolkit` 里 **36 个 2026-10-10 时期就删掉的 `lib/components/*`**（旧流程只比清单内文件 ⇒ 源码删文件后副本永远留着）；清完两个副本都是 **75/0/0**。③ `docs/TOOLKIT.md` 增 `## dsh-version-support`：跨 DSH 版本策略 + **族开关指路**（指向代码生成的 `toolkit_help {topic:"families"}`，不复制一份以免两处漂移）。④ `docs/schema-measurement.md` 的"真 tokenizer"口径修正：本机那个计数脚本原先硬列 6 个模块、**漏了 `download` 一族**（于是 4,531 tok 一直少一个工具），改成从**插件入口的注册面**取 ⇒ **13 工具 6,583 tok**；并按约定重冻 baseline（**工具 schema 仍是 27,414 B、一分未变**，只是按需体积 44,168 → 46,609 B）。

- **文档不再带开发时间戳**（口径统一）：README 与 `docs/` 里"（…修）""…起新增""基线重冻说明（日期）"这类**一律去掉时间、只留事实**，时间线只保留在本 CHANGELOG（以及维护者工作区的会话 LOG）—— 发布给别人的文档不需要读者按日期追历史。顺带把 `docs/schema-measurement.md` 里**三条**"基线重冻说明"合并成一条原因列表（同一件事不该按日期写三遍）；`package.json` 描述与 `cordis.patch.yml` 注释里的时间也一并去掉。改动共 38 处（文档 36 + 元数据 2），工具留在维护者工作区（`dedate-docs.mjs`，带 `--check` 复查）。

- **源码注释也不再带开发日期**（接上一条，口径彻底统一）：`lib/`、`test/`、`bin/`、`scripts/`、`.github/` 共 **304 处**注释日期去掉时间、只留事实（形状分布：括注打头 144 / 句中 82 / 行首 `//` 46 / 裸括注 12 / 代码行**尾注释** 8 / 块注释 4 / "…起" 7，其中"…起"改成"现在"或直接消失）。**护栏**：紧跟在引号后的日期一律不碰 —— 那是**数据**不是文献（唯一命中是 `const BUILD = '2026-10-17T…'` 这个版本戳，保持原样）。工具 `dedate-code.mjs`（逐行处理 + 护栏 + `--check`/`--dry-run`，只在含日期的那一行动刀，且双空格折叠只发生在注释行、不碰代码对齐）。`check-package` 再加一条门禁"源码注释里没有开发日期"⇒ **62/62**，并负向验证过（往 `lib/routing.js` 塞一个日期 ⇒ FAIL + exit 1；撤销即恢复）。

**⚙️ 家族开关搬进「设置」页 + 默认全关 + `toolkit_help` 常开（2026-10-16）**
- **族开关（`help` 除外）从“插件页组件行”改为「设置 → 工具集」的开关**：`.volatile()` 的 Config 字段是宿主设置表单**唯一**会投影的东西（命名空间 = profile 条目 id），浏览器半走 `settings.section` 槽位 + `ctx.configForms`；补丁因此从六行子路径回到**一行裸包名**（客户端半只挂在“specifier = 裸包名”的行上），`lib/components/*` 与六个子路径 `exports` 已删。
- **默认全关**（`z.boolean().default(false)`）：发布给他人使用不再一装就吃掉 13 个工具的常驻 schema，按需在设置里打开；卡片判定为“显式 true 才算开”。`lib/configure.js` 保留“没有 schema 时视为开”（自测/裸用不因读不到配置而少注册）。
- **`toolkit_help` 常开且不可关**（`normalizeConfig` 强制 `families.help = true`，不再进设置表单）：它是 agent 唯一能问出“哪些族启用 / 怎么开”的入口。现在**每次回复都带** `家族状态：… ✓ ｜ 已关闭：…`，并新增 `topic: 'families'`。
- **修两个真事故**：① 旧的家族闸门只换 `defineTool`、拦不住 `ctx.tools.register` ⇒ 关掉的族以**字段映射方言**注册 ⇒ 宿主 `Invalid schema for function 'download': … got 'type: null'`，**整个请求/会话全废**；改在 `ctx.tools.register` 收口拒收 + `sanitizeDefinition()` 兜底。② `lib/ast/edit.js` 用 `ctx.get('tools')` 绕过收口 ⇒ 刷新时 `ast_edit` 重复注册、整族 FAILED；收口现在也拦 `ctx.get()`，并覆盖 `commands/sessions/fs/systemPrompt/jobs`，重复注册不再致命。
- 新增自测：`test/client-half-selftest.mjs`（桩模块加载器 + 桩 React，22 条）、`test/volatile-refresh-selftest.mjs`（会记名/会报重复的桩注册表跑真 `apply`，10 条）⇒ 共 **28 份 / 986 条**。
- **`ast_edit` 残留口径修正**（2026-10-16）：`残留 = 原文出现数 − 命中数`（以前数的是“改写后还剩几处”）⇒ “保留锚点”式改写（替换文本里含旧文本，如插入一行但保留锚点）**不再**被误判为漏改、不再需要 `force:true`；而 `X.foo()` / `X::m` 这类**原文里**未被命中的限定用法**照旧**报残留并默认拒绝（刹车没松）。同时预览与拒绝文案在 `out` 含 `pat` 时明说“残留只统计原始文件中未被覆盖的那些”。新增回归用例 `test/ast-edit-selftest.mjs` §13（4 条）。
- **`download` 支持「未知大小」资源**（2026-10-16）：服务器既没给 `Content-Length` 也不支持 Range 时（GitHub codeload 那类“边生成边吐”的端点）**不再拒绝**，改走**单连接流式落盘**（`mode:'stream'`、`unknownTotal:true`，边下边存直到流结束）。代价写明：**无断点续传、无多线程、无长度校验**（那些都建立在偏移量模型上）—— 完整性只剩 `sha256`（给了就必校验）+“HTTP 层无错、流正常结束”；`expectedBytes` 只能**下载后**核对（不匹配则报错并保留 `.part`）。新增 9 条端到端断言（含“残留 `.part` 重下不拼接旧字节”）。现成机制全复用：代理探测/跨站重定向敏感头剥离/超时（`net.js` 的 `fetchFollowing`，其可读体是 Node 流 `res.stream`）。
- **`proxy` 不再诱导“先试直连”，且失败必给下一步**（2026-10-16）：① 旧说明写着 `none` = “use when you judge the link is domestic…” —— 等于公开邀请模型自行判断“哪条链路直连更快”；**本机实测** huggingface.co / GitHub 直连常 30 s 超时（换网络/换机器会不同），而 `auto`（跟系统代理/PAC）都通 ⇒ 改为“**通常直接省略 proxy**（auto：有代理就用、没装代理就是直连，两种环境都安全）；`none` 留给**确知可直连**的地址（本机 / LAN 等），只是**别靠猜**”。② 超时文案是**中文**（`请求超时（30000 ms 内没有完成）`）而分类器只匹配英文 `timeout` ⇒ 掉进 `unknown` 分支，而 `diagnoseNetError` 又没 unknown 兜底 ⇒ **只回一句超时、零出路建议**（另一个会话就是这样被逼成“先直连、出错再改代理”的）⇒ 补上「超时」匹配 + unknown 兜底出路。③ 用户可见文案里对具名代理软件的指名改为通用说法“本地代理软件 / 系统代理 / PAC”（发布前避免误解）。
- 过程与踩坑：`sessions\dsh-plugin\docs\2026-10-16-toolkit-settings-switch\LOG.md`。

**🖼 插件卡片（图标 / 标题 / 描述）不显示的根因与修法（2026-10-14，拿能显示的 `dsh-context` 逐字对比出来的）**
- 症状：Plugin Manager 卡片一直显示**包名当描述 + 默认占位图标**；文件同步过、宿主也重启过，就是不生效 ✗。
- **根因（三处形状都错，全是照社区文档猜的）**：
  1. **`exports` 没把素材导出去** —— 卡片按**包的 exports 映射**解析本地化/清单文件（Node 规则：未导出的子路径报 `ERR_PACKAGE_PATH_NOT_EXPORTED`）✗。
     `dsh-context` 的 `exports` 含 `"./locale/*.json"`、`"./package.json"`、`"./client"`；我们只有 `"."` ⇒ 素材**在、也同步了，就是解析不到**。
  2. **`locale/*.json` 结构错**：真实形状是**嵌套** `{ "meta": { "title": …, "description": … } }`，我写成了扁平 `{name, description}` ✗。
     （旁证：`dsh-context` 的 `package.json` 里 `meta.title` 是**空的**，卡片照样显示中文标题 ⇒ **卡片读的是 locale 的 `meta.*`**，package.json 的 `meta` 只是备用。）
  3. **`icon.svg` 写法**：可用实现是**扁平多 `<rect>/<path>` + 纯 `xmlns`+`viewBox`**（无 `<defs>`/渐变/`role`/`aria-label`）；我那份用了 `<defs><linearGradient>` ✗。
- **修法**：`exports` 补 `"./locale/*.json"` / `"./icon.svg"` / `"./package.json"`；locale 改嵌套 `meta`；icon 重画为扁平 5 个 `<rect>`。实测通过 ✓。
- **可复现验证**：从 profile 视角用 Node 解析 `dsh-toolkit/locale/zh.json`、`dsh-toolkit/icon.svg` 等子路径 —— 修前 `ERR_PACKAGE_PATH_NOT_EXPORTED`、修后 OK ✓。
- **一般化教训**：**"文件明明在、也同步了，却读不到" ⇒ 先怀疑包的 `exports` 映射**；对齐形状时**拿一个能工作的实现逐字对比**，别照文档猜（社区文档可能落后于本机实现）。

**🧩 A：拆成 6 个可独立开关的组件（2026-10-14，为 GUI 控制做准备）**
- 动机：用户明确更希望**在 GUI 里开关**，而不是编辑 profile YAML ✗；原来 patch 只有 1 行 ⇒ Plugin Manager 只显示 1 个组件 ✗。
- 做法（**段代码一行未动**）：新增 6 个**薄壳** `lib/components/{ast,table,session,checkpoint,download,help}/index.js`（各约 15 行，各自 `export const name = 'dsh-toolkit-<fam>'` + `inject: ['tools']` + 调对应段的 `apply`）；
  `package.json` 的 `exports` 加 `"./components/*": "./lib/components/*/index.js"`；`cordis.patch.yml` 从 **1 行 → 6 行**（每族一行，UI 每族一个开关 ✓）。
- ⚠️ **主入口与 6 行不可并存**（`lib/index.js` 注册全部族 ⇒ 并存会**重复注册** ✗）：patch 里刻意**不再列**裸行；裸行只服务"直接 `name: dsh-toolkit`"的装载方式（开发/探针）✓。
- 注册探针（从安装副本跑，源码树缺 `yaml` 会误报 ✗）：ast 4 / table 2 / session 4 / checkpoint 1 / download 1 / help 1 = **13 个** ✓；`check-package` 56/56 ✓（新增的 `./components/*` 导出与 6 个 `name:` 都通过校验 ✓）。
**✅ ④ 发布面自检 + CI 门（2026-10-14）**
- 新增 `bin/check-package.mjs`：校验**声明与磁盘一致** —— `exports` 目标/通配、`main`、`icon`（存在/≤256 KiB/扩展名）、`files` 条目、
  `dsh.bundle.patch` 存在且 **patch 的 `id` == 入口 `export const name`**、`locale/*.json` 必须是**嵌套 `meta.{title,description}`**、
  **同步面（`bin/install-toolkit.mjs` 的 DIRS/FILES）必须覆盖 `files` 里每一项 + patch + icon**。
  现状 **56/56 通过**；**反向验证有效**：临时删掉 `exports` 的 `./locale/*.json` ⇒ 立刻 FAIL + exit 1 ✓（正是卡片连错三轮的根因）。
- 新增 `.github/workflows/ci.yml`：Windows × node 22/24，跑 ① `check-package` ② `measure-schemas`（报告）③ `test/run-all.mjs`（26 份）。
  说明：`install-toolkit --verify` 是**本机**工具（比对源码 vs 本机 profile 副本），CI 里没有那些 profile ⇒ 不进 CI ✓。
**🐞 修：家族开关会泄漏注册（2026-10-14，端到端实测抓到的）**
- 现象：`config: { families: { ast: false } }` 下，`ast_edit` 等被正确跳过 ✓，但 `ast_grep_search` **仍然注册** ⇒ 宿主整个请求被拒：
  `INVALID_REQUEST: Invalid schema for function 'ast_grep_search': {…,required:true} is not of type string` ✗（不是少一个工具，是**请求全废**）。
- 根因：`lib/search.js` 的注册路径是 `ctx.tools.register(defineTool(def))` —— 它**直接调 ctx.tools.register**，所以"只在 `defineTool` 收口处丢注册"对它无效；被关的工具**以字段映射方言**（未经 `toFieldMap` 归一化）注册出去 ⇒ 撞上宿主的严格 DSL ✗。
- 修法：把生效配置做成**共享只读视图**（`lib/configure.js` 的 `setActiveConfig` / `familyEnabled`，未设置时一律视为开启 ⇒ 绝不因"没读到配置"而少注册），
  `search.js` 注册前自查 `familyEnabled('ast')` ✓；`defineTool` 那道闸门保留为兜底 + 记账。
- 验证（探针宿主真跑，改前/改后对照）：`search.apply ok ()`（名单空 ✓，修前会列出 3 个并泄漏 ✗）+ 9 个工具 + 宿主回 `ok`（修前 INVALID_REQUEST ✗）。
- **一般化教训**：**"在唯一收口处拦截"这类设计，必须先确认没有第二条注册路径** ✗；尤其宿主 DSL 严格时，绕过 `toFieldMap` 的注册**不是少个工具，而是整请求失败** ✗。
**📦 发布面补齐 + 一处 patch id 不一致（2026-10-14，照 `lishuo4096/dsh-plugin-authoring` 的 manifest 规范）**
- **🔴 修**：`cordis.patch.yml` 的 `id` 原为 `toolkit`，而入口导出的是 `export const name = 'dsh-toolkit'` ✗ ——
  作者资料明确要求"**`id` = index.js 的 `export const name`**"，而 profile 里"**按 id 覆盖 config**"是用户改配置的唯一途径
  ⇒ id 写错会让配置覆盖**静默失效**。已改为 `dsh-toolkit`。
- `package.json` 补上规范要求的其余字段：`exports: { ".": "./lib/index.js" }`、`meta.{title,description}`（Plugin Manager **不激活插件**也读它）、`keywords` 加生态约定项 **`dsh-plugin`**。
  （`type: "module"`、`main`、`dsh.bundle.patch: "./cordis.patch.yml"`、`engines.node`、`files` 清单、`license` 原本就有 ✓）
- 新增 `locale/zh.json` + `locale/en.json`（卡片多语言，不激活也能读）。
- `cordis.patch.yml` 里写清了**配置怎么改**：profile patch 按 id 覆盖、**整体替换 config（不深合并）**、改配置**免重启** + 三个可调键示例；
  未知键不会静默吞掉（入口 warn + 信标）。
- **仍未做**：`icon`（可选）、`dsh.compatibility.dshReleases`（**没实测过就不声明** ✗）、`peerDependencies: @deepseek-ai/cordis`（本插件不 import 它 ⇒ 暂不需要）。
- **`bin/install-toolkit.mjs` 同步面跟着扩到 70 个文件**（+ `cordis.patch.yml`、+ `locale/`）—— 否则新文件永远进不了安装副本。

**📊 借鉴 T-Auto/dsh-ops：schema 常驻体积做成 checked-in 的预算（2026-10-14）**
- 来源 <https://github.com/T-Auto/dsh-ops>（Windows 原生性能插件，v0.3.0）；调研记录见 `sessions/dsh-plugin/docs/2026-10-14-dsh-ops-borrow/README.md`（工作区）。
- 落地：`scripts/measure-schemas.mjs`（口径 = `{name,description,parameters}` 紧凑 UTF-8 字节，`tokens≈bytes/4` 且对中文**高估**）+
  `docs/schema-baseline.json`（冻结）/`docs/schema-current.json`（重算、按 diff 审阅）+ `docs/schema-measurement.md`（口径、用法、维护约定）。
- **测试闸门**（`toolkit-help-selftest` 第 5 节，替换原先只守 `table_diff` 一处的字符口径）：总字节 ≤ baseline **+5%**、单件 ≤ baseline **+10%**、
  每个工具必须**归族**（落 `other` 即失败 ⇒ 新增工具必须显式记账）。
- 现状：**13 工具 / 27,076 B**（家族 ast 7,747 / table 6,491 / session 4,044 / download 4,034 / checkpoint 3,684 / help 1,076）；
  最大单件 `table_diff` 4,823 B。**按需**文档 `docs/TOOLKIT.md` 42,494 B 另计 —— 长说明一律进文档，不进 schema。
- 同轮顺手修：`resume-fuzz-selftest` 的第三种合法结局（**中止落地前就已下完**）以前会假红 ⇒ 现在"已完成（且逐字节一致）/探测期中止/进程内中止"三种结局都按合法处理，跳过的种子如实计入 `untested`。

**🔬 第五轮补充：刁钻角度加固（2026-10-14，先确认真实宿主里 new schema 已生效 —— `mode:"bogus"` 被宿主按 enum 拒掉）**
用 16 个"刁钻角度"打刚做的 literal 模式，抓到并修掉 **4 个真坑**（都是 Windows/中文场景的高频形态）：
1. **CRLF 文件上多行 literal 一处都命不中** ✗ —— `pat` 里写 `\n`，而 Windows/Java 文件是 `\r\n`。修：literal 匹配把 `\n` 当 `\r?\n`（改写后行尾仍保持 CRLF ✓）。
2. **`pat` 被 `.trim()` 掉** ⇒ `pat:"    foo();"` 想只改"缩进后的那一处"，结果任意位置的出现全被改 ✗。修：**literal 模式不 trim**（structural 仍 trim）。
3. **token 边界按 ASCII 算** ⇒ JS 的 `\b` 只认 `[A-Za-z0-9_]`，中文词加不上边界 ⇒ `中文` 误伤 `中文标识`/`中文版` ✗。修：改用 `\p{L}\p{N}_` 的 lookaround（Unicode 边界），覆盖率统计同判据。
4. **被跳过的文件不出现在覆盖率里** ⇒ "全文出现 N / 残留 0"会被误读成"整个 paths 都干净"，而那些 >2MB / 二进制文件其实**没检查也没改** ✗。
   修：① "一个可读文件都没有"时把跳过原因打出来（原先只有一句 `No readable files matched…`）；② 有跳过时覆盖率行**显式声明"只统计实际参与改写的文件"**。
另外把词边界语义钉进自测：`ResourceLocation` 不误伤 `ResourceLocationArgument`、`a` 不匹配 `aaa` 内部（要"纯子串"就 `wordBoundary:false`）。
自测 `ast-edit-selftest` **73 → 86 断言**（新增第 10 节「literal 模式的刁钻角度」）。

**🔤 第五轮：`ast_edit` 改名能力（2026-10-14，某个本地化模组工作区反馈 `sessions/dsh-plugin/docs/2026-10-14-dsh-toolkit-ast-rename/`）**
- **问题**（他们实测 Java 26.x 移植，`ResourceLocation` → `Identifier` 57 处）：拿 `ast_edit` 当改名工具**只命中 20/57** —— AST pattern 只匹配**语法位置**（import / 类型声明 / 泛型 / 参数），
  **命中不到限定用法** `X.foo()`、`X::m`（方法引用）、`instanceof X`。预览里那 20 条 diff 看起来像"改完了"⇒ apply 就是**新旧名混用的静默半成品**，只有编译才发现 ✗（比不改更危险）。我们复现为 6 处只中 3 处。
- **落地（按"更通用"做，不是照抄五条建议）**：
  1. **`mode:"literal"`**：按 **token 边界**做字面替换（等价 `\bOld\b → New`），**一条规则覆盖 import / 限定名 / 方法引用 / instanceof**，且**任何文本文件**（不要求已知语言、不需语言包）。`wordBoundary:false` = 纯子串替换（连带改 `OldSuffix`，等价宿主 `replace_all` 的语义）。
  2. **覆盖率报告成了通用能力**（不再只服务"改名"）：凡是**能定义"应当消失的旧文本"**的规则（literal 规则 / 单标识符 structural 规则 / 无元变量的字面 pattern）都统计
     **`命中 N / 全文出现 M` + 改写后残留 R + 残留行号**；`R>0` ⇒ **apply 默认拒绝**（`force:true` 强推）。
     - **0 命中但文本存在**（如 `import a.b.C;` 作 structural pattern）⇒ 点名"节点上下文不对"并建议 literal ——这条诊断原先被"0 改动就不入栈"的提前返回**整段丢掉** ✗，已修。
     - 含元变量的规则**明说未做覆盖统计**（别把"没警告"当"已校验"）。
  3. **`verify:[{text,expect}]` 显式后置条件**（最通用的形态，含元变量的规则同样有效）⇒ 不满足则 apply 被拒（`force` 可推翻）。
  4. 文档：`docs/TOOLKIT.md` 新增「改名 / 全局文本替换」一节 + `AGENTS.md` 的 AST 用法规则补一条；工具 schema 里 4 条 `ops` 描述也点明"改名不要用 AST pattern"。
- **一般化的不变量（写进 `WORKSPACE_MEMORY.md`）**：**"diff 说没差异"与"改写说改完了"是同一类幻觉** —— 凡是能算出"应该有多少"的地方，都必须报覆盖率，并在达不到时**默认拒绝**而不是打印成功。

**🔍 第四轮：「其他姿势」主动审计（2026-10-14）—— 43 + 35 个姿势，修 6 处"闷着不说"**
- 方法：写两组探针（**换用法**而不是只换输入），判据统一为 **"清晰报错＝可接受；静默错 / 静默空 / 崩溃＝必须修"**。
  第一组 43 个姿势打 tablediff（参数组合、边界输入、错用）；第二组 35 个打三个合并型工具的 action 分派 + session/help。
  结果：第一组修前 **1 个静默错 + 5 处闷忽略**，修后 **FIND=0**；第二组 **0 个静默错**（分派的必填/多余参数护栏都在起作用）。
- 修掉的（都是"让它出声"类，正常路径行为不变）：
  1. `table_peek { source: "text:" }`（空内联）以前**静默回 `records=0 format=unknown`** ⇒ 与 `table_diff` 对齐成报错。
  2. **0 字节文件**以前抛裸 `Unexpected end of JSON input`（看不出是哪个文件、为什么）⇒ 现在点名"0 字节（空文件）"并给出路。
  3. **UTF-16 文件**（Windows 上 PowerShell 5.1 的 `Out-File`/`>` 默认就是 UTF-16LE）以前同样是没法定位的 parser 错 ⇒ 现在点名 `UTF-16LE（BOM FF FE）` + 转码建议。
  4. **`#table` 用在非 SQLite/压缩包**（如 `a.json#tbl`）以前报 `file not found: a.json#tbl`（找不到北）⇒ 现在说明 `#` 只用于 `path#table` 与 `x.jar#entry:`。
  5. `valueFields` 里**多个冒号**（`en:zh-cn:xx`）以前按"第一个冒号切"猜下去 ⇒ 现在直接报错（不猜）。
  6. **被忽略的参数必须出声**：`query` 只对 SQLite 有效、`table=` 只对 Lua 有效 —— 以前静默忽略（用户以为生效了）⇒ 现在写进 `note`。
- 新增自测 `test/postures-selftest.mjs`（**32 断言**，自带夹具）：P1–P17 tablediff 边界与错用（空内联 / 0 字节 / UTF-16 / `#` 用错 / valueFields 变体 / 忽略参数出声 / 非法 normalize 与 filter / limit 边界 / glob 变体与重复键 / 缺字段不静默 / 目录 / 0 文件），P18–P31 分派护栏（checkpoint 缺 action 默认 list、非法 action、必填缺失、**多余参数**、未知 id 不写盘；download 不给 action **必须缺 url 报错而不是开下**、`file://` 拒绝；session 的 kind/多余参数/非法正则；toolkit_help 未知主题）。

**🔧 第三轮：`local function …` 打断扫描（2026-10-14 复测回归 —— **我上一轮说"按设计报错"是错的**）**
- **问题**：`TALENTS_Modular.lua` 里其实**有数据表**（`local talent_localizations = {`，29 条），我上一轮却让它"报错" ✗。他们给了四个最小探针：**数据表之前只要有一个 helper 函数，整张表就读不到**（`probe-nofn` ✓ 2 条，`probe-fn/fn2/fn3` ✗）。
- **根因两层**：① 扫到 `local function` 时 `p = save + 1` **跳过了 `function` 关键字** ⇒ 扫描走进函数体；② 函数体里的 `return {}` 命中"文件 return"分支 ⇒ **`break`** ⇒ 函数之后的一切（`class_modules`、`talent_localizations`）再也扫不到。
- **修**：① 见 `function` 就**整块跳过**（`local function` 先退回该位置，不越过关键字）；② `parseFunction` 的跳过区间**必须数全所有需要 `end` 的块**（`function` / `if` / `do`（含 `for…do`、`while…do`）/ `repeat…until`）—— 只数 `function/end` 会在内层 `if … end` 处提前收尾，又扫回函数体。
- **复测（本机实测样例，换工作区/换数据会不同）**：四个探针全部 **2 条** ✓；`TALENTS_Modular.lua` 读出 **29 条**（自动选中 `talent_localizations`，note 列出其它候选 ✓）；`Main_Modules/**/*.lua` 合计 **1539**。
- **口径闭合**：他们的 **1537** = 我们 **1539** − 1（`NAMES_Talents_Blessings` 的 `\t ` 不规则缩进，他们少读一条）+ 1（`TALENTS_Modular`：我们 29 / 他们 28）。**他们对我上一轮"1537 多半是缩进 bug 带进来的"的更正成立** —— 我那句推断错了。
- 另按他们的建议：`table=` 命中失败时错误里**说清扫描结果**（有候选就列出；一个都没有就说明"整份可能都是运行时表达式/函数，或数据由 require/io_dofile 在运行时加载"）。
- 新增自测（`tablediff-lua-module-selftest` L11）：helper 是**平凡 / `if` 里 `return {}` / `pcall` 嵌套函数 / `for`+`do`** 四种形状时其后的数据表都要读到；`table=` 也要能命中函数之后的表。

**🔧 第二轮：某个本地化模组工作区的复测回执 —— 三个真问题（2026-10-14，本机实测样例）**
- **🔴 值提取丢掉函数调用实参 ⇒ `normalize=numbers` 系统性漏报**（他们标为"本次最重要的一条"，我们也确认是最严重的一条）：该工作区的文本形如
  `"…" .. CNumb("0","n_0_rgb") .. "|" .. CNumb("20","n_20_rgb")`，实参以前被 `skipBalanced` **整段丢掉** ⇒ 抽出的文本是 `"…||"`（数字全空）⇒
  **真差异被判成 same**（他们点名的 `loc_talent_psyker_damage_based_on_warp_charge_desc` 就是这条：英文表多一行 `50%`，我们报 `changed=0`）。
  现在**收集字面实参**：保留第一个字面量（内容是单词也保留，如 `CKWord("Bleed","key")` ⇒ `Bleed`），丢掉"键样子"的实参（`n_0_rgb`）与空串。
  修后复测：那条 `changed=2`，两端文本 `A: 0,0,4,8,10,12,16,20,20,40,50,60,80,100` vs `B: …,40,60,…`（**A 多一个 50** ✓）；全目录 `normalize=numbers` 的 changed 从 6 涨到 46（说明之前确实在漏报）。
- **选中的"表"不是数据表也不许静默**：`local Dot_green = Utils.Dot_green` 这类**表达式赋值**曾被当成 1 键候选并胜出 ⇒ 仍返回 1 条 `__expr`。
  修：候选 size 与 `sizeOf` 用**同一判据**（都排除 `__expr`/`__fn` 哨兵键）；再加一道护栏 —— 读出的**每条记录只有哨兵字段**时**直接报错**。`TALENTS_Modular.lua` / `Debug.lua` 当时会明确报错 —— ⚠️ **第三轮已更正：`TALENTS_Modular.lua` 其实有数据表**（`local function` 打断了扫描，见本文件"第三轮"一节）；`Debug.lua` 是真的没有字面量表，报错正确。
- **glob 的 `**/` 必须匹配 0 层目录**：以前 `**/` 被译成 `.*/`（那个斜杠要求至少一层）⇒ `Main_Modules/**/*.lua` **静默漏掉**直接位于 `Main_Modules/` 的 8 个文件。
  修后该模式从 7 个文件变 15 个。另外：**用了 glob 就始终回显解析到几个文件**（只匹配到 1 个会提示"确认不是写窄了"）。
- **glob 里个别文件读不出不再打断整体**：跳过并 `⚠⚠` 点名（单个显式文件仍硬失败）—— 否则一个运行时加载器（`TALENTS_Modular.lua`）就能让 15 文件的比对整段失败。

**📥 采纳某个本地化模组工作区的改进提案（2026-10-14）：模块化 Lua + 值归一化 + 多列一次比**
- **P1 Lua 回退选表（硬阻断解除）**：顶层 `return` 不是字面量表时（`local data = {…}` + 循环拼数组 + `return out` 这类模块写法），**回退到文件内最大的字面量表**（按顶层键数排序、`local` 优先），`note` 里说明选了哪张并列出其它候选；新增 `table="<名字>"` 显式指定。
  - **静默降级消灭**：以前这种文件只回 1 条 `__expr`（看起来像"只有一条数据"）⇒ 现在**没有候选就直接报错**，并提示用 `format=` 指定真实格式；`{__expr}`/`{__fn}` 哨兵不再被当成"可用表"；裸表（函数调用里的表参数）也不再让扫描提前中断。
  - 顺手修嗅探：单行内联 `return { ["k"]=… }` 以前被判成 properties，现在正确识别为 `lua`。
- **P2 值归一化 `normalize`**（通用能力，不限 Lua）：`raw`(默认) / `numbers` / `placeholders` / `skeleton` / `tokens`；默认**集合语义**（语序差异不算差异）、**保留重复项**（"少一行数值"仍可见），`ordered: true` 才位置敏感；`{#color(…)}` 这类富文本标记整段忽略（规则：`{#…}` 是标记、`{name}` 是占位符）。`table_peek` 可预览；输出里回显 `已按 normalize=… 归一化后比较`。
- **P3 多列一次比 `valueFields`**：`["en:zh-cn","en:ru"]`（或逗号分隔字符串）⇒ 一次调用分段输出多组；与 `valueField*` 同给会报错（避免"以为比了其实没比"）。
- **实测（某个本地化模组工作区的真实 fixture —— 本机实测样例，换机器/换数据会不同；15 个模块文件 / 2101 条记录，en vs zh-cn）**：全部 13 个硬指标 records 精确命中（75/88/79/83/99/101/79/197/22/111/288/284*/3；`*` 那个文件实际 285 条，多出的一条只有 `ru`/`zh-tw` ⇒ 他们脚本按"有 en"过滤后为 284 ✓）；归一化后 `changed` **836 → 267（降 68%）**，仅数值模式 `changed=6`；点名的"纯语序"样本消失，而**真·旧译文仍被抓到**。
- 新增自测 `test/tablediff-lua-module-selftest.mjs`（35 断言，**自带合成夹具**，不依赖别的工作区）；既有 `tablediff-selftest` / `tablediff-fuzz` 无回归。

**🔴 P0 修复：合并层路由丢失判别位 —— `download {action:"probe"}` 曾会真的下载（2026-10-11，宿主侧评审第六次回执）**
- **现象**：`{ action:"probe", url, to }` 返回 `downloaded … 205 KB` 并**真的写出文件**；不给 `to` 时落到 `<会话工作区>\downloads\<name>` ⇒ 用户以为在探测、实际花流量还落了盘（**静默副作用**）。
- **根因**：合并后的分派把 `action:'probe'` 路由给旧实现，而旧实现判的是 `args.probe === true || args.dryRun === true`（`lib/download/index.js:255`）⇒ `{ action:"probe" }` 时两个字段都是 undefined ⇒ 掉进普通下载分支。
- **修法**：`const callArgs = action === 'probe' ? { ...args, probe: true } : args`（`action:"probe"` 是权威意图，压过 `probe:false`）。
- **覆盖补齐（原先只测了布尔形式 `probe:true`）**：`download-selftest` 新增 4 条 —— `action:"probe"` 给探测报告 / 指定 `to` 绝不落盘 / 不给 `to` 也绝不创建 `<工作区>/downloads/` / 与 `probe:true` 等价。
- **真宿主复验**（用评审给的真实 URL）：`action:"probe"` + `bmclapi2…/version_manifest.json` ⇒ 完整探测报告（206 / 0.2 MB / Range 是 / etag）、**目标文件不存在、目录为空**；布尔形式行为不变。
- 小项同修：后台任务提示、cancel 缺参报错不再指向旧工具名（改为 `download { action:"status"|"cancel", … }`）；合并描述与 `docs/DOWNLOAD.md` 写明默认落点是 `<工作区>/downloads/`、根目录要保持干净就用 `to:`。
- 全量：源码树 **24 份 / 818 passed / 2 skipped / 0 failed**、安装副本 **24 份 / 832 passed / 0 skipped / 0 failed**（+4）。

**🧩 工具面收敛第三步：session 族成对合并（2026-10-11，账本第十五节）—— 15 → 13 个工具**
- 先**量相似度**再动手（参数 Jaccard）：`session_list`+`session_catalog` **0.50**、`session_peek`+`session_grep` **0.43** ⇒ 合；
  `table_diff`+`table_peek` 0.25、`dump_syntax_tree`+`test_match_code_rule` 0.17、`session_diff`+`session_export` 0.11、`ast_grep_search`+`test_match_code_rule` **0.00** ⇒ 都不合（数据说话，不靠"看起来像"）。
- **`session_list {kind:"sessions"(默认) | "subagents"}`**：后者即原 `session_catalog`（保留 `session`/`gcRoot`）。
- **`session_read {session, cwd, pattern?, flags?, tail?, limit?, width?}`**：给 `pattern` = 正则过滤事件；不给 = 看最后 `tail` 条（原 `session_peek`）。
- `session_diff` / `session_export` 不动；零业务逻辑改动（旧定义降级为普通对象，合并工具只做模式分派，`render` 一并委派）。
- **模式误用给"带纠正提示"的报错**（合并新增的失败面）：`不给 pattern 时用 tail 指定条数；要按正则过滤就给 pattern`。
- 修正第十三节的一句判断："session 不合并"针对的是**整族合一**；**成对看**时这两对恰恰是剩下最像的。
- 全量：源码树 **24 份 / 814 passed / 2 skipped / 0 failed**、安装副本 **24 份 / 828 passed / 0 skipped / 0 failed**；真宿主信标 `session.apply ok (4 tools: …)`、0 拒收。

**🧩 工具面收敛第二步：两个 help 合一个（2026-10-11，账本第十四节）—— 16 → 15 个工具**
- `ast_grep_help`（7 个规则主题）**并入** `toolkit_help`：现在 14 个主题一处取回（家族 `overview`/`table-diff`/`checkpoint`/`session`/`ast`/`ast-rules`/`gotchas`/`full` + 规则 `workflow`/`rule-object`/`atomic`/`relational`/`composite`/`metavariables`）。
- **依赖边界**：合并后的工具留在 **napi-free** 的 `lib/help/index.js`，主题表来自零依赖的 `lib/ast/help-topics.js` —— 刻意不 import `search.js`，否则会把 `@ast-grep/napi` 拖进帮助路径，废掉"缺依赖就隔离 AST 族"。
- **许可**：取回规则主题时**正文里回显上游 MIT 出处**（旧的 `ast_grep_help` 只把出处放在 `source` 字段、`render` 并不显示 ⇒ 用户看不到；这次补上）。切片复用同一个 `section()`：家族主题 `## X`、规则主题 `### 小节`。
- 诚实说明：省下的 schema 文本很少（1,206 → 1,088，约 10%），真正的收益是**少一个工具名与一个判断**；合并后 description 必须列出两族主题，这是文本没怎么降的原因。
- 同步：`lib/search.js` 摘掉定义与旧的 help 辅助代码、`ast_grep_search` 的提示改指 `toolkit_help`；6 份自测（AST 名字面 4→3、展开主题并入键集合、族声明、参数面/只读清单/工具数 15、名单 15/11、帮助体积上限 900→1,400）+ README 中英/AGENTS/PLAN/TOOLKIT。
- 全量：源码树 **24 份 / 814 passed / 2 skipped / 0 failed**、安装副本 **24 份 / 828 passed / 0 skipped / 0 failed**；真宿主 0 拒收。

**🧩 工具面收敛：动词族合并（2026-10-11，账本第十三节）—— 24 → 16 个工具**
- **`checkpoint`（7 → 1）**：`action` 驱动 —— `create` / `list` / `diff` / `restore`（默认只预览）/ `prune` / `journal` / `journal_restore`；默认 `action:"list"`（只读，不会误建快照）。schema 文本 **5,340 → 3,560 字符**。
- **`download`（3 → 1）**：`action` 驱动 —— `start`（默认）/ `probe` / `status` / `cancel`；`probe:true` 仍等价于 `action:"probe"`。文本 **4,364 → 3,781**。两族合计**省 24%**。
- **零业务逻辑改动**：原定义的 `execute` 与 `render` 原样作为内部实现，合并工具只做分派（render 也委派，保真"数组/字符串"两种返回）。
- **把"宿主 schema 拦的事"搬进工具体内**：每个 action 的必填参数与"多余参数"都给可读错误（如 `action "list" 不接受参数 "note"（该 action 可用：limit）`）。
- **L-1（已修）**：首版仍用 `tool({...})` 构造旧定义 ⇒ 宿主 `defineTool` 被多调用 10 次（被 `host-surface-selftest` 的捕获式 ctx 记成"24 个工具"）；改成普通对象字面量后每族只调一次（信标 `checkpoint: 1 tools registered` 佐证）。
- `/checkpoint`、`/rewind` 命令走内部函数，不受影响；受影响的 7 份自测用"动作绑定薄壳"适配（**调用点一行没改**），契约测试/工具名单/文档声明全部同步。
- 全量：源码树 **24 份 / 806 passed / 2 skipped / 0 failed**、安装副本 **24 份 / 820 passed / 0 skipped / 0 failed**；`lib` 零差异；真宿主 0 拒收。

**🧯 最后一轮：`checkpoint_restore` 故障注入（2026-10-11，账本第十二节）——抓到并修掉两个真 bug**
- **`test/restore-fuzz-selftest.mjs`（18 断言）**：默认只预览（`confirm` 前绝不写盘）、还原正确性、
  **not-stored(hash-only) 文件不许被写也不许被删**、失败不留半截（只读目标 ⇒ `回滚预检失败，未写入任何文件`；
  路径被目录占位 ⇒ `目标是目录` 且目录内容完好）、`files:[…]` 局部还原只动指定文件、
  `pruneExtra` 跨工作区必拒、**journal 往返能把被覆盖的版本取回来**、还原后被还原的文件不再出现在 diff 里。
- **🔴 K-1（已修）**：`checkpoint_restore` 覆盖/删除前**不留底** ⇒ 用快照回滚会吃掉用户更新的内容且 journal 救不回来；
  `pruneExtra` 删掉的文件（本就不在快照里）更是**永久丢失**。现在写回循环与 prune 删除前各调一次 `capturePreImage()`。
- **🔴 K-2（已修）**：`checkpoint_journal_restore` 的工具包装**不转发 `cwd`** ⇒ 边界校验退化成 `process.cwd()`（宿主目录）
  ⇒ **回滚会话工作区里的文件也会被"拒绝写回工作区之外"**。现在默认基准是**调用方会话工作区**，并新增 `cwd` / `allowOutside` 参数
  （`output-contract-selftest` 的 `EXPECTED_PARAMS` 已同步 —— 这个契约测试正是用来拦住"偷偷加参数"的）。
- 全量：源码树 **24 份 / 806 passed / 2 skipped / 0 failed**、安装副本 **24 份 / 820 passed / 0 skipped / 0 failed**。

**🛡 兜底审计：写盘原子性 + 性能回归（2026-10-11，账本第十一节）**
- **`test/writepath-fuzz-selftest.mjs`（21 断言）**：`ast_edit` 与 `session_export` 的**写盘不变量** ——
  preview 绝不改盘（逐文件 sha256）、**apply 失败必须原文件一字不变**（只读目标实测 `写盘预检失败，未写入任何文件`）、
  **preview 后文件被改必须拒绝**（实测 `文件在预览之后被改过，已拒绝写入`）、BOM(`efbbbf`)/CRLF 保真、零匹配不写盘、
  导出拒绝覆盖、**绝不写坏会话日志**（sessions 目录内 / zstd 魔数文件 / 真实日志三条都拒），产物自洽（jsonl 逐行可解析）。
- **J-4 文档↔行为不一致（已修）**：`session_export` 描述写 `directory must exist`，实现却**自动 mkdir**，注释又写"直接报错" ⇒ 三者矛盾。
  统一为"父目录不存在自动创建；已存在目标需 `overwrite:true`；会话日志永不覆盖"（保留友好的自动创建）。
- **`test/tablediff-perf-selftest.mjs`（8 断言）**：防"退化回嵌套遍历"——该工具诞生起因就是 O(N·M)。
  实测 25k **83 ms** → 50k 139 ms（×1.67）→ 100k 278 ms（×2.00）→ 200k **615 ms**（×2.21），四个规模计数逐项精确；
  断言计数精确 + 翻倍耗时比 ≤ 3.5 + 20 万行 ≤ 8 s。
- 全量：源码树 **23 份 / 788 passed / 2 skipped / 0 failed**，安装副本 **23 份 / 802 passed / 0 skipped / 0 failed**（skip 均为源码树缺 `@ast-grep/napi`/`yaml`）。

**🧪 换姿势审计第二轮：把"恶意输入 fuzz + 单条不变量"用到其它模块（2026-10-11）**
- **`test/tablediff-fuzz-selftest.mjs`（21 断言）**：性质化 —— P1「变异必被发现」（B = A 的一处已知改动：改值/加键/删键/重命名，9 种格式 × 多种子，**绝不能**报 "no differences"）、P2「自身比较不得误报」；外加 16 份畸形语料（截断的 JSON/Lua/TOML、重复键、NUL、UTF-16 BOM、1 MB 单行、200 层嵌套、Lua 循环引用、非 UTF-8、CRLF、PO 转义）与边界（文件不存在 / 传目录）⇒ **不抛代码级缺陷、不卡死**。结论：**未发现模块 bug**（重命名表现为"旧键消失 + 新键出现"是正确行为，是我的断言先写错了）。
- **`test/checkpoint-fuzz-selftest.mjs`（17 断言）**：I1 快照**绝不修改工作区**（前后逐文件 sha256 一致）、I2 junction 自指环/超长名/unicode/空文件/>1MB/深嵌套不崩不卡、I3 被列为可用的快照必须能 diff 打开且 restore 干跑给出计划、I4 写入中途被改（定时器删文件/追加变大/目录顶掉文件）后不变量仍成立、I5 `estimate:true` 绝不落盘。存储用官方 `DSH_TOOLKIT_CHECKPOINTS` 重定向 +「ROOT 不在临时目录就拒绝运行」自保。结论：**未发现模块 bug**。
- **`test/resume-fuzz-selftest.mjs`（6 断言）**：断点续传状态机 —— 随机时点 `abort`（1~3 次）与**真强杀 worker 进程**，断言 R1 中止后 `.part` 前缀与源**逐字节一致**、R2 manifest 合法、R3 续传后内容一致、R5 强杀后状态必须是 `interrupted`。
- **🔴 R5 抓到一个真 bug（已修）**：`download` 后台任务把状态写在 **`<目标文件目录>/.dsh-downloads`**，而 `download_status`/`download_cancel` 只在 **`<工作区>/downloads/.dsh-downloads`** 里找 ⇒ **只要 `to` 不在默认 `downloads/` 下就报"没有后台下载任务"**（worker 明明在跑、甚至已被杀，`.part` 却被当成"没这回事"）。修法：起任务时登记**任务索引** `jobs.json`（记录真实 stateDir）；status/cancel 用「默认目录 + 索引目录 + `<cwd>/.dsh-downloads` + 显式 `to` 的目录」候选集查找，取消标志也写到任务真实目录；并补 8b 节便宜的回归断言（自定义目标目录 ⇒ status/cancel 必须找得到）。
- 自测：新增 3 份 fuzz + download 自测 8b 节，全量 **21 份 / 763 passed / 1 skipped / 0 failed**。

**🔒 新代码新审计：两处安全/卫生修复 + 一处状态目录 bug（2026-10-11，审计账本第十节）**
- **J-1 跨站重定向泄漏凭据**：`fetchFollowing` 旧行为"跨主机保持自定义头" ⇒ `github.com → 任意第三方跳转` 会把用户的 `Cookie`/`Authorization` 一起送出。现在 `sameSite()` 判定：同主机/互为子域才保留，**跨站一律剥离**并在结果与 `probe` 输出里回显 `已剥离敏感头：Cookie, Authorization`（自测 18 节 8 条断言：跨站剥离 + 同站保留 + 说明文本）。
- **J-2 代理密码进会话记录**：`resolveProxy` 解析失败时把原始 URL（含 `user:pass@`）写进 `source`。新增 `maskCredentials()` 统一抹成 `socks5h://***@host:port`。
- **J-3 状态目录不一致**（由 `resume-fuzz-selftest` 随机强杀 worker 抓出）：状态写在 `<目标目录>/.dsh-downloads` 而 status/cancel 只查 `<工作区>/downloads/.dsh-downloads` ⇒ 目标不在默认目录下就"找不到任务"。修法见上（`jobs.json` 索引 + 候选目录集）。
- 账本 `sessions\dsh-plugin\docs\2026-10-10-generic-diff\AUDIT-ROUND4.md` 新增**第十节**：10.1 复核确认待修队列为 0（含逐标记统计），10.2 记录 J-1/J-2/J-3 与四份 fuzz 自测。全量 **21 份 / 771 passed / 0 failed**。

**🔴 P0 修复（2026-10-11 晚，用户实测"重启后两轮会话起不来"）**
- 症状：`session event "request/header" carries non-JSON-serializable data`，会话直接失败（禁用插件即恢复）。
- 根因：新加的 `download` 段把**原始 JSON Schema** 交给宿主 `defineTool`（宿主 DSL 要的是**字段映射**，顶层必须是参数名）⇒ 宿主拒收（`parameters.type must be a value schema object`）⇒ 三个工具退回"无 schema"注册 ⇒ 宿主写 `request/header` 事件时遇到不可序列化的工具定义而报错，**整个会话起不来**。
- 修复：与其它段一致改为 `defineTool({ ...def, parameters: toFieldMap(def.parameters) })`；真宿主复验 `download.apply ok (3 tools: …)`、`defineTool rejected = 0`、会话正常回复。
- **补了会红的护栏**（这是关键）：`output-contract-selftest` 新增"宿主 DSL 方言 lint" —— 用一个**像宿主那样挑剔**的假 DSL（顶层出现 `type`/`properties` 即拒收）跑一遍各段，任何一段交原始 JSON Schema 立刻红。已用"故意弄坏再还原"验证过它确实会红（`download: 原始 JSON Schema 不是宿主方言`）。

**🌐 代理探测补上 PAC 与端口兜底（用户机器实测驱动）**
- 用户机器实测：本地代理软件用 **PAC 模式**（`AutoConfigURL=http://127.0.0.1:53670/commands/pac`，而 `ProxyEnable=0`）⇒ 只读注册表固定代理会"检测不到"，但 7890（常见 mixed 端口，不保证）明明在监听。
- `auto` 现在是四级链并**如实回显来源**：注册表固定代理 → **PAC 文本里的 `PROXY` 字面量**（不执行 JS）→ 环境变量 → **探测常见本地端口**（7890/7891/10809/10808/1080/8889 —— 常见惯例值，其中 7890/7891 常被本地代理软件用作 mixed 端口，均不保证）。PAC 模式下系统 `ProxyOverride` 的 bypass 依然生效。
- **本机实测样例（换机器/换网络会不同；经本地代理）**：`auto` → `http://127.0.0.1:7890`（常见 mixed 端口，不保证；来源 `PAC (PROXY 字面量)`）；8 连接合计 **18.7 MB/s**（单连接 2–2.6 MB/s），直连 8 连接 13.4 MB/s，经代理 2 连接 6.2 MB/s ⇒ **"代理按连接限速"被证实，多线程确实治它**。
**🧵 线程数改为自动（2026-10-11 晚，用户要求）**
- `threads` **不给即自动**：`planThreads()` = **大小档**（`<1 MB→1`、`<8 MB→3`、`<64 MB→6`、`<512 MB→8`、`≥512 MB→12`）× **实测每连接增益**（探测的 `合计 ÷ 中位单连接`；`<1.8×` ⇒ 收敛到 ≤4，说明瓶颈不在"每连接限速"）→ 再按"有用片数"封顶（`minSplitSize` 很大时自动减）。**给数字即手动**（`1` = 单流，上限 32）。
- 输出与 `probe` 都回显依据与理由，例如 `threads=auto→6（大小档 6 + 探测显示多连接有效（合计 ≈ 4.1× 单连接））`、`threads=auto→1（文件很小（600 KB < 1 MB）⇒ 单流更划算）`。
- 实测：600 KB ⇒ `mode=single threads=auto→1`；20 MB ⇒ `mode=segmented threads=auto→6`；真链接 4.2 MB ⇒ `probe` 给出 `线程建议: auto ⇒ threads=3`。自测 +11 条断言（含"无增益要收敛""手动优先""按有用片数封顶"），下载自测 43 条、全量 **17 份 / 679 passed**。
**🧪 换姿势审计：恶意服务器 fuzz（2026-10-11）**
- 新增 `test/download-fuzz-selftest.mjs`：种子化随机耍赖的服务器（断流/复位、Range 当整包回、乱报 `Content-Length`/`Content-Range`、429/503、变慢、**故意给"格式合法但内容错位"的字节**），只断言一条不变量：**绝不产出"成功但内容不对"的文件**。
- 实测（24 种子/模式）：`clean` 9 成功/15 干净失败/**0 违例**；`sha` 10 成功/14 干净失败（**2 次被 sha256 拦下**）/**0 违例**；`corrupt`（篡改+无校验）10 成功/12 干净失败/**2 次不可发现**。
- 结论落地：① **有校验值时不存在静默损坏**；② 无校验值时"格式合法的篡改"无法发现 ⇒ 结果里**主动提示**带 `sha256`（GitHub Release 常带 `.sha256` 附件）；③ 失败一律"干净"（不生成目标文件、无代码级异常）。
- 自测新增 1 份（共 **18 份**）+ 2 条断言；fuzz 默认 8/5/5 个种子（约 18 s），`DSH_FUZZ_SEEDS` 可加深。
**🚫 代理语义定案：`auto` 跟随系统代理，不做"直连清单"（2026-10-11 用户否掉了清单方案）**
- 曾实现过"逐条维护直连清单（`~/.dsh/dsh-toolkit/direct-hosts.txt` + `<cwd>/.dsh-download-direct`）"，用户指出：**一条条加不是聪明手段**，而且 PAC/规则模式下**代理自己**就会决定哪些直连 —— 这与本地代理软件自身的规则表重复。**已整体撤掉**（代码/自测/文档）。
- 最终语义：`auto`（默认）= **跟随系统代理**（PAC/规则模式由代理裁决；全局模式全走代理）；需要绕过某次下载（已知该链接走代理反而更慢）就**显式** `proxy:'none'`；`NO_PROXY/no_proxy` 照常生效。
- 保留并修正了 `NO_PROXY`：以前只有"代理来自环境变量"时才看它，走本地代理软件（注册表/PAC）时被无视 ⇒ 现在 `auto` 也会合并它做 bypass（自测可见 `bypass (PAC (PROXY 字面量) / NO_PROXY)`）。
**🩺 失败诊断（DNS 解析失败 / 连不上 / TLS 重置 / 代理不可用）（2026-10-11 晚）**
- 用户环境：若你的网络对域名解析有干扰，直连 GitHub 会大部分时间连不上、偶尔能连但很慢（本机实测样例，换网络/换机器会不同）。于是失败信息不再只说 `fetch failed`：
  `classifyNetError()` + `diagnoseNetError()` 把错误分成 DNS / 连接 / TLS重置 / 代理四类，并**给出下一步**（没装代理 ⇒ 先查 DNS / 换网络 / 换加密 DNS；若你有本地代理软件 ⇒ 开它的“系统代理”或 TUN；代理已开却解析失败 ⇒ 换节点；连不上 ⇒ 给出显式 `proxy:"http://127.0.0.1:7890"`（常见 mixed 端口，不保证）写法）。
- 诊断里报告的是**异步解析结果**（含 PAC 与端口探测），不会因为"只读注册表"而误报"本机无代理"。
- 自测 +8 条（含一次真实 `.invalid` 域名解析失败的端到端：错误里必须带 `诊断：` 与 `出路：`）。下载自测 68 条。

**📡 GitHub 真链接实测驱动的一轮修复（2026-10-11 晚，用户："从 GitHub 下载走代理也慢"）**
- **最要命的发现：多线程根本没生效**。实测 `threads=auto→2` 却 `chunks=1` —— 2 MB 的文件被
  "片下限 = minSplitSize(1 MB) + 尾巴小于下限就并回前一块"的规则并成了**单块**，于是无论请求几个线程都只有一条连接。
  修法：片下限改为 `min(minSplitSize, total/(threads*2))`（小文件允许更小的片，保证能切出 ≥2n 块），
  尾巴只在"不到一块的一半"时才合并。现在 2 MB → 4~16 块，120 MB → 32 块，100 MB + `minSplitSize:8MB` 仍是 8 MB 大片。
- **慢链路自动多开连接**：本机实测样例（换机器/换网络会不同）—— 经本地代理下 GitHub 每连接只有 0.2~0.4 MB/s，而连接加上去总带宽继续涨
  （同一 22.7 MB 文件：4 连接 3.77 MB/s、16 连接 **7.72 MB/s**；2 MB 文件 1→16 连接 0.036→0.298 MB/s）。
  ⇒ `planThreads` 新增判据：**多连接有效（gain ≥ 1.8）× 每连接 < 1 MB/s ⇒ 档位 ×4**（仍受自动上限 16 约束）。
  自动档现在对"GitHub 20 MB 级 + 代理"给出 `threads=16`，而不是原来的 4。
- **又抓到两个真 bug**（同样由夹具/真机逼出来）：
  1. **单流回退时的竞态**：`Promise.all` 在第一个 rejection 就返回，其他 worker 还在往 `.part` 里写，
     而回退路径已经 `truncate(0)` + 重置分片 ⇒ 合并后大小对不上（实测 393216 ≠ 3145728）。
     现在每轮带 `AbortController`：回退前先 `abort()` 并 `allSettled` 等所有 worker 停稳；`acquire()` 也响应取消（避免死等名额）。
  2. **"降到单通道仍被拒就判死"是误判**：服务器上常有一条残留连接（或刚触发限流），单通道被拒 ⇒ 现在
     最多重试 6 次（有进展就清零），连续无进展才报"该站点禁止下载/需鉴权"。
- 真链接验证：`ripgrep-14.1.1-x86_64-pc-windows-msvc.zip` 五次不同线程数下载 **sha256 全部等于官方值**；
  HandBrake 22.7 MB 两次（4/16 线程）sha256 一致。文件落在 `downloads\`。
- 自测：下载自测 **57 条**（新增"线程数不超过实际片数""minSplitSize 很大也不许掐死并行""慢链路多开""快链路不盲目多开"）；全量 **17 份 / 696 passed / 0 failed**。

**🧵 线程档改为 1/2/4/8/16 + 收尾加速 + 两类站点兜底（2026-10-11 晚，用户连续三条要求）**
- **线程档**：自动档改成**递进值 1/2/4/8/16**（`<1 MB→1`、`<8 MB→2`、`<64 MB→4`、`<512 MB→8`、`≥512 MB→16`；增益 <1.8× 折半），**自动上限 16**（用户：32 太多容易被服务器干），**手动**可到 32。输出回显依据。
- **收尾加速 `tailBoost`**（默认开）：用户指出 ABD 的通病 —— 收尾时其他连接结束、剩下的连接仍停在旧的带宽均分份额上，导致最后一段特别慢（他的办法是暂停再继续）。现在**自动做**：某块速率低于"本任务见过的最好速率"（基准优先取探测中位速率）持续 2 次采样 ⇒ 断开重连 + （有空闲连接时）把剩余范围劈一半回队列。夹具实测 **13.9 s → 7.2 s**。
- **分块硬下限**（用户："剩下的小块也一直分就会出问题"）：劈开要求两半 ≥ `max(512 KB, minSplitSize)`；同块最多劈 2 次；碎块并入相邻块；新增 `canSplit()`/`normalizeChunks()` 与**覆盖性校验**。
- **两类站点兜底**（用户："有些网站不支持断点续传或者禁止多线程" + "允许并发但限制连接数量，16 条只有 4 条通"）：
  - 分段被忽略（回整包 200）⇒ **自动回退单流**（清空重下并说明），不再让用户手动整包重下；
  - 403/429/503 ⇒ **降并发 + 该块回队列，绝不判死整个下载**（此前一个块的失败会带崩整个下载，降线程来不及生效）；遵守 `Retry-After`；**按主机记住实测上限**（第二次实测零拒绝）；连续成功且 8 s 无拒绝时保守向上试探（每下载 ≤3 次）。
- **又抓到两个真 bug**（都是夹具/断言逼出来的）：
  1. **静默损坏**：worker 循环搜的是"启动时的快照队列"，动态劈出的块 push 进的是 `manifest.chunks` ⇒ **新块永远没人下**，文件缺一段却照样改名成功（sha256 有值也只在用户给了期望值时才比对）。已改为查活列表，并加"**落盘前逐片校验 + 覆盖性校验**"这道结构性防线。
  2. `bestRate` 基准只来自"本次下载里快块的采样"，而快块可能 2 秒内就下完 ⇒ 基准缺失 ⇒ 收尾加速永不触发（夹具实测）。已改为**优先以探测阶段的每连接中位速率为基准**。
- 自测：下载自测 **57 条断言**（新增收尾加速、分块下限/覆盖性、忽略 Range 回退单流、限连接数自适应与主机记忆）；全量 **17 份 / 0 failed**。
### 多线程下载器（2026-10-11 第五批）

- 起因：宿主直连尚可、**经本地代理反而卡**，同一链接在用户的下载器里很快 ⇒ 需要"多连接 + 续传"的下载能力。
- **先做了调研**（见 `docs/DOWNLOAD.md`）：aria2 是 GPLv2（只能借鉴语义）、用户自用的 **AB Download Manager 是 Apache-2.0**（引擎结构可借鉴/移植）、最接近的 Node 库 `node-downloader-helper`（MIT）**只做单流**、解决不了"按连接限速"。⇒ **自研零依赖实现**，许可与归属写进 `THIRD-PARTY-NOTICES.md`。
- **已落地**：
  - `lib/download/net.js`：重定向跟随、Range、**系统代理自动探测（Windows 读注册表；其它平台读环境变量）** + 环境变量 + 显式 HTTP/SOCKS5（含 CONNECT 隧道、`socks5h` 远程解析、账号密码）、`NO_PROXY/ProxyOverride`、代理不可达**明确报错不静默直连**、连接/首字节耗时统计；
  - `lib/download/engine.js`：**chunk 队列 + 工作窃取**（对应 aria2 piece+selector）、`minSplitSize`（尾块合并）、**慢片动态拆分**（连续低速 ⇒ 剩余范围劈开扔回队列，对应 AB 的 `PartSplitSupport`）、`.part` + manifest 断点续传（远端变了就重来）、片内断流续请求、**收尾原子改名**、无条件 self-sha256 + 可选期望值、单流回退、限速、每块重试 3 次。
- **本地夹具 9/9 通过**（本地 Range 服务器模拟：重定向/忽略 Range/缺头 403/反复断流/中止后续传/坏 hash/同名拒绝/坏代理）。
  - 期间抓到并修掉 **2 个真 bug**：① `.part` 用 `'a+'` 打开 ⇒ `O_APPEND` 让定位写失效，分片乱序落盘（**大小对、内容错**，只有 sha256 能发现）；② 服务器中途断流被误判成"用户中止"（Node 响应流把提前关闭报成 `aborted`）⇒ 该重试的没重试。
  - 另修一个监听泄漏（keep-alive 复用 socket 时反复加 `connect` 监听 ⇒ `MaxListenersExceededWarning`）。
- **工具三件套 + 后台 worker 已落地**（工具数 21 → **24**）：
  - `download`（`probe:true` 只探测不落盘 / `mode:auto` ≤32 MB 前台、更大自动转后台 / 默认落盘 `<工作区>\downloads\` / 同名拒绝、`overwrite:true` 才覆盖 / `headers`+`cookie`+`referer` / `sha256`+`expectedBytes` 校验 / `minSplitSize`·`lowestSpeedLimit`·`speedLimit`·`timeoutMs`）；
  - `download_status`（进度/速度/分片/splits/代理；识别“worker 已死但 `.part` 还在” ⇒ 报 `interrupted` 且提示可续）；
  - `download_cancel`（写取消标志 → worker 优雅 abort；`.part`+manifest **默认保留**可续，`deletePart:true` 才删）；
  - `worker.js`（detached 进程 + 状态 JSON + 日志 + 取消轮询 + 中断可续）。
- **自测**：新增 `test/download-selftest.mjs`（本地 Range 夹具，**离线可跑**）32 条断言：重定向 / 分片一致性 / 反复断流续传 / 中止续传 / sha256 拒绝与通过 / 忽略 Range 回退单流 / 同名拒绝 / 后台→状态→取消→续传 / 参数校验 / 坏代理。全量 **17 份 / 667 passed / 0 failed**。
  - 又抓到 1 个真 bug：`download_status` 把 worker 的参数文件 `*.spec.json` 当成状态文件读 ⇒ 列表出现“幽灵任务”并崩（已排除）。
- **真链接验证**：npmmirror（302 → CDN）4,376,902 字节，**工具自算 sha256 ≡ 独立计算**；二次下载带 `sha256` 校验通过、大小一致；1 线程 24 MB/s vs 8 线程 19 MB/s（本机实测样例，换机器/换链路会不同）⇒ 探针现在会提示“文件 <16 MB 时多线程未必更快”。
- **代理现状**：本机当前**没有**系统代理/环境变量（`getSystemProxy()` 返回 null）⇒ 本地代理那条路的真机演示需要先把它的“系统代理”打开，再跑一次 `probe`（`proxy:'auto'` 会自动读到它的端口）。
### 评审方第三次复核的三条跟进（2026-10-11，第四批）

**🔴 自测可移植性（他们硬失败；我上一轮的结论说错了）**
- 事实更正：我上轮说"源码树 + 安装副本各跑一遍都 ALL PASS" —— **安装副本那半我没真跑到**（我的循环跑的是源码树的测试文件、只换了 cwd）。评审方在安装副本里跑**它自己的** `session-selftest.mjs` 得到 `exit 1`：该测试用**自身文件位置**推导被测工作区 ⇒ 副本里推出 `~/.dsh/profiles/<你的 profile>`（**没有会话日志**）⇒ 断言必红、`session_peek` 抛错还把后面用例带崩。
- 修法：`session_list` **不传 cwd = 全库列表**、其余工具**显式给 id 不受 cwd 限制** ⇒ 自测不再依赖自身位置；**本机一个会话都没有时打 SKIP 并算通过**；每个会话段独立 `try/catch`（一条失败不再吞掉整份）；末尾固定打印 `ALL PASS (n)`。
- 实测：安装副本里 `ALL PASS (10)`、`exit 0` ✓。

**ℹ️ 断言总数现在可核对**
- 新增 `test/run-all.mjs`：逐份跑 `*-selftest.mjs`，统计每份 `PASS/SKIP/FAIL` 并**检查退出码**（以前只看文本，一份崩了但没打 FAIL 就可能被漏掉），末尾输出 `TOTAL: 16 files, 633 passed, 0 skipped, 0 failed, 0 non-zero exit` + `ALL PASS (633)`。
- README（中英）与 AGENTS 的自测声明改成引用这条可复现的命令。

**💡 `table_diff` 内联侧表头不再喷全文**：回显 `<inline: N 字符>`（与 `table_peek` 一致），长内容不再淹没表头；已加断言守着。

**顺带**：`ast_grep_help` 描述里点明 `gotchas`/`overview` 属于 `toolkit_help`（他们第二次回执的小提示）。

**第五批（同日，采纳"别把总数写死"）**
- 评审方实测本机是 `632 passed / 1 skipped`（那条 `session_catalog 表格断言`按设计跳过 —— 最新会话没有 catalog 登记）⇒ **断言总数是环境相关的**。README（中英）与 AGENTS 里写死的 `633 passed, 0 skipped` 已改成 **`632-633 passed, 0 failed, 0 non-zero exit`**，并注明**稳定判据是 0 failed / 0 non-zero exit**。
- `run-all.mjs` 现在**自己解释 SKIP**（有跳过时打印"属于正常设计：会话族自测在本机没有会话 / 最新会话没有 catalog 登记时会跳过对应断言"），避免下一个人以为"数字对不上"。

### 评审建议 3 / 5 落地 + 嗅探修复（2026-10-11，第三批）

**🔎 顺带修掉一个"今天就会踩"的静默错：未知扩展名的内容嗅探**
- 旧 `guessText()` 只试 `json → properties → csv` ⇒ **TOML/YAML/JSONL 被静默当成 properties**（实测 `[t]\ny = 2` 解析成键 `[t]`；`toml → properties(2 条)`、`yaml → properties(3 条)`、`jsonl → properties(2 条)`），都是"看着正常、其实错"的 diff。
- 重写为**判别性检查 + 顺序**：`jsonl`（每行都能 JSON.parse）→ `json` → `toml`（`[table]`/`key = value`）→ `yaml`（嵌套键/`- ` 列表/`---`）→ `lua` → `mappings` → `properties` → `csv`，并**淘汰"跳过坏行 ≥ 记录数"的半成品**候选（properties 文件被 TOML 半解析正是这个坑）。
- 命中后**回显胜出者**、点名其它可解析候选；**依赖缺失也点名**（源码树没装 `yaml` 时不再悄悄给 properties）。实测 7 种格式全部识别正确。

**建议 5 — `table_diff` / `table_peek` 支持 `text:` 内联侧**
- `a: "text:<内容>"` 直接与真实文件对比，不必先落临时文件；**不加新参数**（schema 不变），在 `resolvePath` **之前**拦截（Windows 文件名不能含 `:` ⇒ 零冲突）。
- 内联内容走嗅探或显式 `format`；来源回显 `<inline: N 字符>`；空内容**明确报错**；`table_peek` 同样支持。

**建议 3 — 新工具 `session_catalog`（工具数 20 → 21）**
- 一次调用给出某会话的**子代理/catalog 登记表**：`childId` / `mode` / `label` / 创建时间 / 登记次数 / **子代理会话目录是否还在** / 体量 / **gc-backup 备份**，末尾"彻底丢失 N 个"汇总 + 幽灵行告警，并报 `seq` 缺号与"认不出的 catalog 形状"。
- 真实数据实测（本机样例）：某个本地化模组工作区的某父会话 **17 个 child 全部不在**（11 个可从 `~/.dsh/subagent-gc-backup` 救回，**6 个彻底丢失**）；另一会话 5 个 `Audit …` 子代理仍在且体积可见。
- 避开旧脚本两个坑：真实形状是**一条事件一个 child**（不是快照数组）、工作区 slug 不硬编码；统计覆盖**全部** child（早先只统计显示出来的前 N 行 ⇒ 汇总偏小，已修）。
- 同步 12 处"20 个工具"声明（README×2 / package.json / TOOLKIT / AGENTS / PLAN / docs-claims / output-contract / host-surface），并把 `session_catalog` 加进参数面钉住表。

**测试**：+13 条断言（嗅探 7 + 内联 5 + catalog），全量 **16 份 / 631 PASS 全部 ALL PASS**（源码树与安装副本各跑一遍）。

### 宿主侧实测评审的修复（2026-10-11，来自某个本地化模组工作区会话的 `sessions\dsh-plugin\docs\2026-10-11-dsh-toolkit-host-review\LOG.md`）

**回归修复（评审方独立复核抓到的、我新功能里的真 bug）**
- `ast_grep_search` 的 **`paths` + `capture_names` 100% 抛 `TypeError: node.getMultipleMatches is not a function`**：`captures` 构造写成了 `capture(name, …) ? capture(node, name, …) : undefined` —— **参数错位**（把捕获名字符串当 node 传）且是多余的重复提取。现在只调一次 `capture(node, name, maxMatchChars)`；**用评审方那条逐字命令在真宿主复验：`count=5 name=rollFortune`**。
- **覆盖补齐**（原来 `paths` + `capture_names` 组合零覆盖）：`test/ast-search-selftest.mjs` +5 条（捕获文本、`file/line/column`、`filesSearched/filesWithHits`、glob + `$$$ARGS`、`source`+`paths` 同给报错）。
- `session-selftest.mjs` 改为**带真断言**（7 条）+ 结尾 `ALL PASS`（失败 exit 1）⇒ 现在 **16/16 全部打印 ALL PASS**。
- `output-contract-selftest.mjs` 增加 **"参数面钉住"**：20 个工具的参数集逐字比对，**增删参数必须同步该表**（比 `docs-claims` 那条"列出的都已声明"能真正拦住文档↔实现漂移）；`docs-claims` 的参数表补上 `paths`。

**P0 — `ast_grep_help` 完全不可用（工具 0% 可用）**：`output.schema` 声明了 `additionalProperties: false` 却**没列 properties** ⇒ 宿主校验返回值时把 `topic/source/markdown` 全判"未声明属性"（与 `ast_grep_search` 修过的是同一类错，当时漏改了这一个）。顺带发现 `source` 实际是**对象**（`{url, commit, license…}`）而 schema 写成了 `string` —— 由新加的"输出契约自测"抓出。

**P1 — `checkpoint_diff` 不传 `cwd` 时对照树取错（静默错）**：工具层在"对照当前工作区"时硬塞了**调用方会话工作区**、覆盖了快照记录的 `cwd` ⇒ 子目录做的快照会拿整棵树比，输出 `added=2960` 这种"看似正常、实则完全错"的数字。现在**默认取 `rec.cwd`**，与本次会话工作区不同时**置顶提示**两个路径。

**P2 — 自测的 cwd 假设**：`checkpoint-guards` / `checkpoint-selftest` / `session-selftest` 在**插件目录里**跑会红；现在显式给 `cwd`、会话自测默认用由文件位置推出的工作区根 ⇒ **两个目录下都 16/16 全绿**。

**观察项（4 条已修）**：路径/glob 误传给 `source` 现在报错并指向 `paths`；`ast_grep_search` **0 命中时附常见原因**；`ast_edit` 预览对"多行压成一行"点名（`$$$BODY` 模板固有行为）；`checkpoint_journal` 空结果改说"没有 pre-image（新建文件或未经宿主 fs 层）"、`checkpoint_diff` 的 id 前缀报错补说明、`session_diff` 提示"可能不是同源会话"。

**功能建议（3 条已做）**：`ast_grep_search {paths:[…]}`（按文件/目录/glob 搜结构，语言按扩展名自动判定；实测在 `lib/**/*.js` 上一次找出 16 处 `async function` 定义）、`table_diff {only:"same"}`（列出两侧一致的条目 = 词表里"哪些还没翻"）、`checkpoint_create {estimate:true}` / `{presetExclude:true}`（先估算再决定；本机实测样例 —— 某个本地化模组工作区：15,060 文件 / 115 MB / 8,219 个只能记哈希 / 5.3 s，换工作区会不同）。

**新增第 16 份自测 `output-contract-selftest.mjs`**（建议 6，**能拦住 P0 那类 bug**）：静态 lint（`additionalProperties:false` 的 object 必须声明 properties）+ 动态校验（13 个只读工具真跑一遍，用各自 `output.schema` 校验返回值）。

**未做（留待观察）**：建议 3（`session_catalog` 新工具）、建议 5（`table_diff` 一侧用内联字符串）。

**回归护栏（2026-10-11，用户提问触发："新功能会不会把老问题带回来"）**
- 逐条实测新格式 × 旧修复点，**抓到 2 个真漏洞并修掉**：
  1. **jar 内非 UTF-8 条目**以前直接抛裸 `SyntaxError`（老修复点"saferead 的编码提示/优雅失败"在 zip 路径上漏了）⇒ 现在与安全读文件同等对待：先给编码提示，再抛出**可操作**的错误（含"可能不是 UTF-8（解出 N 个 U+FFFD）"+ 下一步建议）；
  2. **zip 炸弹无上限**：`inflateRawSync` 以前不设上限，一个 80 MB 声明值的条目会被整个解出来 ⇒ 现在加**单条目 64 MB 上限**（同时看 head 声明值与 `maxOutputLength` 兜真实解压量），实测**1 ms 拒绝**且 RSS 零增长。
- 其余回归点实测**均未被带回来**：相对路径（jar / `#entry:` / TOML / 映射 `.txt`）由工具层按调用方会话工作区解析 ✓；glob 合并多 jar 并报重复键 ✓；假 jar/不存在/0 记录 → 明确报错或置顶 `⚠⚠`+"无法比较" ✓；同名 zip 条目 → 重复键告警 ✓；`#table(k,v)` 仍走值模式 ✓。
- 这 5 类共 **12 条断言进常驻自测**（含"声明 100 MB 的条目秒拒"这种手工构造的炸弹、以及"整包读 vs 大包有界读结果一致"），防止以后再次回归。
- **大包按文件大小分档读**（2026-10-11，用户建议）：`listZipEntries` ≤64 MB 整包读、更大的包**只读尾部 64 KB + 中央目录区间**（19 MB 的包实测只读 301 KB 中央目录），`readZipEntry` 也只读该条目自己的字节区间；两条路径在真包上（3093 条目）实测**逐字段完全一致**，中央目录另有 256 MB 上限。
**新增：混淆映射适配器（C，2026-10-11）—— 跟版时看"哪些符号改名了"**
- 一个新格式 `mappings`，四种真实格式全认（**按内容嗅探**，`.txt` 也能自动识别）：**Mojang/ProGuard**（`client-*-mappings.txt`）、**TSRG2**（NeoForm `joined.tsrg`、MCP `mcp_config-*`）、**经典 SRG**（`CL:/FD:/MD:`）、**Tiny/Yarn**（v1/v2）。记录带 `kind`（class/field/method），可用 `filter` 只比某一类。
- 真实文件核对：Mojang `1.20.1`（104,048 条）与 MCP `tsrg2 1.20.1`（104,048 条）**数量一致**（同一套映射两种格式，互相印证）；9.6 MB 文件解析约 **100 ms**；真宿主里 `1.20.1 → 1.21.1` 官方映射一次 diff 直接给出 added/removed/changed。
- 期间由**重复键护栏**抓到两个真问题并修掉：
  1. TSRG2 头是 `obf srg id` 时，取"最后一列"会拿到**纯数字的 id**（实测值 `252363`）⇒ 改成按命名空间名优先取 `srg`/`named`，其次取最后一个非纯数字列；
  2. Mojang 官方映射里存在**同名同参数、仅返回类型不同**的桥接方法 ⇒ 方法键改为 `owner.name(args):返回类型`，实测真文件重复键 **100+ → 0**（`119607 records / 119607 unique`）。
- 另修 TSRG2 方法的命名空间下标错位、Tiny v2 的 `f/m` 行（第 1 列是描述符、名字从第 2 列起）与行首制表处理。
- 自测 +15 条断言（五种格式 + 嗅探 + 桥接方法 + 普通 .txt 不误判 + 默认值模式）；全量 15 份 / **581 断言**全绿。
- 顺带：映射适配器会**宣告值列** ⇒ `table_diff` 对映射默认走**值模式**（"名字对名字"，`key=key value=value`），不再逐字段列 `value: b -> a`；`table_peek` 也据此显示 key/value。
### 新功能：zip/jar 与 TOML 适配器（2026-10-10，为 MC 模组"跟上游版本"对比而做）
- **`table_diff` 直接吃 `.jar` / `.zip`**：传 jar 路径 ⇒ 条目清单记录（`path`/`size`/`compressed`/`crc32`/`method`）；`mod.jar#entry:META-INF/mods.toml` ⇒ 把**该条目当文本**解析（按条目扩展名自动选格式）。二进制条目（`.class`/图片）**明确拒绝**并提示先反编译，不硬塞文本解析。
- **TOML 适配器**（零依赖，覆盖 `[table]` / `[[array of tables]]` / 点号键 / `"""多行"""` / 数组 / 内联表 / 注释；不支持的语法会点名）：`mods.toml` / `neoforge.mods.toml` 可直接比。
- `DEFAULT_KEY_FIELDS` 增加 `path`（jar 清单自动拿条目路径当键）；`format` 校验仍在适配器层。
- 实测（真宿主；本机样例 —— 某个本地化模组的两版 jar）：上游 `1.2.3` → `1.2.4` ⇒ `added=8 removed=0 changed=250`；`#entry:META-INF/mods.toml` ⇒ `mods.0.version 1.2.3-… → 1.2.4-…`。
- 自测 +15 条断言（自带一个**只写 stored 的迷你 zip 生成器**，零依赖造 fixture；含二进制拒绝、缺失条目提示、TOML 数组表/多行字符串/注释）。
### 审计第四轮：5 个并行只读审计 → **待修队列已清零（95 条 ✅）**（总账见 `sessions/dsh-plugin/docs/2026-10-10-generic-diff/AUDIT-ROUND4.md`）

审计覆盖 `lib` 下全部文件（含从未逐行看过的上游 `search.js`、入口与会话工具族）。**发现约 57 条**，按"数据丢失 / 静默错 / 可用性"优先修，本版落地 34 条。

**session 工具族（假阴性、挂死、毁日志、OOM —— 全部有最小复现）**
- **`grep`/`peek` 对流式事件内容失明**：真实日志里 `reasoning-chunks`/`text-chunks` 的正文在 `data.texts[]`，旧键表没读它 ⇒ **44%~71% 的事件内容搜不到**（导出成 jsonl 后 `rg` 却能搜到）。现在补键表 + 新增遍历所有字符串值的 `deepTextOf`；**用审计给出的那句复测：从假阴性变成 3/3 命中**。
- **正则灾难性回溯 ⇒ 工具永久挂死**（实测 `(a+)+$` 跑满 300 s 不返回、宿主卡住）：新增粗筛护栏直接拒绝、剥掉会让 `test()` 带状态的 `g/y`、支持 `exec.signal` 中止、夹逼 width/limit。
- **`session_export` 会把会话日志写坏**：`to` 指向日志本身即变成裸 jsonl ⇒ `frames=0`、**会话永久打不开**，而工具回报成功。现在写盘前校验（拒绝会话日志目录 / zstd 文件 / 等于源日志；已存在文件需 `overwrite: true`），并改**临时文件 + rename 原子替换**。
- **导出内存**：39.7 MB 日志旧实现 RSS 1 GB、事件循环冻结 3.5 s、小堆下 V8 OOM abort 整个宿主 ⇒ 改 512 条一批流式写。
- **`slugOf` 与宿主转义不一致**（空格折叠成 `-` 而宿主写 `~0020`）⇒ 含空格的工作区 `cwd=`/`last` **静默失效**、还打印假的"按调用方工作区解析"。现在复刻宿主规则 + 用头帧 `cwd` 真值兜底；作用域为空时**直接报错**而不是回退全局最新。
- 坏行、空文件、非 zstd、非 UTF-8 全部外显（以前静默 `events=0` 且零告警）；`session_list` 按 id 合并并标版本、limit 夹逼外显；id 前缀歧义改为报错列候选；`currentWorkspaceCwd` 未命中返回 null；diff 增加"对齐置信度"提示（同 key 游程内是按位置配对）。

**入口与打包（可用性红线）**
- **静态 import 架空分段保护**（A-1）：入口原本顶层静态 import 六段 ⇒ 任一深层依赖坏掉（缺 yaml、@ast-grep/lang-* 原生二进制缺失）**整个插件 import 失败**，6 个 try/catch 一次都跑不到、20 工具全没。改为**段内 await import()**；隔离副本实测（去掉 yaml/napi）：入口照常加载并注册 **15 个工具**，只损失需要 napi 的 AST 族。
- **defineTool 兜底形状**（A-2）：以前兜底是恒等函数 ⇒ 15 个工具丢全部入参校验、ast_edit 的 output.schema 会被宿主 register() 拒绝而**静默消失**。现在兜底把**字段映射翻译成宿主接受的 JSON Schema**（parameters 与 output.schema 都译），并导出 defineToolKind 让信标写明用的是哪一支。
- **宿主面自测改成真入口**（A-5）：以前是假 ctx + 恒等 defineTool，结构上抓不到"打挂插件"的方言错。现在导入真入口并断言 20 工具、名字唯一、parameters/output 形状、inject，外加"入口不得静态 import 功能段"的结构护栏。

**tablediff（4 个高危 + 1 个误判）**
- **mapRecords.push(...arr) 栈溢出**（F4）：映射表 ≥13 万行直接 RangeError 崩掉整条链路 ⇒ 改逐条 push。
- **单文件内重复键静默覆盖**（F3）：1000 行塌成 3 个键却零提示 ⇒ project 统计并在输出里点名（⚠ 单文件内出现重复键…k1×2）。
- **投影 0 键仍报"无差异"**（F1）：valueField 写错时 3 条记录变 0 键，输出干净得像"确实没差异" ⇒ skipped/0 键置顶 ⚠⚠ 并**替换结论行**为"无法比较"。
- **两侧模式不一致输出 [object Object]**（F2）：一侧整记录、一侧标量时会拿对象比字符串 ⇒ 大声告警 + 记录侧按**摘要文本**参与比较。
- **"无法比较"的判定改为结构化标志**（F19）：以前只要 head 里有 ⚠⚠ 就判不可比较（我新加的告警立刻触发了它）⇒ 只有 0 文件/0 记录/0 键才替换结论行。

**低危扫尾（28 条一次性清完：checkpoint / ast_edit / tablediff / session / entry）**

**checkpoint**：E-M3 journal >20 MB 不再静默（写 `skipped.json` 并由 `checkpoint_journal` 点名）；E-M4 DP 超限的"近似 diff"会显式提示（以前中间未改动的行也显示成 -/+ 却看不出是近似）；E-M6 `checkpoint_list` 改报**快照目录真实占用**（`dirBytes`，旧汇总 30 B vs 实际 1.08 MB）；E-L2 配置留底不再是死重量（`checkpoint_diff {configs:true}` 做键顺序无关对比）。E-M1/E-M2/E-M5/E-M7/E-L1 复核确认此前已修。

**ast_edit**：D-14 提示去重（不再按 op 数重复）、D-15 明说"多规则时行号基于中间态"、D-16 `filesSearched` 统一为候选文件数（目录遍历数改叫 `entriesScanned`）、D-17 暂存**按会话**各自 20 条上限（以前全局 50 条会被别的会话挤掉）、D-18 匿名桶按进程隔离、D-20 单文件失败措辞、D-21 注释与实现一致、D-22 preview/apply 都查 abort、D-附 `.C/.H` 按 C++ 解析 + 补 `.json5/.mdx`、D-存疑 **保留 POSIX 权限位**（0755 不再变 0644）。

**tablediff**：F12 单列文本不再吞首行；F13 properties 支持续行/`\uXXXX`/`export`/引号剥离；F14 PO 的 `msgctxt` 并入键、复数分槽存；F16 Lua `[[…]]`/`[=[…]=]` 长字符串；F18 YAML merge；F21 `limit` 夹取；F22 参数描述写准；F23 多语句 SQL 直接拒绝。

**session**：B-M9 对齐算法升级为**三层**（内容优先 → 有界前瞻 → 位置），六个经典用例全部精确（删 1 条 0/1/0、插入 1/0/0、改 0/0/1、相同 0/0/0、重复游程 0/1/0）；B-L15 校验 zstd 帧头保留位，不再把载荷里的假魔数当坏帧。

**entry/打包**：A-6 删掉未使用的 `zod` 与 5 个内置语言包依赖（css/html/javascript/tsx/typescript 由 napi 内置、从不 import），描述里的"自测 11 份"改为 15；A-7 `apply()` 点名未知配置键（警告 + 信标），`node:sqlite` 错误信息改为"需要 Node ≥23.4（或 22.5+ 加 `--experimental-sqlite`）"。
**tablediff：SQLite 路径（F6/F7/F8/F9）+ 映射展开上限（F17）**
- **F8（最重）**：`diffSqliteLarge` 以前是**死代码**（`table_diff` 永不触发），文档却承诺"超大结果走 SQL join"；而且它的阈值检查会先把**整表读进 JS**（200 万行 ≈ 1.7 GB），等于白省。现在：接线（普通 SQLite 库 + 无投影/映射/过滤时自动接管）、阈值检查改 `count(*)` 轻量探测。
  ⚠️ 接线时踩到大坑：原先的裸 `FULL OUTER JOIN` 因**键列无索引**退化成嵌套扫描 —— 20 万 × 20 万 **跑了 9 分钟没结束**；而 `node:sqlite` 是**同步**调用，JS 定时器插不进去 ⇒ **宿主会被冻住**（我的探针就是这么卡住的）。改为**物化进带索引的临时表 + 索引连接**（`pragma temp_store=FILE` 防内存爆）：实测 **319 ms / RSS +1 MB**（哈希连接路径 649 ms / +300 MB），`via` 改为 `sqlite-indexed-join`。
- **F6**：指定 `#table` 或给了 `query` 时，**只探测那一张表**（以前无论指定与否都对库内每张表跑 `count(*)` + `pragma table_info`）。
- **F7**：`query` 与 `#table` 同给时明确说"`#table` 被忽略（实际执行：…）"，`source` 改成 `#query(...)`（以前 source 仍写 `#table`，用户以为跑的是表）。
- **F9**：`path#table(keyCol,valueCol)` 的括号部分不再被静默吃掉，作为默认键/值列（args 显式给了仍优先）；SQL 路径也认这套写法。
- **F17**：`mapMode:all` 展开上限 20 万键，超出部分**点名丢弃**并说明结果不完整（以前无上限）。
**session M14：diff 改流式摘要（内存 1.1 GB → 350 MB）**
- `session_diff` 以前 `readEvents` 两侧全量常驻（事件对象 + 全文 + 拼接字符串）⇒ 一对大会话实测峰值 **1.1 GB**。
- 现在**逐帧解码 → 摘要（200 字符展示文本 + 全文哈希）→ 丢弃**；短文本（≤200）不存哈希、比较时现算（省掉 34 万次 sha1）。
- 实测最大会话自比：**350 MB / 8.4 s**（两遍 148k 帧解压是硬成本）。
- **正确性护栏**（新增 5 条断言）：尾读取到的就是全量解码的最后 N 行；流式扫描事件数与全量一致且序号连续 `1..N`；`diffDigests` 与旧 `diffEvents` 自比结论一致。
- 顺带：改流式后**比较更准** —— 以前两条文本只有第 200 字符之后不同时会被判"相同"（假阴性）。
**A-3 后续（真宿主探针验证，2026-10-10 13:23）**
- **X-1 修复**：`search.apply` 返回实际注册的工具名，入口信标写真实名单（`search.apply ok (dump_syntax_tree, test_match_code_rule, ast_grep_help, ast_grep_search)`）。
- **H-1 修复（功能性 bug）**：`ast_grep_search` 的 `output.schema` 以前只声明 `type/additionalProperties`、不列 properties ⇒ 宿主**校验返回值**时把结果全判"未声明属性"，工具拿不到结果。现在声明真实形状；真宿主实测 7 处匹配返回 `count=7` ✓
- **H-2 修复（会话起不来）**：上一版"安全兜底"注册未包装对象（字段映射形状 parameters）⇒ 模型 API 报 `type: null`、**新宿主开不了会话**。兜底改为 `toJsonSchema()` 归一化；对"已是 JSON Schema 缺 additionalProperties"的 object 默认 `true`（宽容），合成路径仍 `false`。
- **宿主 DSL 三条硬事实**（已记进 WORKSPACE_MEMORY）：不支持联合类型；object schema 必须显式 `additionalProperties`；`output.schema` 会校验返回值。
**A-3 回调修复（真宿主回归）**
- 统一注册契约的第一版**没过滤键**：宿主 DSL 拒收 `parameters.max_nodes.minimum` ⇒ `search.apply` 抛错、**AST 检索族（4 个工具）在真宿主里整段消失**（信标 `search.apply FAILED` 抓到；本地用兜底 defineTool 验证时不会触发，所以漏了）。
- 修法两层：① `toFieldMap()` **白名单过滤**（只留 `type/description/required/items/enum/default`，被丢的数值范围以 `（1..5000）` 形式并进 description ⇒ 模型仍看得到边界，越界校验仍在工具体里）；② 新增 **`makeSafeDefineTool()`**：入口把所有段都换成"永不抛错"的 defineTool，某个工具被 DSL 拒收时只退回无 schema 校验注册并写一行信标，**不再让整段消失**。
- 教训记进 `WORKSPACE_MEMORY.md`：**插件改动必须在真宿主里看信标验收**（本地兜底路径不校验 schema，抓不到这类错误）。
**session 内存（M13）+ tablediff 语义（F5/F10/F11/F15）+ 入口契约（A-3/A-4）**
- **`session_peek` 大文件尾读 / `session_grep` 逐帧流式**：39.7 MB（148,847 帧）会话实测 peek **3160 ms → 41 ms**、RSS **508 MB → 86 MB**；grep 全量扫描 RSS 160 MB（不再拼巨型字符串 + 留住全部事件）。
- **tablediff 类型敏感比较**：投影阶段不再 `String()` 化 ⇒ `1` vs `"1"`、`true` vs `"true"`、`null` vs `""` 从"漏报"变成报出（实测 `changed=3`）。
- **`+` 组合键转义**：值里含 `+` 时不再撞键（实测 A=`x+y,z` vs B=`x,y+z` 从 "no differences" 变成 `added=1 removed=1`）。
- **适配器坏行外显**（F5）与 **records 模式不再误打印 `[ci]/[trim]`**（F15）。
- **统一注册契约**（A-3）：新增 `toFieldMap()`，`search.js` 的 4 个工具也经 `defineTool` ⇒ 入参校验与其余 16 个工具一致。
- **信标加固**（A-4）：超过 2 MB 自动裁剪只留 200 行（它跑在 fs 写意图热路径上）；各段 ok 行改写**真实工具名**；失败行带 stack。
**ast_edit（审计 D-7/D-9/D-10/D-11/D-13/D-19 —— 管理员模式下补齐了符号链接验证）**
- **符号链接**：改写会把链接 rename 成普通文件（链接断开、真实目标没变，"改了却没生效"）⇒ 现在**解到真实路径**再读写，链接保留、目标真的被改；硬链接给出 ⚠ 提示（rename 会断开）。
- **语言注册**：审计建议的"逐个 register"**实测行不通** —— registerDynamicLanguage 只有**第一次调用生效**（先注册 json 再注册 python ⇒ python 仍不可用）。改为**逐个 \import()\ 验证 + 一次性批量注册**；search.js 顺带删掉 26 个静态 lang import、复用 \lang.js\。48 个扩展名实测全部可 parse。
- **资源上限**（D-7）：单文件 >2 MB 跳过并提示；总命中 20 000 处封顶且外显（以前 5 MB / 40 万处命中要 5 s、堆 +68 MB 且零提示）。
- **逐 op 命中数**（D-9）：0 命中的规则会被点名（打错 pattern 与"本来没命中"不再同形）。
- **0 改动不入栈**（D-10）：不再顶掉真正要用的提案；消息一定带 stagedId。
- **preview 消息带文件数**（D-11）：\(N file(s), M replacement(s); searched S entries)\ —— "apply 前先核对目标文件数"这条纪律要的那个数，终于在可读文本里。
- **\langForFile\ 原型链守卫**（D-13）：\a.constructor\ 不再被当成语言。

**管理员模式补齐的验证**：checkpoint 的 `walkWorkspace` **不穿越**符号链接/junction（`pruneExtra` 无法逃出工作区，实测外部文件安然无恙）；只读文件被写盘预检拦下（一个都没写）。

**checkpoint（数据安全）**
- **索引重复记录 ⇒ `prune keep:N` 只留一半目录（真删数据）**：根因是我这轮加的"孤儿收养"与 create 的 push 撞车；改为按 id 去重 + create 侧 upsert。实测 8 快照 → 索引 8 条、`keep:4` 后磁盘正好 4 个目录（旧版只剩 2）。
- **`pruneExtra` 删掉"被 `.dsh-checkpoint-ignore` 排除、从未进快照"的文件**（参考资料被删）：restore 侧按同一语义过滤 + `ignoredFromPrune` 外显。
- **restore 部分落盘无回滚**：写盘前逐文件预检（目录占位/只读/不可建 tmp）⇒ 全部通过才写；逐文件 tmp+rename 原子替换；中途失败报 `partial` + 已写清单。
- **restore 静默覆盖快照之后的改动**：`changedSinceSnapshot` + `modifiedSince`，工具输出 `⚠ … 回滚会覆盖这些改动`。
- 未存原文的大文件不再被 diff 误报成 `(binary or unreadable)`。
- `prune drop:[...]` 的前缀歧义改为**报错列候选**（以前 `drop:["ck-2"]` 会一次删掉 4 个）；`keep` 非有限数不再静默清空。
- 快照 id 熵 24 → **48 bit**，且目录已存在时换 id 重试（旧版同毫秒碰撞会覆盖目录并留两条同 id）。
- `/rewind confirm` **必须点名 id**（以前不带 id 会静默按最新快照真写盘）；`/checkpoint <非法子命令>` 报错（以前会静默建快照）。
- `journalRestore` 增加**工作区边界校验**（以前可把工作区外的文件按留底覆盖），跨出需显式 `allowOutside: true`。

**ast_edit（审批被绕过 / 静默毁代码）**
- **apply 改为内容哈希 CAS**：preview 记录每文件 sha256，apply 先全量比对（不一致就拒绝并列出文件），写盘前逐文件再校验一次 ⇒ 修掉"数量不变但内容被外部改过仍照样写"（审批绕过）与 read-modify-write 覆盖窗口。
- **模板渲染只在"元变量确实属于 pattern"时插值**：`$$` 按上游 CLI 保留、`\$` 转义、其余 `$` 字面量、**未绑定元变量直接报错**（以前 `out: 'echo "$HOME and $1"'` 会静默写成 `echo " and 1"`）。
- **BOM 保留**（NAPI `commitEdits` 会剥掉它，现在按预览时记的状态补回）。
- **保留用户给的 op 顺序**（以前按 pat 字典序排序，串式改写结果与预期不同）。
- 写盘预检 + 唯一临时名 + 失败即停并精确报告（不再"写一半 + 提案报废"）。

**只读 AST 工具 / glob / 文档**
- `test_match_code_rule` 的 **0 命中不再是错误**（返回空数组 + renderer 给建议）；`$$$ARGS` **只捕获 1 个节点时不再消失**；`dump_syntax_tree` 的截断提示按真实原因报。
- `glob.js`：**`maxFiles` 只统计匹配的文件**（回归：200 个 `.js` + `maxFiles=200` 时 `*.ts` 一个都收不到）；`.gitignore` 改为**逐目录作用域**。
- `help/index.js` 的文档缓存**按"纳秒 mtime + size"失效**（改文档即时生效，首次读失败也能恢复）。
- 文案漂移：`## ast` 里"二进制探测"一句删掉；新增 `test/docs-claims-selftest.mjs`（61 条断言）把"文档声称 ↔ 实际行为"钉住。

**新增自测 4 份（11 → 15）**：`ast-search-selftest`（4 个只读 AST 工具**首次有覆盖**）、`glob-selftest`、`docs-claims-selftest`、`help-topics-selftest`；`checkpoint-guards-selftest` 增"索引自愈 + 审计 E 五类回归"共 21 条。

**工具链加固**：本机运维目录下的 `install-toolkit.ps1` 增加**语法闸门**（源码任一 `lib/*.js` 解析失败就拒绝同步；复制后再校验副本）—— 起因是这轮我把一个语法错误的 `edit.js` 同步进了两个安装副本（已修复），闸门就是防止这类事故。

### 审计第三轮：只读 AST 工具、glob 收集、checkpoint 索引自愈

审计对象是"改过一部分、但没被逐行看过"的剩余代码。**6 个真问题**（多在上游/早期代码里，且此前没有测试覆盖）：

- **`test_match_code_rule` 把 0 命中当错误抛出**（上游行为）：表现为"工具执行失败"，调用方无法区分"规则写坏了"与"规则对这段代码就是不匹配" —— 而后者正是这个工具的用途。现在**返回空数组**，由 renderer 给出可操作建议（含"用了 `inside`/`has` 就加 `stopBy: end`"）。
- **`$$$ARGS` 只捕获 1 个节点时，该元变量在输出里完全消失**（上游用 `getMultipleMatches().length > 1` 过滤）：实测 API 语义是"单节点元变量返回 0；多节点捕获 1 个时返回 1"，所以 `> 1` 恰好把"只捕获一个"的情况整段漏掉。改为 `> 0`。
- **`dump_syntax_tree` 的截断提示一律写成 `at depth N`**：用 `max_nodes` 触发时会误导。现在按实际原因分别报 `max_nodes=…` / `max_depth=…`。
- **`lib/glob.js`：`maxFiles` 上限在按模式过滤之前生效**（回归：旧实现用 fast-glob 先过滤再计数）—— 目录里 200 个 `.js` + `maxFiles=200` 时，glob `*.ts` **一个都收不到**。现在 walker 直接带模式谓词，**只有最终会被处理的文件才计入上限**。
- **`lib/glob.js`：`.gitignore` 改为逐目录作用域**：此前是"从入口向上收一遍、模式统一相对工作目录"的近似，**子目录里的 `.gitignore` 完全没读**。现在每个 `.gitignore` 相对**它所在目录**匹配（更接近 git 真实语义），祖先链仍生效，后匹配者胜。
- **`checkpoint` 索引自愈**：`index.json` 丢失/损坏时旧实现直接返回空 ⇒ `checkpoint_list` 显示"0 个快照"，而快照目录都还在，用户会以为数据没了。现在**从磁盘重建**（损坏文件改名保留为 `index.json.bad-<时间戳>`），并**收养**"目录在、索引里没有"的孤儿快照。

**新增自测 2 份（12 → 14）**：
- `test/ast-search-selftest.mjs` —— 4 个只读 AST 工具**首次有测试覆盖**；锁住上面 3 个修复 + dump 格式/上限/参数校验 + `ast_grep_help` 的 `full` 只返回 ast-rules 整节。
- `test/glob-selftest.mjs` —— glob 与 gitignore 子集边界（零依赖、不需要宿主）：`**`/`*`/`?`/`{a,b}`/`[...]`、锚定与取反、目录型规则、多作用域叠加、隐藏文件、`node_modules`、绝对路径 glob、路径不存在、重复输入、两个上限场景。
- `test/checkpoint-guards-selftest.mjs` 增加"索引自愈"一节（删索引 / 写坏索引 / 孤儿目录 / 重复读取稳定）。

### 文档合并（按需帮助只剩一份）

- 把上游的 `docs/ast-grep.mdc`（ast-grep 规则指南，MIT）**并入 `docs/TOOLKIT.md` 的 `## ast-rules` 一节**，独立文件删除 —— 按需素材统一在一份文件里管理。
- 该节已**全文译为中文**（代码块、属性名、YAML 示例保持英文原样）；署名、commit 与许可全文链接在该节开头的引用块里，并明确标注"这是译文、语义以上游原文为准"。
- 标题表抽到零依赖模块 **`lib/ast/help-topics.js`**（标题随译文汉化），新增 `test/help-topics-selftest.mjs`：逐个核对"主题表里的标题真的在文档里 / 上游内容确实并进来了 / 已译为中文（无英文原版标题残留）/ 无 frontmatter 残留 / 旧 `.mdc` 已不存在" —— 早先"文档与主题表漂移"踩坑后的护栏。
- `toolkit_help` 新增 `ast-rules` 主题（整份规则指南）；`ast_grep_help` 的 `full` 现在返回**规则指南整节**（并入前返回整份文档）。自测 11 → **12 份**。

### ast_edit 改为进程内自研实现
- **`lib/edit/*`（并入上游 `dsh-ast-edit-tool@0.1.6`，MIT）整体删除**，改为 `lib/ast/edit.js` + `lib/ast/lang.js`（自研）：
  `parse(lang,text)` → `findAll(pattern)` → 自研模板渲染 → `node.replace()` → `commitEdits()` → 原子写回，**不再外调 `ast-grep` 二进制**。
- **去掉 3 个依赖**：`@ast-grep/cli`（外部可执行文件）、`fast-glob`、`ignore` ⇒ 文件收集改为自研 `lib/glob.js`（自带 gitignore 子集匹配）。
- 行为对齐（`ast-edit-selftest.mjs` 40+ 条断言锁住）：`paths` 必填、preview 不动文件、preview→apply、**apply 前过期校验**、reject、
  `stagedId` 可省略（回退本会话最近提案）、一次性 stagedId、落盘**原子写**且不留临时文件、`maxFiles` 上限（默认 200，`DSH_AST_MAX_FILES` 可覆盖）。
- 修复/改进：`changes` 的行列号改为**正确的 1-based**（旧实现经 CLI 往返后偏 1）；模板渲染自查实现（实测确认 `replace()` **不插值元变量**）：
  `$NAME`/`$NAME`/`$$NAME`（按原文首尾切片还原分隔符）、`$_` 匿名不插值、空 `out` 删节点、与原文相同的替换不计入；
  未知扩展名与含 NUL 的二进制文件**跳过并提示**；嵌套模式导致的**重叠替换明确报错**。
- 行为变化（须知）：NAPI 对**无效模式不抛错**（旧 CLI 会），建议先用 `test_match_code_rule` 验证模式；
  上游 `Config`（`enabled`/`binaryPath`）随实现移除，只保留 `maxFiles`（插件 options.astEdit.maxFiles 或 `DSH_AST_MAX_FILES`）。
- `lib/deps.js`：`defineTool` 的机会性引入从 `lib/edit/deps.js` 搬到包根（内容不变）。
- 自测 10 → **11 份**（新增 `ast-edit-selftest.mjs`）。

### checkpoint diff 引擎改为自研

- **`lib/checkpoint/diff.js`：自研行级 diff**，取代此前 vendor 自 `dsh-checkpoint-rewind@0.6.24`（Apache-2.0）的 `lib/checkpoint/vendor/diff.mjs`；
  `vendor/` 目录（含该文件的 LICENSE 与 UPSTREAM.md）已整体移除。输出契约保持不变（`@@ -x +y @@` 不带行数、上下文 3 行、无差异返回空串、标签空串→`/dev/null`）。
- 顺带修掉原实现的一个弱点：它按"配置快照只有几十行"设计，用满 O(n·m) DP 表，而 `checkpoint_diff` 对大源码文件也走这里；
  新实现**先掐公共前后缀**再对剩余窗口做有界 DP（窗口过大退化为整段替换）——3000 行 vs 3000 行完全不同只需 2 ms 且不爆内存。
- `checkpoint_diff` 的单文件输出上限改由 diff 内部处理，超限会附一行"另有 N 行未展示"（不再是静默截断）。
- 自测 9 → **10 份**：新增 `diff-engine-selftest.mjs`（契约、前后缀、分块、退化、截断、稳定序列化，含 200 组随机"脚本可回放"性质检查）。

## 0.2.0 — 2026-10-10

**改名扩编**：`dsh-astkit` → `dsh-toolkit`（AST + 会话日志 + checkpoint + 表 diff 四族，共 **19 个工具**）；
上游 `dsh-checkpoint-rewind` 的能力并入（Apache-2.0，仅 vendor `lib/checkpoint/vendor/diff.mjs` + `UPSTREAM.md`）。

**新增**
- 表 diff 一族：`table_diff` / `table_peek` —— 自动识别 Lua / JSON / JSONL / CSV / TSV / PO / properties / YAML / SQLite
  （`node:sqlite`，支持 `path#table` 与自定义 SQL）；`a`/`b`/`mapA`/`mapB` 支持 glob 合并；`keyField`/`valueField` 支持点路径与 `+` 组合。
  一律**哈希连接 O(N+M)**（起因：旧 Python 嵌套遍历语术表 = O(N·M) 3,700 万次比较，靠 SQLite 才解决）。
- 会话日志一族：`session_list` / `_peek` / `_grep` / `_diff` / `_export` —— 多帧 zstd 逐帧解码；`session_diff` 由 LCS 改为**哈希对齐**（169,870×63,206 事件曾需 41 GB，现 213 ms / +104 MB）。

**行为语义（可能影响既有用法）**
- `only=` 只影响"展示哪一段"，三个计数**永远是真实总数**（旧版只展示时计数会变 0，像"没有差异"）。
- records 模式改用 `canonicalValue` 做**结构化比较**（函数/数组/嵌套表不再因引用不同而全部 changed）。
- 0 数据（0 文件 / 0 记录）时**置顶 `⚠⚠` 告警**并**替换结论行**为"无法比较：…（不是"没有差异"）"。
- 路径解析基准 = **调用方会话工作区**（`exec.agent.session.header.cwd`）；跨树 glob/目录不再抛错（跳过 gitignore 检查）。
- `checkpoint_create` 的 `exclude` / `.dsh-checkpoint-ignore`、`maxCopyBytes`（默认 1 MB，超出只记哈希）、`maxCopyTotal`（默认 50 MB）、`maxFiles`（默认 5000）；
  降级与截断**必须告警并计数**；`checkpoint_prune {drop:[…]}` 定点删。
- `checkpoint_restore` 默认只预览；`pruneExtra` **跨工作区直接拒绝**；歧义 id 前缀**报错列候选**；跨工作区 diff/restore 加告警。
- `ast_edit` 落盘改为**原子写**（临时文件 + rename）；`exec.signal` 可选；`DSH_AST_GREP_BINARY` 现在真的生效。

**健壮性**
- BOM 剥离、非 UTF-8（GBK）告警、>300 MB 文本拒绝、目录当来源给 glob 提示、SQLite 表清单取前 25 张。
- `index.json` / journal 索引**原子写**；journal 读侧**跨 bucket**（留底按 `DSH_SESSION_ID` 分桶）。
- `ast_grep_help` 的文档**懒加载**（缺失不再拖垮整个插件导入）。

**自测**：`test/*-selftest.mjs` **8 份**（checkpoint ×3、host-surface、diff、tablediff、session-tools；`session-selftest` 为演示脚本）。

### 0.2.0 追加（同日，按需帮助）
- 新增第 **20** 个工具 **`toolkit_help`**（`lib/help/index.js` + `docs/TOOLKIT.md`）：按主题返回使用说明与踩坑清单
  （`overview` / `table-diff` / `checkpoint` / `session` / `ast` / `gotchas` / `full`）。**文档懒加载**，缺失只降级成速记，不会拖垮插件导入。
- 动机：工具 schema 会进**每个**会话的常驻上下文；"怎么选 / 怎么解读输出 / 有哪些坑"只对正在用的人有价值 ⇒ 移出常驻、按需取。
- 顺带瘦身 schema：`table_diff` 2531 → 2362 字符，`checkpoint_create` 899 → 785，`table_peek` 552 → 494；
  同时把两条**解读输出必需**的契约写进描述（0 结果不是"没有差异"、`maxCopyBytes` 降级文件**无法回滚**、`pruneExtra` 跨工作区会被拒、`last` 默认按调用方工作区）。
- 修：`lib/help/index.js` 的文档路径曾少一层（`../docs` 应为 `../../docs`）⇒ 一直走降级分支；由 `toolkit-help-selftest` 抓到。
- 自测 8 → **9 份**。

- 修：`toolkit_help` 起初用了**原始 JSON Schema** 方言注册参数 ⇒ 宿主拒绝（`unsupported JSON schema: parameters.type must be a value schema object`），
  该段整段注册失败（其余 19 个工具不受影响，因为每段独立 try/catch）。改为 `defineTool` 要的**字段映射**方言。
  教训：`lib/edit/deps.js` 的 `defineTool` 是从 app 包**机会性**引入的（带校验），自测里传恒等包装会绕过校验 ⇒ 已加"方言形状"断言，并以真宿主信标 `help.apply ok` 作为集成验收。
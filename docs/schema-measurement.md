# Schema 常驻体积的度量与预算

**为什么要这份文档**：工具 schema 是**每个会话、每一轮**都要付的常驻成本。凭感觉说"瘦"没用，
所以这里像 `table_diff` 的覆盖率一样，**把数字 checked-in**，让"悄悄膨胀"变成一次显式的 diff。

做法借鉴 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops) 的 `docs/schema-measurement.md`
+ `scripts/measure-schemas.mjs`（它的基线 18,889 B → 8,988 B，压缩 52%）。

## 度量口径

- **指标**：`{name, description, parameters}` 紧凑 JSON 的 **UTF-8 字节数**（就是宿主实际广告的那份载荷）。
- **常驻总量 = 工具 schema + 注入的 prompt 路由段**（由 `lib/routing.js` 生成）：
  | 组成 | 字节 | 说明 |
  |---|---:|---|
  | 工具 schema（15 件） | **36,020 B** | 家族小计见 `docs/schema-baseline.json` 的 `families` |
  | prompt 路由段（`routingSection`） | **649 B**（6 行） | 只广告**实际挂载**的工具；一个都没挂载 ⇒ 整段消失 |
  | **常驻合计** | **36,669 B ≈9,000 tok** | 报告里的 `resident` 字段 |
  **基线重冻说明**（每一次重冻都按"确实决定接受这次变化"来做，原因写在这里；此后继续按 总 +5% / 单件 +10% 的闸门压）：
  - **新增 `bash`（内核 0.2.2 移除 `ops_bash` 后的自建替代）**：工具 schema 28,732 → **29,783 B（+3.66%）**，
    新增 `shell` 族 **1,043 B**（261 tok）；其余单件零变化（`help` 的 1,098 → 1,106 是上一次测量后的口径微差，随本次一并对齐）。
    这是一次**有意为之的能力新增**：用 1 KB 常驻换掉 dsh-ops 的 392 MB 依赖；而且族默认关闭 ⇒ 不用 bash 的会话一分不付。
  - **新增 `file`（同一迁移的第二步，8 个动作合成一个工具）**：工具 schema 29,783 → **32,987 B（+10.8%）**，
    新增 `file` 族 **3,182 B**（796 tok）。这是**单件最大的一次新增**，但换来：编码探测（GB18030）、多文件/多区间、
    二进制 hex、revision CAS + 原子写、copy/move/remove/mkdir —— 若照 ops 拆成 8 个工具，实测同等参数面会更贵；
    族默认关闭 ⇒ 不开的会话一分不付。
  - **`file` 读取协议升级（同日，照 ops 的续读协议）**：`file` 3,182 → **3,341 B（+5%）**，全量 32,987 → **33,146 B（+0.5%）**。
    新增的是"读完回 revision / complete / nextOffset / truncatedInLine"的说明；参数面没变，所以增幅很小。
  - **`file` 新增 `replace` 动作（同日）**：`file` 3,341 → **3,788 B（+13.4%）**，全量 33,146 → **33,593 B（+1.3%）**；
    参数面 +3（`pattern` / `replacement` / `dryRun`），换掉的是"批量字面替换必须自己写脚本"。
  - **严格 provider 契约修**：`required` 递归归一，`ast` 8,531 -> **8,528 B**、`file` 4,479 -> **4,475 B**，全量 **35,350 B**（纯收敛，没有新增能力）。
  - **对齐 dsh-ops 0.5.x**：Niubash 后端探测、DSH_* 环境注入、`INVALID_BASH_ARGUMENT` —— 都是行为改动，schema 不变（**35,350 B**），按需文档 68,138 -> **68,476 B**。
  - **审计修复**：只改行为与文案，schema 不变（**35,350 B**）；按需文档 67,708 -> **68,138 B**。
  - **`file` 新增 diff（同日）**：`file` 3,969 -> **4,479 B（+510）**，全量 34,847 -> **35,357 B（+1.5%）**；
    换来的能力是宿主没有的"改前预览"（单 hunk + 分页 + 双哈希）。
  - **`shell` 信号解码（同日）**：只改渲染与结果字段（schema 不变），按需文档 66,187 -> **66,487 B**。
  - **`shell` 后台参数对齐（同日）**：新增 `run_in_background`（与宿主同名）+ `background` 别名，`shell` 1,974 -> **2,116 B**，全量 34,705 -> **34,847 B（+0.4%）**。
  - **`shell` terminal 卡片契约（同日）**：`description` 必填 + 末尾 `[exit code]` 标记，`shell` 1,928 -> **1,974 B**，全量 34,659 -> **34,705 B（+0.13%）**。
  - **`shell` 审批 + 生命周期（同日）**：新增 `sandbox_permissions`/`justification` 两个参数，`shell` 1,604 -> **1,928 B（+324）**，全量 34,335 -> **34,659 B（+0.9%）**；
    换来的是受限模式下的逐次升级（宿主审批）与会话销毁时的任务收尾。
  - **`shell` 压缩 + spill 上限 + 失败契约（同日）**：`shell` 2,580 -> **1,604 B（-38%）**，全量 35,311 -> **34,335 B（-976 B）**；
    描述与参数说明瘦身（细节搬进本文件），同时补了 64 MB spill 封顶与 `failure` 结构化字段 —— **更小也更有用**。
  - **`shell` 中途晋升（同日）**：`shell` 2,447 -> **2,580 B**，全量 35,178 -> **35,311 B（+0.4%）**；
    描述里多一句"超时转后台而不是杀掉"，换来的是长任务不用取消重跑。
  - **`shell` 平台收口（同日）**：`shell` 2,343 -> **2,447 B**，全量 35,074 -> **35,178 B（+0.3%）**；
    只多一句"只在 Windows 注册、POSIX 让位给宿主 bash"，换来的是**不在 Linux 上遮蔽宿主工具**。
  - **`shell` 加沙箱闸门（同日）**：`shell` 2,139 -> **2,343 B**，全量 34,870 -> **35,074 B（+0.6%）**；
    只是在 bash 描述里补了"受限模式必须过 confinement、拿不到就拒绝执行"这句（参数面没变）—— 这是**安全语义**，值得花。
  - **`shell` 加后台任务（同日）**：`shell` 1,986 → **2,139 B**，全量 34,717 → **34,870 B（+0.4%）**；
    只多一个 `background` 参数；真正的工作量在 `runBash` 的 `signal`/`onChunk` 与宿主 jobs 对接，schema 上看不出来。
  - **`shell` 参数面对齐 ops_bash（同日）**：`shell` 1,157 → **1,986 B**，全量 33,888 → **34,717 B（+2.4%）**；
    多的是 `script_path`/`workdir`/`description`/`graceMs`/`includeDiagnostics` 五个参数与 spill 说明 —— 这是**补能力**，不是描述膨胀。
  - **`shell` 补 `host-shell hiding`（同日）**：`shell` 1,043 → **1,157 B**，全量 33,774 → **33,888 B（+0.3%）**；
    多出来的只是 bash 描述里"Windows 原生操作走 powershell.exe"那句 —— **真正省的是宿主两个工具**（`pwsh`/`pwsh_persistent`，隐藏后不在本表口径内）。
  - **`read` 支持 `.xlsx` / `.pptx`（同日）**：`file` 3,788 → **3,969 B（+4.8%）**，全量 33,593 → **33,774 B（+0.5%）**；
    只是描述里加了一句"能读 OOXML 文本"（参数面没变），避免模型以为只能读纯文本。
  - 接受 `+37 B`（`checkpoint.allowOutside` 的说明改写成"还要运维开关"）与 `+691 B`（新增 prompt 路由段）；
  - 发布前"去本机化"改写了若干 `description`（换中性示例字段名、`presetExclude` 去掉作者目录名、`proxy` 说明条件化）
    ⇒ 工具 schema 27,113 → **27,414 B（+1.1%）**，`download` 单件 +7.5%（仍在 +10% 内）；
  - `docs/TOOLKIT.md` 新增 `## dsh-version-support` 一节 ⇒ **工具 schema 一分未变（仍是 27,414 B）**，
    只是按需体积 44,168 → **46,609 B**（`onDemand` 不是预算字段，随文档重算即可）；
  - **瘦身一次（本文件当前这一版）**：`download` 的工具级描述与 `proxy` 说明去掉重复枚举（细节本就在 `docs/DOWNLOAD.md`）、
    `table_diff` 若干参数说明去掉示例与冗余措辞、`ast_search` 压紧说明 —— 同时**新增**了 `ast_edit.previewDetail`（预览折叠）、
    `ast_search.include_vendored` 与 `ast_search.offset`（分页）三个参数。
    结果是**净减**：工具 schema 27,414 → **26,898 B（−1.9%）**，其中 `download` **−13.2%**、`table_diff` −4.5%、
    `ast_search` −2.0%（**加了两个参数还比原来小**）、`ast_edit` +7.3%（预览折叠的开关，仍在 +10% 内）。
    真分词器口径 **6,583 → 6,429 tok/轮**。⇒ 基线**向下重冻**到 26,898 B，此后增长从新地板算起。
  - 新增 `ast_edit` 的 `action:"diff"`（整文件替换前预览）与 `ast_search.skippedCount`（跳过文件的总数）⇒
    工具 schema 26,898 → **27,201 B（+1.13%）**，`ast_edit` 4,640 → **4,767 B（+2.74%）**；真分词器 **6,429 → 6,515 tok/轮（+86）**。
    先写长的 action 说明时是 +96 tok、`ast_edit` +8.88%（贴着 +10%），**把说明压短后**才降到上面的数字 —— 这正是闸门该起的作用。
    ⇒ 基线重冻到 27,201 B（这是一次**有意为之**的能力新增，不是泄漏）。
  - **工具改名 + `diff` 挪到只读侧**（`ast_grep_search` → `ast_search`，`diff` 从 `ast_edit` 移到 `ast_search` 的 action）：
    `ast_search` 2,198 → **2,638 B**、`ast_edit` 4,767 → **4,485 B**，总量 27,201 → **27,354 B（+0.56%）**、
    真分词器 6,515 → **6,552 tok/轮（+37）**。净增只有 `action` 参数与 diff 的输出 schema（`ast_edit` 同时瘦了 282 B）⇒ 基线重冻到 27,354 B。
  - **会话族扩展（合并优先，0 新增工具）**：`session_read` 加 `scope` / `maxHitsPerSession`（跨会话检索），
    `session_list` 加 `where` / `fields` / `sort` / `offset`（谓词 + 重列 + 分页）。工具 schema 27,408 → **28,732 B（+4.83%）**，
    其中 `session_list` 1,073 → **2,277 B**、`session_read` 1,071 → **1,350 B**；同时瘦身 `session_diff`（811 → 721）与
    `session_export`（1,089 → 962）的描述。真分词器 **6,564 → 6,907 tok/轮（+343）**。
    **单件闸门因此有记录地重冻**：`session_list` 吸收了"体检/筛选"的整个入口 —— 若照提案另开 `session_doctor` + `session_search` 两个新工具，
    实测要 +1,456 B 且多两个动词（评估见维护者工作区的 session-tools-eval）。⇒ 基线重冻到 **28,732 B**。
- **口径边界（重要）**：本文件的"工具 schema"只算 `{name, description, parameters}` 三样 ——
  **`output.schema` 不计入**。所以给输出加字段（如 `ast_search.diff.tailOnly`）在预算里是**零成本**，
  但宿主实际下发的 payload 会略大（实测同一工具真实 payload ≈ 紧凑字节 ×1.04，差在 JSON 结构字段上）。
  这不是"漏算"，是**故意选的口径**：输出 schema 是"结果长什么样"的约定，不随会话重复支付——
  要抓膨胀就抓这三样，它们才是每轮都付的部分。- **近似 token**：`ceil(bytes / 4)` —— **只当参考**：中文 3 字节/字符，而一个中文字通常约 1 token
  ⇒ 对中文内容这个近似是**高估**。要引用"多少 token"，请说明用的是哪个口径：
  | 口径 | 15 工具 | 说明 |
  |---|---:|---|
  | 紧凑字节 | **36,020 B** | 本文件/`docs/schema-baseline.json` 的口径 |
  | `bytes / 4` | ≈8,838 tok | 对中文高估 |
  | 真 tokenizer | **6,921 tok**（上次会话族扩展时的实测；DeepSeek 官方 `tokenizer.json`，换分词器会不同） | 口径可替换：作者本机用维护者工作区的 `schema-cost.mjs`。**注意**：那个脚本原先硬列 6 个模块、**漏了 `download` 一族**（口径少一个工具、4,531 tok 是那时的数），现在改成从**插件入口的注册面**取。**趋势**：6,583 → 瘦身后 6,429 → 加 `text_mode` 6,475 → 加 `diff` 动作 6,515 → 改名并把 diff 挪到 `ast_search` **6,552** → 会话族扩展（scope/where/fields）**6,921** → 加 bash（本次未重测真分词器，按字节增量估 ≈+261 tok） |
- **按需成本另计**：`docs/TOOLKIT.md` **71,534 B**（基线口径；最近一次实测同值 —— 改一次文档就会变，`docs/schema-current.json` 的 `onDemand.bytes` 是最近一次实测）—— 只有某会话真的请教（`toolkit_help`）才付这份钱。
  **要写小抄、长例子、踩坑清单，请放这里，不要塞进 schema。**
- **组件/家族小计**：`ast` 8,483 B、`table` 6,252 B、`session` 5,368 B、`download` 3,762 B、`checkpoint` 3,721 B、
  `file` 4,729 B、`shell` 2,577 B、`help` 1,128 B（同 `docs/schema-baseline.json`）。最重单件现在是 `table_diff` 4,584 B（其后 `ast_edit` 4,485 B）。

## 怎么用

```console
# 打印报告（默认优先用安装副本的入口，源码树缺 yaml 时 AST 段会缺席）
node scripts/measure-schemas.mjs

# 显式指定入口（`<你的 profile>` 换成你自己的 profile 名）；写进 current（基线**不要**覆盖）
node scripts/measure-schemas.mjs --entry "<你的 profile 的绝对路径>/node_modules/dsh-toolkit/lib/index.js" --write docs/schema-current.json
```

- `docs/schema-baseline.json`：**冻结的基线**，只在"确实决定接受增长"时手工更新（重跑 `scripts/measure-schemas.mjs --write docs/schema-baseline.json`），
  并在提交信息/本文件的"基线重冻说明"里写清原因与增量。
- `docs/schema-current.json`：随时重算、**按 diff 审阅**的当前值（重冻后两者一致）。
- `test/toolkit-help-selftest.mjs` 第 5 节是**闸门**：
  1. 总字节 ≤ baseline × **1.05**；
  2. **单个工具**不许超过 baseline × **1.10**（防止某一件悄悄吃掉预算）；
  3. 每个工具都必须**归到某个家族**（`FAMILIES` 表里没有 ⇒ 落在 `other` ⇒ 失败）—— 新增工具必须显式记账。

## 维护约定

- 加参数/加说明 ⇒ 先问"这句必须常驻吗？"；能搬进 `docs/TOOLKIT.md` 的就搬（以前就这么做过：
  `table_diff` 的 4 个新参数只留一行，长说明进文档）。
- 确实要涨 ⇒ 重算 `docs/schema-current.json`，在提交里写清涨了多少、为什么值这个钱，然后才动 baseline。
- 每个工具的体积目标：**单件 ≤ 5 KB**（当前最大 `table_diff` 4,801 B，其后 `download` 4,335 B、`ast_edit` 4,324 B）—— 超过就该考虑拆动作或搬文档。

## 用途底线（purpose floor）：压到哪儿就该停

预算闸门管"**涨**"（总量 +5%、单件 +10%），但没人管"**削**"——而"一压再压"真正的风险不是省钱，
是**模型不知道这工具能用在哪，于是根本不调用**。所以另有一道门（`test\schema-purpose-selftest.mjs`，49 条断言，0.3 s）。

先把账摊开（DeepSeek 分词器；下表是按改动前 6,545 tok 的分布统计）：

| 类别 | token | 占比 | 处置 |
|---|---|---|---|
| 参数说明 + 枚举值 | 4,777 | 73% | **调用期契约**，压了就调错参数 |
| 描述里的用途/触发句 | ~1,045 | 16% | **这就是可发现性**，是底线 |
| 原理/实现说明 | 141 | 2% | 唯一可搬进 `toolkit_help` 的部分 |
| 示例/格式样例 | 0 | 0% | 早已搬走 |

**结论：可压余量只剩 2%**，再压必然先伤用途。所以规则是：

1. **用途句必须还在**：每个工具在 `PURPOSE` 表里登记几条正则（如 `table_diff` → `/glossar|locali|词表/`、`/hash join/`），描述必须全部命中；
2. **动词表必须完整**：`action` 枚举的每个值都要在描述里出现（`reject`、`journal_restore`、`probe` 这类动作一旦从文字里消失，模型就想不到）；
3. **每个参数都要有说明**（`integer` 的「（1..N）」合成说明算通过——那是范围，不是含义）；
4. **描述有冻结字节地板**（当前值 −10%），不许悄悄削一句；
5. **新工具必须登记**：注册面与 `PURPOSE` 键集合必须一致，加工具不写"它能用在哪"直接红。

改描述要**同步改 `PURPOSE`** —— 这道摩擦是有意的：它逼人回答"这句是不是模型选工具的依据"。

配套的**观测**（不是闸门）：`scripts\tool-usage.mjs` 扫本工作区最近 N 份会话，按"每千次供应商请求"算每个工具被调了几次，
与 `docs\tool-usage-baseline.json` 比，**归零或腰斩就告警**。压缩的代价要过一阵才看得出来，这一步就是把它变成可观测。

**为什么不改成"按需发现"**（dsh-ops 0.4.x 的做法）：实测本工作区最近 8 份会话的 10,382 次请求里，
"开了但一次没用"的族只占名义常驻的 **8%**，却要付"每次发现一轮往返 + 路由表变长 + 前缀缓存抖动"——
不划算。真要降常驻，杠杆是**工具数**，不是字数。

# 下载器（`lib/download/`）—— 设计与来源说明

> 起因（**作者本机实测样例**）：**宿主直连还行、但一走代理就卡**，而同一链接在别的下载器里很快 —— 直连与走代理**哪个更快取决于你的网络**，所以本工具先探测再决定。
> 目标：零依赖、多线程、可续传、能跟随系统代理与本地代理软件（若你使用的话；没装代理就走直连）的下载工具，集成进本插件。

## 1. 为什么自己实现（先看了现成的）

| 项目 | 许可证 | 结论 |
|---|---|---|
| [aria2](https://aria2.github.io/manual/en/html/aria2c.html) | **GPLv2** | 模型最成熟，但**不能抄代码**（本插件 MIT）⇒ 只借鉴**语义**：`-s/--split`（连接数）、`-k/--min-split-size`（小于 2×SIZE 不分片）、`-x/--max-connection-per-server`、piece + `--stream-piece-selector`、**`--lowest-speed-limit`（掉慢连接）**、`--checksum`、`--continue`、`--dry-run`、`--remote-time`、代理/Cookie/Referer/Header 全套 |
| [ab-download-manager](https://github.com/amir1376/ab-download-manager)（作者参考过的实现） | **Apache-2.0** | **可借鉴可移植**（保留署名/NOTICE）。引擎在 `downloader/core/.../ir/amirab/downloader/**`，文件名就说明了架构：`part/{Part,PartDownloader,PartSplitSupport}`（**分片与动态拆分**）、`db/{IDownloadPartListDb,PartListFileStorage,TransactionalFileSaver}`（**分片状态持久化**）、`utils/{SparseFile,SplitToRange}`（**稀疏预分配 + 分片数学**）、`connection/proxy/{ProxyStrategy,SystemProxySelectorProvider,AutoConfigurableProxyProvider}`（**系统代理/PAC**）、异常 `PartTooManyError / ServerPartIsNotTheSameAsWeExpect / FileChanged / NoSpaceInStorage`（**必须处理的失败模式**）。CHANGELOG 还给了**实战踩坑清单**（见 §4）。本仓库**未复制其代码**，只借鉴设计；若日后移植片段，会在 `THIRD-PARTY-NOTICES.md` 标注 Apache-2.0 归属。 |
| [bezzad/Downloader](https://github.com/bezzad/Downloader)（.NET） | MIT | 借鉴 `DownloadPackage` 保存 **chunk positions** 的思路（分片位置即断点） |
| [node-downloader-helper](https://www.npmjs.com/package/node-downloader-helper) | **MIT、零依赖、50 KB** | 最接近的 Node 库，**但只做单流**（resume 是"从头/继续"，没有多连接分片）⇒ 集成它解决不了"连接被限速"（有些代理会按连接限速），故只参考其 API/行为（override 策略、progress 事件、`resumeFromFile` 状态对象） |
| Gopeed | GPLv3 | 只借鉴（多分块引擎） |

## 2. 我们的模型（`engine.js`）

- **线程数自动**（用户要求"小文件少线程、大文件多线程、也可手动"）：`planThreads()` = **大小档**（**递进 1/2/4/8/16**：`<1 MB→1`、`<8 MB→2`、`<64 MB→4`、`<512 MB→8`、`≥512 MB→16`）× **实测增益**（探测的 `合计 ÷ 中位单连接`；`<1.8×` ⇒ 折半，因为瓶颈不在每连接限速）→ 再按"有用片数"封顶。**自动上限 16**（32 容易招服务器反感），手动可到 32。输出回显依据。
- **收尾加速 `tailBoost`**（默认开）：收尾阶段某块速率低于"本任务见过的最好速率"（基准优先取探测到的每连接中位速率）持续 2 次采样 ⇒ **断开重连**（等价于用户手动"暂停/继续"，新连接会重新分到带宽）；若此刻有空闲连接，同时把剩余范围劈一半交回队列。夹具场景本机实测 **13.9 s → 7.2 s**（耗时随机器而变；夹具在 `test/download-selftest.mjs`）。
  - 两个**仅自测用**的调参口（默认值就是生产行为，别在正常使用里设）：`DSH_DOWNLOAD_SLOW_CHECK_MS`（慢尾/慢片的采样间隔，默认 2000）
    与 `DSH_DOWNLOAD_STALE_STRIKES`（连续几次判"慢"才动手，默认 2）。自测把采样调到 300 ms —— 否则那一段要按真实节奏等二十多秒。
- **限连接数站点的自适应**：403/429/503 ⇒ **降并发 + 该块回队列（绝不判死整个下载）**，遵守 `Retry-After`，**按主机记住实测上限**（同主机下次直接从上限定步，夹具观测第二次零拒绝），并在"连续成功且 8 s 内无拒绝"时保守向上试探（每下载最多 3 次）以探出真正上限。
- **分块硬下限与覆盖性**：劈开要求两半都 ≥ `max(512 KB, minSplitSize)`；同一块最多劈 2 次、整包 ≤2048 块；碎块并入相邻块；**落盘前校验"每片都下完 + 覆盖 0..total-1 无空洞"**，否则报错并保留 `.part`（防"缺一块却改名成功"）。
- **chunk 队列 + 工作窃取**：按 `total/(threads*4)` 切块（夹在 `minSplitSize` 与 32 MB 之间），N 个 worker 谁空谁拿下一块 ⇒ 快的连接多干活（对应 aria2 的 piece + selector）；
- **`minSplitSize`**：尾巴小于它就并进前一块（不切碎）；
- **动态拆分（`PartSplitSupport` 精神）**：某块连续 3 次测速（每 2 s 一次）都低于 `lowestSpeedLimit`（默认 **8 KB/s**）⇒ 把它**剩余范围的中间劈开、后半段扔回队列**，另一个 worker 会去接管 ⇒ **卡住的连接不再拖住整包**（"某些链路上走代理就卡"的对策之一）；
- **断点续传**：数据写 `<to>.part`，进度（每块 `start/end/done`）写 `<to>.part.manifest.json`；续传前比对 `finalUrl/total/etag/last-modified`，**远端变了就重来**（避免两版本拼成坏文件）；片内断流从 `start+done` 续请求；
- **收尾原子改名**：长度校验 + **无条件自算 sha256**（给了期望值就比对，不符则删 `.part`）通过后才 `rename(.part → to)`；
- **回退**：不支持 Range ⇒ 明确回退**单流**，绝不假装多线程；
- **限速**：`speedLimit`（字节/秒，令牌桶简化版）；**重试**：每块 3 次 + 退避。

## 3. 网络层（`net.js`，零依赖）

- **跟随重定向**（默认 6 跳，实测 npm 镜像先 302 到 CDN）；
- **代理语义**（已定案）：`auto` **跟随系统代理设置**，不按域名自作聪明 —— 若你使用本地代理软件且它工作在 PAC/规则模式，由**代理**决定直连还是走代理（全局模式则全走代理）；要绕过就**显式** `proxy:'direct'`（直连与走代理哪个更快取决于你的网络，**确知该地址直连更快时**再用）；`NO_PROXY` 照常生效。
- **代理**：`auto`（默认）按四级链找，并**如实回显来源**（第 1/2 项是 Windows 行为；其他平台走第 3 项环境变量 + 第 4 项端口探测）：
  1. **注册表固定代理**（`ProxyEnable=1` + `ProxyServer`）；
  2. **PAC 里的代理字面量**（★ 作者本机实测样例：本地代理软件用 **PAC 模式** —— `AutoConfigURL=…/commands/pac` 而 `ProxyEnable=0`，只读固定代理会"检测不到"；现在拉取 PAC 文本、抠出其中的 `PROXY host:port` 字面量（本机样例是 `127.0.0.1:7890`，7890 为常见的 mixed 端口、不保证），**不执行 JS** —— 具体地址与端口随你的代理配置而定）；
  3. 环境变量 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`；
  4. **探测常见本地端口**（7890 是最常见的 mixed 端口（不保证你在用）/ 7891 / 10809 / 10808 / 1080 / 8889，TCP 连通即采用，来源标成 `probed port N`）。
  也可显式给出你在用的代理，如 `http://127.0.0.1:7890`（7890 是常见的 mixed 端口，不保证）、`socks5h://user:pass@127.0.0.1:7891`（**SOCKS5 远程解析域名 + RFC1929 认证**）；`ProxyOverride`/`NO_PROXY` 的 bypass 在 PAC 模式下同样生效；
- HTTP 代理对 https 目标走 **CONNECT 隧道**，对 http 目标走绝对形式请求；`NO_PROXY/ProxyOverride` 支持 bypass 规则；
- **代理连不上时明确报错**（`pingProxy` 先探测），**绝不静默走直连**（那会让人以为"代理没生效但下载成功"）；
- **不发 `Accept-Encoding: gzip`**（Range + gzip 会拿到错误字节；aria2 也默认关闭）。

## 4. 从 AB Download Manager 的 CHANGELOG 提炼的**实战坑**（逐条对待）

| 他们踩过的 | 我们的对策 |
|---|---|
| "some webservers does not respect requested range **at first place**" | 片请求拿到 200 而 `start≠0` ⇒ 先**重试一次 Range**，仍不行才判"不支持续传" |
| "**some websites close the connection if we ask for resume support**" | Range 请求连接被关 ⇒ 该块回退**无 Range 单流**重下（或整包单流）并提示 |
| "server changes status code from **206 to 200**" mid-download | 不整包重置：标记该资源"不再支持 Range"，改用单流续（保留已有 .part） |
| "some servers return **256 bytes instead of full size**" | 校验 `Content-Range` 的总大小；与 `Content-Length` 冲突或过小时**明确报错**，不静默下成小文件 |
| "**Sparse File Allocation**"（1.0.9） | 支持稀疏/预分配：完成前 `ftruncate(total)`（Windows 真稀疏需 FSCTL，Node 无 API ⇒ 至少预分配避免碎片） |
| "Use server **Last-Modified** time"（1.0.8） | 可选 `remoteTime`：收尾后按 `Last-Modified` 设 mtime |
| "Default thread count **8**"（1.4.3）、"default retry **3**"（1.6.x） | 我们的默认与之一致（threads 8 / 每块重试 3） |
| "**System Proxy** support + **PAC**"（1.5.2） | 系统代理 ✓（Windows 读注册表；其他平台读环境变量）；PAC ✓（只抠 `PROXY`/`SOCKS` 字面量，不执行 JS，见 §3） |
| "**DNS-over-HTTPS**"（1.10.2） | 暂不做（列为后续：DoH 可绕开被污染的 DNS 解析；具体效果取决于你的网络） |
| "max concurrent downloads 3"（1.9.0） | 后台三件套里给"同时下载数"参数 |

## 5. 当前状态

| 件 | 状态 |
|---|---|
| `lib/download/net.js`（重定向/Range/代理/CONNECT/SOCKS5/bypass/timings） | ✅ 完成，本地服务器联调通过 |
| `lib/download/engine.js`（探测 / chunk 队列 / 动态拆分 / 续传 / 校验 / 原子改名 / 限速） | ✅ 完成 |
| 引擎层本地夹具（仓库内 `test/download-selftest.mjs` 第 1–6 节，离线可跑） | ✅ 通过：探测、4 线程一致、反复断流续传、中止后 `.part`+manifest 续传、sha256 拒绝/通过、忽略 Range 回退单流、同名拒绝/overwrite、缺头 403、坏代理报错；期间抓到并修掉 2 个真 bug（`'a+'` 导致定位写失效 ⇒ 内容错乱；服务器断流被误判成用户中止） |
| 真机验证（对 CDN） | ✅ 探测 + 单流/8 段对比（**作者本机实测样例**：阿里 CDN 上单流 21.5 MB/s vs 8 段 18.0 MB/s，速率随网络而变 ⇒ **多线程只在"单连接被限速"时才有用**，所以先探测再决定） |
| **一个** `download` 工具（`action`: `start`/`probe`/`status`/`cancel`；已由三个工具收敛）+ 后台 worker（`worker.js`：detached + 状态文件 + 取消标志 + 中断可续） | ✅ 完成，端到端验收 **32 条断言全绿** |
| 自测进 `test/download-selftest.mjs`（本地 Range 夹具，**离线可跑**） | ✅ 完成（32 断言） |
| 工具数声明同步（21→24）/ TOOLKIT 新增 `## download` 段 / README 中英 / AGENTS / PLAN / package.json | ✅ 完成 |
| 真机验证（对 CDN） | ✅ 探测 + 单流/8 段对比；**真链接下载并按 sha256 校验通过**（**作者本机实测样例**：npmmirror → 302 → cdn.npmmirror.com，4,376,902 字节，工具自算 hash ≡ 独立计算；小文件上 1 线程 24 MB/s vs 8 线程 19 MB/s，速率随网络而变 ⇒ 探针会提示"文件 <16 MB 时多线程未必更快"） |
| **本地代理软件实测（PAC 模式）** | ✅ **作者本机实测样例**（速率随网络/时段而变）：`auto` 经 PAC 找到代理（本机是 `127.0.0.1:7890`，7890 为常见的 mixed 端口、不保证）；**经代理 8 连接合计 18.7 MB/s（单连接仅 2–2.6 MB/s ⇒ 该代理确实按连接限速，多线程有效）**，直连 8 连接 13.4 MB/s，经代理 2 连接 6.2 MB/s |

## 6. 计划中的工具面

```text
download { url, to?, threads=auto, resume=true, overwrite=false, proxy="auto",
           headers?, cookie?, referer?, sha256?, minSplitSize?, lowestSpeedLimit?,
           speedLimit?, background?, dryRun?/probe? }
  → 一次调用：前台跑完（小文件）或起后台任务（大文件）
download action:"status" { id? | to? }   → 进度/速度/已下载/剩余/分片健康度
download action:"cancel" { id | to }     → 中止（保留 .part + manifest，可续）
```

### 状态目录与任务索引

后台任务的状态与日志写在**工作区** `downloads\.dsh-downloads\`：`<id>.json`（结果记录）、`<id>.log`（日志）、
`jobs.json`（**任务索引**）。**目标文件所在目录一个文件都不放** —— 目标目录可能是模型目录、游戏 mod 目录这类
会被别的程序扫描的地方，多一个点目录会让它们出现意外行为（实测：下完在 `ComfyUI-Shared\models\*\` 里留下了 `.dsh-downloads`）。

- **要找记录/日志**：直接翻工作区 `downloads\.dsh-downloads\`；只有终态记录会按 **200 条**上限滚动清理（asset 与下载产物仍在 `downloads\`）。
- **候选目录**（`status`/`cancel` 的查找范围）= 工作区目录 + 索引里登记过的目录 + **旧版遗留目录**（工作区根与目标目录旁的 `.dsh-downloads`）。
  旧版残留会被**读取**（旧任务仍能被 status/cancel 管到）并**自动退休**：终态记录与日志就地清掉，目录空了连目录一起删。
  想清掉某个目标目录旁的旧残留，用带 `to` 的调用（`status`/`cancel`/新下载都会自动带），例如 `download {action:"status", to:"<那个目录>/<文件>"}`。
- **取消标志**写到任务所在的真实状态目录，所以 worker 一定读得到。

### 审计姿势三：恶意服务器 fuzz

不再"读代码想问题"，而是让一个**按种子随机耍赖**的服务器去逼引擎（`test/download-fuzz-selftest.mjs`）：
中途断流/复位、把 Range 请求当整包回（200）、乱报 `Content-Length` 与 `Content-Range`、并发时 429/503、故意变慢，
以及**故意返回"格式合法但内容错位"的字节**。核心不变量只有一条：**绝不能产出"成功但内容不对"的文件**。

三种模式与实测（24 种子/模式）：

| 模式 | 成功 | 干净失败 | 违例 |
|---|---|---|---|
| `clean`（服务器不篡改字节） | 9 | 15 | **0** |
| `sha`（篡改 + 给了 `sha256`） | 10 | 14（其中 **2 次被 sha256 拦下**） | **0** |
| `corrupt`（篡改 + 无校验） | 10 | 12 | 0（**2 次不可发现**）|

结论：**有校验值时不存在静默损坏**；**无校验值时"格式合法的篡改"本质上无法发现**（2/24 ≈ 8%）⇒
因此结果里会主动提示带上 `sha256`（很多项目/ GitHub Release 都公布 `.sha256` 附件）。
想跑更多种子：`DSH_FUZZ_SEEDS=60 node test/download-fuzz-selftest.mjs`。

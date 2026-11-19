// 一次性：CHANGELOG 加 0.12.7 段（跑完即删）
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'CHANGELOG.md'
const text = readFileSync(file, 'utf8')
const anchor = '## 0.12.6 — 2026-11-16'
if (!text.includes(anchor)) throw new Error('找不到 0.12.6 段')

const entry = `## 0.12.7 — 2026-11-19（启动信标带上版本与入口路径；内核 rc.5 兼容性确认）

内核升到 **0.2.2-rc.5**（app 2.0.24-next）后做了一轮兼容性核对：**全部通过**
（15 个工具全部注册、`sandboxPolicy.resolve()` 形状不变、`/checkpoint` `/rewind` 命令正常、
`pnpm` 自测 40 套件 1,707 断言全绿）。

升级期间在信标里看到一次真实故障，值得留痕：

\`\`\`text
01:44:46.741Z apply() entered; … config schema: none, volatile 家族开关=0
01:44:46.748Z search.apply FAILED: Cannot find package 'yaml' imported from D:\\…\\dsh-toolkit\\lib\\search.js
01:44:46.753Z astEdit.apply FAILED: Cannot find package '@ast-grep/napi' …
01:44:45.849Z sandbox services: policy=no confine=no
\`\`\`

宿主在插件重载的瞬间从**源码树**解析了 \`file:\` 依赖（源码树没有 \`node_modules\`）⇒ ast/search 两族缺依赖注册失败。
那一轮里安装副本的实例最终胜出（当前 ast 工具都正常），所以没有实际影响。

- 启动信标新增 \`ver=\` 与 \`entry=\`：下次一眼就能看出"加载的是安装副本还是源码树、哪个版本"。
- 顺带确认：即使真有源码树加载，其它 13 个工具也能正常注册（只有依赖外部包的两族会失败），不会整行插件消失。

全量 **40 套件 / 1,707 断言**通过；\`check-package\` 62/62；schema 不变（36,571 B）。

`

writeFileSync(file, text.replace(anchor, entry + anchor, 1))
console.log('changelog ok')

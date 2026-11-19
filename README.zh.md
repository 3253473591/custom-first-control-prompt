# @wm-coders/dsh-custom-first-control-prompt

[English](README.md) | 中文

部署方配置的提示词前缀。有序的系统提示词段渲染在部署 persona 之前，配置的 user/assistant 参考对话被注入到**每一个普通对话请求**中——作为真实的交替 user/assistant 消息前置在请求路径上（`llm/stream` 请求拦截；聊天日志里不出现种子消息，当前生效的配置以一条 `ignorable` 插件记录镜像到会话日志，可用 `dsh-session-yaml --emit-patch` 导出成可直接粘回 profile patch 的条目）。静态内容在每次请求中逐字节一致地渲染，从而保持前缀缓存复用。

## 安装

```bash
# 从 GitHub 安装（推荐 — 构建产物已提交，无需构建审批）
dsh plugin --profile web add github:WM-CODER/custom-first-control-prompt

# 从 npm 安装
dsh plugin --profile web add @wm-coders/dsh-custom-first-control-prompt

# 从本地目录安装（开发用）
dsh plugin --profile web add ./path/to/custom-first-control-prompt
```

安装后重启 web 应用（`dsh --profile web` 或运行 `restart-web.ps1` / `restart-web.sh`）。

卸载：

```bash
dsh plugin --profile web remove @wm-coders/dsh-custom-first-control-prompt
```

> 安装 / 部署 / 调试中遇到过的阻碍与测试方法见
> [DEBUG-NOTES.zh.md](DEBUG-NOTES.zh.md)（web fail-loud 根因、同 id 重复 insert、
> API 验证链路等，路径全部脱敏）；一键安装见 [INSTALL.md](INSTALL.md)；
> 跨机完整实测流程见 [INSTALL-FULL.zh.md](INSTALL-FULL.zh.md)。

## 配置

```yaml
- id: custom-first-control-prompt
  name: '@wm-coders/dsh-custom-first-control-prompt'
  config:
    sections:
      - name: house-rules
        order: -50
        text: |
          …stable system text…
    history:
      - user: …
        assistant: …
    includeSubagents: false
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `sections` | — | 有序的系统提示词片段。缺省或为空时不注册任何内容。 |
| `sections[].name` | 必填 | 条目名；注册表所见为 `custom-first-control-prompt:<name>`。 |
| `sections[].order` | 必填 | 在全部段中的渲染位置。出厂约定：harness identity 为 −100，persona 为 0，工具指导为 100–199；小于 0 的值前置到 persona 之前。 |
| `sections[].enabled` | `true` | `false` 时条目保留在配置中但不注册。 |
| `sections[].text` | 必填 | 静态段文本。不要放入时间戳等易变值：任何变化都会从首个变化的 token 起破坏前缀复用。 |
| `history` | — | 注入到每个普通对话请求的有序 `user`/`assistant` 参考对话；两者文本都必须非空，且不得包含保留标签（大小写不敏感：`<user>`、`<assistant>`、`<exchange>`、`<custom-history` 及所有闭合标签）。缺省或为空时不注入。 |
| `history[].assistantThinking` | — | 可选。该条 assistant 侧的**思维链示范**：注入的 assistant 消息会携带 `reasoning` 块（请求上送为 `reasoning_content`，推理模型在带工具的请求中会把它拼进上下文），正文（`assistant`）保持干净。不给则退回纯正文。同样不得包含保留标签；空值按未配置处理。 |
| `history[].toolCalls` | — | 可选。该条 assistant 侧的**伪造工具调用**：每条生成一个原生 `tool-call` 内容块（`id` / `name` / `arguments` 三字段）。`arguments` 必须是合法 JSON 的**字符串**；`id` 必须是**常量**（建议 `seed-call-<条目号>-<调用号>`），每次请求都变会从首个变化的 token 起破坏前缀复用；`name` 要与当前请求 `tools` 数组里的名字一致，否则模型会困惑。 |
| `history[].toolResults` | — | 可选。与 `toolCalls` 按**索引一对一**配对的结果，每条生成一条独立的 `role:'user'` + `source.kind='tool'` 消息（带配对 `toolCallId`）。**必须与 `toolCalls` 等长**：只造调用不造结果，OpenAI 兼容 provider 直接 400；多出的项会被忽略。`content` 就是模型读到的那段文本，`isError` 默认 `false`。 |
| `includeSubagents` | `false` | `false` 时跳过 header meta 标记为 subagent 来源的会话。 |

配置错误会使插件加载失败并指明出错条目：文本为空、section 重名或 order 非有限数。`sections` 的逐条问题（空名/重名/坏 order/空文本）与 `history` 的逐对问题（空文本/内嵌保留标签/toolCalls 与 toolResults 数量不匹配/id 重复或为空/arguments 非法 JSON）会**降级为跳过该条并告警**，不会拖垮整个插件树。

> **伪造工具调用与纯文本伪装的区别**：把调用过程写成 `assistant` 正文里的文字，模型只是"读到一段关于调用的叙述"；配 `toolCalls` + `toolResults` 则是注入真实的内容块，provider 报文里会出现 `assistant.tool_calls` 与 `role:"tool"` 消息 —— 模型读到的是**自己发起过这次调用**。后者要求 `tools` 数组里确实注册着同名工具。

## 注入机制

参考对话在插件加载时一次性构建为交替的真实 `Message` 对象（深冻结、跨请求共享引用），随后在每个普通对话请求上由 `llm/stream` waterfall 监听器前置注入：

- **克隆重分发**：循环构建的请求是深冻结且带 loop 标记的（`markAgentLoopRequest(deepFreeze(...))`），从不被修改；监听器克隆请求、前置种子消息、经 `ctx.llm.stream` 重新分发。克隆体无 loop 标记，agent-loop 的日志重建不变式不适用于它，被丢弃的原请求只是 `deriveMessages()` 的纯投影。
- **日志里没有种子消息**：种子只存在于请求路径——真实 turn 编号从 1 开始无冲突、fork 是普通副本、压缩无法遮蔽参考历史（每个请求都重新注入）。另每条会话写一条 `ignorable` 插件记录（`plugin:custom-first-control-prompt/injected`），内容是当前生效的完整配置（`sections` + `history` + `includeSubagents`）；它不进模型可见面、不改 turn 编号，日志读取器（dsh-session-yaml）可据此还原，并用 `--emit-patch` 输出可直接粘回 `cordis.patch.yml` 的条目——字段与本插件 `Config` 完全一致。
- **范围过滤**：辅助调用（`purpose` 标记，如 session-title、compaction）与手工构造请求（无 `sessionId`）直接放行不注入；subagent 来源会话默认跳过（`includeSubagents: true` 开启）。
- **面板验证**：聊天 transcript 看不到种子消息是预期行为；用面板「LLM 监听」直接查看注入后的真实请求（设置 → 「自定义优先控制提示词」→ LLM 监听，或对话输入框上方的 dock 条）。

**验证注入生效**：新建会话并提问一个只有注入历史才能回答的问题（如「重复我们最早的那条用户消息」），模型答出配置内容即生效；聊天 transcript 里看不到种子消息（这是特性），会话日志里只有那条 `ignorable` 配置记录。

**面板保存的语义**：面板「配置编辑」保存向 profile `cordis.patch.yml` 写入**带 id 的定向覆盖**（非 insert，绝不与 bundle 层的行撞 id），只更新本插件核心行（`custom-first-control-prompt`）的配置，**保留文件里其它所有内容**——其它条目、注释、以及旧安装遗留的行。profile 无本插件行时，编辑器显示当前生效的组合配置（bundle 层默认值），保存即生成覆盖。

## 系统段

每个启用的条目在插件加载时通过 `ctx.systemPrompt.section()` 注册，因此与出厂段完全一样参与每次组装：变量插值、scope 遮蔽与组装 waterfall 全部适用。静态配置文本在每次组装中渲染结果一致，这正是请求前缀保持可复用的原因。

## 模型体验

### 部署系统段

#### 模型所见

配置段的文本按各自配置的 order 位置渲染——默认在 persona 之前——由 [dsh-system-prompt](https://github.com/deepseek-ai/deepseek-harness) 与出厂段一起渲染。

#### Token 影响

每个段在每次请求中重复出现，开销随渲染长度伸缩。

#### KV 缓存影响

段文本、order 与启用集合渲染一致时前缀稳定。任何变化都可能从首个变化的系统提示词 token 起破坏复用。

### 参考对话历史

#### 模型所见

每个普通对话请求的消息序列头部出现真实的交替消息——每个配置的 `user` 文本一条 user 消息、每个配置的 `assistant` 文本一条 assistant 消息：

```markdown
[user]      configured user text 1
[assistant] configured assistant text 1
[user]      configured user text 2
[assistant] configured assistant text 2
[user]      the real prompt…
```

配置了 `assistantThinking` 的 assistant 侧会在正文前先携带思维链通道（`reasoning` 块）：

```markdown
[user]      configured user text 2
[assistant] <reasoning> configured thinking 2 </reasoning>
[assistant] configured assistant text 2
```

`reasoning` 块对 deepseek 适配器序列化为 `reasoning_content`：带 `tools` 的请求（agent 普通对话请求）会把历史 `reasoning_content` 拼进上下文，因此参考思维链真实可见于模型；不带 `tools` 的辅助请求本插件不注入，不受影响。

#### Token 影响

每请求固定 1 份参考对话（不随轮次累积，压缩也不影响——每个请求重新前置同一份冻结消息序列）。

#### KV 缓存影响

参考对话放在消息序列首位且字节稳定，请求前缀保持可复用。

## 时间、思考、正文、工具调用、结果

一条参考对话可以复刻真实会话的五要素：

| 字段 | 位置 | 作用 |
|---|---|---|
| `time` / `userTime` | 用户侧 | 用户消息时间戳 |
| `assistantTime` | assistant 侧 | 助手消息时间戳 |
| `assistantThinking` | assistant 侧 | 思考（reasoning 块） |
| `assistant` | assistant 侧 | 正文（可为空：纯工具调用步） |
| `toolCalls[]` | assistant 侧 | 工具命令（原生 tool-call 块） |
| `toolResults[]` | 与调用按索引配对 | 返回结果，可带 `time` 与 `images` |
| `userImages[]` | 用户侧 | 用户消息里的图片块 |

时间戳取 ISO-8601（建议带偏移）或 epoch 毫秒，注入时渲染成该消息正文的第一行
`[YYYY-MM-DD HH:mm:ss ±HH:MM]`（dsh 的 `Message` 没有时间字段，时间只能以文本形式
让模型看到；ISO 文本保留你写的墙钟与偏移，不做时区换算）。图片取本地路径或
`data:` URL，加载时写入 attachments 存储并生成真实 image 块，缺失或类型不支持只
丢弃该张图并告警。

把真实会话转成这种 YAML：

```bash
node tools/session-jsonl-to-yaml.mjs <session.v4.jsonl> --turn 9 --steps 12,52 --with-user
```

生成的样例见 `examples/session-76a36330-turn9.yml`（截图工具调用 + 图片结果 + 末轮思考与正文）。

## 按对话捕获（中间体）

会话标题旁有一个 `● 捕获中` 按钮，**新对话默认开启**；点一下变成 `Ⅱ 已暂停`，只影响当前对话。

每次普通对话请求都会把该对话的**有效提示词 + 消息序列**追加写到

```
<profile>/cfcp-captures/<sessionId>.yml
```

形如：

```yaml
sessionId: "session-…"
updatedAt: "2026-11-19T16:09:38.381Z"
model: "deepseek-flash"
provider: "deepseek-official"
purpose: ""
system: |-
  …真实系统提示词…
messages:
  - role: "user"
    text: |-
      真实用户消息
  - role: "assistant"
    thinking: |-
      …思考…
    text: |-
      …正文…
    toolCalls:
      - name: "read"
        arguments: '{"file_path":"…"}'
```

同一对话的捕获**一直叠加且不重复**（`format: 2`）：

- `kind: request`：这次请求新增的消息（`newMessages`），每条带 `id` 与 `time`；文件里已有的前缀不再重写，``previousMessages`` / ``totalMessages`` 说明它接在哪
- `kind: response`：这一轮的助手输出（`thinking` / `assistant` / `toolCalls` / `finish`），带 `time`
- 进度写在 `<capture>.state.json`，重启后接着写
- 旧格式文件可用 `node tools/compact-capture.mjs <file> --write` 压缩成新格式

同一对话的捕获**一直叠加**：每份请求是一份 YAML 文档（`---` 分隔），文档里的 `request: N` 是序号（重启后按文件里已有的文档数续号）。

这是**中间体**：捕获从不写 `cordis.patch.yml`（只有面板里手动保存配置才会动 profile patch）。
想把它变成注入用的参考历史，用 `tools/session-jsonl-to-yaml.mjs` 或手写 `history` 片段。

### YAML 块标量

面板的 patch 读取器同时接受内联标量与块标量，下面两种写法等价：

```yaml
text: "第一行\n第二行"
```

```yaml
text: |-
  第一行
  第二行
```

`|`、`|-`、`|+`、`>`、`>-` 与缩进指示符（`|2`）都支持；完整样例见 `examples/block-scalars.yml`。
注意：面板**保存**时统一用内联标量重写（内容不变，标量样式会被规范化）。

## 已知限制与延后工作

- **聊天界面看不到参考历史** — 种子只存在于请求路径，会话 UI 既不显示交替消息也不显示框架行；生效配置以 `ignorable` 插件记录（`appendPluginRecord`，需要 harness >= 0.2）镜像进会话日志，内容是可直接粘回 profile patch 的 `Config`，旧版 harness 则不写记录。
- **种子文本是模型可见的参考材料** — 部署方应将其视为模型读取的提示词文本，而非可信通道。
- **不支持会话中段修改** — 配置变更在 web 重启后对新请求生效；合规的"静止时编辑"应追加带 source seq 引用的 surface 替换事件，已延后。

## FAQ：插件是怎么进入组合的？

包声明了 `dsh.bundle`（包内 `cordis.patch.yml`），`dsh plugin add` 的对账会把这个
bundle 层激活进组合——**核心行 `custom-first-control-prompt`（服务端逻辑：系统段、
参考历史注入）出现**，无需手写任何 patch 行。浏览器面板（设置页、dock、
LLM 监听）通过包的 `dsh.client` 声明自动发现——不需要单独的面板行。
卸载 `dsh plugin remove` 会把依赖与 bundle 层一起移除。

- **自定义配置**：不要复制 `- insert:` 行。在 profile 的 `cordis.patch.yml` 写
  **带 id 的定向 patch**（非 insert）覆盖 bundle 行的 config（后写胜出），样例见
  `cordis.patch.yml.template`；面板「配置编辑」保存生成的正是这种覆盖。
- **离线 junction 安装**没有经过对账，bundle 层不会激活——`install.ps1 -Offline`
  会把同样的两行写进 profile patch 代替。
- **重复 id 警告**：bundle 层已带这两行后，profile patch 里若还有旧安装遗留的
  `- insert:` 同 id 行 = **根列表重复 → web fail-loud 起不来**；`uninstall.ps1`
  会外科式清理这两种残留。

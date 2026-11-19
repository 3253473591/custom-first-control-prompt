# Changelog

## [0.8.2] - 2026-11-20

### Added - 捕获同时记录助手回复（响应侧）
- 之前捕获挂在**请求**上，只能拿到"到这一条请求为止"的对话，本轮助手回复要等下一条请求才会出现（只发一条消息时永远看不到回复）。
- 现在监听器会**轻量 tap 流式响应**：chunk 原样透传，流结束后把这一轮助手输出作为一份 `kind: response` 文档追加进同一个文件，带 `request: <序号>` 与请求对应。
- response 文档字段：`thinking`（reasoning）、`assistant`（正文）、`toolCalls`（工具调用）、`finish`（stop / tool-calls / aborted…）、`complete`（是否正常结束）。
- 捕获关闭（暂停）时既不写请求也不写响应；流被中断时也会写一份 `complete: false` 的部分结果。

## [0.8.1] - 2026-11-20

### Added - 面板接受 YAML 块标量
- 面板读取 profile patch 时支持块标量：`|`、`|-`、`|+`、`>`、`>-`，含缩进指示符（如 `|2`）；
  `sections[].text`、`history[].user/assistant/assistantThinking`、`toolCalls[].arguments`、
  `toolResults[].content` 全都可以用块标量书写，不再被读成字面量 `|-` 或丢行。
- 折叠标量（`>`）按 YAML 规则把换行折成空格、空行保留为换行；chomping（`-` 去尾、默认保留一个换行、`+` 全保留）同样生效。
- 新增 `examples/block-scalars.yml`：全用块标量书写的可用样例。

### Fixed
- 不带 `-` 的嵌套写法 `user:` / `time:` 之前被忽略（解析器只认 `- user:`），现在也识别。

### Note
- 面板保存仍然用**内联标量**重写（`"…\n…"`）：内容不变、YAML 等价，但手写的块标量格式会被规范化。

## [0.8.0] - 2026-11-20

### Changed - 捕获改为追加，不再覆盖
- 同一对话的捕获文件现在**一直叠加**：每次请求追加一份 YAML 文档（`---` 分隔），文件保留完整时间线；
- 每份文档带 `request: <序号>`，重启后从文件里已有的 `---` 数量续号，不会从 1 重来；
- 会话标题旁的按钮 tooltip 变成 `<path> · N 次请求 · M 条消息`；
- `PanelCaptureView` 新增 `requests` 字段（宿主 + 三条线协议 schema 同步）。

### Note
- 每份文档都是自包含快照（含完整提示词与当时的完整消息序列），所以文件大小随请求数线性增长、随对话长度增长更快；只想保留最新一次请求时，把该对话暂停即可。

## [0.7.0] - 2026-11-20

### Added - 按对话捕获（中间体，不写 profile patch）
- 会话标题旁新增按钮：`● 捕获中` / `Ⅱ 已暂停`，**新对话默认捕获**，点一下只暂停该对话。
- 捕获写成一个对话一个文件：`<profile>/cfcp-captures/<sessionId>.yml`，内容为**有效提示词 + 消息序列**（role / thinking / text / toolCalls / 图片数），每个请求覆盖写，永远是最新一次请求。
- 捕获**不写** `cordis.patch.yml`：插件只在面板里手动保存配置时才动 profile patch；捕获文件是给 `tools/session-jsonl-to-yaml.mjs` / 手工改写参考历史用的中间产物。
- 新增 Remote：`capture-get` / `capture-set`（按会话读写开关），宿主侧 typert 线协议同步补齐。

### Fixed
- 监听器里的面板服务改为直接持有实例（`new PanelService` 的返回值），此前 `ctx.get('custom-first-control-prompt-panel')` 返回 `undefined`，导致「注入」开关在该路径上从未真正生效、捕获也从未被调用。

## [0.6.0] - 2026-11-20

### Added - 完整 transcript 五要素（时间 / 思考 / 正文 / 工具调用 / 结果）
- 每条参考对话支持时间戳：用户侧 `time`（同义 `userTime`）、assistant 侧 `assistantTime`、工具结果 `time`。取值 ISO-8601 文本或 epoch 毫秒，注入时渲染成该消息正文的第一行 `[YYYY-MM-DD HH:mm:ss ±HH:MM]`（dsh 的 Message 没有时间字段，时间只能以文本形式让模型看到；ISO 文本保留作者写的墙钟与偏移）。
- 支持图片内容块：用户侧 `userImages`、工具结果 `images`，取本地路径或 `data:` URL；加载时经 attachments 存储落成真实的内容寻址 image 块（读图场景），文件缺失/类型不支持只丢弃该图并告警。
- 纯工具调用步：`assistant` 允许为空（不再要求正文非空），只要该条还有 `toolCalls`。
- 新增 `tools/session-jsonl-to-yaml.mjs`：把 `session.v4.jsonl` 转成本插件的 `history` YAML（`--turn` / `--steps` / `--with-user` / `--with-images` / `--max-chars`）。
- 新增 `examples/session-76a36330-turn9.yml`：真实会话转出的两条代表性参考对话（截图工具调用 + 图片结果 + 末轮思考与正文）。

### Fixed
- 面板保存不再丢弃 `time` / `userImages` / `toolCalls` / `toolResults`：typert 线协议 schema、YAML 解析与渲染均补齐（此前保存会静默丢掉工具调用）。
- 会话日志的 `plugin:custom-first-control-prompt/injected` 记录不再因可选字段为 `undefined` 被整条拒绝（session 的 JSON 快照要求无损序列化）。

## [0.5.0] - 2026-11-11

### Fixed — dsh 0.2.1-rc.2 alignment
- `engines.dsh` and every `@deepseek-ai/dsh-*` peer declare the 0.2.x line (`>=0.2.0-0 <0.3.0`), so the 0.2.1-rc.2 compatibility gate admits the bundle instead of skipping it. `@deepseek-ai/dsh-client-ui-slots` is dropped from the peers (the client bundle never imports it) and `@deepseek-ai/dsh-client-ui-renderer` is declared, matching `dsh.client.inject`.
- The panel resolves the profile patch file through `profileContext.patchPath` first, then through `settings.prepareDocument()` accepting the 0.2.x semantics (that call returns the patch file itself); the `…/profiles/web/cordis.patch.yml` derivation stays as the 0.1.x fallback. Without this the editor reported an empty configuration and no save could land.
- Rewriting an existing core row keeps that row's own indentation: a second save used to render the row with the bundle layer's nested form, which dropped it inside the preceding patch entry and corrupted the file.
- The dock strip's version marker follows the package version again (`v0.5.0`).

### Added
- The effective configuration is mirrored into the session log once per session as an `ignorable` plugin record (`plugin:custom-first-control-prompt/injected`): `{ sections, history, includeSubagents }`. Every field is a valid `Config` field, so the record can be pasted back into a profile patch and this plugin's schema accepts it unchanged (verified against `Config`).
- The record is written for sections-only configurations too (the listener now installs for any configured content; without `history` it only records and passes the request through).
- `dsh-session-yaml --emit-patch` turns the record back into a paste-ready `- id: custom-first-control-prompt` entry.
- `recordInjectedHistory` exported for tests and hosts.

### Changed
- Requires `@deepseek-ai/dsh-session` (peer, >=0.2.0); on an older harness the record is skipped instead of failing the plugin load.
- One record per session for a static configuration; editing the configuration (panel save) produces a new payload and therefore a new record (dsh-session-yaml renders them as a list and `--emit-patch` prints the latest).
- README statements about "zero session-log writes" now describe the ignorable record precisely.

### Note
- `appendPluginRecord` is the harness' experimental plugin-record API. It is stable at runtime in 0.2.x, but a future 0.3.x may move it; re-check on harness upgrades.

## [0.3.0] - 2026-09-01

### Added
- Template system: save/load/delete named config snapshots (sections + history + subagent flag) from the settings page
- Template selector + "Inject" button on the composer dock strip: pick a template and apply it in one click
- Hot injection toggle button on the dock: enable/disable seed injection without restarting
- Template file (`cfcp-templates.json`) stored next to the profile patch; missing file = empty list, no startup impact

### Fixed
- `deepFreeze` no longer imported from `@deepseek-ai/dsh-llm` (whose npm build does not re-export it); the function is now inlined locally, fixing plugin load failure on dsh >= 0.1.2-alpha

### Changed
- `PanelRequestsView` now includes `injectionEnabled` and `activeTemplate` fields
- `llm/stream` listener checks the hot toggle before injecting seed messages

## [0.2.3] - 2026-08-21

### Fixed
- Client bundle `__ModuleLoader__.load` registration id now matches the core package name (`@wm-coders/dsh-custom-first-control-prompt`), fixing "loaded without registering" error on plugin install

## [0.2.2] - 2026-08-21

### Changed
- Merged host and client halves into a single package: `dsh.bundle` (host patch) and `dsh.client` (browser panel auto-discovery) now live in one `package.json`, eliminating the separate `@wm-coders/dsh-client-ui-custom-first-control-prompt` package
- `cordis.patch.yml` no longer inserts a UI row — the browser panel is auto-discovered via `dsh.client`
- `./client` export now points to the browser panel entry (`lib/client.js`); typert client types moved to `./typert-client`
- `install.ps1`/`install.sh` and `uninstall.ps1`/`uninstall.sh` simplified to single-package flow
- Uninstall message now includes browser hard-refresh instruction

### Fixed
- `dsh plugin add` no longer needs a separate UI package in `dependencies` — one package, one install
- Removed `settings.plugin.item` slot registration that used `id` on a `keyed` slot (keyed slot requires options.key)
- Removed `@deepseek-ai/dsh-client-ui-settings-plugins` from client inject list and peerDependencies (no longer used)
- Fixed offline junction scope from `@wm-coder` to `@wm-coders` in install/uninstall scripts

### Removed
- `client-ui/` subdirectory (merged into the main `lib/` tree)
- `@wm-coders/dsh-client-ui-custom-first-control-prompt` npm package (merged into core)

## [0.2.1] - 2026-08-20

### Added
- `engines.node` field for plugin guide compliance
- `CHANGELOG.md` following Keep a Changelog convention

### Changed
- npm scope renamed from `@wm-coder` to `@wm-coders` (the former was already taken on npm)
- `README.md` install commands updated for both GitHub and npm installation methods

## [0.2.0] - 2026-08-19

### Changed
- C-only convergence: removed A (hook) and B (append) seed modes, keeping only C (request-path interception)
- Package names changed from `@deepseek-ai/dsh-*` to `@wm-coder/dsh-*` (later `@wm-coders` in 0.2.1)
- Bundle layer (`cordis.patch.yml`) added with self-describing sample configuration
- Panel save anti-collision fix: profile patch without core row now uses id-targeted override instead of append

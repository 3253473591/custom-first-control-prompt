# Changelog

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

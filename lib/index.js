import z from "@deepseek-ai/schemastery";
import * as dshSession from "@deepseek-ai/dsh-session";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { MessageId, ToolCallId, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/seed.js
/**
* Seed-message construction for custom-first-control-prompt: the request-path
* alternating user/assistant sequence built once per plugin activation and
* shared by every intercepted request.
*/
/**
* Deep-freeze a value in place with an iterative traversal, guarding cycles.
* Inlined from dsh-util-values' implementation (dsh-llm's built output does
* not re-export it): WeakSet cycle guard + explicit traversal queue, so later
* mutation throws without imposing a call-stack depth cap. AbortSignal objects
* are skipped: they are the request's live cancellation channel.
* @param value - the value to freeze in place.
* @returns the same value, frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
/** Plugin attribution carried by the injected assistant messages' `source`. */
const SEED_SOURCE = "custom-first-control-prompt";
/**
* Exchange tags the injected texts may not contain case-insensitively. The
* reference exchanges travel as plain message texts; embedding the tag
* grammar would invite the model to re-parse (or forge) exchange markup that
* no longer exists, so plugin load skips such texts with a warning instead.
*/
const TRANSCRIPT_RESERVED_TAGS = [
	"<custom-history",
	"</custom-history>",
	"<exchange>",
	"</exchange>",
	"<user>",
	"</user>",
	"<assistant>",
	"</assistant>"
];
const SEED_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/;
function pad2(value) {
	return String(value).padStart(2, "0");
}
function localOffset(date) {
	const minutes = -date.getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	const absolute = Math.abs(minutes);
	return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}
/**
* Render a configured timestamp as `YYYY-MM-DD HH:mm:ss ±HH:MM`: ISO text keeps
* the wall clock and offset its author wrote, epoch milliseconds render in the
* host's local time, and an unparsable value renders nothing.
* @param value - configured timestamp.
* @returns the formatted stamp, or undefined when absent or unparsable.
*/
function formatSeedTime(value) {
	if (value === void 0) return void 0;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return void 0;
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return void 0;
		return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${localOffset(date)}`;
	}
	const match = SEED_TIME_PATTERN.exec(value.trim());
	if (match === null) return void 0;
	const [, day, clock, seconds, rawOffset] = match;
	const offset = rawOffset === void 0 || rawOffset === "Z" ? "+00:00" : rawOffset.includes(":") ? rawOffset : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`;
	return `${day} ${clock}:${seconds ?? "00"} ${offset}`;
}
/**
* Prepend the model-visible timestamp line to one message text.
* @param text - configured text, possibly empty.
* @param value - configured timestamp.
* @returns the stamped text, unchanged when no stamp parses.
*/
function stampSeedText(text, value) {
	const stamp = formatSeedTime(value);
	if (stamp === void 0) return text;
	return text.length > 0 ? `[${stamp}]\n${text}` : `[${stamp}]`;
}
function seedImages(refs, resolve) {
	if (refs === void 0 || refs.length === 0 || resolve === void 0) return [];
	const blocks = [];
	for (const ref of refs) {
		const block = resolve(ref);
		if (block !== void 0) blocks.push(block);
	}
	return blocks;
}
/**
* Build the request-level seed messages: one real alternating user/assistant
* exchange per configured pair, as plain `Message` objects for
* `GenerateOptions.messages`. Built once per plugin activation and shared by
* every intercepted request, keeping the injected prefix byte-identical for
* prefix-cache reuse. These messages never enter the session log — they exist
* only on the request path, so there is no turn structure to conflict with
* the loop's turn numbering and nothing for compaction to shadow. The user
* side carries `kind:'user'` and the assistant side plugin attribution.
*
* A configured timestamp becomes a leading `[YYYY-MM-DD HH:mm:ss ±HH:MM]` line
* inside that message's text block (the model reads time only as text: dsh
* messages carry no time field). Configured image references resolve through
* the host's attachment store, so `读图` transcripts carry real image blocks.
* @param pairs - ordered reference exchanges.
* @param resolveImage - resolves one image reference to an image block.
* @returns the frozen alternating user/assistant message sequence.
*/
function buildSeedMessages(pairs, resolveImage) {
	const messages = [];
	for (const [index, pair] of pairs.entries()) {
		// user 允许留空：为空时只注入 assistant 那一侧
		// （reasoning → 正文 → tool-call），不产生一条空文本的 user 消息。
		const userText = stampSeedText(pair.user ?? "", pair.userTime ?? pair.time);
		const userImageBlocks = seedImages(pair.userImages, resolveImage);
		if (userText.length > 0 || userImageBlocks.length > 0) {
			messages.push(createUserMessage({
				content: [...(userText.length > 0 ? [{
					type: "text",
					text: userText
				}] : []), ...userImageBlocks],
				source: { kind: "user" }
			}));
		}
		messages.push({
			id: MessageId(`${SEED_SOURCE}-intercept-${index}`),
			role: "assistant",
			source: {
				kind: "plugin",
				plugin: SEED_SOURCE
			},
			content: [
			...(pair.assistantThinking !== void 0 && pair.assistantThinking.length > 0 ? [{
				type: "reasoning",
				text: pair.assistantThinking
			}] : []),
			...(stampSeedText(pair.assistant, pair.assistantTime).length > 0 ? [{
				type: "text",
				text: stampSeedText(pair.assistant, pair.assistantTime)
			}] : []),
			...(Array.isArray(pair.toolCalls) ? pair.toolCalls.map((call) => ({
				type: "tool-call",
				id: ToolCallId(call.id),
				name: call.name,
				arguments: call.arguments
			})) : [])
			]
		});
		// 每条调用后面必须紧跟一条 tool-result 消息（role:'user' + source.kind:'tool'）。
		// 只造调用不造结果，OpenAI 兼容 provider 会直接 400。
		if (Array.isArray(pair.toolCalls)) {
			for (const [i, call] of pair.toolCalls.entries()) {
				const result = Array.isArray(pair.toolResults) ? pair.toolResults[i] : void 0;
				if (result === void 0) continue;
				messages.push(createToolResultMessage({
					callId: ToolCallId(call.id),
					content: [{
						type: "text",
						text: stampSeedText(result.content, result.time)
					}, ...seedImages(result.images, resolveImage)],
					isError: result.isError === true
				}));
			}
		}
	}
	return deepFreeze(messages);
}
//#endregion
//#region lib/types/panel.js
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** The web panel management service. */
let PanelService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _configRead_decorators;
	let _configWrite_decorators;
	let _configClear_decorators;
	let _configRawImport_decorators;
	let _requestsList_decorators;
	let _requestsSetPaused_decorators;
	let _captureGet_decorators;
	let _captureSet_decorators;
	let _requestsClear_decorators;
	let _uiSetDockVisible_decorators;
	let _previewAssemble_decorators;
	let _templateList_decorators;
	let _templateSave_decorators;
	let _templateDelete_decorators;
	let _templateApply_decorators;
	let _injectionToggle_decorators;
	return class PanelService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_configRead_decorators = [Remote("config-read")];
			_configWrite_decorators = [Remote("config-write")];
			_configClear_decorators = [Remote("config-clear")];
			_configRawImport_decorators = [Remote("config-raw-import")];
			_requestsList_decorators = [Remote("requests-list")];
			_requestsSetPaused_decorators = [Remote("requests-set-paused")];
			_captureGet_decorators = [Remote("capture-get")];
			_captureSet_decorators = [Remote("capture-set")];
			_requestsClear_decorators = [Remote("requests-clear")];
			_uiSetDockVisible_decorators = [Remote("ui-set-dock-visible")];
			_previewAssemble_decorators = [Remote("preview-assemble")];
			_templateList_decorators = [Remote("template-list")];
			_templateSave_decorators = [Remote("template-save")];
			_templateDelete_decorators = [Remote("template-delete")];
			_templateApply_decorators = [Remote("template-apply")];
			_injectionToggle_decorators = [Remote("injection-toggle")];
			__esDecorate(this, null, _configRead_decorators, {
				kind: "method",
				name: "configRead",
				static: false,
				private: false,
				access: {
					has: (obj) => "configRead" in obj,
					get: (obj) => obj.configRead
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _configWrite_decorators, {
				kind: "method",
				name: "configWrite",
				static: false,
				private: false,
				access: {
					has: (obj) => "configWrite" in obj,
					get: (obj) => obj.configWrite
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _configClear_decorators, {
				kind: "method",
				name: "configClear",
				static: false,
				private: false,
				access: {
					has: (obj) => "configClear" in obj,
					get: (obj) => obj.configClear
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _configRawImport_decorators, {
				kind: "method",
				name: "configRawImport",
				static: false,
				private: false,
				access: {
					has: (obj) => "configRawImport" in obj,
					get: (obj) => obj.configRawImport
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _requestsList_decorators, {
				kind: "method",
				name: "requestsList",
				static: false,
				private: false,
				access: {
					has: (obj) => "requestsList" in obj,
					get: (obj) => obj.requestsList
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _requestsSetPaused_decorators, {
				kind: "method",
				name: "requestsSetPaused",
				static: false,
				private: false,
				access: {
					has: (obj) => "requestsSetPaused" in obj,
					get: (obj) => obj.requestsSetPaused
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _captureGet_decorators, {
				kind: "method",
				name: "captureGet",
				static: false,
				private: false,
				access: {
					has: (obj) => "captureGet" in obj,
					get: (obj) => obj.captureGet
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _captureSet_decorators, {
				kind: "method",
				name: "captureSet",
				static: false,
				private: false,
				access: {
					has: (obj) => "captureSet" in obj,
					get: (obj) => obj.captureSet
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _requestsClear_decorators, {
				kind: "method",
				name: "requestsClear",
				static: false,
				private: false,
				access: {
					has: (obj) => "requestsClear" in obj,
					get: (obj) => obj.requestsClear
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _uiSetDockVisible_decorators, {
				kind: "method",
				name: "uiSetDockVisible",
				static: false,
				private: false,
				access: {
					has: (obj) => "uiSetDockVisible" in obj,
					get: (obj) => obj.uiSetDockVisible
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _previewAssemble_decorators, {
				kind: "method",
				name: "previewAssemble",
				static: false,
				private: false,
				access: {
					has: (obj) => "previewAssemble" in obj,
					get: (obj) => obj.previewAssemble
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _templateList_decorators, {
				kind: "method",
				name: "templateList",
				static: false,
				private: false,
				access: {
					has: (obj) => "templateList" in obj,
					get: (obj) => obj.templateList
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _templateSave_decorators, {
				kind: "method",
				name: "templateSave",
				static: false,
				private: false,
				access: {
					has: (obj) => "templateSave" in obj,
					get: (obj) => obj.templateSave
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _templateDelete_decorators, {
				kind: "method",
				name: "templateDelete",
				static: false,
				private: false,
				access: {
					has: (obj) => "templateDelete" in obj,
					get: (obj) => obj.templateDelete
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _templateApply_decorators, {
				kind: "method",
				name: "templateApply",
				static: false,
				private: false,
				access: {
					has: (obj) => "templateApply" in obj,
					get: (obj) => obj.templateApply
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _injectionToggle_decorators, {
				kind: "method",
				name: "injectionToggle",
				static: false,
				private: false,
				access: {
					has: (obj) => "injectionToggle" in obj,
					get: (obj) => obj.injectionToggle
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		ring = (__runInitializers(this, _instanceExtraInitializers), []);
		seq = 0;
		paused = true;
		dockVisible = true;
		/** Hot injection toggle; when false the llm/stream listener passes through. */
		injectionEnabled = true;
	/** Per-session capture switch; absent means capturing. */
	captureEnabled = /* @__PURE__ */ new Map();
	/** Last capture written per session. */
	captureWritten = /* @__PURE__ */ new Map();
	/** Next document index per session. */
	captureIndex = /* @__PURE__ */ new Map();
		/** Name of the last applied template; empty when none. */
		activeTemplate = "";
		/** Composed plugin config snapshot, shown when the profile patch has no row. */
		effective;
		constructor(ctx, effective) {
			super(ctx, "custom-first-control-prompt-panel");
			this.effective = effective;
			ctx.on("llm/stream", (options, next) => {
				const stream = next();
				if (!this.paused) this.capture(options);
				return stream;
			});
		}
		capture(options) {
			try {
				const record = options;
				const entry = {
					id: ++this.seq,
					time: Date.now(),
					model: typeof record["model"] === "string" ? record["model"] : "",
					provider: typeof record["provider"] === "string" ? record["provider"] : "",
					system: typeof record["system"] === "string" ? record["system"] : "",
					purpose: typeof record["purpose"] === "string" ? record["purpose"] : "",
					messages: []
				};
				entry.messages = (Array.isArray(record["messages"]) ? record["messages"] : []).map((msg) => {
					let text = "";
					const m = typeof msg === "object" && msg !== null ? msg : void 0;
					if (typeof m?.["content"] === "string") text = m["content"];
					else if (Array.isArray(m?.["content"])) text = m["content"].map((block) => {
						if (typeof block === "string") return block;
						const b = typeof block === "object" && block !== null ? block : void 0;
						return b?.["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
					}).join("");
					return {
						role: typeof m?.["role"] === "string" ? m["role"] : "unknown",
						text
					};
				});
				this.ring.push(entry);
				if (this.ring.length > 30) this.ring.shift();
			} catch (error) {
				this.ctx.logger?.warn("custom-first-control-prompt panel request capture failed: %s", String(error));
			}
		}
		async patchPath() {
			// dsh >= 0.2 exposes the launched profile itself; prefer it over string surgery.
			const profileContext = this.ctx.get("profileContext");
			if (profileContext !== void 0 && typeof profileContext.patchPath === "string" && profileContext.patchPath.length > 0) {
				return profileContext.patchPath.replace(/\\/g, "/");
			}
			const settings = this.ctx.get("settings");
			if (settings !== void 0) try {
				const doc = await settings.prepareDocument();
				if (typeof doc === "string" && doc.length > 0) {
					const norm = doc.replace(/\\/g, "/");
					// 0.2.x hands back the profile patch file itself; 0.1.x handed back settings.yaml.
					if (/\/cordis\.patch\.ya?ml$/i.test(norm)) return norm;
					const i = norm.lastIndexOf("/");
					if (i > 0) return `${norm.slice(0, i)}/profiles/web/cordis.patch.yml`;
				}
			} catch {}
			return null;
		}
		writePolicy() {
			const policy = this.ctx.get("sandboxPolicy");
			try {
				return policy?.resolve({ mode: "danger-full-access" });
			} catch {
				return;
			}
		}
		static yamlUnquote(value) {
			let s = value.trim();
			if (s.length >= 2 && s[0] === "\"" && s[s.length - 1] === "\"") s = s.slice(1, -1);
			else if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") s = s.slice(1, -1);
			return s.replace(/\\\\/g, "\0").replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\u0000/g, "\\");
		}
		static yamlScalar(value) {
			return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n")}"`;
		}
		/** Render a list of image references as a YAML flow sequence of scalars. */
		static yamlList(values) {
			return `[${values.map((value) => PanelService.yamlScalar(value)).join(", ")}]`;
		}
		/** Parse a YAML flow sequence of scalars (`["a", "b"]`); a bare scalar yields one entry. */
		static parseInlineList(value) {
			const raw = value.trim();
			const out = [];
			if (raw.length === 0) return out;
			if (!(raw.startsWith("[") && raw.endsWith("]"))) {
				const single = PanelService.yamlUnquote(raw);
				return single.length > 0 ? [single] : out;
			}
			const inner = raw.slice(1, -1);
			let current = "";
			let quoted = false;
			for (let i = 0; i < inner.length; i++) {
				const ch = inner[i];
				if (ch === "\\" && quoted && i + 1 < inner.length) {
					current += ch + inner[i + 1];
					i += 1;
					continue;
				}
				if (ch === "\"") {
					quoted = !quoted;
					current += ch;
					continue;
				}
				if (ch === "," && !quoted) {
					const entry = PanelService.yamlUnquote(current);
					if (entry.length > 0) out.push(entry);
					current = "";
					continue;
				}
				current += ch;
			}
			const last = PanelService.yamlUnquote(current);
			if (last.length > 0) out.push(last);
			return out;
		}
		static parseBlock(raw) {
			const out = {
				found: false,
				sections: [],
				history: [],
				includeSubagents: false
			};
			if (raw.indexOf("custom-first-control-prompt") < 0) return out;
			out.found = true;
			let zone = "";
			let cur = null;
			let sub = "";
			let curCall = null;
			let curResult = null;
			for (const line of raw.split(/\r?\n/)) {
				const t = line.trim();
				if (t.indexOf("sections:") === 0) {
					zone = "sections";
					cur = null;
					continue;
				}
				if (t.indexOf("history:") === 0) {
					zone = "history";
					cur = null;
					continue;
				}
				if (t.indexOf("includeSubagents:") === 0) {
					zone = "";
					cur = null;
				}
				if (zone === "sections") {
					if (t.indexOf("- name:") === 0) {
						cur = {
							name: PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1)),
							order: 0,
							text: "",
							enabled: true
						};
						out.sections.push(cur);
					} else if (cur !== null && "name" in cur && t.indexOf("order:") === 0) cur.order = Number(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "name" in cur && t.indexOf("text:") === 0) cur.text = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
				} else if (zone === "history") {
					// 一条参考对话的起始字段：用户侧为空时序列化出来可能以 assistant 字段打头，
					// 所以任何这些 "- <field>:" 行都要开启新条目，而不是并进上一条。
					const startsPair = t.indexOf("- time:") === 0 || t.indexOf("- user:") === 0 || t.indexOf("- userImages:") === 0 || t.indexOf("- assistant:") === 0 || t.indexOf("- assistantTime:") === 0 || t.indexOf("- assistantThinking:") === 0;
					if (startsPair) {
						cur = { assistant: "" };
						out.history.push(cur);
						sub = "";
						curCall = null;
						curResult = null;
					}
					if (cur !== null && t.indexOf("- time:") === 0) cur.time = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && t.indexOf("- user:") === 0) cur.user = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && t.indexOf("- userImages:") === 0) cur.userImages = PanelService.parseInlineList(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("userTime:") === 0) cur.userTime = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("userImages:") === 0) cur.userImages = PanelService.parseInlineList(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("assistantTime:") === 0) cur.assistantTime = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("- assistantTime:") === 0) cur.assistantTime = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("assistantThinking:") === 0) cur.assistantThinking = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("- assistantThinking:") === 0) cur.assistantThinking = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("- assistant:") === 0) cur.assistant = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("assistant:") === 0) cur.assistant = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && "assistant" in cur && t.indexOf("toolCalls:") === 0) {
						cur.toolCalls = [];
						sub = "calls";
						curCall = null;
					} else if (cur !== null && "assistant" in cur && t.indexOf("toolResults:") === 0) {
						cur.toolResults = [];
						sub = "results";
						curResult = null;
					} else if (cur !== null && sub === "calls" && t.indexOf("- id:") === 0) {
						curCall = {
							id: PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1)),
							name: "",
							arguments: ""
						};
						cur.toolCalls.push(curCall);
					} else if (cur !== null && sub === "calls" && curCall !== null && t.indexOf("name:") === 0) curCall.name = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && sub === "calls" && curCall !== null && t.indexOf("arguments:") === 0) curCall.arguments = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && sub === "results" && t.indexOf("- content:") === 0) {
						curResult = {
							content: PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1)),
							isError: false
						};
						cur.toolResults.push(curResult);
					} else if (cur !== null && sub === "results" && curResult !== null && t.indexOf("time:") === 0) curResult.time = PanelService.yamlUnquote(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && sub === "results" && curResult !== null && t.indexOf("images:") === 0) curResult.images = PanelService.parseInlineList(t.slice(t.indexOf(":") + 1));
					else if (cur !== null && sub === "results" && curResult !== null && t.indexOf("isError:") === 0) curResult.isError = t.slice(t.indexOf(":") + 1).trim() === "true";
				} else if (zone === "") {
					const m = t.match(/^includeSubagents:\s*(true|false)/);
					if (m) out.includeSubagents = m[1] === "true";
				}
			}
			return out;
		}
		/**
		* Render one history pair as YAML: time stamps, user/assistant text,
		* reasoning, forged tool calls, and their results (with per-result time and
		* image references).
		*
		* Extracted so the two indent variants (bundle row / profile override)
		* cannot drift apart: they differ only in the indent strings.
		* @param p - the pair to render.
		* @param itemIndent - indent of the `- ` item line.
		* @param fieldIndent - indent of the `assistant:` / `toolCalls:` lines.
		* @returns the rendered block for one pair.
		*/
		static pairBlock(p, itemIndent, fieldIndent) {
			const userText = typeof p.user === "string" ? p.user : "";
			const stamp = p.userTime ?? p.time;
			let block = `${itemIndent}- `;
			if (stamp !== void 0 && String(stamp).length > 0) block += `time: ${PanelService.yamlScalar(String(stamp))}\n${fieldIndent}user: ${PanelService.yamlScalar(userText)}`;
			else block += `user: ${PanelService.yamlScalar(userText)}`;
			if (Array.isArray(p.userImages) && p.userImages.length > 0) block += `\n${fieldIndent}userImages: ${PanelService.yamlList(p.userImages)}`;
			if (p.assistantTime !== void 0 && String(p.assistantTime).length > 0) block += `\n${fieldIndent}assistantTime: ${PanelService.yamlScalar(String(p.assistantTime))}`;
			block += `\n${fieldIndent}assistant: ${PanelService.yamlScalar(p.assistant)}`;
			if (p.assistantThinking !== void 0 && p.assistantThinking.length > 0) block += `\n${fieldIndent}assistantThinking: ${PanelService.yamlScalar(p.assistantThinking)}`;
			const calls = Array.isArray(p.toolCalls) ? p.toolCalls : [];
			const results = Array.isArray(p.toolResults) ? p.toolResults : [];
			if (calls.length > 0) {
				const callItemIndent = `${fieldIndent}  `;
				const callFieldIndent = `${callItemIndent}  `;
				block += `\n${fieldIndent}toolCalls:`;
				for (const c of calls) {
					block += `\n${callItemIndent}- id: ${PanelService.yamlScalar(String(c.id))}\n${callFieldIndent}name: ${PanelService.yamlScalar(String(c.name))}\n${callFieldIndent}arguments: ${PanelService.yamlScalar(String(c.arguments))}`;
				}
				const pairs = Math.min(calls.length, results.length);
				if (pairs > 0) {
					block += `\n${fieldIndent}toolResults:`;
					for (let i = 0; i < pairs; i++) {
						const result = results[i];
						block += `\n${callItemIndent}- content: ${PanelService.yamlScalar(String(result.content))}\n${callFieldIndent}isError: ${result.isError === true ? "true" : "false"}`;
						if (result.time !== void 0 && String(result.time).length > 0) block += `\n${callFieldIndent}time: ${PanelService.yamlScalar(String(result.time))}`;
						if (Array.isArray(result.images) && result.images.length > 0) block += `\n${callFieldIndent}images: ${PanelService.yamlList(result.images)}`;
					}
				}
			}
			return block;
		}
		/** Render just the core `custom-first-control-prompt` loader row (4-space indent block). */
		static coreBlock(config) {
			const sections = Array.isArray(config?.sections) ? config.sections : [];
			const history = Array.isArray(config?.history) ? config.history : [];
			const includeSubagents = config?.includeSubagents === true;
			const secBlock = sections.length > 0 ? sections.map((s) => `          - name: ${PanelService.yamlScalar(s.name)}\n            order: ${Number(s.order) || 0}\n            text: ${PanelService.yamlScalar(s.text)}`).join("\n") : "";
			const hisBlock = history.length > 0 ? history.map((p) => PanelService.pairBlock(p, "          ", "            ")).join("\n") : "";
			return "    - id: custom-first-control-prompt\n      name: '@wm-coders/dsh-custom-first-control-prompt'\n      config:\n" + (sections.length > 0 ? `        sections:\n${secBlock}\n` : "        sections: []\n") + (history.length > 0 ? `        history:\n${hisBlock}\n` : "        history: []\n") + `        includeSubagents: ${includeSubagents ? "true" : "false"}\n`;
		}
		/**
		* Render the targeted (id-keyed, non-insert) profile-layer override for the
		* core row. The bundle layer (this package's `dsh.bundle` patch) inserts the
		* loader rows; a profile-layer `- insert:` of the same id would duplicate it
		* and fail the whole composition, so the panel always writes overrides.
		*/
		static coreOverrideBlock(config) {
			const sections = Array.isArray(config?.sections) ? config.sections : [];
			const history = Array.isArray(config?.history) ? config.history : [];
			const includeSubagents = config?.includeSubagents === true;
			const secBlock = sections.length > 0 ? sections.map((s) => `    - name: ${PanelService.yamlScalar(s.name)}\n      order: ${Number(s.order) || 0}\n      text: ${PanelService.yamlScalar(s.text)}`).join("\n") : "";
			const hisBlock = history.length > 0 ? history.map((p) => PanelService.pairBlock(p, "    ", "      ")).join("\n") : "";
			return "- id: custom-first-control-prompt\n  config:\n" + (sections.length > 0 ? `    sections:\n${secBlock}\n` : "    sections: []\n") + (history.length > 0 ? `    history:\n${hisBlock}\n` : "    history: []\n") + `    includeSubagents: ${includeSubagents ? "true" : "false"}\n`;
		}
		static buildPatch(config) {
			return "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n" + PanelService.coreOverrideBlock(config);
		}
		/**
		* Return `existingRaw` with the core `custom-first-control-prompt` row's
		* config replaced by `config`, preserving every other line — comments, other
		* patch entries, and especially the manually-added panel client row
		* (`ui-custom-first-control-prompt`), which older bundles require and which a
		* blanket overwrite dropped silently (losing the UI). When the file has no
		* core row yet, a targeted id-keyed override is appended (never an `- insert:`
		* block: the bundle layer already carries the row, and a duplicate insert
		* fails the composition).
		*/
		static mergeCoreBlock(existingRaw, config) {
			const lines = existingRaw.split(/\r?\n/);
			const coreIdx = lines.findIndex((l) => l.trim() === "- id: custom-first-control-prompt");
			if (coreIdx === -1) {
				if (existingRaw.trim() === "") return PanelService.buildPatch(config);
				if (lines.map((l) => l.trim()).filter((t) => t !== "" && !t.startsWith("#")).every((t) => t === "[]")) {
					const head = existingRaw.split(/\r?\n/).filter((l) => l.trim() === "" || l.trim().startsWith("#")).join("\n").trimEnd();
					return (head.length > 0 ? head + "\n" : "") + PanelService.coreOverrideBlock(config);
				}
				return existingRaw + (existingRaw.endsWith("\n") ? "" : "\n") + PanelService.coreOverrideBlock(config);
			}
			const indent = (lines[coreIdx]?.match(/^\s*/)?.[0] ?? "").length;
			// Render the replacement at the matched row's own indent: a profile-layer
			// override is column 0, the bundle layer's insert row is nested. Rewriting a
			// column-0 row with the nested form dropped it inside the preceding block.
			const rendered = PanelService.coreOverrideBlock(config);
			const core = indent === 0 ? rendered : rendered.split("\n").map((line) => (line.length > 0 ? " ".repeat(indent) + line : line)).join("\n");
			let end = coreIdx + 1;
			while (end < lines.length) {
				const line = lines[end];
				if (line.trim().startsWith("- ") && (line.match(/^\s*/)?.[0] ?? "").length <= indent) break;
				end++;
			}
			return [
				...lines.slice(0, coreIdx),
				core,
				...lines.slice(end)
			].join("\n");
		}
		async readPatch() {
			const path = await this.patchPath();
			if (path === null) return {
				ok: false,
				path: "",
				raw: "",
				parsed: PanelService.parseBlock(""),
				error: "unable to locate the profile patch file (settings.prepareDocument() returned no path)"
			};
			const fs = this.ctx.get("fs");
			if (fs === void 0) return {
				ok: false,
				path,
				raw: "",
				parsed: PanelService.parseBlock(""),
				error: "fs service unavailable"
			};
			try {
				const target = await fs.resolve(path);
				const raw = await fs.readText(target);
				const parsed = PanelService.parseBlock(raw);
				return {
					ok: true,
					path,
					raw,
					parsed: parsed.found || this.effective === void 0 ? parsed : this.effective,
					error: ""
				};
			} catch (error) {
				return {
					ok: false,
					path,
					raw: "",
					parsed: PanelService.parseBlock(""),
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		async writePatch(raw) {
			const path = await this.patchPath();
			if (path === null) return {
				ok: false,
				path: "",
				error: "unable to locate the profile patch file (settings.prepareDocument() returned no path)"
			};
			const fs = this.ctx.get("fs");
			if (fs === void 0) return {
				ok: false,
				path,
				error: "fs service unavailable"
			};
			try {
				const target = await fs.resolve(path);
				await fs.writeText(target, raw, void 0, void 0, this.writePolicy());
				return {
					ok: true,
					path,
					saved: true,
					error: ""
				};
			} catch (error) {
				return {
					ok: false,
					path,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/** Read the profile patch entry. */
		configRead(agent) {
			return this.readPatch();
		}
		/** Write the profile patch entry regenerated from the panel's config view. */
		async configWrite(agent, config) {
			const existing = await this.readPatch();
			return this.writePatch(PanelService.mergeCoreBlock(existing.ok ? existing.raw : "", config));
		}
		/** Clear the configured prompt content, keeping the plugin installed (and any other patch lines). */
		async configClear(agent) {
			const existing = await this.readPatch();
			return this.writePatch(PanelService.mergeCoreBlock(existing.ok ? existing.raw : "", {
				found: true,
				sections: [],
				history: [],
				includeSubagents: false
			}));
		}
		/** Import a raw patch file text wholesale. */
		configRawImport(agent, raw) {
			if (typeof raw !== "string" || raw.trim() === "") return Promise.resolve({
				ok: false,
				path: "",
				error: "raw content is empty; nothing written"
			});
			return this.writePatch(raw);
		}
		/** Snapshot the captured request ring plus listener state. */
		requestsList(agent) {
			return {
				requests: this.ring.slice(),
				paused: this.paused,
				dockVisible: this.dockVisible,
				injectionEnabled: this.injectionEnabled,
				activeTemplate: this.activeTemplate
			};
		}
		/** Pause or resume request capture. */
		requestsSetPaused(agent, paused) {
			this.paused = paused === true;
			return {
				requests: this.ring.slice(),
				paused: this.paused,
				dockVisible: this.dockVisible,
				injectionEnabled: this.injectionEnabled,
				activeTemplate: this.activeTemplate
			};
		}
		/** Directory holding one capture file per conversation, beside the profile patch. */
		async captureDir() {
			const patch = await this.patchPath();
			if (patch === null) return null;
			const cut = patch.lastIndexOf("/");
			return cut > 0 ? `${patch.slice(0, cut)}/cfcp-captures` : null;
		}
		captureView(sessionId) {
			const written = this.captureWritten.get(sessionId);
			return {
				enabled: this.captureEnabled.get(sessionId) !== false,
				path: written?.path ?? "",
				updatedAt: written?.updatedAt ?? 0,
				messages: written?.messages ?? 0,
				requests: written?.requests ?? 0,
				error: ""
			};
		}
		/**
		* Write one conversation's real request into its own capture file.
		*
		* The file is the intermediate artifact between a live conversation and a
		* reference-history patch: the effective prompt plus the ordered message
		* sequence, never a write into the profile patch. One file per conversation,
		* overwritten on every request so it always holds the latest request.
		* @param sessionId - the session the request belongs to.
		* @param options - the request as the model will see it.
		*/
		async captureRequest(sessionId, options) {
			if (this.captureEnabled.get(sessionId) === false) return;
			const dir = await this.captureDir();
			if (dir === null) return;
			try {
				const record = options;
				const messages = Array.isArray(record["messages"]) ? record["messages"] : [];
				const path = `${dir}/${sessionId}.yml`;
				const request = await this.nextCaptureIndex(sessionId, path);
				const lines = [
					`request: ${request}`,
					`sessionId: ${JSON.stringify(sessionId)}`,
					`updatedAt: ${JSON.stringify((/* @__PURE__ */ new Date()).toISOString())}`,
					`model: ${JSON.stringify(typeof record["model"] === "string" ? record["model"] : "")}`,
					`provider: ${JSON.stringify(typeof record["provider"] === "string" ? record["provider"] : "")}`,
					`purpose: ${JSON.stringify(typeof record["purpose"] === "string" ? record["purpose"] : "")}`
				];
				const systemText = messages.filter((msg) => msg?.["role"] === "system").map((msg) => PanelService.messageText(msg)).join("\n\n");
				lines.push("system: |-");
				for (const line of (systemText.length > 0 ? systemText : "").split("\n")) lines.push(`  ${line}`);
				lines.push("messages:");
				for (const msg of messages) {
					const m = typeof msg === "object" && msg !== null ? msg : {};
					const role = typeof m["role"] === "string" ? m["role"] : "unknown";
					const content = Array.isArray(m["content"]) ? m["content"] : [];
					const thinking = content.filter((block) => block?.["type"] === "reasoning").map((block) => String(block["text"] ?? "")).join("\n");
					const calls = content.filter((block) => block?.["type"] === "tool-call");
					const images = content.filter((block) => block?.["type"] === "image").length;
					lines.push(`  - role: ${JSON.stringify(role)}`);
					if (thinking.length > 0) {
						lines.push("    thinking: |-");
						for (const line of thinking.split("\n")) lines.push(`      ${line}`);
					}
					lines.push("    text: |-");
					for (const line of PanelService.messageText(msg).split("\n")) lines.push(`      ${line}`);
					if (calls.length > 0) {
						const c = calls[0];
						lines.push("    toolCalls:");
						lines.push(`      - name: ${JSON.stringify(String(c["name"] ?? ""))}`);
						lines.push(`        arguments: ${JSON.stringify(String(c["arguments"] ?? ""))}`);
					}
					if (images > 0) lines.push(`    images: ${images}`);
				}
				await mkdir(dir, { recursive: true });
				await appendFile(path, `${["---", ...lines].join("\n")}\n`, "utf8");
				this.captureIndex.set(sessionId, request);
				this.captureWritten.set(sessionId, {
					path,
					updatedAt: Date.now(),
					messages: messages.length,
					requests: request
				});
			} catch (error) {
				this.ctx.logger?.warn("custom-first-control-prompt could not write the capture file: %s", error instanceof Error ? error.message : String(error));
			}
		}
		/**
		* Next document index for one conversation, derived by counting the
		* already-appended documents on the first capture after a restart.
		* @param sessionId - the session the capture belongs to.
		* @param path - the capture file.
		* @returns the 1-based index of the document about to be appended.
		*/
		async nextCaptureIndex(sessionId, path) {
			const cached = this.captureIndex.get(sessionId);
			if (cached !== void 0) return cached + 1;
			let existing = 0;
			try {
				const raw = await readFile(path, "utf8");
				existing = raw.split("\n").filter((line) => line.trim() === "---").length;
			} catch {
				existing = 0;
			}
			return existing + 1;
		}
		static messageText(msg) {
			const m = typeof msg === "object" && msg !== null ? msg : void 0;
			if (typeof m?.["content"] === "string") return m["content"];
			if (!Array.isArray(m?.["content"])) return "";
			return m["content"].map((block) => {
				if (typeof block === "string") return block;
				const b = typeof block === "object" && block !== null ? block : void 0;
				return b?.["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
			}).join("");
		}
		/** Read this conversation's capture switch and last written file. */
		captureGet(agent) {
			return this.captureView(String(agent.session.id));
		}
		/** Turn this conversation's capture file on or off. */
		captureSet(agent, enabled) {
			const sessionId = String(agent.session.id);
			this.captureEnabled.set(sessionId, enabled === true);
			return this.captureView(sessionId);
		}
		/** Clear the captured request ring. */
		requestsClear(agent) {
			this.ring.length = 0;
			this.seq = 0;
			return {
				requests: [],
				paused: this.paused,
				dockVisible: this.dockVisible,
				injectionEnabled: this.injectionEnabled,
				activeTemplate: this.activeTemplate
			};
		}
		/** Show or hide the composer dock strip. */
		uiSetDockVisible(agent, visible) {
			this.dockVisible = visible === true;
			return {
				requests: this.ring.slice(),
				paused: this.paused,
				dockVisible: this.dockVisible,
				injectionEnabled: this.injectionEnabled,
				activeTemplate: this.activeTemplate
			};
		}
		/** Assemble this plugin's live system-prompt sections for the preview tab. */
		async previewAssemble(agent) {
			const systemPrompt = this.ctx.get("systemPrompt");
			if (systemPrompt === void 0) return {
				sections: [],
				error: "systemPrompt service unavailable"
			};
			try {
				const assembly = await systemPrompt.assemble({});
				return { sections: (Array.isArray(assembly?.sections) ? assembly.sections : []).map((s) => ({
					name: typeof s.name === "string" ? s.name : "",
					text: typeof s.text === "string" ? s.text : "",
					order: typeof s.order === "number" ? s.order : 0
				})).filter((s) => s.name.indexOf("custom-first-control-prompt") === 0) };
			} catch (error) {
				return {
					sections: [],
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/** Resolve the template file path next to the profile patch file. */
		async templatePath() {
			const base = await this.patchPath();
			if (base === null) return null;
			const norm = base.replace(/\\/g, "/");
			const i = norm.lastIndexOf("/");
			if (i <= 0) return null;
			return `${norm.slice(0, i)}/cfcp-templates.json`;
		}
		/** Read and parse the template file; missing file = empty list (graceful). */
		async readTemplates() {
			const path = await this.templatePath();
			if (path === null) return [];
			const fs = this.ctx.get("fs");
			if (fs === void 0) return [];
			try {
				const target = await fs.resolve(path);
				const raw = await fs.readText(target);
				const parsed = JSON.parse(raw);
				return (Array.isArray(parsed.templates) ? parsed.templates : []).filter((t) => typeof t === "object" && t !== null && typeof t["name"] === "string" && Array.isArray(t["sections"]) && Array.isArray(t["history"]));
			} catch {
				return [];
			}
		}
		/** Write templates to the template file. */
		async writeTemplates(templates) {
			const path = await this.templatePath();
			if (path === null) return false;
			const fs = this.ctx.get("fs");
			if (fs === void 0) return false;
			try {
				const target = await fs.resolve(path);
				await fs.writeText(target, JSON.stringify({ templates }, void 0, 2), void 0, void 0, this.writePolicy());
				return true;
			} catch {
				return false;
			}
		}
		/** List saved templates. */
		async templateList(agent) {
			try {
				return {
					ok: true,
					templates: await this.readTemplates(),
					error: ""
				};
			} catch (error) {
				return {
					ok: false,
					templates: [],
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		/** Save the current config as a named template (overwrites if name exists). */
		async templateSave(agent, name, config) {
			const trimmed = typeof name === "string" ? name.trim() : "";
			if (trimmed.length === 0) return {
				ok: false,
				error: "template name is empty"
			};
			const filtered = (await this.readTemplates()).filter((t) => t.name !== trimmed);
			filtered.push({
				name: trimmed,
				sections: config.sections.map((s) => ({
					name: s.name,
					order: s.order,
					text: s.text,
					enabled: s.enabled
				})),
				history: config.history.map((p) => ({
					user: p.user,
					assistant: p.assistant,
					...(p.assistantThinking === void 0 ? {} : { assistantThinking: p.assistantThinking })
				})),
				includeSubagents: config.includeSubagents
			});
			const ok = await this.writeTemplates(filtered);
			return {
				ok,
				error: ok ? "" : "failed to write template file"
			};
		}
		/** Delete a named template. */
		async templateDelete(agent, name) {
			const trimmed = typeof name === "string" ? name.trim() : "";
			const templates = await this.readTemplates();
			const filtered = templates.filter((t) => t.name !== trimmed);
			if (filtered.length === templates.length) return {
				ok: true,
				error: ""
			};
			const ok = await this.writeTemplates(filtered);
			return {
				ok,
				error: ok ? "" : "failed to write template file"
			};
		}
		/** Apply a named template: write its config to the patch file and enable injection. */
		async templateApply(agent, name) {
			const trimmed = typeof name === "string" ? name.trim() : "";
			const found = (await this.readTemplates()).find((t) => t.name === trimmed);
			if (found === void 0) return {
				ok: false,
				path: "",
				error: `template "${trimmed}" not found`
			};
			const config = {
				found: true,
				sections: found.sections,
				history: found.history,
				includeSubagents: found.includeSubagents
			};
			const existing = await this.readPatch();
			const result = await this.writePatch(PanelService.mergeCoreBlock(existing.ok ? existing.raw : "", config));
			if (result.ok) {
				this.activeTemplate = trimmed;
				this.injectionEnabled = true;
			}
			return result;
		}
		/** Toggle the hot injection switch. */
		injectionToggle(agent, enabled) {
			this.injectionEnabled = enabled === true;
			return {
				requests: this.ring.slice(),
				paused: this.paused,
				dockVisible: this.dockVisible,
				injectionEnabled: this.injectionEnabled,
				activeTemplate: this.activeTemplate
			};
		}
	};
})();
//#endregion
//#region lib/types/index.js
/** Cordis plugin name, also the plugin attribution on the injected messages. */
const name = "custom-first-control-prompt";
/**
* Required services: the system-prompt registry for sections, plus `llm`
* (request redispatch) and `sessions` (subagent-origin filtering) for the
* request-path seed injection.
*/
const inject = [
	"systemPrompt",
	"llm",
	"sessions"
];
/** Cordis config schema; semantic checks beyond the schema run in {@link apply}. */
const Config = z.object({
	sections: z.array(z.object({
		name: z.string().required(),
		order: z.number().required(),
		enabled: z.boolean().default(true),
		text: z.string().required()
	})).default([]),
	history: z.array(z.object({
		user: z.string(),
		time: z.union([z.string(), z.number()]),
		userTime: z.union([z.string(), z.number()]),
		userImages: z.array(z.string()).default([]),
		assistant: z.string().required(),
		assistantTime: z.union([z.string(), z.number()]),
		assistantThinking: z.string(),
		toolCalls: z.array(z.object({
			id: z.string().required(),
			name: z.string().required(),
			arguments: z.string().required()
		})).default([]),
		toolResults: z.array(z.object({
			content: z.string().required(),
			isError: z.boolean().default(false),
			time: z.union([z.string(), z.number()]),
			images: z.array(z.string()).default([])
		})).default([])
	})),
	includeSubagents: z.boolean().default(false)
});
/**
* Partition configured sections into mountable entries and per-entry problems.
* A blank name, a duplicate name (first wins), a non-finite order, or an empty
* text is reported and skipped: the configuration is deployment-editable, so a
* bad entry must degrade to "not injected", never fail the plugin tree and take
* the whole deployment down with it.
* @param sections - configured section entries.
* @returns the mountable entries and the human-readable problems for the rest.
*/
function partitionSections(sections) {
	const clean = [];
	const problems = [];
	const seen = /* @__PURE__ */ new Set();
	for (const [index, section] of sections.entries()) {
		if (section.name.trim() === "") {
			problems.push(`sections[${index}].name is blank`);
			continue;
		}
		if (seen.has(section.name)) {
			problems.push(`sections[${index}] reuses name "${section.name}" (first entry wins)`);
			continue;
		}
		seen.add(section.name);
		if (!Number.isFinite(section.order)) {
			problems.push(`sections[${index}].order for "${section.name}" is not a finite number`);
			continue;
		}
		if (section.text.length === 0) {
			problems.push(`sections[${index}].text for "${section.name}" is empty`);
			continue;
		}
		clean.push(section);
	}
	return {
		clean,
		problems
	};
}
/**
* Describe why one reference-history pair must be skipped, or no value when the
* pair is usable.
* @param pair - a configured reference exchange.
* @returns the problem description, or no value when the pair is usable.
*/
function pairProblem(pair) {
	// 正文可以为空 —— 真实的纯工具调用步就没有可见文本；但整条都不能空：
	// 没有正文也没有调用时那条 assistant 消息没有任何内容块。
	const calls = Array.isArray(pair.toolCalls) ? pair.toolCalls : [];
	if (pair.assistant.length === 0 && calls.length === 0) return "assistant text is empty and no toolCalls are configured";
	if (pair.assistant.length > 0) {
		const lower = pair.assistant.toLowerCase();
		const tag = TRANSCRIPT_RESERVED_TAGS.find((reserved) => lower.includes(reserved));
		if (tag !== void 0) return `assistant text embeds reserved tag "${tag}"`;
	}
	// user 侧允许留空（留空 = 只注入 assistant 侧）；非空时照样查保留标签。
	if (typeof pair.user === "string" && pair.user.length > 0) {
		const lower = pair.user.toLowerCase();
		const tag = TRANSCRIPT_RESERVED_TAGS.find((reserved) => lower.includes(reserved));
		if (tag !== void 0) return `user text embeds reserved tag "${tag}"`;
	}
	const thinking = pair.assistantThinking;
	if (thinking !== void 0 && thinking.length > 0) {
		const lower = thinking.toLowerCase();
		const tag = TRANSCRIPT_RESERVED_TAGS.find((reserved) => lower.includes(reserved));
		if (tag !== void 0) return `assistantThinking embeds reserved tag "${tag}"`;
	}
	const results = Array.isArray(pair.toolResults) ? pair.toolResults : [];
	if (results.length > calls.length) return `toolResults has ${results.length} entr${results.length === 1 ? "y" : "ies"} but toolCalls has only ${calls.length}`;
	const seenIds = /* @__PURE__ */ new Set();
	for (const [i, call] of calls.entries()) {
		if (call.id.length === 0) return `toolCalls[${i}].id is empty`;
		if (seenIds.has(call.id)) return `toolCalls[${i}].id "${call.id}" is duplicated within the pair`;
		seenIds.add(call.id);
		if (call.name.length === 0) return `toolCalls[${i}].name is empty`;
		try {
			JSON.parse(call.arguments);
		} catch {
			return `toolCalls[${i}].arguments is not valid JSON`;
		}
		if (results[i] === void 0) return `toolCalls[${i}] has no matching toolResults[${i}] — a call without a result fails the provider request`;
	}
}
/**
* Partition configured history pairs into usable pairs and per-pair problems.
* Same degrade-instead-of-fail contract as {@link partitionSections}: an empty
* side or an embedded reserved exchange tag is skipped with a warning, so a
* bad pair never fails the plugin.
* @param pairs - configured reference exchanges.
* @returns the usable pairs and the human-readable problems for the rest.
*/
function partitionPairs(pairs) {
	const clean = [];
	const problems = [];
	for (const [index, pair] of pairs.entries()) {
		const problem = pairProblem(pair);
		if (problem === void 0) clean.push(pair);
		else problems.push(`history[${index}] ${problem}`);
	}
	return {
		clean,
		problems
	};
}
const SEED_IMAGE_MEDIA_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};
function seedImageMediaType(ref) {
	const clean = ref.split("?")[0].toLowerCase();
	const dot = clean.lastIndexOf(".");
	return dot === -1 ? void 0 : SEED_IMAGE_MEDIA_TYPES[clean.slice(dot)];
}
/**
* Resolve every configured image reference into a real image block.
*
* The harness carries images as durable attachment references, never as inline
* bytes, so each configured path (or `data:` URL) goes through the attachment
* store and yields a content-addressed reference the provider route can read.
* A missing service, an unreadable file, or a rejected raster costs that one
* image (with a warning), never the pair.
* @param ctx - plugin context, used for the attachment service and logging.
* @param pairs - usable reference exchanges.
* @returns the resolved image blocks keyed by configured reference.
*/
async function resolveSeedImages(ctx, pairs) {
	const refs = [];
	for (const pair of pairs) {
		for (const ref of pair.userImages ?? []) refs.push(ref);
		for (const result of pair.toolResults ?? []) for (const ref of result.images ?? []) refs.push(ref);
	}
	const unique = [...new Set(refs)];
	const resolved = /* @__PURE__ */ new Map();
	if (unique.length === 0) return resolved;
	const attachments = ctx.get("attachments");
	if (attachments === void 0) {
		ctx.logger.warn("custom-first-control-prompt: attachments service unavailable; %d configured image(s) stay text-only", unique.length);
		return resolved;
	}
	for (const ref of unique) try {
		let data;
		let mediaType;
		if (ref.startsWith("data:")) {
			const match = /^data:([^;,]+);base64,(.*)$/s.exec(ref);
			if (match === null) throw new Error("unsupported data: URL (expected data:<media-type>;base64,<data>)");
			mediaType = match[1];
			data = Buffer.from(match[2], "base64");
		} else {
			mediaType = seedImageMediaType(ref);
			if (mediaType === void 0) throw new Error("unsupported image extension (png/jpeg/webp/gif)");
			data = await readFile(ref);
		}
		if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) throw new Error(`unsupported media type ${mediaType}`);
		const name = ref.slice(Math.max(ref.lastIndexOf("/"), ref.lastIndexOf("\\")) + 1);
		const attachment = await attachments.saveImage({
			data,
			mediaType,
			name
		});
		resolved.set(ref, {
			type: "image",
			attachment
		});
	} catch (error) {
		ctx.logger.warn("skipping configured image %s: %s", ref, error instanceof Error ? error.message : String(error));
	}
	return resolved;
}
/**
* Split a request history into the leading system-role run and everything else.
*
* Since harness 0.1.5 the assembled system prompt no longer travels in
* `GenerateOptions.system`: the agent loop appends it to the session log as a
* `system/message` surface event, and the request carries it as the LEADING
* `system`-role entry of `options.messages` (dsh-agent-loop
* `runtime-context.ts` → `createSystemMessage`; the loop invariant states the
* prompt is surface node 0 "never as `system`"). A route without the new
* `systemPromptUpdate: 'in-history'` capability has only that leading entry
* read at all, and a provider that does read system entries mid-list treats
* the last one as the whole effective prompt — so the seed pair must be
* inserted AFTER the leading system run, never before it.
* @param messages - the request's ordered messages.
* @returns the leading system messages and the remaining ones.
*/
function splitLeadingSystemMessages(messages) {
	let end = 0;
	while (end < messages.length && messages[end]?.role === "system") end += 1;
	return {
		leading: messages.slice(0, end),
		rest: messages.slice(end)
	};
}
/** Last payload written per session, so a static configuration logs one record. */
const recordedSignatures = /* @__PURE__ */ new WeakMap();
/** `appendPluginRecord` ships with harness 0.2.x; an older harness keeps no record. */
const appendPluginRecord = typeof dshSession.appendPluginRecord === "function" ? dshSession.appendPluginRecord : void 0;
/**
 * Mirror the injected reference history into the session log as an ignorable
 * plugin record: it never enters the model-visible surface, never changes turn
 * numbering, and a log reader can still show what was prepended to each request.
 * @param session - the session whose log receives the record.
 * @param record - the injected history payload.
 */
function recordInjectedHistory(session, record) {
	if (appendPluginRecord === void 0) return;
	const signature = JSON.stringify(record);
	if (recordedSignatures.get(session) === signature) return;
	appendPluginRecord(session, "plugin:custom-first-control-prompt/injected", record);
	recordedSignatures.set(session, signature);
}
/**
* Register configured sections and install the request-path seed injection:
* a `llm/stream` waterfall listener that clones every ordinary conversation
* request with the prebuilt alternating seed messages inserted and
* redispatches it through `ctx.llm.stream`. The seed lands after the leading
* `system`-role run (0.1.5 carries the assembled system prompt there) and
* before the real conversation; see {@link splitLeadingSystemMessages}.
*
* Loop-built requests are deep-frozen and marker-tagged
* (`markAgentLoopRequest`), and the agent-loop invariant fails any marked
* request whose messages differ from `deriveMessages()` — so the original
* request object is never mutated. The clone carries no loop marker, the
* invariant does not apply to it, and the discarded original is a pure
* `deriveMessages()` projection (nothing unrecoverable is dropped). The seed
* messages never enter the session log: real turn numbering is untouched,
* forks stay ordinary copies, and compaction cannot shadow the reference
* history because it is re-injected on every request.
* @param ctx - plugin context.
* @param config - validated plugin configuration.
*/
function apply(ctx, config) {
	const panelService = new PanelService(ctx, {
		found: false,
		sections: (config.sections ?? []).map((section) => ({
			name: section.name,
			order: section.order,
			text: section.text,
			enabled: section.enabled !== false
		})),
		history: (config.history ?? []).map((pair) => ({
			user: pair.user,
			assistant: pair.assistant,
			...(pair.assistantThinking === void 0 ? {} : { assistantThinking: pair.assistantThinking }),
			...(pair.toolCalls === void 0 ? {} : { toolCalls: pair.toolCalls }),
			...(pair.toolResults === void 0 ? {} : { toolResults: pair.toolResults })
		})),
		includeSubagents: config.includeSubagents === true
	});
	const panel = panelService ?? ctx.get("custom-first-control-prompt-panel");
	const { clean: mountableSections, problems: sectionProblems } = partitionSections(config.sections ?? []);
	for (const problem of sectionProblems) ctx.logger.warn("skipping a configured section: %s", problem);
	for (const section of mountableSections) {
		if (section.enabled === false) continue;
		ctx.effect(() => ctx.systemPrompt.section({
			name: `${name}:${section.name}`,
			order: section.order,
			text: section.text
		}), `${name}.section(${section.name})`);
	}
	const history = config.history ?? [];
	const { clean: pairs, problems: pairProblems } = partitionPairs(history);
	for (const problem of pairProblems) ctx.logger.warn("skipping a configured reference-history pair: %s", problem);
	if (mountableSections.length === 0 && pairs.length === 0) return;
	// Configured images become durable attachments, which needs the async
	// store: seeds start image-less and are rebuilt once every reference
	// resolves, so activation never waits on disk I/O.
	const resolvedImages = /* @__PURE__ */ new Map();
	let seedMessages = buildSeedMessages(pairs, (ref) => resolvedImages.get(ref));
	resolveSeedImages(ctx, pairs).then((images) => {
		for (const [ref, block] of images) resolvedImages.set(ref, block);
		seedMessages = buildSeedMessages(pairs, (ref) => resolvedImages.get(ref));
	}).catch((error) => {
		ctx.logger.warn("custom-first-control-prompt could not resolve configured images: %s", error instanceof Error ? error.message : String(error));
	});
	const injectedRecord = {
		sections: mountableSections.map((section) => ({
			name: section.name,
			order: section.order,
			text: section.text,
			...(section.enabled === false ? { enabled: false } : {})
		})),
		history: pairs.map((pair) => ({
			// undefined 属性会让 session 的 JSON 快照整条拒绝（非无损序列化），
			// 所以每个可选字段都必须“有值才出现”。
			...(pair.user === void 0 ? {} : { user: pair.user }),
			...(pair.time === void 0 ? {} : { time: pair.time }),
			...(pair.userTime === void 0 ? {} : { userTime: pair.userTime }),
			...(pair.userImages === void 0 || pair.userImages.length === 0 ? {} : { userImages: pair.userImages }),
			assistant: pair.assistant,
			...(pair.assistantTime === void 0 ? {} : { assistantTime: pair.assistantTime }),
			...(pair.assistantThinking === void 0 ? {} : { assistantThinking: pair.assistantThinking }),
			...(pair.toolCalls === void 0 || pair.toolCalls.length === 0 ? {} : { toolCalls: pair.toolCalls }),
			...(pair.toolResults === void 0 || pair.toolResults.length === 0 ? {} : { toolResults: pair.toolResults })
		})),
		includeSubagents: config.includeSubagents === true
	};
	const reentry = /* @__PURE__ */ new WeakSet();
	ctx.on("llm/stream", (options, next) => {
		if (reentry.has(options)) {
			reentry.delete(options);
			return next();
		}
		if (panel !== void 0 && !panel.injectionEnabled) return next();
		if (options.purpose !== void 0) return next();
		const sessionId = options.sessionId;
		if (sessionId === void 0) return next();
		if (config.includeSubagents !== true && ctx.sessions.get(sessionId)?.header.origin === "subagent") return next();
		const session = ctx.sessions.get(sessionId);
		if (panel !== void 0) {
			const cloned = {
				...options,
				messages: [...options.messages]
			};
			void panel.captureRequest(String(sessionId), cloned);
		}
		if (session !== void 0) try {
			recordInjectedHistory(session, injectedRecord);
		} catch (error) {
			ctx.logger.warn("custom-first-control-prompt could not record the effective configuration: %s", error instanceof Error ? error.message : String(error));
		}
		if (seedMessages.length === 0) return next();
		const { leading, rest } = splitLeadingSystemMessages(options.messages);
		const cloned = {
			...options,
			messages: [...leading, ...seedMessages, ...rest]
		};
		reentry.add(cloned);
		return ctx.llm.stream(cloned);
	}, { prepend: true });
}
/**
* No default export: the Loader's `unwrapExports` collapses a module with a
* default export onto `exports.default` (`exports.default ?? exports`), which
* would drop the named `Config` schema (and every other named export). Keep
* `name`, `inject`, `Config`, and `apply` as named exports so the full plugin
* object — schema included — survives the load path.
*/
//#endregion
export { Config, SEED_SOURCE, TRANSCRIPT_RESERVED_TAGS, apply, buildSeedMessages, inject, name, recordInjectedHistory };

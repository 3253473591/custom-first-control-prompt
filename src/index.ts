/**
 * Deployment-configured prompt prefix. Ordered system-prompt sections render
 * ahead of the deployment persona, and configured reference user/assistant
 * exchanges are injected into every ordinary conversation request as real
 * alternating messages: the `llm/stream` waterfall clones the request with
 * the prebuilt seed sequence prepended and redispatches it.
 *
 * No message is written to the session log, so real turn numbering is
 * untouched, forking stays clean, and compaction cannot shadow the reference
 * history. Instead, the injected history is mirrored into the log once per
 * session as an `ignorable` plugin record
 * (`plugin:custom-first-control-prompt/injected`), which never enters the
 * model-visible surface but lets a log reader such as dsh-session-yaml show
 * what was prepended. Static content renders byte-identically on every
 * request, preserving prefix-cache reuse.
 *
 * @module @wm-coders/dsh-custom-first-control-prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as dshSession from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { HistoryPair } from './seed.ts'
import { buildSeedMessages, TRANSCRIPT_RESERVED_TAGS } from './seed.ts'
import { PanelService } from './panel.ts'

export * from './seed.ts'

/** Cordis plugin name, also the plugin attribution on the injected messages. */
export const name = 'custom-first-control-prompt'

/**
 * Required services: the system-prompt registry for sections, plus `llm`
 * (request redispatch) and `sessions` (subagent-origin filtering) for the
 * request-path seed injection.
 */
export const inject = ['systemPrompt', 'llm', 'sessions']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Web panel management service: patch editing, request capture, previews. */
    'custom-first-control-prompt-panel': PanelService
  }
}

/** One named system-prompt fragment contributed among the shipped sections. */
export interface SectionEntry {
  /** Entry name; the registry sees `custom-first-control-prompt:<name>`. */
  name: string
  /** Render position among all sections; values below 0 prepend ahead of the persona. */
  order: number
  /** `false` keeps the entry in configuration without registering it. */
  enabled?: boolean
  /** Static section text; keep it free of volatile values such as timestamps. */
  text: string
}

/** Plugin configuration; see README for the full contract. */
export interface Config {
  /** Ordered system-prompt fragments; absent or empty registers nothing. */
  sections?: SectionEntry[]
  /** Reference exchanges injected ahead of every conversation request; absent or empty injects nothing. */
  history?: HistoryPair[]
  /** `false` skips sessions whose header marks subagent origin. */
  includeSubagents?: boolean
}

/** Cordis config schema; semantic checks beyond the schema run in {@link apply}. */
export const Config: z<Config> = z.object({
  sections: z.array(z.object({
    name: z.string().required(),
    order: z.number().required(),
    enabled: z.boolean().default(true),
    text: z.string().required(),
  })).default([]),
  history: z.array(z.object({
    // user 允许留空：留空即只注入 assistant 侧
    user: z.string(),
    assistant: z.string().required(),
    // Schemastery fields are optional unless `.required()` — an absent
    // assistantThinking passes through and simply injects no reasoning block.
    assistantThinking: z.string(),
    // Schemastery 会剥掉 schema 里没声明的字段：不在这里放行，
    // 配置里的 toolCalls / toolResults 会被静默丢弃。
    toolCalls: z.array(z.object({
      id: z.string().required(),
      name: z.string().required(),
      arguments: z.string().required(),
    })).default([]),
    toolResults: z.array(z.object({
      content: z.string().required(),
      isError: z.boolean().default(false),
    })).default([]),
  })),
  includeSubagents: z.boolean().default(false),
})

/**
 * One reference exchange as it reaches the model: the user side, the assistant
 * reply, and the optional reasoning / tool-call scaffolding carried with it.
 */
export interface InjectedExchange {
  user: string
  assistant: string
  assistantThinking?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  toolResults?: Array<{ content: string; isError: boolean }>
}

/** One registered system-prompt section, as configured. */
export interface InjectedSection {
  name: string
  order: number
  text: string
  enabled?: boolean
}

/**
 * Payload of the session-log record that mirrors the effective plugin
 * configuration. Every field is a valid `Config` field, so the payload can be
 * pasted back into a profile patch:
 *
 * ```yaml
 * - id: custom-first-control-prompt
 *   config:
 *     sections: [...]
 *     history: [...]
 * ```
 *
 * The record is `ignorable`: an older reader (or the model surface) never sees
 * it, while a log reader can show exactly what was applied.
 */
export interface InjectedConfigRecord {
  /** Registered system-prompt sections, invalid entries already filtered out. */
  sections: InjectedSection[]
  /** The reference exchanges prepended to every ordinary request. */
  history: InjectedExchange[]
  /** Whether subagent-originated sessions are injected too. */
  includeSubagents: boolean
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:custom-first-control-prompt/injected': InjectedConfigRecord
  }
}

/** Last payload written per session, so a static configuration logs one record. */
const recordedSignatures = new WeakMap<Session, string>()

/**
 * `appendPluginRecord` ships with harness 0.2.x; an older harness simply keeps
 * no record (reading it as a missing feature, never as a load failure).
 */
const appendPluginRecord = (dshSession as {
  appendPluginRecord?: (session: Session, type: string, data: unknown) => unknown
}).appendPluginRecord

/**
 * Mirror the effective plugin configuration into the session log.
 *
 * The record is an `ignorable` plugin record: it never enters the model-visible
 * surface, never changes turn numbering, and is carried along by fork/resume and
 * format migration on a best-effort basis. One record per session is enough for
 * a static configuration; a runtime edit (the panel writes the profile patch)
 * produces a new payload and therefore a new record.
 * @param session - the session whose log receives the record.
 * @param record - the effective configuration snapshot.
 */
export function recordInjectedHistory(session: Session, record: InjectedConfigRecord): void {
  if (appendPluginRecord === undefined) return
  const signature = JSON.stringify(record)
  if (recordedSignatures.get(session) === signature) return
  appendPluginRecord(session, 'plugin:custom-first-control-prompt/injected', record)
  recordedSignatures.set(session, signature)
}

/**
 * Partition configured sections into mountable entries and per-entry problems.
 * A blank name, a duplicate name (first wins), a non-finite order, or an empty
 * text is reported and skipped: the configuration is deployment-editable, so a
 * bad entry must degrade to "not injected", never fail the plugin tree and take
 * the whole deployment down with it.
 * @param sections - configured section entries.
 * @returns the mountable entries and the human-readable problems for the rest.
 */
function partitionSections(sections: readonly SectionEntry[]): { clean: SectionEntry[]; problems: string[] } {
  const clean: SectionEntry[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [index, section] of sections.entries()) {
    if (section.name.trim() === '') {
      problems.push(`sections[${index}].name is blank`)
      continue
    }
    if (seen.has(section.name)) {
      problems.push(`sections[${index}] reuses name "${section.name}" (first entry wins)`)
      continue
    }
    seen.add(section.name)
    if (!Number.isFinite(section.order)) {
      problems.push(`sections[${index}].order for "${section.name}" is not a finite number`)
      continue
    }
    if (section.text.length === 0) {
      problems.push(`sections[${index}].text for "${section.name}" is empty`)
      continue
    }
    clean.push(section)
  }
  return { clean, problems }
}

/**
 * Describe why one reference-history pair must be skipped, or no value when the
 * pair is usable.
 * @param pair - a configured reference exchange.
 * @returns the problem description, or no value when the pair is usable.
 */
function pairProblem(pair: HistoryPair): string | undefined {
  // assistant 侧仍必须非空：留空的话那条 assistant 消息只剩
  // reasoning / tool-call，正文位是空的。
  for (const [field, text] of [['assistant', pair.assistant]] as const) {
    if (text.length === 0) {
      return `${field} text is empty`
    }
    const lower = text.toLowerCase()
    const tag = TRANSCRIPT_RESERVED_TAGS.find(reserved => lower.includes(reserved))
    if (tag !== undefined) {
      return `${field} text embeds reserved tag "${tag}"`
    }
  }
  // The optional thinking side degrades on the same reserved-tag rule; an
  // empty or absent value is simply no thinking block, never a problem.
  const calls = pair.toolCalls ?? []
  const results = pair.toolResults ?? []
  if (results.length > calls.length) {
    return `toolResults has ${results.length} entr${results.length === 1 ? 'y' : 'ies'} but toolCalls has only ${calls.length}`
  }
  const seenIds = new Set<string>()
  for (const [i, call] of calls.entries()) {
    if (call.id.length === 0) return `toolCalls[${i}].id is empty`
    if (seenIds.has(call.id)) return `toolCalls[${i}].id "${call.id}" is duplicated within the pair`
    seenIds.add(call.id)
    if (call.name.length === 0) return `toolCalls[${i}].name is empty`
    try {
      JSON.parse(call.arguments)
    } catch {
      return `toolCalls[${i}].arguments is not valid JSON`
    }
    if (results[i] === undefined) {
      return `toolCalls[${i}] has no matching toolResults[${i}] — a call without a result fails the provider request`
    }
  }
  const thinking = pair.assistantThinking
  if (thinking !== undefined && thinking.length > 0) {
    const lower = thinking.toLowerCase()
    const tag = TRANSCRIPT_RESERVED_TAGS.find(reserved => lower.includes(reserved))
    if (tag !== undefined) {
      return `assistantThinking embeds reserved tag "${tag}"`
    }
  }
  return undefined
}

/**
 * Partition configured history pairs into usable pairs and per-pair problems.
 * Same degrade-instead-of-fail contract as {@link partitionSections}: an empty
 * side or an embedded reserved exchange tag is skipped with a warning, so a
 * bad pair never fails the plugin.
 * @param pairs - configured reference exchanges.
 * @returns the usable pairs and the human-readable problems for the rest.
 */
function partitionPairs(pairs: readonly HistoryPair[]): { clean: HistoryPair[]; problems: string[] } {
  const clean: HistoryPair[] = []
  const problems: string[] = []
  for (const [index, pair] of pairs.entries()) {
    const problem = pairProblem(pair)
    if (problem === undefined) {
      clean.push(pair)
    } else {
      problems.push(`history[${index}] ${problem}`)
    }
  }
  return { clean, problems }
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
function splitLeadingSystemMessages(messages: readonly Message[]): {
  leading: readonly Message[]
  rest: readonly Message[]
} {
  let end = 0
  while (end < messages.length && messages[end]?.role === 'system') end += 1
  return { leading: messages.slice(0, end), rest: messages.slice(end) }
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
export function apply(ctx: Context, config: Config): void {
  // The web panel service stays available even with no configured content:
  // it manages the patch entry and captures requests for the browser half.
  // The composed-config snapshot lets the panel show the bundle-layer defaults
  // while the profile patch still carries no row.
  new PanelService(ctx, {
    found: false,
    sections: (config.sections ?? []).map(section => ({
      name: section.name,
      order: section.order,
      text: section.text,
      enabled: section.enabled !== false,
    })),
    history: (config.history ?? []).map(pair => ({
      user: pair.user,
      assistant: pair.assistant,
      ...(pair.assistantThinking === undefined ? {} : { assistantThinking: pair.assistantThinking }),
      ...(pair.toolCalls === undefined ? {} : { toolCalls: pair.toolCalls }),
      ...(pair.toolResults === undefined ? {} : { toolResults: pair.toolResults }),
    })),
    includeSubagents: config.includeSubagents === true,
  })
  const panel = ctx.get('custom-first-control-prompt-panel') as PanelService | undefined
  const sections = config.sections ?? []
  const { clean: mountableSections, problems: sectionProblems } = partitionSections(sections)
  for (const problem of sectionProblems) ctx.logger.warn('skipping a configured section: %s', problem)
  for (const section of mountableSections) {
    if (section.enabled === false) continue
    ctx.effect(() => ctx.systemPrompt.section({
      name: `${name}:${section.name}`,
      order: section.order,
      text: section.text,
    }), `${name}.section(${section.name})`)
  }
  const history = config.history ?? []
  const { clean: pairs, problems: pairProblems } = partitionPairs(history)
  for (const problem of pairProblems) ctx.logger.warn('skipping a configured reference-history pair: %s', problem)
  if (mountableSections.length === 0 && pairs.length === 0) return
  const seedMessages = buildSeedMessages(pairs)
  // Mirror the effective configuration (not just the exchanges): every field is
  // a Config field, so a log reader can hand the record back as a profile patch
  // entry and this plugin's schema accepts it unchanged.
  const injectedRecord: InjectedConfigRecord = {
    sections: mountableSections.map(section => ({
      name: section.name,
      order: section.order,
      text: section.text,
      ...(section.enabled === false ? { enabled: false } : {}),
    })),
    history: pairs.map(pair => ({
      user: pair.user,
      assistant: pair.assistant,
      ...(pair.assistantThinking === undefined ? {} : { assistantThinking: pair.assistantThinking }),
      ...(pair.toolCalls === undefined || pair.toolCalls.length === 0 ? {} : { toolCalls: pair.toolCalls }),
      ...(pair.toolResults === undefined || pair.toolResults.length === 0 ? {} : { toolResults: pair.toolResults }),
    })),
    includeSubagents: config.includeSubagents === true,
  }
  // Reentry guard: the redispatched clone re-enters this waterfall; the
  // WeakSet marks it so it passes straight through instead of being
  // intercepted recursively. Keyed by request object identity — no teardown
  // bookkeeping, and entries vanish with the request.
  const reentry = new WeakSet<GenerateOptions>()
  ctx.on('llm/stream', (options, next) => {
    if (reentry.has(options)) {
      reentry.delete(options)
      return next()
    }
    // Hot injection toggle: when off, pass through without seeding.
    if (panel !== undefined && !panel.injectionEnabled) return next()
    // Ordinary conversation requests only: auxiliary calls (compaction,
    // session-title) carry `purpose`; hand-built calls carry no `sessionId`.
    if (options.purpose !== undefined) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined) return next()
    if (config.includeSubagents !== true
      && ctx.sessions.get(sessionId)?.header.origin === 'subagent') return next()
    // Mirror the effective configuration into the session log before the
    // request goes out: the record is ignorable, so the model surface is
    // untouched while a log reader can recover the configuration.
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) {
      try {
        recordInjectedHistory(session, injectedRecord)
      } catch (error) {
        ctx.logger.warn('custom-first-control-prompt could not record the effective configuration: %s',
          error instanceof Error ? error.message : String(error))
      }
    }
    // Sections-only configuration: the record is all this request needs.
    if (seedMessages.length === 0) return next()
    // The seed pair lands AFTER the leading system run (0.1.5 puts the
    // assembled system prompt there) and before the real conversation. With a
    // pre-0.1.5 harness the leading run is empty and this is the old behavior.
    const { leading, rest } = splitLeadingSystemMessages(options.messages)
    const cloned: GenerateOptions = {
      ...options,
      messages: [...leading, ...seedMessages, ...rest],
    }
    reentry.add(cloned)
    return ctx.llm.stream(cloned)
  }, { prepend: true })
}

/**
 * No default export: the Loader's `unwrapExports` collapses a module with a
 * default export onto `exports.default` (`exports.default ?? exports`), which
 * would drop the named `Config` schema (and every other named export). Keep
 * `name`, `inject`, `Config`, and `apply` as named exports so the full plugin
 * object — schema included — survives the load path.
 */

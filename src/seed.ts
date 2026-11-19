/**
 * Seed-message construction for custom-first-control-prompt: the request-path
 * alternating user/assistant sequence built once per plugin activation and
 * shared by every intercepted request.
 */
import {
  createToolResultMessage,
  createUserMessage,
  MessageId,
  ToolCallId,
  type ContentBlock,
  type Message,
} from '@deepseek-ai/dsh-llm'

/**
 * Deep-freeze a value in place with an iterative traversal, guarding cycles.
 * Inlined from dsh-util-values' implementation (dsh-llm's built output does
 * not re-export it): WeakSet cycle guard + explicit traversal queue, so later
 * mutation throws without imposing a call-stack depth cap. AbortSignal objects
 * are skipped: they are the request's live cancellation channel.
 * @param value - the value to freeze in place.
 * @returns the same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}

/** Plugin attribution carried by the injected assistant messages' `source`. */
export const SEED_SOURCE = 'custom-first-control-prompt'

/**
 * Exchange tags the injected texts may not contain case-insensitively. The
 * reference exchanges travel as plain message texts; embedding the tag
 * grammar would invite the model to re-parse (or forge) exchange markup that
 * no longer exists, so plugin load skips such texts with a warning instead.
 */
export const TRANSCRIPT_RESERVED_TAGS: readonly string[] = [
  '<custom-history',
  '</custom-history>',
  '<exchange>',
  '</exchange>',
  '<user>',
  '</user>',
  '<assistant>',
  '</assistant>',
]

/** One configured reference exchange between a user and the assistant. */
export interface HistoryPair {
  /**
   * User-side text of the exchange.
   *
   * 允许留空：为空时不注入那条 user 消息，只注入 assistant 侧
   * （reasoning → 正文 → tool-call）。适合"只示范一次调用、不需要提问"的场景。
   */
  user?: string
  /**
   * 用户侧时间戳：ISO-8601 文本（建议带偏移，如 `2026-11-19T20:15:03+08:00`）
   * 或 epoch 毫秒。model 可见：渲染成正文前的一行 `[YYYY-MM-DD HH:mm:ss ±HH:MM]`。
   * `userTime` 是同一字段的别名，两者都给时 `userTime` 优先。
   */
  time?: SeedTime
  /** 用户侧时间戳的显式名字（优先于 `time`）。 */
  userTime?: SeedTime
  /** 用户消息里附带的图片块：本地文件路径或 `data:` URL。 */
  userImages?: readonly string[]
  /** Assistant-side text of the exchange. */
  assistant: string
  /** Assistant 侧时间戳，渲染规则同 `time`。 */
  assistantTime?: SeedTime
  /**
   * Optional assistant-side chain-of-thought text. When present and
   * non-empty, the injected assistant message carries a `reasoning` block
   * ahead of its text block, so a reasoning-capable model sees the reference
   * thinking (providers concatenate `reasoning_content` into context on
   * tool-carrying requests) instead of only the visible answer.
   */
  assistantThinking?: string
  /**
   * 可选：assistant 正文之后追加的伪造工具调用。每条生成一个原生
   * `tool-call` 内容块 —— provider 报文里会变成真的 `tool_calls` 字段，
   * 模型看到的是"我自己发起过这次调用"。
   *
   * `id` 必须是常量字符串（建议 `seed-call-<条目号>-<调用号>`）：一旦每次
   * 请求都不同，前缀缓存从第一个变化的 token 起全部失效。
   * `arguments` 必须是合法 JSON 的**字符串**。
   */
  toolCalls?: SeedToolCall[]
  /**
   * 与 `toolCalls` 按索引一一配对的结果。每条生成一条独立的 `role:'user'`
   * 消息（`source.kind='tool'`，带配对 callId）。
   *
   * **必须与 toolCalls 等长**：只造调用不造结果，OpenAI 兼容 provider 直接 400。
   */
  toolResults?: SeedToolResult[]
}

/** 一条伪造的工具调用。 */
export interface SeedToolCall {
  /** 常量 call id，与 toolResults 同索引项配对。 */
  id: string
  /** 工具名，须与当前请求 `tools` 数组里的名字一致。 */
  name: string
  /** 原始 JSON 字符串，与模型真实产出的一致。 */
  arguments: string
}

/** A configured timestamp: ISO-8601 text (offset recommended) or epoch milliseconds. */
export type SeedTime = string | number

/** One configured tool result. */
export interface SeedToolResult {
  /** 结果正文（render 后的文本）。 */
  content: string
  /** 标记为失败结果。默认 false。 */
  isError?: boolean
  /** 结果时间戳，渲染规则同 {@link HistoryPair.time}。 */
  time?: SeedTime
  /** 结果里附带的图片块（本地文件路径或 `data:` URL），与真实工具输出一致。 */
  images?: readonly string[]
}

/** Resolve one configured image reference into a frozen image block, or undefined when unavailable. */
export type SeedImageResolver = (ref: string) => ContentBlock | undefined

const SEED_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function localOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

/**
 * Render a configured timestamp as `YYYY-MM-DD HH:mm:ss ±HH:MM`.
 *
 * ISO text keeps the wall clock and offset its author wrote (no silent
 * time-zone translation); epoch milliseconds render in the host's local time.
 * An unparsable value renders nothing, so a typo costs the stamp, never the pair.
 * @param value - configured timestamp.
 * @returns the formatted stamp, or undefined when absent or unparsable.
 */
export function formatSeedTime(value: SeedTime | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return undefined
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
      + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${localOffset(date)}`
  }
  const match = SEED_TIME_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const [, day, clock, seconds, rawOffset] = match
  const offset = rawOffset === undefined || rawOffset === 'Z'
    ? '+00:00'
    : rawOffset.includes(':') ? rawOffset : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`
  return `${day} ${clock}:${seconds ?? '00'} ${offset}`
}

/**
 * Prepend the model-visible timestamp line to one message text.
 * @param text - configured text, possibly empty.
 * @param value - configured timestamp.
 * @returns the stamped text, unchanged when no stamp parses.
 */
export function stampSeedText(text: string, value: SeedTime | undefined): string {
  const stamp = formatSeedTime(value)
  if (stamp === undefined) return text
  return text.length > 0 ? `[${stamp}]\n${text}` : `[${stamp}]`
}

function seedImages(refs: readonly string[] | undefined, resolve: SeedImageResolver | undefined): ContentBlock[] {
  if (refs === undefined || refs.length === 0 || resolve === undefined) return []
  const blocks: ContentBlock[] = []
  for (const ref of refs) {
    const block = resolve(ref)
    if (block !== undefined) blocks.push(block)
  }
  return blocks
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
 * the host's attachment store, so `读图` transcripts can carry real image blocks.
 * @param pairs - ordered reference exchanges.
 * @param resolveImage - resolves one image reference to an image block.
 * @returns the frozen alternating user/assistant message sequence.
 */
export function buildSeedMessages(
  pairs: readonly HistoryPair[],
  resolveImage?: SeedImageResolver,
): readonly Message[] {
  const messages: Message[] = []
  for (const [index, pair] of pairs.entries()) {
    // user 允许留空：为空时只注入 assistant 那一侧
    // （reasoning → 正文 → tool-call），不产生一条空文本的 user 消息。
    const userText = stampSeedText(pair.user ?? '', pair.userTime ?? pair.time)
    const userImages = seedImages(pair.userImages, resolveImage)
    if (userText.length > 0 || userImages.length > 0) {
      messages.push(createUserMessage({
        content: [
          ...(userText.length > 0 ? [{ type: 'text', text: userText } as const] : []),
          ...userImages,
        ],
        source: { kind: 'user' },
      }))
    }
    // Thinking block first (the reasoning channel opens before the visible
    // text, mirroring a real model turn). A step that only calls tools has no
    // visible text: the text block is then omitted rather than emitted empty.
    const assistantContent: ContentBlock[] = []
    if (pair.assistantThinking !== undefined && pair.assistantThinking.length > 0) {
      assistantContent.push({ type: 'reasoning', text: pair.assistantThinking })
    }
    const assistantText = stampSeedText(pair.assistant, pair.assistantTime)
    if (assistantText.length > 0) {
      assistantContent.push({ type: 'text', text: assistantText })
    }
    // 伪造的工具调用：原生 tool-call 块。放在 text 之后，与真实模型
    // 产出「先说话再调工具」的形状一致。
    for (const call of pair.toolCalls ?? []) {
      assistantContent.push({
        type: 'tool-call',
        id: ToolCallId(call.id),
        name: call.name,
        arguments: call.arguments,
      })
    }
    messages.push({
      id: MessageId(`${SEED_SOURCE}-intercept-${index}`),
      role: 'assistant',
      source: { kind: 'plugin', plugin: SEED_SOURCE },
      content: assistantContent,
    })
    // 每条调用后面必须紧跟一条 tool-result 消息（role:'user' + source.kind:'tool'）。
    // 只造调用不造结果，OpenAI 兼容 provider 会直接 400。
    for (const [callIndex, call] of (pair.toolCalls ?? []).entries()) {
      const result = pair.toolResults?.[callIndex]
      if (result === undefined) continue
      messages.push(createToolResultMessage({
        callId: ToolCallId(call.id),
        content: [
          { type: 'text', text: stampSeedText(result.content, result.time) },
          ...seedImages(result.images, resolveImage),
        ],
        isError: result.isError === true,
      }))
    }
  }
  return deepFreeze(messages)
}

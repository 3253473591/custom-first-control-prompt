#!/usr/bin/env node
/**
 * Convert one DeepSeek Harness session log (`session.v4.jsonl`) into
 * custom-first-control-prompt `history` YAML.
 *
 * The plugin seeds a request with real `Message` objects, so the faithful unit
 * is one assistant *step*: the reasoning + visible text + tool calls of one
 * model turn, followed by the results those calls produced. Timestamps come
 * from the log envelope (`time`, epoch ms) and render as the plugin's
 * model-visible `[YYYY-MM-DD HH:mm:ss ±HH:MM]` line; images referenced by
 * `tool/result` blocks are emitted as `images:` entries pointing into the
 * session's `media/` folder (content-addressed `sha256_<hash>.<ext>` files).
 *
 * Usage:
 *   node tools/session-jsonl-to-yaml.mjs <session.v4.jsonl> [options]
 *
 * Options:
 *   --turn <n>              only use this turn (default: the richest turn)
 *   --limit <k>             emit at most k pairs (default: 2)
 *   --steps <i,j,...>       explicit 0-based step indices inside the turn
 *   --with-images           require an image in the selected window
 *   --with-user             attach the turn's human ask even when the window starts mid-turn
 *   --media-dir <dir>       media folder (default: `<log dir>/media`)
 *   --max-chars <n>         truncate one result text to n chars (default: 0 = full)
 *   --out <file>            write the YAML here (default: stdout)
 *
 * @module @wm-coders/dsh-custom-first-control-prompt/tools/session-jsonl-to-yaml
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const logPath = args.find((arg) => !arg.startsWith('--'))
if (logPath === undefined) {
  console.error('usage: node tools/session-jsonl-to-yaml.mjs <session.v4.jsonl> [--turn N] [--limit K] [--with-images] [--media-dir DIR] [--max-chars N] [--out FILE]')
  process.exit(2)
}

function option(name, fallback) {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}

const limit = Number(option('limit', '2'))
const onlyTurn = option('turn', undefined) === undefined ? undefined : Number(option('turn'))
const withImages = args.includes('--with-images')
const withUser = args.includes('--with-user')
const explicitSteps = option('steps', undefined)?.split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value))
const mediaDir = option('media-dir', path.join(path.dirname(path.resolve(logPath)), 'media'))
const maxChars = Number(option('max-chars', '0'))
const outFile = option('out', undefined)

const records = fs.readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Render epoch milliseconds as `YYYY-MM-DDTHH:mm:ss±HH:MM` in this process's zone. */
function isoLocal(ms) {
  const date = new Date(ms)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    + `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

function textOfContent(content) {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function thinkingOfContent(content) {
  return content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('\n')
}

/** Map one image block to a file in the exported media folder. */
function imagePathOf(block) {
  const id = block?.attachment?.attachmentId
  if (typeof id !== 'string') return undefined
  const hash = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
  const extension = block.attachment.mediaType === 'image/jpeg' ? 'jpg' : (block.attachment.mediaType ?? 'image/png').split('/')[1]
  const candidate = path.join(mediaDir, `sha256_${hash}.${extension}`)
  if (fs.existsSync(candidate)) return candidate
  const fallback = path.join(mediaDir, `sha256_${hash}.png`)
  return fs.existsSync(fallback) ? fallback : undefined
}

function clip(text) {
  return maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

// ---- group the log into turns and steps -------------------------------------
/** Harness-injected notices that ride the user role but are not human asks. */
const NON_HUMAN_USER = /^(<|background job |Time sampled |Current runtime context|\[model changed)/

function isHumanAsk(record) {
  const text = textOfContent(record.data?.content ?? [])
  if (text.trim() === '') return false
  if (record.data?.source?.kind !== 'user') return false
  return !NON_HUMAN_USER.test(text.trim())
}

const turns = []
let currentTurn = undefined
let currentStep = undefined
for (const record of records) {
  if (record.type === 'turn/start') {
    currentTurn = { turn: record.data.turn, user: undefined, steps: [] }
    turns.push(currentTurn)
    currentStep = undefined
    continue
  }
  if (currentTurn === undefined) continue
  if (record.type === 'user/message') {
    // Keep the first human ask of the turn; tool notices and runtime-context
    // reminders share the user role but would make the seed read as noise.
    if (currentTurn.user === undefined && isHumanAsk(record)) {
      currentTurn.user = { text: textOfContent(record.data.content ?? []), time: record.time }
      const image = (record.data.content ?? []).find((block) => block.type === 'image')
      if (image !== undefined) currentTurn.user.images = [imagePathOf(image)].filter(Boolean)
    }
    continue
  }
  if (record.type === 'step/start') {
    currentStep = { step: record.data.step, assistant: [], results: [] }
    currentTurn.steps.push(currentStep)
    continue
  }
  if (currentStep === undefined) continue
  if (record.type === 'assistant/message') {
    currentStep.assistant.push({ time: record.time, message: record.data.message })
    continue
  }
  if (record.type === 'tool/result') {
    const message = record.data.message
    currentStep.results.push({
      time: record.time,
      callId: message.toolCallId,
      content: textOfContent(message.content ?? []),
      isError: message.isError === true,
      images: (message.content ?? []).filter((block) => block.type === 'image').map(imagePathOf).filter(Boolean),
    })
  }
}

// ---- pick the steps to emit -------------------------------------------------
function stepHasImage(step) {
  return step.results.some((result) => result.images.length > 0)
}

function stepCalls(step) {
  return step.assistant.flatMap((entry) => (entry.message.content ?? []).filter((block) => block.type === 'tool-call'))
}

const windowSize = Number.isFinite(limit) && limit > 0 ? limit : 2

/**
 * Score a window of steps the way the seed will actually look: visible text,
 * reasoning, tool calls and image results. The best window is the most
 * representative (and, with `--with-images`, must carry an image).
 */
function windowScore(steps) {
  let calls = 0
  let images = 0
  let texts = 0
  let thinking = 0
  for (const step of steps) {
    calls += stepCalls(step).length
    images += step.results.reduce((sum, result) => sum + result.images.length, 0)
    if (step.assistant.some((entry) => textOfContent(entry.message.content ?? []).length > 0)) texts += 1
    if (step.assistant.some((entry) => thinkingOfContent(entry.message.content ?? []).length > 0)) thinking += 1
  }
  return calls * 3 + images * 6 + texts + thinking * 2
}

const candidates = turns
  .filter((turn) => onlyTurn === undefined || turn.turn === onlyTurn)
  .map((turn) => ({ turn, score: windowScore(turn.steps) }))
  .sort((a, b) => b.score - a.score)

if (candidates.length === 0) {
  console.error('no turn matched the selection')
  process.exit(1)
}

const chosen = candidates[0].turn
// Only steps that actually produce content are usable as a seed pair.
const usableSteps = chosen.steps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => {
    const hasText = step.assistant.some((entry) => textOfContent(entry.message.content ?? []).length > 0)
    return hasText || stepCalls(step).length > 0
  })

let best = undefined
if (explicitSteps !== undefined && explicitSteps.length > 0) {
  const picked = explicitSteps
    .map(index => usableSteps.find(entry => entry.index === index))
    .filter(entry => entry !== undefined)
  if (picked.length === 0) {
    console.error('none of --steps matched a usable step')
    process.exit(1)
  }
  best = { window: picked, score: 0, startsTurn: picked[0].index === 0 }
} else {
  for (let i = 0; i + 1 <= usableSteps.length; i++) {
    const window = usableSteps.slice(i, i + windowSize)
    if (window.length === 0) continue
    if (withImages && !window.some(({ step }) => stepHasImage(step))) continue
    const score = windowScore(window.map(({ step }) => step))
    if (best === undefined || score > best.score) best = { window, score, startsTurn: window[0].index === 0 }
  }
}
if (best === undefined) {
  console.error('no window matched the selection (try without --with-images)')
  process.exit(1)
}
const windowSteps = best.window
const startsTurn = best.startsTurn

// ---- build the plugin pairs -------------------------------------------------
function yamlScalar(value) {
  return JSON.stringify(String(value))
}

const pairs = []
for (const [pairIndex, { step }] of windowSteps.entries()) {
  const pair = {}
  if (pairIndex === 0 && (startsTurn || withUser) && chosen.user !== undefined) {
    pair.time = isoLocal(chosen.user.time)
    pair.user = chosen.user.text
    if (chosen.user.images !== undefined && chosen.user.images.length > 0) pair.userImages = chosen.user.images
  }
  const assistantEntries = step.assistant
  const firstEntry = assistantEntries[0]
  if (firstEntry !== undefined) pair.assistantTime = isoLocal(firstEntry.time)
  const thinking = assistantEntries.map((entry) => thinkingOfContent(entry.message.content ?? [])).filter((text) => text.length > 0).join('\n')
  if (thinking.length > 0) pair.assistantThinking = clip(thinking)
  const text = assistantEntries.map((entry) => textOfContent(entry.message.content ?? [])).filter((value) => value.length > 0).join('\n')
  pair.assistant = clip(text)
  const calls = assistantEntries.flatMap((entry) => (entry.message.content ?? []).filter((block) => block.type === 'tool-call'))
  if (calls.length > 0) {
    pair.toolCalls = calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))
    const results = []
    for (const call of calls) {
      const result = step.results.find((candidate) => candidate.callId === call.id) ?? { content: '', isError: true, images: [], time: firstEntry?.time ?? Date.now() }
      const entry = { content: clip(result.content), isError: result.isError === true }
      if (result.time !== undefined) entry.time = isoLocal(result.time)
      if (result.images !== undefined && result.images.length > 0) entry.images = result.images
      results.push(entry)
    }
    pair.toolResults = results
  }
  pairs.push(pair)
}

// ---- render YAML ------------------------------------------------------------
const lines = ['- id: custom-first-control-prompt', '  config:', '    sections: []', '    history:']
for (const pair of pairs) {
  let first = true
  const lead = (key) => {
    const prefix = first ? '    - ' : '      '
    first = false
    return `${prefix}${key}`
  }
  if (pair.time !== undefined) lines.push(`${lead('time:')} ${yamlScalar(pair.time)}`)
  if (pair.user !== undefined) lines.push(`${lead('user:')} ${yamlScalar(pair.user)}`)
  if (pair.userImages !== undefined) lines.push(`${lead('userImages:')} [${pair.userImages.map(yamlScalar).join(', ')}]`)
  if (pair.assistantTime !== undefined) lines.push(`${lead('assistantTime:')} ${yamlScalar(pair.assistantTime)}`)
  lines.push(`${lead('assistant:')} ${yamlScalar(pair.assistant)}`)
  if (pair.assistantThinking !== undefined) lines.push(`      assistantThinking: ${yamlScalar(pair.assistantThinking)}`)
  if (pair.toolCalls !== undefined) {
    lines.push('      toolCalls:')
    for (const call of pair.toolCalls) {
      lines.push(`        - id: ${yamlScalar(call.id)}`)
      lines.push(`          name: ${yamlScalar(call.name)}`)
      lines.push(`          arguments: ${yamlScalar(call.arguments)}`)
    }
    lines.push('      toolResults:')
    for (const result of pair.toolResults) {
      lines.push(`        - content: ${yamlScalar(result.content)}`)
      lines.push(`          isError: ${result.isError === true ? 'true' : 'false'}`)
      if (result.time !== undefined) lines.push(`          time: ${yamlScalar(result.time)}`)
      if (result.images !== undefined) lines.push(`          images: [${result.images.map(yamlScalar).join(', ')}]`)
    }
  }
}
lines.push('    includeSubagents: false')
const yaml = `${lines.join('\n')}\n`

if (outFile === undefined) {
  process.stdout.write(yaml)
} else {
  fs.writeFileSync(outFile, yaml, 'utf8')
  const callCount = pairs.reduce((sum, pair) => sum + (pair.toolCalls?.length ?? 0), 0)
  const imageCount = pairs.reduce((sum, pair) => sum + (pair.toolResults ?? []).reduce((inner, result) => inner + (result.images?.length ?? 0), 0) + (pair.userImages?.length ?? 0), 0)
  console.error(`wrote ${outFile}: turn ${chosen.turn}, ${pairs.length} pair(s), ${callCount} tool call(s), ${imageCount} image(s)`)
}

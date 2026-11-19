#!/usr/bin/env node
/**
 * Compact a capture file written by an older build into the current format.
 *
 * Early builds wrote the whole message list into every request document, so a
 * long conversation repeated the same history dozens of times and carried no
 * per-message time. This tool merges every message into one ordered document
 * (first appearance wins, so each message appears exactly once and keeps the
 * time of the document that first showed it) and keeps the response documents.
 *
 * Usage:
 *   node tools/compact-capture.mjs <capture.yml>            # writes <capture>.compact
 *   node tools/compact-capture.mjs <capture.yml> --write    # replaces it (keeps a backup)
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Read one `|` block scalar body that follows a `key: |-` line. */
function readBlock(lines, startIndex, baseIndent) {
  const body = []
  let i = startIndex + 1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { body.push(''); i += 1; continue }
    const indent = line.length - line.trimStart().length
    if (indent <= baseIndent) break
    body.push(line.slice(baseIndent + 2))
    i += 1
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return { text: body.join('\n'), next: i }
}

/** Parse one `messages:` list from an older document. */
function parseMessages(lines, startIndex) {
  const messages = []
  let current = null
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]
    if (/^  - role: /.test(line)) {
      const role = line.replace(/^  - role: /, '').replace(/^"|"$/g, '')
      current = { role, text: '', thinking: '', toolCalls: [], images: 0 }
      messages.push(current)
      continue
    }
    if (current === null) {
      if (line.trim() === '') continue
      break
    }
    if (/^  \S/.test(line)) break
    if (/^    thinking: \|-/.test(line)) { const block = readBlock(lines, i, 4); current.thinking = block.text; i = block.next - 1; continue }
    if (/^    text: \|-/.test(line)) { const block = readBlock(lines, i, 4); current.text = block.text; i = block.next - 1; continue }
    if (/^    images: /.test(line)) { current.images = Number(line.replace(/^    images: /, '')) || 0; continue }
    if (/^      - name: /.test(line)) {
      current.toolCalls.push({ name: line.replace(/^      - name: /, '').replace(/^"|"$/g, ''), arguments: '' })
      continue
    }
    if (/^        arguments: /.test(line)) {
      const last = current.toolCalls[current.toolCalls.length - 1]
      if (last !== undefined) last.arguments = line.replace(/^        arguments: /, '')
      continue
    }
  }
  return messages
}

const path = process.argv[2]
const write = process.argv.includes('--write')
if (path === undefined) {
  console.error('usage: node tools/compact-capture.mjs <capture.yml> [--write]')
  process.exit(2)
}

const text = fs.readFileSync(path, 'utf8')
const docs = text.split(/^---$/m).map((part) => part.trim()).filter((part) => part !== '')
if (docs.length === 0) throw new Error('no documents found')

const seen = new Set()
const merged = []
const responses = []
let systemText = ''
let firstTime = ''

for (const doc of docs) {
  const lines = doc.split(/\r?\n/)
  const read = (name) => {
    const line = lines.find((candidate) => candidate.startsWith(`${name}: `))
    if (line === undefined) return ''
    return line.slice(name.length + 2).replace(/^"|"$/g, '')
  }
  const kind = read('kind') || 'request'
  const time = read('time') || read('updatedAt')
  if (time !== '' && firstTime === '') firstTime = time

  if (kind === 'response') {
    responses.push({ doc, time })
    continue
  }

  const sysAt = lines.findIndex((line) => /^system: \|-/.test(line))
  if (sysAt !== -1) {
    const block = readBlock(lines, sysAt, 0)
    if (block.text.length > 0) systemText = block.text
  }
  const msgAt = lines.findIndex((line) => /^messages:$/.test(line) || /^newMessages:$/.test(line))
  if (msgAt === -1) continue
  for (const message of parseMessages(lines, msgAt + 1)) {
    const key = sha256(`${message.role}\u0000${message.text}\u0000${message.thinking}\u0000${message.toolCalls.map((call) => call.name).join(',')}`)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...message, time })
  }
}

const out = [
  'format: 2',
  'kind: request',
  'request: 1',
  'sessionId: ""',
  `time: ${JSON.stringify(firstTime)}`,
  'previousMessages: 0',
  `totalMessages: ${merged.length}`,
  `systemSha256: ${JSON.stringify(sha256(systemText))}`,
]
if (systemText.length > 0) {
  out.push('system: |-')
  for (const line of systemText.split('\n')) out.push(`  ${line}`)
}
out.push('newMessages:')
for (const message of merged) {
  out.push('  - id: ""')
  out.push(`    role: ${JSON.stringify(message.role)}`)
  out.push(`    time: ${JSON.stringify(message.time)}`)
  if (message.thinking.length > 0) {
    out.push('    thinking: |-')
    for (const line of message.thinking.split('\n')) out.push(`      ${line}`)
  }
  if (message.text.length > 0) {
    out.push('    text: |-')
    for (const line of message.text.split('\n')) out.push(`      ${line}`)
  }
  if (message.toolCalls.length > 0) {
    out.push('    toolCalls:')
    for (const call of message.toolCalls) {
      out.push(`      - name: ${JSON.stringify(call.name)}`)
      out.push(`        arguments: ${JSON.stringify(call.arguments)}`)
    }
  }
  if (message.images > 0) out.push(`    images: ${message.images}`)
}

const chunks = [`---\n${out.join('\n')}`]
for (const response of responses) chunks.push(`---\n${response.doc.replace(/^format: 2\r?\n/m, '')}`)
const result = `${chunks.join('\n')}\n`

const target = write ? path : `${path}.compact`
if (write) fs.copyFileSync(path, `${path}.bak-precompact-${Date.now()}`)
fs.writeFileSync(target, result, 'utf8')
console.log(`wrote ${target}`)
console.log(`docs: ${docs.length} -> ${chunks.length} (1 request + ${responses.length} responses)`)
console.log(`unique messages: ${merged.length}`)
console.log(`bytes: ${text.length} -> ${result.length}`)

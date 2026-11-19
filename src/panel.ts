/**
 * Web panel management service for custom-first-control-prompt: reads and
 * writes this plugin's entry in the profile patch file, captures a bounded
 * ring of real model requests, and exposes the whole surface to the browser
 * half through Typert Remote methods.
 *
 * @module @wm-coders/dsh-custom-first-control-prompt/panel
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  PanelAssembleResult,
  PanelCaptureView,
  PanelConfigReadResult,
  PanelConfigView,
  PanelRequestView,
  PanelRequestsView,
  PanelTemplate,
  PanelTemplateListResult,
  PanelTemplateWriteResult,
  PanelWriteResult,
} from './panel-types.ts'

/** Minimal filesystem face the panel needs; the runtime fs service satisfies it. */
interface PanelFs {
  resolve(path: string): Promise<unknown>
  readText(target: unknown): Promise<string>
  writeText(target: unknown, content: string, expected?: unknown, signal?: unknown, sandboxPolicy?: unknown): Promise<unknown>
}

/** Minimal settings face: the provider's user-editable document path. */
interface PanelSettings {
  prepareDocument(): Promise<string | undefined>
}

/** Minimal profile face: the launched profile's own patch file (dsh >= 0.2). */
interface PanelProfileContext {
  patchPath: string
}

/** Minimal sandbox-policy face: per-call execution policy resolution. */
interface PanelSandboxPolicy {
  resolve(request?: { mode?: string }): unknown
}

/** Minimal system-prompt face: section assembly for the preview tab. */
interface PanelSystemPrompt {
  assemble(context?: object): Promise<{ sections: readonly { name?: unknown; text?: unknown; order?: unknown }[] }>
}

/** Service key: the client reaches these methods as `ctx.remote['custom-first-control-prompt-panel']`. */
export const PANEL_SERVICE_KEY = 'custom-first-control-prompt-panel'

/** The web panel management service. */
/** Incremental capture progress for one conversation. */
interface CaptureState {
  /** Number of the last request document written. */
  nextRequest: number
  /** How many leading messages the file already holds. */
  capturedCount: number
  /** Id of the last captured message, for prefix verification. */
  lastMessageId: string
  /** sha256 of the system prompt last written in full. */
  systemSha256: string
  /** sha256 of the last response text, to avoid repeating it as a message. */
  assistantSha256: string
}

export class PanelService extends TypertRemoteService {
  private readonly ring: PanelRequestView[] = []
  private seq = 0
  private paused = true
  private dockVisible = true
  /** Hot injection toggle; when false the llm/stream listener passes through. */
  injectionEnabled = true
  /** Name of the last applied template; empty when none. */
  activeTemplate = ''
  /** Composed plugin config snapshot, shown when the profile patch has no row. */
  private readonly effective: PanelConfigView | undefined
  /**
   * Per-session capture switch, keyed by session id. Absent means "capturing":
   * a new conversation starts capturing, and pausing only affects that one.
   */
  private readonly captureEnabled = new Map<string, boolean>()
  /** Last capture written per session, for the header button's tooltip/state. */
  private readonly captureWritten = new Map<string, { path: string; updatedAt: number; messages: number; requests: number }>()
  /** Next capture document index per session; derived from the file on first capture. */
  private readonly captureIndex = new Map<string, number>()
  /** Incremental capture progress per session. */
  private readonly captureState = new Map<string, CaptureState>()

  constructor(ctx: Context, effective?: PanelConfigView) {
    super(ctx, 'custom-first-control-prompt-panel')
    this.effective = effective
    ctx.on('llm/stream', (options: GenerateOptions, next) => {
      const stream = next()
      if (!this.paused) this.capture(options)
      return stream
    })
  }

  // ---- capture ----

  private capture(options: GenerateOptions): void {
    try {
      const record = options as GenerateOptions & Record<string, unknown>
      const entry: PanelRequestView = {
        id: ++this.seq,
        time: Date.now(),
        model: typeof record['model'] === 'string' ? record['model'] : '',
        provider: typeof record['provider'] === 'string' ? record['provider'] : '',
        system: typeof record['system'] === 'string' ? record['system'] : '',
        purpose: typeof record['purpose'] === 'string' ? record['purpose'] : '',
        messages: [],
      }
      const msgs = Array.isArray(record['messages']) ? record['messages'] : []
      entry.messages = msgs.map((msg: unknown) => {
        let text = ''
        const m = typeof msg === 'object' && msg !== null ? msg as Record<string, unknown> : undefined
        if (typeof m?.['content'] === 'string') text = m['content']
        else if (Array.isArray(m?.['content'])) {
          text = (m['content'] as unknown[]).map((block) => {
            if (typeof block === 'string') return block
            const b = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
            return b?.['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : ''
          }).join('')
        }
        return { role: typeof m?.['role'] === 'string' ? m['role'] : 'unknown', text }
      })
      this.ring.push(entry)
      if (this.ring.length > 30) this.ring.shift()
    } catch (error) {
      this.ctx.logger?.warn('custom-first-control-prompt panel request capture failed: %s', String(error))
    }
  }

  // ---- per-session capture files (the intermediate artifact) ----

  /** Directory holding one capture file per conversation, beside the profile patch. */
  private async captureDir(): Promise<string | null> {
    const patch = await this.patchPath()
    if (patch === null) return null
    const cut = patch.lastIndexOf('/')
    return cut > 0 ? `${patch.slice(0, cut)}/cfcp-captures` : null
  }

  private captureView(sessionId: string): PanelCaptureView {
    const written = this.captureWritten.get(sessionId)
    return {
      enabled: this.captureEnabled.get(sessionId) !== false,
      path: written?.path ?? '',
      updatedAt: written?.updatedAt ?? 0,
      messages: written?.messages ?? 0,
      requests: written?.requests ?? 0,
      error: '',
    }
  }

  /**
   * Write the new part of one conversation's request into its own capture file.
   *
   * The file is the intermediate artifact between a live conversation and a
   * reference-history patch: the effective prompt plus the ordered message
   * sequence, never a write into the profile patch. Documents are appended, and
   * only messages the file does not hold yet are written — the shared prefix of
   * consecutive requests would otherwise repeat the whole conversation in every
   * document. Each message carries the id it has in the session and the time it
   * was first observed.
   * @param sessionId - the session the request belongs to.
   * @param options - the request as the model will see it (seed-injected).
   * @returns completion after the file is written, or when capture is paused.
   */
  async captureRequest(sessionId: string, options: GenerateOptions): Promise<void> {
    if (this.captureEnabled.get(sessionId) === false) return
    const dir = await this.captureDir()
    if (dir === null) return
    try {
      const record = options as GenerateOptions & Record<string, unknown>
      const messages = Array.isArray(record['messages']) ? record['messages'] as unknown[] : []
      const path = `${dir}/${sessionId}.yml`
      const state = await this.readCaptureState(sessionId, path)
      const request = state.nextRequest + 1
      const now = new Date().toISOString()
      const systemText = messages
        .filter(msg => (msg as Record<string, unknown>)?.['role'] === 'system')
        .map(msg => PanelService.messageText(msg))
        .join('\n\n')
      const systemSha = PanelService.sha256(systemText)
      // The history is a prefix extension while the last captured message is still
      // in place; compaction or a changed seed rewrites it, which re-dumps once.
      const prefixHolds = state.capturedCount > 0
        && state.capturedCount <= messages.length
        && (state.lastMessageId === '' || PanelService.messageId(messages[state.capturedCount - 1]) === state.lastMessageId)
      const fresh = state.capturedCount === 0 || prefixHolds ? messages.slice(state.capturedCount) : messages
      const rewritten = state.capturedCount > 0 && !prefixHolds
      const lines: string[] = [
        'format: 2',
        'kind: request',
        `request: ${request}`,
        `sessionId: ${JSON.stringify(sessionId)}`,
        `time: ${JSON.stringify(now)}`,
        `previousMessages: ${rewritten ? 0 : state.capturedCount}`,
        `totalMessages: ${messages.length}`,
        `model: ${JSON.stringify(typeof record['model'] === 'string' ? record['model'] : '')}`,
        `provider: ${JSON.stringify(typeof record['provider'] === 'string' ? record['provider'] : '')}`,
        `purpose: ${JSON.stringify(typeof record['purpose'] === 'string' ? record['purpose'] : '')}`,
        `systemSha256: ${JSON.stringify(systemSha)}`,
      ]
      if (rewritten) lines.push('rewritten: true')
      if (systemSha !== state.systemSha256) {
        lines.push('system: |-')
        for (const line of systemText.split('\n')) lines.push(`  ${line}`)
      }
      if (fresh.length === 0) {
        lines.push('newMessages: []')
      } else {
        lines.push('newMessages:')
        for (const msg of fresh) {
          const m = typeof msg === 'object' && msg !== null ? msg as Record<string, unknown> : {}
          const content = Array.isArray(m['content']) ? m['content'] as unknown[] : []
          const role = typeof m['role'] === 'string' ? m['role'] : 'unknown'
          const text = PanelService.messageText(msg)
          const thinking = content
            .filter(block => (block as Record<string, unknown>)?.['type'] === 'reasoning')
            .map(block => String((block as Record<string, unknown>)['text'] ?? ''))
            .join('\n')
          const calls = content.filter(block => (block as Record<string, unknown>)?.['type'] === 'tool-call')
          const images = content.filter(block => (block as Record<string, unknown>)?.['type'] === 'image').length
          lines.push(`  - id: ${JSON.stringify(PanelService.messageId(msg))}`)
          lines.push(`    role: ${JSON.stringify(role)}`)
          lines.push(`    time: ${JSON.stringify(now)}`)
          // The response document already carries this assistant text and the time
          // the stream finished, so the diff only records that it was seen again.
          if (role === 'assistant' && state.assistantSha256.length > 0 && PanelService.sha256(text) === state.assistantSha256) {
            lines.push('    sameAsResponse: true')
            continue
          }
          if (thinking.length > 0) {
            lines.push('    thinking: |-')
            for (const line of thinking.split('\n')) lines.push(`      ${line}`)
          }
          if (text.length > 0) {
            lines.push('    text: |-')
            for (const line of text.split('\n')) lines.push(`      ${line}`)
          }
          if (calls.length > 0) {
            lines.push('    toolCalls:')
            for (const call of calls) {
              const c = call as Record<string, unknown>
              lines.push(`      - name: ${JSON.stringify(String(c['name'] ?? ''))}`)
              lines.push(`        arguments: ${JSON.stringify(String(c['arguments'] ?? ''))}`)
            }
          }
          if (images > 0) lines.push(`    images: ${images}`)
        }
      }
      await mkdir(dir, { recursive: true })
      await appendFile(path, `${['---', ...lines].join('\n')}\n`, 'utf8')
      const last = messages.length > 0 ? PanelService.messageId(messages[messages.length - 1]) : ''
      await this.writeCaptureState(sessionId, path, {
        nextRequest: request,
        capturedCount: messages.length,
        lastMessageId: last,
        systemSha256: systemSha,
        assistantSha256: state.assistantSha256,
      })
      this.captureIndex.set(sessionId, request)
      this.captureWritten.set(sessionId, { path, updatedAt: Date.now(), messages: messages.length, requests: request })
    } catch (error) {
      this.ctx.logger?.warn('custom-first-control-prompt could not write the capture file: %s',
        error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Read the incremental progress of one conversation, persisted beside its file
   * so a restart continues the sequence instead of re-dumping the history.
   * @param sessionId - the session the capture belongs to.
   * @param path - the capture file; the state lives at `<path>.state.json`.
   * @returns the stored state, or a fresh one.
   */
  private async readCaptureState(sessionId: string, path: string): Promise<CaptureState> {
    const memory = this.captureState.get(sessionId)
    if (memory !== undefined) return memory
    try {
      const parsed = JSON.parse(await readFile(`${path}.state.json`, 'utf8')) as Partial<CaptureState>
      const restored: CaptureState = {
        nextRequest: typeof parsed.nextRequest === 'number' ? parsed.nextRequest : 0,
        capturedCount: typeof parsed.capturedCount === 'number' ? parsed.capturedCount : 0,
        lastMessageId: typeof parsed.lastMessageId === 'string' ? parsed.lastMessageId : '',
        systemSha256: typeof parsed.systemSha256 === 'string' ? parsed.systemSha256 : '',
        assistantSha256: typeof parsed.assistantSha256 === 'string' ? parsed.assistantSha256 : '',
      }
      this.captureState.set(sessionId, restored)
      return restored
    } catch {
      const fresh: CaptureState = { nextRequest: 0, capturedCount: 0, lastMessageId: '', systemSha256: '', assistantSha256: '' }
      this.captureState.set(sessionId, fresh)
      return fresh
    }
  }

  /** Persist one conversation's capture progress. */
  private async writeCaptureState(sessionId: string, path: string, state: CaptureState): Promise<void> {
    this.captureState.set(sessionId, state)
    try {
      await writeFile(`${path}.state.json`, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.ctx.logger?.warn('custom-first-control-prompt could not persist the capture state: %s',
        error instanceof Error ? error.message : String(error))
    }
  }

  /** sha256 of a string, for prompt/response de-duplication. */
  private static sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
  }

  /** The session message id, when the message carries one. */
  private static messageId(msg: unknown): string {
    const m = typeof msg === 'object' && msg !== null ? msg as Record<string, unknown> : {}
    const id = m['id']
    return typeof id === 'string' ? id : ''
  }

  /**
   * Next document index for one conversation, derived by counting the
   * already-appended documents on the first capture after a restart.
   * @param sessionId - the session the capture belongs to.
   * @param path - the capture file.
   * @returns the 1-based index of the document about to be appended.
   */
  private async nextCaptureIndex(sessionId: string, path: string): Promise<number> {
    const cached = this.captureIndex.get(sessionId)
    if (cached !== undefined) return cached + 1
    let existing = 0
    try {
      const raw = await readFile(path, 'utf8')
      existing = raw.split('\n').filter(line => line.trim() === '---').length
    } catch {
      existing = 0
    }
    return existing + 1
  }

  private static messageText(msg: unknown): string {
    const m = typeof msg === 'object' && msg !== null ? msg as Record<string, unknown> : undefined
    if (typeof m?.['content'] === 'string') return m['content']
    if (!Array.isArray(m?.['content'])) return ''
    return (m['content'] as unknown[]).map((block) => {
      if (typeof block === 'string') return block
      const b = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined
      return b?.['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : ''
    }).join('')
  }

  // ---- response capture (the other half of the transcript) ----

  /** Buffered assistant output for one streamed response, keyed by block index. */
  private responseBlocks = new Map<number, { kind: 'text' | 'reasoning' | 'tool-call'; text: string; id: string; name: string; arguments: string }>()

  private responseSlot(index: number, kind: 'text' | 'reasoning' | 'tool-call'): { kind: 'text' | 'reasoning' | 'tool-call'; text: string; id: string; name: string; arguments: string } {
    const existing = this.responseBlocks.get(index)
    if (existing !== undefined && existing.kind === kind) return existing
    const created = { kind, text: '', id: '', name: '', arguments: '' }
    this.responseBlocks.set(index, created)
    return created
  }

  /**
   * Watch one streamed response and append it to the same capture file.
   *
   * A request-path capture can only ever hold the conversation up to that
   * request, so the assistant's answer to it would never appear. Tapping the
   * stream adds the missing half: each chunk is passed through untouched and,
   * when the stream settles abort or not, one `kind: response` document is
   * appended next to the request it answers.
   * @param sessionId - the session the response belongs to.
   * @param stream - the provider stream to observe.
   * @returns the same chunks, unchanged.
   */
  async *tapResponse<T>(sessionId: string, stream: AsyncIterable<T>): AsyncGenerator<T> {
    if (this.captureEnabled.get(sessionId) === false) {
      yield* stream
      return
    }
    this.responseBlocks = new Map()
    let finish = ''
    let complete = false
    try {
      for await (const chunk of stream) {
        this.collectResponseChunk(chunk, (value) => { finish = value })
        yield chunk
      }
      complete = true
    } finally {
      try {
        await this.appendResponse(sessionId, finish, complete)
      } catch (error) {
        this.ctx.logger?.warn('custom-first-control-prompt could not append the response capture: %s',
          error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** Fold one stream chunk into the response buffer. */
  private collectResponseChunk(chunk: unknown, onFinish: (reason: string) => void): void {
    const c = typeof chunk === 'object' && chunk !== null ? chunk as Record<string, unknown> : undefined
    if (c === undefined) return
    const type = typeof c['type'] === 'string' ? c['type'] : ''
    const index = typeof c['index'] === 'number' ? c['index'] : 0
    if (type === 'text-delta') {
      this.responseSlot(index, 'text').text += String(c['text'] ?? '')
    } else if (type === 'reasoning-delta') {
      this.responseSlot(index, 'reasoning').text += String(c['text'] ?? '')
    } else if (type === 'tool-call-delta') {
      const slot = this.responseSlot(index, 'tool-call')
      if (typeof c['id'] === 'string' && c['id'].length > 0) slot.id = c['id']
      if (typeof c['name'] === 'string' && c['name'].length > 0) slot.name = c['name']
      slot.arguments += String(c['argumentsDelta'] ?? '')
    } else if (type === 'block-end') {
      const block = typeof c['block'] === 'object' && c['block'] !== null ? c['block'] as Record<string, unknown> : undefined
      if (block !== undefined && block['type'] === 'text') {
        const slot = this.responseSlot(index, 'text')
        if (typeof block['text'] === 'string' && block['text'].length > 0) slot.text = block['text']
      } else if (block !== undefined && block['type'] === 'reasoning') {
        const slot = this.responseSlot(index, 'reasoning')
        if (typeof block['text'] === 'string' && block['text'].length > 0) slot.text = block['text']
      } else if (block !== undefined && block['type'] === 'tool-call') {
        const slot = this.responseSlot(index, 'tool-call')
        if (typeof block['id'] === 'string') slot.id = block['id']
        if (typeof block['name'] === 'string') slot.name = block['name']
        if (typeof block['arguments'] === 'string') slot.arguments = block['arguments']
      }
    } else if (type === 'finish') {
      const reason = c['reason']
      if (typeof reason === 'object' && reason !== null && typeof (reason as Record<string, unknown>)['kind'] === 'string') {
        onFinish(String((reason as Record<string, unknown>)['kind']))
      } else if (typeof reason === 'string') {
        onFinish(reason)
      }
    }
  }

  /** Append the buffered assistant message as one `kind: response` document. */
  private async appendResponse(sessionId: string, finish: string, complete: boolean): Promise<void> {
    if (this.captureEnabled.get(sessionId) === false) return
    const slots = [...this.responseBlocks.values()].filter(slot => slot.text.length > 0 || slot.name.length > 0)
    if (slots.length === 0) return
    const dir = await this.captureDir()
    if (dir === null) return
    const path = `${dir}/${sessionId}.yml`
    const request = this.captureWritten.get(sessionId)?.requests ?? 0
    const now = new Date().toISOString()
    const assistantText = slots.filter(slot => slot.kind === 'text').map(slot => slot.text).join('')
    const lines: string[] = [
      'format: 2',
      'kind: response',
      `sessionId: ${JSON.stringify(sessionId)}`,
      `request: ${request}`,
      `time: ${JSON.stringify(now)}`,
      `finish: ${JSON.stringify(finish)}`,
      `complete: ${complete ? 'true' : 'false'}`,
      `assistantSha256: ${JSON.stringify(PanelService.sha256(assistantText))}`,
    ]
    const thinking = slots.filter(slot => slot.kind === 'reasoning').map(slot => slot.text).join('\n')
    const text = slots.filter(slot => slot.kind === 'text').map(slot => slot.text).join('')
    const calls = slots.filter(slot => slot.kind === 'tool-call')
    if (thinking.length > 0) {
      lines.push('thinking: |-')
      for (const line of thinking.split('\n')) lines.push(`  ${line}`)
    }
    lines.push('assistant: |-')
    for (const line of text.split('\n')) lines.push(`  ${line}`)
    if (calls.length > 0) {
      lines.push('toolCalls:')
      for (const call of calls) {
        lines.push(`  - name: ${JSON.stringify(call.name)}`)
        lines.push(`    arguments: ${JSON.stringify(call.arguments)}`)
      }
    }
    await mkdir(dir, { recursive: true })
    await appendFile(path, `${['---', ...lines].join('\n')}\n`, 'utf8')
    const state = await this.readCaptureState(sessionId, path)
    await this.writeCaptureState(sessionId, path, { ...state, assistantSha256: PanelService.sha256(assistantText) })
    const written = this.captureWritten.get(sessionId)
    if (written !== undefined) this.captureWritten.set(sessionId, { ...written, updatedAt: Date.now() })
  }

  // ---- patch file plumbing ----

  private async patchPath(): Promise<string | null> {
    // dsh >= 0.2 exposes the launched profile itself; prefer it over string surgery.
    const profileContext = this.ctx.get('profileContext') as PanelProfileContext | undefined
    if (profileContext !== undefined && typeof profileContext.patchPath === 'string' && profileContext.patchPath.length > 0) {
      return profileContext.patchPath.replace(/\\/g, '/')
    }
    const settings = this.ctx.get('settings') as PanelSettings | undefined
    if (settings !== undefined) {
      try {
        const doc = await settings.prepareDocument()
        if (typeof doc === 'string' && doc.length > 0) {
          const norm = doc.replace(/\\/g, '/')
          // 0.2.x hands back the profile patch file itself; 0.1.x handed back settings.yaml.
          if (/\/cordis\.patch\.ya?ml$/i.test(norm)) return norm
          const i = norm.lastIndexOf('/')
          if (i > 0) return `${norm.slice(0, i)}/profiles/web/cordis.patch.yml`
        }
      } catch {
        // fall through to the explicit failure below
      }
    }
    return null
  }

  private writePolicy(): unknown {
    const policy = this.ctx.get('sandboxPolicy') as PanelSandboxPolicy | undefined
    try {
      return policy?.resolve({ mode: 'danger-full-access' })
    } catch {
      return undefined
    }
  }

  private static yamlUnquote(value: string): string {
    let s = value.trim()
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1)
    else if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") s = s.slice(1, -1)
    return s.replace(/\\\\/g, '\u0000').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\u0000/g, '\\')
  }

  private static yamlScalar(value: string): string {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`
  }

  /** Render a list of image references as a YAML flow sequence of scalars. */
  private static yamlList(values: readonly string[]): string {
    return `[${values.map(value => PanelService.yamlScalar(value)).join(', ')}]`
  }

  /** Parse a YAML flow sequence of scalars (`["a", "b"]`); a bare scalar yields one entry. */
  private static parseInlineList(value: string): string[] {
    const raw = value.trim()
    const out: string[] = []
    if (raw.length === 0) return out
    if (!(raw.startsWith('[') && raw.endsWith(']'))) {
      const single = PanelService.yamlUnquote(raw)
      return single.length > 0 ? [single] : out
    }
    const inner = raw.slice(1, -1)
    let current = ''
    let quoted = false
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!
      if (ch === '\\' && quoted && i + 1 < inner.length) {
        current += ch + inner[i + 1]!
        i += 1
        continue
      }
      if (ch === '"') {
        quoted = !quoted
        current += ch
        continue
      }
      if (ch === ',' && !quoted) {
        const entry = PanelService.yamlUnquote(current)
        if (entry.length > 0) out.push(entry)
        current = ''
        continue
      }
      current += ch
    }
    const last = PanelService.yamlUnquote(current)
    if (last.length > 0) out.push(last)
    return out
  }

  /**
   * Expand YAML block scalars into inline scalars.
   *
   * The panel's patch reader is a line scanner over known fields, so a value
   * written as a block scalar (`|-`, `|+`, `>`, with optional indentation
   * indicators) would otherwise be read as the literal header text and its body
   * lines dropped. Rewriting each block into the quoted single-line form the
   * scanner already understands keeps one parser for both syntaxes.
   * @param raw - patch file text.
   * @returns the same text with every block scalar folded into a quoted scalar.
   */
  private static expandBlockScalars(raw: string): string {
    const lines = raw.split(/\r?\n/)
    const out: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const match = /^(\s*(?:-\s+)?[A-Za-z0-9_.-]+\s*:\s*)([|>])([+-]?)([1-9])?\s*$/.exec(line)
      if (match === null) {
        out.push(line)
        continue
      }
      const style = match[2] === '>' ? 'folded' : 'literal'
      const chomp = match[3] ?? ''
      const explicit = match[4] === undefined ? undefined : Number(match[4])
      const block = PanelService.readBlockScalar(lines, i, style, chomp, explicit)
      out.push(`${match[1]}${PanelService.yamlScalar(block.text)}`)
      i = block.next - 1
    }
    return out.join('\n')
  }

  /**
   * Read one block-scalar body starting at its header line.
   * @param lines - patch file lines.
   * @param headerIndex - index of the `key: |-` line.
   * @param style - literal (`|`) or folded (`>`).
   * @param chomp - chomping indicator: '', '-' (strip), '+' (keep).
   * @param explicitIndent - an explicit indentation indicator, when given.
   * @returns the scalar text and the index of the first line after the block.
   */
  private static readBlockScalar(
    lines: readonly string[],
    headerIndex: number,
    style: 'literal' | 'folded',
    chomp: string,
    explicitIndent: number | undefined,
  ): { text: string; next: number } {
    const body: string[] = []
    let indent = explicitIndent
    let i = headerIndex + 1
    for (; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') {
        body.push('')
        continue
      }
      const leading = line.length - line.trimStart().length
      if (indent === undefined) {
        if (leading === 0) break
        indent = leading
      } else if (leading < indent) {
        break
      }
      body.push(line.slice(indent))
    }
    // trailing blank lines are chomping material, never content
    let trailing = 0
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop()
      trailing += 1
    }
    const text = style === 'folded' ? PanelService.foldBlock(body) : body.join('\n')
    if (text.length === 0) return { text: '', next: i }
    if (chomp === '-') return { text, next: i }
    if (chomp === '+') return { text: text + '\n'.repeat(trailing + 1), next: i }
    return { text: `${text}\n`, next: i }
  }

  /** Fold block lines the way a `>` scalar does: newlines become spaces, blank lines become newlines. */
  private static foldBlock(body: readonly string[]): string {
    let out = ''
    let pendingBreak = false
    for (const line of body) {
      if (line === '') {
        pendingBreak = true
        out += '\n'
        continue
      }
      if (out.length > 0 && !out.endsWith('\n')) out += ' '
      out += line
      pendingBreak = false
    }
    return out
  }

  private static parseBlock(rawInput: string): PanelConfigView {
    const raw = PanelService.expandBlockScalars(rawInput)
    const out: PanelConfigView = { found: false, sections: [], history: [], includeSubagents: false }
    if (raw.indexOf('custom-first-control-prompt') < 0) return out
    out.found = true
    let zone: '' | 'sections' | 'history' = ''
    let cur: PanelConfigView['sections'][number] | PanelConfigView['history'][number] | null = null
    // toolCalls / toolResults 是嵌套数组，逐行扫描需要独立的子状态
    let sub: '' | 'calls' | 'results' = ''
    let curCall: { id: string; name: string; arguments: string } | null = null
    let curResult: { content: string; isError?: boolean } | null = null
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (t.indexOf('sections:') === 0) { zone = 'sections'; cur = null; continue }
      if (t.indexOf('history:') === 0) { zone = 'history'; cur = null; continue }
      if (t.indexOf('includeSubagents:') === 0) { zone = ''; cur = null }
      if (zone === 'sections') {
        if (t.indexOf('- name:') === 0) {
          cur = { name: PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1)), order: 0, text: '', enabled: true }
          out.sections.push(cur)
        } else if (cur !== null && 'name' in cur && t.indexOf('order:') === 0) {
          cur.order = Number(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'name' in cur && t.indexOf('text:') === 0) {
          cur.text = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        }
      } else if (zone === 'history') {
        // 一条参考对话的起始字段：用户侧为空时序列化出来可能以 assistant 字段打头，
        // 所以任何这些 "- <field>:" 行都要开启新条目，而不是并进上一条。
        const startsPair = t.indexOf('- time:') === 0
          || t.indexOf('- user:') === 0
          || t.indexOf('- userImages:') === 0
          || t.indexOf('- assistant:') === 0
          || t.indexOf('- assistantTime:') === 0
          || t.indexOf('- assistantThinking:') === 0
        if (startsPair) {
          cur = { assistant: '' }
          out.history.push(cur)
          sub = ''
          curCall = null
          curResult = null
        }
        if (cur !== null && t.indexOf('- time:') === 0) {
          cur.time = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && t.indexOf('- user:') === 0) {
          cur.user = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && t.indexOf('- userImages:') === 0) {
          cur.userImages = PanelService.parseInlineList(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('user:') === 0 && !t.startsWith('-')) {
          cur.user = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && sub === '' && t.indexOf('time:') === 0) {
          cur.time = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('userTime:') === 0) {
          cur.userTime = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('userImages:') === 0) {
          cur.userImages = PanelService.parseInlineList(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('assistantTime:') === 0) {
          cur.assistantTime = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('- assistantTime:') === 0) {
          cur.assistantTime = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('assistantThinking:') === 0) {
          cur.assistantThinking = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('- assistantThinking:') === 0) {
          cur.assistantThinking = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('- assistant:') === 0) {
          cur.assistant = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('assistant:') === 0) {
          cur.assistant = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && 'assistant' in cur && t.indexOf('toolCalls:') === 0) {
          cur.toolCalls = []
          sub = 'calls'
          curCall = null
        } else if (cur !== null && 'assistant' in cur && t.indexOf('toolResults:') === 0) {
          cur.toolResults = []
          sub = 'results'
          curResult = null
        } else if (cur !== null && sub === 'calls' && t.indexOf('- id:') === 0) {
          curCall = { id: PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1)), name: '', arguments: '' }
          cur.toolCalls!.push(curCall)
        } else if (cur !== null && sub === 'calls' && curCall !== null && t.indexOf('name:') === 0) {
          curCall.name = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && sub === 'calls' && curCall !== null && t.indexOf('arguments:') === 0) {
          curCall.arguments = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && sub === 'results' && t.indexOf('- content:') === 0) {
          curResult = { content: PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1)), isError: false }
          cur.toolResults!.push(curResult)
        } else if (cur !== null && sub === 'results' && curResult !== null && t.indexOf('time:') === 0) {
          curResult.time = PanelService.yamlUnquote(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && sub === 'results' && curResult !== null && t.indexOf('images:') === 0) {
          curResult.images = PanelService.parseInlineList(t.slice(t.indexOf(':') + 1))
        } else if (cur !== null && sub === 'results' && curResult !== null && t.indexOf('isError:') === 0) {
          curResult.isError = t.slice(t.indexOf(':') + 1).trim() === 'true'
        }
      } else if (zone === '') {
        const m = t.match(/^includeSubagents:\s*(true|false)/)
        if (m) out.includeSubagents = m[1] === 'true'
      }
    }
    return out
  }

  /**
   * Render one history pair as YAML, including forged tool calls.
   *
   * Extracted so the two indent variants (core row / profile override) cannot
   * drift apart: they differ only in the leading blank string.
   *
   * @param p - the pair to render.
   * @param itemIndent - indent of the `- user:` item line.
   * @param fieldIndent - indent of the `assistant:` / `toolCalls:` lines.
   * @returns the rendered block, one pair.
   */
  private static pairBlock(p: PanelPairView, itemIndent: string, fieldIndent: string): string {
    const userText = typeof p.user === 'string' ? p.user : ''
    const stamp = p.userTime ?? p.time
    // `- time:` 打头让时间最显眼；没有 user 文本时也能单独承载时间
    let block = `${itemIndent}- `
    if (stamp !== undefined && String(stamp).length > 0) {
      block += `time: ${PanelService.yamlScalar(String(stamp))}\n${fieldIndent}user: ${PanelService.yamlScalar(userText)}`
    } else {
      block += `user: ${PanelService.yamlScalar(userText)}`
    }
    if (p.userImages !== undefined && p.userImages.length > 0) {
      block += `\n${fieldIndent}userImages: ${PanelService.yamlList(p.userImages)}`
    }
    if (p.assistantTime !== undefined && String(p.assistantTime).length > 0) {
      block += `\n${fieldIndent}assistantTime: ${PanelService.yamlScalar(String(p.assistantTime))}`
    }
    block += `\n${fieldIndent}assistant: ${PanelService.yamlScalar(p.assistant)}`
    if (p.assistantThinking !== undefined && p.assistantThinking.length > 0) {
      block += `\n${fieldIndent}assistantThinking: ${PanelService.yamlScalar(p.assistantThinking)}`
    }
    const calls = p.toolCalls ?? []
    const results = p.toolResults ?? []
    if (calls.length > 0) {
      const callItemIndent = `${fieldIndent}  `
      const callFieldIndent = `${callItemIndent}  `
      block += `\n${fieldIndent}toolCalls:`
      for (const c of calls) {
        block += `\n${callItemIndent}- id: ${PanelService.yamlScalar(c.id)}`
          + `\n${callFieldIndent}name: ${PanelService.yamlScalar(c.name)}`
          + `\n${callFieldIndent}arguments: ${PanelService.yamlScalar(c.arguments)}`
      }
      // 只渲染能配对的部分：多出来的结果不会被注入，写出去只会误导
      const pairs = Math.min(calls.length, results.length)
      if (pairs > 0) {
        block += `\n${fieldIndent}toolResults:`
        for (let i = 0; i < pairs; i++) {
          const result = results[i]!
          block += `\n${callItemIndent}- content: ${PanelService.yamlScalar(result.content)}`
            + `\n${callFieldIndent}isError: ${result.isError === true ? 'true' : 'false'}`
          if (result.time !== undefined && String(result.time).length > 0) {
            block += `\n${callFieldIndent}time: ${PanelService.yamlScalar(String(result.time))}`
          }
          if (result.images !== undefined && result.images.length > 0) {
            block += `\n${callFieldIndent}images: ${PanelService.yamlList(result.images)}`
          }
        }
      }
    }
    return block
  }

  /** Render just the core `custom-first-control-prompt` loader row (4-space indent block). */
  private static coreBlock(config: PanelConfigView | undefined): string {
    const sections = Array.isArray(config?.sections) ? config.sections : []
    const history = Array.isArray(config?.history) ? config.history : []
    const includeSubagents = config?.includeSubagents === true
    const secBlock = sections.length > 0
      ? sections.map(s => `          - name: ${PanelService.yamlScalar(s.name)}\n            order: ${Number(s.order) || 0}\n            text: ${PanelService.yamlScalar(s.text)}`).join('\n')
      : ''
    const hisBlock = history.length > 0
      ? history.map(p => PanelService.pairBlock(p, '          ', '            ')).join('\n')
      : ''
    return '    - id: custom-first-control-prompt\n'
      + "      name: '@wm-coders/dsh-custom-first-control-prompt'\n"
      + '      config:\n'
      + (sections.length > 0 ? `        sections:\n${secBlock}\n` : '        sections: []\n')
      + (history.length > 0 ? `        history:\n${hisBlock}\n` : '        history: []\n')
      + `        includeSubagents: ${includeSubagents ? 'true' : 'false'}\n`
  }

  /**
   * Render the targeted (id-keyed, non-insert) profile-layer override for the
   * core row. The bundle layer (this package's `dsh.bundle` patch) inserts the
   * loader rows; a profile-layer `- insert:` of the same id would duplicate it
   * and fail the whole composition, so the panel always writes overrides.
   */
  private static coreOverrideBlock(config: PanelConfigView | undefined): string {
    const sections = Array.isArray(config?.sections) ? config.sections : []
    const history = Array.isArray(config?.history) ? config.history : []
    const includeSubagents = config?.includeSubagents === true
    const secBlock = sections.length > 0
      ? sections.map(s => `    - name: ${PanelService.yamlScalar(s.name)}\n      order: ${Number(s.order) || 0}\n      text: ${PanelService.yamlScalar(s.text)}`).join('\n')
      : ''
    const hisBlock = history.length > 0
      ? history.map(p => PanelService.pairBlock(p, '    ', '      ')).join('\n')
      : ''
    return '- id: custom-first-control-prompt\n'
      + '  config:\n'
      + (sections.length > 0 ? `    sections:\n${secBlock}\n` : '    sections: []\n')
      + (history.length > 0 ? `    history:\n${hisBlock}\n` : '    history: []\n')
      + `    includeSubagents: ${includeSubagents ? 'true' : 'false'}\n`
  }

  private static buildPatch(config: PanelConfigView | undefined): string {
    return '# Your patch layer for this dsh profile, applied after every bundle layer:\n'
      + '# a top-level YAML array of loader patch entries (id-targeted config\n'
      + '# overrides, disables, and insert lists; `!!js` expressions allowed).\n'
      + PanelService.coreOverrideBlock(config)
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
  private static mergeCoreBlock(existingRaw: string, config: PanelConfigView | undefined): string {
    const lines = existingRaw.split(/\r?\n/)
    const coreIdx = lines.findIndex(l => l.trim() === '- id: custom-first-control-prompt')
    if (coreIdx === -1) {
      if (existingRaw.trim() === '') return PanelService.buildPatch(config)
      // A comment-only file (optionally with a bare `[]`) carries no entries:
      // rebuild it as comments + the override. Appending after a complete
      // YAML document like `[]` would produce an unparseable file, failing
      // the whole web boot.
      const meaningful = lines.map(l => l.trim()).filter(t => t !== '' && !t.startsWith('#'))
      if (meaningful.every(t => t === '[]')) {
        const head = existingRaw.split(/\r?\n/)
          .filter(l => l.trim() === '' || l.trim().startsWith('#'))
          .join('\n').trimEnd()
        return (head.length > 0 ? head + '\n' : '') + PanelService.coreOverrideBlock(config)
      }
      const sep = existingRaw.endsWith('\n') ? '' : '\n'
      return existingRaw + sep + PanelService.coreOverrideBlock(config)
    }
    const indent = (lines[coreIdx]?.match(/^\s*/)?.[0] ?? '').length
    // Render the replacement at the matched row's own indent. A profile-layer
    // override is column 0; the bundle layer's insert row is nested. Rewriting a
    // column-0 row with the nested form dropped it inside the preceding block.
    const rendered = PanelService.coreOverrideBlock(config)
    const core = indent === 0
      ? rendered
      : rendered.split('\n').map(line => (line.length > 0 ? ' '.repeat(indent) + line : line)).join('\n')
    // The core block ends at the next same-or-lower-indent `- ` entry (e.g. a
    // sibling `    - id: ui-custom-first-control-prompt`); that entry is kept.
    let end = coreIdx + 1
    while (end < lines.length) {
      const line = lines[end]!
      const trimmed = line.trim()
      if (trimmed.startsWith('- ') && (line.match(/^\s*/)?.[0] ?? '').length <= indent) break
      end++
    }
    return [...lines.slice(0, coreIdx), core, ...lines.slice(end)].join('\n')
  }

  private async readPatch(): Promise<PanelConfigReadResult> {
    const path = await this.patchPath()
    if (path === null) {
      return { ok: false, path: '', raw: '', parsed: PanelService.parseBlock(''), error: 'unable to locate the profile patch file (settings.prepareDocument() returned no path)' }
    }
    const fs = this.ctx.get('fs') as PanelFs | undefined
    if (fs === undefined) return { ok: false, path, raw: '', parsed: PanelService.parseBlock(''), error: 'fs service unavailable' }
    try {
      const target = await fs.resolve(path)
      const raw = await fs.readText(target)
      const parsed = PanelService.parseBlock(raw)
      // With the bundle layer carrying the row, the profile patch starts out
      // without one; show the composed config so the editor is not blank.
      return { ok: true, path, raw, parsed: parsed.found || this.effective === undefined ? parsed : this.effective, error: '' }
    } catch (error) {
      return { ok: false, path, raw: '', parsed: PanelService.parseBlock(''), error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async writePatch(raw: string): Promise<PanelWriteResult> {
    const path = await this.patchPath()
    if (path === null) {
      return { ok: false, path: '', error: 'unable to locate the profile patch file (settings.prepareDocument() returned no path)' }
    }
    const fs = this.ctx.get('fs') as PanelFs | undefined
    if (fs === undefined) return { ok: false, path, error: 'fs service unavailable' }
    try {
      const target = await fs.resolve(path)
      await fs.writeText(target, raw, undefined, undefined, this.writePolicy())
      return { ok: true, path, saved: true, error: '' }
    } catch (error) {
      return { ok: false, path, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ---- Remote surface (the gateway prepends the live Agent authority) ----

  /** Read the profile patch entry. */
  @Remote('config-read')
  configRead(agent: Agent): Promise<PanelConfigReadResult> {
    void agent
    return this.readPatch()
  }

  /** Write the profile patch entry regenerated from the panel's config view. */
  @Remote('config-write')
  async configWrite(agent: Agent, config: PanelConfigView): Promise<PanelWriteResult> {
    void agent
    const existing = await this.readPatch()
    return this.writePatch(PanelService.mergeCoreBlock(existing.ok ? existing.raw : '', config))
  }

  /** Clear the configured prompt content, keeping the plugin installed (and any other patch lines). */
  @Remote('config-clear')
  async configClear(agent: Agent): Promise<PanelWriteResult> {
    void agent
    const existing = await this.readPatch()
    return this.writePatch(PanelService.mergeCoreBlock(existing.ok ? existing.raw : '', {
      found: true, sections: [], history: [], includeSubagents: false,
    }))
  }

  /** Import a raw patch file text wholesale. */
  @Remote('config-raw-import')
  configRawImport(agent: Agent, raw: string): Promise<PanelWriteResult> {
    void agent
    if (typeof raw !== 'string' || raw.trim() === '') {
      return Promise.resolve({ ok: false, path: '', error: 'raw content is empty; nothing written' })
    }
    return this.writePatch(raw)
  }

  /** Snapshot the captured request ring plus listener state. */
  @Remote('requests-list')
  requestsList(agent: Agent): PanelRequestsView {
    void agent
    return { requests: this.ring.slice(), paused: this.paused, dockVisible: this.dockVisible, injectionEnabled: this.injectionEnabled, activeTemplate: this.activeTemplate }
  }

  /** Pause or resume request capture. */
  @Remote('requests-set-paused')
  requestsSetPaused(agent: Agent, paused: boolean): PanelRequestsView {
    void agent
    this.paused = paused === true
    return { requests: this.ring.slice(), paused: this.paused, dockVisible: this.dockVisible, injectionEnabled: this.injectionEnabled, activeTemplate: this.activeTemplate }
  }

  /** Read this conversation's capture switch and last written file. */
  @Remote('capture-get')
  captureGet(agent: Agent): PanelCaptureView {
    return this.captureView(String(agent.session.id))
  }

  /** Turn this conversation's capture file on or off. */
  @Remote('capture-set')
  captureSet(agent: Agent, enabled: boolean): PanelCaptureView {
    const sessionId = String(agent.session.id)
    this.captureEnabled.set(sessionId, enabled === true)
    return this.captureView(sessionId)
  }

  /** Clear the captured request ring. */
  @Remote('requests-clear')
  requestsClear(agent: Agent): PanelRequestsView {
    void agent
    this.ring.length = 0
    this.seq = 0
    return { requests: [], paused: this.paused, dockVisible: this.dockVisible, injectionEnabled: this.injectionEnabled, activeTemplate: this.activeTemplate }
  }

  /** Show or hide the composer dock strip. */
  @Remote('ui-set-dock-visible')
  uiSetDockVisible(agent: Agent, visible: boolean): PanelRequestsView {
    void agent
    this.dockVisible = visible === true
    return { requests: this.ring.slice(), paused: this.paused, dockVisible: this.dockVisible, injectionEnabled: this.injectionEnabled, activeTemplate: this.activeTemplate }
  }

  /** Assemble this plugin's live system-prompt sections for the preview tab. */
  @Remote('preview-assemble')
  async previewAssemble(agent: Agent): Promise<PanelAssembleResult> {
    void agent
    const systemPrompt = this.ctx.get('systemPrompt') as PanelSystemPrompt | undefined
    if (systemPrompt === undefined) return { sections: [], error: 'systemPrompt service unavailable' }
    try {
      const assembly = await systemPrompt.assemble({})
      const sections = (Array.isArray(assembly?.sections) ? assembly.sections : [])
        .map(s => ({
          name: typeof s.name === 'string' ? s.name : '',
          text: typeof s.text === 'string' ? s.text : '',
          order: typeof s.order === 'number' ? s.order : 0,
        }))
        .filter(s => s.name.indexOf('custom-first-control-prompt') === 0)
      return { sections }
    } catch (error) {
      return { sections: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ---- template file ----

  /** Resolve the template file path next to the profile patch file. */
  private async templatePath(): Promise<string | null> {
    const base = await this.patchPath()
    if (base === null) return null
    const norm = base.replace(/\\/g, '/')
    const i = norm.lastIndexOf('/')
    if (i <= 0) return null
    return `${norm.slice(0, i)}/cfcp-templates.json`
  }

  /** Read and parse the template file; missing file = empty list (graceful). */
  private async readTemplates(): Promise<PanelTemplate[]> {
    const path = await this.templatePath()
    if (path === null) return []
    const fs = this.ctx.get('fs') as PanelFs | undefined
    if (fs === undefined) return []
    try {
      const target = await fs.resolve(path)
      const raw = await fs.readText(target)
      const parsed = JSON.parse(raw) as { templates?: unknown }
      const arr = Array.isArray(parsed.templates) ? parsed.templates : []
      return arr.filter((t): t is PanelTemplate =>
        typeof t === 'object' && t !== null
        && typeof (t as Record<string, unknown>)['name'] === 'string'
        && Array.isArray((t as Record<string, unknown>)['sections'])
        && Array.isArray((t as Record<string, unknown>)['history'])
      )
    } catch {
      return []
    }
  }

  /** Write templates to the template file. */
  private async writeTemplates(templates: readonly PanelTemplate[]): Promise<boolean> {
    const path = await this.templatePath()
    if (path === null) return false
    const fs = this.ctx.get('fs') as PanelFs | undefined
    if (fs === undefined) return false
    try {
      const target = await fs.resolve(path)
      await fs.writeText(target, JSON.stringify({ templates }, undefined, 2), undefined, undefined, this.writePolicy())
      return true
    } catch {
      return false
    }
  }

  /** List saved templates. */
  @Remote('template-list')
  async templateList(agent: Agent): Promise<PanelTemplateListResult> {
    void agent
    try {
      const templates = await this.readTemplates()
      return { ok: true, templates, error: '' }
    } catch (error) {
      return { ok: false, templates: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Save the current config as a named template (overwrites if name exists). */
  @Remote('template-save')
  async templateSave(agent: Agent, name: string, config: PanelConfigView): Promise<PanelTemplateWriteResult> {
    void agent
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (trimmed.length === 0) return { ok: false, error: 'template name is empty' }
    const templates = await this.readTemplates()
    const filtered = templates.filter(t => t.name !== trimmed)
    filtered.push({
      name: trimmed,
      sections: config.sections.map(s => ({ name: s.name, order: s.order, text: s.text, enabled: s.enabled })),
      history: config.history.map(p => ({
        user: p.user,
        assistant: p.assistant,
        ...(p.assistantThinking === undefined ? {} : { assistantThinking: p.assistantThinking }),
        ...(p.toolCalls === undefined ? {} : { toolCalls: p.toolCalls }),
        ...(p.toolResults === undefined ? {} : { toolResults: p.toolResults }),
      })),
      includeSubagents: config.includeSubagents,
    })
    const ok = await this.writeTemplates(filtered)
    return { ok, error: ok ? '' : 'failed to write template file' }
  }

  /** Delete a named template. */
  @Remote('template-delete')
  async templateDelete(agent: Agent, name: string): Promise<PanelTemplateWriteResult> {
    void agent
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const templates = await this.readTemplates()
    const filtered = templates.filter(t => t.name !== trimmed)
    if (filtered.length === templates.length) return { ok: true, error: '' }
    const ok = await this.writeTemplates(filtered)
    return { ok, error: ok ? '' : 'failed to write template file' }
  }

  /** Apply a named template: write its config to the patch file and enable injection. */
  @Remote('template-apply')
  async templateApply(agent: Agent, name: string): Promise<PanelWriteResult> {
    void agent
    const trimmed = typeof name === 'string' ? name.trim() : ''
    const templates = await this.readTemplates()
    const found = templates.find(t => t.name === trimmed)
    if (found === undefined) return { ok: false, path: '', error: `template "${trimmed}" not found` }
    const config: PanelConfigView = {
      found: true,
      sections: found.sections,
      history: found.history,
      includeSubagents: found.includeSubagents,
    }
    const existing = await this.readPatch()
    const result = await this.writePatch(PanelService.mergeCoreBlock(existing.ok ? existing.raw : '', config))
    if (result.ok) {
      this.activeTemplate = trimmed
      this.injectionEnabled = true
    }
    return result
  }

  /** Toggle the hot injection switch. */
  @Remote('injection-toggle')
  injectionToggle(agent: Agent, enabled: boolean): PanelRequestsView {
    void agent
    this.injectionEnabled = enabled === true
    return { requests: this.ring.slice(), paused: this.paused, dockVisible: this.dockVisible, injectionEnabled: this.injectionEnabled, activeTemplate: this.activeTemplate }
  }
}

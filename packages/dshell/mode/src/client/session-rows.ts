/**
 * Session-row model: durable session events expanded into displayable rows,
 * plus the ANSI text renderer the canvas draws them with.
 */

import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'

export type SessionRowRole = 'user' | 'assistant' | 'reasoning' | 'call' | 'tool' | 'command'

export interface SessionRow {
  readonly role: SessionRowRole
  /** Identity within the session log (type + seq + section), for collapse state. */
  readonly key: string
  /** Full display text; may span lines. */
  readonly text: string
  /** Whether the row offers a collapse toggle. */
  readonly collapsible: boolean
  /** Starts collapsed unless the user has explicitly expanded it. */
  readonly defaultCollapsed: boolean
  /** Header label override (a tool's own name). */
  readonly label?: string | undefined
  /** `tool-call` correlation id, so a later result can name its tool. */
  readonly callId?: string | undefined
  /** Event time, so a row can report how long it ran. */
  readonly time: number
  /** A tool call's own command, when its arguments name one. */
  readonly command?: string | undefined
}

/** The command inside a tool call's arguments, when there is one to show. */
export function commandOfArgs(raw: string): string | undefined {
  if (raw.trim().length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    for (const key of ['command', 'cmd', 'script']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Line count above which a row starts collapsed in the merged timeline. */
export const COLLAPSE_THRESHOLD: Record<SessionRowRole, number> = {
  user: Number.POSITIVE_INFINITY,
  assistant: 10,
  // Reasoning is always a collapsed "think" fold, however short.
  reasoning: 0,
  call: Number.POSITIVE_INFINITY,
  tool: 3,
  command: Number.POSITIVE_INFINITY,
}

/** Content blocks of a message, typed loosely (the wire is JSON). */
export function contentBlocks(content: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
  return (content ?? []).filter(
    (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
  )
}

/** Join the visible `text` blocks only — reasoning is rendered separately. */
export function textOfBlocks(content: readonly unknown[] | undefined): string {
  return contentBlocks(content)
    .filter(block => block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('')
}

/** Join the `reasoning` blocks (the model's chain of thought). */
export function reasoningOfBlocks(content: readonly unknown[] | undefined): string {
  return contentBlocks(content)
    .filter(block => block.type === 'reasoning')
    .map(block => String(block.text ?? ''))
    .join('')
}

/** Extract the model's tool invocations from one assistant message. */
export function toolCallsOfBlocks(content: readonly unknown[] | undefined): readonly { id: string; name: string; args: string }[] {
  return contentBlocks(content)
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: String(block.id ?? ''),
      name: String(block.name ?? '工具'),
      args: typeof block.arguments === 'string' ? block.arguments : '',
    }))
}

/**
 * Text of a tool result. A `tool-result` block nests its payload under
 * `content`, so a flat scan would render tool output as an empty row — walk
 * the nesting and fall back to a marker for non-text payloads.
 */
export function resultText(content: readonly unknown[] | undefined): string {
  const parts: string[] = []
  for (const block of contentBlocks(content)) {
    if (block.type === 'text') {
      parts.push(String(block.text ?? ''))
      continue
    }
    if (Array.isArray(block.content)) {
      const nested = resultText(block.content as unknown[])
      if (nested.length > 0) parts.push(nested)
      continue
    }
    if (block.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n').trim()
}

/** One-line argument preview for a tool call. */
export function compactArguments(raw: string): string {
  if (raw.trim().length === 0) return ''
  let text = raw
  try { text = JSON.stringify(JSON.parse(raw)) } catch { /* not JSON: keep raw */ }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 140 ? `${text.slice(0, 137)}…` : text
}

/** Build one row, or null when it would be blank. */
export function rowOf(
  role: SessionRowRole,
  key: string,
  text: string,
  time: number,
  extra: { label?: string; callId?: string; command?: string | undefined } = {},
): SessionRow | null {
  const body = text.replace(/\n+$/, '')
  if (body.trim().length === 0) return null
  const lines = body.split('\n').length
  // Reasoning folds whenever it is more than a one-liner or a wall of prose;
  // other roles fold on line count alone.
  const collapsible = role === 'reasoning'
    ? lines > 1 || body.length > 200
    : lines > COLLAPSE_THRESHOLD[role]
  return {
    role,
    key,
    text: body,
    collapsible,
    defaultCollapsed: collapsible,
    time,
    ...extra,
  }
}

/**
 * Extract the displayable rows of one durable Session event. A single
 * assistant message may yield three kinds of row — its thinking, its answer,
 * and one line per tool call — in stream order.
 * @param event - the durable event.
 * @param toolNames - call-id → tool-name directory, populated by assistant
 *   messages and read by their results (which carry only the call id).
 * @returns the rows, in display order.
 */
export function sessionRowsOf(event: SessionEventLike, toolNames: Map<string, string>): readonly SessionRow[] {
  if (event.type === 'user/message') {
    // Plugin-sourced user messages (host-side terminal context, guard
    // notices) are model input, not the user's words — keeping them out
    // stops the canvas from painting fake `┃ 你` rows.
    if (event.data.source.kind !== 'user') return []
    const text = textOfBlocks(event.data.content)
    // Legacy sessions carry the Phase 7 client-side context fence inside
    // the user's own message; show only the words beneath it.
    const stripped = /^\[dshell 终端上下文\][\s\S]*?```\n([\s\S]*)$/.exec(text)
    const row = rowOf('user', `${event.type}:${event.seq}`, stripped === null ? text : (stripped[1] ?? ''), event.time)
    return row === null ? [] : [row]
  }
  if (event.type === 'assistant/message') {
    const content = event.data.message.content
    const rows: SessionRow[] = []
    const base = `${event.type}:${event.seq}`
    const reasoning = rowOf('reasoning', `${base}:r`, reasoningOfBlocks(content), event.time, { label: '思考' })
    if (reasoning !== null) rows.push(reasoning)
    const answer = rowOf('assistant', `${base}:t`, textOfBlocks(content), event.time)
    if (answer !== null) rows.push(answer)
    toolCallsOfBlocks(content).forEach((call, index) => {
      toolNames.set(call.id, call.name)
      const preview = compactArguments(call.args)
      const row = rowOf('call', `${base}:c${String(index)}`, preview, event.time, {
        label: call.name,
        callId: call.id,
        command: commandOfArgs(call.args),
      })
      if (row !== null) rows.push(row)
    })
    return rows
  }
  if (event.type === 'tool/result') {
    const callId = event.data.message.source.callId
    const name = toolNames.get(callId) ?? event.data.error?.name ?? '工具'
    const body = resultText(event.data.message.content)
    const failed = event.data.error !== undefined
    const text = body.length > 0 ? body : (failed ? '（失败，无输出）' : '（无文本输出）')
    const row = rowOf('tool', `${event.type}:${event.seq}`, text, event.time, {
      label: `${name}${failed ? ' ✗' : ''}`,
      callId,
    })
    return row === null ? [] : [row]
  }
  if (event.type === 'command/done') {
    const outcome = event.data.kind === 'error' ? `失败:${event.data.text ?? ''}` : (event.data.text ?? '')
    const row = rowOf('command', `${event.type}:${event.seq}`, outcome.trim().length === 0 ? '完成' : outcome, event.time)
    return row === null ? [] : [row]
  }
  if (event.type === 'command/run') {
    const args = event.data.args
    const text = args === undefined || args === '' ? event.data.name : `${event.data.name} ${args}`
    const row = rowOf('command', `${event.type}:${event.seq}`, text, event.time)
    return row === null ? [] : [row]
  }
  return []
}

export const SESSION_ROW_COLOR: Record<SessionRowRole, string> = {
  user: '\u001b[36m', // cyan
  assistant: '\u001b[32m', // green
  reasoning: '\u001b[2;90m', // dim grey
  call: '\u001b[35m', // magenta
  tool: '\u001b[34m', // blue
  command: '\u001b[33m', // yellow
}

/** Row roles plus the states a whole task block can be in. */
export type GutterStyle = SessionRowRole | 'busy' | 'done' | 'failed'

/**
 * CSS colors matching the ANSI codes the labels use (xterm.js' built-in
 * palette). The block's left rule is painted by {@link paintGutter} rather
 * than by the `┃` glyph, so these must track the roles' text colors. A task
 * block's rule carries the block's own status, not a row role.
 */
export const GUTTER_COLOR: Record<GutterStyle, string> = {
  user: '#06989a', // ANSI 36
  assistant: '#4e9a06', // ANSI 32
  reasoning: '#353737', // ANSI 2;90, the dimmed rendering
  call: '#75507b', // ANSI 35
  tool: '#3465a4', // ANSI 34
  command: '#c4a000', // ANSI 33
  busy: '#06989a', // running block
  done: '#4e9a06', // completed block
  failed: '#cc0000', // aborted or failed block
}

export const SESSION_ROW_LABEL: Record<SessionRowRole, string> = {
  user: '你',
  assistant: 'AI',
  reasoning: '思考过程',
  call: '调用',
  tool: '工具',
  command: '⚡ 命令',
}

/** Columns the block's rule owns; text never reaches into them. */
export const GUTTER_COLUMNS = 2

/** Display width of one code point in terminal cells. */
export function cellWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if (code >= 0x0300 && code <= 0x036f) return 0 // combining marks
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) // Hangul Jamo
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) // CJK … Yi
    || (code >= 0xac00 && code <= 0xd7a3) // Hangul syllables
    || (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
    || (code >= 0xfe30 && code <= 0xfe6f) // CJK compatibility forms
    || (code >= 0xff00 && code <= 0xff60) // fullwidth forms
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f9ff) // emoji
    || (code >= 0x1fa70 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd) // CJK extension
  ) return 2
  return 1
}

/** Escape sequences and control characters a captured terminal may carry. */
export const ROW_ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu
export const ROW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu

/**
 * Make captured terminal text safe to lay out inside a block. Tool results are
 * screen captures: they carry carriage returns that rewind to column 0 and
 * overwrite whatever is on the line — including this renderer's own indent and
 * fold hint — plus escapes that can move the cursor or clear the screen. Tabs
 * and newlines survive, because the renderer lays those out itself.
 * @param text - raw row text from the session log.
 * @returns the same text with every cursor-moving effect removed.
 */
export function sanitizeRowText(text: string): string {
  return text.replace(ROW_ESCAPE, '').replace(ROW_CONTROL, '')
}

/**
 * Hard-wrap one logical line to `width` cells, indenting every produced row
 * with the gutter. xterm's own soft wrap restarts at column 0, which would put
 * the continuation under the block's rule; wrapping here keeps the gutter
 * blank on every row of the block.
 *
 * ANSI sequences are copied through without counting toward the width, so a
 * color run survives a wrap.
 * @param text - the logical line, possibly containing escape sequences.
 * @param width - usable cells, gutter excluded.
 * @returns newline-terminated rows, each starting with the gutter.
 */
export function wrapBlockLine(text: string, width: number): string {
  const indent = ' '.repeat(GUTTER_COLUMNS)
  let out = indent
  let used = 0
  let index = 0
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0
    if (code === 0x1b) {
      // Copy the escape sequence verbatim: CSI ends on a final byte 0x40–0x7e,
      // OSC on BEL or ST, anything else is a two-character escape.
      let end = index + 1
      const kind = text[end]
      if (kind === '[') {
        end += 1
        while (end < text.length) {
          const at = text.charCodeAt(end)
          end += 1
          if (at >= 0x40 && at <= 0x7e) break
        }
      } else if (kind === ']') {
        end += 1
        while (end < text.length) {
          if (text[end] === '\u0007') { end += 1; break }
          if (text[end] === '\u001b' && text[end + 1] === '\\') { end += 2; break }
          end += 1
        }
      } else {
        end = Math.min(text.length, index + 2)
      }
      out += text.slice(index, end)
      index = end
      continue
    }
    const character = String.fromCodePoint(code)
    if (code === 0x09) {
      // Tab stops are absolute columns, so the gutter counts toward them.
      const stop = 8 - ((GUTTER_COLUMNS + used) % 8)
      if (used + stop > width) {
        out += `\r\n${indent}`
        used = 0
      } else {
        out += ' '.repeat(stop)
        used += stop
      }
      index += character.length
      continue
    }
    const size = cellWidth(code)
    if (size > 0 && used + size > width) {
      out += `\r\n${indent}`
      used = 0
    }
    out += character
    used += size
    index += character.length
  }
  return `${out}\r\n`
}

/** Trailing escape sequences a chunk may end with after its text. */
export const TRAILING_ESCAPES = /(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_])+$/u

/**
 * Whether a chunk closes its last line. Only a newline does: a carriage return
 * means the PTY is still on that line — readline redraws it with `\r` + erase,
 * so a block row written there would be erased by the shell's next repaint.
 * Trailing escape sequences do not move the cursor, so they are ignored.
 * @param text - the chunk just written.
 * @returns true/false, or undefined when the chunk has no visible character.
 */
export function endsAtLineStart(text: string): boolean | undefined {
  const stripped = text.replace(TRAILING_ESCAPES, '')
  if (stripped.length === 0) return undefined
  return stripped[stripped.length - 1] === '\n'
}

/**
 * Render one session row (design 4.4). A collapsible row renders collapsed to
 * one line plus a toggle hint. Every line is hard-wrapped to the terminal width
 * minus the gutter, so no row of the block ever reaches column 0 — the gutter
 * column stays empty and the rule painted over it never covers text.
 * @param row - the row to draw.
 * @param collapsed - whether the body is hidden.
 * @param cols - current terminal width in cells.
 * @returns the ANSI text for the row (header plus body, newline-terminated).
 */
export function renderSessionRow(row: SessionRow, collapsed: boolean, cols: number, hints = true): string {
  const width = Math.max(16, cols - GUTTER_COLUMNS)
  const color = SESSION_ROW_COLOR[row.role]
  const reset = '\u001b[0m'
  const dim = '\u001b[2m'
  const lines = sanitizeRowText(row.text).split('\n')
  const first = lines[0] ?? ''
  // A folded row is one compact line: keep it short even when the record's
  // first line is a whole paragraph.
  const summary = collapsed && first.length > 160 ? `${first.slice(0, 157)}…` : first
  const rest = lines.slice(1)
  const folded = rest.length > 0 ? `+${String(rest.length)} 行 ▸ 点击展开` : '点击展开'
  const hint = !hints || !row.collapsible
    ? ''
    : collapsed
      ? ` ${dim}[${folded}]${reset}`
      : ` ${dim}[▾ 点击收起]${reset}`
  const label = row.label === undefined ? SESSION_ROW_LABEL[row.role] : sanitizeRowText(row.label)
  // The gutter column stays blank in the text; paintGutter() draws the block's
  // rule over it as a continuous CSS band.
  let out = wrapBlockLine(`${color}${label}${reset} ${summary}${hint}`, width)
  if (!collapsed) {
    for (const line of rest) out += wrapBlockLine(line, width)
  }
  return out
}


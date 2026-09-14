/**
 * dshell-mode host face — terminal context injection, window-based.
 *
 * The user's visible main shell is the session's shared working context. On
 * every step that carries a genuine user prompt, the *newest few commands with
 * their output* ride into that step as a plugin-sourced context message
 * (`agent/pre-step`, host-only).
 *
 * The block is a window rather than a delta, and that is the point: what a model
 * needs in order to reason about the terminal is its recent state, and "the last
 * three commands" is small enough to send every time (each preview is capped at
 * 2 KiB, tail-first, because a command that printed too much is explained by its
 * end). A long command is therefore never pushed into the context whole: the
 * block carries the session cursor and names the tool that reads any command's
 * output in slices by `(seq, offset, limit)`. A watermark is still kept, but
 * only to report how many commands finished since the previous step.
 *
 * Injection is deliberately conservative:
 *  - only steps carrying a `source.kind === 'user'` message (tool rounds and
 *    synthetic notices never re-trigger it, or a tool loop would re-send the
 *    same window on every round);
 *  - only sessions with a *live* main shell (`history` and `since` never spawn
 *    one), so subagents and never-opened sessions stay context-free;
 *  - a shell that has closed no command at all — one without markers — falls
 *    back to a capped slice of its raw output, and injects nothing when even
 *    that is empty.
 *
 * The message source is `kind: 'plugin'`, which the browser face's session-row
 * extractor filters out — context never renders as a fake user bubble.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the host agent Events merge (`agent/pre-step`).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the settings service merge (optional `ctx.settings`).
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: pulls the bridge service merge (ctx.dshellTerminalBridge).
import type {} from '@nexus-aethra/dshell-terminal-bridge'
import type { TerminalCommandRecord, TerminalDelta } from '@nexus-aethra/dshell-terminal-bridge'
import { DSHELL_SETTINGS_NAMESPACE } from './settings.js'
import { DshellSettingsSchema } from './settings-schema.js'

export const name = '@nexus-aethra/dshell-mode/host'

/** Required service: the bridge owns the main-shell buffers we read. */
export const inject = ['dshellTerminalBridge'] as const

/** Commands the injected block carries, newest last. */
const WINDOW_COMMANDS = 3

/** Bytes of one command's output a preview shows. */
const PREVIEW_BYTES = 2 * 1024

/** Bytes of raw output the marker-less fallback shows. */
const RAW_FALLBACK_BYTES = 2 * 1024

/** The context block's durable provenance. */
const CONTEXT_SOURCE: MessageSource = {
  kind: 'plugin',
  plugin: 'dshell-mode',
  form: 'notice',
  summary: '主终端最近命令',
}

/** Keep the newest `maxBytes` of a UTF-8 string, marking the cut. */
function capTail(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  // Do not start on a UTF-8 continuation byte.
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1
  return `…(省略前 ${String(start)} 字节)\n${new TextDecoder().decode(bytes.subarray(start))}`
}

/**
 * The tail of one command's output for the injected block.
 *
 * A bare marker rather than a byte count: the record's own text may already have
 * been truncated by the bridge (at a larger cap), so how much of the *original*
 * output is missing is not knowable here. The tool reports the exact numbers
 * when the model asks, which is also why the block names it.
 */
function previewText(output: string): { text: string; cut: boolean } {
  const trimmed = output.trim()
  if (trimmed.length === 0) return { text: '', cut: false }
  const bytes = new TextEncoder().encode(trimmed)
  if (bytes.length <= PREVIEW_BYTES) return { text: trimmed, cut: false }
  let start = bytes.length - PREVIEW_BYTES
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1
  return { text: `…(仅显示尾部)\n${new TextDecoder().decode(bytes.subarray(start))}`, cut: true }
}

/**
 * Render the window block, or undefined when there is nothing to show.
 *
 * @param commands - the newest commands, oldest first.
 * @param cursor - the session cursor a tool call can be made with.
 * @param finished - commands that finished since the previous step, for the
 *   count line; 0 omits it.
 */
function formatWindow(
  commands: readonly TerminalCommandRecord[],
  cursor: string,
  finished: number,
): string | undefined {
  if (commands.length === 0) return undefined
  const lines: string[] = [`[dshell 主终端 · 最近 ${String(commands.length)} 条]  cursor: ${cursor}`]
  let cut = false
  for (const command of commands) {
    const name = command.command.length > 0 ? command.command : '(未跟踪的命令)'
    // `seq` is part of the line because it is the key the output tool takes.
    lines.push(`$ ${name}${command.exitCode === null ? '' : `  exit ${String(command.exitCode)}`}  · seq=${String(command.seq)}`)
    const preview = previewText(command.output)
    if (preview.text.length > 0) lines.push(preview.text)
    if (preview.cut) cut = true
  }
  if (finished > 0) lines.push(`(自上次以来完成 ${String(finished)} 条命令)`)
  if (cut) lines.push('(输出过长的命令可用 dshell_terminal_output 按 seq 读取更多)')
  return lines.join('\n')
}

/**
 * The fallback for a shell that closed no command records at all: a capped slice
 * of its raw output, which is the only thing a marker-less shell gives us.
 */
function formatRaw(delta: TerminalDelta): string | undefined {
  const text = delta.text.trim()
  if (text.length === 0) return undefined
  return `[dshell 主终端 · 最近输出]  cursor: ${delta.cursor}\n\`\`\`\n${capTail(text, RAW_FALLBACK_BYTES)}\n\`\`\``
}

/**
 * Inject the terminal window before user-driven steps.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  // The settings namespace the Plugins section dispatches a card for: the
  // browser half registers its card under this same key. Registration is all
  // it takes — the Host stores the palette id without interpreting it.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(DSHELL_SETTINGS_NAMESPACE, DshellSettingsSchema)
  })
  const bridge = ctx.dshellTerminalBridge
  /**
   * The last cursor each agent was handed.
   *
   * Only the count line needs it now — the block's content is always the newest
   * commands — so a missing entry means "this agent has never been told
   * anything", and the whole retained window is not reported as new.
   */
  const watermarks = new Map<Agent, string>()
  ctx.on('agent/disposed', ({ agent }) => { watermarks.delete(agent) })
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    if (!messages.some(message => message.source.kind === 'user')) return downstream
    const sessionId = String(agent.id)
    // The window is read from the live shell's own records, so a session that
    // never opened a terminal injects nothing (`history` never spawns).
    const window = bridge.history(sessionId, WINDOW_COMMANDS)
    if (window === undefined) return downstream
    const seen = watermarks.has(agent)
    const delta = bridge.since(sessionId, watermarks.get(agent))
    if (delta === undefined) return downstream
    watermarks.set(agent, delta.cursor)
    const finished = seen && !delta.cleared ? delta.newCommandCount : 0
    const text = formatWindow(window.commands, window.cursor, finished) ?? formatRaw(delta)
    if (text === undefined) return downstream
    const context = createUserMessage({
      content: [{ type: 'text', text }],
      source: CONTEXT_SOURCE,
    })
    return { ...downstream, messages: [context, ...downstream.messages] }
  })
}

export default { name, inject, apply }

/**
 * dshell-mode host face — Phase 7 (terminal context injection), cursor-based.
 *
 * The user's visible main shell is the session's shared working context. On
 * every step that carries a genuine user prompt, the output the model has not
 * seen yet rides into that step as a plugin-sourced context message
 * (`agent/pre-step`, host-only).
 *
 * "Not seen yet" is tracked per Agent with an opaque cursor minted by the
 * bridge: the first turn delivers nothing new, and every later turn delivers
 * only the delta since the previous one. That replaces the old whole-tail
 * snapshot, which re-sent the same recent lines on every turn.
 *
 * Injection is deliberately conservative:
 *  - only steps carrying a `source.kind === 'user'` message (tool rounds and
 *    synthetic notices never re-trigger it);
 *  - only sessions with a *live* main shell (`since` never spawns one), so
 *    subagents and never-opened sessions stay context-free;
 *  - an empty delta injects nothing at all;
 *  - a stale cursor (the shell was respawned or `/clear`ed) advances the
 *    watermark and injects nothing — the seeded scrollback is history, and
 *    the next turn resumes from the new head.
 *
 * The message source is `kind: 'plugin'`, which the browser face's session-row
 * extractor filters out — context never renders as a fake user bubble.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the host agent Events merge (`agent/pre-step`).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the bridge service merge (ctx.dshellTerminalBridge).
import type {} from '@deepseek-ai/dsh-dshell-terminal-bridge'
import type { TerminalDelta } from '@deepseek-ai/dsh-dshell-terminal-bridge'

export const name = '@deepseek-ai/dsh-dshell-mode/host'

/** Required service: the bridge owns the main-shell buffers we read. */
export const inject = ['dshellTerminalBridge'] as const

/** Per-injection text budget (the command summary rides on top of this). */
const INJECT_MAX_BYTES = 8 * 1024

/** Newest commands spelled out individually; older ones are only counted. */
const MAX_COMMANDS_LISTED = 20

/** The context block's durable provenance. */
const CONTEXT_SOURCE: MessageSource = {
  kind: 'plugin',
  plugin: 'dshell-mode',
  form: 'notice',
  summary: '主终端增量',
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
 * Render one delta as the injected block, or undefined when it carries
 * nothing worth spending tokens on.
 * @param delta - incremental slice from the bridge.
 * @returns the context block text.
 */
function formatDelta(delta: TerminalDelta): string | undefined {
  const listed = delta.commands.slice(-MAX_COMMANDS_LISTED)
  const lines: string[] = ['[dshell 主终端 · 自上次以来]']
  if (delta.newCommandCount > 0) {
    lines.push(`完成 ${String(delta.newCommandCount)} 条命令：`)
    if (delta.newCommandCount > listed.length) {
      lines.push(`…(仅列出最近 ${String(listed.length)} 条)`)
    }
    for (const command of listed) {
      const name = command.command.length > 0 ? command.command : '(未跟踪的命令)'
      lines.push(`  $ ${name}${command.exitCode === null ? '' : `  exit ${String(command.exitCode)}`}`)
    }
  }
  const text = delta.text.trim()
  if (text.length > 0) {
    lines.push('最近输出：', '```', capTail(text, INJECT_MAX_BYTES), '```')
  } else if (delta.dropped) {
    lines.push('…(更早的输出已滚出终端缓冲区)')
  }
  if (lines.length === 1) return undefined
  return lines.join('\n')
}

/**
 * Inject the main-shell delta before user-driven steps.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  const bridge = ctx.dshellTerminalBridge
  /** What each agent's model has already been shown. */
  const watermarks = new Map<Agent, string>()
  ctx.on('agent/disposed', ({ agent }) => { watermarks.delete(agent) })
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    if (!messages.some(message => message.source.kind === 'user')) return downstream
    const delta = bridge.since(String(agent.id), watermarks.get(agent))
    if (delta === undefined) return downstream
    // Advance before deciding to inject: a stale cursor means the shell was
    // replaced, and its seeded scrollback is history rather than new output.
    watermarks.set(agent, delta.cursor)
    if (delta.cleared) return downstream
    const text = formatDelta(delta)
    if (text === undefined) return downstream
    const context = createUserMessage({
      content: [{ type: 'text', text }],
      source: CONTEXT_SOURCE,
    })
    return { ...downstream, messages: [context, ...downstream.messages] }
  })
}

export default { name, inject, apply }

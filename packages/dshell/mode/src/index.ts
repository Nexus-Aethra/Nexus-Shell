/**
 * dshell-mode host face — Phase 7 (terminal context injection).
 *
 * The user's visible main shell is the session's shared working context.
 * When a step carries a genuine user prompt, the recent output of that
 * shell rides into the same step as a plugin-sourced context message
 * (`agent/pre-step`, host-only), so the model can answer "what did that
 * command print?" without the user pasting anything.
 *
 * Injection is deliberately conservative:
 *  - only steps that carry a `source.kind === 'user'` message (tool
 *    rounds, synthetic notices and plugin context never re-trigger it);
 *  - only sessions with a *live* main shell (`recentOutput` never spawns
 *    one), so subagents and never-opened sessions stay context-free;
 *  - the snapshot is capped by the bridge's PtyBuffer tail (100 lines /
 *    4 KiB, cut on a UTF-8 boundary) and skipped entirely when empty.
 *
 * The message source is `kind: 'plugin'`, which the browser face's
 * session-row extractor filters out — context never renders as a fake
 * user bubble in the canvas.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the host agent Events merge (`agent/pre-step`).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the bridge service merge (ctx.dshellTerminalBridge).
import type {} from '@deepseek-ai/dsh-dshell-terminal-bridge'

export const name = '@deepseek-ai/dsh-dshell-mode/host'

/** Required service: the bridge owns the main-shell buffers we read. */
export const inject = ['dshellTerminalBridge'] as const

/** Snapshot bounds for one injection (design 4.6). */
const INJECT_MAX_LINES = 100
const INJECT_MAX_BYTES = 4096

/** The context block's durable provenance. */
const CONTEXT_SOURCE: MessageSource = {
  kind: 'plugin',
  plugin: 'dshell-mode',
  form: 'notice',
  summary: '主终端最近输出',
}

/** Wrap the raw tail in a self-describing block the model can attribute. */
function formatContext(text: string): string {
  return [
    '[dshell 终端上下文]',
    '下面是用户在 dshell 主终端里最近的输出，可直接引用：',
    '```',
    text.replace(/\n+$/, ''),
    '```',
  ].join('\n')
}

/**
 * Inject the main-shell tail before user-driven steps.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  const bridge = ctx.dshellTerminalBridge
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    if (!messages.some(message => message.source.kind === 'user')) return downstream
    const text = bridge.recentOutput(String(agent.id), INJECT_MAX_LINES, INJECT_MAX_BYTES)
    if (text === undefined || text.trim().length === 0) return downstream
    const context = createUserMessage({
      content: [{ type: 'text', text: formatContext(text) }],
      source: CONTEXT_SOURCE,
    })
    return { ...downstream, messages: [context, ...downstream.messages] }
  })
}

export default { name, inject, apply }

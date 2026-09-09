/**
 * dshell-commands host face — Phases 6/8.
 *
 * `/clear` wipes the bridge's main-shell history: dsh's TerminalSanitizer
 * strips the ANSI clear from scrollback, so the visual clear is performed
 * by the bridge. `/new` creates a fresh session with the invoking
 * session's cwd (the dock additionally intercepts `/new` client-side,
 * because the "current session" selection is client-only state no host
 * command can switch). `/compact` is dsh's own `command-compact` — dshell
 * must not re-register it; the dock routes it to the stock executor.
 * `dshell_get_main_terminal` hands the agent the addressable
 * `TerminalSessionId` of the user's visible main shell.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: pulls the host merges (ctx.sessionController, ctx.tools) and
// the bridge service merge (ctx.dshellTerminalBridge) into the program.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { DshellTerminalBridge } from '@deepseek-ai/dsh-dshell-terminal-bridge'

export const name = '@deepseek-ai/dsh-dshell-commands'

export const inject = ['commands', 'tools', 'dshellTerminalBridge'] as const

export function apply(ctx: Context): void {
  const bridge: DshellTerminalBridge = ctx.dshellTerminalBridge

  ctx.commands.register({
    name: 'clear',
    description: 'Clear the dshell main terminal scrollback.',
    handler: async (invocation): Promise<CommandResult> => {
      try {
        await bridge.clearSession(String(invocation.agent.id))
        return { kind: 'success', text: '终端已清空。' }
      } catch (error) {
        return { kind: 'error', text: `清空失败:${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  ctx.commands.register({
    name: 'new',
    description: 'Create a new dshell session inheriting the current working directory.',
    handler: async (invocation): Promise<CommandResult> => {
      try {
        const cwd = invocation.agent.session?.header?.cwd
        const created = await ctx.sessionController.create(cwd === undefined ? {} : { cwd })
        return { kind: 'success', text: `新会话已创建:${String(created.sessionId)}` }
      } catch (error) {
        return { kind: 'error', text: `创建会话失败:${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  ctx.tools.register(defineTool({
    name: 'dshell_get_main_terminal',
    description: 'Return the terminal session id of the user-facing main shell. '
      + 'Pass it to terminal_send / terminal_read / terminal_signal to run commands '
      + 'in the terminal the user is watching; its output streams back to the user live.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { sessionId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.sessionId }],
    },
    async execute(_args: Record<string, never>, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dshell_get_main_terminal requires an agent context')
      return { sessionId: String(await bridge.mainTerminalId(String(agent.id))) }
    },
    presentCall: () => ({ card: 'generic', title: '获取主终端', kind: 'read' }),
  }))
}

export default { name, inject, apply }

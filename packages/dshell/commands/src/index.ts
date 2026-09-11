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
 * `dshell_get_agent_terminal` hands the agent the addressable
 * `TerminalSessionId` of its OWN shell — the PTY the bridge spawns for it,
 * separate from the one the user types into.
 * `dshell_terminal_read` reads the USER's shell (read-only) at command
 * granularity — incremental since an opaque cursor, or the latest commands.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: pulls the host merges (ctx.sessionController, ctx.tools) and
// the bridge service merge (ctx.dshellTerminalBridge) into the program.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { DshellTerminalBridge, TerminalCommandRecord } from '@deepseek-ai/dsh-dshell-terminal-bridge'

export const name = '@deepseek-ai/dsh-dshell-commands'

export const inject = ['commands', 'tools', 'dshellTerminalBridge'] as const

/** Render one command record for the model. */
function formatCommand(record: TerminalCommandRecord, includeOutput: boolean): string {
  const name = record.command.length > 0 ? record.command : '(未跟踪的命令)'
  const exit = record.exitCode === null ? '' : `  exit ${String(record.exitCode)}`
  const head = `$ ${name}${exit}`
  const output = record.output.trim()
  if (!includeOutput || output.length === 0) return head
  return `${head}\n${output}`
}

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
    name: 'dshell_get_agent_terminal',
    description: 'Return the terminal session id of YOUR OWN shell — a PTY spawned for you, '
      + 'starting in the directory the user\'s shell is in. Pass it to terminal_send / '
      + 'terminal_read / terminal_signal to run commands. It is a separate shell from the one '
      + 'the user types into, so your commands and theirs never block each other, and the user '
      + 'can watch yours live in the task card. The user\'s own shell is only readable, via '
      + 'dshell_terminal_read.',
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
      if (agent === undefined) throw new Error('dshell_get_agent_terminal requires an agent context')
      return { sessionId: String(await bridge.agentTerminalId(String(agent.id))) }
    },
    presentCall: () => ({ card: 'generic', title: '获取 AI 终端', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'dshell_terminal_read',
    description: 'Read the USER\'s terminal — the shell they are typing into — at command '
      + 'granularity, read-only. Without a cursor it lists the most recent commands; with the '
      + 'cursor a previous call returned, it reports only what happened since — the way to catch '
      + 'up on what the user has been doing without asking them. Output is stripped of terminal '
      + 'control codes. Run your own commands in the shell from '
      + 'dshell_get_agent_terminal instead: typing into the user\'s terminal takes the foreground '
      + 'away from them.',
    parameters: {
      cursor: {
        type: 'string',
        description: 'Opaque cursor from a previous call. Omit to list the most recent commands.',
      },
      limit: {
        type: 'integer',
        description: 'Without a cursor: how many recent commands to list (default 20).',
      },
      includeOutput: {
        type: 'boolean',
        description: 'Without a cursor: include each command\'s output (default true).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          cursor: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.cursor.length > 0 ? `${value.text}\n\ncursor: ${value.cursor}` : value.text,
      }],
    },
    async execute(args: { cursor?: string; limit?: number; includeOutput?: boolean }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('dshell_terminal_read requires an agent context')
      const sessionId = String(agent.id)
      const NO_SHELL = '主终端尚未打开：用户还没有打开这个会话的终端。'
      if (args.cursor !== undefined && args.cursor.length > 0) {
        const delta = bridge.since(sessionId, args.cursor)
        if (delta === undefined) return { text: NO_SHELL, cursor: '' }
        const lines: string[] = []
        if (delta.cleared) {
          lines.push('终端已被清空或重启，游标已失效；下面是新终端的状态。')
        }
        if (delta.newCommandCount > 0) {
          lines.push(`完成 ${String(delta.newCommandCount)} 条命令：`)
          for (const command of delta.commands) lines.push(formatCommand(command, true))
        }
        const text = delta.text.trim()
        if (text.length > 0) lines.push('输出：', text)
        if (delta.dropped) lines.push('…(更早的输出已滚出终端缓冲区)')
        if (lines.length === 0) lines.push('自游标以来没有新的终端活动。')
        return { text: lines.join('\n'), cursor: delta.cursor }
      }
      const history = bridge.history(sessionId, args.limit ?? 20)
      if (history === undefined) return { text: NO_SHELL, cursor: '' }
      const lines = history.commands.length === 0
        ? ['主终端还没有执行过可识别的命令。']
        : history.commands.map(command => formatCommand(command, args.includeOutput !== false))
      return { text: lines.join('\n'), cursor: history.cursor }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.cursor === undefined ? '读取主终端历史' : '读取主终端增量',
      kind: 'read',
    }),
  }))
}

export default { name, inject, apply }

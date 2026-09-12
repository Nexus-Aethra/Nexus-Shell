/**
 * The bridge's HTTP face: one read of a session's shell history.
 *
 * The shell's own history is already recorded here — the command splitter pairs
 * every submitted line with its output and exit status, and the record list is
 * what the agent's terminal tool reads back. The composer needs the same list
 * for its up-arrow gesture, and it cannot get it from anywhere else: the
 * terminal's scrollback is a rendered stream, while these records are the lines
 * the user actually ran.
 *
 * Read-only on purpose, and never spawning: a session without a live shell
 * answers with no commands rather than getting one created to answer a
 * question about it.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { DshellTerminalBridge } from './index.js'

/** The exact `/api` path the bridge answers on. */
export const DSHELL_PTY_PATH = '/api/dshell/pty'

/** Commands one answer carries. Mirrors the bridge's own retention cap. */
const MAX_HISTORY = 200

/** One browser face request. */
export interface DshellPtyRequest {
  readonly action: 'history'
  /** The session whose shell history to read. */
  readonly sessionId: string
  /** Newest-commands cap; omitted means {@link MAX_HISTORY}. */
  readonly limit?: number | undefined
}

/** One command the shell ran, as the composer lists it. */
export interface DshellPtyCommand {
  /** The assembled command line. */
  readonly command: string
  /** Bash's exit status, or null when the marker carried none. */
  readonly exitCode: number | null
  /** Epoch ms the command finished. */
  readonly at: number
}

/** One answer: the commands, oldest first (the order they ran in). */
export interface DshellPtyResponse {
  readonly commands?: readonly DshellPtyCommand[] | undefined
  readonly error?: string | undefined
}

/** JSON response in the shape the browser face parses. */
function respond(body: DshellPtyResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Bind the history route to a bridge.
 * @param bridge - the service holding each session's command records.
 * @returns the route the host's connection layer can register.
 */
export function createPtyRoute(bridge: DshellTerminalBridge): ConnectionFetchRoute {
  return {
    path: DSHELL_PTY_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') return respond({ error: '这条路由只接受 POST' }, 400)
        const input = await request.json() as DshellPtyRequest
        if (input.action !== 'history') return respond({ error: '未知操作' }, 400)
        const limit = Math.max(1, Math.min(input.limit ?? MAX_HISTORY, MAX_HISTORY))
        // A blank command is a tracked line that never assembled into one (the
        // splitter says so with ''), and offering it as history would be noise.
        const commands = (bridge.history(input.sessionId, limit)?.commands ?? [])
          .filter(command => command.command.trim().length > 0)
          .map(command => ({
            command: command.command,
            exitCode: command.exitCode,
            at: command.at,
          }))
        return respond({ commands })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ error: reason }, 400)
      }
    },
  }
}

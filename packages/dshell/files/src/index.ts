/**
 * dshell-files host face: the directory listing the file navigator reads, and
 * the one command it can send.
 *
 * The browser half is the visible feature; this half exists because the walk
 * needs a data source that is not fenced to the session's working directory —
 * dsh's own `workspaceFiles.list` refuses anything above it, while the
 * filesystem seam itself reads wherever the session's world reaches.
 *
 * The shell jump is the second half of the same idea: the pane can show a
 * device's `/etc`, and the session's shell can go there, because both read the
 * session's own execution world rather than this machine's.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the host connection merge (ctx.connection.fetch).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the host agent service merge (ctx.agents.withInitiator).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
// Type-only: pulls the terminal bridge's service merge (ctx.dshellTerminalBridge).
import type { DshellTerminalBridge } from '@deepseek-ai/dsh-dshell-terminal-bridge'
import { createFilesRoute } from './route.js'

export const name = '@deepseek-ai/dsh-dshell-files'

export { DSHELL_FILES_PATH } from './protocol.js'
export type { DshellFileEntry, DshellFileKind, DshellFilesListing, DshellFilesRequest, DshellFilesResponse } from './protocol.js'

export function apply(ctx: Context): void {
  // `fs` is injected, not merely imported: Cordis refuses a property access on a
  // context whose scope never declared the service, and the listing reads the
  // seam through the scope handed to the route.
  ctx.inject(['connection', 'agents', 'sessionController', 'fs'], (routeCtx) => {
    // The terminal bridge is genuinely optional — it is what makes the jump
    // button possible, not what makes the pane work — so it gets its own scope
    // that simply never runs in a composition without it.
    let bridge: DshellTerminalBridge | undefined
    routeCtx.inject(['dshellTerminalBridge'], (terminalCtx) => {
      bridge = terminalCtx.dshellTerminalBridge
    })
    routeCtx.effect(
      () => routeCtx.connection.fetch.register(createFilesRoute(routeCtx, () => bridge)),
      'dshell-files: listing route',
    )
  })
}

export default { name, apply }

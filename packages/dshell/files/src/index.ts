/**
 * dshell-files host face: the directory listing the file navigator reads.
 *
 * The browser half is the visible feature; this half exists because the walk
 * needs a data source that is not fenced to the session's working directory —
 * dsh's own `workspaceFiles.list` refuses anything above it, while the
 * filesystem seam itself reads wherever the session's world reaches.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the host connection merge (ctx.connection.fetch).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the host agent service merge (ctx.agents.withInitiator).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createFilesRoute } from './route.js'

export const name = '@deepseek-ai/dsh-dshell-files'

export { DSHELL_FILES_PATH } from './protocol.js'
export type { DshellFileEntry, DshellFileKind, DshellFilesListing, DshellFilesRequest, DshellFilesResponse } from './protocol.js'

export function apply(ctx: Context): void {
  // `fs` is injected, not merely imported: Cordis refuses a property access on a
  // context whose scope never declared the service, and the listing reads the
  // seam through the scope handed to the route.
  ctx.inject(['connection', 'agents', 'sessionController', 'fs'], (routeCtx) => {
    routeCtx.effect(
      () => routeCtx.connection.fetch.register(createFilesRoute(routeCtx)),
      'dshell-files: listing route',
    )
  })
}

export default { name, apply }

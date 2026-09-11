/**
 * The file navigator's route: one exact `/api` endpoint behind dsh's existing
 * trust and authentication fence, mirroring the other dshell routes.
 *
 * It lists ONE directory, in the session's own execution world. The world is
 * chosen by the filesystem seam itself, not here: every call runs inside
 * `ctx.agents.withInitiator`, and `ctx.fs` resolves the ambient session — a
 * device-bound session's tree is read over its own SSH route, this machine's
 * otherwise. That is also why the walk is unbounded: the routing helper passes
 * an absolute path outside the session's mount directory through unchanged, so
 * on a device `/etc` means the device's `/etc`.
 *
 * Listing is a read, and every sandbox mode permits reads (the policy fence
 * covers mutations only), so this route adds no gate the session did not
 * already have through `read`.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the session-controller service merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DSHELL_FILES_PATH, type DshellFileEntry, type DshellFilesListing, type DshellFilesRequest,
  type DshellFilesResponse,
} from './protocol.js'

/**
 * Entries one listing returns before it is reported truncated.
 *
 * A directory of this size is already unusable as a list, and the cap keeps one
 * request from pushing a whole tree through the browser in a single frame.
 */
const MAX_ENTRIES = 1000

/** JSON response in the shape the browser face parses. */
function respond(body: DshellFilesResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** One directory listing, read as the session that owns the world. */
async function list(
  ctx: Context,
  sessionId: string,
  path: string | undefined,
): Promise<DshellFilesListing> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
  const agent = resolved.agent
  const cwd = agent.session.header.cwd
  const start = path === undefined || path.trim().length === 0 ? cwd : path.trim()
  if (start === undefined) throw new Error('这个会话没有工作目录，且请求没有给出路径')
  const options = cwd === undefined ? {} : { cwd }

  // Every call is made as the session, synchronously entering the seam so the
  // provider reads the right initiator. The target it returns is canonical, and
  // its key is the absolute path in that world.
  const target = await ctx.agents.withInitiator(agent, () => ctx.fs.resolve(start, options))
  const info = await ctx.agents.withInitiator(agent, () => ctx.fs.stat(target))
  if (info === undefined) throw new Error(`目录不存在：${String(target.targetKey)}`)
  if (info.type !== 'directory') throw new Error(`不是目录：${String(target.targetKey)}`)
  const children = await ctx.agents.withInitiator(agent, () => ctx.fs.listDir(target))

  const entries: DshellFileEntry[] = children.slice(0, MAX_ENTRIES).map(child => ({
    name: child.name,
    kind: child.type,
    ...child.size === undefined ? {} : { size: child.size },
  }))
  return {
    path: String(target.targetKey),
    entries,
    truncated: children.length > MAX_ENTRIES,
  }
}

/** Bind the route to the filesystem seam. */
export function createFilesRoute(ctx: Context): ConnectionFetchRoute {
  const handle = async (request: Request): Promise<DshellFilesResponse> => {
    if (request.method === 'GET') return { error: '文件列表只接受 POST' }
    const input = await request.json() as DshellFilesRequest
    switch (input.action) {
      case 'list':
        return { listing: await list(ctx, input.sessionId, input.path) }
      default:
        return { error: '未知操作' }
    }
  }

  return {
    path: DSHELL_FILES_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ error: reason }, 400)
      }
    },
  }
}

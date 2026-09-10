/**
 * The dshell session-panel route: one exact `/api` endpoint behind dsh's
 * existing trust and authentication fence (the physical carrier rejects an
 * unauthenticated or cross-site request before this handler runs).
 *
 * Every response echoes the archive set, so the sidebar's snapshot stays
 * current with one round trip; business refusals travel as `error` on a 200
 * rather than as an HTTP failure — "this session is still running" is an
 * answer, not a transport fault. Only a missing or malformed request is a 4xx.
 *
 * The delete branch has three outcomes because dsh owns the session
 * lifecycle: a running session is refused outright, a loaded-but-idle one is
 * archived and scheduled (dshell frees its terminal memory now, the log goes
 * at the next start), and a cold one is purged immediately. See
 * session-list.ts for why the loaded case cannot be immediate.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { DSHELL_SESSIONS_PATH, type SessionRequest, type SessionResponse } from './protocol.js'
import { purgeSessionArtifacts } from './purge.js'
import type { SessionTagStore } from './tags.js'

/** What the route needs from the plugin that owns it. */
export interface SessionPanelDeps {
  /** The durable archive tag set. */
  readonly tags: SessionTagStore
  /** Whether a session is still loaded in this harness process. */
  readonly live: (sessionId: string) => boolean
  /** Whether a session currently has a turn in flight. */
  readonly running: (sessionId: string) => boolean
  /**
   * Free everything dshell holds for one session — its shell process, its
   * scrollback window and its block log. Called before a scheduled purge so
   * the memory goes now, while the log goes at the next start.
   */
  readonly release: (sessionId: string) => Promise<void>
}

/** JSON response in the shape the sidebar parses. */
function respond(body: SessionResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Bind the route to its owning plugin's tag store and session view. */
export function createSessionsRoute(deps: SessionPanelDeps): ConnectionFetchRoute {
  /** The archive set plus its scheduled qualifier: every response's payload. */
  const state = async (): Promise<Pick<SessionResponse, 'archived' | 'pendingPurge'>> => ({
    archived: await deps.tags.list(),
    pendingPurge: await deps.tags.pendingPurge(),
  })

  const handle = async (request: Request): Promise<SessionResponse> => {
    const input = request.method === 'GET'
      ? { action: 'list' } as const
      : await request.json() as SessionRequest
    switch (input.action) {
      case 'list':
        return await state()
      case 'archive':
        await deps.tags.archive(input.sessionId)
        return await state()
      case 'unarchive':
        await deps.tags.unarchive(input.sessionId)
        return await state()
      case 'delete': {
        const { sessionId } = input
        if (deps.running(sessionId)) {
          return { ...await state(), error: '会话正在运行，等它结束后再删除' }
        }
        if (deps.live(sessionId)) {
          // The log writer is live, so removing the directory now would only
          // have it recreated by the next event. Free what dshell owns, hide
          // the session, and let the next start remove the log.
          await deps.release(sessionId)
          await deps.tags.markPending(sessionId)
          return await state()
        }
        await purgeSessionArtifacts(sessionId)
        await deps.tags.forget(sessionId)
        return await state()
      }
      default:
        return { ...await state(), error: '未知操作' }
    }
  }

  return {
    path: DSHELL_SESSIONS_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ ...await state(), error: reason }, 400)
      }
    },
  }
}

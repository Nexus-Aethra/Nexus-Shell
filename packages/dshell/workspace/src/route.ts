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
import type { HostCopyParams } from '@nexus-aethra/dshell-std'
import { DSHELL_SESSIONS_PATH, type SessionRequest, type SessionResponse } from './protocol.js'
import { purgeSessionArtifacts } from './purge.js'
import type { SessionTagStore } from './tags.js'
import type { DshellWorkspaceHostKey } from './host-locales.js'

/** What the route needs from the plugin that owns it. */
export interface SessionPanelDeps {
  /**
   * This package's host copy, bound to the language the browser reported.
   *
   * A refusal here is rendered verbatim by the sidebar, so it must be written
   * in the language on screen: the host authors this text, the browser reads
   * it. See `host-locales.ts`.
   */
  readonly t: (key: DshellWorkspaceHostKey, params?: HostCopyParams) => string
  /** The durable archive tag set. */
  readonly tags: SessionTagStore
  /** Whether a session is still loaded in this harness process. */
  readonly live: (sessionId: string) => boolean
  /** Whether a session currently has a turn in flight. */
  readonly running: (sessionId: string) => boolean
  /**
   * Free everything dshell holds for one session — its shell process, its
   * scrollback window, its block log and its stored command history. Called for
   * every deletion, in both branches: the loaded one frees its memory now while
   * the log goes at the next start, and a session deleted before its terminal
   * was ever opened still has stored history to drop.
   */
  readonly release: (sessionId: string) => Promise<void>
  /**
   * Cut the session's cross-session state — pipes, unsettled tickets,
   * grants — in dshell-buffer before its record disappears. Optional: a
   * composition without dshell-buffer simply has nothing to detach.
   */
  readonly detach: ((sessionId: string) => Promise<void>) | undefined
  /**
   * Undo {@link detach} when a scheduled deletion is cancelled: the session
   * stays in dsh's list and its log is intact, so the pipe UI must offer it
   * again. Optional for the same reason as `detach`.
   */
  readonly restore: ((sessionId: string) => void) | undefined
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
  /**
   * The archive set plus its scheduled qualifier: every response's payload.
   *
   * The two reads are separate awaits, so a concurrent `markPending` can land
   * between them and report a pending id the archive half does not carry. The
   * sidebar's row split cannot represent that pair — the session would appear
   * in the active list and in `待删除` at once — so the response repairs the
   * `pendingPurge ⊆ archived` invariant the client relies on.
   */
  const state = async (): Promise<Pick<SessionResponse, 'archived' | 'pendingPurge'>> => {
    const archived = await deps.tags.list()
    const pendingPurge = (await deps.tags.pendingPurge()).filter(id => archived.includes(id))
    return { archived, pendingPurge }
  }

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
        // Cancelling a scheduled deletion also un-hides the session in the pipe
        // UI: dsh still lists it and the log survives, so it is live again.
        deps.restore?.(input.sessionId)
        return await state()
      case 'delete': {
        const { sessionId } = input
        if (deps.running(sessionId)) {
          return { ...await state(), error: deps.t('error.running') }
        }
        // The pipes die with the session in both branches: a live one is
        // still resolvable until restart, so detaching first also stops it
        // receiving delegations in its pending-purge window.
        await deps.detach?.(sessionId)
        // Then dshell's own memory, in both branches — and deliberately before
        // the branch, because the history purge must not depend on the bridge
        // having a record for this session.
        await deps.release(sessionId)
        if (deps.live(sessionId)) {
          // The log writer is live, so removing the directory now would only
          // have it recreated by the next event. Hide the session and let the
          // next start remove the log.
          await deps.tags.markPending(sessionId)
          return await state()
        }
        await purgeSessionArtifacts(sessionId)
        await deps.tags.forget(sessionId)
        return await state()
      }
      default:
        return { ...await state(), error: deps.t('error.unknownAction') }
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

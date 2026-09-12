/**
 * dshell-workspace host face — design decision 4.7.
 *
 * Two things live here:
 *
 * 1. The `workspaceRegistry` stand-in. The stock web-app `workspace` row is
 *    disabled, and session-controller's inject would stay pending forever
 *    without a same-key service. The registry is not simulated: `get()`
 *    always misses and `list()` is always empty, which is the honest
 *    projection of a shell that has no workspaces. dshell session creation
 *    never passes a workspaceId (sessions are created by cwd, design 4.7),
 *    so the rejection paths stay cold in normal operation.
 * 2. The session panel's durable state: the archive tag set the sidebar's
 *    collapsed group reads, and the history purge behind its delete action.
 *    dsh's own archive lives on the disabled workspace registry, so dshell
 *    keeps its own tags (see protocol.ts). A purge that could not run yet
 *    (the session was still loaded) is drained here at load, before any
 *    session can be resumed.
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the agents service merge (ctx.agents).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the host connection merge (ctx.connection.fetch).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the `dshellBuffer` service merge the delete branch uses to
// detach a session's pipes.
import type {} from '@deepseek-ai/dsh-dshell-buffer'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSessionsRoute } from './route.js'
import { dshHome, drainPendingPurges } from './purge.js'
import { SessionTagStore } from './tags.js'

export const name = '@deepseek-ai/dsh-dshell-workspace'

/** `workspaceRegistry` stand-in: every lookup misses, every mutation rejects. */
class DshellWorkspaceRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  get(): undefined {
    return undefined
  }

  list(): readonly never[] {
    return []
  }

  get archivedSessionIds(): readonly never[] {
    return []
  }

  async create(): Promise<never> {
    throw new Error('dshell: workspaces are removed (dshell design 4.7)')
  }

  async delete(): Promise<boolean> {
    return false
  }

  async insertBefore(): Promise<readonly never[]> {
    return []
  }

  async archiveSession(): Promise<void> {}

  async resolveByPath(): Promise<undefined> {
    return undefined
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(DshellWorkspaceRegistry)
  const tags = new SessionTagStore(join(dshHome(), 'dshell', 'tags.json'))
  // Load-time drain: purges scheduled while their sessions were loaded. This
  // runs during composition, before a client can resume anything, which is
  // the only window where those log writers are guaranteed gone.
  void drainPendingPurges(tags)
  ctx.inject(['sessions', 'agents', 'connection'], (panelCtx) => {
    // This package compiles its host and client halves in one program, so the
    // client contract's `Context.sessions` (ISessions) merges over the host
    // SessionStore declaration and hides `get`. The service really is the
    // host store — the route table below only ever registers from here.
    const hostSessions = panelCtx.sessions as unknown as { get(id: SessionId): unknown }
    const agents = panelCtx.agents as unknown as {
      get(id: SessionId): { status?: string } | undefined
    }
    const route = createSessionsRoute({
      tags,
      // A session still in the host store has a live log writer: its
      // directory would be recreated by the next event, so its purge is
      // scheduled instead of attempted (see route.ts).
      live: sessionId => hostSessions.get(sessionId as SessionId) !== undefined,
      running: sessionId => agents.get(sessionId as SessionId)?.status === 'running',
      // Optional: the PTY bridge is a sibling row, so a deployment without it
      // simply has no shell memory to free.
      release: async (sessionId) => {
        panelCtx.get('dshellTerminalBridge')?.releaseSession(sessionId)
      },
      // Optional for the same reason: without dshell-buffer the session has
      // no pipes to detach, and deletion proceeds without them.
      detach: async (sessionId) => {
        await panelCtx.get('dshellBufferCore')?.detachSession(sessionId)
      },
    })
    panelCtx.effect(
      () => panelCtx.connection.fetch.register(route),
      'dshell-workspace: session panel route',
    )
  })
}

export default { name, apply }

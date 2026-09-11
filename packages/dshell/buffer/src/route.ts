/**
 * The pipe route: one exact `/api` endpoint behind dsh's existing trust and
 * authentication fence, mirroring the session panel's shape.
 *
 * This is where links are created and revoked. Deliberately not a tool: the
 * plan gives the user sole authority over which sessions are connected, so the
 * browser face is the only caller that reaches these operations.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_BUFFER_PATH, type BufferRequest, type BufferResponse, type BufferState } from './protocol.js'
import type { BufferService } from './service.js'

/** What the route needs from the plugin that owns it. */
export interface BufferRouteDeps {
  readonly service: BufferService
  /** Host context, kept for parity with the other dshell routes. */
  readonly ctx: Context
}

/** JSON response in the shape the pipe panel parses. */
function respond(body: BufferResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Bind the route to the buffer service. */
export function createBufferRoute(deps: BufferRouteDeps): ConnectionFetchRoute {
  const state = (): BufferState => deps.service.snapshot()

  const handle = async (request: Request): Promise<BufferResponse> => {
    const input = request.method === 'GET'
      ? { action: 'state' } as const
      : await request.json() as BufferRequest
    switch (input.action) {
      case 'state':
        return state()
      case 'link':
        await deps.service.createLink(input.a, input.b, input.label)
        return state()
      case 'unlink':
        await deps.service.removeLink(input.linkId)
        return state()
      case 'revoke':
        await deps.service.revokeGrant(input.grantId)
        return state()
      case 'cancel':
        await deps.service.cancelByUser(input.ticketId)
        return state()
      default:
        return { ...state(), error: '未知操作' }
    }
  }

  return {
    path: DSHELL_BUFFER_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ ...state(), error: reason }, 400)
      }
    },
  }
}

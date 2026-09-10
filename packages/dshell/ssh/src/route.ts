/**
 * The SSH device route: one exact `/api` endpoint behind dsh's existing trust
 * and authentication fence, mirroring the session panel's shape.
 *
 * It carries the operations that must not live in the settings document —
 * storing a private key, testing a connection — and reports the device list
 * plus the session assignments after every request, so the UI's snapshot is
 * always the committed one.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import { DSHELL_SSH_PATH, type SshRequest, type SshResponse } from './protocol.js'
import type { SshRouter } from './router.js'

/** What the route needs from the plugin that owns it. */
export interface SshRouteDeps {
  readonly router: SshRouter
  /** Host context, so the connection test can spawn a process. */
  readonly ctx: Context
}

/** JSON response in the shape the device UI parses. */
function respond(body: SshResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Bind the route to the device registry. */
export function createSshRoute(deps: SshRouteDeps): ConnectionFetchRoute {
  const state = async (): Promise<Omit<SshResponse, 'error' | 'testResult'>> => ({
    devices: await deps.router.list(),
    bindings: await deps.router.assignments(),
  })

  const handle = async (request: Request): Promise<SshResponse> => {
    const input = request.method === 'GET'
      ? { action: 'list' } as const
      : await request.json() as SshRequest
    switch (input.action) {
      case 'list':
        return await state()
      case 'save':
        await deps.router.saveDevice(input.device)
        return await state()
      case 'delete':
        await deps.router.removeDevice(input.deviceId)
        return await state()
      case 'test':
        return { ...await state(), testResult: await deps.router.test(input.deviceId, deps.ctx) }
      case 'mount':
        return { ...await state(), mountPath: await deps.router.mountPath(input.deviceId, input.remoteRoot ?? null) }
      case 'bind':
        // The remote directory is created inside `bind`, before the assignment
        // is recorded: the assignment is what makes a session routable, and the
        // shell it starts must not find the directory still missing.
        await deps.router.bind(
          input.sessionId,
          input.deviceId,
          input.remoteRoot ?? null,
          input.mount ?? null,
          deps.ctx,
        )
        return await state()
      default:
        return { ...await state(), error: '未知操作' }
    }
  }

  return {
    path: DSHELL_SSH_PATH,
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

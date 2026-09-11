/**
 * dshell-buffer host face: the cross-session pipe.
 *
 * One service owns the whole feature — links the user established, the deferred
 * requests travelling over them, the scoped grants those requests carry, and
 * the watchdog that settles anything nobody settled. This entry point only
 * wires it up: the model-facing tool, the prompt section that teaches the
 * protocol, and the `/api` route the pipe panel talks to.
 *
 * `connection` is injected separately because a composition may mount this
 * package without a browser face; the service itself then still runs.
 */

import type { Context } from '@deepseek-ai/cordis'
import { BUFFER_PROMPT_TEXT } from './prompt.js'
import { createBufferRoute } from './route.js'
import { BufferService } from './service.js'
import { registerBufferTool } from './tool.js'

export const name = '@deepseek-ai/dsh-dshell-buffer'

export { DSHELL_BUFFER_PATH } from './protocol.js'
export type {
  BufferArea,
  BufferGrant,
  BufferLink,
  BufferReport,
  BufferRequest,
  BufferResponse,
  BufferRight,
  BufferState,
  BufferTicket,
  BufferTicketState,
} from './protocol.js'
export { BufferService } from './service.js'

/**
 * The section order the prompt paragraph takes: right after `TOOL_JOBS`, in the
 * run of tool-usage sections. A literal rather than `getSectionOrder` because
 * this is not one of dsh's reserved names.
 */
const PROMPT_ORDER = 1650

export function apply(ctx: Context): void {
  ctx.inject(['tools', 'systemPrompt', 'fs', 'sessionController', 'agents'], (bufferCtx) => {
    const service = new BufferService(bufferCtx)

    bufferCtx.effect(() => {
      service.start()
      return () => { service.dispose() }
    }, 'dshell-buffer: watchdog')

    bufferCtx.effect(() => registerBufferTool(bufferCtx, service), 'dshell-buffer: tool')

    bufferCtx.effect(() => bufferCtx.systemPrompt.section({
      name: 'tool:dshell-buffer',
      order: PROMPT_ORDER,
      text: BUFFER_PROMPT_TEXT,
    }), 'dshell-buffer: prompt section')

    // The route needs the same service instance, so it is registered from
    // inside this injection rather than from a second `apply`-level inject.
    bufferCtx.inject(['connection'], (routeCtx) => {
      routeCtx.effect(
        () => routeCtx.connection.fetch.register(createBufferRoute({ service, ctx: routeCtx })),
        'dshell-buffer: pipe route',
      )
    })
  })
}

export default { name, apply }

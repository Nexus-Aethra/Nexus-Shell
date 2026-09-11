/**
 * dshell-buffer browser face: the pipe panel in the frame-wide overlay seat,
 * and the `dshellBuffer` service other client bundles open it through.
 *
 * The panel enters `shell.overlay` — the additive, click-through frame layer —
 * rather than replacing anything, so a composition that omits this package
 * simply has one fewer floating surface. The sidebar entry that opens it lives
 * in dshell-workspace and reaches the service by injection, which is the only
 * collaboration path between client bundles.
 */

import { type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's SlotMap merge (the `shell.overlay` seat).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { PipePanel } from './panel.js'
import { BufferClientService, type SessionSeat } from './service.js'

export const name = '@deepseek-ai/dsh-dshell-buffer/client'

export const inject = ['slots'] as const

export type { BufferSnapshot, SessionSeat } from './service.js'
export type { PipePanelProps } from './panel.js'

/** A permanently empty list, for the frames before the sessions service arrives. */
const EMPTY_SESSIONS: ReturnType<SessionSeat['getSnapshot']> = { ids: [], byId: {}, current: undefined }

export function apply(ctx: Context): void {
  const buffer = new BufferClientService(ctx)
  void buffer.load()

  // The sessions service may be provided by a sibling row that activates after
  // this one, so it is resolved by injection rather than read once at apply
  // time. The seat is a stable facade over a mutable holder: the panel's props
  // never change identity, and the panel re-renders on whatever the live store
  // publishes.
  let sessions: ISessions | undefined
  ctx.inject(['sessions'], (sessionCtx) => {
    sessions = sessionCtx.get('sessions') as unknown as ISessions
  })
  const sessionsSeat: SessionSeat = {
    getSnapshot: () => sessions?.list.getSnapshot() ?? EMPTY_SESSIONS,
    subscribe: (listener) => sessions?.list.subscribe(listener) ?? (() => {}),
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'dshell-buffer',
      order: 100,
      label: '管道',
      inject: () => ({ buffer, sessions: sessionsSeat }),
    },
    PipePanel,
  ))
}

export default { name, inject, apply }

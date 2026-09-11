/**
 * The browser half's pipe state: one snapshot of links, tickets and grants,
 * refreshed from the route after every mutation, plus the panel's open state.
 *
 * The open state lives here rather than inside the panel component because the
 * sidebar's entry button (dshell-workspace) is a different bundle and cannot
 * value-import this one; it reaches the toggle through the `dshellBuffer`
 * service, exactly as dshell-workspace reaches dshell-ssh.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  DSHELL_BUFFER_PATH, type BufferGrant, type BufferLink, type BufferRequest, type BufferResponse,
  type BufferTicket,
} from '../protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-session pipe state provided by dshell-buffer's browser half. */
    dshellBuffer: BufferClientService
  }
}

/** What the pipe panel renders from. */
export interface BufferSnapshot {
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  readonly grants: readonly BufferGrant[]
  /** The last refusal or transport failure, shown until the next call. */
  readonly error: string | undefined
  /** Whether the host has answered at least once. */
  readonly loaded: boolean
  /** Whether the pipe panel is on screen. */
  readonly open: boolean
}

const EMPTY: BufferSnapshot = {
  links: [], tickets: [], grants: [], error: undefined, loaded: false, open: false,
}

/** How often an open panel re-reads the state, so progress is visible live. */
const POLL_MS = 3000

/** The slice of the session list the panel renders peer labels from. */
export interface SessionSeat {
  getSnapshot: () => {
    readonly ids: readonly string[]
    readonly byId: Record<string, { readonly displayTitle: string; readonly cwd?: string | undefined }>
    readonly current: string | undefined
  }
  subscribe: (listener: () => void) => () => void
}

/** Pipe state mirror plus its mutations. */
export class BufferClientService extends Service {
  private snapshot: BufferSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private poll: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context) {
    super(ctx, 'dshellBuffer')
  }

  getSnapshot = (): BufferSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Open or close the pipe panel; opening starts the refresh poll. */
  setOpen(open: boolean): void {
    if (this.snapshot.open === open) return
    this.publish({ ...this.snapshot, open })
    if (open) {
      void this.load()
      if (this.poll === undefined) {
        this.poll = setInterval(() => { void this.load() }, POLL_MS)
      }
    } else if (this.poll !== undefined) {
      clearInterval(this.poll)
      this.poll = undefined
    }
  }

  /** Flip the panel's open state. */
  toggle(): void {
    this.setOpen(!this.snapshot.open)
  }

  /** Read the committed state. */
  async load(): Promise<void> {
    await this.send({ action: 'state' })
  }

  /** Connect two sessions. Only the user may do this. */
  async link(a: string, b: string, label?: string): Promise<void> {
    await this.send({ action: 'link', a, b, ...label === undefined || label === '' ? {} : { label } }, { strict: true })
  }

  /** Remove a pipe. Outstanding tickets keep running. */
  async unlink(linkId: string): Promise<void> {
    await this.send({ action: 'unlink', linkId }, { strict: true })
  }

  /** Revoke a grant immediately, releasing its remaining references. */
  async revoke(grantId: string): Promise<void> {
    await this.send({ action: 'revoke', grantId }, { strict: true })
  }

  /** Withdraw an outstanding ticket. */
  async cancel(ticketId: string): Promise<void> {
    await this.send({ action: 'cancel', ticketId }, { strict: true })
  }

  /** Clear the last error line. */
  clearError(): void {
    if (this.snapshot.error === undefined) return
    this.publish({ ...this.snapshot, error: undefined })
  }

  /**
   * One route call. The refusal is always published so the panel shows it;
   * `strict` additionally throws it, for callers whose flow must not continue.
   * @param request - request body; `state` travels as a GET.
   * @param options - `strict` rethrows the refusal after publishing it.
   * @returns the response body, or a body synthesized from a transport failure.
   */
  private async send(request: BufferRequest, options?: { strict?: boolean }): Promise<BufferResponse> {
    const strict = options?.strict === true
    let body: BufferResponse
    try {
      const response = await fetch(DSHELL_BUFFER_PATH, {
        method: request.action === 'state' ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...request.action === 'state' ? {} : { body: JSON.stringify(request) },
      })
      body = await response.json() as BufferResponse
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.publish({ ...this.snapshot, error: reason })
      if (strict) throw new Error(reason)
      return { ...this.snapshot, error: reason }
    }
    this.publish({
      links: body.links,
      tickets: body.tickets,
      grants: body.grants,
      error: body.error,
      loaded: true,
      open: this.snapshot.open,
    })
    if (strict && body.error !== undefined) throw new Error(body.error)
    return body
  }

  private publish(snapshot: BufferSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

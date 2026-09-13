/**
 * Client half of the dshell session panel: the archive tag set plus the
 * archive/restore/delete calls, over the package's own `/api/dshell/sessions`
 * route (see ../protocol.ts).
 *
 * The snapshot is a cached object so `useSyncExternalStore` can compare it by
 * identity; every response replaces it wholesale with the tag set the host
 * just committed, which keeps one round trip authoritative.
 */

import { DSHELL_SESSIONS_PATH, type SessionRequest, type SessionResponse } from '../protocol.js'

/** What the sidebar renders from. */
export interface ArchiveSnapshot {
  /** Archived session ids, in host archive order. */
  readonly archived: readonly string[]
  /**
   * Archived ids whose removal is scheduled for the next start: the session
   * was still loaded, so dsh's open log writer would have recreated a deleted
   * directory. The row says so instead of pretending the history is gone.
   */
  readonly pending: readonly string[]
  /** Set while a tag or purge is in flight, so the list can settle first. */
  readonly busy: boolean
  /**
   * Whether a host answer has arrived at least once. Boot navigation waits for
   * this: opening the most recent session is wrong if that session turns out
   * to be archived.
   */
  readonly loaded: boolean
  /** The last refusal, shown until the next successful call. */
  readonly error: string | undefined
}

const EMPTY: ArchiveSnapshot = { archived: [], pending: [], busy: false, loaded: false, error: undefined }

/** Archive tags and session purge, from the sidebar's point of view. */
export class SessionPanelClient {
  private snapshot: ArchiveSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): ArchiveSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read the tag set; a transport failure leaves the current one in place. */
  async load(): Promise<void> {
    await this.send({ action: 'list' })
  }

  /** Tag a session as archived (it leaves the active list). */
  async archive(sessionId: string): Promise<void> {
    await this.send({ action: 'archive', sessionId })
  }

  /** Remove the archive tag (the session returns to the active list). */
  async unarchive(sessionId: string): Promise<void> {
    await this.send({ action: 'unarchive', sessionId })
  }

  /**
   * Purge one session's history, agent log and shell log together.
   * @returns the refusal message when the host declined, else undefined.
   */
  async remove(sessionId: string): Promise<string | undefined> {
    await this.send({ action: 'delete', sessionId })
    return this.snapshot.error
  }

  /** Clear the last refusal (dialog close). */
  clearError(): void {
    if (this.snapshot.error === undefined) return
    this.publish({ ...this.snapshot, error: undefined })
  }

  private async send(request: SessionRequest): Promise<void> {
    this.publish({ ...this.snapshot, busy: true, error: undefined })
    try {
      const response = await fetch(DSHELL_SESSIONS_PATH, {
        method: request.action === 'list' ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...request.action === 'list' ? {} : { body: JSON.stringify(request) },
      })
      const body = await response.json() as SessionResponse
      // A business refusal still carries the current tag set: adopt it, and
      // surface the message. A transport-level failure (non-JSON, 5xx) lands
      // in the catch instead.
      this.publish({
        archived: body.archived,
        pending: body.pendingPurge ?? [],
        busy: false,
        loaded: true,
        error: body.error,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.publish({ ...this.snapshot, busy: false, error: reason })
    }
  }

  private publish(snapshot: ArchiveSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

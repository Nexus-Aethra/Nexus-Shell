/**
 * The storage contract: what a dshell store *is*, with no medium attached.
 *
 * dshell has one durable store for shell history today and a reason to expect
 * more (agent-facing records that want indexes). The split that keeps that from
 * becoming each feature's private file format:
 *
 *   - **the contract** lives here — the record shape, the store surface, the
 *     on-disk naming and layout version, and the failure vocabulary;
 *   - **the medium** lives in `@nexus-aethra/dshell-storage` (`node:sqlite`);
 *   - **a feature** only calls the store, and never names a file, a pragma or a
 *     schema.
 *
 * Nothing here may import a Node builtin: `std` is inlined into client bundles,
 * so this file has to stay an isomorphic declaration. The engine is host-only
 * for exactly that reason — `node:sqlite` cannot cross into a browser bundle.
 */

/** File name of the shared database inside a log directory. */
export const HISTORY_STORE_FILENAME = 'history.sqlite'

/**
 * Physical layout version of the history database, stamped in
 * `PRAGMA user_version`.
 *
 * A database stamped with anything else is rejected rather than migrated: this
 * code is the only producer, and history is a convenience the user may lose
 * without losing a session.
 */
export const HISTORY_STORE_SCHEMA_VERSION = 1

/** Why a store could not be used; the caller decides whether to fall back. */
export type HistoryStoreErrorCode = 'open-failed' | 'version-mismatch'

/** A store that cannot be opened, or was written by another layout. */
export class HistoryStoreError extends Error {
  constructor(readonly code: HistoryStoreErrorCode, message: string) {
    super(message)
    this.name = 'HistoryStoreError'
  }
}

/**
 * One completed command, as stored.
 *
 * The shape every producer already had; it is a contract now because both the
 * writer (the terminal bridge) and the readers (the history route, and later an
 * agent-facing query) have to agree on it without importing each other.
 */
export interface HistoryRecord {
  /** Monotonic within the shell generation that produced it. */
  readonly seq: number
  /** The line as the user ran it; this is what a caller shows and re-applies. */
  readonly command: string
  /** The shell's exit status, or null when it never reported one. */
  readonly exitCode: number | null
  /** Epoch ms the command finished. */
  readonly at: number
}

/**
 * The durable history of every session under one store.
 *
 * Deliberately small and query-shaped rather than a generic KV: the two things
 * the feature needs — the newest N of one session, and the commands sharing a
 * prefix with what the user has typed — are exactly the two operations a medium
 * can index for. A `loadAll`-style surface would put the whole history in memory
 * on every read, which is the problem this store exists to remove.
 *
 * `sessionId` is the caller's own session identity; a store keys rows by it.
 */
export interface HistoryStore {
  /** Absolute path of the backing medium, for diagnostics. */
  readonly path: string
  /** Insert a batch; an already-stored `(session, seq)` is left as it is. */
  append(sessionId: string, commands: readonly HistoryRecord[]): void
  /** The newest `limit` commands of one session, oldest first. */
  recent(sessionId: string, limit: number): HistoryRecord[]
  /**
   * Commands that *start with* `draft`, case-insensitively — the newest `limit`
   * of them, in timeline order.
   *
   * Timeline order (oldest first) is the same convention as {@link recent}, so a
   * caller filters a history without reordering it: the shell's own gesture
   * shows the newest command at the bottom and walks upward into the past.
   *
   * Strict prefix on purpose: every match shares the whole draft, so there is
   * no "longer prefix" left to rank by — recency is the only meaningful order,
   * and one range query answers it. An empty draft has no prefix at all, so it
   * answers as {@link recent}.
   *
   * Fuzzy ranking (a draft of `g` listing `git …` above `grep …`) is a different
   * query: the caller ranks a bounded candidate set by shared-prefix length.
   */
  matchPrefix(sessionId: string, draft: string, limit: number): HistoryRecord[]
  /** Drop one session's history — the `/clear` epoch. */
  clearSession(sessionId: string): void
  /** How many commands one session has stored. */
  count(sessionId: string): number
  /** Release the medium. Idempotent. */
  close(): void
}

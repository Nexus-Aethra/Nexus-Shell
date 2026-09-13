/**
 * The SQLite command-history medium: one database per log directory, holding
 * every session's completed commands.
 *
 * Implements the {@link HistoryStore} contract from `@nexus-aethra/dshell-std`.
 * The engine is Node's built-in `node:sqlite`: no native dependency, no install
 * script, and FTS5 is present on both the host runtime and the packaged desktop
 * runtime (v24.17.0, verified with `sqlite_compileoption_used('ENABLE_FTS5')`),
 * which is what a later full-text search over history would need.
 *
 * Why a table instead of the per-session `.history.json` array this replaces:
 * that array has no index, so a read parsed the whole thing into memory and a
 * write rewrote it in full, and the only way to keep it bounded was to drop the
 * oldest commands at a fixed cap — lossy exactly where a query would want them.
 *
 * Format — `PRAGMA user_version = 1` as the contract declares; a database
 * stamped with anything else rejects rather than migrating.
 *
 *   commands(session_id, seq, command, command_norm, exit_code, at)
 *     PRIMARY KEY (session_id, seq)
 *       the shell's own numbering, continued across restarts — `clearSession`
 *       deletes a whole session's rows when that session is deleted
 *   commands_session_prefix(session_id, command_norm)
 *   commands_at(at)
 *
 * `command_norm` is the lower-cased command and exists for the prefix index:
 * prefix matching is case-insensitive by design, the way a shell's own history
 * search is. `command` keeps the original text, which is what gets shown and
 * what replaces the draft.
 *
 * Four measured facts shape the queries; each was confirmed with
 * `EXPLAIN QUERY PLAN` and timings against this exact schema at 200k commands
 * in one session:
 *
 * - `LIKE ?` with a bound prefix argument never uses the prefix index: SQLite
 *   refuses the LIKE optimization for a bound parameter, so with a session
 *   filter the plan degrades to `SEARCH … USING INDEX commands_session_prefix
 *   (session_id=?)` — the index serves the session term and every one of that
 *   session's rows is tested against the pattern. The range form
 *   `command_norm >= ? AND command_norm < ?` turns the prefix itself into an
 *   index seek.
 * - The range form alone is not enough, because the index is ordered by
 *   `command_norm` while "the newest matches" is ordered by `seq`: the plan
 *   gains `USE TEMP B-TREE FOR ORDER BY` and sorts *every* match, so a
 *   20k-match prefix cost 9.1 ms and a 10k-match one 4.7 ms. Scanning newest
 *   first instead — the primary key's `(session_id, seq)` order plus
 *   `ORDER BY seq DESC LIMIT` — lets SQLite stop as soon as enough matches are
 *   seen and cost 0.11 ms / 0.23 ms for the same answers. It is bounded by
 *   {@link PREFIX_SCAN_BUDGET} rows and falls back to the range seek, which is
 *   the cheap one for a sparse prefix (0.005 ms with no match).
 * - `PRAGMA synchronous = NORMAL` under WAL: history is best-effort by an
 *   existing contract ("losing a line of history must never cost the session
 *   anything"), and the session event log owns real durability.
 *
 * The composer's up-arrow gesture sends its draft here (the route maps the wire
 * request onto {@link HistoryStore.matchPrefix}), so the first-character filter
 * that used to run in `mode` — `commonPrefix(command, query) > 0`, which listed
 * `grep -r git .` for a draft of `git` — is gone. Strict prefix is the whole
 * matching rule now, in the store and in the client's fallback window.
 */

import { mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  HISTORY_STORE_SCHEMA_VERSION,
  HistoryStoreError,
  type HistoryRecord,
  type HistoryStore,
} from '@nexus-aethra/dshell-std'

/** The row shape `node:sqlite` hands back for the select statements below. */
interface CommandRow {
  readonly seq: number
  readonly command: string
  readonly exit_code: number | null
  readonly at: number
}

/**
 * How many of a session's newest commands a prefix search scans before it gives
 * up on the newest-first path and lets the range seek answer.
 *
 * The scan wants the newest matches, and matches are usually dense near the
 * draft (a shell repeats what it has run), so a few thousand rows cover the
 * normal case at a bounded cost. A sparse prefix is the case the range seek
 * exists for, and it is the *cheap* path there. Measured at 200k rows in one
 * session: 5000 keeps every dense draft under 0.25 ms, and the miss case (scan
 * 5000, find nothing, fall back) at 0.68 ms.
 */
const PREFIX_SCAN_BUDGET = 5_000

/**
 * The exclusive upper bound of every string starting with `prefix`.
 *
 * Returns undefined when no bound exists (a prefix of only U+FFFF units), which
 * the caller answers with an open-ended range.
 */
function prefixUpperBound(prefix: string): string | undefined {
  let end = prefix.length
  while (end > 0 && prefix.charCodeAt(end - 1) === 0xffff) end -= 1
  if (end === 0) return undefined
  const last = prefix.charCodeAt(end - 1)
  return prefix.slice(0, end - 1) + String.fromCharCode(last + 1)
}

/** Create the database file owner-only before SQLite opens it by path. */
function createFilePrivate(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    // Command history routinely contains secrets typed on a command line, and
    // the surrounding log directory is group- and world-readable by default.
    closeSync(openSync(path, 'wx', 0o600))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Apply pragmas and the schema, rejecting a foreign layout version. */
function initSchema(db: DatabaseSync, path: string): void {
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  const version = Number(row?.user_version ?? 0)
  if (version === HISTORY_STORE_SCHEMA_VERSION) return
  if (version !== 0) {
    throw new HistoryStoreError('version-mismatch', `${path} carries history layout ${String(version)}, expected ${String(HISTORY_STORE_SCHEMA_VERSION)}`)
  }
  db.exec(`
    CREATE TABLE commands (
      session_id   TEXT    NOT NULL,
      seq          INTEGER NOT NULL,
      command      TEXT    NOT NULL,
      command_norm TEXT    NOT NULL,
      exit_code    INTEGER,
      at           INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX commands_session_prefix ON commands (session_id, command_norm);
    CREATE INDEX commands_at ON commands (at);
    PRAGMA user_version = ${String(HISTORY_STORE_SCHEMA_VERSION)};
  `)
}

/** Map a database row to the contract's record shape. */
function toRecord(row: CommandRow): HistoryRecord {
  return {
    seq: Number(row.seq),
    command: String(row.command),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    at: Number(row.at),
  }
}

/**
 * Reinterpret `node:sqlite`'s `Record<string, SQLOutputValue>` rows as the
 * column shape the select statements above project. The driver types every row
 * as a generic record because it cannot know the projection; the statements are
 * written next to this function, so the shape is true by construction.
 */
function asRows(values: readonly unknown[]): CommandRow[] {
  return values as unknown as CommandRow[]
}

/** Open the database at `path` and prepare its statements. */
function openStore(path: string): HistoryStore {
  let db: DatabaseSync
  try {
    if (path !== ':memory:') createFilePrivate(path)
    db = new DatabaseSync(path)
    initSchema(db, path)
  }
  catch (error) {
    if (error instanceof HistoryStoreError) throw error
    throw new HistoryStoreError('open-failed', `${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO commands (session_id, seq, command, command_norm, exit_code, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const newest = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? ORDER BY seq DESC LIMIT ?
  `)
  const band = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND command_norm >= ? AND command_norm < ?
    ORDER BY seq DESC LIMIT ?
  `)
  const bandOpen = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND command_norm >= ?
    ORDER BY seq DESC LIMIT ?
  `)
  // The newest-first variants: `seq > ?` keeps the primary key's
  // `(session_id, seq)` order usable, so ORDER BY seq DESC needs no sort and
  // LIMIT stops the scan early.
  const bounded = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND seq > ? AND command_norm >= ? AND command_norm < ?
    ORDER BY seq DESC LIMIT ?
  `)
  const boundedOpen = db.prepare(`
    SELECT seq, command, exit_code, at FROM commands
    WHERE session_id = ? AND seq > ? AND command_norm >= ?
    ORDER BY seq DESC LIMIT ?
  `)
  const head = db.prepare('SELECT max(seq) AS s FROM commands WHERE session_id = ?')
  const drop = db.prepare('DELETE FROM commands WHERE session_id = ?')
  const tally = db.prepare('SELECT count(*) AS n FROM commands WHERE session_id = ?')
  let closed = false

  return {
    path,

    append(sessionId, commands) {
      if (closed || commands.length === 0) return
      // One transaction per batch: the caller hands over a burst of finished
      // commands, and WAL makes the group barely more expensive than one row.
      db.exec('BEGIN')
      try {
        for (const item of commands) {
          insert.run(sessionId, item.seq, item.command, item.command.toLowerCase(), item.exitCode, item.at)
        }
        db.exec('COMMIT')
      }
      catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },

    recent(sessionId, limit) {
      if (closed || limit <= 0) return []
      // The statement orders newest-first so LIMIT keeps the newest; the shell
      // wants them oldest-first, which is a reverse of a bounded array.
      return asRows(newest.all(sessionId, limit)).map(toRecord).reverse()
    },

    matchPrefix(sessionId, draft, limit) {
      if (closed || limit <= 0) return []
      const norm = draft.toLowerCase()
      if (norm.length === 0) return this.recent(sessionId, limit)
      // Strict prefix, not a descending probe: under `startsWith` every match
      // shares the whole draft, so "longest shared prefix" has nothing to rank —
      // recency is the only meaningful order. (Ranking by partial overlap would
      // be fuzzy matching, where `grep` deserves to sit below `git` for a draft
      // of `g`; that is a different query and belongs with the caller, over a
      // bounded candidate set.)
      const upper = prefixUpperBound(norm)
      // Newest-first first: the answer is the newest `limit` matches, and the
      // primary key's order is already the order they are wanted in, so the scan
      // can stop the moment it has enough. `limit` matches inside the newest
      // budget *are* the newest `limit` matches, which is why this path needs no
      // tie-break with the range query below.
      const newestSeq = (head.get(sessionId) as { s?: number | null } | undefined)?.s ?? null
      if (newestSeq !== null) {
        const floor = newestSeq - Math.max(PREFIX_SCAN_BUDGET, limit * 4)
        const scanned = asRows(upper === undefined
          ? boundedOpen.all(sessionId, floor, norm, limit)
          : bounded.all(sessionId, floor, norm, upper, limit))
        if (scanned.length >= limit) return scanned.map(toRecord).reverse()
      }
      // Sparse or absent prefix: the range seek answers from the index, and with
      // few matches the sort the plan adds costs nothing.
      return asRows(upper === undefined
        ? bandOpen.all(sessionId, norm, limit)
        : band.all(sessionId, norm, upper, limit)).map(toRecord).reverse()
    },

    clearSession(sessionId) {
      if (closed) return
      drop.run(sessionId)
    },

    count(sessionId) {
      if (closed) return 0
      const row = tally.get(sessionId) as { n?: number } | undefined
      return Number(row?.n ?? 0)
    },

    close() {
      if (closed) return
      closed = true
      stores.delete(path)
      try {
        db.close()
      }
      catch {
        // Closing a handle whose file is already gone is not a caller problem.
      }
    },
  }
}

/** Open stores by path, so every session in one process shares a handle. */
const stores = new Map<string, HistoryStore>()

/**
 * Open (or reuse) the store for one database path.
 *
 * Sessions in one process share a single handle: a per-session connection would
 * multiply file handles and turn concurrent writes into lock contention for no
 * benefit, since `node:sqlite` is synchronous.
 * @param path - Database file path, or `:memory:` for a throwaway store.
 * @returns The shared store.
 * @throws {HistoryStoreError} when the file cannot be opened or its layout differs.
 */
export function openHistoryStore(path: string): HistoryStore {
  const key = path === ':memory:' ? path : resolve(path)
  const existing = stores.get(key)
  if (existing !== undefined) return existing
  const store = openStore(key)
  stores.set(key, store)
  return store
}

/** Close and forget one path's store; the bridge teardown path. */
export function closeHistoryStore(path: string): void {
  const key = path === ':memory:' ? path : resolve(path)
  stores.get(key)?.close()
}

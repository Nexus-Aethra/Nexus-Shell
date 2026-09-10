/**
 * Session history purge — the destructive half of the sidebar's session
 * menu ("delete" clears the record, agent half included).
 *
 * dsh has no delete API, and its storage layout is an implementation detail
 * this package must not reimplement: the session directory is keyed by a
 * slug of the session's cwd, which only the persistence backend knows how to
 * derive. So the purge locates the directory by id instead of by name —
 * every shard under `sessions/` is scanned for a child named after the
 * session — and takes the projection cache and the dshell PTY artifacts with
 * it. That keeps the file correct for any backend layout that still stores
 * one directory per session, without duplicating the slug rule.
 *
 * Ids are validated before they ever reach a path join: they arrive from a
 * browser request, and `..` in a session id must not become a directory
 * traversal.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionTagStore } from './tags.js'

/** A session id safe to interpolate into a path: one plain path segment. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** dsh's harness home: $DSH_HOME, else ~/.dsh. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(process.env.HOME ?? '/', '.dsh')
}

/**
 * Remove every durable artifact of one session.
 *
 * What is removed: the session directory (log generations), its projection
 * cache entry, and the dshell PTY log plus its timeline/block sidecars. What
 * is deliberately kept: content-addressed attachments, which are shared
 * between sessions and cannot be attributed to one owner.
 *
 * @param sessionId - the session to purge; must be a plain path segment.
 * @param home - harness home; defaults to {@link dshHome}.
 * @returns the absolute paths that were removed, for the caller's report.
 * @throws when the id is not a safe path segment.
 */
export async function purgeSessionArtifacts(
  sessionId: string,
  home: string = dshHome(),
): Promise<readonly string[]> {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`refusing to purge unsafe session id "${sessionId}"`)
  }
  const removed: string[] = []
  const drop = async (path: string): Promise<void> => {
    try {
      await stat(path)
    } catch {
      return
    }
    await rm(path, { recursive: true, force: true })
    removed.push(path)
  }

  let shards: string[] = []
  try {
    shards = (await readdir(join(home, 'sessions'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    // No session storage yet: nothing to purge there.
  }
  for (const shard of shards) await drop(join(home, 'sessions', shard, sessionId))

  await drop(join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`))
  for (const suffix of ['.log', '.log.timeline.json', '.log.blocks.json']) {
    await drop(join(home, 'dshell-pty', `${sessionId}${suffix}`))
  }
  return removed
}

/**
 * Run the purges scheduled while their sessions were still loaded.
 *
 * This must run during plugin load: once a client connects, the sessions it
 * opens resume and their log writers come back, which is exactly the state a
 * scheduled purge is waiting to escape. A failure is logged and the id is
 * kept for the next start rather than silently marking the log as removed.
 *
 * @param tags - tag store holding the scheduled ids.
 * @param home - harness home; defaults to {@link dshHome}.
 * @returns the ids whose artifacts were removed.
 */
export async function drainPendingPurges(
  tags: SessionTagStore,
  home: string = dshHome(),
): Promise<readonly string[]> {
  const done: string[] = []
  for (const sessionId of await tags.pendingPurge()) {
    try {
      await purgeSessionArtifacts(sessionId, home)
      await tags.forget(sessionId)
      done.push(sessionId)
    } catch (error) {
      console.warn(`dshell: scheduled purge for "${sessionId}" failed:`, error)
    }
  }
  return done
}

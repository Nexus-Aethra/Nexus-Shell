/**
 * Durable session tags — the archive set behind the sidebar's collapsed
 * group. A tag never touches the session log: archiving only removes the id
 * from the active list, and unarchiving puts it back exactly where it was.
 *
 * One JSON document under $DSH_HOME/dshell/tags.json, read lazily on the
 * first operation and rewritten whole after every mutation. The file is
 * written through a temporary sibling and renamed, so a crash mid-write
 * leaves the previous document intact instead of a truncated one.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** On-disk document; unknown keys are preserved so a newer dshell can add fields. */
interface TagDocument {
  archived?: unknown
  pendingPurge?: unknown
}

/** Coerce one parsed id list, dropping anything unusable and any duplicate. */
function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || seen.has(entry)) continue
    seen.add(entry)
  }
  return [...seen]
}

/** The archive tag set, persisted as one document. */
export class SessionTagStore {
  private loaded = false
  private archived: string[] = []
  private pending: string[] = []

  /** @param path - absolute location of the tag document. */
  constructor(private readonly path: string) {}

  /** The archived session ids, in archive order. */
  async list(): Promise<readonly string[]> {
    await this.ensure()
    return [...this.archived]
  }

  /**
   * Sessions whose log is scheduled for removal at the next start. They are
   * always also archived (the tag is what hides them meanwhile), so this is a
   * qualifier on the archive set, not a separate list.
   */
  async pendingPurge(): Promise<readonly string[]> {
    await this.ensure()
    return [...this.pending]
  }

  /** Whether one session carries the archive tag. */
  async has(sessionId: string): Promise<boolean> {
    await this.ensure()
    return this.archived.includes(sessionId)
  }

  /**
   * Add the archive tag; an already-tagged id is a no-op.
   * @param sessionId - session to archive.
   * @returns the tag set after the write.
   */
  async archive(sessionId: string): Promise<readonly string[]> {
    await this.ensure()
    if (this.archived.includes(sessionId)) return [...this.archived]
    this.archived.push(sessionId)
    await this.save()
    return [...this.archived]
  }

  /**
   * Remove the archive tag; an untagged id is a no-op.
   * @param sessionId - session to restore.
   * @returns the tag set after the write.
   */
  async unarchive(sessionId: string): Promise<readonly string[]> {
    await this.ensure()
    // Restoring also cancels a scheduled purge: the two are one gesture from
    // the sidebar's point of view.
    this.pending = this.pending.filter(id => id !== sessionId)
    if (!this.archived.includes(sessionId)) {
      await this.save()
      return [...this.archived]
    }
    this.archived = this.archived.filter(id => id !== sessionId)
    await this.save()
    return [...this.archived]
  }

  /**
   * Archive a session AND schedule its log for removal at the next start.
   * Used when the session is still loaded in this process: dsh owns that
   * lifecycle (see session-list.ts), so the durable half waits until the
   * harness that holds the log writer is gone.
   * @param sessionId - session to remove at the next start.
   * @returns the tag set after the write.
   */
  async markPending(sessionId: string): Promise<readonly string[]> {
    await this.ensure()
    if (!this.archived.includes(sessionId)) this.archived.push(sessionId)
    if (!this.pending.includes(sessionId)) this.pending.push(sessionId)
    await this.save()
    return [...this.archived]
  }

  /**
   * Drop every trace of a purged session (its log is gone, so a tag would
   * point at nothing).
   * @param sessionId - purged session.
   * @returns the tag set after the write.
   */
  async forget(sessionId: string): Promise<readonly string[]> {
    return this.unarchive(sessionId)
  }

  /** Load once; a missing document is an empty tag set. */
  private async ensure(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const document = JSON.parse(await readFile(this.path, 'utf8')) as TagDocument
      this.archived = readIds(document.archived)
      this.pending = readIds(document.pendingPurge).filter(id => this.archived.includes(id))
    } catch {
      // Missing or unreadable: an empty tag set beats refusing to start.
      this.archived = []
      this.pending = []
    }
  }

  /** Rewrite the whole document atomically. */
  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const body = JSON.stringify({ archived: this.archived, pendingPurge: this.pending }, null, 2)
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, body, 'utf8')
    await rename(temporary, this.path)
  }
}

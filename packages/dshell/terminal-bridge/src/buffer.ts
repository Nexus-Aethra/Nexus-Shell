/**
 * PtyBuffer — dshell design 4.9.
 *
 * Append-only persisted scrollback for one main PTY. The log file is the
 * source of truth; memory holds a fixed window whose oldest lines drop
 * first, so a chatty shell costs bounded RAM no matter how much it
 * prints. A fresh main shell bound to the same dsh session (including
 * the fresh PTY process a harness restart must spawn) seeds its window
 * from the file tail, so the canvas can restore recent scrollback
 * without unbounded memory.
 *
 * The log lives at $DSH_HOME/dshell-pty/<dsh-session-id>.log. Appends
 * are batched and flushed on a short timer; close() and truncate() flush
 * synchronously.
 *
 * Alongside the text, the buffer keeps the arrival time of every append. That
 * timeline is what lets a reader place shell output between the agent tasks it
 * sat between: a replay carries the whole window in one frame, so a browser
 * that only knew its own frames could not tell where one command ended. The
 * host was there for all of it, so the times travel with the text.
 */

import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Window and flush knobs for one PtyBuffer. */
export interface PtyBufferOptions {
  /** In-memory window byte cap; the oldest lines drop first. */
  windowMaxBytes: number
  /** In-memory window line cap; the oldest lines drop first. */
  windowMaxLines: number
  /** How much of an existing log tail seeds a fresh window. */
  seedMaxBytes: number
  /** Append batching window in milliseconds. */
  flushIntervalMs: number
  /** How long a changed timeline waits before it is written beside the log. */
  timelineSaveDelayMs: number
}

export const DEFAULT_PTY_BUFFER_OPTIONS: PtyBufferOptions = {
  windowMaxBytes: 256 * 1024,
  windowMaxLines: 2000,
  seedMaxBytes: 64 * 1024,
  flushIntervalMs: 150,
  timelineSaveDelayMs: 500,
}

/** When a stretch of text reached the buffer, and how long it was. */
export interface PtyTimelineEntry {
  /** Epoch milliseconds. */
  t: number
  /** Characters this entry accounts for. */
  n: number
}

/** Where a buffer keeps its persisted arrival timeline. */
function timelinePath(logPath: string): string {
  return `${logPath}.timeline.json`
}

/**
 * The timeline for a freshly seeded window: the sidecar if it still aligns,
 * otherwise one entry stamped with the log's own mtime — a restart is exactly
 * one batch of old output followed by precise frames again.
 */
async function seedTimeline(logPath: string, seedChars: number): Promise<PtyTimelineEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(timelinePath(logPath), 'utf8'))
    if (Array.isArray(parsed)) {
      const entries: PtyTimelineEntry[] = []
      for (const item of parsed) {
        if (!Array.isArray(item)) continue
        const [t, n] = item as [unknown, unknown]
        if (typeof t === 'number' && typeof n === 'number' && n > 0) entries.push({ t, n })
      }
      const total = entries.reduce((sum, entry) => sum + entry.n, 0)
      if (total >= seedChars) {
        // The seed is the log's tail, so keep the timeline's tail: drop the
        // entries (or the part of one) older than the seeded text.
        let excess = total - seedChars
        while (excess > 0 && entries.length > 0) {
          const head = entries[0]
          if (head === undefined) break
          if (head.n <= excess) { excess -= head.n; entries.shift() }
          else { head.n -= excess; excess = 0 }
        }
        if (entries.length > 0) return entries
      } else if (entries.length > 0 && total > 0) {
        // The log grew past the persisted timeline: the missing prefix is the
        // oldest text we can no longer time, so it gets the seed's timestamp.
        entries.unshift({ t: Date.now(), n: seedChars - total })
        return entries
      }
    }
  } catch {
    // No sidecar, or unreadable: fall through to the mtime anchor.
  }
  let seededAt = Date.now()
  try { seededAt = (await stat(logPath)).mtimeMs } catch { /* keep now */ }
  return [{ t: seededAt, n: seedChars }]
}

/** Decode the tail of a UTF-8 file without splitting a multibyte sequence. */
function decodeTail(buffer: Buffer): string {
  let start = 0
  const limit = Math.min(buffer.length, 3)
  while (start < limit && (buffer[start]! & 0b1100_0000) === 0b1000_0000) start++
  return buffer.subarray(start).toString('utf8')
}

export class PtyBuffer {
  private handle: import('node:fs/promises').FileHandle | undefined
  private pending = ''
  private flushTimer: NodeJS.Timeout | undefined
  private writing = false
  /** Arrival time of each append still inside the window, oldest first. */
  private timeline: PtyTimelineEntry[] = []
  private timelineTimer: NodeJS.Timeout | undefined

  private constructor(
    readonly logPath: string,
    private readonly options: PtyBufferOptions,
    private window = '',
  ) {}

  /**
   * Open (or create) the log and seed the window from its tail.
   * @param logPath - append-only log location.
   * @param options - window and flush knobs; defaults apply per key.
   */
  static async open(logPath: string, options: PtyBufferOptions = DEFAULT_PTY_BUFFER_OPTIONS): Promise<PtyBuffer> {
    await mkdir(dirname(logPath), { recursive: true })
    let seed = ''
    try {
      const info = await stat(logPath)
      if (info.isFile() && info.size > 0) {
        const handle = await open(logPath, 'r')
        try {
          const start = Math.max(0, info.size - options.seedMaxBytes)
          const length = info.size - start
          const buffer = Buffer.alloc(length)
          await handle.read(buffer, 0, length, start)
          seed = decodeTail(buffer)
        } finally {
          await handle.close()
        }
      }
    } catch {
      // A missing or unreadable log is an empty history.
      seed = ''
    }
    const buffer = new PtyBuffer(logPath, options, seed)
    if (seed.length > 0) buffer.timeline = await seedTimeline(logPath, seed.length)
    buffer.trim()
    buffer.handle = await open(logPath, 'a')
    return buffer
  }

  /** Append one output delta to the window and the pending write batch. */
  append(delta: string): void {
    if (delta.length === 0) return
    this.window += delta
    this.timeline.push({ t: Date.now(), n: delta.length })
    this.scheduleTimelineSave()
    this.trim()
    this.pending += delta
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        void this.flush()
      }, this.options.flushIntervalMs)
    }
  }

  /** Replace the window wholesale after the backend dropped retained lines. */
  resync(text: string): void {
    this.window = text
    this.timeline = text.length === 0 ? [] : [{ t: Date.now(), n: text.length }]
    this.scheduleTimelineSave()
    this.trim()
  }

  /** Arrival timeline of the retained window, oldest first. */
  timelineEntries(): readonly PtyTimelineEntry[] {
    return this.timeline
  }

  /** The in-memory window, oldest lines first. */
  text(): string {
    return this.window
  }

  /** Number of lines currently retained in the window. */
  lineCount(): number {
    return this.window.length === 0 ? 0 : this.window.split('\n').length
  }

  /**
   * The newest bounded slice of the window — the 4.6 context-injection
   * snapshot. Prompt-anchor selection is a Phase 7 concern; callers get
   * the raw tail capped at `maxLines`/`maxBytes` on a UTF-8 boundary.
   */
  tail(maxLines: number, maxBytes: number): string {
    const lines = this.window.length === 0 ? [] : this.window.split('\n')
    let text = lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
    if (Buffer.byteLength(text) > maxBytes) {
      const bytes = Buffer.from(text, 'utf8')
      text = decodeTail(bytes.subarray(bytes.length - maxBytes))
    }
    return text
  }

  /** Drop the window and truncate the log (the `/clear` path). */
  async truncate(): Promise<void> {
    this.window = ''
    this.timeline = []
    if (this.timelineTimer !== undefined) { clearTimeout(this.timelineTimer); this.timelineTimer = undefined }
    await this.flush()
    await this.handle?.truncate(0)
    await writeFile(timelinePath(this.logPath), '[]', 'utf8').catch(() => { /* best effort */ })
  }

  /**
   * Flush any pending appends to the log. Serialized writer loop: one
   * write drains everything queued during it, a failed write re-queues
   * its batch and resurfaces on the next trigger instead of poisoning
   * later writes.
   */
  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.writing) return
    this.writing = true
    try {
      for (;;) {
        const batch = this.pending
        this.pending = ''
        if (batch.length === 0) return
        const handle = this.handle
        if (handle === undefined) {
          this.pending = batch + this.pending
          return
        }
        try {
          await handle.write(batch, null, 'utf8')
        } catch (error) {
          this.pending = batch + this.pending
          console.warn('dshell-pty: log write failed:', error)
          return
        }
      }
    } finally {
      this.writing = false
    }
  }

  /** Flush pending writes and release the log handle. */
  async close(): Promise<void> {
    if (this.timelineTimer !== undefined) { clearTimeout(this.timelineTimer); this.timelineTimer = undefined }
    await this.saveTimeline()
    await this.flush()
    await this.handle?.close()
    this.handle = undefined
  }

  /** Coalesce timeline writes: a chatty shell would otherwise rewrite per frame. */
  private scheduleTimelineSave(): void {
    if (this.timelineTimer !== undefined) return
    this.timelineTimer = setTimeout(() => {
      this.timelineTimer = undefined
      void this.saveTimeline()
    }, this.options.timelineSaveDelayMs)
  }

  /** Persist the window's arrival timeline beside the log. */
  private async saveTimeline(): Promise<void> {
    const pairs = this.timeline.map(entry => [entry.t, entry.n])
    await writeFile(timelinePath(this.logPath), JSON.stringify(pairs), 'utf8')
      .catch(() => { /* best effort: a missing sidecar only costs placement */ })
  }

  /** Enforce the window caps by dropping the oldest lines. */
  private trim(): void {
    for (;;) {
      if (this.window.length === 0) return
      const overBytes = Buffer.byteLength(this.window) > this.options.windowMaxBytes
      const lines = this.window.split('\n')
      const overLines = lines.length > this.options.windowMaxLines
      if (!overBytes && !overLines) return
      const drop = overLines ? lines.length - this.options.windowMaxLines : 1
      const before = this.window.length
      this.window = lines.slice(drop).join('\n')
      // The timeline must consume exactly what the window dropped, or every
      // later offset would be timed by the wrong frame.
      this.consumeTimeline(before - this.window.length)
    }
  }

  /** Drop `count` characters from the timeline's oldest end. */
  private consumeTimeline(count: number): void {
    let remaining = count
    while (remaining > 0 && this.timeline.length > 0) {
      const head = this.timeline[0]
      if (head === undefined) return
      if (head.n <= remaining) {
        remaining -= head.n
        this.timeline.shift()
      } else {
        head.n -= remaining
        remaining = 0
      }
    }
  }
}

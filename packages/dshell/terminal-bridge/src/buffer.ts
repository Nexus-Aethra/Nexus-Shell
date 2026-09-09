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
 */

import { mkdir, open, stat } from 'node:fs/promises'
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
}

export const DEFAULT_PTY_BUFFER_OPTIONS: PtyBufferOptions = {
  windowMaxBytes: 256 * 1024,
  windowMaxLines: 2000,
  seedMaxBytes: 64 * 1024,
  flushIntervalMs: 150,
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
    buffer.trim()
    buffer.handle = await open(logPath, 'a')
    return buffer
  }

  /** Append one output delta to the window and the pending write batch. */
  append(delta: string): void {
    if (delta.length === 0) return
    this.window += delta
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
    this.trim()
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
    await this.flush()
    await this.handle?.truncate(0)
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
    await this.flush()
    await this.handle?.close()
    this.handle = undefined
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
      this.window = lines.slice(drop).join('\n')
    }
  }
}

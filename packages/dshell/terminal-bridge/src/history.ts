/**
 * The command history a session's shell keeps across boots.
 *
 * The bridge's in-memory records are per boot: a restart respawns the shell and
 * the composer's up-arrow list would start empty even though the terminal view
 * replays its own scrollback from disk. This is that missing half — the command
 * lines, their exit status and their time, beside the PTY log the same session
 * already writes.
 *
 * Only the command is kept, never its output: the output belongs to the PTY and
 * block logs, which exist for reading back; this file exists so the shell's own
 * history gesture survives a restart. Writes are debounced and best-effort, the
 * way the block log next door does it, because losing a line of history must
 * never cost the session anything.
 */

import { readFile, writeFile } from 'node:fs/promises'

/** Completed commands retained per session; the live array's cap too. */
export const MAX_COMMAND_HISTORY = 200

/** How long writes coalesce before touching the disk. */
const SAVE_DELAY_MS = 400

/** One recorded command, as it is stored. */
export interface PersistedCommand {
  /** Monotonic within the shell generation that produced it. */
  readonly seq: number
  readonly command: string
  readonly exitCode: number | null
  /** Epoch ms the command finished. */
  readonly at: number
}

/** Where one session's history lives: beside its PTY log. */
export function commandHistoryPath(logPath: string): string {
  return `${logPath}.history.json`
}

/** One entry as written; anything malformed is dropped rather than trusted. */
function asCommand(value: unknown): PersistedCommand | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as { seq?: unknown; command?: unknown; exitCode?: unknown; at?: unknown }
  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) return undefined
  return {
    seq: typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0,
    command: raw.command,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
  }
}

/** The retained command list of one session, loaded at spawn and kept in sync. */
export class CommandHistory {
  private entries: PersistedCommand[] = []
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly path: string | undefined) {}

  /** Load what the previous shell left; a missing or broken file starts empty. */
  async load(): Promise<void> {
    if (this.path === undefined) return
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const value of parsed) {
        const command = asCommand(value)
        if (command !== undefined) this.entries.push(command)
      }
      this.trim()
    } catch {
      // No history yet (or an unreadable one): an empty list is a valid start.
    }
  }

  /** The retained commands, oldest first. */
  list(): readonly PersistedCommand[] {
    return this.entries
  }

  /** Add closed commands, newest last, and schedule the write. */
  append(commands: readonly PersistedCommand[]): void {
    if (commands.length === 0) return
    this.entries.push(...commands)
    this.trim()
    this.schedule()
  }

  /**
   * Drop everything — the `/clear` path, which is a new shell epoch: the
   * scrollback, the block log and the history all restart together, so the file
   * must not resurrect commands the user just cleared.
   */
  clear(): void {
    this.entries = []
    this.schedule()
  }

  /** Write now, cancelling any pending debounce (teardown path). */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    await this.save()
  }

  private trim(): void {
    if (this.entries.length > MAX_COMMAND_HISTORY) {
      this.entries.splice(0, this.entries.length - MAX_COMMAND_HISTORY)
    }
  }

  private schedule(): void {
    if (this.path === undefined || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, SAVE_DELAY_MS)
  }

  private async save(): Promise<void> {
    if (this.path === undefined) return
    await writeFile(this.path, JSON.stringify(this.entries), 'utf8')
      .catch(() => { /* best effort: history outlives nothing if the write fails */ })
  }
}

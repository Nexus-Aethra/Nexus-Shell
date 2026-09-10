/**
 * dshell-terminal-bridge host face — design 4.2 (main shell ownership),
 * 4.9 (scrollback persistence), and § 5 (the /dshell/pty wire protocol).
 *
 * The bridge owns one `name: 'main'` PTY per dsh session, keyed by the
 * exact Agent (dsh terminals are owner-scoped; the agent calling
 * `terminal_open` with `name: 'main'` mints a second PTY, never this
 * one). A tail loop polls the backend scrollback for new content
 * (content prefix-diff — the stream mutates in place, line-index
 * cursors double-count it), appends deltas to the per-session PtyBuffer
 * (disk-backed, fixed memory window, 4.9), and fans them out to the
 * bound ws clients. Input frames are serialized through `startSend` —
 * one active send at a time, further input queued; Ctrl+C (`\x03`)
 * cancels the active send with SIGINT.
 *
 * The ws upgrade route reuses dsh's own auth
 * (`connection.requestRejection`), so the cookie/token gate matches the
 * rest of the app. Resize frames are accepted and ignored: dsh's PTY
 * backends fix rows/cols at spawn (§ 5).
 */

import { homedir, userInfo, hostname } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TerminalSendOperation, TerminalSessionId, TerminalSignal } from '@deepseek-ai/dsh-terminal'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the host connection service merge (ctx.connection,
// upgrade auth) and the agents service merge (ctx.agents) into the program.
import type {} from '@deepseek-ai/dsh-client-connection'
import { BlockLog, blockLogPath } from './blocks.js'
import { PtyBuffer } from './buffer.js'
import { DshellPtyBackend, type DshellPtySession } from './pty.js'
import {
  createSplitter, sanitizeTerminalText, sliceWindow, splitOutput, trackInput,
  type CommandSplitterState, type TerminalCommandRecord,
} from './commands.js'

export { DEFAULT_PTY_BUFFER_OPTIONS, PtyBuffer } from './buffer.js'
export { sliceWindow, stripAnsi, sanitizeTerminalText, type TerminalCommandRecord } from './commands.js'

/** Completed-command history retained per shell (oldest drop first). */
const MAX_COMMAND_HISTORY = 200

/**
 * Shell generation counter. A new record — spawn or `/clear` — takes the next
 * value, so a cursor minted against an older shell is always detectable as
 * stale (a plain offset cannot be, since a respawn's log seed restarts near
 * zero).
 */
let nextShellGeneration = 1

/** Cursor state carried in the opaque token handed to agents. */
interface CursorState {
  readonly generation: number
  readonly offset: number
  readonly seq: number
}

/** Parse an opaque cursor token (`g<generation>:<offset>:<seq>`). */
function parseCursor(cursor: string | undefined): CursorState | undefined {
  if (cursor === undefined) return undefined
  const match = /^g(\d+):(\d+):(\d+)$/.exec(cursor.trim())
  if (match === null) return undefined
  return { generation: Number(match[1]), offset: Number(match[2]), seq: Number(match[3]) }
}

/** Format one cursor token. */
function formatCursor(state: CursorState): string {
  return `g${String(state.generation)}:${String(state.offset)}:${String(state.seq)}`
}

/** Incremental slice of one shell's activity since a cursor. */
export interface TerminalDelta {
  /** Opaque token to pass back on the next call. */
  readonly cursor: string
  /** The shell generation the delta belongs to. */
  readonly generation: number
  /** Sanitized output appended since the cursor. */
  readonly text: string
  /** Commands completed since the cursor (bounded by the retained history). */
  readonly commands: readonly TerminalCommandRecord[]
  /** Count of completed commands since the cursor. */
  readonly newCommandCount: number
  /** Older output fell out of the retained window before the cursor. */
  readonly dropped: boolean
  /** The cursor belonged to a previous shell generation (respawn or /clear). */
  readonly cleared: boolean
}

/** Latest retained commands of one shell. */
export interface TerminalHistory {
  readonly cursor: string
  readonly generation: number
  readonly commands: readonly TerminalCommandRecord[]
}

export const name = '@deepseek-ai/dsh-dshell-terminal-bridge'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The bridge service instance (Service key `dshellTerminalBridge`). */
    dshellTerminalBridge: DshellTerminalBridge
  }
}

/** dshell PTY log directory: $DSH_HOME/dshell-pty. */
export function ptyLogDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dshell-pty')
}

/** Default canvas size for a spawned main shell; the browser resizes it. */
const DEFAULT_PTY_COLS = 160
const DEFAULT_PTY_ROWS = 40

interface MainRecord {
  agent: Agent
  /** dsh session id this main shell belongs to. */
  dshSessionId: string
  /** PTY id inside ctx.terminals (per boot). */
  ptyId: TerminalSessionId
  /** The backend's rich handle: raw output push, exit push, resize. */
  session: DshellPtySession
  buffer: PtyBuffer
  /** The host's block model for this session: the render order's source. */
  blocks: BlockLog
  /** Shell identity; every respawn and `/clear` takes a fresh value. */
  generation: number
  /** Bytes ever appended to the logical stream, independent of window trims. */
  absOffset: number
  /** Completed commands, oldest drop first. */
  commands: TerminalCommandRecord[]
  /** Input-line assembly + output/marker splitter for this shell. */
  splitter: CommandSplitterState
  activeSend: TerminalSendOperation | undefined
  inputQueue: string[]
  /** Init echo is scrubbed and output suppressed until the first settle. */
  initializing: boolean
  /** Push-subscription disposers, released in dropMain. */
  stopOutput: () => void
  stopExit: () => void
  /**
   * Set when the PTY exited or the dsh session was disposed. The record
   * stays in `mains` briefly so a reconnecting client can receive the
   * close frame in its bindClient sequence; `disposeRecord` removes it
   * after the grace.
   */
  dead?: { reason: string; time: number }
  /** Pending dispose handle, kept so a rapid respawn can cancel it. */
  disposeTimer?: NodeJS.Timeout
}

export class DshellTerminalBridge extends Service {
  static inject = ['terminals', 'agents'] as const

  private readonly mains = new Map<Agent, MainRecord>()
  private readonly pendingMain = new Map<Agent, Promise<MainRecord>>()
  private readonly clients = new Map<string, Set<WebSocket>>()
  private readonly boundSession = new Map<WebSocket, string>()
  /** OS identity for the bash prompt; safe for embedding inside PS1 quotes. */
  readonly promptUser = safeShellWord(userInfo().username)
  readonly promptHost = safeShellWord(hostname())

  /** The backend's rich handle (raw push, exit push, resize) for its sessions. */
  private readonly backend = new DshellPtyBackend(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, (cwd) => {
    // A session bound to a device runs that device's shell, so the user's own
    // terminal is not a local shell stranded in an empty mount directory. The
    // router is reached through the service the SSH plugin publishes, asked
    // lazily because that plugin may load after this one; a composition
    // without it returns undefined and the local shell is used as before.
    if (cwd === undefined || cwd === '') return undefined
    const routing = this.ctx.get('dshellSshRouting') as
      | { interactiveShellPlan(sessionCwd: string): { argv: readonly string[]; env: Record<string, string> } | undefined }
      | undefined
    return routing?.interactiveShellPlan(cwd)
  })

  constructor(ctx: Context) {
    super(ctx, 'dshellTerminalBridge')
    ctx.effect(() => this.ctx.terminals.registerBackend(this.backend), 'dshell-bridge: raw pty backend')
    ctx.effect(() => () => {
      this.backend.dispose()
      void this.disposeAll()
    }, 'dshell-bridge: teardown')
    // Turn boundaries come from the session itself, so a block is cut exactly
    // where the agent took over and where it handed the terminal back.
    ctx.on('session/event', (session: Session, event: { type?: string; data?: unknown }) => {
      const sessionId = String(session.id)
      const record = this.recordFor(sessionId)
      if (record === undefined) return
      const data = (event.data ?? {}) as { turn?: number }
      if (event.type === 'turn/start') {
        record.blocks.startTurn(data.turn)
        this.broadcast(sessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      } else if (event.type === 'turn/end') {
        record.blocks.endTurn()
        this.broadcast(sessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      }
    }, { global: true })
    // Session dispose (sidebar delete, host-side cleanup) → mark the
    // session's main PTY dead so the bindClient sequence can forward the
    // close frame and the dispose timer frees the node-pty.
    ctx.on('session/disposed', (session: Session) => {
      const sessionId = String(session.id)
      for (const record of this.mains.values()) {
        if (record.dshSessionId !== sessionId) continue
        this.markDead(record, 'session closed')
        const set = this.clients.get(sessionId)
        if (set !== undefined) {
          for (const client of set) {
            this.boundSession.delete(client)
            if (client.readyState === WebSocket.OPEN) client.close(1000, 'session closed')
          }
          this.clients.delete(sessionId)
        }
      }
    })
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      const wss = new WebSocketServer({ noServer: true })
      const route: WebUpgradeRoute = {
        path: '/dshell/pty',
        handler: (req, socket, head) => {
          const rejection = webCtx.connection.requestRejection(req)
          if (rejection !== undefined) {
            rejectUpgrade(socket, rejection)
            return
          }
          wss.handleUpgrade(req as never, socket as never, head, (client) => { this.attachClient(client) })
        },
      }
      webCtx.effect(() => webCtx.webServer.registerUpgrade(route), 'dshell-bridge: /dshell/pty')
    })
  }

  /**
   * The bridge-owned `main` PTY for one dsh session, spawning it lazily.
   * The PtyBuffer seeds from the persisted log tail (4.9) and the tail
   * loop starts streaming backend scrollback into buffer and clients.
   */
  async ensureMainShell(dshSessionId: string): Promise<MainRecord> {
    const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
    if (agent === undefined) {
      throw new Error(`dshell-bridge: no live agent for session "${dshSessionId}"`)
    }
    const existing = this.mains.get(agent)
    if (existing !== undefined && existing.dead === undefined) return existing
    if (existing !== undefined) {
      // A dead record blocks the owner's name reservation; force-release
      // it inline so the spawn below doesn't collide on "name main exists".
      if (existing.disposeTimer !== undefined) clearTimeout(existing.disposeTimer)
      await this.disposeRecord(existing)
      void this.ctx.terminals.kill(agent, existing.ptyId, 'dshell: replace dead').catch(() => {})
    }
    const pending = this.pendingMain.get(agent)
    if (pending !== undefined) return await pending
    const promise = this.spawnMain(agent, dshSessionId)
    this.pendingMain.set(agent, promise)
    try {
      return await promise
    } finally {
      this.pendingMain.delete(agent)
    }
  }

  /** The live main record for a dsh session, if one exists. */
  private recordFor(dshSessionId: string): MainRecord | undefined {
    for (const record of this.mains.values()) if (record.dshSessionId === dshSessionId) return record
    return undefined
  }

  private async spawnMain(agent: Agent, dshSessionId: string): Promise<MainRecord> {
    const cwd = agent.session?.header?.cwd
    const spawned = await this.ctx.terminals.spawn(agent, {
      type: 'dshell-pty',
      name: 'main',
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
    })
    const session = this.backend.session(spawned.sessionId)
    if (session === undefined) {
      throw new Error(`dshell-bridge: backend session missing after spawn (${String(spawned.sessionId)})`)
    }
    const logPath = join(ptyLogDir(), `${dshSessionId}.log`)
    const buffer = await PtyBuffer.open(logPath)
    const blocks = new BlockLog(blockLogPath(logPath))
    await blocks.load()
    if (blocks.snapshot().length === 0 && buffer.text().length > 0) {
      // First run after this log was introduced (or after a clear): the
      // seeded history has no block yet, so give it the shell block it was.
      blocks.append(buffer.text(), Date.now())
    }
    const record: MainRecord = {
      agent,
      dshSessionId,
      ptyId: spawned.sessionId,
      session,
      buffer,
      blocks,
      generation: nextShellGeneration++,
      // The seeded log tail is history the previous shell already produced;
      // starting the cursor at its end keeps a respawn from replaying it.
      absOffset: Buffer.byteLength(buffer.text(), 'utf8'),
      commands: [],
      splitter: createSplitter(),
      activeSend: undefined,
      inputQueue: [],
      initializing: true,
      stopOutput: () => {},
      stopExit: () => {},
    }
    this.mains.set(agent, record)
    // Raw ANSI push: every output byte lands in the persisted buffer and on
    // the wire untouched — the canvas renders it natively. Suppressed while
    // the init echo is pending so a fresh session opens on a clean slate.
    // The same bytes feed the command splitter (OSC 133;D closes a record).
    record.stopOutput = session.onOutput((chunk) => {
      if (record.initializing) return
      record.buffer.append(chunk)
      const block = record.blocks.append(chunk)
      this.broadcast(record.dshSessionId, { kind: 'block-text', seq: block.seq, text: chunk })
      record.absOffset += Buffer.byteLength(chunk, 'utf8')
      const closed = splitOutput(record.splitter, chunk, Date.now())
      if (closed.length > 0) {
        record.commands.push(...closed)
        if (record.commands.length > MAX_COMMAND_HISTORY) {
          record.commands.splice(0, record.commands.length - MAX_COMMAND_HISTORY)
        }
      }
      this.broadcast(record.dshSessionId, { kind: 'output', chunk, time: Date.now() })
    })
    record.stopExit = session.onExit((status) => {
      this.markDead(record, status.kind === 'exited' ? `exit code ${String(status.exitCode)}` : status.kind)
    })
    // Replace the stock `dsh> ` prompt with a bash-style `user@host:path$`
    // cue once the shell is ready; PS1 and PROMPT_COMMAND are rewritten in
    // one line so no render window can clobber it, and the backend's fast
    // settle keys off the marker this PROMPT_COMMAND prints.
    this.runInit(record)
    return record
  }

  /** Queue the prompt-rewrite init and wipe its setup echo from the scrollback. */
  private runInit(record: MainRecord): void {
    // The scrollback a respawn owes the client: the window already holds the
    // seeded log tail, so snapshot it before the init echo lands. Restoring
    // the snapshot (below) is the whole point of the persisted log — seeding
    // it and then truncating would erase the previous shell's output for good.
    const seeded = record.buffer.text()
    // ONE line: the PROMPT_COMMAND re-asserts PS1 from a dedicated variable
    // on every prompt render, so the prompt survives any clobber and the
    // settle marker stays live. Real ESC bytes are safe on this backend.
    const init = [
      `export DSHELL_PS1='\\u@\\h:\\w\\$ '; export PS1="$DSHELL_PS1"; export PROMPT_COMMAND='printf "\\033]133;D;%s\\007" "$?"; PS1="$DSHELL_PS1"'`,
      'clear',
      '',
    ].join('\n')
    const operation = this.ctx.terminals.startSend(record.agent, record.ptyId, { text: init, submit: false })
    record.activeSend = operation
    void operation.done.then(() => {
      record.activeSend = undefined
      record.initializing = false
      // The init echo (export line + clear) never deserves screen space, but
      // the seeded scrollback does: reset the log to the snapshot instead of
      // to nothing, and hand that same text back to every client, which
      // replaces its own history from a replay chunk.
      void record.buffer.truncate().then(() => {
        record.buffer.append(seeded)
        record.absOffset = Buffer.byteLength(seeded, 'utf8')
        this.broadcast(record.dshSessionId, {
          kind: 'output',
          chunk: seeded,
          time: Date.now(),
          replay: true,
          timeline: record.buffer.timelineEntries().map(entry => [entry.t, entry.n]),
        })
        record.inputQueue.push('\n')
        this.pump(record)
      })
    }, () => {
      record.activeSend = undefined
      record.initializing = false
      this.pump(record)
    })
  }

  /**
   * Ensure the session has a *live* main record. If the existing one is
   * dead, ensureMainShell forces a release-and-respawn inline so the
   * returned record is always usable (Phase 9 hardening — feeds,
   * signals, clears must never operate on a dying PTY).
   */
  private ensureLiveMain(dshSessionId: string): Promise<MainRecord> {
    return this.ensureMainShell(dshSessionId)
  }

  /** Feed one input chunk to the main PTY (Ctrl+C, `\x03`, cancels the active send). */
  feed(dshSessionId: string, text: string): void {
    void this.ensureLiveMain(dshSessionId).then((record) => {
      // The input side of the command splitter: assemble the line that Enter
      // will queue, so the next `133;D` marker can pair command ↔ output.
      trackInput(record.splitter, text)
      if (text === '\u0003' && record.activeSend !== undefined) {
        record.activeSend.cancel()
        return
      }
      record.inputQueue.push(text)
      this.pump(record)
    }, (error: unknown) => {
      console.warn('dshell-bridge: input dropped:', error)
    })
  }

  /**
   * `/clear` command entry: wipe one session's main-shell history (the
   * in-terminal `clear` command now clears the canvas natively; /clear
   * additionally drops the persisted scrollback).
   */
  async clearSession(dshSessionId: string): Promise<void> {
    const record = await this.ensureLiveMain(dshSessionId)
    this.performClear(record)
  }

  /**
   * Drop one session's main shell: kill the PTY and release its scrollback
   * window, timeline and block log. Used when the session is deleted while
   * still loaded — dsh keeps the session object alive, but everything dshell
   * allocated for it can go now instead of at the next start.
   *
   * Never spawns: a session without a shell is already in the requested state.
   */
  releaseSession(dshSessionId: string): void {
    const record = this.recordFor(dshSessionId)
    if (record === undefined) return
    this.markDead(record, 'session deleted')
  }

  /**
   * The main PTY's addressable `TerminalSessionId`, spawning the shell on
   * first need — what `dshell_get_main_terminal` hands the agent so
   * `terminal_send` lands in the user's visible shell.
   */
  async mainTerminalId(dshSessionId: string): Promise<TerminalSessionId> {
    const record = await this.ensureMainShell(dshSessionId)
    return record.ptyId
  }

  /** The live main record for one session, or undefined. Never spawns. */
  private liveRecord(dshSessionId: string): MainRecord | undefined {
    const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
    if (agent === undefined) return undefined
    const record = this.mains.get(agent)
    if (record === undefined || record.dead !== undefined) return undefined
    return record
  }

  /** Cursor at the current head of one record. */
  private headCursor(record: MainRecord): CursorState {
    return {
      generation: record.generation,
      offset: record.absOffset,
      seq: record.commands.at(-1)?.seq ?? 0,
    }
  }

  /**
   * Incremental slice of one session's main-shell activity since a cursor —
   * the context-management read. Output is sanitized for the model; commands
   * closed since the cursor come back structured. Never spawns a shell.
   * @param dshSessionId - the dsh session whose main record to read.
   * @param cursor - token from a previous call; omitted means "nothing yet",
   *   which reports `cleared: false` and returns the whole retained window.
   * @returns the delta, or undefined when there is no live main shell.
   */
  since(dshSessionId: string, cursor?: string): TerminalDelta | undefined {
    const record = this.liveRecord(dshSessionId)
    if (record === undefined) return undefined
    const head = this.headCursor(record)
    const parsed = parseCursor(cursor)
    // A cursor from an older shell generation means the shell was replaced or
    // cleared: report the reset and restart from the new head rather than
    // replaying the seeded scrollback as if it were new.
    if (parsed !== undefined && parsed.generation !== record.generation) {
      return {
        cursor: formatCursor(head),
        generation: record.generation,
        text: '',
        commands: [],
        newCommandCount: 0,
        dropped: false,
        cleared: true,
      }
    }
    const windowText = record.buffer.text()
    const windowStart = record.absOffset - Buffer.byteLength(windowText, 'utf8')
    // No cursor at all means "nothing has been delivered yet": the whole
    // retained window is the first delta, so the model starts out knowing
    // what the terminal already shows.
    const slice = sliceWindow(windowText, record.absOffset, parsed?.offset ?? windowStart)
    const commands = record.commands.filter(command => command.seq > (parsed?.seq ?? 0))
    return {
      cursor: formatCursor(head),
      generation: record.generation,
      text: sanitizeTerminalText(slice.text),
      commands,
      newCommandCount: commands.length,
      dropped: slice.dropped || (parsed === undefined && windowStart > 0),
      cleared: false,
    }
  }

  /**
   * The latest retained commands of one session's main shell (no cursor) —
   * what an agent asks for when it wants to look back rather than catch up.
   * @param dshSessionId - the dsh session whose main record to read.
   * @param limit - newest-commands cap.
   * @returns the commands plus the cursor at the head, or undefined when no
   *   live main shell exists.
   */
  history(dshSessionId: string, limit: number): TerminalHistory | undefined {
    const record = this.liveRecord(dshSessionId)
    if (record === undefined) return undefined
    const commands = limit >= record.commands.length
      ? record.commands
      : record.commands.slice(record.commands.length - Math.max(0, limit))
    return {
      cursor: formatCursor(this.headCursor(record)),
      generation: record.generation,
      commands,
    }
  }

  /**
   * Reset the buffer and client histories, then queue an empty line so
   * bash renders a fresh `user@host:path$ ` cue (the `/clear` path).
   */
  private performClear(record: MainRecord): void {
    // A clear is a new shell epoch: old cursors must read as stale, the
    // splitter and command history restart, and the absolute offset restarts
    // with the truncated window.
    record.generation = nextShellGeneration++
    record.absOffset = 0
    record.commands = []
    record.splitter = createSplitter()
    void record.buffer.truncate()
    this.broadcast(record.dshSessionId, { kind: 'output', chunk: '', time: Date.now(), replay: true })
    record.inputQueue.push('\n')
    this.pump(record)
  }

  /** Deliver a foreground signal to the main PTY. */
  async signal(dshSessionId: string, signal: TerminalSignal): Promise<void> {
    const record = await this.ensureMainShell(dshSessionId)
    await this.ctx.terminals.signal(record.agent, record.ptyId, signal)
  }

  /** Serialize queued input through the exclusive `startSend` slot. */
  private pump(record: MainRecord): void {
    if (record.activeSend !== undefined || record.inputQueue.length === 0) return
    const text = record.inputQueue.join('')
    record.inputQueue.length = 0
    try {
      const operation = this.ctx.terminals.startSend(record.agent, record.ptyId, { text, submit: false })
      record.activeSend = operation
      void operation.done.then(() => {
        record.activeSend = undefined
        this.pump(record)
      }, () => {
        record.activeSend = undefined
        this.pump(record)
      })
    } catch {
      // The slot was taken (e.g. the agent's own terminal_send on main):
      // re-queue and retry shortly instead of dropping keystrokes.
      record.inputQueue.unshift(text)
      setTimeout(() => { this.pump(record) }, 100)
    }
  }

  /**
   * Mark a record dead: stop listeners, broadcast the close frame, and
   * schedule disposal so a reconnecting client still receives the frame
   * in its bindClient push sequence (Phase 9 hardening).
   */
  private markDead(record: MainRecord, reason: string): void {
    if (record.dead !== undefined) return
    record.dead = { reason, time: Date.now() }
    record.stopOutput()
    record.stopExit()
    record.stopOutput = () => {}
    record.stopExit = () => {}
    this.broadcast(record.dshSessionId, { kind: 'closed', reason })
    // Release the dsh-side name reservation NOW so a same-tick respawn
    // (via ensureLiveMain) doesn't collide with the still-resident owner.
    void this.ctx.terminals.kill(record.agent, record.ptyId, 'dshell: dead').catch(() => {})
    record.disposeTimer = setTimeout(() => { void this.disposeRecord(record) }, 200)
  }

  /** Drop a dead record from `mains` and release its PtyBuffer. */
  private async disposeRecord(record: MainRecord): Promise<void> {
    delete record.disposeTimer
    this.mains.delete(record.agent)
    await record.buffer.close().catch(() => {})
  }

  private async disposeAll(): Promise<void> {
    for (const record of [...this.mains.values()]) {
      if (record.disposeTimer !== undefined) clearTimeout(record.disposeTimer)
      record.stopOutput()
      record.stopExit()
      await record.buffer.close().catch(() => {})
    }
    this.mains.clear()
    this.clients.clear()
    this.boundSession.clear()
  }

  private attachClient(client: WebSocket): void {
    client.on('message', (data: unknown) => {
      let frame: { kind?: string; sessionId?: string; text?: string; signal?: string; cols?: number; rows?: number }
      try {
        frame = JSON.parse(String(data)) as typeof frame
      } catch {
        return
      }
      if (frame.kind === 'bind' && typeof frame.sessionId === 'string') {
        this.bindClient(client, frame.sessionId)
        return
      }
      const bound = this.boundSession.get(client)
      if (bound === undefined || (frame.sessionId !== undefined && frame.sessionId !== bound)) return
      if (frame.kind === 'input' && typeof frame.text === 'string') {
        this.feed(bound, frame.text)
        return
      }
      if (frame.kind === 'signal' && typeof frame.signal === 'string') {
        if (frame.signal === 'SIGINT' || frame.signal === 'SIGTERM' || frame.signal === 'SIGTSTP') {
          void this.signal(bound, frame.signal).catch((error: unknown) => {
            console.warn('dshell-bridge: signal failed:', error)
          })
        }
        return
      }
      // Resize is real on the raw backend: the browser canvas drives cols/rows.
      if (frame.kind === 'resize' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
        void this.ensureMainShell(bound).then((record) => {
          record.session.resize(Math.floor(frame.cols as number), Math.floor(frame.rows as number))
        }, () => {})
      }
    })
    client.on('close', () => {
      const bound = this.boundSession.get(client)
      this.boundSession.delete(client)
      if (bound === undefined) return
      const set = this.clients.get(bound)
      set?.delete(client)
      if (set !== undefined && set.size === 0) this.clients.delete(bound)
    })
  }

  private bindClient(client: WebSocket, dshSessionId: string): void {
    // Stash the dead reason BEFORE ensureMainShell swaps in a replacement,
    // so the close frame can be forwarded to a freshly reconnected client.
    const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
    const priorDead = agent === undefined ? undefined : this.mains.get(agent)?.dead
    void this.ensureMainShell(dshSessionId).then((record) => {
      let set = this.clients.get(dshSessionId)
      if (set === undefined) {
        set = new Set()
        this.clients.set(dshSessionId, set)
      }
      set.add(client)
      this.boundSession.set(client, dshSessionId)
      if (priorDead !== undefined) {
        this.sendFrame(client, { kind: 'closed', reason: priorDead.reason })
      }
      this.sendFrame(client, { kind: 'info', user: this.promptUser, host: this.promptHost, home: homedir() })
      this.sendFrame(client, {
        kind: 'output',
        chunk: record.initializing ? '' : record.buffer.text(),
        time: Date.now(),
        replay: true,
        timeline: record.buffer.timelineEntries().map(entry => [entry.t, entry.n]),
      })
      // The host owns block order; the client renders this list as given.
      this.sendFrame(client, { kind: 'blocks', blocks: record.blocks.snapshot() })
    }, (error: unknown) => {
      this.sendFrame(client, { kind: 'error', message: String(error) })
      client.close(1008, 'bind rejected')
    })
  }

  /** Send a single frame to one ws client; tolerates a closing socket. */
  private sendFrame(client: WebSocket, payload: Record<string, unknown>): void {
    if (client.readyState !== WebSocket.OPEN) return
    try {
      client.send(JSON.stringify(payload))
    } catch {
      // The client closed mid-write; the close handler will drop the
      // boundSession entry, nothing else to do here.
    }
  }

  private broadcast(dshSessionId: string, frame: Record<string, unknown>): void {
    const set = this.clients.get(dshSessionId)
    if (set === undefined) return
    const data = JSON.stringify(frame)
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    }
  }
}

/** Defensive escape: drop chars that would let a quoted $PS1 leak out. */
function safeShellWord(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** Reject one unauthenticated upgrade with dsh's status semantics. */
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

export function apply(ctx: Context): void {
  ctx.plugin(DshellTerminalBridge)
}

export default { name, apply }

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
import { PtyBuffer } from './buffer.js'
import { DshellPtyBackend, type DshellPtySession } from './pty.js'

export { DEFAULT_PTY_BUFFER_OPTIONS, PtyBuffer } from './buffer.js'

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
  private readonly backend = new DshellPtyBackend(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS)

  constructor(ctx: Context) {
    super(ctx, 'dshellTerminalBridge')
    ctx.effect(() => this.ctx.terminals.registerBackend(this.backend), 'dshell-bridge: raw pty backend')
    ctx.effect(() => () => {
      this.backend.dispose()
      void this.disposeAll()
    }, 'dshell-bridge: teardown')
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
    const buffer = await PtyBuffer.open(join(ptyLogDir(), `${dshSessionId}.log`))
    const record: MainRecord = {
      agent,
      dshSessionId,
      ptyId: spawned.sessionId,
      session,
      buffer,
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
    record.stopOutput = session.onOutput((chunk) => {
      if (record.initializing) return
      record.buffer.append(chunk)
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
      // The init echo (export line + clear) never deserves screen space:
      // reset the buffer and every client history, then re-issue a prompt
      // with an empty line so the user opens on a fresh cue.
      void record.buffer.truncate()
      this.broadcast(record.dshSessionId, { kind: 'output', chunk: '', time: Date.now(), replay: true })
      record.inputQueue.push('\n')
      this.pump(record)
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
   * The main PTY's addressable `TerminalSessionId`, spawning the shell on
   * first need — what `dshell_get_main_terminal` hands the agent so
   * `terminal_send` lands in the user's visible shell.
   */
  async mainTerminalId(dshSessionId: string): Promise<TerminalSessionId> {
    const record = await this.ensureMainShell(dshSessionId)
    return record.ptyId
  }

  /**
   * Bounded recent output of one session's main shell — the Phase 7
   * context-injection snapshot. Never spawns: a session the browser has
   * not opened (or one whose shell exited) has no snapshot, so agent
   * turns that carry no visible terminal stay context-free.
   * @param dshSessionId - the dsh session whose main record to read.
   * @param maxLines - newest-lines cap.
   * @param maxBytes - UTF-8 byte cap, cut on a boundary when it binds.
   * @returns the tail text, or undefined when there is no live main shell.
   */
  recentOutput(dshSessionId: string, maxLines: number, maxBytes: number): string | undefined {
    const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
    if (agent === undefined) return undefined
    const record = this.mains.get(agent)
    if (record === undefined || record.dead !== undefined) return undefined
    return record.buffer.tail(maxLines, maxBytes)
  }

  /**
   * Reset the buffer and client histories, then queue an empty line so
   * bash renders a fresh `user@host:path$ ` cue (the `/clear` path).
   */
  private performClear(record: MainRecord): void {
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
      })
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

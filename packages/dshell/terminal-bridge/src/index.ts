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
import type { TerminalSendOperation, TerminalSessionId, TerminalSignal } from '@deepseek-ai/dsh-terminal'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the host connection service merge (ctx.connection,
// upgrade auth) and the agents service merge (ctx.agents) into the program.
import type {} from '@deepseek-ai/dsh-client-connection'
import { PtyBuffer } from './buffer.js'

export { DEFAULT_PTY_BUFFER_OPTIONS, PtyBuffer } from './buffer.js'

export const name = '@deepseek-ai/dsh-dshell-terminal-bridge'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The bridge service instance (Service key `dshellTerminalBridge`). */
    dshellTerminalBridge: DshellTerminalBridge
  }
}

/** Poll interval for the backend scrollback tail loop. */
const TAIL_INTERVAL_MS = 200
/** Read bound per tick: the full retained scrollback (dsh caps at maxReadBytes). */
const TAIL_READ_LINES = 100_000

/** dshell PTY log directory: $DSH_HOME/dshell-pty. */
export function ptyLogDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dshell-pty')
}

interface MainRecord {
  agent: Agent
  /** dsh session id this main shell belongs to. */
  dshSessionId: string
  /** PTY id inside ctx.terminals (per boot). */
  ptyId: TerminalSessionId
  buffer: PtyBuffer
  /**
   * Full retained backend scrollback as of the last sync — the content
   * cursor. dsh's scrollback is a mutating stream (the trailing prompt
   * is a partial line that grows in place, echo completion rewrites the
   * last line), so line-index cursors double-count it; prefix diffs of
   * the text do not.
   */
  backendText: string
  tailTimer: NodeJS.Timeout | undefined
  tailBusy: boolean
  activeSend: TerminalSendOperation | undefined
  inputQueue: string[]
  /** Init echo is scrubbed and broadcasts suppressed until the first settle. */
  initializing: boolean
}

export class DshellTerminalBridge extends Service {
  static inject = ['terminals'] as const

  private readonly mains = new Map<Agent, MainRecord>()
  private readonly pendingMain = new Map<Agent, Promise<MainRecord>>()
  private readonly clients = new Map<string, Set<WebSocket>>()
  private readonly boundSession = new Map<WebSocket, string>()
  /** OS identity for the bash prompt; safe for embedding inside PS1 quotes. */
  readonly promptUser = safeShellWord(userInfo().username)
  readonly promptHost = safeShellWord(hostname())

  constructor(ctx: Context) {
    super(ctx, 'dshellTerminalBridge')
    ctx.effect(() => () => { void this.disposeAll() }, 'dshell-bridge: teardown')
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
    if (existing !== undefined) return existing
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
      type: 'shell',
      name: 'main',
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
    })
    const buffer = await PtyBuffer.open(join(ptyLogDir(), `${dshSessionId}.log`))
    const record: MainRecord = {
      agent,
      dshSessionId,
      ptyId: spawned.sessionId,
      buffer,
      backendText: '',
      tailTimer: undefined,
      tailBusy: false,
      activeSend: undefined,
      inputQueue: [],
      initializing: true,
    }
    this.mains.set(agent, record)
    this.startTail(record)
    // Replace dsh's stock `dsh> ` prompt with a bash-style `user@host:path$`
    // cue once the shell is ready. dsh's terminal-bash backend hardcodes
    // PS1 and its PROMPT_COMMAND re-asserts it after every prompt render,
    // so both are rewritten together. The command text carries only
    // backslash-literal escapes (\u \h \w \033): dsh's input sanitizer
    // strips raw ESC bytes, while bash expands the literals at render/run
    // time. Runs before any user input; queued input serializes behind it.
    this.runInit(record)
    return record
  }

  /** Queue the prompt-rewrite init and wipe its setup echo from the scrollback. */
  private runInit(record: MainRecord): void {
    // ONE line: dsh's stock PROMPT_COMMAND re-asserts PS1='dsh> ' on every
    // prompt render, so a multi-line batch races — the prompt between line 1
    // (PS1) and line 2 (PROMPT_COMMAND) resets PS1 back. Joining with `; `
    // leaves no render window, and the new PROMPT_COMMAND re-asserts from a
    // dedicated variable so the prompt survives any later clobber.
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
      // The init echo (export line + clear) never deserves screen space,
      // and the prompt the shell already printed is part of the pre-slate
      // backend text: mark it consumed, reset the buffer and every client
      // history, then re-issue a prompt with an empty line so the user
      // opens on a fresh `user@host:path$ ` cue.
      record.backendText = this.readAll(record)
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
   * Feed one input chunk to the main PTY (Ctrl+C, `\x03`, cancels the
   * active send). `clear`/`cls` also truncate the bridge buffer: dsh's
   * sanitizer strips the ANSI clear-screen sequence from scrollback, so
   * the visual clear only happens if the bridge performs it.
   */
  feed(dshSessionId: string, text: string): void {
    void this.ensureMainShell(dshSessionId).then((record) => {
      if (text === '\u0003' && record.activeSend !== undefined) {
        record.activeSend.cancel()
        return
      }
      const command = text.trim()
      if (command === 'clear' || command === 'cls') {
        this.performClear(record)
        return
      }
      record.inputQueue.push(text)
      this.pump(record)
    }, (error: unknown) => {
      console.warn('dshell-bridge: input dropped:', error)
    })
  }

  /**
   * `/clear` command entry: wipe one session's main-shell history. dsh's
   * sanitizer strips the ANSI clear-screen sequence, so the visual clear
   * only happens here.
   */
  async clearSession(dshSessionId: string): Promise<void> {
    const record = await this.ensureMainShell(dshSessionId)
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
   * Wipe the visible history and re-issue a prompt: mark everything the
   * backend currently holds as consumed, reset the buffer and client
   * histories, then queue an empty line so bash renders a fresh
   * `user@host:path$ ` cue.
   */
  private performClear(record: MainRecord): void {
    record.backendText = this.readAll(record)
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
   * Poll backend scrollback for new content and fan it out. The cursor is
   * the full retained text of the previous tick: dsh's scrollback mutates
   * in place (the trailing prompt is a partial line that grows, echo
   * completion extends the last line), so a prefix extension is the delta;
   * anything else means retention slid under the cursor and both the
   * window and every client resync from the retained tail.
   */
  private startTail(record: MainRecord): void {
    const tick = async (): Promise<void> => {
      if (record.tailBusy) return
      record.tailBusy = true
      try {
        const snapshot = this.ctx.terminals.list(record.agent)
          .find(item => item.sessionId === record.ptyId)
        if (snapshot === undefined) throw new Error('main PTY vanished')
        const fresh = this.readAll(record)
        // The init echo is scrubbed wholesale at first settle: until then
        // the tail only advances the cursor, streaming nothing.
        if (record.initializing) {
          record.backendText = fresh
        } else if (fresh !== record.backendText) {
          if (fresh.startsWith(record.backendText)) {
            const delta = fresh.slice(record.backendText.length)
            if (delta.length > 0) {
              record.buffer.append(delta)
              this.broadcast(record.dshSessionId, { kind: 'output', chunk: delta, time: Date.now() })
            }
          } else {
            record.buffer.resync(fresh)
            this.broadcast(record.dshSessionId, {
              kind: 'output', chunk: fresh, time: Date.now(), replay: true,
            })
          }
          record.backendText = fresh
        }
        if (snapshot.status.kind === 'exited') {
          this.broadcast(record.dshSessionId, {
            kind: 'closed',
            reason: `exit code ${String(snapshot.status.exitCode)}`,
          })
          await this.dropMain(record)
        }
      } catch {
        // The PTY or its owner is gone: stop tailing.
        await this.dropMain(record)
      } finally {
        record.tailBusy = false
      }
    }
    record.tailTimer = setInterval(() => { void tick() }, TAIL_INTERVAL_MS)
  }

  /** The retained backend scrollback, oldest first (tail-capped by dsh). */
  private readAll(record: MainRecord): string {
    return this.ctx.terminals.read(record.agent, record.ptyId, { offset: 0, count: TAIL_READ_LINES }).text
  }

  private async dropMain(record: MainRecord): Promise<void> {
    if (record.tailTimer !== undefined) clearInterval(record.tailTimer)
    record.tailTimer = undefined
    await record.buffer.close().catch(() => {})
    this.mains.delete(record.agent)
  }

  private async disposeAll(): Promise<void> {
    for (const record of [...this.mains.values()]) {
      if (record.tailTimer !== undefined) clearInterval(record.tailTimer)
      await record.buffer.close().catch(() => {})
    }
    this.mains.clear()
    this.clients.clear()
    this.boundSession.clear()
  }

  private attachClient(client: WebSocket): void {
    client.on('message', (data: unknown) => {
      let frame: { kind?: string; sessionId?: string; text?: string; signal?: string }
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
      }
      // `resize` is accepted and ignored: rows/cols are fixed at spawn (§ 5).
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
    void this.ensureMainShell(dshSessionId).then((record) => {
      let set = this.clients.get(dshSessionId)
      if (set === undefined) {
        set = new Set()
        this.clients.set(dshSessionId, set)
      }
      set.add(client)
      this.boundSession.set(client, dshSessionId)
      client.send(JSON.stringify({
        kind: 'info', user: this.promptUser, host: this.promptHost, home: homedir(),
      }))
      client.send(JSON.stringify({
        kind: 'output',
        chunk: record.initializing ? '' : record.buffer.text(),
        time: Date.now(),
        replay: true,
      }))
    }, (error: unknown) => {
      client.send(JSON.stringify({ kind: 'error', message: String(error) }))
      client.close(1008, 'bind rejected')
    })
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

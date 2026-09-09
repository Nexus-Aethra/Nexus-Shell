/**
 * dshell-terminal-bridge host face — design 4.2 (main shell ownership),
 * 4.9 (scrollback persistence), and § 5 (the /dshell/pty wire protocol).
 *
 * The bridge owns one `name: 'main'` PTY per dsh session, keyed by the
 * exact Agent (dsh terminals are owner-scoped; the agent calling
 * `terminal_open` with `name: 'main'` mints a second PTY, never this
 * one). A tail loop polls the backend scrollback for new lines, appends
 * them to the per-session PtyBuffer (disk-backed, fixed memory window,
 * 4.9), and fans them out to the bound ws clients. Input frames are
 * serialized through `startSend` — one active send at a time, further
 * input queued; Ctrl+C (`\x03`) cancels the active send with SIGINT.
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

/** Poll interval for the backend scrollback tail loop. */
const TAIL_INTERVAL_MS = 200
/** Newest-line window probed per tick before deciding the incremental read. */
const TAIL_PROBE_LINES = 2000

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
  /** Backend retained scrollback lines already consumed. */
  seenLines: number
  /** Newest retained line as of the last tick (at-cap change detector). */
  lastNewest: string
  tailTimer: NodeJS.Timeout | undefined
  tailBusy: boolean
  activeSend: TerminalSendOperation | undefined
  inputQueue: string[]
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
      seenLines: 0,
      lastNewest: '',
      tailTimer: undefined,
      tailBusy: false,
      activeSend: undefined,
      inputQueue: [],
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
      // The init echo (export line + clear) never deserves screen space:
      // reset the buffer and every client history to a clean slate.
      record.buffer.truncate()
      this.broadcast(record.dshSessionId, { kind: 'output', chunk: '', time: Date.now(), replay: true })
      this.pump(record)
    }, () => {
      record.activeSend = undefined
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
        record.inputQueue.push(text)
        this.pump(record)
        record.activeSend?.done.then(() => {
          record.buffer.truncate()
          this.broadcast(dshSessionId, { kind: 'output', chunk: '', time: Date.now(), replay: true })
        }, () => {})
        return
      }
      record.inputQueue.push(text)
      this.pump(record)
    }, (error: unknown) => {
      console.warn('dshell-bridge: input dropped:', error)
    })
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

  /** Poll backend scrollback for new lines and fan them out. */
  private startTail(record: MainRecord): void {
    const tick = async (): Promise<void> => {
      if (record.tailBusy) return
      record.tailBusy = true
      try {
        const snapshot = this.ctx.terminals.list(record.agent)
          .find(item => item.sessionId === record.ptyId)
        if (snapshot === undefined) throw new Error('main PTY vanished')
        const probe = this.ctx.terminals.read(record.agent, record.ptyId, { offset: 0, count: 1 })
        const total = probe.totalLines
        if (total < record.seenLines
          || (total === record.seenLines && probe.truncated && probe.text !== record.lastNewest)) {
          // Backend retention slid under the cursor (cap reached): resync the
          // window from the full retained scrollback. Lines older than the
          // read bound are treated as consumed — they are unrecoverable.
          const full = this.ctx.terminals.read(record.agent, record.ptyId, { offset: 0, count: 100_000 })
          record.buffer.resync(full.text)
          record.seenLines = total
          record.lastNewest = probe.text
          this.broadcast(record.dshSessionId, {
            kind: 'output', chunk: full.text, time: Date.now(), replay: true,
          })
        } else if (total > record.seenLines) {
          // Consume unseen lines oldest-first until caught up. Relative
          // position p counts back from the newest line, so absolute index
          // = total - 1 - p and a page [offset, offset+want) covers absolute
          // [total-offset-want, total-offset); the cursor therefore advances
          // to `total - offset` per page. A page shorter than requested
          // (maxReadBytes bound) drops its head — acceptable for flood
          // output, matching dsh's own read bounds.
          let consumed = record.seenLines
          let chunk = ''
          for (;;) {
            const remaining = total - consumed
            if (remaining <= 0) break
            const want = Math.min(remaining, TAIL_PROBE_LINES)
            const offset = remaining - want
            const page = this.ctx.terminals.read(record.agent, record.ptyId, { offset, count: want })
            if (page.text.length > 0) {
              chunk = chunk.length === 0 ? page.text : `${chunk}\n${page.text}`
            }
            consumed = total - offset
          }
          record.seenLines = consumed
          record.lastNewest = probe.text
          if (chunk.length > 0) {
            record.buffer.append(chunk)
            this.broadcast(record.dshSessionId, { kind: 'output', chunk, time: Date.now() })
          }
        } else {
          record.lastNewest = probe.text
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
        kind: 'output', chunk: record.buffer.text(), time: Date.now(), replay: true,
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

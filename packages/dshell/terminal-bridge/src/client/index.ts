/**
 * dshell-terminal-bridge browser face — Phase 3.
 *
 * Opens one ws against `/dshell/pty`, binds it to the current dsh
 * session, and relays wire frames (§ 5) into a capped per-connection
 * frame store that the Phase 4 xterm.js canvas will render. Rebinds on
 * session switches and reconnects with a fixed delay after drops.
 *
 * `window.__DSHELL_PTY__` is the Phase 3 acceptance handle: it drives
 * input and reads the relayed buffer from the console. Phase 4 replaces
 * the console relay with the canvas.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

export const name = '@deepseek-ai/dsh-dshell-terminal-bridge/client'

export const inject = ['sessions'] as const

/** One PTY output chunk with its arrival time. */
export interface PtyChunk {
  text: string
  time: number
  /** True for the bind replay (4.9 seeded tail) or a resync. */
  replay: boolean
}

export interface PtyStreamState {
  sessionId: string | undefined
  status: 'idle' | 'connecting' | 'open' | 'closed' | 'error'
  /** Bumped on every history change; read the text via {@link read}. */
  version: number
}

/** Browser render-buffer cap per session: the canvas replays from this store. */
const HISTORY_MAX_BYTES = 256 * 1024
const HISTORY_MAX_FRAMES = 1000
const RECONNECT_DELAY_MS = 2000

interface WireFrame {
  kind?: string
  sessionId?: string
  chunk?: string
  time?: number
  replay?: boolean
  reason?: string
  message?: string
  /** `info` frames: OS identity the dock uses to build bash prompts. */
  user?: string
  host?: string
  home?: string
}

interface SessionHistory {
  chunks: PtyChunk[]
  bytes: number
}

/** Client face of the PTY wire: one ws, per-session frame histories. */
export class PtyStreamService extends Service {
  readonly state = createSnapshotStore<PtyStreamState>({
    sessionId: undefined,
    status: 'idle',
    version: 0,
  })

  /** OS identity from the server's `info` frame (bash prompt material). */
  readonly host = createSnapshotStore<{ user: string; host: string; home: string }>({
    user: '',
    host: '',
    home: '',
  })

  private readonly histories = new Map<string, SessionHistory>()
  private readonly chunkListeners = new Set<(sessionId: string, chunk: PtyChunk) => void>()
  private socket: WebSocket | undefined
  /** The session the current socket was opened (or is connecting) for. */
  private socketSession: string | undefined
  private desiredId: string | undefined
  private boundId: string | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: Context) {
    super(ctx, 'dshellPtyStream')
  }

  /** The persisted-and-live PTY text of one session (oldest first). */
  read(dshSessionId: string): string {
    const history = this.histories.get(dshSessionId)
    if (history === undefined) return ''
    let text = ''
    for (const chunk of history.chunks) text += chunk.text
    return text
  }

  /** The session's timed chunk list — the canvas merge's PTY side (4.4). */
  chunks(dshSessionId: string): readonly PtyChunk[] {
    return this.histories.get(dshSessionId)?.chunks ?? []
  }

  /** Switch the connection to one session (undefined disconnects). */
  bind(dshSessionId: string | undefined): void {
    this.desiredId = dshSessionId
    if (dshSessionId === undefined) {
      this.closeSocket()
      return
    }
    // Idempotent while the socket for this session is still connecting or
    // open: sessions.list churns several times around a session switch and
    // a redundant open would leave two live sockets feeding one history.
    const socket = this.socket
    if (socket !== undefined && this.socketSession === dshSessionId
      && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return
    this.openSocket(dshSessionId)
  }

  /** Forward one input chunk to the bound main PTY. */
  send(text: string): void {
    if (this.boundId === undefined || this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ kind: 'input', sessionId: this.boundId, text }))
  }

  /** Resize the bound main PTY (the raw backend honors cols/rows). */
  resize(cols: number, rows: number): void {
    if (this.boundId === undefined || this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ kind: 'resize', sessionId: this.boundId, cols, rows }))
  }

  /**
   * Subscribe to every ingested chunk, tagged with its session — the
   * canvas renderer streams frames into the xterm buffer incrementally.
   */
  onChunk(listener: (sessionId: string, chunk: PtyChunk) => void): () => void {
    this.chunkListeners.add(listener)
    return () => { this.chunkListeners.delete(listener) }
  }

  /** Deliver a foreground signal to the bound main PTY. */
  sendSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGTSTP'): void {
    if (this.boundId === undefined || this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ kind: 'signal', sessionId: this.boundId, signal }))
  }

  private openSocket(dshSessionId: string): void {
    this.closeSocket()
    this.patch({ sessionId: dshSessionId, status: 'connecting' })
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/dshell/pty`)
    this.socket = socket
    this.socketSession = dshSessionId
    socket.onopen = () => {
      socket.send(JSON.stringify({ kind: 'bind', sessionId: dshSessionId }))
    }
    socket.onmessage = (event) => {
      // A superseded socket (handover already moved on) must never feed
      // history: the server may still deliver to it while its close
      // handshake finishes.
      if (this.socket !== socket) return
      let frame: WireFrame
      try {
        frame = JSON.parse(String(event.data)) as WireFrame
      } catch {
        return
      }
      if (frame.kind === 'output' && typeof frame.chunk === 'string') {
        this.boundId = dshSessionId
        this.patch({ status: 'open' })
        this.ingest(dshSessionId, {
          text: frame.chunk,
          time: frame.time ?? Date.now(),
          replay: frame.replay === true,
        })
        if (frame.replay !== true) console.debug('[dshell-pty]', frame.chunk)
        return
      }
      if (frame.kind === 'info') {
        this.host.set({
          user: typeof frame.user === 'string' ? frame.user : '',
          host: typeof frame.host === 'string' ? frame.host : '',
          home: typeof frame.home === 'string' ? frame.home : '',
        })
        return
      }
      if (frame.kind === 'closed') {
        this.patch({ status: 'closed' })
        console.warn('[dshell-pty] main shell closed:', frame.reason)
        return
      }
      if (frame.kind === 'error') {
        this.patch({ status: 'error' })
        console.warn('[dshell-pty] server error:', frame.message)
      }
    }
    socket.onclose = () => {
      // Only the current socket owns teardown and reconnection; a
      // superseded socket's close (handover or deliberate disconnect)
      // must not clear live state or schedule a reconnect.
      if (this.socket !== socket) return
      this.socket = undefined
      this.socketSession = undefined
      this.boundId = undefined
      if (this.desiredId === undefined) return
      this.patch({ status: 'closed' })
      if (this.reconnectTimer !== undefined) return
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        if (this.desiredId !== undefined) this.openSocket(this.desiredId)
      }, RECONNECT_DELAY_MS)
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.patch({ status: 'error' })
    }
  }

  private closeSocket(): void {
    this.socket?.close()
    this.socket = undefined
    this.socketSession = undefined
    this.boundId = undefined
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  /** Ingest one wire chunk into the session's history (replay resets it). */
  private ingest(dshSessionId: string, chunk: PtyChunk): void {
    let history = this.histories.get(dshSessionId)
    if (history === undefined) {
      history = { chunks: [], bytes: 0 }
      this.histories.set(dshSessionId, history)
    }
    if (chunk.replay) {
      history.chunks = [chunk]
      history.bytes = chunk.text.length
    } else {
      history.chunks = [...history.chunks, chunk]
      history.bytes += chunk.text.length
      while (history.bytes > HISTORY_MAX_BYTES || history.chunks.length > HISTORY_MAX_FRAMES) {
        const dropped = history.chunks[0]
        if (dropped === undefined || history.chunks.length === 1) break
        history.chunks = history.chunks.slice(1)
        history.bytes -= dropped.text.length
      }
    }
    this.patch({ version: this.state.getSnapshot().version + 1 })
    for (const listener of [...this.chunkListeners]) listener(dshSessionId, chunk)
  }

  private patch(patch: Partial<PtyStreamState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...patch })
  }
}

/** Phase 3 acceptance handle: drive and inspect the PTY wire from the console. */
export interface DshellPtyDebug {
  session(): string | undefined
  status(): PtyStreamState['status']
  send(text: string): void
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGTSTP'): void
  text(): string
}

declare global {
  interface Window {
    __DSHELL_PTY__?: DshellPtyDebug
  }
}

/**
 * Mount the wire client and follow the current session.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // Cast through unknown: the 'sessions' key collides across faces in this
  // package's single tsc program (host SessionStore from dsh-session vs
  // client ISessions) and skipLibCheck hides the conflict, so the merged
  // type is not the client face here. Same cast dsh's own ui-workspace
  // applies at runtime typing.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const stream = new PtyStreamService(ctx)

  const reconcile = (): void => {
    stream.bind(sessions.list.getSnapshot().current)
  }
  ctx.effect(() => {
    const dispose = sessions.list.subscribe(reconcile)
    reconcile()
    return dispose
  }, 'dshell-bridge: follow current session')

  window.__DSHELL_PTY__ = {
    session: () => stream.state.getSnapshot().sessionId,
    status: () => stream.state.getSnapshot().status,
    send: (text) => { stream.send(text) },
    signal: (signal) => { stream.sendSignal(signal) },
    text(): string {
    const sessionId = stream.state.getSnapshot().sessionId
    return sessionId === undefined ? '' : stream.read(sessionId)
  }
  }
}

export default { name, inject, apply }

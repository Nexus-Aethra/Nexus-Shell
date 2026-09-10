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

/**
 * Arrival-timeline persistence (localStorage). A bind replay delivers the
 * whole retained scrollback as ONE frame, so its text has a single timestamp
 * and a rebuild cannot place it between the session's task blocks — the shell
 * history collapses to the end of the timeline. Recording `(time, length)` per
 * live frame lets a rebuild slice that text back into its original pieces.
 */
const TIMELINE_STORAGE_PREFIX = 'dshell.pty.timeline.'
const TIMELINE_MAX_ENTRIES = 2000
const TIMELINE_MAX_BYTES = 256 * 1024
const TIMELINE_SAVE_DELAY_MS = 500

/** One live frame's arrival time and character count. */
interface TimelineEntry {
  t: number
  n: number
}

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

/** One timed slice of a session's PTY text, for timeline placement. */
export interface PtyTextSegment {
  readonly text: string
  readonly time: number
}

function timelineKey(sessionId: string): string {
  return `${TIMELINE_STORAGE_PREFIX}${sessionId}`
}

/** Read a session's persisted arrival timeline; anything malformed reads empty. */
function loadTimeline(sessionId: string): TimelineEntry[] {
  try {
    const raw = window.localStorage.getItem(timelineKey(sessionId))
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: TimelineEntry[] = []
    for (const item of parsed) {
      if (!Array.isArray(item)) continue
      const [t, n] = item as [unknown, unknown]
      if (typeof t === 'number' && typeof n === 'number' && n > 0) entries.push({ t, n })
    }
    return entries
  } catch {
    return []
  }
}

function timelineBytes(entries: readonly TimelineEntry[]): number {
  let total = 0
  for (const entry of entries) total += entry.n
  return total
}

interface SessionHistory {
  chunks: PtyChunk[]
  bytes: number
  /** Arrival timeline of live frames, oldest first (see the storage block). */
  timeline: TimelineEntry[]
  /** Bytes the timeline accounts for. */
  recorded: number
  /** Debounced localStorage write. */
  saveTimer: ReturnType<typeof setTimeout> | undefined
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

  /**
   * The session's PTY text as timed segments. A bind replay arrives as one
   * frame, so a rebuild that used chunk timestamps would place the whole
   * scrollback at the moment of the bind; this slices it back with the
   * arrival times recorded per live frame.
   * @param dshSessionId - the session whose stream to slice.
   * @returns oldest-first segments; a session with no recorded timeline falls
   *   back to its chunks, which is what a fresh browser sees.
   */
  segments(dshSessionId: string): readonly PtyTextSegment[] {
    const history = this.histories.get(dshSessionId)
    if (history === undefined) return []
    const timeline = history.timeline
    if (timeline.length === 0) {
      return history.chunks.filter(chunk => chunk.text.length > 0).map(chunk => ({ text: chunk.text, time: chunk.time }))
    }
    const text = this.read(dshSessionId)
    if (text.length === 0) return []
    const segments: PtyTextSegment[] = []
    let end = text.length
    for (let index = timeline.length - 1; index >= 0 && end > 0; index -= 1) {
      const entry = timeline[index]
      if (entry === undefined) continue
      const start = Math.max(0, end - entry.n)
      segments.push({ text: text.slice(start, end), time: entry.t })
      end = start
    }
    if (end > 0) {
      // Bytes older than the recorded timeline (evicted, or a stream this
      // browser never watched): one segment at the oldest time we know.
      const oldest = timeline[0]?.t ?? 0
      segments.push({ text: text.slice(0, end), time: oldest })
    }
    return segments.reverse()
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
    const history = this.historyFor(dshSessionId)
    if (chunk.replay) {
      history.chunks = [chunk]
      history.bytes = chunk.text.length
      // Keep only the timeline entries the replayed text still covers: a
      // resync replaces the stream, so entries older than it are meaningless.
      while (history.timeline.length > 0 && history.recorded > chunk.text.length) {
        const dropped = history.timeline.shift()
        history.recorded -= dropped?.n ?? 0
      }
    } else {
      history.chunks = [...history.chunks, chunk]
      history.bytes += chunk.text.length
      while (history.bytes > HISTORY_MAX_BYTES || history.chunks.length > HISTORY_MAX_FRAMES) {
        const dropped = history.chunks[0]
        if (dropped === undefined || history.chunks.length === 1) break
        history.chunks = history.chunks.slice(1)
        history.bytes -= dropped.text.length
      }
      history.timeline.push({ t: chunk.time, n: chunk.text.length })
      history.recorded += chunk.text.length
      while (history.timeline.length > TIMELINE_MAX_ENTRIES || history.recorded > TIMELINE_MAX_BYTES) {
        const dropped = history.timeline.shift()
        if (dropped === undefined) break
        history.recorded -= dropped.n
      }
    }
    this.scheduleTimelineSave(dshSessionId, history)
    this.patch({ version: this.state.getSnapshot().version + 1 })
    for (const listener of [...this.chunkListeners]) listener(dshSessionId, chunk)
  }

  /** The per-session history, seeding the arrival timeline from storage once. */
  private historyFor(dshSessionId: string): SessionHistory {
    const existing = this.histories.get(dshSessionId)
    if (existing !== undefined) return existing
    const timeline = loadTimeline(dshSessionId)
    const history: SessionHistory = {
      chunks: [],
      bytes: 0,
      timeline,
      recorded: timelineBytes(timeline),
      saveTimer: undefined,
    }
    this.histories.set(dshSessionId, history)
    return history
  }

  /** Coalesce timeline writes: a chatty shell would otherwise serialize per frame. */
  private scheduleTimelineSave(dshSessionId: string, history: SessionHistory): void {
    if (history.saveTimer !== undefined) return
    history.saveTimer = setTimeout(() => {
      history.saveTimer = undefined
      try {
        const pairs = history.timeline.map(entry => [entry.t, entry.n])
        window.localStorage.setItem(timelineKey(dshSessionId), JSON.stringify(pairs))
      } catch {
        // Storage full or unavailable: the timeline is an optimization, so a
        // failed write only costs the interleaving after the next reload.
      }
    }, TIMELINE_SAVE_DELAY_MS)
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

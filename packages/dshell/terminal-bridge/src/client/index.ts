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
import {
  TIMELINE_LIMITS,
  loadTimeline,
  saveTimeline,
  segmentsOf,
  splitByTime,
  timelineBytes,
  type PtyTextSegment,
  type TimelineEntry,
} from './timeline.js'

export type { PtyTextSegment, TimelineEntry } from './timeline.js'

export const name = '@deepseek-ai/dsh-dshell-terminal-bridge/client'

export const inject = ['sessions'] as const

/** One host-defined block: a shell stretch or one agent turn, in order. */
export interface PtyBlock {
  readonly seq: number
  readonly kind: 'shell' | 'agent'
  readonly turn?: number | undefined
  readonly startedAt: number
  readonly endedAt?: number | undefined
  readonly text: string
}

/** One PTY output chunk with its arrival time. */
export interface PtyChunk {
  text: string
  time: number
  /** True for the bind replay (4.9 seeded tail) or a resync. */
  replay: boolean
  /**
   * On a replay, the host's own arrival timeline for this text: a replay is
   * one frame, so without it the whole scrollback would carry a single
   * timestamp and every shell region would collapse to one end of the
   * timeline.
   */
  timeline?: readonly { t: number; n: number }[]
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
 * Drop `count` characters from the front of a history's arrival timeline,
 * splitting the entry that straddles the cut.
 */
function dropTimeline(history: SessionHistory, count: number): void {
  let remaining = count
  while (remaining > 0 && history.timeline.length > 0) {
    const head = history.timeline[0]
    if (head === undefined) return
    if (head.n <= remaining) {
      remaining -= head.n
      history.timeline.shift()
      history.recorded -= head.n
    } else {
      head.n -= remaining
      history.recorded -= remaining
      remaining = 0
    }
  }
}

/** One wire frame from the bridge (`§ 5`). */
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
  /** `(time, length)` pairs the host kept for the replayed text. */
  timeline?: [number, number][]
  /** `blocks` frames: the host's ordered block list, replacing the client's. */
  blocks?: PtyBlock[]
  /** `block-text` frames: a delta appended to one open block. */
  seq?: number
  text?: string
}

/** Debounce before a changed timeline is written back to localStorage. */
const TIMELINE_SAVE_DELAY_MS = 500

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
  /** Per-session block lists, exactly as the host ordered them. The stored
   * copy is mutable because a live block grows by deltas. */
  private readonly blockLists = new Map<string, {
    seq: number
    kind: 'shell' | 'agent'
    turn?: number | undefined
    startedAt: number
    endedAt?: number | undefined
    text: string
  }[]>()
  private readonly chunkListeners = new Set<(sessionId: string, chunk: PtyChunk) => void>()
  private socket: WebSocket | undefined
  /** The session the current socket was opened (or is connecting) for. */
  private socketSession: string | undefined
  private desiredId: string | undefined
  private boundId: string | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The grid the view last asked for.
   *
   * Kept because the request can arrive before the socket is up (the view
   * measures on mount, the socket may still be connecting) and because a
   * reconnected or newly spawned shell must not start at the backend's default
   * size. Without this the PTY keeps whatever size it was spawned with, so the
   * shell wraps and pads its output to a width the view does not have.
   */
  private desiredSize: { cols: number; rows: number } | undefined

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

  /** The session's host-defined blocks, in render order. */
  blocks(dshSessionId: string): readonly PtyBlock[] {
    return this.blockLists.get(dshSessionId) ?? []
  }

  /** The session's timed chunk list — the canvas merge's PTY side (4.4). */
  chunks(dshSessionId: string): readonly PtyChunk[] {
    return this.histories.get(dshSessionId)?.chunks ?? []
  }

  /**
   * The session's PTY text cut at wall-clock boundaries: piece i is what the
   * terminal printed before the i-th boundary, and the final piece is
   * everything after the last one. The block view uses the task starts as
   * boundaries, so each shell stretch lands between the tasks it sat between.
   * @param dshSessionId - the session whose text to cut.
   * @param boundaries - ascending epoch-ms cuts.
   * @returns `boundaries.length + 1` pieces, oldest first.
   */
  slices(dshSessionId: string, boundaries: readonly number[]): readonly { text: string; time: number }[] {
    const history = this.histories.get(dshSessionId)
    if (history === undefined) return []
    return splitByTime(this.read(dshSessionId), history.timeline, history.chunks, boundaries)
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
    if (history.timeline.length === 0) {
      return history.chunks.filter(chunk => chunk.text.length > 0).map(chunk => ({ text: chunk.text, time: chunk.time }))
    }
    return segmentsOf(this.read(dshSessionId), history.timeline)
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

  /**
   * Resize the bound main PTY (the raw backend honors cols/rows).
   *
   * The request is remembered as well as sent: this can run before the socket
   * is open, and the size has to be replayed when it is, or the PTY keeps the
   * backend's default grid for the session's whole life.
   */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    this.desiredSize = { cols, rows }
    this.flushSize()
  }

  /** Send the remembered grid, if the bound socket can carry it. */
  private flushSize(): void {
    if (this.boundId === undefined || this.desiredSize === undefined) return
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ kind: 'resize', sessionId: this.boundId, ...this.desiredSize }))
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
      this.boundId = dshSessionId
      // Replay the grid this session's view already asked for: a request made
      // while the socket was still connecting was remembered, not lost, and
      // the shell about to be spawned must start at it.
      this.flushSize()
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
          ...(Array.isArray(frame.timeline)
            ? { timeline: frame.timeline.map(pair => ({ t: pair[0], n: pair[1] })) }
            : {}),
        })
        if (frame.replay !== true) console.debug('[dshell-pty]', frame.chunk)
        return
      }
      if (frame.kind === 'blocks' && Array.isArray(frame.blocks)) {
        const sessionId = this.boundId
        if (sessionId !== undefined) {
          this.blockLists.set(sessionId, frame.blocks.map(block => ({ ...block })))
          this.patch({ version: this.state.getSnapshot().version + 1 })
        }
        return
      }
      if (frame.kind === 'block-text' && typeof frame.seq === 'number' && typeof frame.text === 'string') {
        const sessionId = this.boundId
        const list = sessionId === undefined ? undefined : this.blockLists.get(sessionId)
        const block = list?.find(candidate => candidate.seq === frame.seq)
        if (block !== undefined) {
          block.text += frame.text
          this.patch({ version: this.state.getSnapshot().version + 1 })
        }
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
      if (chunk.timeline !== undefined && chunk.timeline.length > 0) {
        // The host watched every frame, so its timeline is authoritative for
        // the text it just shipped.
        history.timeline = chunk.timeline.map(entry => ({ t: entry.t, n: entry.n }))
        history.recorded = timelineBytes(history.timeline)
      } else if (history.recorded !== chunk.text.length) {
        // No timeline came with the replay and the one we hold describes a
        // different text: keeping it would time offsets by the wrong frame.
        history.timeline = []
        history.recorded = 0
      }
    } else {
      history.chunks = [...history.chunks, chunk]
      history.bytes += chunk.text.length
      while (history.bytes > HISTORY_MAX_BYTES || history.chunks.length > HISTORY_MAX_FRAMES) {
        const dropped = history.chunks[0]
        if (dropped === undefined || history.chunks.length === 1) break
        history.chunks = history.chunks.slice(1)
        history.bytes -= dropped.text.length
        // A dropped chunk's bytes leave the text, so its arrival entry must
        // leave the timeline: the two are sliced against each other.
        dropTimeline(history, dropped.text.length)
      }
      history.timeline.push({ t: chunk.time, n: chunk.text.length })
      history.recorded += chunk.text.length
      while (history.timeline.length > TIMELINE_LIMITS.entries || history.recorded > TIMELINE_LIMITS.bytes) {
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
      saveTimeline(dshSessionId, history.timeline)
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
  },
  }
}

export default { name, inject, apply }

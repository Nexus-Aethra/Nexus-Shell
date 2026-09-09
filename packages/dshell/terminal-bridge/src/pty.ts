/**
 * dshell raw PTY backend — the canvas phase.
 *
 * dsh's terminal-bash backend sanitizes all ANSI out of scrollback (a
 * documented line-oriented decision), which starves a real terminal
 * canvas. This backend owns the dshell main shells instead: a plain
 * node-pty bash with TERM=xterm-256color, raw bytes retained and
 * streamed to the bridge verbatim (colors, cursor control, readline
 * redraws all reach the browser). The agent-facing surface
 * (`terminal_read`, send viewports, motd) is ANSI-stripped so tool
 * results stay clean text.
 *
 * Send settle is ours: PROMPT_COMMAND prints the OSC 133;D marker before
 * every prompt, so a settled prompt is "marker seen and the stream is
 * quiet" — the ~60ms fast path — with a 350ms silence fallback and an
 * absolute timeout. No sanitizer, no dsh-side prompt-text dependency.
 */

import { StringDecoder } from 'node:string_decoder'
import * as nodePty from 'node-pty'
import { TerminalError } from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendOperation,
  TerminalSendRead,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalSessionId,
  TerminalSessionStatus,
  TerminalSignal,
  TerminalSignalResult,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import type { TerminalBackendSpawnSpec } from '@deepseek-ai/dsh-terminal'

/** Retention bounds for one raw session (mirrors dsh's own defaults). */
const RETAINED_MAX_BYTES = 4 * 1024 * 1024
const RETAINED_MAX_LINES = 10_000
/** One read/send result caps at this many bytes (tail kept). */
const MAX_RESULT_BYTES = 256 * 1024

/** Settle tuning: marker fast path, silence fallback, absolute bound. */
const PROMPT_QUIET_MS = 60
const SILENT_SETTLE_MS = 350
const SEND_TIMEOUT_MS = 15_000
const SETTLE_POLL_MS = 25

/** Prompt-end marker our PROMPT_COMMAND prints before every prompt. */
const PROMPT_MARKER = '\u001b]133;D;'
const MARKER_CARRY_CHARS = 64

/** Strip CSI/OSC/two-byte escape sequences and BEL for plain-text reads. */
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replaceAll('\u0007', '')
}

/** node-pty reports numeric signals; map the common ones to their names. */
function exitSignalName(signal: number | undefined): NodeJS.Signals | null {
  switch (signal) {
    case undefined:
    case 0:
      return null
    case 1:
      return 'SIGHUP'
    case 2:
      return 'SIGINT'
    case 3:
      return 'SIGQUIT'
    case 9:
      return 'SIGKILL'
    case 15:
      return 'SIGTERM'
    case 20:
    case 24:
      return 'SIGTSTP'
    default:
      return null
  }
}

/** Cap to the newest `maxBytes` UTF-8 bytes without splitting a codepoint. */
function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start++
  return { text: bytes.subarray(start).toString('utf8'), truncated: true }
}

/** Push-based rich session the bridge consumes for the canvas wire. */
export interface DshellPtySession extends TerminalBackendSession {
  /** Subscribe to raw ANSI output chunks (the bridge is the sole consumer). */
  onOutput(listener: (chunk: string) => void): () => void
  /** Subscribe to process exit. */
  onExit(listener: (status: TerminalSessionStatus) => void): () => void
  /** Resize the pty (the browser canvas drives this). */
  resize(cols: number, rows: number): void
}

class RawSendOperation implements TerminalSendOperation {
  private readonly resolvers = Promise.withResolvers<TerminalSendResult>()
  private finished = false
  private cancelled = false
  private viewport = ''

  constructor(private readonly onCancel: () => void) {}

  get done(): Promise<TerminalSendResult> {
    return this.resolvers.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancelled
  }

  append(text: string): void {
    if (!this.finished) this.viewport += text
  }

  settle(waitReason: TerminalWaitReason, status: TerminalSessionStatus): void {
    if (this.finished) return
    this.finished = true
    const bounded = utf8Tail(stripAnsi(this.viewport), MAX_RESULT_BYTES)
    this.resolvers.resolve({
      viewport: bounded.text,
      waitReason,
      sessionStatus: status,
      truncated: bounded.truncated,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.resolvers.reject(error)
  }

  readOutput(): TerminalSendRead {
    const delta = this.viewport
    this.viewport = ''
    return { delta, truncated: false }
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancelled = true
    this.onCancel()
    return true
  }
}

/** One raw bash PTY session owned by the dshell backend. */
class LocalRawSession implements DshellPtySession {
  motd = ''
  readonly pid: number

  private readonly pty: nodePty.IPty
  private readonly decoder = new StringDecoder('utf8')
  private retained = ''
  private retainedTruncated = false
  private readonly outputListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(status: TerminalSessionStatus) => void>()
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  private active: RawSendOperation | undefined
  private markerCarry = ''
  private lastOutputAt = Date.now()
  private markerAt = 0
  private settleTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    readonly id: TerminalSessionId,
    cwd: string | undefined,
    cols: number,
    rows: number,
  ) {
    this.pty = nodePty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
      name: 'xterm-256color',
      cols,
      rows,
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
    this.pid = this.pty.pid
    this.pty.onData((data: string) => { this.onData(data) })
    this.pty.onExit(({ exitCode, signal }) => {
      this.statusValue = { kind: 'exited', exitCode, signal: exitSignalName(signal) }
      this.settleActive('session_exit')
      for (const listener of [...this.exitListeners]) listener(this.statusValue)
    })
  }

  /** Capture the first prompt as the motd (dsh's startup contract). */
  async initialize(signal?: AbortSignal): Promise<void> {
    const operation = this.startSend({ text: '', submit: false })
    const result = await operation.done
    signal?.throwIfAborted()
    if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
    if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
    this.motd = result.viewport
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closed) throw new TerminalError('PTY session is closing', 'NO_SESSION')
    if (this.statusValue.kind === 'exited') throw new TerminalError('PTY session has exited', 'NO_SESSION')
    if (this.active !== undefined) {
      throw new TerminalError('PTY session already has an active send', 'SEND_ACTIVE')
    }
    const operation = new RawSendOperation(() => {
      // Cancel = SIGINT to the foreground group, via the line discipline.
      if (this.statusValue.kind === 'running') this.pty.write('\u0003')
    })
    this.active = operation
    const input = `${request.text}${request.submit ? '\r' : ''}`
    if (input.length > 0 && !operation.cancelRequested) {
      this.pty.write(input)
    }
    this.scheduleSettle(operation, input.length > 0)
    return operation
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const lines = this.retained.length === 0 ? [] : this.retained.split('\n')
    const totalLines = lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: this.retainedTruncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const bounded = utf8Tail(stripAnsi(lines.slice(start, end).join('\n')), MAX_RESULT_BYTES)
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + (bounded.text.length === 0 ? 0 : bounded.text.split('\n').length),
      truncated: this.retainedTruncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    // The pty line discipline delivers SIGINT/SIGTSTP from control chars to
    // the true foreground group; other signals target the shell's group.
    if (signal === 'SIGINT') this.pty.write('\u0003')
    else if (signal === 'SIGTSTP') this.pty.write('\u001a')
    else this.killTree(signal)
    return { delivered: true, targetPgid: this.pid }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  async close(reason: string): Promise<void> {
    void reason
    if (this.closed) return
    this.closed = true
    if (this.statusValue.kind === 'running') {
      this.killTree('SIGTERM')
      // Give the process tree half a second to exit before the hard kill.
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 500)
        const onExit = (): void => { clearTimeout(deadline); this.exitListeners.delete(onExit); resolve() }
        this.exitListeners.add(onExit)
      })
      if (this.statusValue.kind === 'running') this.pty.kill()
    } else {
      this.pty.kill()
    }
  }

  onOutput(listener: (chunk: string) => void): () => void {
    this.outputListeners.add(listener)
    return () => { this.outputListeners.delete(listener) }
  }

  onExit(listener: (status: TerminalSessionStatus) => void): () => void {
    this.exitListeners.add(listener)
    if (this.statusValue.kind === 'exited') listener(this.statusValue)
    return () => { this.exitListeners.delete(listener) }
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.pty.resize(cols, rows)
  }

  /** Latest raw output snapshot (the bridge seeds nothing from this; its buffer owns history). */
  snapshot(): string {
    return this.retained
  }

  private onData(data: string): void {
    const text = this.decoder.write(data)
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.retained += text
    this.trimRetained()
    this.trackMarker(text)
    for (const listener of [...this.outputListeners]) listener(text)
    this.active?.append(text)
  }

  private trimRetained(): void {
    for (;;) {
      if (this.retained.length === 0) return
      const lines = this.retained.split('\n')
      const overLines = lines.length > RETAINED_MAX_LINES
      const overBytes = Buffer.byteLength(this.retained) > RETAINED_MAX_BYTES
      if (!overLines && !overBytes) return
      const drop = overLines ? lines.length - RETAINED_MAX_LINES : 1
      this.retained = lines.slice(drop).join('\n')
      this.retainedTruncated = true
    }
  }

  /** Marker scan with a small carry so sequences split across chunks match. */
  private trackMarker(chunk: string): void {
    const combined = this.markerCarry + chunk
    if (combined.includes(PROMPT_MARKER)) this.markerAt = Date.now()
    this.markerCarry = combined.slice(-MARKER_CARRY_CHARS)
  }

  private scheduleSettle(operation: RawSendOperation, wroteInput: boolean): void {
    void wroteInput
    const startedAt = Date.now()
    const tick = (): void => {
      if (this.active !== operation || operation.settled || this.closed) return
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      const now = Date.now()
      const quietFor = now - this.lastOutputAt
      const sinceMarker = now - this.markerAt
      // Fast path: our PROMPT_COMMAND's end-of-command marker landed and
      // the stream stayed quiet — the prompt is up and bash owns stdin.
      if (this.markerAt > 0 && sinceMarker < 1000 && quietFor >= PROMPT_QUIET_MS) {
        this.settleActive('stdin_read')
        return
      }
      if (quietFor >= SILENT_SETTLE_MS) {
        this.settleActive('inferred_idle')
        return
      }
      if (now - startedAt >= SEND_TIMEOUT_MS) {
        this.settleActive('timeout')
        return
      }
      this.settleTimer = setTimeout(tick, SETTLE_POLL_MS)
    }
    this.settleTimer = setTimeout(tick, SETTLE_POLL_MS)
  }

  private settleActive(waitReason: TerminalWaitReason): void {
    const operation = this.active
    if (operation === undefined) return
    if (this.settleTimer !== undefined) {
      clearTimeout(this.settleTimer)
      this.settleTimer = undefined
    }
    this.active = undefined
    operation.settle(waitReason, this.statusValue)
  }

  private killTree(signal: NodeJS.Signals | TerminalSignal): void {
    try { process.kill(-this.pid, signal as NodeJS.Signals) } catch { /* already gone */ }
    try { process.kill(this.pid, signal as NodeJS.Signals) } catch { /* already gone */ }
  }
}

/** Backend providing raw dshell main-shell sessions under type `dshell-pty`. */
export class DshellPtyBackend implements TerminalBackend {
  readonly type = 'dshell-pty'

  private readonly sessions = new Map<TerminalSessionId, LocalRawSession>()
  private disposed = false

  constructor(
    private readonly cols: number,
    private readonly rows: number,
  ) {}

  /** The rich handle for a session this backend spawned (bridge wiring). */
  session(id: TerminalSessionId): DshellPtySession | undefined {
    return this.sessions.get(id)
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    if (this.disposed) throw new TerminalError('dshell PTY backend is disposing', 'NO_SESSION')
    spec.signal?.throwIfAborted()
    const session = new LocalRawSession(
      spec.sessionId as TerminalSessionId,
      spec.cwd,
      this.cols,
      this.rows,
    )
    this.sessions.set(spec.sessionId as TerminalSessionId, session)
    try {
      await session.initialize(spec.signal)
      return session
    } catch (error) {
      this.sessions.delete(session.id)
      await session.close('dshell PTY startup failed').catch(() => {})
      throw error
    }
  }

  /** Release every session's pty (service teardown). */
  dispose(): void {
    this.disposed = true
    for (const session of this.sessions.values()) {
      void session.close('dshell PTY backend disposed').catch(() => {})
    }
    this.sessions.clear()
  }
}

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

/**
 * What ssh says when it cannot connect, matched loosely on purpose: these
 * strings are printed by the `ssh` client in every locale-relevant failure we
 * care about (refused, timed out, key rejected, name not resolved).
 */
const SSH_DIAGNOSTIC =
  /(ssh:|kex_exchange_identification|Connection (?:refused|timed out|closed|reset)|Permission denied|Host key verification failed|Could not resolve hostname|No route to host|Network is unreachable|Operation timed out)/i

/**
 * The last connection diagnostic in a stretch of terminal output.
 *
 * A device session's terminal is a local `ssh` process, so "cannot connect"
 * arrives as that process's stderr — merged into the same PTY stream as
 * everything else, and gone once the session is torn down. When the shell dies
 * there is no structured error to read (node-pty reports an exit code only), so
 * the reason has to be recovered from the text. A line that does not look like
 * an ssh diagnostic is never returned: no match means no detail line, rather
 * than an arbitrary last line presented as the cause.
 *
 * @param text - raw terminal output, ANSI included.
 * @param maxChars - cap on the returned line, which is shown in a narrow banner.
 * @returns the diagnostic line, or undefined when the output has none.
 */
export function diagnosticTail(text: string, maxChars = 240): string | undefined {
  const lines = stripAnsi(text).split('\n')
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]?.trim() ?? ''
    if (line === '' || !SSH_DIAGNOSTIC.test(line)) continue
    return line.length > maxChars ? line.slice(0, maxChars) : line
  }
  return undefined
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

/**
 * How a dead PTY is named to the user: the signal that killed it, else its
 * exit code.
 *
 * node-pty reports a killed process as `exitCode: 0, signal: 9`, so listing
 * both would read as a clean exit; the signal is the true story.
 *
 * @param status - the `exited` status of a terminal session.
 * @returns a short human-readable cause.
 */
export function exitLabel(status: Extract<TerminalSessionStatus, { kind: 'exited' }>): string {
  if (status.signal !== null) return `signal ${status.signal}`
  return `exit code ${status.exitCode === null ? 'unknown' : String(status.exitCode)}`
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
  /** Top-level process id; present for every PTY this backend spawns. */
  readonly pid: number
  /**
   * Whether the spawn plan sent this shell somewhere else.
   *
   * A device session's terminal is a local `ssh` process, so that process's own
   * working directory says nothing about the directory the user's shell is in.
   */
  readonly redirected: boolean
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

/**
 * What one PTY should run.
 *
 * The default is the local interactive bash. A device-bound session replaces it
 * with `ssh … -t 'cd <dir> && exec bash -l'`, so the user's own terminal is the
 * device's shell instead of a local one sitting in an empty mount directory.
 * `env` is merged over the process environment — that is how the password-auth
 * askpass hook reaches ssh.
 */
export interface PtySpawnPlan {
  readonly argv: readonly string[]
  readonly env?: Record<string, string> | undefined
}

/** What the backend knows about the session whose terminal it is about to spawn. */
export interface PtySpawnQuery {
  /** Session-backed agent identity: the key a binding is written under. */
  readonly sessionId: string | undefined
  /** The session's own directory, which for a bound session IS its device mount. */
  readonly cwd: string | undefined
}

/**
 * How the backend asks whether a session's terminal should run somewhere else.
 *
 * Answered by session identity, with the directory as context. Directory alone
 * cannot identify the caller: one device tree's mount directory is shared by
 * every session bound to that device and root, and a session that merely
 * inherited a mount path as its cwd (an unbound session) would then borrow a
 * device shell it has no binding for. The bridge supplies this; keeping it a
 * plain function here means this package does not depend on the SSH plugin, and
 * a composition without it simply gets local shells.
 */
export type PtySpawnPlanResolver = (
  query: PtySpawnQuery,
) => PtySpawnPlan | undefined | Promise<PtySpawnPlan | undefined>

/** The default local interactive shell, unchanged from before this seam existed. */
const LOCAL_SHELL: PtySpawnPlan = { argv: ['/bin/bash', '--noprofile', '--norc', '-i'] }

/** One raw PTY session owned by the dshell backend. */
class LocalRawSession implements DshellPtySession {
  motd = ''
  readonly pid: number
  /** A plan that is not the local default means the shell runs elsewhere. */
  readonly redirected: boolean

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
    plan: PtySpawnPlan = LOCAL_SHELL,
  ) {
    const [file, ...args] = plan.argv
    if (file === undefined) throw new Error('dshell PTY: spawn plan has no program')
    this.pty = nodePty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      env: { ...process.env, TERM: 'xterm-256color', ...plan.env } as Record<string, string>,
    })
    this.pid = this.pty.pid
    this.redirected = plan !== LOCAL_SHELL
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
    if (result.waitReason === 'session_exit' || result.waitReason === 'timeout') {
      // Carry the diagnostic out with the failure: this is the last moment the
      // session exists, and the output that says WHY (ssh's own stderr) is
      // about to be discarded with it. Without this a failed device session
      // reports only "the shell exited", which names neither the host nor the
      // cause.
      const status = result.sessionStatus
      // "before its first prompt", not "during startup": this same failure is
      // what a respawn after a dropped connection produces, where nothing is
      // starting up — it is the NEW shell that never got to a prompt.
      const head = result.waitReason === 'session_exit'
        ? `PTY shell exited before its first prompt${status.kind === 'exited' ? ` (${exitLabel(status)})` : ''}`
        : 'PTY shell did not reach a prompt before the startup timeout'
      const detail = diagnosticTail(this.retained)
      throw new Error(detail === undefined ? head : `${head}：${detail}`)
    }
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

/**
 * Backend providing raw dshell main-shell sessions.
 *
 * The type is `shell` — the name dsh's persistent shell tools resolve by
 * default (`backendType` defaults to `'shell'`) — so a composition whose
 * persistent shell group sits OUTSIDE an `isolate: terminals` realm resolves
 * this backend, and the bridge's claim hook then owns its spawns as the
 * agent's watched terminal. Stock presets isolate the realm (their backend is
 * their own, deliberately invisible to the host), which is respected here
 * rather than worked around.
 */
export class DshellPtyBackend implements TerminalBackend {
  readonly type = 'shell'

  private readonly sessions = new Map<TerminalSessionId, LocalRawSession>()
  private disposed = false

  constructor(
    private readonly cols: number,
    private readonly rows: number,
    /** Optional redirect: a session whose cwd is a device mount gets that device's shell. */
    private readonly planFor: PtySpawnPlanResolver | undefined = undefined,
    /**
     * Optional claim hook for spawns dshell did not issue itself. Bridge
     * spawns always carry a name (`main` / `agent`); an unnamed spawn through
     * this backend — dsh's persistent-bash pointed here via `backendType`, or
     * a `terminal_open` — is another party creating the agent's shell inside
     * dshell's world, and the bridge is told so it can attach the agent
     * stream (status card, watch panel) to it instead of leaving it invisible.
     */
    private readonly onForeign: ((owner: unknown, sessionId: TerminalSessionId) => void) | undefined = undefined,
  ) {}

  /** The rich handle for a session this backend spawned (bridge wiring). */
  session(id: TerminalSessionId): DshellPtySession | undefined {
    return this.sessions.get(id)
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    if (this.disposed) throw new TerminalError('dshell PTY backend is disposing', 'NO_SESSION')
    spec.signal?.throwIfAborted()
    // Awaited: a device session's assignment can still be in flight while the
    // terminal attaches, and the resolver is allowed to wait for it.
    const plan = await this.planFor?.({
      sessionId: spec.owner?.id === undefined ? undefined : String(spec.owner.id),
      cwd: spec.cwd,
    })
    const session = new LocalRawSession(
      spec.sessionId as TerminalSessionId,
      spec.cwd,
      this.cols,
      this.rows,
      plan ?? LOCAL_SHELL,
    )
    this.sessions.set(spec.sessionId as TerminalSessionId, session)
    // Unnamed spawns are other plugins creating shells in dshell's world; the
    // bridge may want to claim them as the agent's shell. Fired after the
    // session is registered so the claimant can look it up immediately.
    if (spec.name === undefined) {
      this.onForeign?.(spec.owner, session.id as TerminalSessionId)
    }
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

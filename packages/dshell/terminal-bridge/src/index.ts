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
import { DshellPtyBackend, diagnosticTail, exitLabel, type DshellPtySession } from './pty.js'
import {
  createSplitter, sanitizeTerminalText, sliceWindow, splitOutput, stripAnsi, trackInput,
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

/** How long a PTY bind waits for its session's Agent before reporting failure. */
const AGENT_WAIT_MS = 4000
/** Poll interval while waiting for that Agent. */
const AGENT_WAIT_POLL_MS = 50

/** What every bridge-owned shell needs for the shared init handshake. */
interface ShellRecord {
  agent: Agent
  /** dsh session id this shell belongs to. */
  dshSessionId: string
  /** PTY id inside ctx.terminals (per boot). */
  ptyId: TerminalSessionId
  /** The backend's rich handle: raw output push, exit push, resize. */
  session: DshellPtySession
  buffer: PtyBuffer
  activeSend: TerminalSendOperation | undefined
  /** Init echo is scrubbed and output suppressed until the first settle. */
  initializing: boolean
  /**
   * Whether this shell ever reached a prompt.
   *
   * The init send settles only once the shell answers, so a record whose init
   * settled with the process still alive was a working terminal. It is what
   * tells "the connection dropped" apart from "it never came up": the client
   * shows the first as a marker at the end of the output and the second as a
   * full connecting/failure panel, and only the host can make that call.
   */
  ready: boolean
}

interface MainRecord extends ShellRecord {
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
  inputQueue: string[]
  /** Push-subscription disposers, released in dropMain. */
  stopOutput: () => void
  stopExit: () => void
  /**
   * Set when the PTY exited or the dsh session was disposed. The record
   * stays in `mains` briefly so a reconnecting client can receive the
   * close frame in its bindClient sequence; `disposeRecord` removes it
   * after the grace. The diagnostic and readiness travel with it so a client
   * that binds after the death still gets the whole story.
   */
  dead?: { reason: string; detail?: string | undefined; ready: boolean; time: number }
  /** Pending dispose handle, kept so a rapid respawn can cancel it. */
  disposeTimer?: NodeJS.Timeout
}

/**
 * The agent's own shell.
 *
 * The user's main shell and the agent's shell are two PTYs owned by the same
 * session Agent, so a command the agent runs and a command the user types no
 * longer take turns in one foreground: each has its own line discipline, its
 * own settle and its own Ctrl+C. That is what makes the two sides genuinely
 * parallel instead of mutually blocking, and it is the only arrangement in
 * which "the terminal stays usable while the agent works" can hold — one PTY
 * has exactly one foreground job.
 *
 * It is spawned lazily, on the agent's first need for a terminal, so a session
 * that never runs a shell pays for nothing (a device session would otherwise
 * open a second ssh connection for nobody).
 */
interface AgentRecord extends ShellRecord {
  /** Shell identity; a replaced shell takes a fresh value. */
  generation: number
  /** Push-subscription disposers, released on death. */
  stopOutput: () => void
  stopExit: () => void
  /**
   * Settles when the init handshake finished.
   *
   * The id handed to the agent is only safe to send into once init has settled:
   * the backend rejects a second concurrent send with `SEND_ACTIVE`, and an
   * agent that got the id and immediately ran a command would race its own
   * shell's startup and lose.
   */
  readonly initSettled: Promise<void>
  dead?: { reason: string; detail?: string | undefined; ready: boolean; time: number }
  /** Pending dispose handle, kept so a rapid respawn can cancel it. */
  disposeTimer?: NodeJS.Timeout
}

export class DshellTerminalBridge extends Service {
  static inject = ['terminals', 'agents'] as const

  private readonly mains = new Map<Agent, MainRecord>()
  private readonly pendingMain = new Map<Agent, Promise<MainRecord>>()
  /**
   * The grid each session's view last asked for, kept per dsh session id.
   *
   * A resize can arrive before the session's main shell exists (the view
   * measures on mount, the bind is still spawning) and before the client is
   * registered as bound, so it is remembered here and applied at spawn; a
   * request that is only applied when a shell happens to exist is a request
   * the session never sees, and the PTY then keeps the backend's default
   * columns forever — the shell wraps and pads its output to that width while
   * the view renders at its own.
   */
  private readonly pendingSizes = new Map<string, { cols: number; rows: number }>()
  private readonly clients = new Map<string, Set<WebSocket>>()
  private readonly boundSession = new Map<WebSocket, string>()
  /** The agent-owned shells, keyed by the same Agent as their main shell. */
  private readonly agents = new Map<Agent, AgentRecord>()
  private readonly pendingAgents = new Map<Agent, Promise<AgentRecord>>()
  /**
   * Watchers of one session's agent shell — the task card's terminal panel.
   *
   * A separate subscriber set from `clients` on purpose: this stream is
   * read-only, has no input or signal frames, and a view that never opens the
   * panel costs the host nothing.
   */
  private readonly agentClients = new Map<string, Set<WebSocket>>()
  /** Sessions the sockets on {@link agentClients} are bound to. */
  private readonly agentBound = new Map<WebSocket, string>()
  /**
   * Columns the panel last asked for, applied when the agent shell spawns.
   *
   * Only the width: the agent's shell is spawned at the backend's row count and
   * keeps it, because rows decide how much a full-screen program can draw while
   * the panel is a short window that scrolls.
   */
  private readonly agentCols = new Map<string, number>()
  /** OS identity for the bash prompt; safe for embedding inside PS1 quotes. */
  readonly promptUser = safeShellWord(userInfo().username)
  readonly promptHost = safeShellWord(hostname())

  /** The backend's rich handle (raw push, exit push, resize) for its sessions. */
  private readonly backend = new DshellPtyBackend(DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, ({ sessionId, cwd }) => {
    // A session bound to a device runs that device's shell, so the user's own
    // terminal is not a local shell stranded in an empty mount directory. The
    // router is reached through the service the SSH plugin publishes, asked
    // lazily because that plugin may load after this one; a composition
    // without it returns undefined and the local shell is used as before.
    // Answered by session identity: the mount directory is shared by every
    // session bound to that device tree, so directory alone cannot tell a
    // bound session from an unbound one that inherited the path.
    if (sessionId === undefined) return undefined
    const routing = this.ctx.get('dshellSshRouting') as
      | {
        interactiveShellPlan(
          sessionId: string,
          sessionCwd: string | undefined,
        ): Promise<{ argv: readonly string[]; env: Record<string, string> } | undefined>
      }
      | undefined
    return routing?.interactiveShellPlan(sessionId, cwd)
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
      // The agent's shell goes with the session for the same reason, and its
      // panel sockets are closed the same way: nothing can watch a session
      // that no longer exists.
      const agentRecord = this.agentRecordFor(sessionId)
      if (agentRecord !== undefined) this.markAgentDead(agentRecord, 'session closed')
      const watching = this.agentClients.get(sessionId)
      if (watching !== undefined) {
        for (const client of watching) {
          this.agentBound.delete(client)
          if (client.readyState === WebSocket.OPEN) client.close(1000, 'session closed')
        }
        this.agentClients.delete(sessionId)
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
   * The session's live Agent, waiting briefly for it to materialize.
   *
   * A PTY bind can legitimately arrive before the session has an agent: the
   * browser opens a session and binds its shell in the same tick, while the
   * host is still composing the agent, and a session SWITCH publishes the new
   * current session one tick before anything is built for it. Throwing on
   * `undefined` turned that ordinary race into a connection error: the client
   * drew a "reconnecting (1/3)" line, spent a retry attempt, and waited out a
   * backoff before opening the shell it was always going to get. Waiting for
   * the agent here is both quieter and faster than letting the client retry.
   * @param dshSessionId - the session whose agent to resolve.
   * @returns the live agent.
   * @throws when none appears within {@link AGENT_WAIT_MS}.
   */
  private async awaitAgent(dshSessionId: string): Promise<Agent> {
    const deadline = Date.now() + AGENT_WAIT_MS
    for (;;) {
      const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
      if (agent !== undefined) return agent
      if (Date.now() >= deadline) {
        throw new Error(`dshell-bridge: no live agent for session "${dshSessionId}"`)
      }
      await new Promise(resolve => { setTimeout(resolve, AGENT_WAIT_POLL_MS) })
    }
  }

  /**
   * The bridge-owned `main` PTY for one dsh session, spawning it lazily.
   * The PtyBuffer seeds from the persisted log tail (4.9) and the tail
   * loop starts streaming backend scrollback into buffer and clients.
   */
  async ensureMainShell(dshSessionId: string): Promise<MainRecord> {
    const agent = await this.awaitAgent(dshSessionId)
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
      ready: false,
      stopOutput: () => {},
      stopExit: () => {},
    }
    // Start at the grid the view asked for, not the backend's default: the
    // shell's first prompt decides where every later line wraps, and the view
    // is already sized when a session is opened or restored.
    const requested = this.pendingSizes.get(dshSessionId)
    if (requested !== undefined) session.resize(requested.cols, requested.rows)
    this.mains.set(agent, record)
    // Raw ANSI push: every output byte lands in the persisted buffer and on
    // the wire untouched — the canvas renders it natively. Suppressed while
    // the init echo is pending so a fresh session opens on a clean slate.
    // The same bytes feed the command splitter (OSC 133;D closes a record).
    record.stopOutput = session.onOutput((chunk) => {
      if (record.initializing) return
      record.buffer.append(chunk)
      const opened = record.blocks.tailSeq
      const block = record.blocks.append(chunk)
      if (block.seq === opened) {
        this.broadcast(record.dshSessionId, { kind: 'block-text', seq: block.seq, text: chunk })
      } else {
        // This chunk started a block. The client merges `block-text` into a
        // block it already has, so a new one must be announced with a full
        // snapshot — otherwise output that arrives before the session's first
        // turn is dropped from the timeline and the view stays empty.
        this.broadcast(record.dshSessionId, { kind: 'blocks', blocks: record.blocks.snapshot() })
      }
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
      this.markDead(record, status.kind === 'exited' ? exitLabel(status) : status.kind)
    })
    // Replace the stock `dsh> ` prompt with a bash-style `user@host:path$`
    // cue once the shell is ready; PS1 and PROMPT_COMMAND are rewritten in
    // one line so no render window can clobber it, and the backend's fast
    // settle keys off the marker this PROMPT_COMMAND prints.
    this.runInit(record, frame => { this.broadcast(record.dshSessionId, frame) }, {
      afterRestore: () => {
        record.absOffset = Buffer.byteLength(record.buffer.text(), 'utf8')
        this.pump(record)
      },
    })
    return record
  }

  /**
   * Queue the prompt-rewrite init and wipe its setup echo from the scrollback.
   *
   * Shared by both shells: the user's and the agent's get the same prompt and
   * the same settle marker, so one settle implementation and one backend
   * contract cover them. What differs is only who hears about it (`deliver`)
   * and what the owner must fix up once the seeded scrollback is restored.
   * @param record - the shell being initialized.
   * @param deliver - publishes one frame to that shell's watchers.
   * @param options - `cdTo` is an already-quoted directory for the new shell to
   *   start in (the agent's fork), `afterRestore` runs once the seeded history
   *   is back in the buffer.
   */
  private runInit(
    record: ShellRecord,
    deliver: (frame: Record<string, unknown>) => void,
    options: {
      cdTo?: string | undefined
      afterRestore?: (() => void) | undefined
    } = {},
  ): void {
    // The scrollback a respawn owes the client: the window already holds the
    // seeded log tail, so snapshot it before the init echo lands. Restoring
    // the snapshot (below) is the whole point of the persisted log — seeding
    // it and then truncating would erase the previous shell's output for good.
    const seeded = record.buffer.text()
    // ONE line: the PROMPT_COMMAND re-asserts PS1 from a dedicated variable
    // on every prompt render, so the prompt survives any clobber and the
    // settle marker stays live. Real ESC bytes are safe on this backend.
    const cd = options.cdTo === undefined ? '' : `cd ${options.cdTo} 2>/dev/null; `
    const init = [
      `${cd}export DSHELL_PS1='\\u@\\h:\\w\\$ '; export PS1="$DSHELL_PS1"; export PROMPT_COMMAND='printf "\\033]133;D;%s\\007" "$?"; PS1="$DSHELL_PS1"'`,
      'clear',
      '',
    ].join('\n')
    const operation = this.ctx.terminals.startSend(record.agent, record.ptyId, { text: init, submit: false })
    record.activeSend = operation
    void operation.done.then((result) => {
      // The init send settles only once the shell answers (marker seen and
      // quiet), so a settle with the process still alive means this shell is a
      // working terminal — the fact the client needs to tell "connection
      // dropped" apart from "never connected".
      record.ready = result.sessionStatus.kind !== 'exited'
      record.activeSend = undefined
      record.initializing = false
      // Clients already bound need this the moment it happens: until the
      // shell has answered, they show a connecting state rather than an empty
      // terminal, and only this frame ends it.
      deliver({ kind: 'ready', ready: record.ready })
      // The init echo (export line + clear) never deserves screen space, but
      // the seeded scrollback does: reset the log to the snapshot instead of
      // to nothing, and hand that same text back to every client, which
      // replaces its own history from a replay chunk.
      void record.buffer.truncate().then(() => {
        record.buffer.append(seeded)
        deliver({
          kind: 'output',
          chunk: seeded,
          time: Date.now(),
          replay: true,
          timeline: record.buffer.timelineEntries().map(entry => [entry.t, entry.n]),
        })
        // The init script already ended with an empty line, which readline
        // echoed and ran the new PROMPT_COMMAND through — the shell is at a
        // fresh prompt with no need for another Enter press. Pushing another
        // `\n` would add another empty echo row, and over many respawns that
        // is exactly the blank block the user sees growing on every reconnect.
        options.afterRestore?.()
      })
    }, () => {
      record.activeSend = undefined
      record.initializing = false
      options.afterRestore?.()
    })
  }

  /**
   * The agent's own shell for one session, spawning it lazily.
   *
   * Lazy on purpose: a session that never asks for a terminal pays nothing, and
   * a device session does not open a second ssh connection for a panel nobody
   * opened. The record is keyed by the same Agent as the main shell — the two
   * are two named PTYs under one owner, addressable separately.
   */
  async ensureAgentShell(dshSessionId: string): Promise<AgentRecord> {
    const agent = await this.awaitAgent(dshSessionId)
    const existing = this.agents.get(agent)
    if (existing !== undefined && existing.dead === undefined) return existing
    if (existing !== undefined) {
      // A dead record still holds the owner's "agent" name reservation, so the
      // respawn below would collide; release it inline first.
      if (existing.disposeTimer !== undefined) clearTimeout(existing.disposeTimer)
      await this.disposeAgentRecord(existing)
      void this.ctx.terminals.kill(agent, existing.ptyId, 'dshell: replace dead agent shell').catch(() => {})
    }
    const pending = this.pendingAgents.get(agent)
    if (pending !== undefined) return await pending
    const promise = this.spawnAgent(agent, dshSessionId)
    this.pendingAgents.set(agent, promise)
    try {
      return await promise
    } finally {
      this.pendingAgents.delete(agent)
    }
  }

  /**
   * The addressable id of the agent's own shell.
   *
   * What the model-facing tool hands the agent, so `terminal_send` lands in a
   * shell the agent owns rather than in the one the user is typing into. The
   * id is only returned once init has settled: the backend rejects a send that
   * overlaps another (`SEND_ACTIVE`), and the agent's next act is a send.
   * @param dshSessionId - the session whose agent shell to spawn (lazily).
   * @returns the PTY id inside `ctx.terminals`.
   */
  async agentTerminalId(dshSessionId: string): Promise<TerminalSessionId> {
    const record = await this.ensureAgentShell(dshSessionId)
    await record.initSettled
    return record.ptyId
  }

  private async spawnAgent(agent: Agent, dshSessionId: string): Promise<AgentRecord> {
    const cwd = agent.session?.header?.cwd
    const spawned = await this.ctx.terminals.spawn(agent, {
      type: 'dshell-pty',
      name: 'agent',
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
    })
    const session = this.backend.session(spawned.sessionId)
    if (session === undefined) {
      throw new Error(`dshell-bridge: backend session missing after agent spawn (${String(spawned.sessionId)})`)
    }
    // The width the panel already asked for, if any: a shell spawned wider than
    // the panel wraps its output where the panel does not, and nothing would
    // re-wrap it afterwards.
    const cols = this.agentCols.get(dshSessionId)
    if (cols !== undefined) session.resize(cols, DEFAULT_PTY_ROWS)
    const logPath = join(ptyLogDir(), `${dshSessionId}.agent.log`)
    const buffer = await PtyBuffer.open(logPath)
    const settled = Promise.withResolvers<void>()
    const record: AgentRecord = {
      agent,
      dshSessionId,
      ptyId: spawned.sessionId,
      session,
      buffer,
      generation: nextShellGeneration++,
      activeSend: undefined,
      initializing: true,
      ready: false,
      stopOutput: () => {},
      stopExit: () => {},
      initSettled: settled.promise,
    }
    this.agents.set(agent, record)
    record.stopOutput = session.onOutput((chunk) => {
      // The init echo is the bridge's own setup, not the agent's work: the
      // panel opens on the fork's prompt, not on an export line.
      if (record.initializing) return
      record.buffer.append(chunk)
      this.broadcastAgent(record.dshSessionId, { kind: 'output', chunk, time: Date.now() })
    })
    record.stopExit = session.onExit((status) => {
      this.markAgentDead(record, status.kind === 'exited' ? exitLabel(status) : status.kind)
    })
    // The agent's shell forks the user's: it opens in the directory the user's
    // own shell is sitting in, so "look at what I am looking at" needs no path
    // in a prompt. Best effort — a shell in the middle of a command reports no
    // directory, and the fork simply stays in the session's own.
    const fork = forkDirWord(this.mains.get(agent))
    this.runInit(record, frame => { this.broadcastAgent(record.dshSessionId, frame) }, {
      cdTo: fork,
      afterRestore: () => { settled.resolve() },
    })
    return record
  }

  /** The agent shell record for one session — live, dead, or not spawned. */
  private agentRecordFor(dshSessionId: string): AgentRecord | undefined {
    for (const record of this.agents.values()) if (record.dshSessionId === dshSessionId) return record
    return undefined
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
    if (record !== undefined) this.markDead(record, 'session deleted')
    const agentRecord = this.agentRecordFor(dshSessionId)
    if (agentRecord !== undefined) this.markAgentDead(agentRecord, 'session deleted')
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
    // A dead PTY can never settle a send, and `startSend` on it throws — which
    // the catch below would turn into an unbreakable 100ms retry loop.
    if (record.dead !== undefined) return
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
   *
   * The frame carries everything the client needs to explain the death: the
   * cause, the last connection diagnostic the output holds (a device session's
   * ssh stderr is the only place "Connection refused" exists), and whether the
   * shell had ever reached a prompt.
   */
  private markDead(record: MainRecord, reason: string): void {
    if (record.dead !== undefined) return
    const detail = diagnosticTail(record.buffer.text())
    record.dead = { reason, detail, ready: record.ready, time: Date.now() }
    record.stopOutput()
    record.stopExit()
    record.stopOutput = () => {}
    record.stopExit = () => {}
    // Queued keystrokes have nowhere to go, and a pump that keeps retrying a
    // dead PTY is an endless 100ms loop. Dropping them is what the shell's
    // death means anyway.
    record.inputQueue.length = 0
    this.broadcast(record.dshSessionId, { kind: 'closed', reason, detail, ready: record.ready })
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

  /**
   * Mark the agent's shell dead: stop listening and tell its panel.
   *
   * Unlike the main shell there is no dispose timer. A dead main shell has to
   * leave quickly — its name holds the next respawn back — while a dead agent
   * shell is worth keeping: it is the record of what the agent did, and the
   * panel that opens hours later must be able to say the shell ended and why,
   * not pretend none ever existed. The next `ensureAgentShell` replaces it.
   */
  private markAgentDead(record: AgentRecord, reason: string): void {
    if (record.dead !== undefined) return
    record.dead = {
      reason,
      detail: diagnosticTail(record.buffer.text()),
      ready: record.ready,
      time: Date.now(),
    }
    record.stopOutput()
    record.stopExit()
    record.stopOutput = () => {}
    record.stopExit = () => {}
    this.broadcastAgent(record.dshSessionId, { kind: 'closed', reason, detail: record.dead.detail, ready: record.ready })
    void this.ctx.terminals.kill(record.agent, record.ptyId, 'dshell: agent shell dead').catch(() => {})
  }

  /** Drop the agent record, releasing its buffer's file handle. */
  private async disposeAgentRecord(record: AgentRecord): Promise<void> {
    delete record.disposeTimer
    this.agents.delete(record.agent)
    await record.buffer.close().catch(() => {})
  }

  private async disposeAll(): Promise<void> {
    for (const record of [...this.mains.values()]) {
      if (record.disposeTimer !== undefined) clearTimeout(record.disposeTimer)
      record.stopOutput()
      record.stopExit()
      await record.buffer.close().catch(() => {})
    }
    for (const record of [...this.agents.values()]) {
      if (record.disposeTimer !== undefined) clearTimeout(record.disposeTimer)
      record.stopOutput()
      record.stopExit()
      await record.buffer.close().catch(() => {})
    }
    this.mains.clear()
    this.agents.clear()
    this.clients.clear()
    this.boundSession.clear()
    this.agentClients.clear()
    this.agentBound.clear()
  }

  private attachClient(client: WebSocket): void {
    client.on('message', (data: unknown) => {
      let frame: {
        kind?: string
        stream?: string
        sessionId?: string
        text?: string
        signal?: string
        cols?: number
        rows?: number
      }
      try {
        frame = JSON.parse(String(data)) as typeof frame
      } catch {
        return
      }
      if (frame.kind === 'bind' && typeof frame.sessionId === 'string') {
        // The task card's panel opens a socket of its own for the agent's
        // shell; the main stream and the agent stream never share one.
        if (frame.stream === 'agent') this.bindAgent(client, frame.sessionId)
        else this.bindClient(client, frame.sessionId)
        return
      }
      const agentSession = this.agentBound.get(client)
      if (agentSession !== undefined) {
        if (frame.kind === 'agent-open') this.openAgentFor(client, agentSession)
        else if (frame.kind === 'resize' && typeof frame.cols === 'number') this.resizeAgent(agentSession, frame.cols)
        return
      }
      const bound = this.boundSession.get(client)
      // Handled before the bound check on purpose: the view sends its grid the
      // moment its seat is laid out, which can be before this client finished
      // binding (and before the shell it names was spawned).
      if (frame.kind === 'resize' && typeof frame.cols === 'number' && typeof frame.rows === 'number') {
        const session = bound ?? frame.sessionId
        if (session === undefined) return
        if (bound !== undefined && frame.sessionId !== undefined && frame.sessionId !== bound) return
        const cols = Math.max(1, Math.floor(frame.cols))
        const rows = Math.max(1, Math.floor(frame.rows))
        this.pendingSizes.set(session, { cols, rows })
        const resizeAgent = this.ctx.get('agents')?.get(session as SessionId)
        const resizeRecord = resizeAgent === undefined ? undefined : this.mains.get(resizeAgent)
        resizeRecord?.session.resize(cols, rows)
        return
      }
      // A retry, from the client's automatic loop or its button. Handled
      // before the bound check because the client may be the one that knows
      // the shell is gone (its own socket survived the PTY's death).
      if (frame.kind === 'reconnect') {
        const session = bound ?? frame.sessionId
        if (session === undefined) return
        if (bound !== undefined && frame.sessionId !== undefined && frame.sessionId !== bound) return
        this.reconnectClient(client, session)
        return
      }
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
    })
    client.on('close', () => {
      const agentSession = this.agentBound.get(client)
      if (agentSession !== undefined) {
        this.agentBound.delete(client)
        const watching = this.agentClients.get(agentSession)
        watching?.delete(client)
        if (watching !== undefined && watching.size === 0) this.agentClients.delete(agentSession)
      }
      const bound = this.boundSession.get(client)
      this.boundSession.delete(client)
      if (bound === undefined) return
      const set = this.clients.get(bound)
      set?.delete(client)
      if (set !== undefined && set.size === 0) this.clients.delete(bound)
    })
  }

  /**
   * Subscribe one socket to a session's agent shell and tell it the state.
   *
   * Subscribing is not spawning: the panel may open against a session whose
   * agent has never touched a terminal, and that is a state to report, not a
   * reason to start a second shell. `agent-open` is the frame that asks for
   * one.
   */
  private bindAgent(client: WebSocket, dshSessionId: string): void {
    let set = this.agentClients.get(dshSessionId)
    if (set === undefined) {
      set = new Set()
      this.agentClients.set(dshSessionId, set)
    }
    set.add(client)
    this.agentBound.set(client, dshSessionId)
    this.pushAgentSnapshot(client, dshSessionId)
  }

  /** Spawn the agent's shell on the panel's request, then report it. */
  private openAgentFor(client: WebSocket, dshSessionId: string): void {
    void this.ensureAgentShell(dshSessionId).then(() => {
      this.pushAgentSnapshot(client, dshSessionId)
    }, (error: unknown) => {
      this.sendFrame(client, {
        kind: 'error',
        stream: 'agent',
        message: describeSpawnError(error),
        sessionId: dshSessionId,
      })
    })
  }

  /**
   * Apply the panel's width to the agent's shell.
   *
   * Only the columns: the panel is a short window onto a full-height terminal,
   * so it scrolls rather than shrinking the rows a full-screen program may
   * draw. A request that arrives before the shell exists is remembered and
   * applied at spawn.
   */
  private resizeAgent(dshSessionId: string, cols: number): void {
    const width = Math.max(20, Math.min(500, Math.floor(cols)))
    this.agentCols.set(dshSessionId, width)
    const record = this.agentRecordFor(dshSessionId)
    if (record === undefined || record.dead !== undefined) return
    record.session.resize(width, DEFAULT_PTY_ROWS)
  }

  /** Hand one panel client the agent shell's existence, state and scrollback. */
  private pushAgentSnapshot(client: WebSocket, dshSessionId: string): void {
    const record = this.agentRecordFor(dshSessionId)
    this.sendFrame(client, {
      kind: 'agent-info',
      stream: 'agent',
      live: record !== undefined && record.dead === undefined,
      ready: record?.ready ?? false,
      ...record?.dead === undefined ? {} : { reason: record.dead.reason, detail: record.dead.detail },
    })
    if (record !== undefined) {
      this.sendFrame(client, {
        kind: 'output',
        stream: 'agent',
        chunk: record.initializing ? '' : record.buffer.text(),
        time: Date.now(),
        replay: true,
      })
    }
  }

  private bindClient(client: WebSocket, dshSessionId: string): void {
    // Stash the dead reason BEFORE ensureMainShell swaps in a replacement,
    // so the close frame can be forwarded to a freshly reconnected client.
    const agent = this.ctx.get('agents')?.get(dshSessionId as SessionId)
    const priorDead = agent === undefined ? undefined : this.mains.get(agent)?.dead
    this.attachToSession(client, dshSessionId, priorDead)
  }

  /**
   * Bind one client to a session and hand it that session's current state.
   *
   * A failure to start the shell does NOT close the socket any more. The
   * failure is almost always the device (unreachable host, refused key) or a
   * session whose agent has not materialized, and those are exactly what a
   * retry is for; closing would discard the connection the retry needs and
   * leave the client reconnecting into the same wall. The error frame says
   * what happened and the client decides whether to try again.
   */
  private attachToSession(
    client: WebSocket,
    dshSessionId: string,
    priorDead?: { reason: string; detail?: string | undefined; ready: boolean },
  ): void {
    void this.ensureMainShell(dshSessionId).then((record) => {
      this.adopt(client, dshSessionId)
      if (priorDead !== undefined) {
        this.sendFrame(client, {
          kind: 'closed',
          reason: priorDead.reason,
          detail: priorDead.detail,
          ready: priorDead.ready,
        })
      }
      this.pushSnapshot(client, record)
    }, (error: unknown) => {
      // Stay bound: the client's retry is a frame on this very socket.
      this.adopt(client, dshSessionId)
      this.sendFrame(client, { kind: 'error', message: describeSpawnError(error), sessionId: dshSessionId })
    })
  }

  /**
   * Replace one session's dead shell on behalf of one client — its retry
   * button or its automatic retry loop — then hand that client the new state.
   *
   * The old scrollback is not lost: a respawn seeds its buffer from the
   * persisted log, so the replay carries the history the client already had,
   * with the new shell's prompt appended after it.
   */
  private reconnectClient(client: WebSocket, dshSessionId: string): void {
    void this.ensureMainShell(dshSessionId).then((record) => {
      this.adopt(client, dshSessionId)
      this.pushSnapshot(client, record)
    }, (error: unknown) => {
      this.sendFrame(client, { kind: 'error', message: describeSpawnError(error), sessionId: dshSessionId })
    })
  }

  /** Register one client as a subscriber of one session. */
  private adopt(client: WebSocket, dshSessionId: string): void {
    let set = this.clients.get(dshSessionId)
    if (set === undefined) {
      set = new Set()
      this.clients.set(dshSessionId, set)
    }
    set.add(client)
    this.boundSession.set(client, dshSessionId)
  }

  /** Hand one client the session's identity, scrollback and block order. */
  private pushSnapshot(client: WebSocket, record: MainRecord): void {
    // `ready` rides the info frame so a client that binds (or re-binds) after
    // the fact still knows whether this shell ever reached a prompt.
    this.sendFrame(client, {
      kind: 'info',
      user: this.promptUser,
      host: this.promptHost,
      home: homedir(),
      ready: record.ready,
    })
    this.sendFrame(client, {
      kind: 'output',
      chunk: record.initializing ? '' : record.buffer.text(),
      time: Date.now(),
      replay: true,
      timeline: record.buffer.timelineEntries().map(entry => [entry.t, entry.n]),
    })
    // The host owns block order; the client renders this list as given.
    this.sendFrame(client, { kind: 'blocks', blocks: record.blocks.snapshot() })
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

  /** Fan one frame out to the panels watching a session's agent shell. */
  private broadcastAgent(dshSessionId: string, frame: Record<string, unknown>): void {
    const set = this.agentClients.get(dshSessionId)
    if (set === undefined) return
    const data = JSON.stringify({ stream: 'agent', ...frame })
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    }
  }
}

/**
 * The honest text of a failed spawn for the wire.
 *
 * `String(error)` would prefix "Error: ", and an Error with no message would
 * ship an empty line; the client shows this verbatim in its connection panel,
 * so it has to be a sentence either way.
 */
function describeSpawnError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim()
  return text === '' ? '终端启动失败' : text
}

/** Defensive escape: drop chars that would let a quoted $PS1 leak out. */
function safeShellWord(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** One POSIX shell word, quoted so any character inside stays literal. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

/**
 * The directory the *user's* shell is sitting in, as a shell word.
 *
 * The prompt dshell installs is `user@host:dir$`, printed by the shell itself
 * on every prompt render, so when the user's shell is idle its scrollback ends
 * in that directory. Nothing else reports a terminal's working directory —
 * there is no cwd channel on this wire — and this is what lets the agent's
 * shell open where the user is looking instead of in the session's original
 * directory, which is the closest thing to a fork of their shell that the
 * model of a PTY allows.
 *
 * `~` is rebuilt as `"$HOME"` because a tilde inside quotes would not expand;
 * the rest of the path is single-quoted verbatim. Best effort by design: a
 * shell in the middle of a command ends in output, not in a prompt, and then
 * this returns nothing and the caller leaves the new shell where it spawned.
 * @param record - the user's main record, when one exists.
 * @returns the quoted directory, or undefined when the tail is not a prompt.
 */
function forkDirWord(record: MainRecord | undefined): string | undefined {
  if (record === undefined) return undefined
  const stripped = stripAnsi(record.buffer.text())
  const lines = stripped.split('\n')
  let tail = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.length > 0) { tail = line; break }
  }
  // `user@host:dir$` (or `#` for a root shell) — the prompt this bridge
  // installs, matched at the very end of the line.
  const match = /@[^:@\s]*:([^$#\n]*)[$#]\s*$/.exec(tail)
  const dir = match?.[1]?.trim()
  if (dir === undefined || dir.length === 0) return undefined
  if (dir === '~') return '"$HOME"'
  if (dir.startsWith('~/')) return `"$HOME"/${shellQuote(dir.slice(2))}`
  if (!dir.startsWith('/')) return undefined
  return shellQuote(dir)
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

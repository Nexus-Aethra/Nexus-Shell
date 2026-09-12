/**
 * The buffer service: links, deferred requests, scoped grants, and the
 * watchdog that guarantees a requester is always woken.
 *
 * The shape of this feature is dictated by one dsh constraint: **a turn cannot
 * be suspended and resumed.** So "wait for the other agent" cannot be a blocked
 * tool call. Instead a delegation is a durable ticket plus a message; the
 * requester's turn ends naturally, and when the ticket settles the buffer
 * delivers a new message that reopens the requester's turn — the same
 * completion-delivery policy dsh's own job registry uses.
 *
 * Everything that can leave a requester stranded is closed here:
 *  - an unsettled ticket past its deadline is settled as `timeout` by the
 *    watchdog, and the requester is still woken;
 *  - a worker session that is disposed settles its running tickets as `failed`;
 *  - a cancelled ticket wakes the requester immediately;
 *  - every settlement path releases the ticket's grants, so a grant cannot
 *    outlive the work it was issued for.
 *
 * Grants are enforced by the tool that fronts this service, not by a seam:
 * the tool is the only door, so one check covers every access.
 */

import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the session-controller service merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the shell service merge (`ctx.shell`), the byte-transport
// seam a cross-world transfer writes through.
import type {} from '@deepseek-ai/dsh-shell'
// Type-only: pulls the sandbox-policy service merge, so a granted write can be
// authorized against the GRANTER's own mode instead of the fail-safe default.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { Feasibility, type DeviceRoutingSeat } from './feasibility.js'
import {
  sessionLabel, renderRequestNotice, renderSettlementNotice, requestSummary, settlementSummary,
} from './notice.js'
import { isUnder } from './paths.js'
import {
  BUFFER_PLUGIN,
  SETTLED_STATES,
  type BufferArea,
  type BufferGrant,
  type BufferLink,
  type BufferRight,
  type BufferState,
  type BufferTicket,
  type BufferTicketState,
  type BufferTransfer,
} from './protocol.js'
import { readDocument, writeDocument } from './store.js'

/** How long a ticket may stay unsettled before the watchdog settles it. */
export const DEFAULT_DEADLINE_MS = 10 * 60_000
/** Shortest deadline a caller may ask for; below this the watchdog races the worker. */
export const MIN_DEADLINE_MS = 30_000
/** Longest deadline a caller may ask for. */
export const MAX_DEADLINE_MS = 2 * 60 * 60_000
/** How often the watchdog looks for expired tickets. */
const WATCHDOG_INTERVAL_MS = 15_000
/** Bytes one transfer moves when the caller names no ceiling. */
export const DEFAULT_TRANSFER_BYTES = 8 * 1024 * 1024
/** Hard ceiling on one INLINE transfer: the payload rides stdin as base64. */
export const MAX_TRANSFER_BYTES = 32 * 1024 * 1024
/** Files above this size take the chunked path instead of one inline move. */
export const CHUNK_THRESHOLD_BYTES = MAX_TRANSFER_BYTES
/** Byte size of one relayed chunk: a read plus one base64 stdin write. */
export const CHUNK_BYTES = 16 * 1024 * 1024
/** Default ceiling for a chunked transfer's WHOLE size. */
export const DEFAULT_BIG_BYTES = 1024 * 1024 * 1024
/** Hard ceiling on a chunked transfer's whole size. */
export const MAX_BIG_BYTES = 4 * 1024 * 1024 * 1024
/** How long a settled transfer stays in the snapshot for progress surfaces. */
const TRANSFER_TAIL_MS = 15_000

/** Which end of a transfer is the source. */
export type TransferSide = 'from' | 'to'

/** What one cross-world copy moved, and between which paths. */
export interface TransferOutcome {
  readonly bytes: number
  /** The source's path, as its own world spells it. */
  readonly source: string
  /** The destination's path, as its own world spells it. */
  readonly destination: string
  readonly side: TransferSide
  /** Chunked transfers only: how many relayed slices made the file. */
  readonly chunks?: number | undefined
}

/** One inline grant a delegation asks to create. */
export interface GrantRequest {
  readonly description: string
  readonly areas: readonly BufferArea[]
}

/** What a delegation carries. */
export interface DelegateInput {
  /** Target session; required unless `linkId` names the link. */
  readonly to?: string | undefined
  /** The link to send over; when omitted the service finds one between the pair. */
  readonly linkId?: string | undefined
  readonly subject: string
  readonly detail?: string | undefined
  /** Grants to create and hold for this ticket. */
  readonly grants?: readonly GrantRequest[] | undefined
  /** Existing grant ids to hold open and reference. */
  readonly grantIds?: readonly string[] | undefined
  readonly deadlineMs?: number | undefined
}

/** The outcome of an admitted delegation. */
export interface DelegateOutcome {
  readonly ticket: BufferTicket
  /** The target agent's status at admission — `running` means the request queued. */
  readonly targetStatus: AgentStatus
  readonly grants: readonly BufferGrant[]
}

/** A ticket plus the grant operations a holder may perform on it. */
export interface GrantsForResult {
  readonly grants: readonly BufferGrant[]
}

export class BufferService {
  private links: BufferLink[] = []
  private tickets: BufferTicket[] = []
  private grants: BufferGrant[] = []
  /** Chunked transfers in flight (and the freshly settled), for progress UI. */
  private readonly transfers = new Map<string, BufferTransfer>()
  private readonly feasibility: Feasibility
  /**
   * A context carrying `subprocess`, for the device probe only.
   *
   * The router the probe calls spawns `ssh` through that seam, and cordis
   * refuses a property the calling context did not inject — so the buffer
   * resolves a dedicated scope instead of making `subprocess` a hard
   * dependency of the whole plugin (a composition without dshell-ssh never
   * probes anything).
   */
  private probeCtx: Context | undefined
  /** Serializes persistence so two mutations cannot interleave a write. */
  private saveChain: Promise<void> = Promise.resolve()
  private watchdog: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(private readonly ctx: Context) {
    const document = readDocument()
    this.links = [...document.links]
    this.tickets = [...document.tickets]
    this.grants = [...document.grants]
    // Structural, optional: a composition without dshell-ssh has no device to
    // probe, and this package must not depend on that bundle.
    const routing = this.ctx.get('dshellSshRouting') as unknown as DeviceRoutingSeat | undefined
    this.feasibility = new Feasibility(this.ctx, routing)
    this.ctx.inject(['subprocess'], (probeCtx) => { this.probeCtx = probeCtx })
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start the watchdog and subscribe to worker disappearance. */
  start(): void {
    if (this.watchdog !== undefined) return
    this.watchdog = setInterval(() => { void this.sweep() }, WATCHDOG_INTERVAL_MS)
    this.watchdog.unref?.()
    this.ctx.on('agent/disposed', ({ agent }) => { void this.onAgentDisposed(String(agent.id)) })
  }

  /** Stop the watchdog. State stays on disk for the next start. */
  dispose(): void {
    this.disposed = true
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
  }

  // ------------------------------------------------------------------- reads

  /** The whole state, for the pipe UI and the tool's listings. */
  snapshot(): BufferState {
    return {
      links: [...this.links],
      tickets: [...this.tickets],
      grants: [...this.grants],
      transfers: [...this.transfers.values()],
    }
  }

  /** Links one session is an end of. */
  linksFor(sessionId: string): readonly BufferLink[] {
    return this.links.filter(link => link.a === sessionId || link.b === sessionId)
  }

  /** Tickets one session is an end of. */
  ticketsFor(sessionId: string, direction: 'in' | 'out' | 'both'): readonly BufferTicket[] {
    return this.tickets.filter(ticket =>
      direction === 'in' ? ticket.to === sessionId
        : direction === 'out' ? ticket.from === sessionId
          : ticket.from === sessionId || ticket.to === sessionId)
  }

  /** Grants addressed TO a session — the ones it may exercise. */
  grantsFor(sessionId: string): readonly BufferGrant[] {
    return this.grants.filter(grant => grant.to === sessionId && grant.revokedAt === undefined)
  }

  /** Grants a session ISSUED. */
  grantsIssuedBy(sessionId: string): readonly BufferGrant[] {
    return this.grants.filter(grant => grant.from === sessionId)
  }

  /** The other end of a link, from one side. */
  peerOf(link: BufferLink, sessionId: string): string {
    return link.a === sessionId ? link.b : link.a
  }

  /** A readable label for a session, for message text and tool output. */
  label(sessionId: string): string {
    return this.labelOf(sessionId)
  }

  // ------------------------------------------------------ user-facing changes

  /** Connect two sessions. Called by the pipe UI; no tool exposes this. */
  async createLink(a: string, b: string, label?: string): Promise<BufferLink> {
    if (a === b) throw new Error('不能把会话连接到它自己')
    const existing = this.links.find(link =>
      (link.a === a && link.b === b) || (link.a === b && link.b === a))
    if (existing !== undefined) throw new Error('这两个会话之间已经有管道了')
    const link: BufferLink = {
      id: newId('link'),
      a, b,
      ...label === undefined || label.trim().length === 0 ? {} : { label: label.trim() },
      createdAt: Date.now(),
    }
    this.links.push(link)
    await this.save()
    return link
  }

  /** Remove a link. Outstanding tickets keep running; no new delegation may use it. */
  async removeLink(linkId: string): Promise<void> {
    const at = this.links.findIndex(link => link.id === linkId)
    if (at < 0) throw new Error(`没有这个管道：${linkId}`)
    this.links.splice(at, 1)
    await this.save()
  }

  /**
   * Revoke a grant immediately, whoever issued it.
   *
   * This is the manual escape hatch next to the reference count: a grant the
   * user no longer wants can be dropped without waiting for its tickets, and
   * the tool's check reads `revokedAt`, so the door closes at once.
   */
  async revokeGrant(grantId: string): Promise<void> {
    const grant = this.requireGrant(grantId)
    if (grant.revokedAt !== undefined) return
    grant.revokedAt = Date.now()
    grant.count = 0
    await this.save()
  }

  // ------------------------------------------------------------------ detach

  /**
   * A session is gone: settle every unsettled ticket it participates in,
   * revoke every grant it holds or issued, and drop its pipes.
   *
   * Deleting a session in dshell does not dispose its agent — the delete
   * route only frees dshell's own memory and schedules the log purge — so
   * this must be called explicitly by the deletion path;
   * {@link onAgentDisposed} covers the narrower case of an agent actually
   * being disposed in this process.
   */
  async detachSession(sessionId: string): Promise<void> {
    if (this.disposed) return
    const live = this.tickets.filter(ticket =>
      (ticket.from === sessionId || ticket.to === sessionId)
      && !SETTLED_STATES.includes(ticket.state))
    for (const ticket of live) {
      await this.settle(
        ticket,
        ticket.from === sessionId ? 'cancelled' : 'failed',
        undefined,
        ticket.from === sessionId
          ? `发起会话 ${short(sessionId)} 已删除`
          : `承接会话 ${short(sessionId)} 已删除`,
      )
    }
    let changed = false
    for (const grant of this.grants) {
      if ((grant.from === sessionId || grant.to === sessionId) && grant.revokedAt === undefined) {
        grant.revokedAt = Date.now()
        grant.count = 0
        changed = true
      }
    }
    const linksBefore = this.links.length
    this.links = this.links.filter(link => link.a !== sessionId && link.b !== sessionId)
    if (changed || this.links.length !== linksBefore) await this.save()
  }

  // -------------------------------------------------------------- delegation

  /**
   * Admit one deferred request.
   *
   * The pre-flight runs first and its refusal is the tool's error: a target
   * that cannot take the work is reported now rather than discovered by a
   * watchdog ten minutes later.
   *
   * @param callerId - the requesting session, from the tool's calling agent.
   * @param input - what to ask and what to expose.
   * @returns the ticket, the target's status at admission, and the grants held.
   */
  async delegate(callerId: string, input: DelegateInput): Promise<DelegateOutcome> {
    const subject = input.subject.trim()
    if (subject.length === 0) throw new Error('subject 不能为空')
    const link = this.resolveLink(callerId, input)
    const targetId = this.peerOf(link, callerId)

    const feasible = await this.feasibility.resolveTarget(targetId, this.probeCtx)
    if (!feasible.ok) throw new Error(feasible.reason)

    const deadlineMs = clampDeadline(input.deadlineMs)
    const created: BufferGrant[] = []
    for (const request of input.grants ?? []) {
      created.push(this.newGrant(callerId, targetId, request))
    }
    const referenced: BufferGrant[] = []
    for (const grantId of input.grantIds ?? []) {
      const grant = this.requireGrant(grantId)
      if (grant.revokedAt !== undefined) throw new Error(`授权已回收：${grantId}`)
      if (grant.from !== callerId || grant.to !== targetId) {
        throw new Error(`授权 ${grantId} 不是本会话发给该会话的`)
      }
      grant.count += 1
      referenced.push(grant)
    }
    const held = [...created, ...referenced]
    const ticket: BufferTicket = {
      id: newId('ticket'),
      linkId: link.id,
      from: callerId,
      to: targetId,
      subject,
      ...input.detail === undefined || input.detail.trim().length === 0 ? {} : { detail: input.detail.trim() },
      state: 'queued',
      grantIds: held.map(grant => grant.id),
      createdAt: Date.now(),
      deadlineAt: Date.now() + deadlineMs,
      reports: [],
    }
    this.tickets.push(ticket)
    await this.save()

    // Deliver LAST: a delivery failure must not lose the ticket, and the
    // requester needs the ticket id even if the target cannot be reached.
    const text = renderRequestNotice(ticket, this.labelOf(callerId), held)
    const delivered = await this.deliver(targetId, text, requestSummary(ticket, this.labelOf(callerId)))
    if (!delivered.ok) {
      await this.settle(ticket, 'failed', undefined, `投递失败：${delivered.reason}`)
      throw new Error(delivered.reason)
    }
    return { ticket, targetStatus: feasible.status, grants: held }
  }

  /** Cancel an outstanding ticket. Either end may do it. */
  async cancel(ticketId: string, callerId: string): Promise<void> {
    const ticket = this.requireTicket(ticketId)
    if (ticket.from !== callerId && ticket.to !== callerId) {
      throw new Error(`ticket ${ticketId} 与本会话无关`)
    }
    if (SETTLED_STATES.includes(ticket.state)) return
    await this.settle(ticket, 'cancelled', undefined, `由 ${short(callerId)} 取消`)
  }

  /**
   * Cancel an outstanding ticket on the user's authority.
   *
   * The pipe UI is not a session, so it cannot be an end of the ticket; the
   * user is the one who created the link and may always withdraw the work it
   * carries.
   */
  async cancelByUser(ticketId: string): Promise<void> {
    const ticket = this.requireTicket(ticketId)
    if (SETTLED_STATES.includes(ticket.state)) return
    await this.settle(ticket, 'cancelled', undefined, '由用户取消')
  }

  // ------------------------------------------------------------------ worker

  /** Mark a ticket as being worked on. */
  async claim(ticketId: string, callerId: string): Promise<void> {
    const ticket = this.requireWorkerTicket(ticketId, callerId)
    if (ticket.state === 'running') return
    if (ticket.state !== 'queued') throw new Error(`ticket ${ticketId} 已结算（${ticket.state}）`)
    ticket.state = 'running'
    ticket.startedAt = Date.now()
    await this.save()
  }

  /** File a progress (or blocked) report the requester can see. */
  async report(ticketId: string, callerId: string, text: string, blocked: boolean): Promise<void> {
    const ticket = this.requireWorkerTicket(ticketId, callerId)
    if (ticket.state !== 'queued' && ticket.state !== 'running') {
      throw new Error(`ticket ${ticketId} 已结算（${ticket.state}）`)
    }
    if (ticket.state === 'queued') {
      ticket.state = 'running'
      ticket.startedAt = Date.now()
    }
    ticket.reports.push({ time: Date.now(), text: text.trim(), kind: blocked ? 'blocked' : 'progress' })
    await this.save()
  }

  /** Settle a ticket as done, with the worker's result. */
  async finish(ticketId: string, callerId: string, result: string): Promise<void> {
    await this.settleWorker(ticketId, callerId, 'done', result, undefined)
  }

  /** Settle a ticket as failed, with the worker's reason. */
  async fail(ticketId: string, callerId: string, error: string): Promise<void> {
    await this.settleWorker(ticketId, callerId, 'failed', undefined, error)
  }

  private async settleWorker(
    ticketId: string,
    callerId: string,
    state: 'done' | 'failed',
    result: string | undefined,
    error: string | undefined,
  ): Promise<void> {
    const ticket = this.requireWorkerTicket(ticketId, callerId)
    if (SETTLED_STATES.includes(ticket.state)) {
      throw new Error(`ticket ${ticketId} 已结算（${ticket.state}）`)
    }
    await this.settle(ticket, state, result, error)
  }

  // ----------------------------------------------------------- granted files

  /** Read a file inside a granted area, as the granter. */
  async readGranted(callerId: string, grantId: string, path: string, signal?: AbortSignal): Promise<string> {
    const access = await this.authorize(callerId, grantId, path, 'read', signal)
    return await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.readText(access.target, signal),
    )
  }

  /** List a directory inside a granted area, as the granter. */
  async listGranted(callerId: string, grantId: string, path: string, signal?: AbortSignal): Promise<string> {
    const access = await this.authorize(callerId, grantId, path, 'read', signal)
    const entries = await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.listDir(access.target, signal),
    )
    if (entries.length === 0) return `${path} 下没有条目。`
    return entries
      .map(entry => `${entry.type === 'directory' ? 'd' : entry.type === 'file' ? '-' : '?'} ${entry.name}`)
      .join('\n')
  }

  /** Write a file inside a granted area, as the granter, under the granter's policy. */
  async writeGranted(
    callerId: string,
    grantId: string,
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const access = await this.authorize(callerId, grantId, path, 'write', signal)
    // The policy is resolved against the GRANTER's session: without it the
    // sandbox falls back to its fail-safe default and refuses every local
    // write, and the grant would be read-only in practice. Resolving it here
    // also means the granter's own mode is the ceiling — a grant can never
    // widen it. Structural, optional: a composition that mounts no policy
    // service leaves the backend its own default.
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: access.granter.session })
    await this.ctx.agents.withInitiator(
      access.granter,
      () => this.ctx.fs.writeText(access.target, content, undefined, signal, policy),
    )
  }

  /**
   * Copy one file between the granted area's execution world and this
   * session's own.
   *
   * This is the one operation that crosses worlds rather than reaching into
   * one: the source is read through `ctx.fs` as its owner, and the destination
   * is written through the shell seam as ITS owner, so a grantee on a device
   * and a granter on this machine (or the reverse) never learn more about each
   * other than the bytes moved. `path` is always the grant-side path and
   * `dest` the caller-side one; `side` says which end is the source.
   *
   * @param callerId - the session exercising the grant.
   * @param grantId - the grant, which supplies the path's scope and the right.
   * @param path - path relative to a granted area root.
   * @param dest - path in the caller's own world; omitted means the same
   *   relative path, which is what "the corresponding location" means here.
   * @param side - `from` reads the granted area (needs read), `to` writes it
   *   (needs write).
   * @param maxBytes - size ceiling override, clamped by the service.
   * @returns what moved where, in bytes.
   */
  async transfer(
    callerId: string,
    grantId: string,
    path: string,
    dest: string | undefined,
    side: TransferSide,
    maxBytes: number | undefined,
    signal?: AbortSignal,
  ): Promise<TransferOutcome> {
    const access = await this.authorize(callerId, grantId, path, side === 'from' ? 'read' : 'write', signal)
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(callerId))
    if ('error' in resolved) throw new Error(`本会话不可用：${resolved.error.code}`)
    const caller = resolved.agent
    const callerPath = dest === undefined || dest.trim().length === 0 ? path : dest.trim()
    // Resolved as the CALLER: the path lands in this session's own world, which
    // is a device tree over its own route or this machine.
    const callerTarget = await this.ctx.agents.withInitiator(
      caller,
      () => this.ctx.fs.resolve(callerPath, this.resolveOptions(caller, signal)),
    )
    const source = side === 'from' ? access.target : callerTarget
    const destination = side === 'to' ? access.target : callerTarget
    const sourceWorld = side === 'from' ? access.granter : caller
    const destinationWorld = side === 'to' ? access.granter : caller

    const info = await this.ctx.agents.withInitiator(sourceWorld, () => this.ctx.fs.stat(source, signal))
    if (info === undefined) throw new Error(`源文件不存在：${source.displayPath}`)
    if (info.type !== 'file') throw new Error(`源不是普通文件：${source.displayPath}（${info.type}）`)

    // Dispatch by size: one inline move up to the stdin ceiling, a chunked
    // relay above it. With no ceiling named, any file the inline path can
    // carry just goes (the 8 MiB default predates the chunked path and would
    // otherwise refuse 8-32 MiB files that need no relay at all); a named
    // ceiling applies to the WHOLE file in either mode.
    const big = info.size !== undefined && info.size > CHUNK_THRESHOLD_BYTES
    const cap = big
      ? clampBig(maxBytes)
      : maxBytes === undefined ? MAX_TRANSFER_BYTES : clampTransfer(maxBytes)
    if (info.size !== undefined && info.size > cap) {
      throw new Error(
        `源文件 ${fmtBytes(info.size)}，超过本次上限 ${fmtBytes(cap)}；`
        + (big
          ? `分块传输默认上限 ${fmtBytes(DEFAULT_BIG_BYTES)}，硬上限 ${fmtBytes(MAX_BIG_BYTES)}，可用 max_bytes 提高。`
          : `inline 上限 ${fmtBytes(MAX_TRANSFER_BYTES)}；更大的文件会自动走分块传输。`),
      )
    }
    if (big) {
      return await this.transferChunked(callerId, side, source, destination, sourceWorld, destinationWorld, info.size, signal)
    }

    const bytes = await this.ctx.agents.withInitiator(
      sourceWorld,
      () => this.ctx.fs.readBytes(source, signal, cap),
    )
    await this.writeBytesAs(destinationWorld, destination, bytes, signal)
    return {
      bytes: bytes.byteLength,
      source: source.displayPath,
      destination: destination.displayPath,
      side,
    }
  }

  /**
   * Relay one oversized file in chunks.
   *
   * The two worlds share no filesystem, so the file moves through the harness
   * in bounded pieces: the source world `split`s it into {@link CHUNK_BYTES}
   * slices under a scratch directory, every slice is read as bytes and written
   * into the destination world's scratch directory through the same
   * base64-over-stdin path the inline move uses, and the destination world
   * `cat`s the slices back together. Both ends checksum the whole file and the
   * transfer refuses to report success on a mismatch; the scratch directories
   * are cleaned on success and left in place on failure for inspection.
   */
  private async transferChunked(
    callerId: string,
    side: TransferSide,
    source: FsTarget,
    destination: FsTarget,
    sourceWorld: Agent,
    destinationWorld: Agent,
    total: number | undefined,
    signal?: AbortSignal,
  ): Promise<TransferOutcome> {
    const size = Math.max(0, total ?? 0)
    const chunksTotal = Math.max(1, Math.ceil(size / CHUNK_BYTES))
    const id = newId('xfer')
    const record: BufferTransfer = {
      id,
      sessionId: callerId,
      label: `${source.displayPath} → ${destination.displayPath}`,
      bytesDone: 0,
      bytesTotal: size,
      chunksDone: 0,
      chunksTotal,
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
    }
    this.transfers.set(id, record)
    // Scratch directories live INSIDE each world's workspace, not /tmp: the
    // slicing and reassembly run through that world's sandboxed shell, and a
    // 工作区内修改 policy refuses writes outside the workspace.
    const scratchOf = (world: Agent): string => {
      const cwd = world.session.header.cwd
      return `${(cwd ?? '/tmp').replace(/\/+$/u, '')}/.dshell-xfer-${id.slice(5)}`
    }
    const sourceScratch = scratchOf(sourceWorld)
    const destinationScratch = scratchOf(destinationWorld)
    try {
      // Slice in the source world and pin the whole-file checksum.
      const sourcePath = this.ctx.fs.processPath(source)
      await this.execAs(
        sourceWorld,
        `mkdir -p -- ${quote(sourceScratch)} && split -b ${String(CHUNK_BYTES)} -d -a 4 -- ${quote(sourcePath)} ${quote(sourceScratch + '/p')}`
        + ` && sha256sum ${quote(sourcePath)} > ${quote(sourceScratch + '/sum')}`,
        signal,
      )
      const sumOf = (text: string): string =>
        text.split('\n').map(line => line.trim()).find(line => line.length > 0)?.split(/\s+/u)[0] ?? ''
      const sourceSha = sumOf(await this.readWorldFile(sourceWorld, `${sourceScratch}/sum`, signal))
      const entries = await this.ctx.agents.withInitiator(
        sourceWorld,
        async () => await this.ctx.fs.listDir(
          await this.ctx.fs.resolve(sourceScratch, this.resolveOptions(sourceWorld, signal)),
          signal,
        ),
      )
      const names = entries.filter(entry => entry.type === 'file' && entry.name.startsWith('p')).map(entry => entry.name).sort()
      if (names.length !== chunksTotal) {
        throw new Error(`分块数量不符：预期 ${String(chunksTotal)}，实际 ${String(names.length)}`)
      }
      const destinationPath = this.ctx.fs.processPath(destination)
      await this.execAs(destinationWorld, `mkdir -p -- ${quote(destinationScratch)}`, signal)
      let bytesDone = 0
      for (const [index, name] of names.entries()) {
        signal?.throwIfAborted()
        const bytes = await this.ctx.agents.withInitiator(
          sourceWorld,
          async () => await this.ctx.fs.readBytes(
            await this.ctx.fs.resolve(`${sourceScratch}/${name}`, this.resolveOptions(sourceWorld, signal)),
            signal,
            CHUNK_BYTES,
          ),
        )
        await this.ctx.agents.withInitiator(
          destinationWorld,
          async () => await this.writeBytesAs(
            destinationWorld,
            await this.ctx.fs.resolve(`${destinationScratch}/${name}`, this.resolveOptions(destinationWorld, signal)),
            bytes,
            signal,
          ),
        )
        bytesDone += bytes.byteLength
        this.transfers.set(id, { ...record, bytesDone, chunksDone: index + 1 })
      }
      // Reassemble in the destination world and verify the whole-file digest.
      await this.execAs(
        destinationWorld,
        `mkdir -p -- ${quote(posixDirname(destinationPath))} && cat ${quote(destinationScratch)}/p* > ${quote(destinationPath)}`
        + ` && sha256sum ${quote(destinationPath)} > ${quote(destinationScratch + '/sum')}`,
        signal,
      )
      const destinationSha = sumOf(await this.readWorldFile(destinationWorld, `${destinationScratch}/sum`, signal))
      if (sourceSha === '' || destinationSha !== sourceSha) {
        throw new Error(`分块传输校验不一致：源 ${sourceSha || '未知'}，目标 ${destinationSha || '未知'}。中间数据保留在 ${sourceScratch} 与 ${destinationScratch}`)
      }
      await this.execAs(sourceWorld, `rm -rf -- ${quote(sourceScratch)}`, signal)
      await this.execAs(destinationWorld, `rm -rf -- ${quote(destinationScratch)}`, signal)
      const finished: BufferTransfer = { ...record, bytesDone: size, chunksDone: chunksTotal, finishedAt: Date.now() }
      this.transfers.set(id, finished)
      this.pruneTransfer(id)
      return {
        bytes: size,
        source: source.displayPath,
        destination: destination.displayPath,
        side,
        chunks: chunksTotal,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.transfers.set(id, { ...record, finishedAt: Date.now(), error: reason })
      this.pruneTransfer(id)
      throw error
    }
  }

  /** Convenience: resolve an absolute scratch path as one world and read it. */
  private async readWorldFile(world: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return await this.ctx.agents.withInitiator(
      world,
      async () => await this.ctx.fs.readText(
        await this.ctx.fs.resolve(path, this.resolveOptions(world, signal)),
        signal,
      ),
    )
  }

  /** Run one shell command AS one world, fenced by that world's own policy. */
  private async execAs(world: Agent, command: string, signal?: AbortSignal): Promise<void> {
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      throw new Error('本次组合没有 shell 服务，无法执行跨世界传输')
    }
    const cwd = world.session.header.cwd
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: world.session })
    const spec = this.ctx.agents.withInitiator(world, () => shell.resolve({
      command,
      ...cwd === undefined ? {} : { workdir: cwd },
      ...policy === undefined ? {} : { sandboxPolicy: policy },
      ...signal === undefined ? {} : { signal },
    }))
    const result = await shell.run({ ...spec, stdin: undefined })
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim()
      throw new Error(
        `命令执行失败：${detail.length > 0 ? detail : `退出码 ${String(result.exitCode ?? result.signal ?? 'unknown')}`}`)
    }
  }

  /** Drop a settled transfer from the snapshot after progress surfaces catch it. */
  private pruneTransfer(id: string): void {
    const timer = setTimeout(() => { this.transfers.delete(id) }, TRANSFER_TAIL_MS)
    timer.unref?.()
  }

  /**
   * Write bytes into ONE session's execution world.
   *
   * `ctx.fs` has no byte write — both of its mutations take text, and its
   * remote half encodes stdin as UTF-8 — so the bytes travel base64 on the
   * shell seam's stdin and are decoded by the destination world's own
   * `base64 -d`. That seam is the right one rather than a new filesystem
   * method: it already routes per initiator (a device session decodes on the
   * device, with no new transport), and the executor already fences the run by
   * the session's resolved policy, so this write is bounded exactly where
   * `writeText` would be — a grant cannot reach outside what that session's
   * own mode allows.
   */
  private async writeBytesAs(world: Agent, target: FsTarget, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const shell = this.ctx.get('shell')
    if (shell === undefined) {
      throw new Error('本次组合没有 shell 服务，无法把字节写入目标执行环境')
    }
    // `processPath` is the path this filesystem's own world can open, which is
    // the device path for a remote target and the host path locally — exactly
    // the string the destination shell needs.
    const path = this.ctx.fs.processPath(target)
    const cwd = world.session.header.cwd
    const policy = this.ctx.get('sandboxPolicy')?.resolve({ session: world.session })
    const spec = this.ctx.agents.withInitiator(world, () => shell.resolve({
      command: `mkdir -p -- ${quote(posixDirname(path))} && base64 -d > ${quote(path)}`,
      ...cwd === undefined ? {} : { workdir: cwd },
      ...policy === undefined ? {} : { sandboxPolicy: policy },
      ...signal === undefined ? {} : { signal },
    }))
    const result = await shell.run({ ...spec, stdin: Buffer.from(bytes).toString('base64') })
    if (result.exitCode !== 0) {
      const detail = result.stderr.text.trim()
      throw new Error(
        `写入 ${target.displayPath} 失败：`
        + (detail.length > 0 ? detail : `退出码 ${String(result.exitCode ?? result.signal ?? 'unknown')}`),
      )
    }
  }

  /** The fs resolution options for one session: its cwd and the call's signal. */
  private resolveOptions(agent: Agent, signal?: AbortSignal): { cwd?: string; signal?: AbortSignal } {
    const cwd = agent.session.header.cwd
    return {
      ...cwd === undefined ? {} : { cwd },
      ...signal === undefined ? {} : { signal },
    }
  }

  /**
   * Resolve a request against a grant's areas.
   *
   * The area root and the requested path are both resolved **as the granter**,
   * so a device-bound granter's tree is read over its own SSH route and a local
   * granter's tree on this machine — the caller never learns which, and never
   * needs to. Containment is then checked on the canonical targets, so `..` and
   * symlinks in the request cannot escape the area.
   *
   * @returns the granter agent, the resolved target, and the area it matched.
   */
  private async authorize(
    callerId: string,
    grantId: string,
    path: string,
    right: BufferRight,
    signal?: AbortSignal,
  ): Promise<{ granter: Agent; target: FsTarget; area: BufferArea }> {
    const grant = this.requireGrant(grantId)
    if (grant.revokedAt !== undefined) throw new Error(`授权已回收：${grantId}`)
    if (grant.to !== callerId) throw new Error(`授权 ${grantId} 不是发给本会话的`)
    if (grant.count <= 0) throw new Error(`授权 ${grantId} 已无未结算任务，已回收`)
    const areas = grant.areas.filter(area => area.rights.includes(right))
    if (areas.length === 0) throw new Error(`授权 ${grantId} 不含「${right}」权限`)
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(grant.from))
    if ('error' in resolved) throw new Error(`授权方会话不可用：${resolved.error.code}`)
    const granter = resolved.agent
    // Built conditionally: `exactOptionalPropertyTypes` treats an explicit
    // `undefined` as a value, and the resolution options are optional keys.
    const options = this.resolveOptions(granter, signal)
    const rejections: string[] = []
    for (const area of areas) {
      try {
        const rootTarget = await this.ctx.agents.withInitiator(
          granter,
          () => this.ctx.fs.resolve(area.path, options),
        )
        const fileTarget = await this.ctx.agents.withInitiator(
          granter,
          () => this.ctx.fs.resolve(joinRelative(rootTarget, path), options),
        )
        if (!isUnder(String(rootTarget.targetKey), String(fileTarget.targetKey))) {
          rejections.push(`${area.path}：越界`)
          continue
        }
        return { granter, target: fileTarget, area }
      } catch (error) {
        rejections.push(`${area.path}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`不在授权范围内（${path}）：${rejections.join('；')}`)
  }

  // --------------------------------------------------------------- internals

  /**
   * Create a grant for one delegation, born with one reference (the ticket it
   * is issued for). A grant outlives the ticket only when a later delegation
   * references it by id, which increments the same counter.
   */
  private newGrant(from: string, to: string, request: GrantRequest): BufferGrant {
    if (request.areas.length === 0) throw new Error('授权至少要包含一个目录')
    const grant: BufferGrant = {
      id: newId('grant'),
      from,
      to,
      description: request.description.trim(),
      areas: request.areas.map(area => ({ path: area.path, rights: [...area.rights] })),
      count: 1,
      createdAt: Date.now(),
    }
    this.grants.push(grant)
    return grant
  }

  /** Settle a ticket, release its grants and wake the requester exactly once. */
  private async settle(
    ticket: BufferTicket,
    state: BufferTicketState,
    result: string | undefined,
    error: string | undefined,
  ): Promise<void> {
    if (state === 'queued' || state === 'running') throw new Error(`不能结算到 ${state}`)
    if (SETTLED_STATES.includes(ticket.state)) return
    ticket.state = state
    ticket.settledAt = Date.now()
    if (result !== undefined) ticket.result = result
    if (error !== undefined) ticket.error = error
    for (const grantId of ticket.grantIds) this.releaseGrant(grantId)
    await this.save()
    await this.wake(ticket)
  }

  /** Drop one reference; reaching zero revokes the grant at once. */
  private releaseGrant(grantId: string): void {
    const grant = this.grants.find(candidate => candidate.id === grantId)
    if (grant === undefined || grant.revokedAt !== undefined) return
    grant.count = Math.max(0, grant.count - 1)
    if (grant.count === 0) grant.revokedAt = Date.now()
  }

  /** Deliver the settlement notice to the requester. */
  private async wake(ticket: BufferTicket): Promise<void> {
    const text = renderSettlementNotice(ticket, this.labelOf(ticket.to))
    await this.deliver(ticket.from, text, settlementSummary(ticket, this.labelOf(ticket.to)))
  }

  /**
   * Hand one message to a session.
   *
   * Delivery mirrors dsh's job registry: an idle agent is woken with a new
   * turn, a running one is injected so the message parks at its next step
   * (a notice must not be lost, and it must not interrupt a step in flight).
   *
   * @returns whether the message was admitted.
   */
  private async deliver(
    sessionId: string,
    text: string,
    summary: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const resolved = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
      if ('error' in resolved) return { ok: false, reason: `目标会话不可用：${resolved.error.code}` }
      const agent = resolved.agent
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: BUFFER_PLUGIN, form: 'notice', summary },
      })
      if (agent.status === 'idle') agent.followup(message)
      else agent.inject(message)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** A worker session went away: settle its live tickets so nobody waits on it. */
  private async onAgentDisposed(sessionId: string): Promise<void> {
    if (this.disposed) return
    const orphaned = this.tickets.filter(ticket =>
      ticket.to === sessionId && (ticket.state === 'queued' || ticket.state === 'running'))
    for (const ticket of orphaned) {
      await this.settle(ticket, 'failed', undefined, `承接会话 ${short(sessionId)} 已关闭`)
    }
    // The requester going away ends its requests too: nothing can be woken
    // any more, and the worker should not keep spending on a dead ticket.
    const requested = this.tickets.filter(ticket =>
      ticket.from === sessionId && (ticket.state === 'queued' || ticket.state === 'running'))
    for (const ticket of requested) {
      await this.settle(ticket, 'cancelled', undefined, `发起会话 ${short(sessionId)} 已关闭`)
    }
  }

  /** Settle tickets nobody resolved in time. */
  private async sweep(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const expired = this.tickets.filter(ticket =>
      (ticket.state === 'queued' || ticket.state === 'running') && now >= ticket.deadlineAt)
    for (const ticket of expired) {
      await this.settle(ticket, 'timeout', undefined, '超过了委派时给定的期限')
    }
  }

  /** Find the link a delegation travels over. */
  private resolveLink(callerId: string, input: DelegateInput): BufferLink {
    if (input.linkId !== undefined) {
      const link = this.links.find(candidate => candidate.id === input.linkId)
      if (link === undefined) throw new Error(`没有这个管道：${input.linkId}`)
      if (link.a !== callerId && link.b !== callerId) throw new Error(`管道 ${input.linkId} 与本会话无关`)
      return link
    }
    const to = input.to?.trim()
    if (to === undefined || to.length === 0) throw new Error('需要 to 或 link_id 指定目标会话')
    if (to === callerId) throw new Error('不能把请求委派给自己')
    const link = this.links.find(candidate =>
      (candidate.a === callerId && candidate.b === to) || (candidate.a === to && candidate.b === callerId))
    if (link === undefined) {
      throw new Error(`本会话与 ${short(to)} 之间还没有管道；请在「管道」页面里先建立连接`)
    }
    return link
  }

  private requireGrant(grantId: string): BufferGrant {
    const grant = this.grants.find(candidate => candidate.id === grantId)
    if (grant === undefined) throw new Error(`没有这个授权：${grantId}`)
    return grant
  }

  private requireTicket(ticketId: string): BufferTicket {
    const ticket = this.tickets.find(candidate => candidate.id === ticketId)
    if (ticket === undefined) throw new Error(`没有这个 ticket：${ticketId}`)
    return ticket
  }

  private requireWorkerTicket(ticketId: string, callerId: string): BufferTicket {
    const ticket = this.requireTicket(ticketId)
    if (ticket.to !== callerId) throw new Error(`ticket ${ticketId} 不是发给本会话的`)
    return ticket
  }

  /** A readable handle for a session in message text. */
  private labelOf(sessionId: string): string {
    const link = this.links.find(candidate => candidate.a === sessionId || candidate.b === sessionId)
    return sessionLabel(sessionId, link?.label, undefined)
  }

  /** Persist, serialized so two mutations cannot interleave their writes. */
  private save(): Promise<void> {
    const next = this.saveChain.then(() => {
      writeDocument({
        version: 1,
        links: this.links,
        tickets: this.tickets,
        grants: this.grants,
      })
    })
    this.saveChain = next.catch(() => { /* the next write retries the document */ })
    return next
  }
}

/** A short, readable, collision-resistant id for a link, ticket or grant. */
function newId(prefix: string): string {
  const random = globalThis.crypto.randomUUID().replace(/-/gu, '').slice(0, 10)
  return `${prefix}_${random}`
}

/** First 8 characters of a session id, for message text. */
function short(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** Clamp a caller-supplied deadline into the range the watchdog can honour. */
function clampDeadline(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_DEADLINE_MS
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Math.floor(requested)))
}

/** Clamp a caller-supplied transfer ceiling. */
function clampTransfer(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TRANSFER_BYTES
  return Math.min(MAX_TRANSFER_BYTES, Math.max(1, Math.floor(requested)))
}

/** Clamp a chunked transfer's WHOLE-size ceiling. */
function clampBig(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_BIG_BYTES
  return Math.min(MAX_BIG_BYTES, Math.max(CHUNK_BYTES, Math.floor(requested)))
}

/** Human-readable byte count for error text. */
function fmtBytes(size: number): string {
  return size >= 1024 * 1024 * 1024
    ? `${(size / (1024 * 1024 * 1024)).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(size / (1024 * 1024)))} MiB`
}

/**
 * The directory part of a POSIX path, without `node:path`.
 *
 * Both execution worlds in this composition are POSIX (this machine and the
 * device), and a device path must not be run through a local path module that
 * would rewrite its separators.
 */
function posixDirname(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0) return '.'
  return cut === 0 ? '/' : trimmed.slice(0, cut)
}

/** Single-quote one shell argument so the destination shell reads it literally. */
function quote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`
}

/**
 * Join a relative request onto a canonical root, keeping the root's own
 * separator style (the root may be a device path).
 */
function joinRelative(root: FsTarget, path: string): string {
  const base = String(root.targetKey).replace(/[/\\]+$/u, '')
  if (path.length === 0 || path === '.' || path === './') return base
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(path)) {
    throw new Error(`path 必须是相对于授权目录的路径，收到绝对路径：${path}`)
  }
  return `${base}/${path.replace(/^\.\//u, '')}`
}

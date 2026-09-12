/**
 * The single `dshell_buffer` tool — the only door between an agent and the
 * buffer.
 *
 * Four families of action behind one name (linking state, ticket lifecycle,
 * the grant view, and granted file access). One tool rather than a dozen keeps
 * the surface small for the model and, more importantly, keeps every check in
 * one place: the granted file actions are the only way a session can touch
 * another session's tree, and they run through the service's single
 * containment test.
 *
 * The calling session is taken from `exec.agent`, never from an argument, so a
 * model cannot claim to be someone else.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { BufferGrant, BufferTicket } from './protocol.js'
import type { DelegateInput, GrantRequest, BufferService } from './service.js'

/** Hard cap on text an agent may pull out of one granted file in one call. */
const MAX_READ_CHARS = 120_000

const ACTION_KINDS: Record<string, GenericCallView['kind']> = {
  links: 'read',
  tickets: 'read',
  grants: 'read',
  read: 'read',
  ls: 'read',
  transfer: 'move',
}

const DESCRIPTION =
  'Cross-session pipe. Use it to hand a task to a session the user connected to this one, '
  + 'and to work on requests other sessions handed to you. Actions:\n'
  + '- links: the pipes this session is an end of (how you learn the peer session ids and link ids).\n'
  + '- delegate: send a request to the session on the other end of a pipe. Supply to or link_id, a '
  + 'subject, optional detail, an optional deadline_ms, and optionally grants — directories this '
  + 'session is opening to the other side, each with read and/or write rights. Returns at once with a '
  + 'ticket id; the answer arrives later as a new message, so end your turn or keep working on '
  + 'something else instead of waiting.\n'
  + '- tickets: the requests sent to you (direction "in") or by you (direction "out").\n'
  + '- claim / progress / finish / fail: the worker side of a ticket. A ticket you received must end '
  + 'in finish (with a result) or fail (with a reason); nothing may be left unresolved.\n'
  + '- cancel: withdraw an outstanding ticket from either end.\n'
  + '- grants: grants other sessions handed to you, with their provenance, description and remaining '
  + 'reference count, and grants you issued, so you can see what is still open.\n'
  + '- read / ls / write: file access inside a granted area, addressed by grant_id plus a path '
  + 'relative to the area root. Paths outside the granted areas are refused.\n'
  + '- transfer: copy one FILE, bytes intact, between the granted area and this session\'s own '
  + 'machine. side="from" (the default) pulls the granted area\'s path to this session\'s dest; '
  + 'side="to" pushes this session\'s dest into the granted area\'s path. dest defaults to the same '
  + 'relative path, which is the corresponding location in the other world. It needs read (from) or '
  + 'write (to) on the grant, is capped by max_bytes, and works for binary files that read/write '
  + 'cannot carry.\n'
  + 'A grant stays alive only while a ticket references it; settle the ticket and the access ends.'

/**
 * One delegation's inline grant, as the model writes it.
 *
 * A separate shape from the service's `GrantRequest` only because the wire form
 * is snake_case-JSON while the service speaks camelCase.
 */
interface GrantParam {
  readonly description: string
  readonly areas: readonly { readonly path: string; readonly rights: readonly ('read' | 'write')[] }[]
}

/** Normalize a model-supplied grant into the service's request shape. */
function toGrantRequest(grants: readonly GrantParam[]): GrantRequest[] {
  return grants.map(grant => ({
    description: grant.description,
    areas: grant.areas.map(area => ({ path: area.path, rights: [...area.rights] })),
  }))
}

/** Require one non-empty string argument. */
function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`缺少参数 ${name}`)
  return value.trim()
}

/** Minutes from now until a deadline, never below zero. */
function minutesLeft(deadlineAt: number): number {
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 60_000))
}

/** `读/写` for a rights list. */
function rightsLabel(rights: readonly string[]): string {
  const parts: string[] = []
  if (rights.includes('read')) parts.push('读')
  if (rights.includes('write')) parts.push('写')
  return parts.length > 0 ? parts.join('/') : '无'
}

/** One line acounting for a ticket, from the side of the session reading it. */
function ticketLine(ticket: BufferTicket, service: BufferService, viewer: string): string {
  const peer = ticket.from === viewer ? ticket.to : ticket.from
  const who = ticket.from === viewer ? '发给' : '来自'
  const state = ticket.state === 'queued' || ticket.state === 'running'
    ? `${ticket.state}（剩约 ${String(minutesLeft(ticket.deadlineAt))} 分钟）`
    : ticket.state
  const tail = ticket.result ?? ticket.error ?? ticket.reports[ticket.reports.length - 1]?.text
  return `- ${ticket.id} · ${state} · ${who} ${service.label(peer)} · ${ticket.subject}${tail === undefined ? '' : ` · ${tail}`}`
}

/** Render the link list. */
function renderLinks(service: BufferService, viewer: string): string {
  const links = service.linksFor(viewer)
  if (links.length === 0) {
    return '本会话还没有连接到任何会话。请让用户打开「管道」页面建立连接；建立之前无法委派。'
  }
  const lines = ['本会话的管道：']
  for (const link of links) {
    const peer = service.peerOf(link, viewer)
    lines.push(`- ${link.id} ↔ ${service.label(peer)}（session ${peer}）${link.label === undefined ? '' : ` · ${link.label}`}`)
  }
  lines.push('', '用 delegate 时把 to 设成对方 session id，或把 link_id 设成上面的管道 id。')
  return lines.join('\n')
}

/** Render the granted-area view, from both directions. */
function renderGrants(service: BufferService, viewer: string): string {
  const received = service.grantsFor(viewer)
  const issued = service.grantsIssuedBy(viewer)
  const lines: string[] = []
  lines.push('他人授予本会话的访问权：')
  if (received.length === 0) {
    lines.push('- （无）')
  } else {
    for (const grant of received) {
      lines.push(`- ${grant.id} · 授予方 ${service.label(grant.from)} · 剩余引用 ${String(grant.count)}`)
      if (grant.description.trim().length > 0) lines.push(`  用途：${grant.description.trim()}`)
      for (const area of grant.areas) lines.push(`  区域：${area.path}（${rightsLabel(area.rights)}）`)
    }
    lines.push('', '用 read / ls / write 访问，参数为 grant_id 与相对区域根的路径。')
  }
  lines.push('', '本会话发出的访问权：')
  if (issued.length === 0) {
    lines.push('- （无）')
  } else {
    for (const grant of issued) {
      const state = grant.revokedAt === undefined ? `剩余引用 ${String(grant.count)}` : '已回收'
      lines.push(`- ${grant.id} · 给 ${service.label(grant.to)} · ${state}`)
      for (const area of grant.areas) lines.push(`  区域：${area.path}（${rightsLabel(area.rights)}）`)
    }
  }
  return lines.join('\n')
}

/** Render a delegate outcome for the requester. */
function renderDelegated(
  ticket: BufferTicket,
  targetStatus: string,
  grants: readonly BufferGrant[],
  service: BufferService,
): string {
  const lines = [
    `已委派给 ${service.label(ticket.to)}（ticket ${ticket.id}）。`,
    targetStatus === 'idle'
      ? '对方当时空闲，已用一条新消息唤醒它。'
      : '对方当时正忙，请求已排进它的队列。',
  ]
  if (grants.length > 0) {
    lines.push('', '同时开出了这些访问权（任务结算时自动回收）：')
    for (const grant of grants) {
      lines.push(`- ${grant.id} · 给 ${service.label(grant.to)}`)
      for (const area of grant.areas) lines.push(`  ${area.path}（${rightsLabel(area.rights)}）`)
    }
  }
  lines.push(
    '',
    `结果会以一条新消息回到本会话（ticket ${ticket.id}），无论成功、失败还是超时。`,
    '现在不要空等：结束本回合，或继续你手上其他的事；回报到达时你的回合会被重新打开。',
  )
  return lines.join('\n')
}

/** Cap one granted read so a huge file cannot swallow the context. */
function capRead(text: string): string {
  if (text.length <= MAX_READ_CHARS) return text
  return `${text.slice(0, MAX_READ_CHARS)}\n…（已截断，原文 ${String(text.length)} 字符）`
}

/** Pending-call card for one action. */
function present(args: { action?: string; to?: string; ticket_id?: string; grant_id?: string; path?: string; subject?: string }): GenericCallView {
  const kind = args.action === undefined ? undefined : ACTION_KINDS[args.action]
  const target = args.to ?? args.ticket_id ?? args.grant_id ?? args.path
  const title = args.action === 'delegate' && args.subject !== undefined
    ? `管道委派：${args.subject}`
    : `管道 ${args.action ?? '操作'}`
  return { card: 'generic', title, ...kind === undefined ? {} : { kind }, ...target === undefined ? {} : { rawInput: target } }
}
/** Register the one buffer tool. */
export function registerBufferTool(ctx: Context, service: BufferService): () => void {
  return ctx.tools.register(defineTool({
    name: 'dshell_buffer',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['links', 'delegate', 'tickets', 'claim', 'progress', 'finish', 'fail', 'cancel', 'grants', 'read', 'ls', 'write', 'transfer'],
        description: 'Which buffer operation to perform.',
      },
      to: { type: 'string', description: 'delegate: target session id (the peer of a pipe).' },
      link_id: { type: 'string', description: 'delegate: the pipe to send over, instead of to.' },
      subject: { type: 'string', description: 'delegate: one-line statement of what is being asked.' },
      detail: { type: 'string', description: 'delegate: the full request, including acceptance criteria.' },
      grants: {
        type: 'array',
        description: 'delegate: directories this session opens to the target, each with read and/or write rights. Released automatically when the ticket settles.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string', required: true },
            areas: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  rights: { type: 'array', required: true, items: { type: 'string', enum: ['read', 'write'] } },
                },
              },
            },
          },
        },
      },
      grant_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'delegate: existing grant ids to hold open for this ticket instead of creating new ones.',
      },
      deadline_ms: { type: 'number', description: 'delegate: how long the target has before the watchdog settles the ticket as timeout. Default 10 minutes.' },
      ticket_id: { type: 'string', description: 'The ticket a lifecycle action applies to.' },
      direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'tickets: which side to list. Default both.' },
      text: { type: 'string', description: 'progress: what to report.' },
      result: { type: 'string', description: 'finish: the outcome handed back to the requester.' },
      error: { type: 'string', description: 'fail: why the request could not be completed.' },
      grant_id: { type: 'string', description: 'read / ls / write / transfer: the grant being exercised.' },
      path: { type: 'string', description: 'read / ls / write: path relative to the granted area root. In transfer this is the grant-side path, and a directory path is listed by ls.' },
      content: { type: 'string', description: 'write: the full text to write.' },
      dest: { type: 'string', description: 'transfer: the path in THIS session\'s own machine; omitted means the same relative path as path.' },
      side: { type: 'string', enum: ['from', 'to'], description: 'transfer: "from" pulls from the granted area into this session (needs read); "to" pushes this session\'s file into the granted area (needs write). Default "from".' },
      max_bytes: { type: 'number', description: 'transfer: whole-file size ceiling in bytes. Files up to 32 MiB move inline; larger files transfer automatically in 16 MiB chunks with sha256 verification (default ceiling 1 GiB, hard cap 4 GiB).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec): Promise<{ text: string }> {
      if (exec.agent === undefined) throw new Error('dshell_buffer 只能在某个会话的 agent 内调用')
      const text = await run(args, String(exec.agent.id), service, exec.signal)
      return { text }
    },
    presentCall: args => present(args as Parameters<typeof present>[0]),
  }))
}

/** One dispatched action, returning its model-facing text. */
async function run(
  args: {
    action: string
    to?: string
    link_id?: string
    subject?: string
    detail?: string
    grants?: readonly GrantParam[]
    grant_ids?: readonly string[]
    deadline_ms?: number
    ticket_id?: string
    direction?: string
    text?: string
    result?: string
    error?: string
    grant_id?: string
    path?: string
    content?: string
    dest?: string
    side?: string
    max_bytes?: number
  },
  viewer: string,
  service: BufferService,
  signal: AbortSignal,
): Promise<string> {
  switch (args.action) {
    case 'links':
      return renderLinks(service, viewer)

    case 'delegate': {
      const input: DelegateInput = {
        ...args.to === undefined ? {} : { to: args.to },
        ...args.link_id === undefined ? {} : { linkId: args.link_id },
        subject: required(args.subject, 'subject'),
        ...args.detail === undefined ? {} : { detail: args.detail },
        ...args.grants === undefined ? {} : { grants: toGrantRequest(args.grants) },
        ...args.grant_ids === undefined ? {} : { grantIds: args.grant_ids },
        ...args.deadline_ms === undefined ? {} : { deadlineMs: args.deadline_ms },
      }
      const outcome = await service.delegate(viewer, input)
      return renderDelegated(outcome.ticket, outcome.targetStatus, outcome.grants, service)
    }

    case 'tickets': {
      const direction = args.direction === 'in' || args.direction === 'out' ? args.direction : 'both'
      const tickets = service.ticketsFor(viewer, direction)
      if (tickets.length === 0) {
        return direction === 'in'
          ? '没有其他会话委派给你的请求。'
          : direction === 'out' ? '本会话还没有委派过请求。' : '本会话没有管道请求记录。'
      }
      const lines = [`管道请求（${direction}，共 ${String(tickets.length)} 条）：`]
      for (const ticket of tickets) lines.push(ticketLine(ticket, service, viewer))
      const open = tickets.filter(ticket => ticket.state === 'queued' || ticket.state === 'running')
      if (open.some(ticket => ticket.to === viewer)) {
        lines.push('', '其中发给本会话的未结算请求，必须用 claim / progress / finish / fail 推进到结算。')
      }
      return lines.join('\n')
    }

    case 'claim': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      await service.claim(ticketId, viewer)
      return `已认领 ${ticketId}。完成后请用 finish（带 result）或 fail（带 error）结算。`
    }

    case 'progress': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      const body = required(args.text, 'text')
      await service.report(ticketId, viewer, body, false)
      return `已记录进度（${ticketId}）。`
    }

    case 'finish': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      const result = required(args.result, 'result')
      await service.finish(ticketId, viewer, result)
      return `已结算 ${ticketId} 为完成，请求方会被唤醒并收到结果。`
    }

    case 'fail': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      const reason = required(args.error, 'error')
      await service.fail(ticketId, viewer, reason)
      return `已结算 ${ticketId} 为失败，请求方会被唤醒并收到原因。`
    }

    case 'cancel': {
      const ticketId = required(args.ticket_id, 'ticket_id')
      await service.cancel(ticketId, viewer)
      return `已取消 ${ticketId}。`
    }

    case 'grants':
      return renderGrants(service, viewer)

    case 'read': {
      const grantId = required(args.grant_id, 'grant_id')
      const path = required(args.path, 'path')
      const body = await service.readGranted(viewer, grantId, path, signal)
      return `${path}（授权 ${grantId}）：\n\n${capRead(body)}`
    }

    case 'ls': {
      const grantId = required(args.grant_id, 'grant_id')
      const path = required(args.path, 'path')
      const listing = await service.listGranted(viewer, grantId, path, signal)
      return `目录 ${path}：\n${listing}`
    }

    case 'write': {
      const grantId = required(args.grant_id, 'grant_id')
      const path = required(args.path, 'path')
      if (args.content === undefined) throw new Error('缺少参数 content')
      await service.writeGranted(viewer, grantId, path, args.content, signal)
      return `已写入 ${path}（${String(args.content.length)} 字符）。`
    }

    case 'transfer': {
      const grantId = required(args.grant_id, 'grant_id')
      const path = required(args.path, 'path')
      const side = args.side === 'to' ? 'to' : 'from'
      const outcome = await service.transfer(viewer, grantId, path, args.dest, side, args.max_bytes, signal)
      return `已传输（${side === 'from' ? '拉取' : '推送'}）：`
        + `${outcome.source} → ${outcome.destination}，${String(outcome.bytes)} 字节。`
    }

    default:
      throw new Error(`未知 action：${args.action}`)
  }
}

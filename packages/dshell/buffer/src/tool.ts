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
  download: 'move',
  upload: 'move',
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
  + '- ls: with no path, list the buffer roots this session holds — each mapped area as name/ with '
  + 'its rights and origin. With a buffer path, list that directory.\n'
  + '- read: one text file from the buffer, addressed by buffer path (mappedName/sub/file). offset '
  + 'is a 1-based line to start from and limit caps lines, so big files page instead of flooding.\n'

  + '- edit: replace old_string with new_string inside one buffer file, in place — for targeted '
  + 'changes this beats download-then-upload. old_string must already exist and be unique unless '
  + 'replace_all is set; edit cannot create files, upload does that.\n'
  + '- download / upload: the explicit byte moves between the two machines. download copies a buffer '
  + 'file to dest in this session\'s own world; upload pushes this session\'s src file into the buffer '
  + 'at path. Binary-safe, capped by max_bytes; files up to 32 MiB move inline, anything larger is '
  + 'relayed in 16 MiB chunks with sha256 verification (up to 4 GiB).\n'
  + 'Buffer paths always start with the as name a grant declared, and each pipe has its own namespace — '
  + 'this is the only addressing the file actions need. A grant stays alive only while a ticket references '
  + 'it: settle the ticket and its mapped paths end with it.'

/**
 * One delegation's inline grant, as the model writes it.
 *
 * A separate shape from the service's `GrantRequest` only because the wire form
 * is snake_case-JSON while the service speaks camelCase.
 */
interface GrantParam {
  readonly description: string
  readonly areas: readonly { readonly path: string; readonly rights: readonly ('read' | 'write')[]; readonly as?: string }[]
}

/** Normalize a model-supplied grant into the service's request shape. */
function toGrantRequest(grants: readonly GrantParam[]): GrantRequest[] {
  return grants.map(grant => ({
    description: grant.description,
    areas: grant.areas.map(area => ({
      path: area.path,
      rights: [...area.rights],
      ...(area.as === undefined ? {} : { as: area.as }),
    })),
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
    lines.push(`- link_id=${link.id} · 对端 session id=${peer} · ${service.label(peer)}${link.label === undefined ? '' : ` · ${link.label}`}`)
  }
  lines.push('', 'delegate 时 to 填对端 session id（上面每行都有），或 link_id 填管道 id——两者任选其一。')
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
        enum: ['links', 'delegate', 'tickets', 'claim', 'progress', 'finish', 'fail', 'cancel', 'grants', 'read', 'ls', 'edit', 'download', 'upload'],
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
                  path: { type: 'string', required: true, description: 'A real directory or file in THIS session\'s world to map into the buffer.' },
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
      grant_id: { type: 'string', description: 'Legacy fallback for grants created before mappings existed. Prefer the buffer path (mappedName/sub/file) — it resolves the grant for you.' },
      path: { type: 'string', description: 'Buffer path: mappedName/sub/file — the name the delegating side declared with as. ls with no path lists every mapped root.' },
      offset: { type: 'number', description: 'read: 1-based line number to start from, for paging through a big text file.' },
      limit: { type: 'number', description: 'read: maximum lines to return.' },
      old_string: { type: 'string', description: 'edit: the exact text to replace; must already exist in the file (edit cannot create files — use upload for that), and must occur exactly once unless replace_all.' },
      new_string: { type: 'string', description: 'edit: the replacement text (may be empty to delete).' },
      replace_all: { type: 'boolean', description: 'edit: replace every occurrence of old_string. Default false.' },
      dest: { type: 'string', description: 'download: the full destination file path in THIS session\'s own world; omitted means the same relative path as path.' },
      src: { type: 'string', description: 'upload: the source file path in THIS session\'s own world.' },
      max_bytes: { type: 'number', description: 'download / upload: whole-file size ceiling in bytes. Files up to 32 MiB move inline; larger files transfer automatically in 16 MiB chunks with sha256 verification (default ceiling 1 GiB, hard cap 4 GiB).' },
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

/** 
 * Resolve the file actions' target: a buffer path (mappedName/sub/file) picks
 * its grant by name; an explicit grant_id keeps the area-relative path.
 */
function resolveTarget(service: BufferService, viewer: string, args: { grant_id?: string; path?: string }): { grantId: string; path: string } {
  const grantId = args.grant_id ?? ''
  const path = args.path ?? ''
  if (grantId !== '') return { grantId, path: path === '' ? '.' : path }
  if (path === '' || path === '/') throw new Error('需要 path（缓冲路径）或 grant_id')
  return service.resolveBufferPath(viewer, path)
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
    offset?: number
    limit?: number
    old_string?: string
    new_string?: string
    replace_all?: boolean
    src?: string
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

    // File actions address the buffer by mapped name (see ls) or by
    // grant_id + area-relative path for older grants without a mapping.
    // Reading and editing happen in the granter's world, zero copy; download
    // and upload are the explicit cross-world byte moves.
    case 'read': {
      const target = resolveTarget(service, viewer, args)
      const body = await service.readGranted(
        viewer,
        target.grantId,
        target.path,
        { offset: args.offset, limit: args.limit },
        signal,
      )
      return `${target.path}（授权 ${target.grantId}）：\n\n${capRead(body)}`
    }

    case 'edit': {
      const target = resolveTarget(service, viewer, args)
      if (args.old_string === undefined || args.new_string === undefined) throw new Error('缺少参数 old_string / new_string')
      const text = await service.editGranted(
        viewer, target.grantId, target.path,
        args.old_string, args.new_string, args.replace_all === true, signal,
      )
      return `${text}（授权 ${target.grantId}）`
    }

    case 'download': {
      const target = resolveTarget(service, viewer, args)
      const outcome = await service.download(viewer, target.grantId, target.path, args.dest, args.max_bytes, signal)
      return `已下载：${outcome.source} → ${outcome.destination}，${String(outcome.bytes)} 字节`
        + (outcome.chunks === undefined ? '' : `（分 ${String(outcome.chunks)} 块中继，sha256 已校验）`) + '。'
    }

    case 'upload': {
      const target = resolveTarget(service, viewer, args)
      if (args.src === undefined || args.src.trim().length === 0) throw new Error('缺少参数 src')
      const outcome = await service.upload(viewer, target.grantId, target.path, args.src, args.max_bytes, signal)
      return `已上传：${outcome.source} → ${outcome.destination}，${String(outcome.bytes)} 字节`
        + (outcome.chunks === undefined ? '' : `（分 ${String(outcome.chunks)} 块中继，sha256 已校验）`) + '。'
    }

    case 'ls': {
      if ((args.grant_id === undefined || args.grant_id === '') && (args.path === undefined || args.path === '')) {
        return service.bufferTree(viewer)
      }
      const target = resolveTarget(service, viewer, args)
      const listing = await service.listGranted(viewer, target.grantId, target.path, signal)
      return `目录 ${target.path}：\n${listing}`
    }

    default:
      throw new Error(`未知 action：${args.action}`)
  }
}

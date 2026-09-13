/**
 * The two messages the buffer delivers, and the bounded one-line accounts that
 * ride their transcript rows.
 *
 * These are the only text a model ever sees from this plugin, so they carry the
 * whole protocol: what is being asked, what it may touch, and — for the
 * requester — an explicit instruction to resume the work it interrupted. That
 * last line is the "return to the original task" guarantee made concrete: the
 * notice is not a status report, it is the message that reopens the turn.
 */

import { boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { BufferGrant, BufferTicket } from './protocol.js'

const STATE_LABEL: Record<Exclude<BufferTicket['state'], 'queued' | 'running'>, string> = {
  done: '已完成',
  failed: '已失败',
  timeout: '已超时',
  cancelled: '已被取消',
}

/** `读/写` for a rights list. */
function rightsLabel(rights: readonly string[]): string {
  const parts: string[] = []
  if (rights.includes('read')) parts.push('读')
  if (rights.includes('write')) parts.push('写')
  return parts.length > 0 ? parts.join('/') : '无'
}

/**
 * A readable handle for a session inside message text.
 *
 * The id fallback drops the `session-` prefix first: every id starts with it,
 * so a first-8 slice named every peer `session-`. What is left is the leading
 * part of the random component, which distinguishes peers.
 */
export function sessionLabel(sessionId: string, title: string | undefined, cwd: string | undefined): string {
  const name = title !== undefined && title.trim().length > 0
    ? title.trim()
    : sessionId.replace(/^session-/u, '').slice(0, 8) || sessionId.slice(0, 8)
  return cwd === undefined ? name : `${name}（${cwd}）`
}

/** Minutes a deadline is away, rounded up, for the worker's warning line. */
function minutesUntil(deadlineAt: number): number {
  return Math.max(1, Math.ceil((deadlineAt - Date.now()) / 60_000))
}

/**
 * The message a worker session receives when a request is delegated to it.
 *
 * @param ticket - the freshly created ticket.
 * @param from - the requester's display label.
 * @param grants - grants created or referenced by this ticket.
 * @returns the message text.
 */
export function renderRequestNotice(
  ticket: BufferTicket,
  from: string,
  grants: readonly BufferGrant[],
): string {
  const lines = [
    `【管道请求】会话「${from}」把一件事委派给你（ticket ${ticket.id}）。`,
    '',
    `主题：${ticket.subject}`,
  ]
  if (ticket.detail !== undefined && ticket.detail.trim().length > 0) {
    lines.push('', '说明：', ticket.detail.trim())
  }
  if (grants.length > 0) {
    lines.push('', '为完成它，对方把下面的位置映射进了你们的缓冲区——这就是你访问它们的方式（先 action="ls" 看结构）：')
    for (const grant of grants) {
      for (const area of grant.areas) {
        if (area.as !== undefined) lines.push(`- /${area.as} ← ${area.path}（${rightsLabel(area.rights)}）`)
      }
      if (grant.description.trim().length > 0) lines.push(`  用途说明：${grant.description.trim()}`)
    }
    lines.push(
      '缓冲路径以 / 为根，形如 /名字/子/文件；用 ls / read / edit / download / upload 操作它。',
      '注意方向：动手的是持有授权的一方——要取走文件用 download（配上 dest，文件会复制到你自己的世界）；'
      + '要改动对方的文件用 edit；把你自己世界的文件送过去用 upload（需要对方给了写权限）。',
    )
  }
  lines.push(
    '',
    '处理进度与结论必须回报，不要静默放着：',
    `- 认领：dshell_buffer action="claim" ticket_id="${ticket.id}"`,
    `- 进度：dshell_buffer action="progress" ticket_id="${ticket.id}" text="..."`,
    `- 成功：dshell_buffer action="finish" ticket_id="${ticket.id}" result="..."`,
    `- 失败：dshell_buffer action="fail" ticket_id="${ticket.id}" error="..."`,
    '',
    `若 ${String(minutesUntil(ticket.deadlineAt))} 分钟内没有任何结算，看门狗会把它判为超时并回报给请求方。`,
  )
  return lines.join('\n')
}

/**
 * The message the requester receives once a ticket settles — the wake that
 * reopens its turn. Delivered for every terminal state, including timeout and
 * cancellation, so the requester is never left waiting on something that
 * already ended.
 *
 * @param ticket - the settled ticket.
 * @param to - the worker's display label.
 * @returns the message text.
 */
export function renderSettlementNotice(ticket: BufferTicket, to: string): string {
  const state = ticket.state === 'queued' || ticket.state === 'running'
    ? '已结束'
    : STATE_LABEL[ticket.state]
  const lines = [
    `【管道回报】你委派给会话「${to}」的请求${state}（ticket ${ticket.id}）。`,
    '',
    `主题：${ticket.subject}`,
  ]
  if (ticket.result !== undefined && ticket.result.trim().length > 0) {
    lines.push('', '结果：', ticket.result.trim())
  }
  if (ticket.error !== undefined && ticket.error.trim().length > 0) {
    lines.push('', `原因：${ticket.error.trim()}`)
  }
  if (ticket.state === 'timeout') {
    lines.push('', '对方没有在期限内回报。你可以重新委派、改用其他会话，或自己继续。')
  }
  if (ticket.reports.length > 0) {
    const last = ticket.reports[ticket.reports.length - 1]
    lines.push('', `对方最后一条进度：${last?.text ?? ''}`)
  }
  lines.push('', '现在回到你原来的任务继续，不要重复已经完成的委派。')
  return lines.join('\n')
}

/** Bounded one-line account for a request notice's transcript row. */
export function requestSummary(ticket: BufferTicket, from: string): string {
  return boundContextSummary(`管道请求 · 来自 ${from} · ${ticket.subject}`)
}

/** Bounded one-line account for a settlement notice's transcript row. */
export function settlementSummary(ticket: BufferTicket, to: string): string {
  const state = ticket.state === 'queued' || ticket.state === 'running' ? '结束' : STATE_LABEL[ticket.state]
  return boundContextSummary(`管道回报 · ${to} · ${state} · ${ticket.subject}`)
}

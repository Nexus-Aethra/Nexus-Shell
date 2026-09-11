/**
 * The pipe panel: a frame-wide overlay (the `shell.overlay` seat) with the four
 * surfaces the feature has — the established pipes, the form that creates one,
 * the requests travelling over them, and the grants those requests carry.
 *
 * Only the user can create a pipe, and this panel is the only place that
 * happens, so the panel is where the authority lives: the agent-facing tool has
 * no linking action at all.
 *
 * The overlay layer is click-through, so the panel root opts back into pointer
 * events. It renders nothing while closed, which keeps the layer inert.
 */

import {
  createElement, useEffect, useState, useSyncExternalStore,
  type CSSProperties, type ReactElement,
} from 'react'
import type { BufferGrant, BufferLink, BufferTicket } from '../protocol.js'
import type { BufferClientService, SessionSeat } from './service.js'

const rootStyle: CSSProperties = {
  position: 'fixed',
  top: 56,
  right: 14,
  bottom: 24,
  width: 420,
  maxWidth: 'calc(100vw - 28px)',
  display: 'flex',
  flexDirection: 'column',
  pointerEvents: 'auto',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 14,
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: '0 18px 50px rgba(0,0,0,.34)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  overflow: 'hidden',
  zIndex: 20,
}
const headerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l4)',
}
const titleStyle: CSSProperties = { flex: '1 1 auto', fontWeight: 600, fontSize: 13 }
const bodyStyle: CSSProperties = { flex: '1 1 auto', overflowY: 'auto', padding: '12px 14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }
const sectionTitleStyle: CSSProperties = { fontSize: 12, fontWeight: 600, opacity: 0.6, marginBottom: 6 }
const cardStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const growStyle: CSSProperties = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const dimStyle: CSSProperties = { opacity: 0.62, fontSize: 12 }
const subStyle: CSSProperties = { ...dimStyle, whiteSpace: 'pre-wrap', lineHeight: '17px' }
const smallButtonStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'inherit',
  cursor: 'pointer', fontSize: 12, opacity: 0.82, padding: '2px 8px', borderRadius: 6, flex: '0 0 auto',
}
const primaryStyle: CSSProperties = {
  ...smallButtonStyle,
  border: 'none', background: 'var(--dsw-alias-brand-primary, #4f6bed)', color: '#fff',
  opacity: 1, padding: '6px 14px',
}
const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-3)',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, color: 'inherit',
  padding: '6px 8px', fontSize: 12, outline: 'none',
}
const errorStyle: CSSProperties = {
  margin: '0 14px 12px', padding: '7px 10px', borderRadius: 8, fontSize: 12,
  color: '#f87171', background: 'rgba(248,113,113,.1)',
}
const emptyStyle: CSSProperties = { ...dimStyle, padding: '2px 0' }

const STATE_LABEL: Record<BufferTicket['state'], string> = {
  queued: '排队中',
  running: '处理中',
  done: '已完成',
  failed: '已失败',
  timeout: '已超时',
  cancelled: '已取消',
}

/** Rights as a short Chinese label. */
function rightsLabel(rights: readonly string[]): string {
  const parts: string[] = []
  if (rights.includes('read')) parts.push('读')
  if (rights.includes('write')) parts.push('写')
  return parts.length > 0 ? parts.join('/') : '无'
}

/** Minutes until a deadline, floored at zero. */
function minutesLeft(deadlineAt: number): number {
  return Math.max(0, Math.ceil((deadlineAt - Date.now()) / 60_000))
}

/** The panel's props: the pipe state plus the session labels it renders peers by. */
export interface PipePanelProps {
  readonly buffer: BufferClientService
  /** Absent in a composition that mounts no sessions service; ids are shown raw. */
  readonly sessions?: SessionSeat | undefined
}

/** One label for a session id. */
function labelFor(seat: SessionSeat | undefined, id: string): string {
  const row = seat?.getSnapshot().byId[id]
  const title = row?.displayTitle ?? id.slice(0, 8)
  return row?.cwd === undefined ? title : `${title}（${row.cwd}）`
}

/** Stable stand-ins so a composition without a sessions service still has hooks. */
const noSessionsSnapshot = (): undefined => undefined
const noSessionsSubscribe = (): (() => void) => () => {}

/** The pipe panel component. */
export function PipePanel(props: PipePanelProps): ReactElement | null {
  const snapshot = useSyncExternalStore(props.buffer.subscribe, props.buffer.getSnapshot)
  const sessions = props.sessions
  const sessionState = useSyncExternalStore<ReturnType<SessionSeat['getSnapshot']> | undefined>(
    sessions === undefined ? noSessionsSubscribe : sessions.subscribe,
    sessions === undefined ? noSessionsSnapshot : sessions.getSnapshot,
  )
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [label, setLabel] = useState('')

  // Seed the two pickers once the list is known: the current session on the
  // left, the first other session on the right. Never overwrites a choice.
  useEffect(() => {
    if (sessionState === undefined) return
    if (left === '' && sessionState.current !== undefined) setLeft(String(sessionState.current))
    if (right === '') {
      const current = sessionState.current === undefined ? undefined : String(sessionState.current)
      const other = sessionState.ids.map(String).find(id => id !== current)
      if (other !== undefined) setRight(other)
    }
  }, [sessionState, left, right])

  if (!snapshot.open) return null

  const sessionIds = sessionState === undefined ? [] : sessionState.ids.map(String)
  const open = snapshot.tickets.filter(ticket => ticket.state === 'queued' || ticket.state === 'running')
  const settled = snapshot.tickets.filter(ticket => ticket.state !== 'queued' && ticket.state !== 'running').slice(-8).reverse()
  const liveGrants = snapshot.grants.filter(grant => grant.revokedAt === undefined)

  const create = (): void => {
    if (left === '' || right === '') return
    void props.buffer.link(left, right, label).then(() => { setLabel('') }).catch(() => {})
  }

  return createElement('div', { style: rootStyle, 'data-dshell-panel': 'buffer' },
    createElement('div', { style: headerStyle },
      createElement('span', { style: titleStyle }, '跨会话管道'),
      createElement('button', {
        style: smallButtonStyle,
        title: '关闭',
        onClick: () => { props.buffer.setOpen(false) },
      }, '关闭'),
    ),

    createElement('div', { style: bodyStyle },
      createElement('div', null,
        createElement('div', { style: sectionTitleStyle }, `已建立的管道 (${String(snapshot.links.length)})`),
        snapshot.links.length === 0
          ? createElement('div', { style: emptyStyle }, '还没有管道。建立之后，两侧的 agent 才能互相委派。')
          : createElement('div', { style: cardStyle }, snapshot.links.map(link => linkRow(link, props))),
      ),

      createElement('div', null,
        createElement('div', { style: sectionTitleStyle }, '建立新管道'),
        createElement('div', { style: cardStyle },
          createElement('div', { style: rowStyle },
            sessionSelect(left, setLeft, sessionIds, labelFor.bind(null, sessions)),
            createElement('span', { style: dimStyle }, '↔'),
            sessionSelect(right, setRight, sessionIds, labelFor.bind(null, sessions)),
          ),
          createElement('input', {
            style: fieldStyle,
            placeholder: '标签（可选），例如「部署机」',
            value: label,
            onChange: (event: { target: { value: string } }) => { setLabel(event.target.value) },
          }),
          createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
            createElement('button', {
              style: primaryStyle,
              disabled: left === '' || right === '' || left === right,
              onClick: create,
            }, '建立管道'),
          ),
          createElement('div', { style: dimStyle }, '只有你能建立管道；agent 没有建连的工具。'),
        ),
      ),

      createElement('div', null,
        createElement('div', { style: sectionTitleStyle }, `进行中的请求 (${String(open.length)})`),
        open.length === 0
          ? createElement('div', { style: emptyStyle }, '没有未结算的请求。')
          : createElement('div', { style: cardStyle }, open.map(ticket => ticketRow(ticket, props, labelFor.bind(null, sessions), true))),
      ),

      createElement('div', null,
        createElement('div', { style: sectionTitleStyle }, `生效中的授权 (${String(liveGrants.length)})`),
        liveGrants.length === 0
          ? createElement('div', { style: emptyStyle }, '没有生效中的授权。任务结算时授权会自动回收。')
          : createElement('div', { style: cardStyle }, liveGrants.map(grant => grantRow(grant, props, labelFor.bind(null, sessions)))),
      ),

      settled.length === 0 ? null : createElement('div', null,
        createElement('div', { style: sectionTitleStyle }, '最近结束'),
        createElement('div', { style: cardStyle }, settled.map(ticket => ticketRow(ticket, props, labelFor.bind(null, sessions), false))),
      ),
    ),

    snapshot.error === undefined ? null : createElement('div', {
      style: errorStyle,
      onClick: () => { props.buffer.clearError() },
      title: '点击清除',
    }, snapshot.error),
  )
}

/** One `<select>` of session ids. */
function sessionSelect(
  value: string,
  onChange: (next: string) => void,
  ids: readonly string[],
  label: (id: string) => string,
): ReactElement {
  return createElement('select', {
    style: fieldStyle,
    value,
    onChange: (event: { target: { value: string } }) => { onChange(event.target.value) },
  }, ids.map(id => createElement('option', { key: id, value: id }, label(id))))
}

/** One established pipe with its release button. */
function linkRow(link: BufferLink, props: PipePanelProps): ReactElement {
  return createElement('div', { key: link.id, style: rowStyle },
    createElement('span', { style: growStyle, title: `${link.a} ↔ ${link.b}` },
      `${labelFor(props.sessions, link.a)} ↔ ${labelFor(props.sessions, link.b)}${link.label === undefined ? '' : ` · ${link.label}`}`),
    createElement('button', {
      style: smallButtonStyle,
      onClick: () => { void props.buffer.unlink(link.id).catch(() => {}) },
    }, '解除'),
  )
}

/** One ticket row; `cancellable` adds the withdraw button. */
function ticketRow(
  ticket: BufferTicket,
  props: PipePanelProps,
  label: (id: string) => string,
  cancellable: boolean,
): ReactElement {
  const tail = ticket.result ?? ticket.error ?? ticket.reports[ticket.reports.length - 1]?.text
  const unsettled = ticket.state === 'queued' || ticket.state === 'running'
  return createElement('div', { key: ticket.id, style: { ...rowStyle, alignItems: 'flex-start' } },
    createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
      createElement('span', { style: growStyle },
        `${STATE_LABEL[ticket.state]} · ${label(ticket.from)} → ${label(ticket.to)} · ${ticket.subject}`),
      unsettled
        ? createElement('span', { style: dimStyle }, `剩约 ${String(minutesLeft(ticket.deadlineAt))} 分钟 · ${ticket.id}`)
        : createElement('span', { style: dimStyle }, ticket.id),
      tail === undefined ? null : createElement('span', { style: subStyle }, tail),
    ),
    cancellable
      ? createElement('button', {
        style: smallButtonStyle,
        onClick: () => { void props.buffer.cancel(ticket.id).catch(() => {}) },
      }, '取消')
      : null,
  )
}

/** One live grant with its revoke button. */
function grantRow(grant: BufferGrant, props: PipePanelProps, label: (id: string) => string): ReactElement {
  return createElement('div', { key: grant.id, style: { ...rowStyle, alignItems: 'flex-start' } },
    createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
      createElement('span', { style: growStyle }, `${label(grant.from)} → ${label(grant.to)} · 剩余引用 ${String(grant.count)}`),
      grant.description.trim().length === 0 ? null : createElement('span', { style: subStyle }, grant.description),
      ...grant.areas.map((area, index) => createElement('span', {
        key: `${grant.id}:${String(index)}`,
        style: dimStyle,
      }, `${area.path}（${rightsLabel(area.rights)}）`)),
    ),
    createElement('button', {
      style: smallButtonStyle,
      onClick: () => { void props.buffer.revoke(grant.id).catch(() => {}) },
    }, '回收'),
  )
}

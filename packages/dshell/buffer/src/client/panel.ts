/**
 * The pipe dialog: a proper centered modal for the whole pipe feature, with
 * two views over the same data.
 *
 * - 列表 — every established pipe as a row; clicking one opens its detail
 *   (the requests that travelled it and the grants they carry), and a form
 *   creates a new pipe.
 * - 图 — sessions as draggable nodes and pipes as edges, drawn with React
 *   Flow (`pipe-graph`); dragging from one node to another creates a pipe,
 *   and a selected edge offers detail and release.
 *
 * The panel keeps its old seat (`shell.overlay`) and its `open` flag in the
 * service; only the shape changed. Only the user can create a pipe, and this
 * dialog is the only place that happens, so the authority note stays.
 */

import {
  createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactElement,
} from 'react'
import type { BufferGrant, BufferTicket, BufferUserEntry } from '../protocol.js'
import type { BufferClientService, SessionSeat } from './service.js'
import { PipeGraph, type GraphSession } from './pipe-graph.js'

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 40,
  background: 'rgba(0,0,0,.44)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  pointerEvents: 'auto',
}
const dialogStyle: CSSProperties = {
  width: 'min(920px, 92vw)',
  height: 'min(620px, 86vh)',
  display: 'flex', flexDirection: 'column',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 14,
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: '0 18px 50px rgba(0,0,0,.34)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  overflow: 'hidden',
}
const headerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l4)',
  flex: '0 0 auto',
}
const titleStyle: CSSProperties = { fontWeight: 600, fontSize: 14 }
const headerDimStyle: CSSProperties = { fontSize: 12, opacity: 0.55, flex: '1 1 auto' }
const tabRowStyle: CSSProperties = { display: 'flex', gap: 2, background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 8, padding: 2 }
const tabStyle: (active: boolean) => CSSProperties = active => ({
  border: 'none', background: active ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
  color: 'var(--dsw-alias-label-primary)', opacity: active ? 1 : 0.62,
  cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 6,
})
const smallButtonStyle: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'inherit',
  cursor: 'pointer', fontSize: 12, opacity: 0.82, padding: '3px 10px', borderRadius: 6, flex: '0 0 auto',
}
const primaryStyle: CSSProperties = {
  ...smallButtonStyle,
  border: 'none', background: 'var(--dsw-static-deepseek-500, #4f6bed)', color: '#fff',
  opacity: 1, padding: '5px 14px',
}
const bodyStyle: CSSProperties = { flex: '1 1 auto', overflowY: 'auto', padding: '14px 16px 18px' }
const sectionTitleStyle: CSSProperties = { fontSize: 12, fontWeight: 600, opacity: 0.6, marginBottom: 6, marginTop: 14 }
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
const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-3)',
  border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, color: 'inherit',
  padding: '6px 8px', fontSize: 12, outline: 'none', colorScheme: 'dark',
}
const errorStyle: CSSProperties = {
  margin: '0 16px 12px', padding: '7px 10px', borderRadius: 8, fontSize: 12,
  color: '#f87171', background: 'rgba(248,113,113,.1)',
  flex: '0 0 auto',
}
const emptyStyle: CSSProperties = { ...dimStyle, padding: '2px 0' }
const clickableRowStyle: CSSProperties = {
  ...rowStyle, cursor: 'pointer', borderRadius: 6, padding: '2px 4px', margin: '0 -4px',
}
const backRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }

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

/** One label for a session id (title, without the cwd suffix). */
function shortLabel(seat: SessionSeat | undefined, id: string): string {
  return seat?.getSnapshot().byId[id]?.displayTitle ?? id.slice(0, 8)
}

/** One label with the cwd, the way list rows render peers. */
function labelFor(seat: SessionSeat | undefined, id: string): string {
  const row = seat?.getSnapshot().byId[id]
  const title = row?.displayTitle ?? id.slice(0, 8)
  return row?.cwd === undefined ? title : `${title}（${row.cwd}）`
}

/** Stable stand-ins so a composition without a sessions service still has hooks. */
const noSessionsSnapshot = (): undefined => undefined
const noSessionsSubscribe = (): (() => void) => () => {}

type View = 'list' | 'graph'

/** The pipe dialog component. */
export function PipePanel(props: PipePanelProps): ReactElement | null {
  const snapshot = useSyncExternalStore(props.buffer.subscribe, props.buffer.getSnapshot)
  const sessions = props.sessions
  const sessionState = useSyncExternalStore<ReturnType<SessionSeat['getSnapshot']> | undefined>(
    sessions === undefined ? noSessionsSubscribe : sessions.subscribe,
    sessions === undefined ? noSessionsSnapshot : sessions.getSnapshot,
  )
  const [view, setView] = useState<View>('list')
  const [detailLink, setDetailLink] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)

  // Every hook sits above the early return: this seat renders null while
  // closed and content once opened, and a hook that first runs on the open
  // render would change the hook count between renders — the exact mistake
  // that once took the whole status card down (React #310).
  const graphSessions: GraphSession[] = useMemo(() => {
    if (sessionState === undefined) {
      // Without a sessions seat the nodes are the ids the links name.
      const ids = [...new Set(snapshot.links.flatMap(link => [link.a, link.b]))]
      return ids.map(id => ({ id, label: id.slice(0, 8), sub: undefined, active: false, current: false }))
    }
    const current = sessionState.current === undefined ? undefined : String(sessionState.current)
    const ids = [...new Set([...sessionState.ids.map(String), ...snapshot.links.flatMap(link => [link.a, link.b])])]
    return ids.map(id => {
      const row = sessionState.byId[id]
      return {
        id,
        label: row?.displayTitle ?? id.slice(0, 8),
        sub: row?.cwd,
        active: row?.running === true,
        current: id === current,
      }
    })
  }, [sessionState, snapshot.links])

  if (!snapshot.open) return null

  const close = (): void => { props.buffer.setOpen(false) }
  const openDetail = (linkId: string): void => { setDetailLink(linkId); setView('list') }

  return createElement('div', {
    style: backdropStyle,
    'data-dshell-panel': 'buffer',
    onClick: (event: { target: unknown; currentTarget: unknown }) => {
      if (event.target === event.currentTarget) close()
    },
  },
    createElement('div', { style: dialogStyle, onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation() } },
      createElement('div', { style: headerStyle },
        createElement('span', { style: titleStyle }, '跨会话管道'),
        createElement('span', { style: headerDimStyle },
          `${String(snapshot.links.length)} 条管道 · ${String(snapshot.tickets.filter(t => t.state === 'queued' || t.state === 'running').length)} 个进行中请求`),
        createElement('div', { style: tabRowStyle },
          createElement('button', { style: tabStyle(view === 'list'), onClick: () => { setView('list') } }, '列表'),
          createElement('button', { style: tabStyle(view === 'graph'), onClick: () => { setView('graph') } }, '图'),
        ),
        createElement('button', { style: smallButtonStyle, title: '关闭', onClick: close }, '关闭'),
      ),
      view === 'graph'
        ? createElement('div', { style: { flex: '1 1 auto', minHeight: 0, position: 'relative' } },
          createElement(PipeGraph, {
            sessions: graphSessions,
            links: snapshot.links,
            tickets: snapshot.tickets,
            onConnect: (a, b) => {
              if (snapshot.links.some(link => (link.a === a && link.b === b) || (link.a === b && link.b === a))) return
              void props.buffer.link(a, b).catch(() => {})
            },
            onUnlink: linkId => { void props.buffer.unlink(linkId).catch(() => {}) },
            onOpenDetail: openDetail,
          }),
        )
        : detailLink === undefined
          ? createElement(ListPane, {
            snapshot, sessions, sessionState,
            creating, setCreating,
            onOpenDetail: openDetail,
            buffer: props.buffer,
          })
          : createElement(DetailPane, {
            snapshot, sessions,
            linkId: detailLink,
            onBack: () => { setDetailLink(undefined) },
            buffer: props.buffer,
          }),
      snapshot.error === undefined ? null : createElement('div', {
        style: errorStyle,
        onClick: () => { props.buffer.clearError() },
        title: '点击清除',
      }, snapshot.error),
    ),
  )
}

/** Props shared by the two list-side panes. */
interface ListSideProps {
  readonly snapshot: ReturnType<BufferClientService['getSnapshot']>
  readonly buffer: BufferClientService
  readonly sessions?: SessionSeat | undefined
}

/** The list view: established pipes (click → detail), the create form. */
function ListPane(props: ListSideProps & {
  readonly sessionState: ReturnType<SessionSeat['getSnapshot']> | undefined
  readonly creating: boolean
  readonly setCreating: (next: boolean) => void
  readonly onOpenDetail: (linkId: string) => void
}): ReactElement {
  const { snapshot, sessions, sessionState } = props
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [label, setLabel] = useState('')
  const seat = sessions
  const sessionIds = sessionState === undefined ? [] : sessionState.ids.map(String)

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

  const create = (): void => {
    if (left === '' || right === '') return
    void props.buffer.link(left, right, label).then(() => {
      setLabel('')
      props.setCreating(false)
    }).catch(() => {})
  }

  return createElement('div', { style: bodyStyle },
    createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 } },
      createElement('div', { style: { ...sectionTitleStyle, marginTop: 0, marginBottom: 0 } },
        `已建立的管道 (${String(snapshot.links.length)})`),
      createElement('button', {
        style: props.creating ? smallButtonStyle : primaryStyle,
        onClick: () => { props.setCreating(!props.creating) },
      }, props.creating ? '收起' : '+ 建立管道'),
    ),
    props.creating ? createElement('div', { style: cardStyle },
      createElement('div', { style: rowStyle },
        sessionSelect(left, setLeft, sessionIds, labelFor.bind(null, seat)),
        createElement('span', { style: dimStyle }, '↔'),
        sessionSelect(right, setRight, sessionIds, labelFor.bind(null, seat)),
      ),
      createElement('input', {
        style: fieldStyle,
        placeholder: '标签（可选），例如「部署机」',
        value: label,
        onChange: (event: { target: { value: string } }) => { setLabel(event.target.value) },
      }),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        createElement('div', { style: dimStyle }, '只有你能建立管道；agent 没有建连的工具。'),
        createElement('button', {
          style: primaryStyle,
          disabled: left === '' || right === '' || left === right,
          onClick: create,
        }, '建立管道'),
      ),
    ) : null,
    snapshot.links.length === 0
      ? createElement('div', { style: { ...emptyStyle, marginTop: 12 } },
        props.creating ? '' : '还没有管道。建立之后，两侧的 agent 才能互相委派。')
      : createElement('div', { style: cardStyle },
        snapshot.links.map(link => {
          const open = openCountOf(snapshot.tickets, link.id)
          return createElement('div', {
            key: link.id,
            style: clickableRowStyle,
            title: '点击查看这条管道的请求与授权',
            onClick: () => { props.onOpenDetail(link.id) },
          },
            createElement('span', { style: { ...growStyle, fontWeight: 500 } },
              `${labelFor(seat, link.a)} ↔ ${labelFor(seat, link.b)}${link.label === undefined ? '' : ` · ${link.label}`}`),
            open > 0 ? createElement('span', { style: dimStyle }, `${String(open)} 个进行中`) : null,
            createElement('button', {
              style: smallButtonStyle,
              onClick: (event: { stopPropagation: () => void }) => {
                event.stopPropagation()
                void props.buffer.unlink(link.id).catch(() => {})
              },
            }, '解除'),
          )
        })),
  )
}

/** The detail view for one pipe: its tickets, live grants between the pair. */
function DetailPane(props: ListSideProps & {
  readonly linkId: string
  readonly onBack: () => void
}): ReactElement {
  const { snapshot, sessions } = props
  const link = snapshot.links.find(candidate => candidate.id === props.linkId)
  if (link === undefined) {
    return createElement('div', { style: bodyStyle },
      createElement('div', { style: backRowStyle },
        createElement('button', { style: smallButtonStyle, onClick: props.onBack }, '← 返回')),
      createElement('div', { style: emptyStyle }, '这条管道已被解除。'))
  }
  const seats = new Set([link.a, link.b])
  const tickets = snapshot.tickets.filter(ticket => ticket.linkId === link.id)
  const open = tickets.filter(ticket => ticket.state === 'queued' || ticket.state === 'running')
  const settled = tickets.filter(ticket => ticket.state !== 'queued' && ticket.state !== 'running').reverse()
  const grants = snapshot.grants.filter(grant => grant.revokedAt === undefined && (seats.has(grant.from) && seats.has(grant.to)))

  return createElement('div', { style: bodyStyle },
    createElement('div', { style: backRowStyle },
      createElement('button', { style: smallButtonStyle, onClick: props.onBack }, '← 返回'),
      createElement('span', { style: { fontWeight: 600 } },
        `${labelFor(sessions, link.a)} ↔ ${labelFor(sessions, link.b)}`),
      link.label === undefined ? null : createElement('span', { style: dimStyle }, link.label),
      createElement('span', { style: { flex: '1 1 auto' } }),
      createElement('button', {
        style: smallButtonStyle,
        onClick: () => { void props.buffer.unlink(link.id).catch(() => {}) },
      }, '解除管道'),
    ),
    createElement(BufferBrowser, { buffer: props.buffer, linkId: link.id, sessions }),
    createElement('div', { style: sectionTitleStyle }, `进行中的请求 (${String(open.length)})`),
    open.length === 0
      ? createElement('div', { style: emptyStyle }, '没有进行中的请求。')
      : createElement('div', { style: cardStyle }, open.map(ticket => ticketRow(ticket, props.buffer, sessions, true))),
    settled.length === 0 ? null : createElement('div', null,
      createElement('div', { style: sectionTitleStyle }, `已结束 (${String(settled.length)})`),
      createElement('div', { style: cardStyle }, settled.map(ticket => ticketRow(ticket, props.buffer, sessions, false)))),
    createElement('div', { style: sectionTitleStyle }, `生效中的授权 (${String(grants.length)})`),
    grants.length === 0
      ? createElement('div', { style: emptyStyle }, '没有生效中的授权。任务结算时授权会自动回收。')
      : createElement('div', { style: cardStyle }, grants.map(grant => grantRow(grant, sessions))),
  )
}

/** Count a link's unsettled tickets. */
function openCountOf(tickets: readonly BufferTicket[], linkId: string): number {
  return tickets.filter(ticket => ticket.linkId === linkId
    && (ticket.state === 'queued' || ticket.state === 'running')).length
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

/** One ticket row; `cancellable` adds the withdraw button. */
function ticketRow(
  ticket: BufferTicket,
  buffer: BufferClientService,
  sessions: SessionSeat | undefined,
  cancellable: boolean,
): ReactElement {
  const tail = ticket.result ?? ticket.error ?? ticket.reports[ticket.reports.length - 1]?.text
  const unsettled = ticket.state === 'queued' || ticket.state === 'running'
  return createElement('div', { key: ticket.id, style: { ...rowStyle, alignItems: 'flex-start' } },
    createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
      createElement('span', { style: growStyle },
        `${STATE_LABEL[ticket.state]} · ${shortLabel(sessions, ticket.from)} → ${shortLabel(sessions, ticket.to)} · ${ticket.subject}`),
      unsettled
        ? createElement('span', { style: dimStyle }, `剩约 ${String(minutesLeft(ticket.deadlineAt))} 分钟 · ${ticket.id}`)
        : createElement('span', { style: dimStyle }, ticket.id),
      tail === undefined ? null : createElement('span', { style: subStyle }, tail),
    ),
    cancellable
      ? createElement('button', {
        style: smallButtonStyle,
        onClick: () => { void buffer.cancel(ticket.id).catch(() => {}) },
      }, '取消')
      : null,
  )
}

/** One live grant with its revoke button. */
function grantRow(grant: BufferGrant, sessions: SessionSeat | undefined): ReactElement {
  return createElement('div', { key: grant.id, style: { ...rowStyle, alignItems: 'flex-start' } },
    createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
      createElement('span', { style: growStyle }, `${shortLabel(sessions, grant.from)} → ${shortLabel(sessions, grant.to)} · 剩余引用 ${String(grant.count)}`),
      grant.description.trim().length === 0 ? null : createElement('span', { style: subStyle }, grant.description),
      ...grant.areas.map((area, index) => createElement('span', {
        key: `${grant.id}:${String(index)}`,
        style: dimStyle,
      }, area.as === undefined
        ? `${area.path}（${rightsLabel(area.rights)}，未映射）`
        : `/${area.as}/ ← ${area.path}（${rightsLabel(area.rights)}）`)),
    ),
  )
}

// --------------------------------------------------------------------------
// The buffer browser: the pipe detail page's view over the namespace.

/** Where in the namespace the browser currently stands. */
interface BrowserLocation {
  /** The mapped root descended into; absent means standing at `/`. */
  readonly root: BufferUserEntry | undefined
  /** Directory below that root, area-relative; empty means the root itself. */
  readonly rel: string
  readonly entries: readonly BufferUserEntry[]
  readonly truncated: boolean
  /** The real path the server listed, shown as provenance once inside. */
  readonly realPath: string | undefined
}

const browserHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }
const crumbStyle: CSSProperties = {
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  fontSize: 12, padding: '2px 4px', borderRadius: 6, opacity: 0.85,
}
const browserRowStyle: CSSProperties = {
  ...clickableRowStyle, padding: '3px 6px', fontFamily: 'ui-monospace, monospace', fontSize: 12,
}
const glyphStyle: CSSProperties = { flex: '0 0 auto', opacity: 0.55, width: 12 }
const sizeStyle: CSSProperties = { ...dimStyle, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }

/**
 * Walk the pipe's buffer namespace: at `/` the mapped roots (with rights and
 * origin), below one root its directories, as the same view the two agents'
 * `ls` answers from. Read-only: the browser is for looking, every mutation
 * stays a tool call.
 */
function BufferBrowser(props: {
  readonly buffer: BufferClientService
  readonly linkId: string
  readonly sessions?: SessionSeat | undefined
}): ReactElement {
  const [location, setLocation] = useState<BrowserLocation | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  // Races one-liner: only the newest request may land, so a slow deep listing
  // cannot overwrite the view the user has since navigated away from.
  const seq = useRef(0)

  useEffect(() => {
    // A new pipe's detail starts at `/`; the old view must not leak through.
    const mine = ++seq.current
    setLocation(undefined)
    setError(undefined)
    setLoading(true)
    props.buffer.listBuffer(props.linkId).then(listing => {
      if (seq.current !== mine) return
      setLocation({ root: undefined, rel: '', entries: listing.entries, truncated: listing.truncated, realPath: '/' })
    }).catch(reason => {
      if (seq.current !== mine) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (seq.current === mine) setLoading(false)
    })
  }, [props.buffer, props.linkId])

  /** List one directory below a mapped root. */
  const open = (root: BufferUserEntry, rel: string): void => {
    const mine = ++seq.current
    setLoading(true)
    setError(undefined)
    props.buffer.listBuffer(props.linkId, root.grantId, rel === '' ? '.' : rel).then(listing => {
      if (seq.current !== mine) return
      setLocation({ root, rel, entries: listing.entries, truncated: listing.truncated, realPath: listing.path })
    }).catch(reason => {
      if (seq.current !== mine) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (seq.current === mine) setLoading(false)
    })
  }

  const back = (): void => {
    const current = location
    if (current === undefined || current.root === undefined) return
    if (current.rel === '') {
      const mine = ++seq.current
      setLoading(true)
      props.buffer.listBuffer(props.linkId).then(listing => {
        if (seq.current !== mine) return
        setLocation({ root: undefined, rel: '', entries: listing.entries, truncated: listing.truncated, realPath: '/' })
      }).catch(() => {}).finally(() => { if (seq.current === mine) setLoading(false) })
      return
    }
    open(current.root, current.rel.split('/').slice(0, -1).join(''))
  }

  const refresh = (): void => {
    const current = location
    if (current === undefined) return
    if (current.root === undefined) {
      const mine = ++seq.current
      setLoading(true)
      props.buffer.listBuffer(props.linkId).then(listing => {
        if (seq.current !== mine) return
        setLocation({ root: undefined, rel: '', entries: listing.entries, truncated: listing.truncated, realPath: '/' })
      }).catch(reason => {
        if (seq.current !== mine) return
        setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => { if (seq.current === mine) setLoading(false) })
    } else {
      open(current.root, current.rel)
    }
  }

  const root = location?.root
  const relSegments = location === undefined || location.rel === '' ? [] : location.rel.split('/')

  return createElement('div', null,
    createElement('div', { style: sectionTitleStyle }, `缓冲区 (${root === undefined ? '/' : `/${root.name}/${relSegments.length === 0 ? '' : String(location?.rel)}`})`),
    createElement('div', { style: cardStyle },
      createElement('div', { style: browserHeaderStyle },
        root === undefined ? null : createElement('span', { style: dimStyle }, String(location?.realPath)),
        createElement('span', { style: { flex: '1 1 auto' } }),
        createElement('button', { style: smallButtonStyle, onClick: refresh, disabled: loading }, '⟳ 刷新'),
      ),
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, marginBottom: 4 } },
        createElement('button', { style: crumbStyle, onClick: back }, '/'),
        root === undefined ? null : createElement('button', {
          style: crumbStyle, onClick: () => { if (root.grantId !== undefined) open(root, '') },
        }, `/${root.name}`),
        ...relSegments.map((segment, index) => {
          const target = relSegments.slice(0, index + 1).join('')
          return createElement('button', {
            key: target,
            style: crumbStyle,
            onClick: () => { if (root?.grantId !== undefined) open(root, target) },
          }, `/${segment}`)
        }),
      ),
      error === undefined ? null : createElement('div', { style: { ...dimStyle, color: '#f87171' } }, error),
      loading && location === undefined ? createElement('div', { style: emptyStyle }, '读取中…') : null,
      !loading && location === undefined && error === undefined
        ? createElement('div', { style: emptyStyle }, '缓冲区为空。委派任务时带上带 as 名字的授权，映射目录会出现在这里。')
        : null,
      location === undefined ? null : location.entries.length === 0
        ? createElement('div', { style: emptyStyle }, '（空目录）')
        : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
          ...location.entries.map(entry => {
            const isRoot = entry.grantId !== undefined
            const childRel = location.rel === '' ? entry.name : `${location.rel}/${entry.name}`
            return createElement('div', {
              key: `${entry.grantId ?? ''}:${entry.name}`,
              style: entry.kind === 'directory' || isRoot ? browserRowStyle : rowStyle,
              title: isRoot ? `${entry.origin}（${rightsLabel(entry.rights ?? [])}）` : entry.kind === 'directory' ? '进入' : undefined,
              onClick: entry.kind === 'directory' || isRoot
                ? () => { if (isRoot) open(entry, ''); else if (root !== undefined && root.grantId !== undefined) open(root, childRel) }
                : undefined,
            },
              createElement('span', { style: glyphStyle }, isRoot || entry.kind === 'directory' ? 'd' : entry.kind === 'file' ? '-' : '?'),
              createElement('span', { style: growStyle }, isRoot ? `/${entry.name}/` : entry.name),
              isRoot
                ? createElement('span', { style: dimStyle },
                  `← ${entry.origin} · ${rightsLabel(entry.rights ?? [])} · ${shortLabel(props.sessions, entry.from ?? '')} → ${shortLabel(props.sessions, entry.to ?? '')}`)
                : entry.size === undefined ? null : createElement('span', { style: sizeStyle }, fmtSize(entry.size)),
            )
          }),
          location.truncated ? createElement('div', { style: emptyStyle }, '（条目过多，已截断到前 1000 项）') : null,
        ),
    ),
  )
}

/** One compact byte count for the browser's file rows. */
function fmtSize(size: number): string {
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

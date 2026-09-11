/**
 * The status card.
 *
 * dsh docks its `TodoPanel` at the bottom of the conversation, where it lies
 * across the transcript and covers the last lines of output. For a terminal
 * that is the wrong place: the reader is watching the tail of the stream. This
 * card floats in the top-right corner instead, out of the reading flow, and the
 * docked panel is suppressed while this view is mounted.
 *
 * It is an *integrated status list*, not a task panel and not a terminal
 * window: one row per thing worth knowing about the session's work — the plan
 * and the phase it is in, the AI's own terminal, the subagents it spawned, the
 * open sessions, a broken terminal link. Collapsed it is one narrow line: the
 * newest thing that is happening, so a glance is enough. Expanded it is those
 * rows, and a row's detail (the task list, the live terminal, the children)
 * opens only when that row is clicked.
 *
 * Everything here is a *projection* of state owned elsewhere — the fold's
 * tasks, the bridge's agent stream, dsh's session list and subagent catalog —
 * so the card never becomes a second source of truth.
 */

import { Component, createElement, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SPAN_FONT } from './block-terminal.js'
import { createAgentTerminal, AGENT_PANEL_HEIGHT, type AgentTerminalView } from './agent-terminal.js'
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { Theme } from './theme.js'

/** One item of the session's task list, as the `todo/write` event carries it. */
export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
}

/**
 * The cross-session pipe, as `dshell-buffer` publishes it.
 *
 * Structural on purpose: this package must not depend on the buffer plugin's
 * bundle, and a composition without it passes nothing — the pipe rows then
 * simply never appear.
 */
export interface PipeSeat {
  getSnapshot(): {
    readonly links: readonly { readonly id: string; readonly a: string; readonly b: string }[]
    readonly tickets: readonly PipeTicket[]
  }
  subscribe(listener: () => void): () => void
  /** Re-read the committed pipe state from the host. */
  load(): Promise<void>
  /** Withdraw an outstanding ticket. */
  cancel(ticketId: string): Promise<void>
  /** Open the pipe panel (the frame-wide overlay). */
  setOpen(open: boolean): void
}

/** One deferred request, reduced to what a status row shows. */
export interface PipeTicket {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'timeout' | 'cancelled'
  readonly createdAt: number
  readonly deadlineAt: number
  readonly reports: readonly { readonly time: number; readonly text: string }[]
}

/** The card renders without a pipe in a composition that has no buffer. */
const EMPTY_PIPE_STATE = { links: [], tickets: [] } as const
const getEmptyPipeState = (): typeof EMPTY_PIPE_STATE => EMPTY_PIPE_STATE
const NO_PIPE_SUBSCRIBE = (): (() => void) => () => {}

/** Ticket states that are still running; everything else is settled. */
const SETTLED: readonly PipeTicket['state'][] = ['done', 'failed', 'timeout', 'cancelled']

/** How a ticket's state reads in a row. */
const STATE_LABEL: Record<PipeTicket['state'], string> = {
  queued: '待领取',
  running: '对方处理中',
  done: '已完成',
  failed: '失败',
  timeout: '已超时',
  cancelled: '已撤回',
}

/** How long a ticket has left before the host's watchdog settles it. */
function remaining(deadlineAt: number): string {
  const left = deadlineAt - Date.now()
  if (!Number.isFinite(left)) return ''
  if (left <= 0) return '已到期限'
  const minutes = Math.floor(left / 60_000)
  return minutes >= 1 ? `剩 ${String(minutes)} 分钟` : `剩 ${String(Math.max(1, Math.round(left / 1000)))} 秒`
}

/** How often the card re-reads the pipe while this session has one. */
const PIPE_POLL_MS = 5000

/**
 * Vertical space the collapsed card occupies, reserved at the top of the
 * column so the transcript never starts underneath it.
 */
export const STATUS_CARD_RESERVE = 46

/** Suppress the docked panel for as long as the block view owns the surface. */
export function setTodoPanelSuppressed(suppressed: boolean): void {
  if (typeof document === 'undefined') return
  if (suppressed) document.body.dataset.dshellTodoFloating = ''
  else delete document.body.dataset.dshellTodoFloating
}

/** Injected once per page: the docked panel yields to the floating card. */
export function injectTodoCardCss(): void {
  if (typeof document === 'undefined' || document.getElementById('dshell-todo-card-css') !== null) return
  const style = document.createElement('style')
  style.id = 'dshell-todo-card-css'
  style.textContent = 'body[data-dshell-todo-floating] [data-testid="todo-panel"]{display:none !important;}'
  document.head.append(style)
}

/** One row of the card: a status line, and the detail behind it. */
interface StatusRow {
  readonly id: string
  /** Leading glyph, in the row's own column. */
  readonly glyph: string
  /** What this row is about (`任务`, `AI 终端`, …). */
  readonly label: string
  /** The one-line value, already formatted. */
  readonly value: string
  /** Accent when the row reports live work. */
  readonly active: boolean
  /** Detail body, rendered only while the row is open. */
  readonly detail?: ReactNode
}

/** The live agent terminal, at a fixed grid, re-rendered from the stream. */
function AgentTerminalPanel(props: { pty: PtyStreamService; sessionId: string; theme: Theme }): ReactElement {
  const { pty, sessionId, theme } = props
  const state = useSyncExternalStore(pty.agent.subscribe, pty.agent.getSnapshot)
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<AgentTerminalView | undefined>(undefined)
  useEffect(() => {
    const element = host.current
    if (element === null) return
    const terminal = createAgentTerminal(element, theme, cols => { pty.resizeAgent(cols) })
    view.current = terminal
    terminal.update(pty.agentText(sessionId))
    const observer = new ResizeObserver(() => { terminal.fit() })
    observer.observe(element)
    return () => {
      observer.disconnect()
      terminal.dispose()
      view.current = undefined
    }
  }, [pty, sessionId, theme])
  // The stream's version is the render key: the text itself is read on demand,
  // so a long shell output never rides through React's state.
  useEffect(() => {
    view.current?.update(pty.agentText(sessionId))
  }, [pty, sessionId, state.version])
  return createElement('div', {
    ref: host,
    'data-dshell-agent-terminal': '',
    style: {
      height: `${String(AGENT_PANEL_HEIGHT + 10)}px`,
      marginTop: '2px',
      padding: '4px 2px 2px 6px',
      borderRadius: '6px',
      background: theme.inputBar,
      border: `1px solid ${theme.border}`,
      overflow: 'hidden',
    },
  })
}

/** One clickable row: glyph, label, value, and the detail it opens. */
function Row(props: {
  row: StatusRow
  open: boolean
  theme: Theme
  onToggle: () => void
  onClose: () => void
}): ReactElement {
  const { row, open, theme, onToggle, onClose } = props
  return createElement('div', { 'data-dshell-status-row': row.id },
    createElement('div', {
      onClick: () => {
        if (open) onClose()
        else onToggle()
      },
      style: {
        display: 'flex',
        gap: '7px',
        alignItems: 'baseline',
        padding: '5px 7px',
        borderRadius: '6px',
        cursor: 'pointer',
        background: open ? theme.accentFaint : 'transparent',
      },
    },
      createElement('span', {
        style: { width: '13px', flex: '0 0 auto', color: row.active ? theme.accentText : theme.muted },
      }, row.glyph),
      createElement('span', { style: { color: theme.text, flex: '0 0 auto' } }, row.label),
      createElement('span', {
        style: {
          color: row.active ? theme.accentText : theme.muted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto',
        },
      }, row.value),
      createElement('span', { style: { color: theme.muted, flex: '0 0 auto', opacity: 0.8 } }, open ? '▾' : '▸'),
    ),
    open && row.detail !== undefined
      ? createElement('div', {
        'data-dshell-status-detail': row.id,
        style: { padding: '2px 7px 8px 27px', display: 'grid', gap: '3px' },
      }, row.detail)
      : null,
  )
}

/**
 * The line an idle session shows.
 *
 * The card is permanent, so "nothing is happening" needs a settled word rather
 * than a blank or a shifting count: a number here would redraw whenever any
 * session was created or archived, in a corner nobody is reading for that.
 */
function idleHeadline(): string {
  return '空闲'
}

/** One line inside a detail body. */
function line(text: string, theme: Theme, extra: CSSProperties = {}): ReactElement {
  return createElement('div', {
    key: text,
    style: {
      color: theme.muted, fontSize: 11.5, lineHeight: '16px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...extra,
    },
  }, text)
}

/**
 * Containment for the card.
 *
 * The card projects state owned by four different services, and a fault in any
 * of those projections must cost the reader the card — never the terminal it
 * floats over. A thrown render here is caught, reported in place, and dropped on
 * the next clean render.
 */
export class StatusCardBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return createElement('pre', {
        'data-dshell-status-error': '',
        style: {
          position: 'absolute', top: 8, right: 12, zIndex: 5, maxWidth: 'min(560px, 70%)',
          maxHeight: '40vh', overflow: 'auto', margin: 0, padding: '6px 9px',
          borderRadius: '8px', background: '#2a0f12', color: '#f87171', fontSize: 11, whiteSpace: 'pre-wrap',
        },
      }, this.state.error)
    }
    return this.props.children
  }
}

/** The floating status card: one line collapsed, integrated status rows expanded. */
export function StatusCard(props: {
  todos: readonly TodoItem[]
  /** What the running turn is doing, when the fold knows (the current phase). */
  activity: string | undefined
  theme: Theme
  pty: PtyStreamService
  sessionId: string | undefined
  sessions: ISessions
  /** The cross-session pipe's face; absent in a composition without it. */
  pipe?: PipeSeat | undefined
}): ReactElement | null {
  const { todos, activity, theme, pty, sessionId, sessions, pipe } = props
  // Subscribed before any early return: hooks cannot be conditional, and the
  // state they carry is what decides whether the card exists at all.
  const agent = useSyncExternalStore(pty.agent.subscribe, pty.agent.getSnapshot)
  const link = useSyncExternalStore(pty.state.subscribe, pty.state.getSnapshot)
  const list = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
  const pipeState = useSyncExternalStore(
    pipe?.subscribe ?? NO_PIPE_SUBSCRIBE,
    pipe?.getSnapshot ?? getEmptyPipeState,
  )
  const [openCard, setOpenCard] = useState(false)
  const [openRow, setOpenRow] = useState<string | undefined>(undefined)

  // Every hook runs before the card can return nothing: the card is absent on
  // most renders and present while work is in flight, and a hook that appears
  // only in the second case is a hook-count change React rejects outright.
  //
  // The subagent catalog is fetched on demand — dsh serves it while a menu is
  // consuming it, so the row announces itself and asks for the catalog when the
  // reader opens it. Both calls are optional on the service: a build without
  // the subagent half simply never fills this row, and a throw inside an effect
  // would take the whole view down with it.
  useEffect(() => {
    if (sessionId === undefined) return
    const parent = sessionId as SessionId
    const catalog = sessions.setSubagentCatalogOpen
    const refresh = sessions.refreshSubagents
    if (typeof catalog !== 'function' || typeof refresh !== 'function') return
    const open = openRow === 'agents'
    catalog.call(sessions, parent, open)
    if (open) void refresh.call(sessions, parent)
    return () => { catalog.call(sessions, parent, false) }
  }, [openRow, sessionId, sessions])

  // The pipe's state is pulled, not pushed, and its own poll only runs while
  // the panel is open. The card therefore reads it itself — once at mount, then
  // only while this session actually has a pipe: a composition or a session
  // without one costs a single request.
  const pipeActive = pipeState.links.length > 0 || pipeState.tickets.length > 0
  useEffect(() => {
    if (pipe === undefined) return
    void pipe.load()
    if (!pipeActive) return
    const timer = setInterval(() => { void pipe.load() }, PIPE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [pipe, pipeActive])

  const agentHere = sessionId !== undefined && agent.sessionId === sessionId
  const live = agentHere && agent.live
  const dead = agentHere && agent.reason !== undefined
  // Every list field is read defensively: the store's shape is dsh's, and a
  // field it has not populated yet must degrade to "nothing to report" — a
  // throw here would take the whole view down with the card.
  const byId = list.byId ?? {}
  // Whether a turn is running comes from the session list, not from the fold:
  // a turn that died with the host leaves a permanently "running" block behind,
  // and a status line that keeps claiming work is worse than no status line.
  const running = sessionId !== undefined && byId[sessionId as SessionId]?.running === true
  const linkHere = sessionId !== undefined && link.sessionId === sessionId
  const linkBroken = linkHere && (link.status === 'closed' || link.status === 'error')
  const children = sessionId === undefined
    ? []
    : (list.subagentsByParent?.[sessionId as SessionId]?.entries ?? []).filter(entry => entry.kind === 'child')
  const runningChildren = children.filter(entry => entry.activity === 'running').length

  const done = todos.filter(item => item.status === 'completed').length
  const activeTodo = todos.find(item => item.status === 'in_progress')
  const pendingTodo = todos.find(item => item.status === 'pending')

  // The pipe's effect on this session, computed before the head line because
  // it is part of that line. A ticket the current session *asked for* and did
  // not get an answer to is a breakpoint: the agent delegated, ended its turn
  // on purpose and is parked until the reply reopens it, which is a state the
  // reader must see — otherwise the session looks idle while it is waiting.
  // Work another session handed *to* this one is the pipe's other half.
  const peerTitle = (id: string): string => byId[id as SessionId]?.displayTitle ?? id.slice(0, 12)
  const waiting = pipeState.tickets.filter(ticket =>
    ticket.from === sessionId && !SETTLED.includes(ticket.state))
  const owed = pipeState.tickets.filter(ticket =>
    ticket.to === sessionId && !SETTLED.includes(ticket.state))

  // The one line the collapsed card shows: the newest thing that is happening,
  // in the order a reader would ask about it — the phase of a written plan
  // first, since it is short and is what the reader last saw the agent do. A
  // quiet session says so and stays openable: the card is the session's status
  // surface, and its rows are worth reaching even when nothing is running.
  const headline =
    running ? `◐ ${activeTodo?.content ?? activity ?? 'AI 正在工作'}`
      : waiting.length > 0 ? `⏸ 等待 ${peerTitle(waiting[0]?.to ?? '')} 回信`
        : activeTodo !== undefined ? `◐ ${activeTodo.content}`
          : owed.length > 0 ? `⇄ ${String(owed.length)} 个管道任务待处理`
            : live ? '▚ AI 终端运行中'
              : runningChildren > 0 ? `⎇ ${String(runningChildren)} 个智能体运行中`
                : pendingTodo !== undefined ? `○ ${pendingTodo.content}`
                  : dead ? 'AI 终端已结束'
                    : linkBroken ? '终端连接中断'
                      : idleHeadline()
  const idle = !running && activeTodo === undefined && !live && runningChildren === 0
    && pendingTodo === undefined && !dead && !linkBroken && waiting.length === 0 && owed.length === 0

  const rows: StatusRow[] = []
  if (todos.length > 0) {
    const phase = activeTodo?.content ?? pendingTodo?.content
    rows.push({
      id: 'plan', glyph: '◐', label: '计划', active: activeTodo !== undefined,
      value: `${String(done)}/${String(todos.length)}${phase === undefined ? '' : ` · ${phase}`}`,
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        ...todos.map(item => createElement('div', {
          key: item.content,
          style: {
            display: 'grid', gridTemplateColumns: '14px 1fr', gap: '6px',
            color: item.status === 'completed' ? theme.muted : theme.text,
            textDecoration: item.status === 'completed' ? 'line-through' : 'none',
            whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: '17px',
          },
        },
          createElement('span', { style: { opacity: 0.8 } }, STATUS_GLYPH[item.status]),
          createElement('span', null, item.content),
        )),
      ),
    })
  }
  rows.push({
    id: 'terminal', glyph: '▚', label: 'AI 终端', active: live,
    value: !live
      ? (dead ? '已结束' : '未开启')
      : agent.ready ? '运行中 · 只读' : '启动中…',
    detail: createElement('div', { style: { display: 'grid', gap: '4px' } },
      live || !agentHere
        ? null
        : createElement('div', {
          onClick: () => { pty.openAgentTerminal() },
          style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5 },
        }, agent.reason === undefined ? '为 AI 开启一个终端' : '重新开启'),
      dead ? line(agent.reason ?? '', theme) : null,
      live && !agent.ready ? line('正在启动它自己的 shell…', theme) : null,
      agentHere
        ? createElement(AgentTerminalPanel, { pty, sessionId, theme })
        : line('切换到会话后可用。', theme),
    ),
  })
  if (children.length > 0 || runningChildren > 0) {
    rows.push({
      id: 'agents', glyph: '⎇', label: '智能体', active: runningChildren > 0,
      value: children.length === 0
        ? '读取中…'
        : `${String(children.length)} 个${runningChildren === 0 ? '' : ` · ${String(runningChildren)} 运行中`}`,
      detail: children.length === 0
        ? line('还没有派生子智能体。', theme)
        : createElement('div', { style: { display: 'grid', gap: '2px' } },
          ...children.map(entry => createElement('div', {
            key: String(entry.id),
            onClick: () => {
              const address = sessions.subagentAddress(entry.id)
              if (address !== undefined) sessions.openSubagent(address)
            },
            style: {
              display: 'grid', gridTemplateColumns: '10px 1fr', gap: '6px',
              color: theme.text, fontSize: 11.5, lineHeight: '17px', cursor: 'pointer',
            },
          },
            createElement('span', {
              style: { color: entry.activity === 'running' ? theme.accent : theme.borderStrong },
            }, '●'),
            createElement('span', {
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, entry.label ?? String(entry.id)),
          )),
        ),
    })
  }
  // The pipe rows. A breakpoint is the wait for an answer (the agent ended its
  // turn on purpose); a pipe task is work another session handed to this one.
  if (waiting.length > 0) {
    rows.push({
      id: 'breakpoint', glyph: '⏸', label: '中断点', active: true,
      value: `等待 ${peerTitle(waiting[0]?.to ?? '')} 回信${waiting.length > 1 ? ` · ${String(waiting.length)} 个` : ''}`,
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        line('已把活交给别的会话并结束本轮，对方回信后会自动唤醒。', theme),
        ...waiting.map(ticket => createElement('div', {
          key: ticket.id,
          style: { display: 'grid', gap: '1px', marginTop: '2px' },
        },
          createElement('div', {
            style: { color: theme.text, fontSize: 11.5, lineHeight: '16px', whiteSpace: 'pre-wrap' },
          }, `→ ${peerTitle(ticket.to)}：${ticket.subject}`),
          createElement('div', {
            style: { display: 'flex', gap: '8px', color: theme.muted, fontSize: 11 },
          },
            createElement('span', null, `${STATE_LABEL[ticket.state]} · ${remaining(ticket.deadlineAt)}`),
            ticket.reports.length === 0 ? null : createElement('span', null, `${String(ticket.reports.length)} 条进展`),
            createElement('span', {
              onClick: (event: { stopPropagation: () => void }) => {
                event.stopPropagation()
                void pipe?.cancel(ticket.id)
              },
              style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer' },
            }, '撤回'),
          ),
        )),
      ),
    })
  }
  if (owed.length > 0) {
    rows.push({
      id: 'pipe', glyph: '⇄', label: '管道任务', active: true,
      value: `${String(owed.length)} 个待处理 · ${peerTitle(owed[0]?.from ?? '')}`,
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        ...owed.map(ticket => createElement('div', {
          key: ticket.id,
          style: { display: 'grid', gap: '1px', marginTop: '2px' },
        },
          createElement('div', {
            style: { color: theme.text, fontSize: 11.5, lineHeight: '16px', whiteSpace: 'pre-wrap' },
          }, `← ${peerTitle(ticket.from)}：${ticket.subject}`),
          createElement('div', { style: { color: theme.muted, fontSize: 11 } },
            `${STATE_LABEL[ticket.state]} · ${remaining(ticket.deadlineAt)}`),
        )),
        pipe === undefined
          ? null
          : createElement('div', {
            onClick: (event: { stopPropagation: () => void }) => {
              event.stopPropagation()
              pipe.setOpen(true)
            },
            style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5, marginTop: '3px' },
          }, '打开管道面板'),
      ),
    })
  }
  if (linkBroken || (linkHere && link.status === 'connecting')) {
    rows.push({
      id: 'link', glyph: '⚡', label: '连接', active: false,
      value: linkBroken ? '已断开' : '连接中…',
      detail: createElement('div', { style: { display: 'grid', gap: '3px' } },
        line(link.reason ?? '', theme),
        link.detail === undefined ? null : line(link.detail, theme),
        createElement('div', {
          onClick: () => { pty.reconnect() },
          style: { color: theme.accentText, textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5 },
        }, '重新连接'),
      ),
    })
  }

  // The terminal's grid needs the room; every other detail is text.
  const wide = openRow === 'terminal'

  return createElement('div', {
    'data-dshell-status-card': '',
    style: {
      position: 'absolute',
      top: 8,
      right: 12,
      zIndex: 5,
      display: 'grid',
      gap: '2px',
      width: openCard ? (wide ? 'min(720px, 84%)' : 'min(380px, 62%)') : 'fit-content',
      maxWidth: openCard ? (wide ? 'min(720px, 84%)' : 'min(380px, 62%)') : 'min(330px, 56%)',
      background: theme.menuBg,
      border: `1px solid ${theme.border}`,
      borderRadius: '8px',
      padding: openCard ? '6px 7px 7px' : '8px 11px',
      fontFamily: SPAN_FONT,
      fontSize: 12.5,
      color: theme.muted,
      boxShadow: '0 6px 20px rgba(0,0,0,.35)',
    },
  },
    createElement('div', {
      'data-dshell-status-head': '',
      onClick: () => { setOpenCard(!openCard); if (openCard) setOpenRow(undefined) },
      style: { display: 'flex', gap: '7px', alignItems: 'baseline', cursor: 'pointer', whiteSpace: 'nowrap' },
    },
      createElement('span', {
        style: { color: idle ? theme.muted : theme.accentText, flex: '0 0 auto', opacity: idle ? 0.8 : 1 },
      }, '⌘'),
      createElement('span', {
        style: {
          color: running || live ? theme.text : theme.muted,
          overflow: 'hidden', textOverflow: 'ellipsis', flex: '1 1 auto',
        },
      }, headline),
      createElement('span', { style: { color: theme.muted, flex: '0 0 auto', opacity: 0.8 } }, openCard ? '▴' : '▾'),
    ),
    openCard
      ? createElement('div', {
        style: { display: 'grid', gap: '1px', marginTop: '2px', borderTop: `1px solid ${theme.border}`, paddingTop: '4px' },
      },
        ...rows.map(row => createElement(Row, {
          key: row.id,
          row,
          theme,
          open: openRow === row.id,
          onToggle: () => { setOpenRow(row.id) },
          onClose: () => { setOpenRow(undefined) },
        })),
      )
      : null,
  )
}

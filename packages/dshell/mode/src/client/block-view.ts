/**
 * The block view: one scrolling column that alternates shell regions with
 * agent task blocks.
 *
 * A shell region is everything the terminal printed between two tasks, drawn
 * by a real terminal (see `block-terminal`) and carrying no chrome of its own:
 * the prompt, the command echoes and their output are exactly what the shell
 * produced. A task is a card — header, a two-line preview folded, every row
 * expanded, and its closing line. Regions and cards sort on one timeline, so
 * the interleaving the reader saw is preserved.
 *
 * The seat mirrors the canvas's view shell: the slot area is absolutely
 * positioned over the content column, so the seat fills it and the inner
 * column owns the scrolling. Without that the column grows to content height
 * and the composer paints over its tail.
 */

import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type {
  ISessions,
  SessionEventLikeEntry,
  SessionEventSource,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { blockLabel, createFold, foldEvent } from './blocks.js'
import { assembleTimeline, type ViewItem } from './block-model.js'
import { createSpanTerminal, SPAN_FONT, SPAN_FONT_SIZE, SPAN_LINE_HEIGHT } from './block-terminal.js'
import { SESSION_ROW_LABEL, sanitizeRowText, type SessionRow } from './session-rows.js'
import { useDshellTheme, type Theme } from './theme.js'

/** Status colours a task header uses, mirroring the canvas's ANSI palette. */
const STATUS_COLOR: Record<string, string> = {
  running: '#06989a',
  done: '#4e9a06',
  aborted: '#c4a000',
  failed: '#cc0000',
}

/** Content lines a folded task card previews. */
const PREVIEW_LINES = 2

/**
 * Row colours, matching the ANSI palette the canvas painted each role with, so
 * a task reads the same in either view: the user's words, the answer, the
 * chain of thought, a tool call and its result are all distinguishable.
 */
const ROW_COLOR: Record<SessionRow['role'], string> = {
  user: '#06989a',
  assistant: '#4e9a06',
  reasoning: '#6b7280',
  call: '#75507b',
  tool: '#3465a4',
  command: '#c4a000',
}

/** One session row as a coloured, labelled line. */
function RowLine(props: { row: SessionRow; theme: Theme; dim: boolean; clamp: boolean }): ReactElement {
  const { row, theme } = props
  const color = props.dim ? theme.muted : ROW_COLOR[row.role]
  return createElement('div', {
    style: {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      ...(props.clamp ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : {}),
    },
  },
    createElement('span', { style: { color, marginRight: '6px' } }, row.label ?? SESSION_ROW_LABEL[row.role]),
    createElement('span', { style: { color: props.dim ? theme.muted : theme.text } }, sanitizeRowText(row.text)),
  )
}

/** A shell region: a plain terminal, no header and no frame of its own. */
function ShellRegion(props: {
  item: Extract<ViewItem, { kind: 'shell' }>
  theme: Theme
}): ReactElement {
  const host = useRef<HTMLDivElement | null>(null)
  const handle = useRef<ReturnType<typeof createSpanTerminal> | undefined>(undefined)
  useEffect(() => {
    const el = host.current
    if (el === null) return
    handle.current = createSpanTerminal(el, props.theme, props.item.text)
    const observer = new ResizeObserver(() => { handle.current?.fit() })
    observer.observe(el)
    return () => { observer.disconnect(); handle.current?.dispose(); handle.current = undefined }
  }, [props.theme])
  // Output that arrived after mount is appended in place.
  useEffect(() => { handle.current?.update(props.item.text) }, [props.item.text])
  return createElement('div', {
    ref: host,
    'data-dshell-shell-region': '',
    style: { fontFamily: SPAN_FONT, fontSize: SPAN_FONT_SIZE, lineHeight: `${String(SPAN_LINE_HEIGHT)}px` },
  })
}

/** An agent task card. */
function AgentBlock(props: {
  item: Extract<ViewItem, { kind: 'agent' }>
  theme: Theme
}): ReactElement {
  const block = props.item.block
  const [expanded, setExpanded] = useState(false)
  const rows = block.rows
  const body = expanded ? rows : rows.slice(-PREVIEW_LINES)
  return createElement('div', { 'data-dshell-block': 'agent', style: cardStyle(props.theme) },
    createElement('div', {
      onClick: () => { setExpanded(value => !value) },
      style: {
        display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer',
        fontFamily: SPAN_FONT, fontSize: SPAN_FONT_SIZE, lineHeight: '18px',
      },
    },
      createElement('span', { style: { color: STATUS_COLOR[block.status] ?? props.theme.text } }, '▸'),
      createElement('span', {
        style: { color: props.theme.text, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, blockLabel(block)),
      createElement('span', { style: { color: props.theme.muted, fontSize: 11 } }, expanded ? '▾' : '▸'),
    ),
    ...body.map((row, index) => createElement(RowLine, {
      key: `${row.key}:${String(index)}`,
      row,
      theme: props.theme,
      dim: !expanded,
      clamp: !expanded,
    })),
    block.notice === undefined ? null : createElement('div', {
      style: { color: props.theme.muted, fontSize: 11, marginTop: '2px' },
    }, block.notice.text),
  )
}

function cardStyle(theme: Theme): Record<string, string> {
  return {
    border: `1px solid ${theme.border}`,
    borderLeft: `3px solid ${theme.borderStrong}`,
    borderRadius: '6px',
    background: theme.inputBar,
    margin: '6px 0',
    padding: '6px 8px',
    overflow: 'hidden',
  }
}

/** The block view seat: the whole content column above the composer. */
export function BlockView(props: {
  pty: PtyStreamService
  sessions: ISessions
  sessionId: SessionId | undefined
}): ReactElement {
  const theme = useDshellTheme()
  const seat = useRef<HTMLDivElement | null>(null)
  const probe = useRef<HTMLSpanElement | null>(null)
  const scroll = useRef<HTMLDivElement | null>(null)
  const [entries, setEntries] = useState<readonly SessionEventLikeEntry[]>([])
  const [version, setVersion] = useState(0)
  const id = props.sessionId === undefined ? undefined : String(props.sessionId)

  // The binding (and its event window) materializes shortly after a session
  // opens; retry until it lands, and drop it when the session closes.
  useEffect(() => {
    if (props.sessionId === undefined) { setEntries([]); return }
    let source: SessionEventSource | undefined
    const sessionId = props.sessionId
    const tryBind = (): boolean => {
      try {
        const binding = props.sessions.binding(sessionId)
        if (binding === undefined) return false
        source = binding.eventSource
        setEntries(source.getSnapshot().entries)
        return true
      } catch {
        return false
      }
    }
    if (!tryBind()) {
      const timer = setInterval(() => { if (tryBind()) clearInterval(timer) }, 500)
      return () => { clearInterval(timer) }
    }
    const bound = source
    return bound?.subscribe(() => { setEntries(bound.getSnapshot().entries) })
  }, [props.sessions, props.sessionId])

  // PTY history changes bump the service's version; re-slice the regions.
  useEffect(() => props.pty.state.subscribe(() => { setVersion(value => value + 1) }), [props.pty])

  // Keep the PTY's cell grid in step with the seat while this tab is active:
  // the canvas normally owns that, and it is unmounted here.
  useEffect(() => {
    const el = seat.current
    if (el === null) return
    const sync = (): void => {
      const metrics = probe.current?.getBoundingClientRect()
      if (metrics === undefined || metrics.width <= 0) return
      const cellWidth = metrics.width / 40
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return
      const cols = Math.min(500, Math.max(20, Math.floor(el.clientWidth / cellWidth)))
      const rows = Math.min(300, Math.max(6, Math.floor(el.clientHeight / SPAN_LINE_HEIGHT)))
      props.pty.resize(cols, rows)
    }
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    sync()
    return () => { observer.disconnect() }
  }, [props.pty, id])

  const items = useMemo(() => {
    if (id === undefined) return []
    const fold = createFold()
    for (const entry of entries) if (entry.type === 'event') foldEvent(fold, entry.event)
    // Cut the shell stream at each task's start, so a stretch of terminal
    // output that spans several tasks is split between them rather than
    // lumped above or below all of them.
    const slices = props.pty.slices(id, fold.blocks.map(block => block.startedAt))
    return assembleTimeline(fold.blocks, slices)
    // `version` re-cuts the PTY regions when output arrives.
  }, [entries, id, props.pty, version])

  // Follow the tail unless the reader has scrolled away.
  const pinned = useRef(true)
  useEffect(() => {
    const el = scroll.current
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight
  })

  return createElement('div', {
    ref: seat,
    'data-dshell-terminal-view': 'blocks',
    // The seat is the view area's flex child. Its only child is absolutely
    // positioned, so the seat contributes no intrinsic height: the view area
    // keeps its own height (clear of the composer) instead of growing to the
    // column's content. Without that, `flex: 1 0 auto` on the view area makes
    // the whole page scroll and the composer lands on top of the content.
    style: {
      position: 'relative',
      flex: '1 1 auto',
      minHeight: 0,
      minWidth: 0,
      overflow: 'hidden',
      background: theme.bg,
    },
  },
    createElement('span', {
      ref: probe,
      style: {
        position: 'absolute', visibility: 'hidden', whiteSpace: 'pre',
        font: `${String(SPAN_FONT_SIZE)}px ${SPAN_FONT}`,
      },
    }, 'W'.repeat(40)),
    createElement('div', {
      ref: scroll,
      'data-dshell-block-view': '',
      onScroll: () => {
        const el = scroll.current
        if (el === null) return
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      },
      style: { position: 'absolute', inset: 0, overflowY: 'auto', padding: '6px 10px 2px' },
    },
      ...items.map(item => (item.kind === 'shell'
        ? createElement(ShellRegion, { key: `${item.key}:${String(version)}`, item, theme })
        : createElement(AgentBlock, { key: item.key, item, theme }))),
    ),
  )
}

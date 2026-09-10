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
import { createFold, foldEvent } from './blocks.js'
import { AgentBlock } from './agent-block.js'
import { assembleTimeline, todosOf, type ViewItem } from './block-model.js'
import { createSpanTerminal, SPAN_FONT, SPAN_FONT_SIZE, SPAN_LINE_HEIGHT } from './block-terminal.js'
import { TodoCard, injectTodoCardCss, setTodoPanelSuppressed } from './todo-card.js'
import { useDshellTheme } from './theme.js'

/** A shell region: a plain terminal, no header and no frame of its own. */
function ShellRegion(props: {
  item: Extract<ViewItem, { kind: 'shell' }>
  theme: import('./theme.js').Theme
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

  // The docked task panel lies across the transcript; the floating card takes
  // over while this view is on screen, and hands it back on unmount.
  useEffect(() => {
    injectTodoCardCss()
    setTodoPanelSuppressed(true)
    return () => { setTodoPanelSuppressed(false) }
  }, [])

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
    createElement(TodoCard, { todos: todosOf(entries), theme }),
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
      ...items.flatMap((item, index) => {
        const previous = items[index - 1]
        // A hairline only where the kind changes: enough to see where a shell
        // stretch ends and a task begins, without boxing either of them in.
        const divider = previous !== undefined && previous.kind !== item.kind
          ? [createElement('div', {
              key: `${item.key}:sep`,
              style: { height: 1, background: theme.border, margin: '12px 0' },
            })]
          : []
        const node = item.kind === 'shell'
          ? createElement(ShellRegion, { key: `${item.key}:${String(version)}`, item, theme })
          : createElement(AgentBlock, { key: item.key, block: item.block, theme })
        return [...divider, node]
      }),
    ),
  )
}

/**
 * The block view: one scrolling DOM column in which every shell command run
 * and every agent task is a block.
 *
 * Shell blocks render their slice on a real xterm instance (see
 * `block-terminal`), so ANSI fidelity is not re-implemented; agent blocks are
 * plain DOM — a header, a two-line preview when folded, and their rows when
 * expanded. The column replaces the single-canvas view, but keeps the merge:
 * both block kinds are sorted on one timeline, so shell output that arrived
 * between two tasks stays between them.
 */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import type { SessionEventLikeEntry, SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { blockLabel } from './blocks.js'
import { assembleTimeline, blockPreview, clockOf, type ViewItem } from './block-model.js'
import {
  BLOCK_FONT,
  BLOCK_FONT_SIZE,
  BLOCK_ROWS_COLLAPSED,
  blockRows,
  createBlockTerminal,
  lineCount,
} from './block-terminal.js'
import { sanitizeRowText } from './session-rows.js'
import { useDshellTheme, type Theme } from './theme.js'

/** Status colours a block header uses, mirroring the canvas's ANSI palette. */
const STATUS_COLOR: Record<string, string> = {
  running: '#06989a',
  done: '#4e9a06',
  aborted: '#c4a000',
  failed: '#cc0000',
}
const EXIT_COLOR = (code: number | undefined): string => (code === undefined || code === 0 ? '#4e9a06' : '#cc0000')

/** Blocks within this many items of the tail mount a real terminal. */
const TERMINAL_WINDOW = 40

function ShellBlock(props: {
  item: Extract<ViewItem, { kind: 'shell' }>
  theme: Theme
  /** Whether this block is close enough to the tail to get a terminal. */
  live: boolean
}): ReactElement {
  const { command } = props.item
  const body = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const rows = blockRows(command.output, expanded)
  const running = command.live

  useEffect(() => {
    const host = body.current
    if (host === null || !props.live) return
    const handle = createBlockTerminal(host, props.theme, command.output, rows)
    const observer = new ResizeObserver(() => { handle.fit() })
    observer.observe(host)
    return () => { observer.disconnect(); handle.dispose() }
  }, [props.live, command.output, props.theme])

  const header = command.command.length === 0
    ? (running ? '运行中…' : '（无命令）')
    : `$ ${command.command}`
  return createElement('div', { 'data-dshell-block': 'shell', style: blockCardStyle(props.theme) },
    createElement('div', { style: headerStyle },
      createElement('span', { style: { color: '#c4a000', marginRight: 8 } }, '$'),
      createElement('span', { style: { color: props.theme.text, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        sanitizeRowText(command.command.length === 0 ? header : command.command)),
      running
        ? createElement('span', { style: { color: STATUS_COLOR.running } }, '● 运行中')
        : createElement('span', { style: { color: EXIT_COLOR(command.exitCode) } },
            command.exitCode === undefined ? '✓' : `退出码 ${String(command.exitCode)}`),
      createElement('span', { style: { color: props.theme.muted, marginLeft: 10 } }, clockOf(command.time)),
    ),
    createElement('div', {
      ref: body,
      'data-dshell-shell-body': '',
      style: {
        fontFamily: BLOCK_FONT,
        fontSize: BLOCK_FONT_SIZE,
        lineHeight: '16px',
        height: `${String(rows * 16)}px`,
        overflow: 'hidden',
        // Before the terminal mounts (or for distant blocks) the raw text is
        // shown through the same sanitizer the canvas uses.
        whiteSpace: 'pre',
        color: props.theme.text,
      },
    }, props.live ? null : sanitizeRowText(command.output)),
    // Only offer the toggle when folding actually hides something.
    lineCount(command.output) > BLOCK_ROWS_COLLAPSED
      ? createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          createElement('button', {
            'data-dshell-shell-toggle': '',
            onClick: () => { setExpanded(value => !value) },
            style: toggleStyle(props.theme),
          }, expanded ? '收起' : '展开'),
        )
      : null,
  )
}

function AgentBlock(props: {
  item: Extract<ViewItem, { kind: 'agent' }>
  theme: Theme
}): ReactElement {
  const block = props.item.block
  const [expanded, setExpanded] = useState(false)
  const preview = blockPreview(block, 2)
  const rows = block.rows
  return createElement('div', { 'data-dshell-block': 'agent', style: blockCardStyle(props.theme) },
    createElement('div', {
      onClick: () => { setExpanded(value => !value) },
      style: { ...headerStyle, cursor: 'pointer' },
    },
      createElement('span', { style: { color: STATUS_COLOR[block.status] ?? props.theme.text, marginRight: 8 } }, '▸'),
      createElement('span', { style: { color: props.theme.text, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, blockLabel(block)),
      createElement('span', { style: { color: props.theme.muted } }, expanded ? '▾' : '▸'),
    ),
    ...(expanded
      ? rows.map(row => createElement('div', {
          key: row.key,
          style: { color: props.theme.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '2px 0' },
        }, sanitizeRowText(`${row.label ?? ''} ${row.text}`.trim())))
      : preview.map((line, index) => createElement('div', {
          key: `p${String(index)}`,
          style: { color: props.theme.muted, whiteSpace: 'pre-wrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        }, line))),
  )
}

function blockCardStyle(theme: Theme): Record<string, string> {
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

const headerStyle: Record<string, string> = {
  display: 'flex',
  alignItems: 'center',
  gap: '2px',
  fontFamily: BLOCK_FONT,
  fontSize: `${String(BLOCK_FONT_SIZE)}px`,
  lineHeight: '18px',
  marginBottom: '2px',
}

function toggleStyle(theme: Theme): Record<string, string> {
  return {
    background: 'transparent',
    border: 'none',
    color: theme.muted,
    fontSize: '11px',
    cursor: 'pointer',
    padding: '0 2px',
  }
}

/** The DOM block column; replaces the single-canvas conversation view. */
export function BlockView(props: {
  pty: PtyStreamService
  sessions: ISessions
  sessionId: SessionId | undefined
}): ReactElement {
  const theme = useDshellTheme()
  const scroll = useRef<HTMLDivElement | null>(null)
  const [entries, setEntries] = useState<readonly SessionEventLikeEntry[]>([])
  const [version, setVersion] = useState(0)
  const id = props.sessionId === undefined ? undefined : String(props.sessionId)

  // The binding (and its event window) materializes shortly after a session
  // opens; retry until it lands, and drop it when the session closes.
  useEffect(() => {
    if (id === undefined) { setEntries([]); return }
    let source: SessionEventSource | undefined
    const tryBind = (): boolean => {
      try {
        const binding = props.sessions.binding(props.sessionId!)
        if (binding === undefined) return false
        source = binding.eventSource
        setEntries(source.getSnapshot().entries)
        return true
      } catch {
        return false
      }
    }
    if (tryBind()) {
      return source?.subscribe(() => { setEntries(source!.getSnapshot().entries) })
    }
    const timer = setInterval(() => { if (tryBind()) clearInterval(timer) }, 500)
    return () => { clearInterval(timer) }
  }, [props.sessions, id, props.sessionId])

  // PTY history changes bump the service's version; re-slice the commands.
  useEffect(() => {
    const unsubscribe = props.pty.state.subscribe(() => { setVersion(value => value + 1) })
    return unsubscribe
  }, [props.pty])

  const items = id === undefined
    ? []
    : assembleTimeline(entries, props.pty.commands(id))

  // Keep the tail in view unless the reader has scrolled away.
  const pinned = useRef(true)
  useEffect(() => {
    const el = scroll.current
    if (el === null || !pinned.current) return
    el.scrollTop = el.scrollHeight
  })

  return createElement('div', {
    // The view area is the whole column above the composer, and it is not a
    // flex container we can grow into: fill it absolutely, then let the inner
    // column own the scrolling. Without this the column grows to its content
    // and the composer paints over its tail.
    style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
  },
    createElement('div', {
      ref: scroll,
      'data-dshell-block-view': '',
      onScroll: () => {
        const el = scroll.current
        if (el === null) return
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      },
      style: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '8px 12px 4px',
        background: theme.bg,
        color: theme.text,
      },
    },
      ...items.map((item, index) => {
        const near = index >= items.length - TERMINAL_WINDOW
        if (item.kind === 'shell') {
          return createElement(ShellBlock, { key: `${item.key}:${String(version)}`, item, theme, live: near })
        }
        if (item.kind === 'agent') return createElement(AgentBlock, { key: item.key, item, theme })
        return createElement('div', {
          key: item.key,
          style: { color: theme.muted, fontSize: 12, padding: '2px 0' },
        }, item.text)
      }),
    ),
  )
}

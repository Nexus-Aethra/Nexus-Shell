/**
 * The right-edge bookmark rail.
 *
 * One tick per agent turn in the current session, drawn from the block fold
 * (the same fold the column renders). The collapsed form is a vertical strip
 * of horizontal dashes — most gray, the running turn's accent, the latest
 * done one muted — so it reads as a marker strip rather than as content. On
 * hover the strip expands leftward into a list of the first line of each
 * request, and clicking a row scrolls the column to that block and unsticks
 * the tail-pin so a fresh turn does not immediately drag the reader away.
 *
 * The strip disappears entirely when there are no agent turns in this
 * session — a session that has only ever been a shell would otherwise carry
 * a permanent UI surface that does nothing.
 */

import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { TurnBlock } from './blocks.js'
import { useDshellTheme, type Theme } from './theme.js'
import { sanitizeRowText } from './session-rows.js'

/** Width of the collapsed strip — narrow enough to disappear into the gutter. */
const RAIL_WIDTH = 8
/** Width of the row label once the rail is open. */
const ROW_WIDTH = 260
/** Pixels from the column's top edge where the strip starts, to clear rounded corners. */
const TOP_INSET = 8
/** Maximum characters of a label before it is truncated with an ellipsis. */
const LABEL_MAX = 36

/**
 * One bookmark: a turn in the current session, with the row's first line of
 * text as a label. The label is computed once from the durable rows, since a
 * streaming line is, by definition, not the title the bookmark would point at.
 */
export interface Bookmark {
  readonly key: string
  readonly label: string
  readonly status: TurnBlock['status']
}

/** Build the list the rail renders, oldest first; fold order is the same. */
export function bookmarksOf(blocks: readonly TurnBlock[]): readonly Bookmark[] {
  const out: Bookmark[] = []
  for (const block of blocks) {
    const asked = block.rows.find(row => row.role === 'user')
    const raw = asked?.text ?? block.title
    const line = sanitizeRowText(raw).split('\n').map(part => part.trim()).find(part => part.length > 0) ?? ''
    const label = line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line
    out.push({ key: block.key, label: label.length > 0 ? label : '(空消息)', status: block.status })
  }
  return out
}

/** The colour a tick takes, by the turn's status. */
function tickColor(theme: Theme, status: TurnBlock['status'], isLast: boolean): string {
  if (isLast && status === 'running') return theme.accent
  if (isLast) return theme.accentText
  if (status === 'failed') return '#f87171'
  if (status === 'aborted') return theme.muted
  return theme.borderStrong
}

/**
 * Resolve the agent block element for a bookmark, then scroll the container
 * so the block sits near the top of the column. The block elements are tagged
 * with `data-dshell-block-key` on the column, and the container is the same
 * scroll element the column manages.
 */
function scrollToBlock(scroll: HTMLDivElement | null, key: string): boolean {
  if (scroll === null) return false
  const target = scroll.querySelector(`[data-dshell-block-key="${CSS.escape(key)}"]`)
  if (!(target instanceof HTMLElement)) return false
  // Place the block 8px below the container's top edge — close enough that the
  // folded header is visible without the content feeling cut off. The browser
  // scrolls the nearest scrollable ancestor of `target`, which is `scroll`.
  const containerTop = scroll.getBoundingClientRect().top
  const targetTop = target.getBoundingClientRect().top
  const desired = scroll.scrollTop + (targetTop - containerTop) - 8
  scroll.scrollTo({ top: Math.max(0, desired), behavior: 'smooth' })
  return true
}

/** Props the block view passes in. */
export interface BookmarkRailProps {
  /** The bookmarks to show, oldest first; empty hides the rail. */
  bookmarks: readonly Bookmark[]
  /** The scroll container the agent blocks live in, for jump targeting. */
  scrollContainer: HTMLDivElement | null
  /** Called when the user jumps to a bookmark — unsticks the tail-pin. */
  onJump: () => void
}

/**
 * The right-edge bookmark strip.
 *
 * State machine: `idle` (collapsed), `hover` (mouse over the strip), and
 * `pinned` (the user clicked a row, so it stays open even after the cursor
 * leaves). The strip collapses back to `idle` whenever the session changes or
 * the bookmark list grows stale, so a freshly arrived turn does not keep the
 * panel stuck open across an unrelated switch.
 */
export function BookmarkRail(props: BookmarkRailProps): ReactElement | null {
  const theme = useDshellTheme()
  const [mode, setMode] = useState<'idle' | 'hover' | 'pinned'>('idle')
  // Close the pinned state when the session changes — identified by the
  // bookmark key set, since block keys are stable per session.
  const identity = props.bookmarks.map(b => b.key).join('|')
  useEffect(() => {
    setMode('idle')
    // `identity` is the dependency: a different key set means a different
    // session's turns are showing, which is the trigger to retract.
  }, [identity])

  const open = mode !== 'idle'
  const lastKey = props.bookmarks[props.bookmarks.length - 1]?.key
  const width = open ? RAIL_WIDTH + ROW_WIDTH + 12 : RAIL_WIDTH
  // Keep the cursor-keep-alive timer in a ref so the leave handler can cancel it.
  const closeTimer = useRef<number | undefined>(undefined)
  const cancelClose = useCallback((): void => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }, [])
  const scheduleClose = useCallback((): void => {
    cancelClose()
    // A small grace period lets the cursor cross the gap between the strip
    // and its expanded panel without flickering the panel closed mid-motion.
    closeTimer.current = window.setTimeout(() => { setMode('idle') }, 120)
  }, [cancelClose])
  useEffect(() => () => cancelClose(), [cancelClose])

  if (props.bookmarks.length === 0) return null
  return createElement('div', {
    'data-dshell-bookmark-rail': mode,
    onMouseEnter: () => { cancelClose(); if (mode === 'idle') setMode('hover') },
    onMouseLeave: () => { if (mode === 'hover') scheduleClose() },
    style: {
      position: 'absolute',
      top: TOP_INSET,
      right: 0,
      bottom: TOP_INSET,
      width,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'stretch',
      pointerEvents: 'auto',
      transition: 'width 140ms ease',
      zIndex: 2,
    },
  },
    // The expanded panel: a list of labels, with the latest row tinted as
    // "you are here". Sits to the left of the strip and is part of the same
    // hover target so the cursor can travel across without a flicker.
    createElement('div', {
      'data-dshell-bookmark-panel': '',
      style: {
        width: open ? ROW_WIDTH + 8 : 0,
        overflow: 'hidden',
        background: theme.menuBg,
        border: `1px solid ${open ? theme.borderStrong : 'transparent'}`,
        borderRadius: 8,
        marginRight: 4,
        opacity: open ? 1 : 0,
        transition: 'opacity 120ms ease',
        display: 'flex',
        flexDirection: 'column',
        padding: open ? '6px 4px' : 0,
        gap: 2,
        // The panel itself is not interactive beyond its buttons; the rail's
        // outer onMouseEnter keeps it open.
        boxShadow: open ? '0 8px 24px rgba(0, 0, 0, 0.35)' : 'none',
      },
    },
      ...props.bookmarks.map(bookmark => {
        const isLast = bookmark.key === lastKey
        const row: CSSProperties = {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 12,
          color: isLast ? theme.accentText : theme.text,
          background: isLast ? theme.accentFaint : 'transparent',
          border: 'none',
          textAlign: 'left',
          width: '100%',
          fontFamily: 'inherit',
        }
        return createElement('button', {
          key: bookmark.key,
          type: 'button',
          title: bookmark.label,
          // The label can be long; truncate visually but keep the full title
          // in the native tooltip for the reader who hovers the row itself.
          style: { ...row, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          onClick: () => {
            if (scrollToBlock(props.scrollContainer, bookmark.key)) {
              setMode('pinned')
              props.onJump()
            }
          },
        }, bookmark.label)
      }),
    ),
    // The collapsed strip: a column of horizontal dashes. Width equals
    // RAIL_WIDTH so the hit-target is generous without the strip feeling
    // like a sidebar of its own.
    createElement('div', {
      'data-dshell-bookmark-strip': '',
      style: {
        width: RAIL_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        paddingTop: 6,
        // A faint strip background makes the hit-target obvious without
        // drawing a card; the panel's background is what reads as a panel.
        background: open ? 'transparent' : 'rgba(255, 255, 255, 0.02)',
        borderRadius: 4,
        // `flex: 1` would push ticks apart; the reader expects the strip to
        // reflect the actual count of turns, not stretch to fill the column.
        flexShrink: 0,
      },
    },
      ...props.bookmarks.map(bookmark => {
        const isLast = bookmark.key === lastKey
        return createElement('span', {
          key: bookmark.key,
          'data-dshell-bookmark-tick': bookmark.status,
          style: {
            display: 'block',
            width: 6,
            height: 2,
            background: tickColor(theme, bookmark.status, isLast),
            borderRadius: 1,
          },
        })
      }),
    ),
  )
}

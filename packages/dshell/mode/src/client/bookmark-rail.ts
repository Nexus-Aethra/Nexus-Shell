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
 *
 * "Active" tracking: the bookmark whose block currently dominates the
 * viewport is highlighted, so the reader can see which turn they are
 * reading. A click sets the active key explicitly; as the user scrolls, an
 * IntersectionObserver re-evaluates the active block from the visible
 * geometry, and the highlight follows.
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { TurnBlock } from './blocks.js'
import { useDshellTheme, type Theme } from './theme.js'
import { sanitizeRowText } from './session-rows.js'

/** Width of the collapsed strip — narrow enough to disappear into the gutter. */
const RAIL_WIDTH = 8
/** Width of the row label once the rail is open. */
const ROW_WIDTH = 260
/**
 * Pixels from the column's top edge where the strip starts. The strip is
 * pulled down from the very top of the seat so it does not crowd the
 * session's header chrome above the first turn — about a turn's worth of
 * vertical room, so the first tick aligns with the first agent block.
 */
const TOP_INSET = 120
/**
 * Pixels of bottom margin, so the strip does not reach the composer.
 * Small enough that the strip still spans the column.
 */
const BOTTOM_INSET = 24
/** Maximum characters of a label before it is truncated with an ellipsis. */
const LABEL_MAX = 36
/**
 * Grace period between the cursor leaving the rail and the panel closing.
 * The reader's path from a row to where they want to read crosses the gap
 * between strip and panel, so a longer-than-immediate close avoids flicker.
 */
const CLOSE_DELAY_MS = 140

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

/**
 * Pick the block the reader is currently reading.
 *
 * The answer is the block whose body occupies the largest share of the
 * container's visible region — the block the reader's eyes are on, which
 * is also the block a click jump puts the user on (the click target fills
 * the viewport from just below the top down to its bottom).
 *
 * "Visible height" is the part of the block that lies inside the
 * container's visible region: `min(r.bottom, containerBottom) - max(r.top,
 * containerTop)`, clipped to zero when the block is entirely above or
 * below the viewport. The block with the greatest visible height wins. If
 * no block has any visible height, there is no answer.
 */
function activeBlockKey(scroll: HTMLDivElement | null, keys: readonly string[]): string | undefined {
  if (scroll === null || keys.length === 0) return undefined
  const r = scroll.getBoundingClientRect()
  const top = r.top
  const bottom = r.bottom
  let bestKey: string | undefined
  let bestVisible = 0
  for (const key of keys) {
    const el = scroll.querySelector(`[data-dshell-block-key="${CSS.escape(key)}"]`)
    if (!(el instanceof HTMLElement)) continue
    const br = el.getBoundingClientRect()
    const visible = Math.max(0, Math.min(br.bottom, bottom) - Math.max(br.top, top))
    if (visible > bestVisible) {
      bestVisible = visible
      bestKey = key
    }
  }
  return bestKey
}

/** Props the block view passes in. */
export interface BookmarkRailProps {
  /** The bookmarks to show, oldest first; empty hides the rail. */
  bookmarks: readonly Bookmark[]
  /** The scroll container the agent blocks live in, for jump targeting. */
  scrollContainer: HTMLDivElement | null
  /** Called when the user jumps to a bookmark — unsticks the tail-pin. */
  onJump: () => void
  /**
   * Called once after a successful jump, in addition to `onJump`. Used by
   * the block view to dismiss the sidebar so the new content lands in a
   * fully open reading surface; the user reopens the sidebar from the
   * toolbar when they want to switch sessions.
   */
  onAfterJump?: () => void
}

/**
 * The right-edge bookmark strip.
 *
 * State: `idle` (collapsed) or `hover` (mouse over the strip and panel). The
 * panel closes on `mouseleave` after a short grace period so the cursor can
 * cross the gap between strip and panel without flickering. Clicking a row
 * jumps the column to that block and updates the active highlight, but does
 * not pin the panel open — the panel still closes when the cursor leaves.
 */
export function BookmarkRail(props: BookmarkRailProps): ReactElement | null {
  const theme = useDshellTheme()
  const [hover, setHover] = useState(false)
  // Reset hover when the session changes — identified by the bookmark key
  // set, since block keys are stable per session. A fresh session's hover
  // should not leak across from the previous one.
  const identity = props.bookmarks.map(b => b.key).join('|')
  useEffect(() => { setHover(false) }, [identity])

  const keys = useMemo(() => props.bookmarks.map(b => b.key), [props.bookmarks])
  const lastKey = keys[keys.length - 1]
  // The key the rail treats as "you are reading this turn". Initialised to
  // the most recent turn so a brand-new session shows the same active
  // highlight as before; the scroll observer below takes over once the user
  // moves. `null` means "nothing to highlight" (empty session — but the
  // empty case returns null earlier, so this branch is unreachable here).
  const [activeKey, setActiveKey] = useState<string | undefined>(() => lastKey)
  useEffect(() => { setActiveKey(lastKey) }, [lastKey])

  // Track the block that dominates the viewport and update `activeKey` as
  // the reader scrolls. An IntersectionObserver is the right tool: it is
  // driven by the layout engine, not by a 16ms timer, and it does not need
  // any per-scroll arithmetic. We observe the column's agent blocks; the
  // callback runs when any of them crosses a threshold. A single threshold
  // at the container's top is enough — the rest of the rule is in
  // `activeBlockKey`, which decides which of the still-in-view blocks
  // dominates.
  useEffect(() => {
    const scroll = props.scrollContainer
    if (scroll === null || keys.length === 0) return
    // The root's bounding rect is the viewport we compare against, so the
    // observer's root margin shrinks the effective viewport to the area the
    // reader actually sees. A negative top margin pulls the upper boundary
    // down by the same amount we use for the click target — so a block is
    // "active" the moment its top crosses that line.
    const recompute = (): void => {
      if (Date.now() - clickedAt.current < CLICK_STICKY_MS) return
      const next = activeBlockKey(scroll, keys)
      if (next !== undefined) setActiveKey(prev => prev === next ? prev : next)
    }
    recompute()
    const observer = new IntersectionObserver(() => { recompute() }, {
      root: scroll,
      // Only the very top of the container matters for "what is the reader
      // looking at"; the bottom is already covered by following the tail.
      rootMargin: '0px 0px -100% 0px',
      threshold: [0, 0.01, 0.5, 1],
    })
    for (const key of keys) {
      const el = scroll.querySelector(`[data-dshell-block-key="${CSS.escape(key)}"]`)
      if (el instanceof HTMLElement) observer.observe(el)
    }
    // The click-sticky window suppresses geometry-based recomputation
    // while the smooth scroll is in flight. A trusted `wheel` event is
    // the natural moment the user takes over, and that is when the
    // sticky should end — earlier than the timeout, when the user is
    // already moving, so the highlight follows without lag.
    const onWheel = (event: WheelEvent): void => {
      if (event.isTrusted !== true) return
      clickedAt.current = 0
      recompute()
    }
    const onScroll = (): void => { recompute() }
    scroll.addEventListener('wheel', onWheel, { passive: true })
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      scroll.removeEventListener('wheel', onWheel)
      scroll.removeEventListener('scroll', onScroll)
    }
  }, [props.scrollContainer, identity, keys])

  const open = hover
  const closeTimer = useRef<number | undefined>(undefined)
  const cancelClose = useCallback((): void => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }, [])
  const scheduleClose = useCallback((): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => { setHover(false) }, CLOSE_DELAY_MS)
  }, [cancelClose])
  useEffect(() => () => cancelClose(), [cancelClose])

  /**
   * A click sets `activeKey` to the bookmark the reader asked for, and
   * the geometry rule must not override that pick until either the user
   * scrolls themselves or the click "stale" timeout expires. The smooth
   * scroll fires a stream of `scroll` events on the way to its destination,
   * each of which would otherwise call `recompute` and pick a different
   * block the moment a larger neighbour takes over the viewport. The
   * window is long enough to cover the smooth-scroll duration and the
   * reader's first look at the destination, short enough that an
   * intentional scroll never lags.
   */
  const clickedAt = useRef(0)
  const CLICK_STICKY_MS = 1500

  if (props.bookmarks.length === 0) return null
  return createElement('div', {
    'data-dshell-bookmark-rail': open ? 'hover' : 'idle',
    onMouseEnter: () => { cancelClose(); setHover(true) },
    onMouseLeave: () => { scheduleClose() },
    style: {
      position: 'absolute',
      top: TOP_INSET,
      right: 0,
      bottom: BOTTOM_INSET,
      width: open ? RAIL_WIDTH + ROW_WIDTH + 12 : RAIL_WIDTH,
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'stretch',
      pointerEvents: 'auto',
      transition: 'width 140ms ease',
      zIndex: 2,
    },
  },
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
        boxShadow: open ? '0 8px 24px rgba(0, 0, 0, 0.35)' : 'none',
      },
    },
      ...props.bookmarks.map(bookmark => {
        const isLast = bookmark.key === lastKey
        const isActive = bookmark.key === activeKey
        const row: CSSProperties = {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 12,
          // The active row reads as the turn the reader is on: full accent
          // text and a tinted background. The "latest" row uses a fainter
          // version of the same treatment so a click on the latest row does
          // not change the panel's appearance — it is already where the
          // reader is. Older rows stay neutral.
          color: isActive ? theme.accentText : theme.text,
          background: isActive
            ? theme.accentFaint
            : isLast
              ? 'rgba(255, 255, 255, 0.02)'
              : 'transparent',
          borderLeft: isActive
            ? `2px solid ${theme.accent}`
            : '2px solid transparent',
          paddingLeft: isActive ? 6 : 8,
          border: 'none',
          textAlign: 'left',
          width: '100%',
          fontFamily: 'inherit',
          fontWeight: isActive ? 500 : 400,
        }
        return createElement('button', {
          key: bookmark.key,
          type: 'button',
          title: bookmark.label,
          'data-dshell-bookmark-active': isActive ? 'true' : 'false',
          style: { ...row, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          onClick: () => {
            if (scrollToBlock(props.scrollContainer, bookmark.key)) {
              // Optimistic: jump immediately so the highlight follows the
              // click without waiting for the IntersectionObserver's next
              // tick. The observer will re-confirm the choice once the
              // smooth scroll settles and the click guard has expired.
              clickedAt.current = Date.now()
              setActiveKey(bookmark.key)
              props.onJump()
              // Optional: a host-specific side effect (collapse the
              // sidebar, for instance) that runs once per successful jump.
              // Kept on the rail so the bookmark row remains a single
              // self-contained widget.
              props.onAfterJump?.()
            }
          },
        }, bookmark.label)
      }),
    ),
    createElement('div', {
      'data-dshell-bookmark-strip': '',
      style: {
        width: RAIL_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        paddingTop: 6,
        background: open ? 'transparent' : 'rgba(255, 255, 255, 0.02)',
        borderRadius: 4,
        flexShrink: 0,
      },
    },
      ...props.bookmarks.map(bookmark => {
        const isLast = bookmark.key === lastKey
        const isActive = bookmark.key === activeKey
        // The active tick glows in the accent border colour so the strip
        // and the panel agree about which turn the reader is on.
        return createElement('span', {
          key: bookmark.key,
          'data-dshell-bookmark-tick': bookmark.status,
          'data-dshell-bookmark-tick-active': isActive ? 'true' : 'false',
          style: {
            display: 'block',
            width: isActive ? 8 : 6,
            height: 2,
            background: isActive
              ? theme.accent
              : tickColor(theme, bookmark.status, isLast),
            borderRadius: 1,
          },
        })
      }),
    ),
  )
}

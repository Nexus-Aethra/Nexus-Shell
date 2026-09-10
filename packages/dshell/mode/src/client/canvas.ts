/**
 * The dshell canvas: one xterm.js terminal rendering the merged timeline of
 * PTY output and agent task blocks (design 4.4).
 */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import type {
  ISessions,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  blockGutter,
  blockSegments,
  createFold,
  foldEvent,
  maxSeq,
  renderBlockCollapsed,
  renderNotice,
  segmentLines,
  type TimelineItem,
  type TurnBlock,
} from './blocks.js'
import {
  GUTTER_COLOR,
  endsAtLineStart,
  type GutterStyle,
  type SessionRow,
} from './session-rows.js'
import { activeTerm, injectXtermCss, xtermTheme, type Theme } from './theme.js'
import type { SessionMode } from './types.js'

declare global {
  interface Window {
    /** Acceptance/debug handle: the live canvas terminal (see `xterm-css`). */
    __DSHELL_TERM__?: XtermTerminal | null
  }
}

export function paintGutter(term: XtermTerminal, lines: ReadonlyMap<number, GutterStyle>): void {
  const rows = term.element?.querySelector('.xterm-rows')
  if (rows === undefined || rows === null) return
  const top = term.buffer.active.viewportY
  for (let index = 0; index < rows.children.length; index++) {
    const row = rows.children[index]
    if (!(row instanceof HTMLElement)) continue
    const role = lines.get(top + index)
    const shadow = role === undefined ? '' : `inset 3px 0 0 0 ${GUTTER_COLOR[role]}`
    if (row.style.boxShadow !== shadow) row.style.boxShadow = shadow
  }
}

export function PtyCanvas(props: {
  pty: PtyStreamService
  sessions: ISessions
  sessionId: SessionId | undefined
  theme: Theme
  /** Focus owner: shell mode routes keystrokes to the PTY (design 4.8). */
  mode: SessionMode
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XtermTerminal | null>(null)
  const probeRef = useRef<HTMLSpanElement | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | undefined>(undefined)
  const sessionIdRef = useRef<string | undefined>(undefined)
  /**
   * Whether the next write starts at column 0. Writes are queued in order, so
   * this mirrors the buffer strictly: a block row is prefixed with a newline
   * when the PTY left an unterminated prompt line (otherwise the row — and the
   * rule drawn over it — lands on top of the prompt's own text).
   */
  const lineStartRef = useRef(true)
  const theme = props.theme
  // Read inside the once-created xterm callbacks: only shell mode feeds the
  // PTY, so a focus that lingers on the canvas in agent mode stays inert.
  const modeRef = useRef(props.mode)
  modeRef.current = props.mode
  const [eventSource, setEventSource] = useState<SessionEventSource | undefined>(undefined)

  // The binding (and its event window) materializes shortly after a session
  // opens; retry until it lands, and drop it when the session closes.
  useEffect(() => {
    if (props.sessionId === undefined) {
      setEventSource(undefined)
      return
    }
    const id = props.sessionId
    const tryBind = (): boolean => {
      try {
        const binding = props.sessions.binding(id)
        if (binding === undefined) return false
        setEventSource(binding.eventSource)
        return true
      } catch {
        return false
      }
    }
    if (tryBind()) return
    const timer = setInterval(() => {
      if (tryBind()) clearInterval(timer)
    }, 500)
    return () => clearInterval(timer)
  }, [props.sessions, props.sessionId])

  // Create the terminal once; the container owns it for the dock's lifetime.
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    injectXtermCss()
    const term = new XtermTerminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(theme),
    })
    termRef.current = term
    term.open(el)
    activeTerm.current = term
    window.__DSHELL_TERM__ = term
    // Repaint the block rules after every refresh: xterm re-renders rows on
    // scroll and resize, and row elements are recreated, so the bands cannot
    // be applied once and left.
    const gutterSub = term.onRender(() => { paintGutter(term, gutterLinesRef.current) })
    // Raw keystrokes → PTY, but only while shell mode owns focus (design
    // 4.8). Ctrl+C arrives as \x03 and interrupts the foreground job; Tab,
    // arrows, and every readline key pass through untouched — the reason the
    // canvas, not the rich composer, must hold focus in shell mode.
    const dataSub = term.onData((data) => {
      if (modeRef.current === 'shell') props.pty.send(data)
    })
    // Terminal copy/paste. The shell keeps Ctrl+C for SIGINT, so copy and
    // paste ride Ctrl+Shift (Cmd+Shift on macOS), as in native terminals;
    // returning false stops xterm from also acting on the chord.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      if (!mod || !event.shiftKey) return true
      const key = event.key.toLowerCase()
      if (key === 'c') {
        const selection = term.getSelection()
        if (selection.length > 0 && navigator.clipboard !== undefined) {
          void navigator.clipboard.writeText(selection).catch(() => { /* clipboard denied */ })
        }
        return false
      }
      if (key === 'v') {
        if (navigator.clipboard !== undefined) {
          void navigator.clipboard.readText().then(
            (text) => {
              if (modeRef.current === 'shell' && text.length > 0) props.pty.send(text)
            },
            () => { /* clipboard denied */ },
          )
        }
        return false
      }
      return true
    })
    const fit = (): void => {
      const probe = probeRef.current
      if (probe === null) return
      const probeBox = probe.getBoundingClientRect()
      const charWidth = probeBox.width / 40
      // xterm measures its own cell height, which is not the probe's CSS line
      // box (16px vs 15px at this font size). Trusting the probe overshoots by
      // a row or two, and the overflow is clipped — the bottom row, i.e. the
      // live prompt, disappears under the composer. The rendered screen is the
      // truth: its height is rows × cell height.
      const screenBox = el.querySelector('.xterm-screen')?.getBoundingClientRect()
      const cellHeight = screenBox !== undefined && screenBox.height > 0 && term.rows > 0
        ? screenBox.height / term.rows
        : probeBox.height
      // The probe has no metrics until the view area gets laid out (and a
      // hidden/zero-size ancestor yields 0 or NaN). xterm's resize throws
      // "This API only accepts integers" on non-finite input, so guard.
      if (!Number.isFinite(charWidth) || charWidth <= 0) return
      if (!Number.isFinite(cellHeight) || cellHeight <= 0) return
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return
      // clientWidth/Height include this element's own padding, which the
      // screen cannot use: subtract it instead of a hand-tuned constant.
      const style = getComputedStyle(el)
      const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
      // Clamp hard: a layout feedback loop (container growing with the
      // rendered screen) would otherwise runaway to hundreds of thousands
      // of rows.
      const cols = Math.min(500, Math.max(20, Math.floor((el.clientWidth - padX) / charWidth)))
      const rows = Math.min(300, Math.max(6, Math.floor((el.clientHeight - padY) / cellHeight)))
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
      const size = sizeRef.current
      if (size !== undefined && size.cols === cols && size.rows === rows) return
      const rewrapped = size !== undefined && size.cols !== cols
      sizeRef.current = { cols, rows }
      term.resize(cols, rows)
      props.pty.resize(cols, rows)
      // A width change re-wraps the buffer, so every recorded row line shifts.
      // Redraw the merged timeline to re-anchor rows and their rules.
      if (rewrapped) mergedReplayRef.current?.()
    }
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    fit()
    const offChunk = props.pty.onChunk((sessionId, chunk) => {
      if (sessionId !== sessionIdRef.current) return
      if (chunk.replay) {
        // A replay means retention slid (clear, resync). The same command
        // also emits session events that may land just after this chunk;
        // hold row appends briefly, then redraw the merged timeline once
        // so rows don't interleave with the freshly printed prompts.
        replayPendingRef.current = true
        if (replayTimerRef.current !== undefined) clearTimeout(replayTimerRef.current)
        const replay = mergedReplayRef.current
        replayTimerRef.current = window.setTimeout(() => {
          replayTimerRef.current = undefined
          replayPendingRef.current = false
          if (replay !== undefined) replay()
          else {
            term.reset()
            gutterLinesRef.current.clear()
            const next = endsAtLineStart(chunk.text)
            if (next !== undefined) lineStartRef.current = next
            term.write(chunk.text)
          }
        }, 150)
      } else {
        const next = endsAtLineStart(chunk.text)
        if (next !== undefined) lineStartRef.current = next
        term.write(chunk.text)
      }
    })
    return () => {
      dataSub.dispose()
      gutterSub.dispose()
      offChunk()
      observer.disconnect()
      if (replayTimerRef.current !== undefined) clearTimeout(replayTimerRef.current)
      term.dispose()
      termRef.current = null
      if (activeTerm.current === term) activeTerm.current = null
      if (window.__DSHELL_TERM__ === term) delete window.__DSHELL_TERM__
      sessionIdRef.current = undefined
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the pty service and theme are stable for the dock
  }, [])

  // Session switch: reset the buffer and replay the new session's history.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    const key = props.sessionId === undefined ? undefined : String(props.sessionId)
    sessionIdRef.current = key
    // Collapse state is per session log; drop it when the log changes.
    collapsedRef.current.clear()
    rowLinesRef.current.clear()
    gutterLinesRef.current.clear()
    blockSpanRef.current.clear()
    term.reset()
    lineStartRef.current = true
    if (key !== undefined) {
      const text = props.pty.read(key)
      const next = endsAtLineStart(text)
      if (next !== undefined) lineStartRef.current = next
      term.write(text)
    }
  }, [props.sessionId, props.pty])

  // Theme follows the dock's palette.
  useEffect(() => {
    const term = termRef.current
    if (term !== null) term.options.theme = xtermTheme(theme)
  }, [theme])

  // Design 4.8: focus follows mode. Shell mode hands the keyboard to the
  // canvas so the PTY receives raw keys; agent mode blurs it (the stock
  // composer's editor is focused from DshellLeftControls). A low-frequency
  // heartbeat re-claims the keyboard whenever focus has fallen back to
  // `body` (page load, a modal closing, late stock chrome) — a deliberate
  // click on the composer or a chrome button is never stolen, because those
  // leave a real element focused.
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    if (props.mode !== 'shell') {
      term.blur()
      return
    }
    const grab = (): void => {
      if (modeRef.current !== 'shell') return
      const active = document.activeElement
      if (active === null || active === document.body) term.focus()
    }
    grab()
    const timer = window.setInterval(grab, 400)
    return () => { clearInterval(timer) }
  }, [props.mode, props.sessionId])

  // Design 4.4 merge: durable session events draw as left-ruled rows. Window
  // replace/prepend (page load, history load) replays the full merged
  // timeline — pty chunks and session rows stable-sorted by time, pty first
  // on ties; an appended event draws at its arrival position (live order).
  // A pty replay (clear, resync) redraws the same merged timeline instead of
  // a pty-only reset, or it would erase rows appended before the wipe.
  const mergedReplayRef = useRef<((keepScroll?: boolean) => void) | undefined>(undefined)
  const replayPendingRef = useRef(false)
  const replayTimerRef = useRef<number | undefined>(undefined)
  /** Explicit collapse overrides, keyed by session + row key (absent = default). */
  const collapsedRef = useRef<Map<string, boolean>>(new Map())
  /** Absolute buffer line of each row header → its collapse identity. */
  const rowLinesRef = useRef<Map<number, { key: string; collapsible: boolean; defaultCollapsed: boolean }>>(new Map())
  /** Absolute buffer line → gutter style, for each block's continuous rule. */
  const gutterLinesRef = useRef<Map<number, GutterStyle>>(new Map())
  /** Block key → the buffer lines it occupies, for the in-place repaint. */
  const blockSpanRef = useRef<Map<string, { start: number; end: number }>>(new Map())
  /** Bumped per replay so late write callbacks cannot repopulate a cleared map. */
  const replayGenRef = useRef(0)
  useEffect(() => {
    const term = termRef.current
    if (term === null || eventSource === undefined) return
    let watermark = 0
    /** The block fold, rebuilt on every full replay. */
    let fold = createFold()
    /** Coalesces live-chunk repaints so a fast stream does not rewrite per delta. */
    let streamTimer: number | undefined
    /** Per-row fold state inside an expanded block. */
    const rowCollapsed = (blockKey: string, row: SessionRow): boolean =>
      collapsedRef.current.get(`${blockKey}:${row.key}`) ?? row.defaultCollapsed
    /** A block is folded by default; only an explicit false unfolds it. */
    const blockExpanded = (blockKey: string): boolean => collapsedRef.current.get(blockKey) === false
    /**
     * Draw one block at the timeline tail. The block's rows, their rules, and
     * their click identities are all recorded after the write lands, so a
     * later click or repaint addresses the same buffer lines.
     */
    const drawBlock = (block: TurnBlock): void => {
      const gen = replayGenRef.current
      // An unterminated PTY line (a live prompt) would otherwise swallow the
      // block's first line, putting its header — and the rule over it — on top
      // of the prompt's own text.
      const prefix = lineStartRef.current ? '' : '\r\n'
      lineStartRef.current = true
      const segments = blockSegments(block, term.cols, blockExpanded(block.key), row => rowCollapsed(block.key, row))
      let start = -1
      term.write(prefix, () => {
        if (replayGenRef.current !== gen) return
        const buffer = term.buffer.active
        start = buffer.baseY + buffer.cursorY
      })
      term.write(segments.map(segment => segment.text).join(''), () => {
        if (replayGenRef.current !== gen || start < 0) return
        let line = start
        for (const segment of segments) {
          for (let index = 0; index < segmentLines(segment.text); index++) {
            rowLinesRef.current.set(line, {
              key: segment.key,
              collapsible: segment.collapsible,
              defaultCollapsed: segment.defaultCollapsed,
            })
            gutterLinesRef.current.set(line, blockGutter(block))
            line += 1
          }
        }
        blockSpanRef.current.set(block.key, { start, end: line })
        paintGutter(term, gutterLinesRef.current)
      })
    }
    /** Draw one standalone notice line (a turn's completion reminder). */
    const drawNotice = (text: string): void => {
      const gen = replayGenRef.current
      const prefix = lineStartRef.current ? '' : '\r\n'
      lineStartRef.current = true
      term.write(prefix + renderNotice(text, term.cols), () => {
        if (replayGenRef.current !== gen) return
        paintGutter(term, gutterLinesRef.current)
      })
    }
    /**
     * Rewrite a collapsed block in place. The block's rows are a fixed height
     * and the shell's rows after it must not move, so the repaint saves the
     * cursor, walks up to the block, rewrites exactly its rows, and restores —
     * no reset, no full replay. Anything it cannot reach (scrolled off, or the
     * view is not at the bottom) is left for the next full replay.
     */
    const repaintBlock = (block: TurnBlock): void => {
      if (blockExpanded(block.key)) return
      const span = blockSpanRef.current.get(block.key)
      if (span === undefined) return
      const buffer = term.buffer.active
      if (buffer.viewportY !== buffer.baseY) return
      // Walk up from the cursor to the block's FIRST row: the block's height
      // when it is at the tail, more when shell output landed after it.
      const up = buffer.baseY + buffer.cursorY - span.start
      if (up < 0 || up >= term.rows) return
      const lines = renderBlockCollapsed(block, term.cols).split('\r\n')
      if (lines.at(-1) === '') lines.pop()
      const body = `\r${lines.map(line => `${line}\u001b[K`).join('\r\n')}`
      const move = up > 0 ? `\u001b[${String(up)}A` : ''
      const gen = replayGenRef.current
      term.write(`\u001b[s${move}${body}\u001b[u`, () => {
        if (replayGenRef.current !== gen) return
        for (let index = 0; index < lines.length; index++) {
          rowLinesRef.current.set(span.start + index, { key: block.key, collapsible: true, defaultCollapsed: true })
          gutterLinesRef.current.set(span.start + index, blockGutter(block))
        }
        blockSpanRef.current.set(block.key, { start: span.start, end: span.start + lines.length })
        paintGutter(term, gutterLinesRef.current)
      })
    }
    /** Write one PTY chunk, tracking whether it left the cursor mid-line. */
    const writeChunk = (text: string): void => {
      const next = endsAtLineStart(text)
      if (next !== undefined) lineStartRef.current = next
      term.write(text)
    }
    /**
     * Coalesce live-chunk repaints: the model streams many deltas per second
     * and each repaint rewrites the block's fixed rows.
     */
    const scheduleStreamRepaint = (block: TurnBlock): void => {
      if (streamTimer !== undefined) return
      streamTimer = window.setTimeout(() => {
        streamTimer = undefined
        repaintBlock(block)
      }, 80)
    }
    const mergedReplay = (entries: readonly SessionEventLikeEntry[], keepScroll = false): void => {
      const id = sessionIdRef.current
      if (id === undefined) return
      replayGenRef.current += 1
      // A rebuild resets the buffer, which parks the viewport at the tail.
      // Folding a block must not do that: remember the top line and put it
      // back once xterm has consumed the replay's writes.
      const keepTop = keepScroll ? term.buffer.active.viewportY : undefined
      term.reset()
      lineStartRef.current = true
      rowLinesRef.current.clear()
      gutterLinesRef.current.clear()
      blockSpanRef.current.clear()
      fold = createFold()
      for (const entry of entries) {
        if (entry.type !== 'event') continue
        foldEvent(fold, entry.event)
      }
      // Blocks anchor at the request that opened them, so shell output that
      // arrives while the agent works lands after the block, never inside it.
      // The PTY side uses timed segments, not raw chunks: a bind replay is one
      // frame, and its single timestamp would bunch the whole scrollback after
      // every block instead of between them.
      const items: TimelineItem[] = []
      let order = 0
      for (const segment of props.pty.segments(id)) {
        if (segment.text.length === 0) continue
        items.push({ kind: 'pty', time: segment.time, order: order++, text: segment.text })
      }
      for (const block of fold.blocks) items.push({ kind: 'block', time: block.startedAt, order: order++, block })
      for (const notice of fold.notices) items.push({ kind: 'notice', time: notice.time, order: order++, text: notice.text })
      items.sort((left, right) => left.time - right.time || left.order - right.order)
      for (const item of items) {
        if (item.kind === 'pty') writeChunk(item.text)
        else if (item.kind === 'block') drawBlock(item.block)
        else drawNotice(item.text)
      }
      if (keepTop !== undefined) {
        // Empty write: its callback runs after every queued replay write, so
        // the buffer is complete and the scroll target is clamped correctly.
        term.write('', () => {
          term.scrollToLine(Math.min(keepTop, term.buffer.active.baseY))
        })
      }
    }
    mergedReplayRef.current = (keepScroll?: boolean) => {
      const id = sessionIdRef.current
      if (id !== undefined) mergedReplay(eventSource.getSnapshot().entries, keepScroll === true)
    }
    const render = (win: SessionEventWindow): void => {
      if (win.change.kind === 'replace' || win.change.kind === 'prepend') {
        mergedReplay(win.entries)
        // Anchor the watermark at the window's newest seq: appends then carry
        // only events the replay has not folded, and a window-wide iteration
        // can never re-fold history (which would duplicate blocks).
        watermark = maxSeq(win.entries)
        return
      }
      if (win.change.kind === 'settle-assistant') {
        // The durable message replaces the live row; drop the stream so the
        // block stops showing a half-written line.
        const open = fold.open
        if (open !== undefined && open.stream !== undefined) {
          open.stream = undefined
          repaintBlock(open)
        }
        return
      }
      for (const entry of win.entries) {
        if (entry.type === 'transient') {
          // Live streaming: keep the newest partial line inside the running
          // block so the user sees progress without waiting for the step.
          const chunk = entry.event.data.chunk
          if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') continue
          const open = fold.open
          if (open === undefined) continue
          const text = `${open.stream?.text ?? ''}${chunk.text}`
          open.stream = {
            role: chunk.type === 'reasoning-delta' ? 'reasoning' : 'assistant',
            key: 'stream',
            text,
            time: entry.event.time,
            collapsible: false,
            defaultCollapsed: false,
            ...(chunk.type === 'reasoning-delta' ? { label: '⎿ 思考过程' } : {}),
          }
          scheduleStreamRepaint(open)
          continue
        }
        const seq = entry.event.seq
        if (seq <= watermark) continue
        watermark = seq
        const before = fold.open
        foldEvent(fold, entry.event)
        if (replayPendingRef.current) continue
        const id = sessionIdRef.current
        if (id === undefined) continue
        const after = fold.open
        if (before !== undefined && before !== after) {
          // The block closed: freeze it (its final status) and append the
          // closing notice after the shell's newest line. An expanded block
          // cannot be repainted in place — its height is not fixed — so the
          // whole timeline is redrawn once instead.
          if (blockExpanded(before.key)) mergedReplayRef.current?.()
          else repaintBlock(before)
          const notice = fold.notices.at(-1)
          if (notice !== undefined && notice.time === entry.event.time && !blockExpanded(before.key)) drawNotice(notice.text)
          continue
        }
        if (after === undefined) continue
        if (after === before) repaintBlock(after)
        else drawBlock(after)
      }
    }
    render(eventSource.getSnapshot())
    const dispose = eventSource.subscribe(() => { render(eventSource.getSnapshot()) })
    return () => {
      if (streamTimer !== undefined) clearTimeout(streamTimer)
      dispose()
    }
  }, [eventSource, props.pty])

  // Click-to-collapse: map the clicked buffer line back to the row header.
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const onClick = (event: MouseEvent): void => {
      const term = termRef.current
      if (term === null) return
      const screen = el.querySelector('.xterm-screen')
      if (screen === null) return
      const box = screen.getBoundingClientRect()
      if (event.clientY < box.top || event.clientY > box.bottom) return
      // Derive the row from the rendered screen itself: the probe's font
      // metrics are close to, but not exactly, xterm's cell height, and a
      // half-pixel error lands on the neighbouring row.
      const cellHeight = box.height / term.rows
      if (!Number.isFinite(cellHeight) || cellHeight <= 0) return
      const viewportRow = Math.floor((event.clientY - box.top) / cellHeight)
      const absolute = term.buffer.active.viewportY + viewportRow
      const hit = rowLinesRef.current.get(absolute)
      if (hit === undefined || !hit.collapsible) return
      const collapsed = collapsedRef.current.get(hit.key) ?? hit.defaultCollapsed
      collapsedRef.current.set(hit.key, !collapsed)
      // Folding is a local edit: keep the reader where they were.
      mergedReplayRef.current?.(true)
    }
    el.addEventListener('click', onClick)
    return () => { el.removeEventListener('click', onClick) }
  }, [])

  return createElement('div', {
    ref,
    style: {
      position: 'absolute',
      inset: 0,
      overflow: 'hidden',
      padding: '6px 10px 2px',
      boxSizing: 'border-box',
      background: 'transparent',
    },
  },
    createElement('span', {
      ref: probeRef,
      style: {
        position: 'absolute', visibility: 'hidden', whiteSpace: 'pre',
        font: "13px 'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace",
      },
    }, 'W'.repeat(40)))
}


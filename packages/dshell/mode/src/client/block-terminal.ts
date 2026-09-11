/**
 * Terminal rendering for a shell region.
 *
 * A region is everything the terminal printed while no agent task was running:
 * prompts, command echoes and their output, in stream order. It is rendered by
 * a real xterm instance, so the terminal keeps its own design — PS1 line,
 * colours, carriage-return redraws — with no synthetic per-command chrome.
 *
 * Column count is the load-bearing decision here. The bytes were produced at
 * the PTY's width, which is not necessarily this column's width, and a
 * redraw line that does not fit gets wrapped: `\r` then returns to column 0 of
 * the *continuation* row, so every repaint consumes a row and a progress bar
 * stacks down the screen instead of overwriting itself. A region that contains
 * bare carriage returns therefore renders at least as wide as its widest line,
 * and scales its font down when that grid is wider than the column.
 */

import { Terminal as XtermTerminal } from '@xterm/xterm'
import { injectXtermCss, xtermTheme, type Theme } from './theme.js'
import { cellWidth } from './session-rows.js'

/** Hard cap on a region's rendered rows; longer output scrolls inside it. */
export const SPAN_MAX_ROWS = 220
/** Hard cap on a region's columns; wider recorded output is clipped by the grid. */
export const SPAN_MAX_COLS = 500

/** Font the regions render in. */
export const SPAN_FONT = "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace"
export const SPAN_FONT_SIZE = 13
/** Smallest font a too-wide region is scaled down to before it scrolls instead. */
export const SPAN_FONT_MIN_SIZE = 9
export const SPAN_LINE_HEIGHT = 16

/**
 * How wide each line of a region ends up, and how wide its redraws are.
 *
 * Measured by simulating the column the terminal's cursor would be on, not by
 * summing characters: progress output overwrites itself with `\r`, and tools
 * such as dpkg draw a status line in place between `ESC 7` (save cursor) and
 * `ESC 8` (restore). Counting raw characters reports those overlays as one
 * enormous line, which would stretch the grid and shrink the font for nothing.
 */
export interface RegionMetrics {
  /** Maximum column reached on each line, in cells. */
  readonly widths: readonly number[]
  /**
   * The width a redrawn stretch of a line needs, or 0 when nothing is redrawn.
   *
   * A rewind while the line is still inside the grid lands back on that line's
   * first row; a rewind after it has wrapped lands on a continuation row, so
   * every repaint falls one row lower — a progress bar stacking down the
   * screen. Only a stretch that is drawn and then drawn *again* needs the grid
   * to cover it: a line that merely rewinds once and moves on (an echo of a
   * long typed command, whose trailing carriage return only returns to the
   * start) is left to wrap, which is exactly what a terminal does with it.
   */
  readonly redrawCols: number
}

/** One pass over the text, tracking the cursor column line by line. */
export function regionMetrics(text: string): RegionMetrics {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const widths: number[] = []
  let x = 0
  let saved = 0
  let widest = 0
  let redraw = 0
  /** Widest column of the current stretch (since the last rewind). */
  let stretch = 0
  /** The two widest stretches of the line, so a repeat can be recognised. */
  let first = 0
  let second = 0
  const closeStretch = (): void => {
    if (stretch >= first) { second = first; first = stretch } else if (stretch > second) second = stretch
    stretch = 0
  }
  const endLine = (): void => {
    closeStretch()
    // Two stretches of comparable width mean the line draws the same thing (or
    // nearly the same width) more than once — a redraw, not a single wide
    // line. Only then does the grid have to cover it.
    if (second > 0 && second * 2 >= first && first > redraw) redraw = first
    widths.push(widest)
    x = 0
    saved = 0
    widest = 0
    first = 0
    second = 0
  }
  /** The cursor is about to move back over the line it is already on. */
  const rewind = (): void => { closeStretch() }
  const reach = (column: number): void => {
    if (column > widest) widest = column
    if (column > stretch) stretch = column
  }
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index) ?? 0
    if (code === 0x1b) {
      const kind = body[index + 1] ?? ''
      // Saves and restores of the cursor are what make an overlay an overlay.
      if (kind === '7') { saved = x; index += 2; continue }
      if (kind === '8') { rewind(); x = saved; index += 2; continue }
      if (kind === '[') {
        let end = index + 2
        while (end < body.length) {
          const byte = body.charCodeAt(end)
          end += 1
          if (byte >= 0x40 && byte <= 0x7e) break
        }
        const final = body[end - 1] ?? ''
        // Only the sequences that place the column matter here; movement by
        // row is the grid's business, not the width's.
        if (final === 'H' || final === 'f' || final === 'G') {
          const params = body.slice(index + 2, end - 1).split(';')
          const raw = Number.parseInt(final === 'G' ? params[0] ?? '' : params[1] ?? '', 10)
          rewind()
          x = Number.isFinite(raw) ? Math.max(0, raw - 1) : 0
        }
        index = end
        continue
      }
      if (kind === ']') {
        let end = index + 2
        while (end < body.length) {
          if (body[end] === '\u0007') { end += 1; break }
          if (body[end] === '\u001b' && body[end + 1] === '\\') { end += 2; break }
          end += 1
        }
        index = end
        continue
      }
      index += 2
      continue
    }
    if (code === 0x0d || code === 0x0a) {
      if (code === 0x0d) rewind()
      index += 1
      if (code === 0x0a) endLine()
      else x = 0
      continue
    }
    if (code === 0x08) { x = Math.max(0, x - 1); index += 1; continue }
    if (code === 0x09) { x += 8 - (x % 8); reach(x); index += 1; continue }
    x += cellWidth(code)
    reach(x)
    index += String.fromCodePoint(code).length
  }
  endLine()
  return { widths, redrawCols: redraw }
}

/**
 * Rows a region occupies at `cols`, counting the wraps it will produce.
 *
 * Counting `\n` alone undercounts a region whose lines are wider than the
 * grid, and a terminal sized to that undercount scrolls the region's own head
 * out of view.
 */
export function renderedRows(metrics: RegionMetrics, cols: number): number {
  const width = Math.max(1, cols)
  let rows = 0
  for (const cells of metrics.widths) rows += Math.max(1, Math.ceil(cells / width))
  return Math.max(1, rows)
}

/**
 * The grid a region renders at.
 *
 * A region that redraws itself must be at least as wide as its widest redraw,
 * or the wraps move the redraw's origin and a progress bar stacks one row per
 * repaint. Ordinary output keeps the column width, so one long line wraps
 * instead of stretching the whole region and shrinking its font.
 * @param metrics - the region's measured line widths.
 * @param containerCols - columns the column itself fits.
 * @returns the column count, capped at {@link SPAN_MAX_COLS}.
 */
export function regionCols(metrics: RegionMetrics, containerCols: number): number {
  const container = Math.min(SPAN_MAX_COLS, Math.max(1, containerCols))
  return Math.min(SPAN_MAX_COLS, Math.max(container, metrics.redrawCols))
}

/** Cell width of the region font at its base size, or 0 when unmeasurable. */
function measureCell(host: HTMLElement): number {
  if (typeof document === 'undefined') return 0
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${String(SPAN_FONT_SIZE)}px ${SPAN_FONT}`
  probe.textContent = 'W'.repeat(32)
  host.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width > 0 ? width / 32 : 0
}

/** Columns the column element fits, from a measured cell width. */
function containerColsOf(host: HTMLElement, cell: number): number {
  const width = host.clientWidth
  if (cell <= 0 || width <= 0) return 80
  return Math.min(SPAN_MAX_COLS, Math.max(20, Math.floor(width / cell)))
}

/**
 * Font size a region renders at: the base size, scaled down only when its grid
 * is wider than the column. Never larger than the base, never below the floor
 * (below which the region scrolls horizontally instead).
 */
function fontSizeFor(cols: number, containerCols: number): number {
  if (cols <= containerCols) return SPAN_FONT_SIZE
  const scaled = SPAN_FONT_SIZE * (containerCols / cols)
  return Math.max(SPAN_FONT_MIN_SIZE, Math.round(scaled * 10) / 10)
}

/** One shell region's terminal. */
export interface SpanTerminal {
  /** Show the region's current text; appends in place when it only grew. */
  update(text: string): void
  /** Re-measure the container and re-column. */
  fit(): void
  dispose(): void
}

/**
 * Open a terminal inside `host` and render one shell region.
 *
 * The grid is measured and settled **before** the first write: a terminal that
 * writes at a provisional width and resizes afterwards has already wrapped
 * lines it can no longer unwrap, which is what breaks carriage-return
 * redraws.
 * @param host - the region's element.
 * @param theme - the active palette.
 * @param text - the region's raw ANSI text.
 * @returns the handle to update and dispose.
 */
export function createSpanTerminal(host: HTMLElement, theme: Theme, text: string): SpanTerminal {
  injectXtermCss()
  const cell = measureCell(host)
  const containerCols = containerColsOf(host, cell)
  const metrics = regionMetrics(text)
  const cols = regionCols(metrics, containerCols)
  const term = new XtermTerminal({
    fontFamily: SPAN_FONT,
    fontSize: fontSizeFor(cols, containerCols),
    convertEol: true,
    cursorBlink: false,
    disableStdin: true,
    scrollback: 1000,
    rows: Math.min(SPAN_MAX_ROWS, renderedRows(metrics, cols)),
    cols,
    theme: xtermTheme(theme),
  })
  term.open(host)
  // xterm's default key handling ignores Ctrl+Shift+C — with `disableStdin`
  // every key is dropped, including the chord a user expects to copy the
  // highlighted selection. The browser's default copy binding is also
  // short-circuited because the focused element is xterm's helper
  // textarea, not a real text node. Install one handler that listens for
  // Ctrl+Shift+C / Ctrl+Insert and writes xterm's own selection string to
  // the clipboard. Other chords (Ctrl+C, Ctrl+V, Shift+Insert, …) keep
  // their default behaviour — `disableStdin` already drops anything that
  // would type a character, and the shell-mode composer is the one that
  // owns those chords anyway.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.shiftKey && (event.key === 'C' || event.code === 'KeyC')) {
      const text = term.getSelection()
      if (text.length === 0) return false
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(text)
      }
      // Returning false tells xterm not to forward the chord to the PTY;
      // the chord has been handled here.
      return false
    }
    return true
  })
  let last = ''
  // Geometry follows the text and the column: the grid spans the column, and
  // widens only as far as a redraw needs. Growing it cannot move a redraw's
  // origin and shrinking it stops at that redraw's width, so a `\r` line stays
  // on one row in both directions.
  const update = (next: string): void => {
    const available = containerColsOf(host, cell)
    const nextMetrics = regionMetrics(next)
    const nextCols = regionCols(nextMetrics, available)
    const nextFont = fontSizeFor(nextCols, available)
    const nextRows = Math.min(SPAN_MAX_ROWS, renderedRows(nextMetrics, nextCols))
    if (nextFont !== term.options.fontSize) term.options.fontSize = nextFont
    if (nextCols !== term.cols || nextRows !== term.rows) term.resize(nextCols, nextRows)
    if (last.length > 0 && next.startsWith(last)) {
      // The region only grew (a command is still printing): append, so the
      // terminal keeps its scroll position and the redraw stays cheap.
      term.write(next.slice(last.length))
    } else {
      term.reset()
      term.write(next)
    }
    last = next
  }
  update(text)
  // Debug handle: `window.__DSHELL_TERMS__` lists the live xterm instances
  // for headless verification. Cleared on dispose so closed terminals do
  // not pile up.
  if (typeof window !== 'undefined') {
    const handle = ((window as unknown as { __DSHELL_TERMS__?: Set<unknown> }).__DSHELL_TERMS__ ??= new Set()) as Set<unknown>
    handle.add(term)
  }
  return {
    update,
    // A container resize is not a text change: re-run the geometry pass only,
    // which reflows what is already in the buffer instead of rewriting it.
    fit: () => { update(last) },
    dispose: () => {
      term.dispose()
      if (typeof window !== 'undefined') {
        const handle = (window as unknown as { __DSHELL_TERMS__?: Set<unknown> }).__DSHELL_TERMS__
        if (handle !== undefined) handle.delete(term)
      }
    },
  }
}

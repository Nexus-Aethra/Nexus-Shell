/**
 * Terminal rendering for a shell region.
 *
 * A region is everything the terminal printed while no agent task was running:
 * prompts, command echoes and their output, in stream order. It is rendered by
 * a real xterm instance, so the terminal keeps its own design — PS1 line,
 * colours, carriage-return redraws — with no synthetic per-command chrome.
 */

import { Terminal as XtermTerminal } from '@xterm/xterm'
import { injectXtermCss, xtermTheme, type Theme } from './theme.js'

/** Hard cap on a region's rendered rows; longer output scrolls inside it. */
export const SPAN_MAX_ROWS = 220

/** Lines a piece of text occupies, ignoring the newline that closes the last. */
export function lineCount(text: string): number {
  if (text.length === 0) return 1
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body.length === 0) return 1
  let lines = 1
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\n') lines += 1
  }
  return lines
}

/** Font the regions render in. */
export const SPAN_FONT = "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace"
export const SPAN_FONT_SIZE = 13
export const SPAN_LINE_HEIGHT = 16

/** One shell region's terminal. */
export interface SpanTerminal {
  /** Show the region's current text; appends in place when it only grew. */
  update(text: string): void
  /** Re-measure the container width and re-column. */
  fit(): void
  dispose(): void
}

/**
 * Open a terminal inside `host` and render one shell region.
 * @param host - the region's element.
 * @param theme - the active palette.
 * @param text - the region's raw ANSI text.
 * @returns the handle to update and dispose.
 */
export function createSpanTerminal(host: HTMLElement, theme: Theme, text: string): SpanTerminal {
  injectXtermCss()
  const term = new XtermTerminal({
    fontFamily: SPAN_FONT,
    fontSize: SPAN_FONT_SIZE,
    convertEol: true,
    cursorBlink: false,
    disableStdin: true,
    scrollback: 1000,
    rows: Math.min(lineCount(text), SPAN_MAX_ROWS),
    cols: 80,
    theme: xtermTheme(theme),
  })
  term.open(host)
  let last = ''
  const fit = (): void => {
    const width = host.clientWidth
    if (width <= 0 || term.cols <= 0) return
    const screen = host.querySelector('.xterm-screen')
    const box = screen?.getBoundingClientRect()
    const cellWidth = box !== undefined && box.width > 0 ? box.width / term.cols : 0
    if (!Number.isFinite(cellWidth) || cellWidth <= 0) return
    const cols = Math.min(500, Math.max(20, Math.floor(width / cellWidth)))
    if (cols !== term.cols) term.resize(cols, term.rows)
  }
  const update = (next: string): void => {
    if (next === last) return
    const rows = Math.min(lineCount(next), SPAN_MAX_ROWS)
    if (last.length > 0 && next.startsWith(last)) {
      // The region only grew (a command is still printing): append, so the
      // terminal keeps its scroll position and the redraw stays cheap.
      term.write(next.slice(last.length))
    } else {
      term.reset()
      term.write(next)
    }
    last = next
    if (rows !== term.rows) term.resize(term.cols, Math.max(1, rows))
    fit()
  }
  update(text)
  fit()
  return { update, fit, dispose: () => { term.dispose() } }
}

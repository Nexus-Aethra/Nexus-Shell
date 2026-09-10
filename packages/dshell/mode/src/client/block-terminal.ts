/**
 * Terminal pool for the block view.
 *
 * Every shell block renders its own xterm instance rather than a
 * re-implementation of ANSI: the block view is a DOM column, but the fidelity
 * problem stays solved by the real emulator. Instances are cheap enough for
 * the visible window and are capped by the caller.
 *
 * A block's terminal is opened with `scrollback: 0`, so when the output is
 * taller than the block's `rows` the buffer keeps the newest lines — that is
 * exactly the collapsed "tail" presentation, with no slicing.
 */

import { Terminal as XtermTerminal } from '@xterm/xterm'
import { injectXtermCss, xtermTheme, type Theme } from './theme.js'

/** Rows a collapsed shell block shows before it is expanded. */
export const BLOCK_ROWS_COLLAPSED = 10

/** Hard cap on an expanded block's rows; the tail beyond it scrolls away. */
export const BLOCK_ROWS_EXPANDED = 400

/** Font metrics the block view and the terminal must agree on. */
export const BLOCK_FONT = "'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace"
export const BLOCK_FONT_SIZE = 13

/** Lines of text a slice would occupy, for sizing its terminal. */
export function lineCount(text: string): number {
  if (text.length === 0) return 1
  // A trailing newline closes the last line; it does not open an empty one.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body.length === 0) return 1
  let lines = 1
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\n') lines += 1
  }
  return lines
}

/** Rows to open a block's terminal with, given its content and fold state. */
export function blockRows(text: string, expanded: boolean): number {
  const lines = lineCount(text)
  const cap = expanded ? BLOCK_ROWS_EXPANDED : BLOCK_ROWS_COLLAPSED
  return Math.max(1, Math.min(lines, cap))
}

/** One block's terminal and the element it lives in. */
export interface BlockTerminal {
  /** Write (or rewrite) the block's content. */
  render(text: string, rows: number): void
  /** Re-measure the container: width in cells and the font's cell height. */
  fit(): { cols: number; rows: number } | undefined
  dispose(): void
}

/**
 * Create a terminal inside `host` and render `text` into it.
 * @param host - the block body element, owned by the caller's layout.
 * @param theme - the active palette.
 * @param text - the slice to render (raw ANSI).
 * @param rows - how many rows the block should occupy.
 * @returns the handle the caller disposes on unmount.
 */
export function createBlockTerminal(host: HTMLElement, theme: Theme, text: string, rows: number): BlockTerminal {
  injectXtermCss()
  const term = new XtermTerminal({
    fontFamily: BLOCK_FONT,
    fontSize: BLOCK_FONT_SIZE,
    convertEol: true,
    cursorBlink: false,
    disableStdin: true,
    scrollback: 0,
    rows,
    cols: 80,
    theme: xtermTheme(theme),
  })
  term.open(host)
  let last = ''
  let lastRows = rows
  const fit = (): { cols: number; rows: number } | undefined => {
    const width = host.clientWidth
    if (width <= 0) return undefined
    // Measure the real cell from the rendered screen, as the canvas does: the
    // probe's CSS line box is not xterm's cell height.
    const screen = host.querySelector('.xterm-screen')
    const box = screen?.getBoundingClientRect()
    const cellWidth = box !== undefined && term.cols > 0 ? box.width / term.cols : 0
    if (!Number.isFinite(cellWidth) || cellWidth <= 0) return undefined
    const cols = Math.min(500, Math.max(20, Math.floor(width / cellWidth)))
    if (cols === term.cols && lastRows === term.rows) return { cols, rows: term.rows }
    term.resize(cols, Math.min(500, Math.max(1, lastRows)))
    return { cols, rows: term.rows }
  }
  const render = (next: string, nextRows: number): void => {
    if (next === last && nextRows === lastRows) return
    last = next
    lastRows = nextRows
    fit()
    term.reset()
    term.resize(term.cols, Math.max(1, Math.min(nextRows, BLOCK_ROWS_EXPANDED)))
    term.write(next)
  }
  render(text, rows)
  return {
    render,
    fit,
    dispose: () => { term.dispose() },
  }
}

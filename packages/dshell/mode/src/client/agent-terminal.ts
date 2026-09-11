/**
 * A read-only terminal showing the agent's own shell.
 *
 * This is the window the task card opens onto what the AI is doing: the same
 * bytes the agent's PTY produced, rendered by a real terminal, so a command it
 * runs looks the way it looks to the agent. The view is a *window*, not a
 * mirror: the shell keeps a full terminal's rows (a full-screen program needs
 * them) while the panel draws a fixed short grid and scrolls, and only the
 * width is negotiated — the panel tells the host how wide it is so the shell
 * wraps the way the reader sees it.
 *
 * It carries no input: the agent owns this terminal. The only key it handles is
 * the copy chord, because a selection nobody can copy out is useless.
 */

import { Terminal as XtermTerminal } from '@xterm/xterm'
import { injectXtermCss, xtermTheme, type Theme } from './theme.js'
import { SPAN_FONT } from './block-terminal.js'

/** Rows the panel draws; the agent's shell keeps its own, larger, row count. */
export const AGENT_PANEL_ROWS = 12
/** Font the panel renders at — a notch smaller than the timeline's regions. */
const AGENT_FONT_SIZE = 12
const AGENT_LINE_HEIGHT = 15
/** How much scrollback the panel keeps behind the visible rows. */
const AGENT_SCROLLBACK = 2000

/** Handle on one panel terminal. */
export interface AgentTerminalView {
  /** Show the shell's current text; appends when it only grew. */
  update(text: string): void
  /** Re-measure the container: re-column and reflow in place. */
  fit(): void
  /** The grid's current column count. */
  cols(): number
  dispose(): void
}

/** Cell width of the panel font, from a hidden probe, or 0 when unmeasurable. */
function measureCell(host: HTMLElement): number {
  if (typeof document === 'undefined') return 0
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${String(AGENT_FONT_SIZE)}px ${SPAN_FONT}`
  probe.textContent = 'W'.repeat(32)
  host.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width > 0 ? width / 32 : 0
}

/** Columns the panel's box fits, or 0 while it is hidden (no width yet). */
function colsOf(host: HTMLElement, cell: number): number {
  const width = host.clientWidth
  if (cell <= 0 || width <= 0) return 0
  return Math.max(20, Math.min(500, Math.floor(width / cell)))
}

/**
 * Open a terminal inside `host` and render the agent shell into it.
 * @param host - the panel's terminal element.
 * @param theme - the active palette.
 * @param onCols - called whenever the grid's width changes, so the host can
 *   wrap the shell's output at the same width.
 * @returns the handle to update, refit and dispose.
 */
export function createAgentTerminal(
  host: HTMLElement,
  theme: Theme,
  onCols?: (cols: number) => void,
): AgentTerminalView {
  injectXtermCss()
  const cell = measureCell(host)
  const measured = colsOf(host, cell)
  const term = new XtermTerminal({
    fontFamily: SPAN_FONT,
    fontSize: AGENT_FONT_SIZE,
    convertEol: true,
    cursorBlink: true,
    disableStdin: true,
    scrollback: AGENT_SCROLLBACK,
    rows: AGENT_PANEL_ROWS,
    cols: measured > 0 ? measured : 80,
    theme: xtermTheme(theme),
  })
  term.open(host)
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.shiftKey && (event.key === 'C' || event.code === 'KeyC')) {
      const text = term.getSelection()
      if (text.length === 0) return false
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(text)
      }
      return false
    }
    return true
  })
  if (measured > 0) onCols?.(measured)
  let last = ''
  const update = (text: string): void => {
    const width = colsOf(host, cell)
    // A hidden panel measures nothing; resizing the shell to a width nobody
    // can see would re-wrap the agent's output for a view that is not there.
    if (width > 0 && width !== term.cols) {
      term.resize(width, AGENT_PANEL_ROWS)
      onCols?.(width)
    }
    if (last.length > 0 && text.startsWith(last)) {
      // The shell only printed more: append, so the reader's scroll position
      // and the incremental path both survive.
      term.write(text.slice(last.length))
    } else {
      term.reset()
      term.write(text)
    }
    last = text
    term.scrollToBottom()
  }
  return {
    update,
    fit: () => { update(last) },
    cols: () => term.cols,
    dispose: () => { term.dispose() },
  }
}

/** The panel's line height, for sizing the element that holds it. */
export const AGENT_PANEL_HEIGHT = AGENT_PANEL_ROWS * AGENT_LINE_HEIGHT

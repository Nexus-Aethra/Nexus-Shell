/**
 * dshell-mode browser face — Phase 5 (fused terminal dock).
 *
 * The dock is dshell's primary surface: it shadows the stock composer bar
 * (`conversation.composer.bar`, priority -1 — lowest renders) and replaces
 * the chat-shaped InputBar with a single full-bleed terminal-style column:
 * the main PTY scrollback streams above a monospace input line at the
 * bottom. Mode chip + model chip + theme chip live inline with the input.
 *
 * Per-session mode routes Enter — `shell` forwards the line to the
 * bridge-owned main PTY through the terminal-bridge ws client; `agent`
 * submits through the session's Conversation service (dsh's real
 * queued-turn pipeline). `/agent` and `/shell` (alias `/terminal`)
 * prefixes switch the mode — bare they only toggle, with a payload they
 * dispatch immediately. The mode resets to `shell` for every new
 * session (per-session stores keyed by SessionId).
 *
 * The dock renders its model chip directly over `ctx.modelDirectories`
 * (the same per-session directory the /model popup reads, so both stay
 * in sync). It cannot go through the stock `conversation.input.model`
 * seat: a child hole has exactly one declarer and the shadowed
 * composer-bar entry already declared it, so renderSlot from the
 * shadowing entry would be unauthorized.
 *
 * Themes: four palettes (midnight, solarized, dracula, monochrome) re-skin
 * the dock's CSS variables AND the bash prompt colors (the bridge reads
 * the active theme from a localStorage key the dock writes when the
 * theme changes, via a follow-up `export PS1=...` send).
 */

import {
  Component,
  createElement,
  useEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'
import { type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ModelProviderGroup,
  ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  ISessions,
  SessionEventLike,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Conversation SlotMap (input.left / composer.dock seats).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) and the
// generic SlotMap interface that constrains the `inject` name string.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Terminal as XtermTerminal, type ITheme } from '@xterm/xterm'
import { XTERM_CSS } from './xterm-css.js'
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const name = '@deepseek-ai/dsh-dshell-mode/client'

export const inject = ['slots', 'sessions', 'dshellPtyStream', 'modelDirectories'] as const

/** Per-message routing mode for one session. */
export type SessionMode = 'shell' | 'agent'

/** Read-only face of ctx.modelDirectories the dock's model chip needs. */
interface ModelDirectoryFace {
  store: SnapshotStore<ModelDirectoryState>
  load: () => Promise<unknown>
  select: (selection: ModelSelection) => Promise<unknown>
}

/** Snapshot of one session's shared model directory (see ui-model-selection). */
interface ModelDirectoryState {
  current: ModelSelection | null
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

/** Model chip face for one session. */
interface ModelChipFace {
  directory: SnapshotStore<ModelDirectoryState>
  load: () => void
  select: (selection: ModelSelection) => Promise<boolean>
}

/** Strip dsh's prompt-protocol OSC markers (133;D + 133;A/B/C + OSC 1337 sequences). */
/** Theme registry. `accent` colors the active-mode chip + prompt glyph; `user` / `path` color the bash PS1 segments. */
interface Theme {
  readonly id: string
  readonly label: string
  readonly bg: string
  readonly text: string
  readonly muted: string
  readonly border: string
  readonly borderStrong: string
  readonly inputBar: string
  readonly accent: string
  readonly accentText: string
  readonly accentBorder: string
  readonly accentFaint: string
  readonly menuBg: string
  readonly menuBorder: string
  /** Bash PS1 ANSI SGR for the user@host segment. */
  readonly ps1User: string
  /** Bash PS1 ANSI SGR for the path segment. */
  readonly ps1Path: string
}

const THEMES: readonly Theme[] = [
  {
    id: 'midnight',
    label: '午夜',
    bg: 'transparent',
    text: '#e8e8ec',
    muted: '#9d9da6',
    border: '#1c1d22',
    borderStrong: '#2c2c33',
    inputBar: 'rgba(8, 8, 11, 0.6)',
    accent: '#7c3aed',
    accentText: '#cbb5ff',
    accentBorder: '#4c2a8a',
    accentFaint: 'rgba(124, 58, 237, 0.12)',
    menuBg: '#131418',
    menuBorder: '#2a2b31',
    ps1User: '1;32',
    ps1Path: '1;34',
  },
  {
    id: 'solarized',
    label: '柔和',
    bg: 'transparent',
    text: '#93a1a1',
    muted: '#657b83',
    border: '#0f3a44',
    borderStrong: '#268bd2',
    inputBar: 'rgba(7, 38, 43, 0.55)',
    accent: '#b58900',
    accentText: '#fdf6e3',
    accentBorder: '#8a6a00',
    accentFaint: 'rgba(181, 137, 0, 0.14)',
    menuBg: '#002b36',
    menuBorder: '#0f3a44',
    ps1User: '1;33',
    ps1Path: '1;32',
  },
  {
    id: 'dracula',
    label: '神秘',
    bg: 'transparent',
    text: '#f8f8f2',
    muted: '#6272a4',
    border: '#44475a',
    borderStrong: '#6272a4',
    inputBar: 'rgba(40, 42, 54, 0.6)',
    accent: '#ff79c6',
    accentText: '#ffb3da',
    accentBorder: '#bd4188',
    accentFaint: 'rgba(255, 121, 198, 0.14)',
    menuBg: '#282a36',
    menuBorder: '#44475a',
    ps1User: '1;35',
    ps1Path: '1;36',
  },
  {
    id: 'forest',
    label: '森林',
    bg: 'transparent',
    text: '#d0d7c5',
    muted: '#8a9a76',
    border: '#1f2e1c',
    borderStrong: '#4a6b3a',
    inputBar: 'rgba(15, 25, 18, 0.6)',
    accent: '#7fb069',
    accentText: '#bce09a',
    accentBorder: '#4a6b3a',
    accentFaint: 'rgba(127, 176, 105, 0.14)',
    menuBg: '#141c14',
    menuBorder: '#2a3a26',
    ps1User: '1;32',
    ps1Path: '1;33',
  },
]

const DEFAULT_THEME_ID = 'midnight'

function getTheme(id: string): Theme {
  return THEMES.find(t => t.id === id) ?? THEMES[0]!
}

const THEME_STORAGE_KEY = 'dshell.theme'

/** Module-level theme store; single subscription feeds every dock instance. */
const themeStore = createSnapshotStore<string>(
  (() => {
    if (typeof localStorage === 'undefined') return DEFAULT_THEME_ID
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      return getTheme(stored ?? DEFAULT_THEME_ID).id
    } catch {
      return DEFAULT_THEME_ID
    }
  })(),
)

function setTheme(id: string): void {
  const theme = getTheme(id)
  themeStore.set(theme.id)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme.id) } catch { /* ignore */ }
  }
}

/** Public setter used by dshell-settings; kept here so the theme registry
 * stays the single source of truth (the host bridge also reads it to
 * re-issue the bash PS1 after a palette change). */
export { setTheme }

/** Read the current theme id (used by dshell-settings + host). */
export function currentThemeId(): string {
  return themeStore.getSnapshot()
}

/** Subscribe to theme changes (used by dshell-settings + host). */
export function subscribeTheme(listener: () => void): () => void {
  return themeStore.subscribe(listener)
}

const modeChipStyle: CSSProperties = {
  border: '1px solid var(--dshell-border-strong)',
  background: 'transparent',
  color: 'var(--dshell-muted)',
  cursor: 'pointer',
  borderRadius: 999,
  padding: '3px 10px',
  fontSize: 11,
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
  transition: 'color 120ms, border-color 120ms',
}
const chipSeatStyle: CSSProperties = { position: 'relative', display: 'flex' }

let xtermCssInjected = false

/** The combo loader serves one client.js per plugin — inject the stylesheet at runtime. */
function injectXtermCss(): void {
  if (xtermCssInjected) return
  xtermCssInjected = true
  const style = document.createElement('style')
  // xterm's own CSS leaves the viewport opaque in some renderers; force the
  // whole terminal tree transparent so the canvas blends with the app
  // surface instead of painting a black card.
  style.textContent = `${XTERM_CSS}\n.xterm,.xterm-viewport,.xterm-screen,.xterm-scrollable-element{background-color:transparent !important;}`
  document.head.append(style)
}

/** Map a dock theme palette onto the xterm renderer. The background stays
 * fully transparent (8-digit hex is what xterm's parser reliably accepts)
 * so the terminal blends with the app surface. */
function xtermTheme(theme: Theme): ITheme {
  return {
    background: '#00000000',
    foreground: theme.text,
    cursor: theme.accent,
    cursorAccent: '#00000000',
    selectionBackground: theme.accentFaint,
    selectionForeground: theme.text,
  }
}

/** A durable session event worth drawing into the canvas (4.4 merge). */
interface SessionRow {
  readonly role: 'user' | 'assistant' | 'tool' | 'command'
  /** Identity within the session log (type + seq), for collapse state. */
  readonly key: string
  /** Full display text; may span lines. */
  readonly text: string
  /** Whether the row offers a collapse toggle (long agent/tool records). */
  readonly collapsible: boolean
}

/** Line count above which a row starts collapsed in the merged timeline. */
const COLLAPSE_THRESHOLD: Record<SessionRow['role'], number> = {
  user: Number.POSITIVE_INFINITY,
  assistant: 10,
  tool: 3,
  command: Number.POSITIVE_INFINITY,
}

function messageText(content: readonly unknown[] | undefined): string {
  return (content ?? [])
    .map((block) => typeof block === 'object' && block !== null && 'text' in block
      ? String((block as { text: unknown }).text)
      : '')
    .join('')
}

function rowOf(
  role: SessionRow['role'],
  type: string,
  seq: number,
  text: string,
): SessionRow | null {
  const body = text.replace(/\n+$/, '')
  if (body.trim().length === 0) return null
  const lines = body.split('\n').length
  return {
    role,
    key: `${type}:${seq}`,
    text: body,
    collapsible: lines > COLLAPSE_THRESHOLD[role],
  }
}

/** Extract one displayable row from a durable Session event. */
function sessionRowOf(event: SessionEventLike): SessionRow | null {
  if (event.type === 'user/message') {
    const text = messageText(event.data.content)
    // The Phase 7 context block rides inside the user message; show only
    // the user's own words beneath it.
    const stripped = /^\[dshell 终端上下文\][\s\S]*?```\n([\s\S]*)$/.exec(text)
    return rowOf('user', event.type, event.seq, stripped === null ? text : (stripped[1] ?? ''))
  }
  if (event.type === 'assistant/message') {
    return rowOf('assistant', event.type, event.seq, messageText(event.data.message.content))
  }
  if (event.type === 'tool/result') {
    return rowOf('tool', event.type, event.seq, messageText(event.data.message.content))
  }
  if (event.type === 'command/done') {
    const outcome = event.data.kind === 'error' ? `失败:${event.data.text ?? ''}` : (event.data.text ?? '')
    return rowOf('command', event.type, event.seq, outcome.trim().length === 0 ? '完成' : outcome)
  }
  if (event.type === 'command/run') {
    const args = event.data.args
    const text = args === undefined || args === '' ? event.data.name : `${event.data.name} ${args}`
    return rowOf('command', event.type, event.seq, text)
  }
  return null
}

const SESSION_ROW_COLOR: Record<SessionRow['role'], string> = {
  user: '\u001b[36m',
  assistant: '\u001b[90m',
  tool: '\u001b[90m',
  command: '\u001b[33m',
}

const SESSION_ROW_LABEL: Record<SessionRow['role'], string> = {
  user: '┃ 你',
  assistant: '┃ AI',
  tool: '┃✦ 工具',
  command: '┃⚡ 命令',
}

/**
 * Draw one session row as `┃`-margined lines (design 4.4). Long records
 * render collapsed to their first line plus a toggle hint; the caller
 * records the header's buffer line so a click can flip the state.
 * @param term - target terminal.
 * @param row - the row to draw.
 * @param collapsed - whether the body is hidden.
 * @returns the absolute buffer line of the header, or null when skipped.
 */
function writeSessionRow(term: XtermTerminal, row: SessionRow, collapsed: boolean): number | null {
  const color = SESSION_ROW_COLOR[row.role]
  const reset = '\u001b[0m'
  const dim = '\u001b[2m'
  const lines = row.text.split('\n')
  const summary = lines[0] ?? ''
  const rest = lines.slice(1)
  const buffer = term.buffer.active
  const headerLine = buffer.baseY + buffer.cursorY
  const hint = row.collapsible
    ? collapsed
      ? ` ${dim}[+${String(rest.length)} 行 ▸ 点击展开]${reset}`
      : ` ${dim}[▾ 点击收起]${reset}`
    : ''
  term.write(`${color}${SESSION_ROW_LABEL[row.role]}${reset} ${summary}${hint}\r\n`)
  if (!collapsed) {
    for (const line of rest) term.write(`${color}┃${reset} ${line}\r\n`)
  }
  return headerLine
}

/** The xterm.js canvas: raw ANSI stream + session events merged (4.4). */
function PtyCanvas(props: {
  pty: PtyStreamService
  sessions: ISessions
  sessionId: SessionId | undefined
  theme: Theme
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XtermTerminal | null>(null)
  const probeRef = useRef<HTMLSpanElement | null>(null)
  const sizeRef = useRef<{ cols: number; rows: number } | undefined>(undefined)
  const sessionIdRef = useRef<string | undefined>(undefined)
  const theme = props.theme
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
    const fit = (): void => {
      const probe = probeRef.current
      if (probe === null) return
      const probeBox = probe.getBoundingClientRect()
      const charWidth = probeBox.width / 40
      const lineHeight = probeBox.height
      // The probe has no metrics until the view area gets laid out (and a
      // hidden/zero-size ancestor yields 0 or NaN). xterm's resize throws
      // "This API only accepts integers" on non-finite input, so guard.
      if (!Number.isFinite(charWidth) || charWidth <= 0) return
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return
      lineHeightRef.current = lineHeight
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return
      // Clamp hard: a layout feedback loop (container growing with the
      // rendered screen) would otherwise runaway to hundreds of thousands
      // of rows.
      const cols = Math.min(500, Math.max(20, Math.floor((el.clientWidth - 8) / charWidth)))
      const rows = Math.min(300, Math.max(6, Math.floor((el.clientHeight - 12) / lineHeight)))
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
      const size = sizeRef.current
      if (size !== undefined && size.cols === cols && size.rows === rows) return
      sizeRef.current = { cols, rows }
      term.resize(cols, rows)
      props.pty.resize(cols, rows)
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
            term.write(chunk.text)
          }
        }, 150)
      } else {
        term.write(chunk.text)
      }
    })
    return () => {
      offChunk()
      observer.disconnect()
      if (replayTimerRef.current !== undefined) clearTimeout(replayTimerRef.current)
      term.dispose()
      termRef.current = null
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
    term.reset()
    if (key !== undefined) term.write(props.pty.read(key))
  }, [props.sessionId, props.pty])

  // Theme follows the dock's palette.
  useEffect(() => {
    const term = termRef.current
    if (term !== null) term.options.theme = xtermTheme(theme)
  }, [theme])

  // Design 4.4 merge: durable session events draw as dimmed ┃ rows. Window
  // replace/prepend (page load, history load) replays the full merged
  // timeline — pty chunks and session rows stable-sorted by time, pty first
  // on ties; an appended event draws at its arrival position (live order).
  // A pty replay (clear, resync) redraws the same merged timeline instead of
  // a pty-only reset, or it would erase rows appended before the wipe.
  const mergedReplayRef = useRef<(() => void) | undefined>(undefined)
  const replayPendingRef = useRef(false)
  const replayTimerRef = useRef<number | undefined>(undefined)
  /** Rows the user collapsed, keyed by session + row key. */
  const collapsedRef = useRef<Set<string>>(new Set())
  /** Absolute buffer line of each row header → its collapse identity. */
  const rowLinesRef = useRef<Map<number, { key: string; collapsible: boolean }>>(new Map())
  const lineHeightRef = useRef(18)
  useEffect(() => {
    const term = termRef.current
    if (term === null || eventSource === undefined) return
    let watermark = 0
    const drawRow = (id: string, row: SessionRow): void => {
      const key = `${id}:${row.key}`
      const line = writeSessionRow(term, row, collapsedRef.current.has(key))
      if (line !== null) rowLinesRef.current.set(line, { key, collapsible: row.collapsible })
    }
    const mergedReplay = (entries: readonly SessionEventLikeEntry[]): void => {
      const id = sessionIdRef.current
      if (id === undefined) return
      term.reset()
      rowLinesRef.current.clear()
      const rows: { time: number; kind: 'pty' | 'session'; payload: string | SessionRow }[] = []
      for (const chunk of props.pty.chunks(id)) {
        if (chunk.text.length === 0) continue
        rows.push({ time: chunk.time, kind: 'pty', payload: chunk.text })
      }
      for (const entry of entries) {
        if (entry.type !== 'event') continue
        const row = sessionRowOf(entry.event)
        if (row === null) continue
        rows.push({ time: entry.event.time, kind: 'session', payload: row })
      }
      rows.sort((a, b) => a.time - b.time || (a.kind === 'pty' ? -1 : 1))
      for (const item of rows) {
        if (item.kind === 'pty') term.write(item.payload as string)
        else drawRow(id, item.payload as SessionRow)
      }
    }
    mergedReplayRef.current = () => {
      const id = sessionIdRef.current
      if (id !== undefined) mergedReplay(eventSource.getSnapshot().entries)
    }
    const render = (win: SessionEventWindow): void => {
      if (win.change.kind === 'replace' || win.change.kind === 'prepend') {
        watermark = 0
        mergedReplay(win.entries)
      } else {
        for (const entry of win.entries) {
          const seq = entry.event.seq
          if (seq <= watermark) continue
          watermark = seq
          if (entry.type !== 'event') continue
          const row = sessionRowOf(entry.event)
          if (row !== null) {
            // While a replay redraw is pending the row belongs to the same
            // transaction as the wipe — the redraw draws it in time order.
            if (replayPendingRef.current) continue
            const id = sessionIdRef.current
            if (id === undefined) continue
            // The cursor usually sits mid-line (after a live prompt); rows
            // are log entries and always start on their own line.
            if (term.buffer.active.cursorX > 0) term.write('\r\n')
            drawRow(id, row)
          }
        }
      }
    }
    render(eventSource.getSnapshot())
    return eventSource.subscribe(() => { render(eventSource.getSnapshot()) })
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
      const viewportRow = Math.floor((event.clientY - box.top) / lineHeightRef.current)
      const absolute = term.buffer.active.viewportY + viewportRow
      const hit = rowLinesRef.current.get(absolute)
      if (hit === undefined || !hit.collapsible) return
      if (collapsedRef.current.has(hit.key)) collapsedRef.current.delete(hit.key)
      else collapsedRef.current.add(hit.key)
      mergedReplayRef.current?.()
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

/** Standard stock props this entry receives from the composer bar owner. */
interface DshellInputStandardProps {
  /** Live composer state (draft text) — the submit router reads it. */
  useInput?: <S>(sel: (state: { draft: string }) => S, eq?: (a: S, b: S) => boolean) => S
  /** Programmatic draft writes (the router clears the composer after a shell send). */
  inputActions?: { setDraft(text: string): void }
}

/**
 * Compact dshell controls rendered into the stock composer's
 * `conversation.input.left` slot, plus the dual-mode submit router.
 *
 * Mode is a per-session store (`shell` | `agent`, default `shell`):
 *  - `agent` — the stock composer behaves exactly like dsh: Enter runs
 *    the command adjudication / sends the prompt, `/` and `@` popups,
 *    model select, context ring, attachments all untouched.
 *  - `shell` — Enter (and the stock send button) is captured and the
 *    draft goes to the bridge-owned main PTY instead of the model. A
 *    leading `/` is left to the stock command pipeline in both modes
 *    (`/clear`, `/new`, skills), so the composer's command surface keeps
 *    working. The stock internals expose no submit hook for plain text
 *    (`matchEnter` is only polled for trigger-prefixed lines), so the
 *    router is a capture-phase listener on the composer card that reads
 *    the draft from the stock input store and clears it through
 *    `inputActions`.
 */
function DshellLeftControls(props: {
  sessionId: SessionId | undefined
  mode: SnapshotStore<SessionMode> | undefined
  pty: PtyStreamService | undefined
  setMode(next: SessionMode): void
  submitShell(text: string): void
} & DshellInputStandardProps): ReactElement | null {
  const mode = useSyncExternalStore(
    props.mode?.subscribe ?? (() => () => {}),
    props.mode?.getSnapshot ?? (() => 'shell' as SessionMode),
  )
  // Latest draft, kept in a ref so the DOM-level listener reads it
  // without re-subscribing on every keystroke.
  const draft = props.useInput?.(state => state.draft) ?? ''
  const draftRef = useRef(draft)
  draftRef.current = draft
  const modeRef = useRef(mode)
  modeRef.current = mode
  const pty = props.pty
  const sendShell = props.submitShell
  const clearDraft = props.inputActions?.setDraft

  useEffect(() => {
    if (pty === undefined || clearDraft === undefined) return
    const route = (): boolean => {
      if (modeRef.current !== 'shell') return false
      const text = draftRef.current
      if (text.trim().length === 0) return false
      // A leading slash belongs to the stock command/trigger pipeline
      // (`/clear`, `/new`, skills, …) in both modes — never to bash.
      if (text.trimStart().startsWith('/')) return false
      sendShell(text)
      clearDraft('')
      return true
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      const target = event.target
      if (!(target instanceof Element) || target.closest('[data-composer-card]') === null) return
      if (!route()) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[class*="_primary"]') === null) return
      if (target.closest('[data-composer-card]') === null) return
      if (!route()) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('click', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('click', onPointerDown, true)
    }
  }, [pty, sendShell, clearDraft])

  if (props.sessionId === undefined) return null
  const next: SessionMode = mode === 'shell' ? 'agent' : 'shell'
  const glyph = mode === 'shell' ? '$' : '✦'
  const label = mode === 'shell' ? 'shell' : 'agent'
  return createElement('div', { style: chipSeatStyle },
    createElement('button', {
      style: modeChipStyle,
      title: mode === 'shell' ? '当前:shell 模式,Enter 直接执行命令' : '当前:对话模式,Enter 发送给 AI',
      onClick: () => { props.setMode(next) },
    }, `${glyph} ${label}`),
    createElement('div', { style: { color: 'var(--dshell-muted, #9d9da6)', fontSize: 12, marginLeft: 8 } },
      mode === 'shell' ? 'Enter 执行命令 · / 看指令' : 'Enter 发送对话 · / 看指令'),
  )
}

/** Temporary diagnostic boundary: surfaces a render failure inside the
 * dshell view instead of letting the stock slot boundary swallow it. */
class DshellViewBoundary extends Component<{ children: ReactElement }, { error: string | null }> {
  constructor(props: { children: ReactElement }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }

  override render(): ReactElement {
    if (this.state.error !== null) {
      return createElement('pre', {
        'data-dshell-view-error': '',
        style: { color: '#f87171', fontSize: 12, whiteSpace: 'pre-wrap', padding: 12 },
      }, this.state.error)
    }
    return this.props.children
  }
}

/**
 * The dshell main surface: the PTY canvas registered as the `terminal`
 * conversation view (`conversation.view`, id `terminal`). The view area
 * is the whole content column above the composer, so the canvas is
 * full-bleed — the composer card below stays stock (its `/` | `@`
 * popups, model select, context ring, attachments).
 */
function DshellTerminalView(props: {
  sessionId: SessionId | undefined
  pty: PtyStreamService
  sessions: ISessions
  theme: Theme
}): ReactElement {
  return createElement('div', {
    'data-dshell-terminal-view': '',
    style: {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      flex: '1 1 auto',
      minHeight: 0,
      minWidth: 0,
      overflow: 'hidden',
      background: props.theme.bg,
    },
  },
    createElement(DshellViewBoundary, null,
      createElement(PtyCanvas, {
        pty: props.pty,
        sessions: props.sessions,
        sessionId: props.sessionId,
        theme: props.theme,
      }),
    ),
  )
}

/**
 * Mount the mode store and contribute dshell pieces as entries into the
 * stock composer slot hierarchy. The stock `InputBar` is the visible
 * composer (see dsh `ui-conversation/.../InputBar.tsx`); dshell adds
 * the mode chip to `conversation.input.left` and the PTY canvas to
 * `conversation.composer.dock`.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // Cast through unknown: the 'sessions' key collides across faces in one
  // tsc program (host SessionStore vs client ISessions); see terminal-bridge.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const pty = ctx.get('dshellPtyStream') as PtyStreamService
  // Cast: the modelDirectories merge lives in ui-model-selection's face,
  // which this package must not take as a dependency (the model chip here
  // reads the service read-only; the declarer stays ui-model-selection).
  const models = ctx.get('modelDirectories') as unknown as
    { directoryFor(sessionId: SessionId): ModelDirectoryFace }

  const modeStores = new Map<string, SnapshotStore<SessionMode>>()
  const modeFor = (sessionId: SessionId): SnapshotStore<SessionMode> => {
    const key = String(sessionId)
    let store = modeStores.get(key)
    if (store === undefined) {
      store = createSnapshotStore<SessionMode>('shell')
      modeStores.set(key, store)
    }
    return store
  }

  /** Model chip face for one session; undefined while the session is unusable. */
  const modelSeat = (sessionId: SessionId): ModelChipFace | undefined => {
    try {
      const directory = models.directoryFor(sessionId)
      return {
        directory: directory.store,
        load: () => { directory.load().catch(() => { /* surfaced on the store */ }) },
        select: (selection) => directory.select(selection).then(() => true, () => false),
      }
    } catch {
      return undefined
    }
  }

  // dshell does not shadow the stock composer bar — the stock InputBar owns
  // the composer surface, so the user gets stock features out of the box:
  // the `/` | `@` trigger popup (commands / skills / files / sessions),
  // context-occupancy ring, model select, attachment surface, subagent bar,
  // and send / stop button. dshell contributes exactly two entries:
  //  - `conversation.input.left`  the dual-mode chip + submit router
  //  - `conversation.view` (id `terminal`)  the full-bleed PTY canvas
  // The canvas is a conversation VIEW, not a composer child: the view
  // area is the content column above the composer, while
  // `conversation.composer.dock` lives inside the composer card.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      // Own id so dshell can be addressed individually by future owners.
      id: 'dshell-mode-chip',
      name: 'conversation.input.left',
      order: 100,
      inject: (sessionId: SessionId | undefined) => ({
        sessionId,
        mode: sessionId === undefined ? undefined : modeFor(sessionId),
        model: sessionId === undefined ? undefined : modelSeat(sessionId),
        sessions,
        pty,
        setMode: (next: SessionMode) => {
          if (sessionId !== undefined) modeFor(sessionId).set(next)
        },
        submitShell: (text: string) => { pty.send(text.length === 0 ? '\r' : `${text}\r`) },
      }),
    },
    DshellLeftControls,
  ))
  // The terminal IS the conversation surface, so this entry takes over the
  // stock `chat` view cell (same id, lower priority shadows it) instead of
  // registering a sibling tab. That keeps the app at one surface: the view
  // preference falls back to `chat`, and our entry is what renders there —
  // no tab strip, no second view, no dependence on a store write. The
  // shadowed stock entry stays registered, so the child slots it declares
  // (`conversation.chat.node` rows) remain available to other plugins.
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      id: 'chat',
      name: 'conversation.view',
      priority: -1,
      label: () => '对话',
      inject: (sessionId: SessionId | undefined) => ({
        sessionId,
        pty,
        sessions,
        theme: getTheme(DEFAULT_THEME_ID),
      }),
    },
    DshellTerminalView,
  ))
}

export default { name, inject, apply }
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
// Type-only: pulls the settings SlotMap (`settings.general.item`).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `ctx.inputTriggers` service merge; the named types are
// the frozen source contract (`CommandClaim`/`PickOutcome` re-exported there).
import type {
  ClientSessionContext,
  CommandClaim,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
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

/** Public setter used by the settings row below; kept here so the theme
 * registry stays the single source of truth for the dock's palette. */
export { setTheme }

/** React binding for the module-level theme store. */
function useDshellTheme(): Theme {
  const id = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  return getTheme(id)
}

const chipSeatStyle: CSSProperties = { position: 'relative', display: 'flex' }

/**
 * The one live canvas terminal. The composer's key router needs it to copy
 * the terminal selection (`Ctrl+Shift+C`) while the keyboard sits in the
 * input line rather than the canvas.
 */
let activeTerm: XtermTerminal | null = null

declare global {
  interface Window {
    /** Acceptance/debug handle: the live canvas terminal (see `xterm-css`). */
    __DSHELL_TERM__?: XtermTerminal | null
  }
}

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
 * fully transparent so the terminal blends with the app surface instead of
 * painting its own black card (the palette's `bg` is `transparent` too). */
function xtermTheme(theme: Theme): ITheme {
  return {
    background: '#00000000',
    foreground: theme.text,
    cursor: theme.accent,
    cursorAccent: '#00000000',
    // Reverse-video selection, keyed to the active palette: the highlight is
    // the theme's own accent and the glyphs invert to its dark surface
    // (`menuBg`), so a selection reads as part of the current theme rather
    // than a fixed system blue. Both pairs are set — focus usually sits in
    // the composer while the user drags across the canvas, and xterm would
    // otherwise paint its near-invisible inactive colour.
    selectionBackground: theme.accent,
    selectionInactiveBackground: theme.accent,
    selectionForeground: theme.menuBg,
  }
}

/** A durable session event expands into one or more canvas rows (4.4 merge). */
type SessionRowRole = 'user' | 'assistant' | 'reasoning' | 'call' | 'tool' | 'command'

interface SessionRow {
  readonly role: SessionRowRole
  /** Identity within the session log (type + seq + section), for collapse state. */
  readonly key: string
  /** Full display text; may span lines. */
  readonly text: string
  /** Whether the row offers a collapse toggle. */
  readonly collapsible: boolean
  /** Starts collapsed unless the user has explicitly expanded it. */
  readonly defaultCollapsed: boolean
  /** Header label override (a tool's own name). */
  readonly label?: string
  /** `tool-call` correlation id, so a later result can name its tool. */
  readonly callId?: string
}

/** Line count above which a row starts collapsed in the merged timeline. */
const COLLAPSE_THRESHOLD: Record<SessionRowRole, number> = {
  user: Number.POSITIVE_INFINITY,
  assistant: 10,
  // Reasoning is always a collapsed "think" fold, however short.
  reasoning: 0,
  call: Number.POSITIVE_INFINITY,
  tool: 3,
  command: Number.POSITIVE_INFINITY,
}

/** Content blocks of a message, typed loosely (the wire is JSON). */
function contentBlocks(content: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
  return (content ?? []).filter(
    (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
  )
}

/** Join the visible `text` blocks only — reasoning is rendered separately. */
function textOfBlocks(content: readonly unknown[] | undefined): string {
  return contentBlocks(content)
    .filter(block => block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('')
}

/** Join the `reasoning` blocks (the model's chain of thought). */
function reasoningOfBlocks(content: readonly unknown[] | undefined): string {
  return contentBlocks(content)
    .filter(block => block.type === 'reasoning')
    .map(block => String(block.text ?? ''))
    .join('')
}

/** Extract the model's tool invocations from one assistant message. */
function toolCallsOfBlocks(content: readonly unknown[] | undefined): readonly { id: string; name: string; args: string }[] {
  return contentBlocks(content)
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: String(block.id ?? ''),
      name: String(block.name ?? '工具'),
      args: typeof block.arguments === 'string' ? block.arguments : '',
    }))
}

/**
 * Text of a tool result. A `tool-result` block nests its payload under
 * `content`, so a flat scan would render tool output as an empty row — walk
 * the nesting and fall back to a marker for non-text payloads.
 */
function resultText(content: readonly unknown[] | undefined): string {
  const parts: string[] = []
  for (const block of contentBlocks(content)) {
    if (block.type === 'text') {
      parts.push(String(block.text ?? ''))
      continue
    }
    if (Array.isArray(block.content)) {
      const nested = resultText(block.content as unknown[])
      if (nested.length > 0) parts.push(nested)
      continue
    }
    if (block.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n').trim()
}

/** One-line argument preview for a tool call. */
function compactArguments(raw: string): string {
  if (raw.trim().length === 0) return ''
  let text = raw
  try { text = JSON.stringify(JSON.parse(raw)) } catch { /* not JSON: keep raw */ }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > 140 ? `${text.slice(0, 137)}…` : text
}

/** Build one row, or null when it would be blank. */
function rowOf(
  role: SessionRowRole,
  key: string,
  text: string,
  extra: { label?: string; callId?: string } = {},
): SessionRow | null {
  const body = text.replace(/\n+$/, '')
  if (body.trim().length === 0) return null
  const lines = body.split('\n').length
  // Reasoning folds whenever it is more than a one-liner or a wall of prose;
  // other roles fold on line count alone.
  const collapsible = role === 'reasoning'
    ? lines > 1 || body.length > 200
    : lines > COLLAPSE_THRESHOLD[role]
  return {
    role,
    key,
    text: body,
    collapsible,
    defaultCollapsed: collapsible,
    ...extra,
  }
}

/**
 * Extract the displayable rows of one durable Session event. A single
 * assistant message may yield three kinds of row — its thinking, its answer,
 * and one line per tool call — in stream order.
 * @param event - the durable event.
 * @param toolNames - call-id → tool-name directory, populated by assistant
 *   messages and read by their results (which carry only the call id).
 * @returns the rows, in display order.
 */
function sessionRowsOf(event: SessionEventLike, toolNames: Map<string, string>): readonly SessionRow[] {
  if (event.type === 'user/message') {
    // Plugin-sourced user messages (host-side terminal context, guard
    // notices) are model input, not the user's words — keeping them out
    // stops the canvas from painting fake `┃ 你` rows.
    if (event.data.source.kind !== 'user') return []
    const text = textOfBlocks(event.data.content)
    // Legacy sessions carry the Phase 7 client-side context fence inside
    // the user's own message; show only the words beneath it.
    const stripped = /^\[dshell 终端上下文\][\s\S]*?```\n([\s\S]*)$/.exec(text)
    const row = rowOf('user', `${event.type}:${event.seq}`, stripped === null ? text : (stripped[1] ?? ''))
    return row === null ? [] : [row]
  }
  if (event.type === 'assistant/message') {
    const content = event.data.message.content
    const rows: SessionRow[] = []
    const base = `${event.type}:${event.seq}`
    const reasoning = rowOf('reasoning', `${base}:r`, reasoningOfBlocks(content), { label: '⎿ 思考过程' })
    if (reasoning !== null) rows.push(reasoning)
    const answer = rowOf('assistant', `${base}:t`, textOfBlocks(content))
    if (answer !== null) rows.push(answer)
    toolCallsOfBlocks(content).forEach((call, index) => {
      toolNames.set(call.id, call.name)
      const preview = compactArguments(call.args)
      const row = rowOf('call', `${base}:c${String(index)}`, preview, {
        label: `→ ${call.name}`,
        callId: call.id,
      })
      if (row !== null) rows.push(row)
    })
    return rows
  }
  if (event.type === 'tool/result') {
    const callId = event.data.message.source.callId
    const name = toolNames.get(callId) ?? event.data.error?.name ?? '工具'
    const body = resultText(event.data.message.content)
    const failed = event.data.error !== undefined
    const text = body.length > 0 ? body : (failed ? '（失败，无输出）' : '（无文本输出）')
    const row = rowOf('tool', `${event.type}:${event.seq}`, text, { label: `← ${name}${failed ? ' ✗' : ''}` })
    return row === null ? [] : [row]
  }
  if (event.type === 'command/done') {
    const outcome = event.data.kind === 'error' ? `失败:${event.data.text ?? ''}` : (event.data.text ?? '')
    const row = rowOf('command', `${event.type}:${event.seq}`, outcome.trim().length === 0 ? '完成' : outcome)
    return row === null ? [] : [row]
  }
  if (event.type === 'command/run') {
    const args = event.data.args
    const text = args === undefined || args === '' ? event.data.name : `${event.data.name} ${args}`
    const row = rowOf('command', `${event.type}:${event.seq}`, text)
    return row === null ? [] : [row]
  }
  return []
}

const SESSION_ROW_COLOR: Record<SessionRowRole, string> = {
  user: '\u001b[36m', // cyan
  assistant: '\u001b[32m', // green
  reasoning: '\u001b[2;90m', // dim grey
  call: '\u001b[35m', // magenta
  tool: '\u001b[34m', // blue
  command: '\u001b[33m', // yellow
}

/**
 * CSS colors matching the ANSI codes the labels use (xterm.js' built-in
 * palette). The block's left rule is painted by {@link paintGutter} rather
 * than by the `┃` glyph, so these must track the roles' text colors.
 */
const SESSION_ROW_GUTTER: Record<SessionRowRole, string> = {
  user: '#06989a', // ANSI 36
  assistant: '#4e9a06', // ANSI 32
  reasoning: '#353737', // ANSI 2;90, the dimmed rendering
  call: '#75507b', // ANSI 35
  tool: '#3465a4', // ANSI 34
  command: '#c4a000', // ANSI 33
}

/**
 * Paint each block's left rule as one CSS band per buffer row. A stacked `┃`
 * glyph inks only ~14px of the 16px cell, so it reads as a dashed line; an
 * inset box-shadow fills the whole row box, staying unbroken across rows and
 * across soft-wrapped continuation rows. Called after every xterm render, so
 * scrolling and re-layout repaint without extra bookkeeping.
 */
function paintGutter(term: XtermTerminal, lines: ReadonlyMap<number, SessionRowRole>): void {
  const rows = term.element?.querySelector('.xterm-rows')
  if (rows === undefined || rows === null) return
  const top = term.buffer.active.viewportY
  for (let index = 0; index < rows.children.length; index++) {
    const row = rows.children[index]
    if (!(row instanceof HTMLElement)) continue
    const role = lines.get(top + index)
    const shadow = role === undefined ? '' : `inset 3px 0 0 0 ${SESSION_ROW_GUTTER[role]}`
    if (row.style.boxShadow !== shadow) row.style.boxShadow = shadow
  }
}

/** Two-column gutter the rule occupies; labels start past it. */
const SESSION_ROW_LABEL: Record<SessionRowRole, string> = {
  user: '  你',
  assistant: '  AI',
  reasoning: '  思考过程',
  call: '  调用',
  tool: '  工具',
  command: ' ⚡ 命令',
}

/**
 * Render one session row (design 4.4). A collapsible row renders collapsed to
 * one line plus a toggle hint. Returned as a string because the caller needs
 * xterm's post-wrap cursor line for click mapping, which is only observable
 * after an ordered write callback.
 * @param row - the row to draw.
 * @param collapsed - whether the body is hidden.
 * @returns the ANSI text for the row (header plus body, newline-terminated).
 */
function renderSessionRow(row: SessionRow, collapsed: boolean): string {
  const color = SESSION_ROW_COLOR[row.role]
  const reset = '\u001b[0m'
  const dim = '\u001b[2m'
  const lines = row.text.split('\n')
  const first = lines[0] ?? ''
  // A folded row is one compact line: keep it short even when the record's
  // first line is a whole paragraph.
  const summary = collapsed && first.length > 160 ? `${first.slice(0, 157)}…` : first
  const rest = lines.slice(1)
  const folded = rest.length > 0 ? `+${String(rest.length)} 行 ▸ 点击展开` : '点击展开'
  const hint = row.collapsible
    ? collapsed
      ? ` ${dim}[${folded}]${reset}`
      : ` ${dim}[▾ 点击收起]${reset}`
    : ''
  const label = row.label === undefined ? SESSION_ROW_LABEL[row.role] : `  ${row.label}`
  let out = `${color}${label}${reset} ${summary}${hint}\r\n`
  if (!collapsed) {
    // The gutter column stays blank in the text; paintGutter() draws the
    // block's rule over it as a continuous CSS band.
    for (const line of rest) out += `  ${line}\r\n`
  }
  return out
}

/** The xterm.js canvas: raw ANSI stream + session events merged (4.4). */
function PtyCanvas(props: {
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
    activeTerm = term
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
      const lineHeight = probeBox.height
      // The probe has no metrics until the view area gets laid out (and a
      // hidden/zero-size ancestor yields 0 or NaN). xterm's resize throws
      // "This API only accepts integers" on non-finite input, so guard.
      if (!Number.isFinite(charWidth) || charWidth <= 0) return
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return
      // Clamp hard: a layout feedback loop (container growing with the
      // rendered screen) would otherwise runaway to hundreds of thousands
      // of rows.
      const cols = Math.min(500, Math.max(20, Math.floor((el.clientWidth - 8) / charWidth)))
      const rows = Math.min(300, Math.max(6, Math.floor((el.clientHeight - 12) / lineHeight)))
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
            term.write(chunk.text)
          }
        }, 150)
      } else {
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
      if (activeTerm === term) activeTerm = null
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
    term.reset()
    if (key !== undefined) term.write(props.pty.read(key))
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
  const mergedReplayRef = useRef<(() => void) | undefined>(undefined)
  const replayPendingRef = useRef(false)
  const replayTimerRef = useRef<number | undefined>(undefined)
  /** Explicit collapse overrides, keyed by session + row key (absent = default). */
  const collapsedRef = useRef<Map<string, boolean>>(new Map())
  /** Absolute buffer line of each row header → its collapse identity. */
  const rowLinesRef = useRef<Map<number, { key: string; collapsible: boolean; defaultCollapsed: boolean }>>(new Map())
  /** Absolute buffer line → row role, for the block's continuous left rule. */
  const gutterLinesRef = useRef<Map<number, SessionRowRole>>(new Map())
  /** call-id → tool name, rebuilt on every replay so results can name their tool. */
  const toolNamesRef = useRef(new Map<string, string>())
  /** Bumped per replay so late write callbacks cannot repopulate a cleared map. */
  const replayGenRef = useRef(0)
  useEffect(() => {
    const term = termRef.current
    if (term === null || eventSource === undefined) return
    let watermark = 0
    const collapsedFor = (key: string, row: SessionRow): boolean =>
      collapsedRef.current.get(key) ?? row.defaultCollapsed
    // A row's buffer line is only knowable after xterm has processed every
    // earlier write. Queue a zero-length write first: its callback runs once
    // all pending data is consumed, so the cursor then sits on this row's
    // header line.
    const drawRow = (id: string, row: SessionRow): void => {
      const key = `${id}:${row.key}`
      const gen = replayGenRef.current
      let start = -1
      term.write('', () => {
        if (replayGenRef.current !== gen) return
        const buffer = term.buffer.active
        start = buffer.baseY + buffer.cursorY
        rowLinesRef.current.set(start, {
          key,
          collapsible: row.collapsible,
          defaultCollapsed: row.defaultCollapsed,
        })
      })
      // The row ends with a newline, so the cursor lands on the line after
      // the block: every line in [start, end) carries this role's rule.
      term.write(renderSessionRow(row, collapsedFor(key, row)), () => {
        if (replayGenRef.current !== gen || start < 0) return
        const buffer = term.buffer.active
        const end = buffer.baseY + buffer.cursorY
        for (let line = start; line < end; line++) gutterLinesRef.current.set(line, row.role)
        paintGutter(term, gutterLinesRef.current)
      })
    }
    const mergedReplay = (entries: readonly SessionEventLikeEntry[]): void => {
      const id = sessionIdRef.current
      if (id === undefined) return
      replayGenRef.current += 1
      term.reset()
      rowLinesRef.current.clear()
      gutterLinesRef.current.clear()
      toolNamesRef.current.clear()
      const rows: { time: number; order: number; kind: 'pty' | 'session'; payload: string | SessionRow }[] = []
      let order = 0
      for (const chunk of props.pty.chunks(id)) {
        if (chunk.text.length === 0) continue
        rows.push({ time: chunk.time, order: order++, kind: 'pty', payload: chunk.text })
      }
      for (const entry of entries) {
        if (entry.type !== 'event') continue
        for (const row of sessionRowsOf(entry.event, toolNamesRef.current)) {
          rows.push({ time: entry.event.time, order: order++, kind: 'session', payload: row })
        }
      }
      // Absolute insertion order breaks ties, so a single assistant message's
      // thinking / answer / call rows always draw in that order.
      rows.sort((a, b) => a.time - b.time || a.order - b.order)
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
          const rows = sessionRowsOf(entry.event, toolNamesRef.current)
          if (rows.length > 0) {
            // While a replay redraw is pending the rows belong to the same
            // transaction as the wipe — the redraw draws them in time order.
            if (replayPendingRef.current) continue
            const id = sessionIdRef.current
            if (id === undefined) continue
            for (const row of rows) {
              // The cursor usually sits mid-line (after a live prompt); rows
              // are log entries and always start on their own line.
              if (term.buffer.active.cursorX > 0) term.write('\r\n')
              drawRow(id, row)
            }
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
  const theme = useDshellTheme()
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
  // Agent mode gives the keyboard back to the stock composer editor; the
  // canvas blurs itself in PtyCanvas (focus follows mode, design 4.8).
  useEffect(() => {
    if (mode !== 'agent') return
    const editor = document.querySelector('[contenteditable="true"][role="textbox"]')
    if (editor instanceof HTMLElement) editor.focus()
  }, [mode])
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
      const target = event.target
      const inComposer = target instanceof Element && target.closest('[data-composer-card]') !== null
      // Terminal chords must behave the same whether the keyboard is in the
      // canvas or the composer: the composer is the input line too, so
      // Ctrl+C interrupts the foreground job and Ctrl+Shift+C copies the
      // terminal selection from either focus owner.
      if (inComposer && modeRef.current === 'shell' && !event.isComposing) {
        const mod = event.ctrlKey || event.metaKey
        const key = event.key.toLowerCase()
        if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'c') {
          // Bash's line editor abandons the current line on Ctrl+C, so the
          // draft goes with it.
          event.preventDefault()
          event.stopImmediatePropagation()
          clearDraft('')
          pty.send('\u0003')
          return
        }
        if (mod && event.shiftKey && key === 'c') {
          const selection = activeTerm?.getSelection() ?? ''
          if (selection.length > 0) {
            if (navigator.clipboard !== undefined) {
              void navigator.clipboard.writeText(selection).catch(() => { /* clipboard denied */ })
            }
            event.preventDefault()
            event.stopImmediatePropagation()
            return
          }
        }
        if (mod && event.shiftKey && key === 'v' && navigator.clipboard !== undefined) {
          event.preventDefault()
          event.stopImmediatePropagation()
          void navigator.clipboard.readText().then(
            (text) => { if (text.length > 0) pty.send(text) },
            () => { /* clipboard denied */ },
          )
          return
        }
      }
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (!inComposer) return
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
  const chipStyle: CSSProperties = {
    border: `1px solid ${mode === 'shell' ? theme.accentBorder : theme.borderStrong}`,
    background: mode === 'shell' ? theme.accentFaint : 'transparent',
    color: mode === 'shell' ? theme.accentText : theme.muted,
    cursor: 'pointer',
    borderRadius: 999,
    padding: '3px 10px',
    fontSize: 11,
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    transition: 'color 120ms, border-color 120ms',
  }
  return createElement('div', { style: chipSeatStyle },
    createElement('button', {
      style: chipStyle,
      onClick: () => { props.setMode(next) },
    }, `${glyph} ${label}`),
    createElement('div', { style: { color: theme.muted, fontSize: 12, marginLeft: 8 } },
      mode === 'shell' ? '直接输入 · Ctrl+C 中断 · Ctrl+Shift+C 复制' : 'Enter 发送对话 · /agent 切终端'),
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
  mode: SnapshotStore<SessionMode> | undefined
}): ReactElement {
  // Palette changes re-render the canvas in place (PtyCanvas re-themes xterm
  // from props.theme without recreating the terminal).
  const theme = useDshellTheme()
  const mode = useSyncExternalStore(
    props.mode?.subscribe ?? (() => () => {}),
    props.mode?.getSnapshot ?? (() => 'shell' as SessionMode),
  )
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
      background: theme.bg,
    },
  },
    createElement(DshellViewBoundary, null,
      createElement(PtyCanvas, {
        pty: props.pty,
        sessions: props.sessions,
        sessionId: props.sessionId,
        theme,
        mode,
      }),
    ),
  )
}

/** `/` menu rows for the terminal-mode toggle, in display order. */
const MODE_MENU_ROWS: readonly { name: 'shell' | 'agent'; description: string }[] = [
  { name: 'shell', description: '切换到 shell 模式：Enter 直接执行命令' },
  { name: 'agent', description: '切换到 agent 模式：Enter 发送给 AI' },
]

/** Typed aliases → canonical mode. `/terminal` stays an accepted alias. */
const MODE_ALIASES = new Map<string, SessionMode>([
  ['shell', 'shell'],
  ['agent', 'agent'],
  ['terminal', 'shell'],
])

/**
 * `/shell` and `/agent` as first-class client commands. They are NOT host
 * commands: the per-session mode store lives in this browser module, so the
 * handler has to run here. The input-trigger pipeline is the supported
 * client-side entry — a source on `/` contributes menu rows and claims
 * `matchEnter` with a local `CommandClaim` whose `submit` flips the store
 * (no RPC, no durable command lifecycle to pollute the log). Typed args
 * after a shell switch run immediately (`/shell ls -la`). Plain draft text
 * still routes through the capture-phase composer listener; this source
 * owns the slash forms only.
 * @param deps - per-session mode store and the main-shell sender.
 * @returns the trigger source for `ctx.inputTriggers.registerSource`.
 */
function modeSwitchSource(deps: {
  modeFor(sessionId: SessionId): SnapshotStore<SessionMode>
  sendShell(text: string): void
}): InputTriggerSource {
  /** Resolve a typed/picked name to its canonical mode (`/terminal` → shell). */
  const canonicalOf = (rawName: string): SessionMode | undefined => {
    const canonical = rawName === 'terminal' ? 'shell' : rawName
    return MODE_ALIASES.has(canonical) ? canonical as SessionMode : undefined
  }
  const claimFor = (name: string, session: ClientSessionContext): { claim: CommandClaim } => {
    const next = canonicalOf(name) as SessionMode
    return {
      claim: {
        token: `/${next}`,
        hint: '切换模式',
        submit: async (args) => {
          deps.modeFor(session.sessionId).set(next)
          const rest = args.trim()
          if (next === 'shell' && rest.length > 0) deps.sendShell(rest)
          return {
            kind: 'success',
            text: next === 'shell'
              ? '已切换到 shell 模式 · Enter 直接执行命令'
              : '已切换到 agent 模式 · Enter 发送给 AI',
          }
        },
      },
    }
  }
  return {
    trigger: '/',
    name: 'dshell',
    order: 50,
    showGroupTitle: true,
    candidates: async (_session, req) => {
      if (req.position !== 'leading') return []
      const query = req.query.trim().toLowerCase()
      return MODE_MENU_ROWS
        .filter(row => row.name.startsWith(query))
        .map(row => ({ name: row.name, description: row.description, value: row.name }))
    },
    // A menu pick is the common path (typing `/agent` opens the menu, Enter
    // picks the highlighted row). Switching in `onPick` and replacing the
    // token with empty text makes that ONE keystroke with no leftover draft,
    // instead of the stock two-step "insert token, then submit" claim.
    onPick: (pick) => {
      const next = canonicalOf((pick.candidate.value ?? pick.candidate.name).toLowerCase())
      if (next === undefined) return undefined
      deps.modeFor(pick.session.sessionId).set(next)
      return { text: '' }
    },
    // The no-menu path (pasted line, or menu already closed): claim and
    // submit so the composer clears through the normal settlement and the
    // switch reports a notice.
    matchEnter: async (session, line, _signal, envelope) => {
      const trimmed = line.trim()
      const ws = trimmed.search(/\s/)
      const token = ws === -1 ? trimmed : trimmed.slice(0, ws)
      const name = token.slice(1).toLowerCase()
      if (canonicalOf(name) === undefined) return undefined
      if (envelope.attachments > 0) throw new Error(`/${name} 不支持附件`)
      return claimFor(name, session)
    },
  }
}

/**
 * Terminal-palette picker for the Settings General section. It lives beside
 * the registry it writes (the module-level `themeStore`), so the palette has
 * one owner and no cross-plugin service is needed to reach it.
 */
function DshellThemeSettingsRow(): ReactElement {
  const current = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  return createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '16px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    },
  },
    createElement('div', {
      style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
    }, '终端配色'),
    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      THEMES.map(theme => createElement('button', {
        key: theme.id,
        type: 'button',
        'aria-pressed': current === theme.id,
        onClick: () => { setTheme(theme.id) },
        style: {
          flex: '1 1 140px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: '14px 16px',
          borderRadius: 16,
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 13,
          color: 'var(--dsw-alias-label-primary)',
          border: current === theme.id
            ? '1px solid var(--dsw-alias-brand-primary)'
            : '0.5px solid var(--dsw-alias-border-l4)',
          background: current === theme.id ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
        },
      },
        createElement('span', {
          style: {
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: 999,
            background: theme.accent,
            border: `1px solid ${theme.borderStrong}`,
          },
        }),
        theme.label,
      )),
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

  /** Send one line (or a bare Enter) to the bridge-owned main shell. */
  const sendShell = (text: string): void => { pty.send(text.length === 0 ? '\r' : `${text}\r`) }

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
        submitShell: sendShell,
      }),
    },
    DshellLeftControls,
  ))
  // `/shell` and `/agent` live in the client-side slash pipeline, not on
  // `ctx.commands`: they flip a browser store, which no host handler can
  // reach. Registered once; each session controller polls it.
  ctx.inject(['inputTriggers'], (scope) => {
    scope.effect(
      () => scope.inputTriggers.registerSource(modeSwitchSource({ modeFor, sendShell })),
      'dshell-mode: /shell + /agent source',
    )
  })
  // The terminal palette is a preference with no page of its own, so it
  // belongs in the General section's item seat — out of the composer.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'dshell-theme', order: 200 },
    DshellThemeSettingsRow,
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
        mode: sessionId === undefined ? undefined : modeFor(sessionId),
      }),
    },
    DshellTerminalView,
  ))
}

export default { name, inject, apply }
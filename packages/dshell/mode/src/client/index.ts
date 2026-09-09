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
  createElement,
  useEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ModelProviderGroup,
  ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PtyStreamService, PtyStreamState } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
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

/** Props injected into the terminal dock. */
interface TerminalDockProps {
  sessionId: SessionId | undefined
  /** Per-session mode store; absent with no session. */
  mode: SnapshotStore<SessionMode> | undefined
  /** Per-session PTY history source. */
  pty: PtyStreamService | undefined
  /** Model chip face; absent with no session. */
  model: ModelChipFace | undefined
  submitShell(text: string): void
  submitAgent(text: string): Promise<void>
}

const PREFIX_PATTERN = /^\/(agent|shell|terminal)(?:\s+([\s\S]+))?\s*$/

/** Strip dsh's prompt-protocol OSC markers (133;D + 133;A/B/C + OSC 1337 sequences). */
const OSC_DS_PROBE = /\x1b\]133;[^\x07\x1b]*(\x07|\x1b\\)/g

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

/** Stable no-session host-info snapshot (uSES-safe identity). */
const EMPTY_HOST_INFO: { user: string; host: string; home: string } = { user: '', host: '', home: '' }
const subscribeNoop = () => () => {}

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.012) 0%, rgba(0,0,0,0.25) 100%)',
  color: 'var(--dshell-fg)',
  fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.55,
  letterSpacing: 0,
}
const scrollStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '14px 16px 8px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  scrollbarColor: 'var(--dshell-border-strong) transparent',
}
const inputBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  borderTop: '1px solid var(--dshell-border)',
  padding: '10px 14px 12px',
  flex: '0 0 auto',
  background: 'var(--dshell-input-bar)',
  backdropFilter: 'blur(8px)',
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
const modeChipStyleActive: CSSProperties = {
  ...modeChipStyle,
  color: 'var(--dshell-accent)',
  borderColor: 'var(--dshell-accent-border)',
}
const promptPrefixStyle: CSSProperties = {
  color: 'var(--dshell-accent)',
  fontWeight: 600,
  whiteSpace: 'pre',
  userSelect: 'none',
  marginRight: 6,
}
const inputStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--dshell-fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  minWidth: 0,
  padding: '2px 0',
}
const errorStyle: CSSProperties = {
  color: '#f87171',
  fontSize: 12,
  padding: '0 4px',
}
const chipSeatStyle: CSSProperties = { position: 'relative', display: 'flex' }
const chipMenuStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  right: 0,
  minWidth: 200,
  maxHeight: 360,
  overflowY: 'auto',
  background: 'var(--dshell-menu-bg)',
  border: '1px solid var(--dshell-menu-border)',
  borderRadius: 10,
  padding: 4,
  zIndex: 60,
  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
}
const chipGroupStyle: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--dshell-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  padding: '8px 10px 4px',
  whiteSpace: 'nowrap',
  fontWeight: 600,
}
const chipItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  color: 'var(--dshell-fg)',
  cursor: 'pointer',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
  transition: 'background 80ms',
}
const chipItemStyleActive: CSSProperties = {
  ...chipItemStyle,
  background: 'var(--dshell-accent-faint)',
  color: 'var(--dshell-accent-text)',
}
const swatchStyle: CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: 3,
  border: '1px solid rgba(255,255,255,0.1)',
  flex: '0 0 auto',
}

/** Apply the theme's CSS variables onto the dock root element. */
function applyThemeVars(el: HTMLElement | null, theme: Theme): void {
  if (el === null) return
  const s = el.style
  s.setProperty('--dshell-bg', theme.bg)
  s.setProperty('--dshell-fg', theme.text)
  s.setProperty('--dshell-muted', theme.muted)
  s.setProperty('--dshell-border', theme.border)
  s.setProperty('--dshell-border-strong', theme.borderStrong)
  s.setProperty('--dshell-input-bar', theme.inputBar)
  s.setProperty('--dshell-accent', theme.accent)
  s.setProperty('--dshell-accent-text', theme.accentText)
  s.setProperty('--dshell-accent-border', theme.accentBorder)
  s.setProperty('--dshell-accent-faint', theme.accentFaint)
  s.setProperty('--dshell-menu-bg', theme.menuBg)
  s.setProperty('--dshell-menu-border', theme.menuBorder)
}

/**
 * Build the PS1 rewrite for a theme. Backslash-literal escapes only —
 * dsh's input sanitizer strips raw ESC bytes, while bash expands \e \u \h
 * \w at render time. Colors survive in the real PTY but dsh's scrollback
 * sanitizer strips them from the browser stream (documented dsh contract).
 * One line with the new PROMPT_COMMAND re-asserting from $DSHELL_PS1, so
 * no prompt render between assignments can reset the prompt.
 */
function ps1For(theme: Theme): string {
  const colored = [
    `\\e[${theme.ps1User}m\\u@\\h\\e[0m:\\e[${theme.ps1Path}m\\w\\e[0m`,
    '\\$ ',
  ].join('')
  return `export DSHELL_PS1='${colored}'; export PS1="$DSHELL_PS1"; export PROMPT_COMMAND='printf "\\033]133;D;%s\\007" "$?"; PS1="$DSHELL_PS1"'\n`
}

/** Tiny preview swatch showing a theme's two PS1 colors side by side. */
function ThemeSwatch(props: { theme: Theme }): ReactElement {
  return createElement('span', {
    style: {
      ...swatchStyle,
      background: `linear-gradient(135deg, ${props.theme.accent} 0%, ${props.theme.accent} 55%, ${props.theme.text} 55%, ${props.theme.text} 100%)`,
    },
  })
}

/** The dock's theme chip: a palette dot + a flat picker over the theme registry. */
function ThemeChip(): ReactElement {
  const [open, setOpen] = useState(false)
  const currentId = useSyncExternalStore(
    themeStore.subscribe,
    () => themeStore.getSnapshot(),
  )
  const current = getTheme(currentId)
  return createElement('div', { style: chipSeatStyle },
    createElement('button', {
      style: modeChipStyle,
      title: '终端配色',
      onClick: () => { setOpen(!open) },
    }, createElement(ThemeSwatch, { theme: current }), ` ${current.label}`),
    open ? createElement('div', { style: chipMenuStyle },
      THEMES.map(theme => {
        const active = theme.id === current.id
        return createElement('button', {
          key: theme.id,
          style: active ? chipItemStyleActive : chipItemStyle,
          onClick: () => {
            setOpen(false)
            setTheme(theme.id)
          },
        },
          createElement(ThemeSwatch, { theme }),
          createElement('span', null, theme.label),
          active ? createElement('span', { style: { marginLeft: 'auto', color: 'var(--dshell-accent)' } }, '✓') : null,
        )
      }),
    ) : null,
  )
}

/** The dock's model chip: current selection + a flat picker over the shared directory. */
function ModelChip(props: { face: ModelChipFace }): ReactElement {
  const [open, setOpen] = useState(false)
  const state = useSyncExternalStore(
    props.face.directory.subscribe,
    () => props.face.directory.getSnapshot(),
  )
  if (open && state.groups.length === 0 && state.status !== 'loading') props.face.load()
  const current = state.current
  const currentLabel = current === null ? '选择模型' : current.model
  const groups = state.groups
  return createElement('div', { style: chipSeatStyle },
    createElement('button', {
      style: { ...modeChipStyle, color: current === null ? '#9d9da6' : '#cbb5ff' },
      title: '切换模型',
      onClick: () => {
        setOpen(!open)
        props.face.load()
      },
    }, `◆ ${currentLabel}`),
    open ? createElement('div', { style: chipMenuStyle },
      groups.length === 0
        ? createElement('div', { style: chipGroupStyle },
          state.status === 'loading' ? '目录加载中…' : '目录暂不可用')
        : groups.map(group =>
          createElement('div', { key: group.id },
            createElement('div', { style: chipGroupStyle }, group.name),
            group.models.map(model => {
              const active = current?.provider === group.id && current?.model === model.id
              return createElement('button', {
                key: model.id,
                style: active ? chipItemStyleActive : chipItemStyle,
                onClick: () => {
                  setOpen(false)
                  void props.face.select({ provider: group.id, model: model.id })
                },
              }, (active ? '✓ ' : '  ') + model.name)
            }),
          )),
    ) : null,
  )
}

/** Auto-scrolling PTY pane: only pins to the bottom when content overflows. */
/** readline redraws erase the line with backspaces; collapse them for plain rendering. */
function collapseBackspaces(text: string): string {
  let out = ''
  for (const ch of text) {
    if (ch === '\b') out = out.slice(0, -1)
    else out += ch
  }
  return out
}

function PtyScrollback(props: { pty: PtyStreamService; sessionId: SessionId | undefined }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  // Re-render on every bridge store change so the latest PTY chunk shows.
  useSyncExternalStore<PtyStreamState>(
    props.pty.state.subscribe,
    () => props.pty.state.getSnapshot(),
  )
  const sessionId = props.sessionId
  const text = sessionId === undefined ? '' : props.pty.read(String(sessionId))
  const cleaned = text.length === 0
    ? ''
    : collapseBackspaces(text.replace(OSC_DS_PROBE, '').replace(/\u0007/g, ''))
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    // Anchor at the top while content fits the viewport — the prompt and
    // first lines stay flush under the session header instead of floating
    // mid-screen. Once content overflows, scrollHeight > clientHeight and
    // pinning to the bottom kicks in (standard terminal tail-follow).
    if (el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTop = 0
    }
  }, [cleaned])
  const empty = cleaned.length === 0
    ? (sessionId === undefined ? '新建会话后开始' : '正在连接终端…')
    : null
  return createElement('div', { ref, style: scrollStyle },
    empty ?? cleaned)
}

/** The fused terminal surface: PTY scrollback above, input line at the bottom. */
function TerminalDock(props: TerminalDockProps): ReactElement {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const mode = useSyncExternalStore(
    props.mode?.subscribe ?? (() => () => {}),
    props.mode?.getSnapshot ?? (() => 'shell' as SessionMode),
  )
  const themeId = useSyncExternalStore(
    themeStore.subscribe,
    () => themeStore.getSnapshot(),
  )
  const theme = getTheme(themeId)
  // Server's OS identity arrives on the ws `info` frame; subscribing keeps
  // the PS1 effect honest when it lands after mount.
  const hostInfo = useSyncExternalStore(
    props.pty?.host.subscribe ?? subscribeNoop,
    () => props.pty?.host.getSnapshot() ?? EMPTY_HOST_INFO,
  )

  // Re-skin the dock whenever the theme changes; also re-issue the bash
  // PS1 so the shell prompt follows the palette (colors surface in the
  // real PTY; the browser scrollback stays monochrome — dsh strips ANSI).
  useEffect(() => {
    applyThemeVars(rootRef.current, theme)
  }, [theme])
  const appliedThemeRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (props.sessionId === undefined || props.pty === undefined) return
    if (props.pty.host.getSnapshot().user === '') return
    if (appliedThemeRef.current === theme.id) return
    appliedThemeRef.current = theme.id
    props.submitShell(ps1For(theme))
  }, [theme, props.sessionId, props.pty, hostInfo.user])

  const dispatch = (target: SessionMode, payload: string): void => {
    setError(null)
    if (target === 'shell') {
      props.submitShell(payload)
      return
    }
    props.submitAgent(payload).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const submit = (): void => {
    const raw = text
    setText('')
    const match = PREFIX_PATTERN.exec(raw.trim())
    if (match !== null) {
      const next: SessionMode = match[1] === 'agent' ? 'agent' : 'shell'
      props.mode?.set(next)
      const payload = match[2] ?? ''
      if (payload.trim() !== '') dispatch(next, payload.trim())
      return
    }
    if (props.sessionId === undefined) return
    if (raw.trim() === '' && mode === 'agent') return
    dispatch(mode, raw)
  }

  const placeholder = props.sessionId === undefined
    ? '新建会话后开始'
    : mode === 'shell'
      ? '输入命令…  /agent 切到对话'
      : '与 AI 对话…  /shell 切回命令'
  const promptGlyph = props.sessionId === undefined
    ? '›'
    : mode === 'shell' ? '$' : '✦'

  return createElement('div', { ref: rootRef, style: rootStyle, 'data-dshell-dock': '' },
    props.pty !== undefined
      ? createElement(PtyScrollback, { pty: props.pty, sessionId: props.sessionId })
      : createElement('div', { style: { ...scrollStyle, color: 'var(--dshell-muted)' } }, '正在加载终端…'),
    createElement('div', { style: inputBarStyle },
      createElement('button', {
        style: mode === 'shell' ? modeChipStyle : modeChipStyleActive,
        title: '点击切换模式（/agent、/shell）',
        onClick: () => { props.mode?.set(mode === 'shell' ? 'agent' : 'shell') },
      }, mode === 'shell' ? '$ shell' : '✦ agent'),
      createElement('span', { style: promptPrefixStyle }, promptGlyph),
      createElement('input', {
        style: inputStyle,
        value: text,
        autoFocus: props.sessionId !== undefined,
        spellCheck: false,
        placeholder,
        onChange: (event) => { setText(event.target.value) },
        onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
            return
          }
          if (mode !== 'shell' || props.sessionId === undefined || props.pty === undefined) return
          // Readline bindings the browser input would otherwise swallow:
          // Tab completes on the shell, Up/Down walk history via C-p/C-n
          // (no ESC bytes — those never survive the PTY input path),
          // Ctrl+C interrupts the foreground job (terminal convention
          // beats copy). Recalled lines replace the box's text, matching
          // readline's line replacement.
          if (event.key === 'Tab') {
            event.preventDefault()
            props.pty.send('\t')
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setText('')
            props.pty.send('\u0010')
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setText('')
            props.pty.send('\u000e')
          } else if (event.key === 'c' && event.ctrlKey) {
            event.preventDefault()
            setText('')
            props.pty.sendSignal('SIGINT')
          }
        },
      }),
      props.sessionId !== undefined && props.model !== undefined
        ? createElement(ModelChip, { face: props.model })
        : null,
      createElement(ThemeChip),
    ),
    error !== null ? createElement('div', { style: errorStyle }, error) : null,
  )
}

/**
 * Mount the mode store and the fused terminal dock, shadowing the stock
 * composer bar.
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

  const scopedConversation = (sessionId: SessionId): IConversation => {
    const conversation = sessions.scope(sessionId)?.get('conversation')
    if (conversation === undefined) {
      throw new Error(`dshell-mode: session "${String(sessionId)}" resolved no conversation service`)
    }
    return conversation
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

  ctx.slots.inject('conversation.composer.bar', () => ctx.slots.register(
    {
      // The entry name IS the hole it fills; priority -1 shadows the stock
      // InputBar (priority 0, lowest renders). The composer's child holes
      // ('conversation.input.model' etc.) are already declared by the stock
      // conversation.composer.bar entry — one declarer per hole, and a
      // second declaration fails the whole load — so the dock renders the
      // model chip directly (ModelSelect over ctx.modelDirectories) instead
      // of through renderSlot.
      name: 'conversation.composer.bar',
      priority: -1,
      inject: (sessionId: SessionId | undefined) => ({
        sessionId,
        mode: sessionId === undefined ? undefined : modeFor(sessionId),
        pty,
        model: sessionId === undefined ? undefined : modelSeat(sessionId),
        submitShell: (text: string) => { pty.send(text.length === 0 ? '\r' : `${text}\r`) },
        submitAgent: async (text: string) => {
          if (sessionId === undefined) throw new Error('dshell-mode: no session open')
          await scopedConversation(sessionId).send(text)
        },
      }),
    },
    TerminalDock,
  ))
}

export default { name, inject, apply }
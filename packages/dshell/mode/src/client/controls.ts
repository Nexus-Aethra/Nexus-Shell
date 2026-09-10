import {
  Component,
  createElement,
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { activeTerm, useDshellTheme } from './theme.js'
import { PtyCanvas } from './canvas.js'
import type { SessionMode } from './types.js'

const chipSeatStyle: CSSProperties = { position: 'relative', display: 'flex' }

export interface DshellInputStandardProps {
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
export function DshellLeftControls(props: {
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
          const selection = activeTerm.current?.getSelection() ?? ''
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
export class DshellViewBoundary extends Component<{ children: ReactElement }, { error: string | null }> {
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
export function DshellTerminalView(props: {
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


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
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useDshellTheme } from './theme.js'
import type { SessionMode } from './types.js'

const chipSeatStyle: CSSProperties = { position: 'relative', display: 'flex' }

export interface DshellInputStandardProps {
  /**
   * Live composer state — the submit router reads the draft and the pending
   * attachment ids. The declared shape is the subset dshell touches; the stock
   * store carries more.
   */
  useInput?: <S>(sel: (state: { draft: string; attachmentIds?: readonly string[] }) => S, eq?: (a: S, b: S) => boolean) => S
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
  // A pending attachment is the one thing bash cannot receive. Routing is
  // decided here, not in bash: with a file attached the stock pipeline runs,
  // which is what puts the image in front of the model.
  const attachmentCount = props.useInput?.(state => state.attachmentIds?.length ?? 0) ?? 0
  const attachmentsRef = useRef(attachmentCount)
  attachmentsRef.current = attachmentCount
  const modeRef = useRef(mode)
  modeRef.current = mode
  // Agent mode gives the keyboard back to the stock composer editor. The
  // block view never takes focus for itself, so nothing has to be blurred.
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
      // Leave an attached message to the stock sender: a shell has no way to
      // read an image, and dropping the attachment silently is worse than
      // answering in the wrong surface.
      if (attachmentsRef.current > 0) return false
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
      mode === 'shell'
        ? (attachmentCount > 0 ? '有附件：Enter 发送给 AI · 附件已转对话' : '直接输入 · Ctrl+C 中断 · Ctrl+Shift+C 复制')
        : 'Enter 发送对话 · /agent 切终端'),
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

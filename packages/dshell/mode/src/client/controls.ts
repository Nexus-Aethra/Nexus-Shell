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
import type { ShellCompletion } from './completion.js'
import { useDshellTheme } from './theme.js'
import type { SessionMode } from './types.js'

const chipSeatStyle: CSSProperties = { position: 'relative', display: 'flex' }

/** The completion seat, created once per browser face and shared with the list. */
export interface DshellInputCompletion {
  readonly completion: ShellCompletion
}

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
} & DshellInputStandardProps & DshellInputCompletion): ReactElement | null {
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
  const sessionIdRef = useRef(props.sessionId)
  sessionIdRef.current = props.sessionId
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
  const completion = props.completion
  const completeOpen = useSyncExternalStore(
    completion.store.subscribe,
    () => completion.store.getSnapshot() !== null,
  )

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
      // The terminal owns the directory; this is how our mirror of it follows.
      completion.trackCd(String(sessionIdRef.current), text)
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
    // Shell-mode completion. dsh's trigger menu floats in the same overlay and
    // marks itself `data-trigger-menu`.
    const stockMenu = (): boolean => document.querySelector('[data-trigger-menu]') !== null
    /**
     * Whether dsh's menu is the one that should answer Tab.
     *
     * Its slash rule is positional, not path-aware: any `/` after punctuation
     * opens a command trigger, so typing `ls ~/` pops the command list with an
     * empty query and Tab would PICK a command, mangling the shell line. Only a
     * leading slash is a command here (`/clear`); a slash later in the line is
     * an argument, which in shell mode is a path.
     */
    const stockCommand = (): boolean => stockMenu() && draftRef.current.trimStart().startsWith('/')
    /**
     * Close the stock menu the way the framework closes it on a click outside
     * the composer (MenuView's own pointerdown listener asks the controller to
     * dismiss). Called before this completion takes the overlay so the two
     * never stack, and because leaving it open is what let Tab reach it.
     */
    const dismissStock = (): void => {
      if (!stockMenu()) return
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    }
    const pathLike = (token: string): boolean =>
      token.startsWith('/') || token.startsWith('.') || token.startsWith('~') || token.includes('/')
    // The line's last whitespace-delimited token, plus whether a word precedes
    // it. The caret is assumed to be at the end of the draft, which is where
    // shell lines are typed. Whitespace at the end is NOT trimmed: a draft
    // ending in a space is starting a NEW argument, and that empty token is
    // what makes `ls <Tab>` list the directory instead of reading the whole
    // draft as the bare command word `ls`.
    const tokenOf = (text: string): { token: string; argument: boolean } => {
      const cut = Math.max(
        text.lastIndexOf(' '), text.lastIndexOf('\t'), text.lastIndexOf('\n'),
      )
      if (cut < 0) return { token: text, argument: false }
      return {
        token: text.slice(cut + 1),
        argument: text.slice(0, cut).trim().length > 0,
      }
    }
    const onCompletionKey = (event: KeyboardEvent): boolean => {
      const sessionId = sessionIdRef.current
      if (modeRef.current !== 'shell' || sessionId === undefined || clearDraft === undefined) return false
      /**
       * Write a completion into the composer.
       *
       * A directory lands with its trailing slash, and a trailing slash is a
       * live trigger for dsh's menu — a command list, which is never what a
       * shell line wants there. The trigger pass runs after this write, so the
       * dismiss is deferred one task rather than fired inline.
       */
      const writeDraft = (text: string): void => {
        clearDraft(text)
        window.setTimeout(dismissStock, 0)
      }
      const open = completion.store.getSnapshot()
      const key = event.key
      if (key === 'Escape') {
        if (open === null) return false
        completion.store.set(null)
        return true
      }
      // Tab and the arrows are the same gesture over an open list: move the
      // highlight AND put it in the draft. Applying on the move is what keeps
      // the visible text and the highlight from ever disagreeing — the composer
      // is the input line, so whatever is highlighted has to be what Enter
      // would send.
      const cycling = open !== null && open.items.length > 0
      if (cycling && (key === 'Tab' || key === 'ArrowDown' || key === 'ArrowUp')) {
        const back = key === 'ArrowUp' || (key === 'Tab' && event.shiftKey)
        const index = (open.index + (back ? -1 : 1) + open.items.length) % open.items.length
        const next = completion.apply(open, index, draftRef.current)
        if (next !== undefined) {
          writeDraft(next.text)
          completion.store.set(next.state)
        }
        return true
      }
      if (key !== 'Tab') {
        // Any other edit or caret move invalidates the list: its offsets assume
        // the caret sits at the end of the draft. The next Tab rebuilds it.
        const stales = key.length === 1 || key === 'Backspace' || key === 'Delete'
          || key === 'ArrowLeft' || key === 'ArrowRight'
        if (open !== null && stales) completion.store.set(null)
        return false
      }
      // A fresh Tab: ask the host for the candidates under this token.
      const draftNow = draftRef.current
      const { token, argument } = tokenOf(draftNow)
      // dsh's own triggers keep their keys: `@` is its file reference, whose
      // menu the stock pipeline arbitrates (a leading slash never reaches here —
      // see stockCommand).
      if (token.startsWith('@')) return false
      // A token after the command word is an argument, so it names a path even
      // without a slash (`ls comp<Tab>` completes against the tracked cwd) — and
      // an EMPTY token there is the start of one, which is `ls <Tab>` listing
      // the directory. A lone first token could be a command name, which this
      // does not do yet.
      if (!argument && !pathLike(token)) {
        // Nothing here to complete, but Tab still must not leave the input:
        // the composer IS the terminal's input line, and a terminal's Tab never
        // moves focus — letting it fall through is what landed the user on the
        // composer's buttons. Shift+Tab is left alone as the way back out.
        return !event.shiftKey
      }
      // A visible stock menu here is a command list for what is really a path
      // (see stockCommand): close it before the one round trip, so the two
      // overlays never share the seat.
      dismissStock()
      event.preventDefault()
      event.stopImmediatePropagation()
      void completion.request(sessionId, draftNow, draftNow.length).then((state) => {
        if (state === null) { completion.store.set(null); return }
        // A bare word with no match is more likely a non-path argument
        // (`echo hi<Tab>`) than a failed path completion, so it stays quiet:
        // the shell's own answer to "no matches" is silence, not a card.
        if (state.items.length === 0 && !pathLike(token)) { completion.store.set(null); return }
        // One candidate is the whole answer: substitute it (a directory lands
        // with its slash) and close the list. The next Tab asks again, which is
        // how a directory's contents get listed — the shell's own rhythm.
        if (state.items.length === 1) {
          const next = completion.apply(state, 0, draftNow)
          if (next !== undefined) writeDraft(next.text)
          completion.store.set(null)
          return
        }
        completion.store.set(state)
      }).catch(() => { completion.store.set(null) })
      return true
    }
    const onKeyDownFull = (event: KeyboardEvent): void => {
      const target = event.target
      const inCard = target instanceof Element && target.closest('[data-composer-card]') !== null
      if (!inCard || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
      if (stockCommand()) return
      if (onCompletionKey(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
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
    document.addEventListener('keydown', onKeyDownFull, true)
    document.addEventListener('click', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keydown', onKeyDownFull, true)
      document.removeEventListener('click', onPointerDown, true)
    }
  }, [pty, sendShell, clearDraft, completion, sessionIdRef])

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
        ? (attachmentCount > 0
          ? '有附件：Enter 发送给 AI · 附件已转对话'
          : completeOpen
            ? 'Tab 下一个 · ↑↓ 选择 · Esc 关闭'
            : '直接输入 · Tab 补全路径 · Ctrl+C 中断')
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

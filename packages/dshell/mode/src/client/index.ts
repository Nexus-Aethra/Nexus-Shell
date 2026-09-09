/**
 * dshell-mode browser face — Phase 5 (fused terminal dock).
 *
 * The dock is dshell's primary surface: it shadows the stock composer bar
 * (`conversation.composer.bar`, priority -1 — lowest renders) and replaces
 * the chat-shaped InputBar with a single full-bleed terminal-style column:
 * the main PTY scrollback streams above a monospace input line at the
 * bottom. Mode chip + model chip live inline with the input.
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

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  background: '#0d0d10',
  color: '#d6d6dc',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.45,
}
const scrollStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: '10px 12px 4px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}
const inputBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  borderTop: '1px solid #1f1f24',
  padding: '8px 12px',
  flex: '0 0 auto',
}
const modeChipStyle: CSSProperties = {
  border: '1px solid #3a3a42',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
}
const inputStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 13,
  minWidth: 0,
}
const errorStyle: CSSProperties = {
  color: '#f87171',
  fontSize: 12,
  padding: '0 4px',
}
const chipSeatStyle: CSSProperties = { position: 'relative', display: 'flex' }
const chipMenuStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  right: 0,
  minWidth: 220,
  maxHeight: 320,
  overflowY: 'auto',
  background: '#16161a',
  border: '1px solid #2c2c33',
  borderRadius: 8,
  padding: 4,
  zIndex: 30,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
}
const chipGroupStyle: CSSProperties = {
  fontSize: 11,
  color: '#8a8a94',
  padding: '6px 8px 2px',
  whiteSpace: 'nowrap',
}
const chipItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  borderRadius: 5,
  padding: '5px 8px',
  fontSize: 12,
  whiteSpace: 'nowrap',
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
  const currentLabel = current === null ? '模型' : current.model
  const groups = state.groups
  return createElement('div', { style: chipSeatStyle },
    createElement('button', {
      style: modeChipStyle,
      title: '切换模型',
      onClick: () => {
        setOpen(!open)
        props.face.load()
      },
    }, `▣ ${currentLabel}`),
    open ? createElement('div', { style: chipMenuStyle },
      groups.length === 0
        ? createElement('div', { style: chipGroupStyle },
          state.status === 'loading' ? '目录加载中…' : '目录暂可用')
        : groups.map(group =>
          createElement('div', { key: group.id },
            createElement('div', { style: chipGroupStyle }, group.name),
            group.models.map(model => createElement('button', {
              key: model.id,
              style: {
                ...chipItemStyle,
                background: current?.provider === group.id && current?.model === model.id
                  ? '#26262e'
                  : 'transparent',
              },
              onClick: () => {
                setOpen(false)
                void props.face.select({ provider: group.id, model: model.id })
              },
            }, current?.provider === group.id && current?.model === model.id
              ? `✓ ${model.name}`
              : model.name)),
          )),
    ) : null,
  )
}

/** Auto-scrolling PTY pane: only pins to the bottom when content overflows. */
function PtyScrollback(props: { pty: PtyStreamService; sessionId: SessionId | undefined }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  // Re-render on every bridge store change so the latest PTY chunk shows.
  useSyncExternalStore<PtyStreamState>(
    props.pty.state.subscribe,
    () => props.pty.state.getSnapshot(),
  )
  const sessionId = props.sessionId
  const text = sessionId === undefined ? '' : props.pty.read(String(sessionId))
  const cleaned = text.length === 0 ? '' : text.replace(OSC_DS_PROBE, '').replace(/\u0007/g, '')
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
  const mode = useSyncExternalStore(
    props.mode?.subscribe ?? (() => () => {}),
    props.mode?.getSnapshot ?? (() => 'shell' as SessionMode),
  )

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
      ? '输入命令 — /agent 切到对话'
      : '与 AI 对话 — /shell 切回命令'

  return createElement('div', { style: rootStyle, 'data-dshell-dock': '' },
    props.pty !== undefined
      ? createElement(PtyScrollback, { pty: props.pty, sessionId: props.sessionId })
      : createElement('div', { style: { ...scrollStyle, color: '#6a6a74' } }, '正在加载终端…'),
    createElement('div', { style: inputBarStyle },
      createElement('button', {
        style: modeChipStyle,
        title: '点击切换模式（/agent、/shell）',
        onClick: () => { props.mode?.set(mode === 'shell' ? 'agent' : 'shell') },
      }, mode === 'shell' ? '⌨ shell' : '✳ agent'),
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
          }
        },
      }),
      props.sessionId !== undefined && props.model !== undefined
        ? createElement(ModelChip, { face: props.model })
        : null,
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
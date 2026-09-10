import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
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
import type { PtyStreamService } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BlockView } from './block-view.js'
import { DshellLeftControls, DshellTerminalView } from './controls.js'
import { THEMES, setTheme, themeStore } from './theme.js'
import type { ModelChipFace, ModelDirectoryFace, SessionMode } from './types.js'

export const name = '@deepseek-ai/dsh-dshell-mode/client'

export const inject = ['slots', 'sessions', 'dshellPtyStream', 'modelDirectories', 'uiConversation'] as const

/** Per-message routing mode for one session. */
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
  const uiConversation = ctx.get('uiConversation') as unknown as {
    imageUrl: (sessionId: SessionId, attachment: Parameters<MessageImageLoader>[0]) => Promise<string>
  }
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
  // The block view renders the same merged timeline through DOM blocks: a
  // shell command run and an agent task are peer cards, and shell fidelity
  // comes from a real terminal per block (see `block-terminal`). Registered as
  // a sibling tab rather than a replacement while it grows input parity with
  // the canvas — the tab strip is dsh's, so switching needs no extra chrome.
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      id: 'blocks',
      name: 'conversation.view',
      order: 10,
      label: () => '块视图',
      inject: (sessionId: SessionId | undefined) => ({
        sessionId,
        pty,
        sessions,
        // Attachments arrive as opaque refs; the conversation service owns the
        // only sanctioned way to turn one into a URL.
        loadImage: sessionId === undefined
          ? undefined
          : (attachment) => uiConversation.imageUrl(sessionId, attachment),
      }),
    },
    BlockView,
  ))
}

export default { name, inject, apply }

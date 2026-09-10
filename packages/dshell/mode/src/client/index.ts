import { type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Conversation SlotMap (input.left / composer.dock seats).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) and the
// generic SlotMap interface that constrains the `inject` name string.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings SlotMap and the ctx.settingsScope merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the plugin-card SlotMap (`settings.plugin.item`).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
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
import { DSHELL_SETTINGS_NAMESPACE, type DshellSettings } from '../theme-settings.js'
import { BlockView, type SshSeat } from './block-view.js'
import { DshellLeftControls } from './controls.js'
import { DshellThemeCard } from './theme-card.js'
import { adoptTheme, connectThemeSettings } from './theme.js'
import type { ModelChipFace, ModelDirectoryFace, SessionMode } from './types.js'

export const name = '@deepseek-ai/dsh-dshell-mode/client'

export const inject = ['slots', 'sessions', 'dshellPtyStream', 'modelDirectories', 'uiConversation', 'settingsScope'] as const

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
 * Mount the mode store and contribute dshell pieces as entries into the
 * stock composer slot hierarchy. The stock `InputBar` is the visible
 * composer (see dsh `ui-conversation/.../InputBar.tsx`); dshell adds
 * the mode chip to `conversation.input.left` and the block view to the
 * conversation's view cell.
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
  // The SSH plugin is a sibling row: present in the dshell bundle, absent in a
  // composition that omits it. The block view only needs its device face for
  // the connection screen, and a missing seat must leave the terminal intact —
  // hence deferred injection rather than a required dependency. The seat object
  // is built once so its identity is stable across renders (the view subscribes
  // to it), and it is structural, so this package needs no import of the SSH
  // bundle: only the runtime service key, which is what the cast pins down.
  const sshHost = ctx as unknown as {
    inject(keys: readonly string[], callback: (scope: {
      /** The SSH client service, reduced to what the block view asks of it. */
      dshellSsh: SshSeat & {
        getSnapshot(): { devices: readonly { id: string; name: string }[] }
      }
    }) => void): unknown
  }
  let sshSeat: SshSeat | undefined
  sshHost.inject(['dshellSsh'], (scope) => {
    const ssh = scope.dshellSsh
    sshSeat = {
      bindingOf: sessionId => ssh.bindingOf(sessionId),
      devices: () => ssh.getSnapshot().devices.map(device => ({ id: device.id, name: device.name })),
      revealSettings: () => ssh.revealSettings(),
      subscribe: listener => ssh.subscribe(listener),
    }
  })
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

  // The palette's durable half. The scope is the Host settings document's
  // mirror: its value wins over the localStorage pre-paint cache on arrival
  // (another browser's change, or this user's earlier session), and each local
  // pick is written back through it. Writing is skipped while the transport
  // reports the namespace unwritable — the local store has already moved, so
  // the pick still takes effect for this browser instead of silently failing.
  const themeScope = ctx.settingsScope.bind<DshellSettings>({ namespace: DSHELL_SETTINGS_NAMESPACE })
  connectThemeSettings((id) => {
    if (!themeScope.getSnapshot().writable) return
    void themeScope.set('theme', id).catch(() => { /* the scope republishes on failure */ })
  })
  const syncTheme = (): void => {
    const snapshot = themeScope.getSnapshot()
    if (snapshot.status === 'ready') adoptTheme(snapshot.value?.theme)
  }
  ctx.effect(() => themeScope.subscribe(syncTheme), 'dshell-mode: theme settings mirror')
  syncTheme()

  // dshell does not shadow the stock composer bar — the stock InputBar owns
  // the composer surface, so the user gets stock features out of the box:
  // the `/` | `@` trigger popup (commands / skills / files / sessions),
  // context-occupancy ring, model select, attachment surface, subagent bar,
  // and send / stop button. dshell contributes exactly two entries:
  //  - `conversation.input.left`  the dual-mode chip + submit router
  //  - `conversation.view` (id `chat`)  the block view
  // The view is the content column above the composer, while
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
  // The palette is a dshell plugin setting, so it lives in the Plugins
  // settings section's "configurable" tab as a card keyed by the namespace it
  // edits — the same namespace this package's Host half registers, which is
  // what makes the tab dispatch the card at all.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: DSHELL_SETTINGS_NAMESPACE },
    DshellThemeCard,
  ))
  // The block view owns the stock `chat` cell (same id, lower priority
  // shadows it). `chat` is dsh's DEFAULT_VIEW_ID, so taking that cell — not a
  // sibling tab — is what makes it the surface every session opens with; a
  // sibling is only reachable through a stored view selection, and dshell
  // hides the tab strip, so a fresh session would silently fall back to
  // whatever else holds `chat`. The shadowed stock entry stays registered, so
  // the child slots it declares (`conversation.chat.node` rows) remain
  // available to other plugins.
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
        // Read at render time, so a plugin that loads after this one is still
        // picked up.
        ssh: sshSeat,
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

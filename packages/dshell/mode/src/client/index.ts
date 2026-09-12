import { type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Conversation SlotMap (input.left / composer.dock seats).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots) and the
// generic SlotMap interface that constrains the `inject` name string.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `sidebar.brand.*` SlotMap so `sidebar.brand.name` is
// accepted as a registration name string.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
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
import type { PipeSeat, PipeTicket } from './status-card.js'
import { injectSidebarCompactCss } from './sidebar-compact.js'
import { DshellLeftControls } from './controls.js'
import { createShellCompletion, ShellCompletionList } from './completion.js'
import { DshellComposerStats } from './composer-stats.js'
import { DshellThemeCard } from './theme-card.js'
import { adoptTheme, connectThemeSettings } from './theme.js'
import type { ModelChipFace, ModelDirectoryFace, SessionMode } from './types.js'

/** The pipe's state before (or without) a buffer service to read it from. */
const EMPTY_PIPE_STATE = { links: [], tickets: [] } as const

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
  // Shell-mode completion's shared state: the Tab interceptor in the composer's
  // left controls writes it, the overlay list reads it, both keep the shell's
  // directory through it (see completion.ts).
  const shellCompletion = createShellCompletion()
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
  // The sidebar's open/close state belongs to dsh's layout service, but
  // dshell must not change it from a bookmark click — the user owns
  // that toggle via the toolbar's "打开/收起侧边栏" button.
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
  // The cross-session pipe is the same story one package over: reached by
  // service key, reduced to the reads the status card's pipe rows need. A
  // composition without `dshell-buffer` simply leaves those rows absent.
  //
  // The seat object is built NOW and forwards to the service whenever it
  // arrives, instead of being captured at the moment the service happens to be
  // available: a view registration memoizes its injected props per session
  // binding, so a seat filled in later would never reach the card that asked
  // for it. Subscribe is forwarded the same way, and subscribers already
  // waiting are woken when the service lands.
  type PipeService = {
    getSnapshot(): { links: readonly { id: string; a: string; b: string }[]; tickets: readonly PipeTicket[] }
    subscribe(listener: () => void): () => void
    load(): Promise<void>
    cancel(ticketId: string): Promise<void>
    setOpen(open: boolean): void
  }
  const pipeListeners = new Set<() => void>()
  let pipeService: PipeService | undefined
  const pipeSeat: PipeSeat = {
    getSnapshot: () => pipeService?.getSnapshot() ?? EMPTY_PIPE_STATE,
    subscribe: (listener) => {
      pipeListeners.add(listener)
      return () => { pipeListeners.delete(listener) }
    },
    load: async () => { await pipeService?.load() },
    cancel: async (ticketId) => { await pipeService?.cancel(ticketId) },
    setOpen: (open) => { pipeService?.setOpen(open) },
  }
  const pipeHost = ctx as unknown as {
    inject(keys: readonly string[], callback: (scope: { dshellBuffer: PipeService }) => unknown): unknown
  }
  pipeHost.inject(['dshellBuffer'], (scope) => {
    pipeService = scope.dshellBuffer
    // Read once AS SOON as the service exists. A card that mounted before it
    // arrived already spent its effect with no service behind the seat, and its
    // dependencies do not change when the service lands — so without this first
    // read the pipe would stay visibly empty until the next unrelated render.
    void pipeService.load()
    const stop = pipeService.subscribe(() => { for (const listener of [...pipeListeners]) listener() })
    for (const listener of [...pipeListeners]) listener()
    return () => {
      stop()
      pipeService = undefined
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

  // Inject once per page load: the rule that suppresses the workspace
  // sidebar's section labels ("会话 (6)", "已归档") in the compact rail
  // state. The rail still draws its icons; the rotated text that would
  // otherwise crowd them is gone. Safe to run before the AppFrame mounts
  // — the rule is scoped by the sidebar root's collapsed class, which is
  // applied on toggle.
  injectSidebarCompactCss()

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
        completion: shellCompletion,
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
  // sibling is only reachable through a stored view selection, so a fresh
  // session would silently fall back to whatever else holds `chat`.
  //
  // The tab strip is visible again (dsh shows it whenever more than one view
  // is registered), and it is built from the RAW entry list rather than the
  // shadowed one — so the stock `ui-chat` entry would appear beside this one,
  // both named `chat`. That row is therefore disabled in the bundle patch
  // (packages/dshell/bundle/cordis.patch.yml): dshell's block view replaces
  // it, and leaving it registered only duplicated the tab. Its two child
  // slots went with it, which costs nothing here — dshell's view renders
  // neither a chat turn node nor `conversation.message.images`, so the
  // plugins that register into them (`ui-goal`, `ui-workflow-run`,
  // `ui-attachment`) would never have been asked to draw anything.
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      id: 'chat',
      name: 'conversation.view',
      priority: -1,
      label: () => '会话',
      inject: (sessionId: SessionId | undefined) => ({
        sessionId,
        pty,
        sessions,
        // Read at render time, so a plugin that loads after this one is still
        // picked up.
        ssh: sshSeat,
        pipe: pipeSeat,
        // Attachments arrive as opaque refs; the conversation service owns the
        // only sanctioned way to turn one into a URL.
        loadImage: sessionId === undefined
          ? undefined
          : (attachment) => uiConversation.imageUrl(sessionId, attachment),
      }),
    },
    BlockView,
  ))
  // Shell-mode path completion's list. It rides the same floating layer inside
  // the composer card as dsh's own trigger menu (the one wildcard-free seat for
  // something that appears above the input line without pushing the layout);
  // the composer's Tab interceptor writes the state it reads.
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
    {
      name: 'conversation.input.overlay',
      id: 'dshell-completion',
      order: 10,
      inject: () => ({ completion: shellCompletion }),
    },
    ShellCompletionList,
  ))
  // The composer dock's readings — turn/step counts with output speed, token
  // total with cache-hit share — ride `conversation.composer.dock`, the row
  // under the composer card. Stock ui-chat owned it (`StatsPills`); disabling
  // that client row to stop it duplicating the view tab took the row with it,
  // so dshell re-registers the same readings from their own packages'
  // projections (`sessionStats`, `tokenUsage`) rather than re-enabling a row
  // that would bring the duplicate tab back. See `composer-stats.ts`.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'dshell-stats', order: 0 },
    DshellComposerStats,
  ))
  // Hide the dsh local-build product label + version pill that sit to the
  // right of the logo in the expanded brand row. The slot is `kind: 'single'`,
  // and any registration shadows the shell's fallback (which would otherwise
  // render `DSH 本地构建` + `0.1.5-rc.1-<sha>-dirty`). Rendering an empty
  // fragment leaves just the mark, since `.brandIdentity` is `inline-flex` and
  // collapses cleanly when the name child is empty. We do not migrate the
  // metadata into Settings: the product name and the build SHA live in the
  // same place the user already knows about (the dsh web footer and the
  // package version), and the user only asked to remove them from the
  // sidebar's most prominent row.
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
    { name: 'sidebar.brand.name' },
    function DshellBrandNamePlaceholder() { return null },
  ))
}

export default { name, inject, apply }

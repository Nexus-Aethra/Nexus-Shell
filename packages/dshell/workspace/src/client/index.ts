/**
 * dshell-workspace browser face — design decision 4.7.
 *
 * Provides the same-key stand-ins that let the stock web-app rows
 * `workspace-controller` and `ui-workspace` be disabled:
 *
 * - `workspaces`: an IWorkspaces whose snapshot is a permanent empty
 *   'pending' list. ConversationRoot's chip-title resolution then falls
 *   through to the session cwd label (its step-4 branch), so the composer
 *   stays live without any workspace; no consumer ever sees a workspace row.
 * - `uiWorkspace`: startSession/connectWorkspace create sessions by cwd
 *   (`sessions.create({ cwd })`, never workspaceId), and boot navigation
 *   opens the most recent ordinary session instead of the most recent
 *   workspace's.
 * - the root `workspaces` standard hook that ConversationRoot requires.
 * - the `sidebar.workspaces` slot: a flat session list replaces the
 *   workspace-grouped browser, keeping multi-session navigation intact. Its
 *   archive group and destructive delete ride the package's own
 *   `/api/dshell/sessions` route (session-list.tsx / archive.ts).
 *
 * React reaches the component through the shell's frozen module table
 * (PLATFORM_MODULES), which is why 'react' is an external in the dshell
 * client bundle preset.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: `ctx.remote` plus the mounted `agentPresets` namespace merge.
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Session Controller service merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces,
  WorkspaceId,
  WorkspaceSnapshot,
  WorkspaceSource,
  WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls ui-sidebar's SlotMap merge ('sidebar.workspaces' hole).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SshSnapshot } from '@deepseek-ai/dsh-dshell-ssh/client'
import { SessionPanelClient } from './archive.js'
import { newSessionDialog } from './dialog-store.js'
import { activeRows, directoryName, presetChoices, type PresetChoice, type SessionRow } from './rows.js'
import { FlatSessionList, type DeviceSeat, type FlatSessionListProps } from './session-list.js'

export const name = '@deepseek-ai/dsh-dshell-workspace/client'

export const inject = ['slots', 'sessions', 'remote', 'remote.agentPresets'] as const

/** The permanent projection of a shell without workspaces. */
const EMPTY_WORKSPACES: WorkspaceSnapshot = {
  items: [],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'pending',
  error: null,
}

/** `workspaces` stand-in: observable empty state, every mutation rejects. */
class DshellWorkspaces extends Service implements IWorkspaces {
  readonly list: WorkspaceSource = {
    getSnapshot: () => EMPTY_WORKSPACES,
    subscribe: () => () => {},
  }

  constructor(ctx: Context, private readonly panel: SessionPanelClient) {
    super(ctx, 'workspaces')
  }

  async create(): Promise<WorkspaceView> {
    throw new Error('dshell: workspace management is removed (dshell design 4.7)')
  }

  async rename(): Promise<WorkspaceView> {
    throw new Error('dshell: workspace management is removed (dshell design 4.7)')
  }

  async delete(): Promise<void> {
    throw new Error('dshell: workspace management is removed (dshell design 4.7)')
  }

  async insertBefore(): Promise<void> {
    throw new Error('dshell: workspace management is removed (dshell design 4.7)')
  }

  /** The stock client archive entry, pointed at dshell's own tag store. */
  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.panel.archive(String(sessionId))
  }

  async insertSessionBefore(): Promise<WorkspaceView> {
    throw new Error('dshell: workspace management is removed (dshell design 4.7)')
  }
}

/** `uiWorkspace` stand-in: cwd-based session flows and boot navigation. */
class DshellUiWorkspace extends Service implements UiWorkspace {
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
    private readonly panel: SessionPanelClient,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => this.watchBootNavigation(), 'dshell-workspace: boot navigation')
  }

  async connectWorkspace(_workspaceId: WorkspaceId): Promise<SessionId> {
    return await this.openBlankSession()
  }

  /**
   * dsh navigation action (rc.1): select a Session. dshell keeps dsh's own
   * selection semantics, so this is the stock `open`.
   */
  openSession(sessionId: SessionId): void {
    this.sessions.open(sessionId)
  }

  /**
   * dsh navigation action (rc.1): "open a Workspace". dshell has no
   * workspaces (design 4.7), so the action lands on the terminal-continuity
   * blank session instead — the same target `connectWorkspace` uses.
   */
  async openWorkspace(_workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    const sessionId = await this.openBlankSession()
    beforeOpen?.(sessionId)
    this.sessions.open(sessionId)
  }

  /** dsh navigation action (rc.1): fork a Session and open the child. */
  async forkSession(sessionId: SessionId): Promise<void> {
    const child = await this.sessions.fork({ sessionId })
    this.sessions.open(child)
  }

  startSession(_workspaceId?: WorkspaceId): void {
    // The stock New-Session affordance opens dshell's naming dialog instead
    // of creating silently (design 4.7 naming paragraph).
    newSessionDialog.set(true)
  }

  /** The stock archive entry, pointed at dshell's own tag store. */
  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.panel.archive(String(sessionId))
  }

  async pickDirectory(): Promise<string | null> {
    throw new Error('dshell: directory picking is removed (dshell design 4.7)')
  }

  async listDirectory(_path?: string, _signal?: AbortSignal): Promise<DirectoryListing> {
    throw new Error('dshell: directory picking is removed (dshell design 4.7)')
  }

  async createDirectory(_path: string, _name: string): Promise<string> {
    throw new Error('dshell: directory picking is removed (dshell design 4.7)')
  }

  /**
   * Rows continuity flows may land on: archived sessions are still real, but
   * they are not what "the last session I used" means to the reader.
   */
  private visibleRows(): SessionRow[] {
    return activeRows(this.sessions.list.getSnapshot(), this.panel.getSnapshot().archived)
  }

  /** The cwd a new session lands in: the requested one, else the most recent session's. */
  private resolveCwd(cwd: string | undefined): string | undefined {
    if (cwd !== undefined && cwd !== '') return cwd
    return this.visibleRows().find(row => !row.blank)?.cwd
  }

  /** Create a session bound to `cwd`; absent cwd falls back to the most recent session's directory, then the server default. */
  private async createCwdSession(cwd: string | undefined): Promise<SessionId> {
    const target = this.resolveCwd(cwd)
    return await this.sessions.create({ ...(target === undefined ? {} : { cwd: target }) })
  }

  /**
   * The new-session dialog's roster. A deployment without the preset service
   * reports `gateway/invocation-unavailable`, which is not an error here:
   * every session then composes from the host default.
   * @returns the selectable presets, empty when none are available.
   */
  async listPresets(): Promise<PresetChoice[]> {
    const result = await this.ctx.remote.agentPresets.list()
    if (!result.ok) return []
    return presetChoices(result.value.presets)
  }

  /**
   * Create or reuse a blank cwd session (design 4.7). The default target
   * directory is the most recent ordinary session's cwd — terminal
   * continuity — and an existing blank session for that directory is reused
   * so repeated new-session actions do not pile up empty shells.
   */
  private async openBlankSession(): Promise<SessionId> {
    const rows = this.visibleRows()
    const targetCwd = rows.find(row => !row.blank)?.cwd
    const reusable = targetCwd === undefined
      ? undefined
      : rows.find(row => row.blank && row.cwd === targetCwd)
    if (reusable !== undefined) return reusable.id
    return await this.createCwdSession(targetCwd)
  }

  /**
   * Create a named session through the new-session dialog (design 4.7
   * naming paragraph): pick the agent preset while the session is still
   * blank (a started session refuses the switch), then one durable rename
   * through the session face. An empty name falls back to the directory
   * name the placeholder promises; pinning that title is what stops the
   * first message's automatic title from renaming the session.
   */
  async createNamedSession(name: string | undefined, cwd: string | undefined, presetId?: string): Promise<SessionId> {
    const target = this.resolveCwd(cwd)
    const sessionId = await this.createCwdSession(target)
    if (presetId !== undefined && presetId !== '') {
      const selected = await this.ctx.remote.agentPresets.select(sessionId, presetId)
      if (!selected.ok) console.warn('dshell: agent preset select failed:', selected.error.message)
    }
    const title = name === undefined || name === '' ? directoryName(target) : name
    if (title !== undefined && title !== '') {
      const binding = this.sessions.binding(sessionId)
      if (binding !== undefined) {
        const result = await binding.session.rename(title)
        if (!result.ok) console.warn('dshell: session rename failed:', result.error.message)
      }
    }
    return sessionId
  }

  /**
   * Boot selection policy: open the most recent ordinary session when the
   * list arrives with nothing on stage. Replaces the stock policy of
   * re-opening the most recent workspace's session.
   */
  private watchBootNavigation(): () => void {
    let armed = true
    const reconcile = (): void => {
      if (!armed) return
      const state = this.sessions.list.getSnapshot()
      if (state.phase !== 'ready') return
      // The archive set decides which sessions are on stage; opening the most
      // recent one before it arrives would resurrect an archived session.
      if (!this.panel.getSnapshot().loaded) return
      armed = false
      const archived = this.panel.getSnapshot().archived
      // dsh restores the last selection from browser storage, so a reload can
      // land on a session that has since been archived — an archived session
      // belongs to the collapsed group, not to the main area.
      const current = state.current
      if (current !== undefined && !archived.includes(String(current))) return
      const latest = activeRows(state, archived).at(0)
      if (latest !== undefined) this.sessions.open(latest.id)
      else if (current !== undefined) this.sessions.clear()
    }
    const dispose = this.sessions.list.subscribe(reconcile)
    // The boot target depends on the archive set, so the tag load is a trigger
    // too: whichever of the two facts arrives last decides.
    const disposePanel = this.panel.subscribe(reconcile)
    reconcile()
    return () => {
      armed = false
      dispose()
      disposePanel()
    }
  }
}

/**
 * Mount the workspace removal: stub services, the root hook, and the flat
 * session list. Nothing from the stock workspace UI survives.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // The host SessionStore declaration is visible in this program too (the
  // package compiles both halves at once), so the client contract needs the
  // explicit two-step cast.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const panel = new SessionPanelClient()
  // The SSH plugin is a sibling row: present in the dshell bundle, absent in a
  // composition that omits it, so the seat is filled by injection rather than
  // assumed. List and dialog both tolerate its absence.
  let deviceSeat: DeviceSeat | undefined
  ctx.inject(['dshellSsh'], (sshCtx) => {
    const ssh = sshCtx.dshellSsh
    deviceSeat = {
      getSnapshot: () => ssh.getSnapshot() as SshSnapshot,
      subscribe: listener => ssh.subscribe(listener),
      devices: () => ssh.getSnapshot().devices.map(device => ({
        id: device.id,
        name: device.name,
        remoteRoot: device.remoteRoot,
      })),
      bind: (sessionId, deviceId, remoteRoot, mount) =>
        ssh.bind(String(sessionId), deviceId, remoteRoot ?? null, mount ?? null),
      mountFor: (deviceId, remoteRoot) => ssh.mountFor(deviceId, remoteRoot),
      test: (deviceId, remoteRoot) => ssh.test(deviceId, remoteRoot),
      revealSettings: () => ssh.revealInSettings(),
      isMountPath: (path) => ssh.isMountPath(path),
    }
  })
  const workspaces = new DshellWorkspaces(ctx, panel)
  const uiWorkspace = new DshellUiWorkspace(ctx, sessions, panel)
  void panel.load()

  // ConversationRoot resolves its chip via the global useWorkspaces hook;
  // the empty 'pending' snapshot routes it to the cwd-label branch.
  ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })

  // dshell is terminal-first: the blank-session hero banner ("探索未至之境")
  // and its workspace chip fight the terminal surface, and neither is a slot,
  // so a plugin cannot unmount them — hide/reposition with a stylesheet. The
  // CSS-module suffixes are stable; the hash prefixes are not, hence the
  // contains-selectors. Nothing here touches the active phase: the stock
  // layout (docked composer + `conversation.view` area) is exactly where the
  // dshell PTY canvas and composer belong, so it stays stock.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshell = 'hero-interim-hide'
    style.textContent = [
      '[class*="heroWorkspaceRow"] { display: none !important; }',
      '[class*="headline"] { display: none !important; }',
      // dshell has ONE surface: the terminal view interleaves PTY output and
      // session records, so the stock view-tab strip (对话/轨迹/终端) only
      // splits the shell in two. The stock views stay registered and the
      // terminal target stays activated — only the switcher row is hidden.
      '[data-slot="conversation.session.header"] [role="tablist"] { display: none !important; }',
      // Hero phase (no open session): pin the composer stack to the bottom of
      // the scroll column instead of the stock vertical center. data-phase is
      // a stable stock attribute on the conversation root.
      '[data-phase="hero"] [class*="scrollBody"] { justify-content: flex-end !important; }',
      '[class*="composerHero"] { padding-bottom: 14px !important; }',
      // The composer is an input line, not a floating dialog card (design
      // 4.8): strip the stock elevation (22px radius, surface fill, soft
      // shadow, hairline stroke) and mark the boundary with one bottom rule
      // that spans the terminal's content width. `data-phase` rides the
      // conversation root, whose inherited geometry variables we retune to
      // the canvas' own 10px inset.
      '[data-phase] { --dsh-composer-side-clearance: 10px !important; --dsh-composer-card-max-width: 100% !important; }',
      '[data-composer-card] {',
      '  border-radius: 0 !important;',
      '  background: transparent !important;',
      '  box-shadow: none !important;',
      '  --dsw-elevation-stroke-color: transparent !important;',
      '  border-bottom: 1px solid var(--dsw-alias-border-l4) !important;',
      '  padding: 6px 0 4px !important;',
      '  gap: 8px !important;',
      '}',
      // The dashed pick-a-workspace ring only makes sense on a rounded card.
      '[data-composer-card]::after { display: none !important; }',
      // Stock chat-width drag handles (a col-resize strip whose ::after is a
      // short 3px glow bar that lights up on hover). They resize the chat
      // content width, which dshell's full-bleed canvas and composer ignore —
      // in a terminal surface they read as a stray sliding light column.
      '[class*="widthHandle"] { display: none !important; }',
    ].join('\n')
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dshell-workspace: hero interim hide')

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      inject: (): FlatSessionListProps => ({
        sessions: sessions.list,
        panel,
        device: deviceSeat,
        refresh: () => sessions.refresh(),
        createSession: (name, cwd, presetId) =>
          uiWorkspace.createNamedSession(name, cwd, presetId).then((sessionId) => {
            sessions.open(sessionId)
            return sessionId
          }),
        listPresets: () => uiWorkspace.listPresets(),
        open: (sessionId) => { sessions.open(sessionId) },
      }),
    },
    FlatSessionList,
  ))
}

export default { name, inject, apply }

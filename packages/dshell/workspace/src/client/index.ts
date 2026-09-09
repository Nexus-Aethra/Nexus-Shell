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
 *   workspace-grouped browser, keeping multi-session navigation intact.
 *
 * React reaches the component through the shell's frozen module table
 * (PLATFORM_MODULES), which is why 'react' is an external in the dshell
 * client bundle preset.
 */

import { createElement, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { Service, type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
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

export const name = '@deepseek-ai/dsh-dshell-workspace/client'

export const inject = ['slots', 'sessions'] as const

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

  constructor(ctx: Context) {
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

  async archiveSession(): Promise<void> {}

  async insertSessionBefore(): Promise<WorkspaceView> {
    throw new Error('dshell: workspace management is removed (dshell design 4.7)')
  }
}

/** dshell session creation: cwd-carrying sessions, never workspace-bound. */
interface SessionRow {
  id: SessionId
  cwd: string | undefined
  blank: boolean
  origin: 'subagent' | undefined
  running: boolean
  displayTitle: string
  updatedAt: number
}

function ordinaryRows(state: SessionListState): SessionRow[] {
  const rows: SessionRow[] = []
  for (const id of state.ids) {
    const row = state.byId[id]
    if (row === undefined || row.origin === 'subagent') continue
    rows.push({
      id: row.id,
      cwd: row.cwd,
      blank: row.blank,
      origin: row.origin,
      running: row.running,
      displayTitle: row.displayTitle,
      updatedAt: row.updatedAt,
    })
  }
  return rows.sort((left, right) => right.updatedAt - left.updatedAt)
}

/** `uiWorkspace` stand-in: cwd-based session flows and boot navigation. */
class DshellUiWorkspace extends Service implements UiWorkspace {
  constructor(ctx: Context, private readonly sessions: ISessions) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => this.watchBootNavigation(), 'dshell-workspace: boot navigation')
  }

  async connectWorkspace(_workspaceId: WorkspaceId): Promise<SessionId> {
    return await this.openBlankSession()
  }

  startSession(_workspaceId?: WorkspaceId): void {
    void this.openBlankSession().then(
      (sessionId) => { this.sessions.open(sessionId) },
      (reason: unknown) => { console.warn('dshell new session failed:', reason) },
    )
  }

  async archiveSession(_sessionId: SessionId): Promise<void> {}

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
   * Create or reuse a blank cwd session (design 4.7). The default target
   * directory is the most recent ordinary session's cwd — terminal
   * continuity — and an existing blank session for that directory is reused
   * so repeated new-session actions do not pile up empty shells.
   */
  private async openBlankSession(): Promise<SessionId> {
    const rows = ordinaryRows(this.sessions.list.getSnapshot())
    const targetCwd = rows.find(row => !row.blank)?.cwd
    const reusable = targetCwd === undefined
      ? undefined
      : rows.find(row => row.blank && row.cwd === targetCwd)
    if (reusable !== undefined) return reusable.id
    return await this.sessions.create({ ...(targetCwd === undefined ? {} : { cwd: targetCwd }) })
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
      armed = false
      if (state.current !== undefined) return
      const latest = ordinaryRows(state).at(0)
      if (latest !== undefined) this.sessions.open(latest.id)
    }
    const dispose = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      armed = false
      dispose()
    }
  }
}

/** Props the sidebar slot injects into the flat session list. */
interface FlatSessionListProps {
  sessions: {
    getSnapshot: () => SessionListState
    subscribe: (listener: () => void) => () => void
  }
  startSession(): void
  open(sessionId: SessionId): void
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: 1,
  overflow: 'hidden',
}
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 8px',
  fontSize: 12,
  opacity: 0.75,
}
const newButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 6px',
}
const rowStyle: CSSProperties = {
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: 13,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const emptyStyle: CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  opacity: 0.5,
}

/** Flat session browser: dshell's replacement for the workspace-grouped list. */
function FlatSessionList(props: FlatSessionListProps): ReactElement {
  const state = useSyncExternalStore(props.sessions.subscribe, props.sessions.getSnapshot)
  const rows = ordinaryRows(state)
  const children = [
    createElement(
      'div',
      { key: 'header', style: headerStyle },
      createElement('span', null, `会话 (${rows.length})`),
      createElement(
        'button',
        { style: newButtonStyle, onClick: () => { props.startSession() } },
        '＋ 新会话',
      ),
    ),
  ]
  if (rows.length === 0) {
    children.push(createElement('div', { key: 'empty', style: emptyStyle }, '暂无会话'))
  }
  for (const row of rows) {
    const selected = state.current === row.id
    children.push(createElement(
      'div',
      {
        key: row.id,
        style: { ...rowStyle, fontWeight: selected ? 600 : 400, opacity: selected ? 1 : 0.8 },
        onClick: () => { props.open(row.id) },
      },
      `${row.running ? '● ' : ''}${row.displayTitle}`,
    ))
  }
  return createElement('div', { style: listStyle }, children)
}

/**
 * Mount the workspace removal: stub services, the root hook, and the flat
 * session list. Nothing from the stock workspace UI survives.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = new DshellWorkspaces(ctx)
  const uiWorkspace = new DshellUiWorkspace(ctx, sessions)

  // ConversationRoot resolves its chip via the global useWorkspaces hook;
  // the empty 'pending' snapshot routes it to the cwd-label branch.
  ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      inject: (): FlatSessionListProps => ({
        sessions: sessions.list,
        startSession: () => { uiWorkspace.startSession() },
        open: (sessionId) => { sessions.open(sessionId) },
      }),
    },
    FlatSessionList,
  ))
}

export default { name, inject, apply }

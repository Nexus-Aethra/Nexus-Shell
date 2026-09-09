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

import { createElement, useSyncExternalStore, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
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

/**
 * New-session dialog signal. The `uiWorkspace.startSession` stand-in is
 * called by dsh's sidebar chrome button, which cannot render dshell UI —
 * the store bridges that service call to the dialog living inside the
 * flat list. Module-level on purpose: one browser window owns one shell
 * (design § 2).
 */
const newSessionDialog = createSnapshotStore(false)

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
    // The stock New-Session affordance opens dshell's naming dialog instead
    // of creating silently (design 4.7 naming paragraph).
    newSessionDialog.set(true)
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

  /** Create a session bound to `cwd`; absent cwd falls back to the most recent session's directory, then the server default. */
  private async createCwdSession(cwd: string | undefined): Promise<SessionId> {
    if (cwd !== undefined) return await this.sessions.create({ cwd })
    const fallback = ordinaryRows(this.sessions.list.getSnapshot()).find(row => !row.blank)?.cwd
    return await this.sessions.create({ ...(fallback === undefined ? {} : { cwd: fallback }) })
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
    return await this.createCwdSession(targetCwd)
  }

  /**
   * Create a named session through the new-session dialog (design 4.7
   * naming paragraph): `sessions.create({ cwd })` then one durable rename
   * through the session face. Auto-titling may overwrite the name on the
   * first message — same lifetime as a stock sidebar rename.
   */
  async createNamedSession(name: string | undefined, cwd: string | undefined): Promise<SessionId> {
    const sessionId = await this.createCwdSession(cwd)
    if (name !== undefined && name !== '') {
      const binding = this.sessions.binding(sessionId)
      if (binding !== undefined) {
        const result = await binding.session.rename(name)
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
  createSession(name: string | undefined, cwd: string | undefined): Promise<void>
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
const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}
const dialogStyle: CSSProperties = {
  background: '#1b1b1f',
  border: '1px solid #33333a',
  borderRadius: 10,
  padding: 18,
  width: 400,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  color: '#e8e8ec',
}
const dialogTitleStyle: CSSProperties = { fontSize: 15, fontWeight: 600 }
const fieldLabelStyle: CSSProperties = { fontSize: 12, opacity: 0.7, marginBottom: 4 }
const fieldInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: '#101013',
  border: '1px solid #3a3a42',
  borderRadius: 6,
  color: 'inherit',
  padding: '7px 9px',
  fontSize: 13,
  outline: 'none',
}
const dialogErrorStyle: CSSProperties = { color: '#f87171', fontSize: 12 }
const dialogActionsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
}
const cancelButtonStyle: CSSProperties = {
  border: '1px solid #3a3a42',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
}
const createButtonStyle: CSSProperties = {
  border: 'none',
  background: '#4f6bed',
  color: '#fff',
  cursor: 'pointer',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
}

/**
 * The new-session dialog (design 4.7 naming paragraph): optional name and
 * starting directory, defaulted to terminal continuity (the most recent
 * session's cwd). Confirm creates the session, renames it durably, and
 * opens it; failures surface inline and keep the dialog up.
 */
function NewSessionDialog(props: {
  defaultCwd: string | undefined
  createSession(name: string | undefined, cwd: string | undefined): Promise<void>
}): ReactElement {
  const [name, setName] = useState('')
  const [dir, setDir] = useState(props.defaultCwd ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await props.createSession(
        name.trim() === '' ? undefined : name.trim(),
        dir.trim() === '' ? undefined : dir.trim(),
      )
      newSessionDialog.set(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  return createElement('div', {
    style: backdropStyle,
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !busy) newSessionDialog.set(false)
    },
  },
    createElement('div', { style: dialogStyle, onClick: (event: ReactMouseEvent<HTMLDivElement>) => { event.stopPropagation() } },
      createElement('div', { style: dialogTitleStyle }, '新会话'),
      createElement('div', null,
        createElement('div', { style: fieldLabelStyle }, '名称'),
        createElement('input', {
          style: fieldInputStyle,
          value: name,
          autoFocus: true,
          placeholder: '可选，留空则用目录名',
          onChange: (event) => { setName(event.target.value) },
          onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
        })),
      createElement('div', null,
        createElement('div', { style: fieldLabelStyle }, '起始目录'),
        createElement('input', {
          style: fieldInputStyle,
          value: dir,
          placeholder: props.defaultCwd === undefined ? '服务器默认目录' : '会话的工作目录',
          onChange: (event) => { setDir(event.target.value) },
          onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
        })),
      error !== null ? createElement('div', { style: dialogErrorStyle }, error) : null,
      createElement('div', { style: dialogActionsStyle },
        createElement('button', {
          style: cancelButtonStyle,
          disabled: busy,
          onClick: () => { newSessionDialog.set(false) },
        }, '取消'),
        createElement('button', {
          style: createButtonStyle,
          disabled: busy,
          onClick: () => { void submit() },
        }, busy ? '创建中…' : '创建'),
      ),
    ))
}

/** Flat session browser: dshell's replacement for the workspace-grouped list. */
function FlatSessionList(props: FlatSessionListProps): ReactElement {
  const state = useSyncExternalStore(props.sessions.subscribe, props.sessions.getSnapshot)
  const dialogOpen = useSyncExternalStore(newSessionDialog.subscribe, newSessionDialog.getSnapshot)
  const rows = ordinaryRows(state)
  const defaultCwd = rows.find(row => !row.blank)?.cwd
  const children = [
    createElement(
      'div',
      { key: 'header', style: headerStyle },
      createElement('span', null, `会话 (${rows.length})`),
      createElement(
        'button',
        { style: newButtonStyle, onClick: () => { newSessionDialog.set(true) } },
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
  return createElement('div', { style: listStyle }, children,
    dialogOpen
      ? createElement(NewSessionDialog, { key: 'dialog', defaultCwd, createSession: props.createSession })
      : null)
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

  // Interim (removed with the Phase 4 scaffold takeover, design 4.8): the
  // stock hero row hardcodes a WorkspaceChip whose label falls back to the
  // session cwd, and the blank-session hero banner ("探索未至之境") plus
  // its centered layout fight the terminal-first surface. None of these
  // are slots, so a plugin cannot unmount them — hide/reposition with a
  // stylesheet instead. The CSS-module suffixes are stable; the hash
  // prefixes are not, hence the contains-selectors.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshell = 'hero-interim-hide'
    style.textContent = [
      '[class*="heroWorkspaceRow"] { display: none !important; }',
      '[class*="headline"] { display: none !important; }',
      // Hero phase (no open session): pin the composer stack to the bottom of
      // the scroll column instead of the stock vertical center. data-phase is
      // a stable stock attribute on the conversation root.
      '[data-phase="hero"] [class*="scrollBody"] { justify-content: flex-end !important; }',
      '[class*="composerHero"] { padding-bottom: 14px !important; }',
      // Active phase: the dock (fused PTY + input) IS the surface; let the
      // composerSeat flex to fill the scroll body, neutralize the slot
      // chain's display:contents + flex:0 1 auto wrappers so the dock's
      // flex sizing reaches it, pin the dock root to the seat, and hide
      // the stock view area / todo strip — content lives in the dock.
      '[data-phase="active"] [class*="composerSeat"] { flex: 1 1 auto !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; }',
      '[data-phase="active"] [data-slot="conversation.composer"] { flex: 1 1 auto !important; display: flex !important; flex-direction: column !important; min-height: 0 !important; }',
      '[data-phase="active"] [class*="composerStack"] { flex: 1 1 auto !important; min-height: 0 !important; }',
      '[data-phase="active"] [data-slot="conversation.composer.bar"] { order: 99 !important; flex: 1 1 auto !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; }',
      '[data-phase="active"] [data-dshell-dock] { flex: 1 1 auto !important; min-height: 0 !important; }',
      '[data-phase="active"] [data-slot="conversation.input.dock"] { display: none !important; }',
      '[data-phase="active"] [class*="viewArea"] { display: none !important; }',
    ].join('\n')
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dshell-workspace: hero interim hide')

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      inject: (): FlatSessionListProps => ({
        sessions: sessions.list,
        createSession: (name, cwd) =>
          uiWorkspace.createNamedSession(name, cwd).then((sessionId) => { sessions.open(sessionId) }),
        open: (sessionId) => { sessions.open(sessionId) },
      }),
    },
    FlatSessionList,
  ))
}

export default { name, inject, apply }

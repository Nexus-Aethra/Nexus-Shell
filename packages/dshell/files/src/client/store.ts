/**
 * The navigator's view state: where each tab is standing, how it got there, and
 * what it has already listed.
 *
 * A Slot-standard exclusive store — one instance per session — bucketed by tab
 * id, because the right pane mounts only the active tab's body: switching tabs
 * unmounts the React tree, so anything held in `useState` would be lost, while
 * this store survives until the tab record itself goes away.
 *
 * Every path here is the canonical absolute path in the session's execution
 * world, exactly as the route reported it.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DshellFileEntry } from '../protocol.js'

/** One directory's contents, as the route answered. */
export interface DirectoryLevel {
  /**
   * The directory's own canonical path, as the world that listed it spells it.
   *
   * Equal to the level's key for a session on this machine. A device session
   * differs: the tab asks in this machine's namespace (its working directory is
   * a local mount directory standing in for the device tree) and the device
   * answers with its own absolute path. That answer is what re-bases the tab,
   * so the `..` row walks the device's tree instead of the mount's parents,
   * which do not exist on the device.
   */
  readonly path: string
  readonly entries: readonly DshellFileEntry[]
  readonly truncated: boolean
  /** Whether the host can send the session's shell into this directory. */
  readonly canCd: boolean
}

/** What one directory level is doing right now. */
export type LevelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly level: DirectoryLevel }
  | { readonly kind: 'failed'; readonly message: string }

/** Where one tab is, and what it remembers. */
export interface FilesTabState {
  /** The session's own directory, where the tab opened. */
  readonly home: string
  /** The directory this tab is showing now. */
  readonly root: string
  /** Visited roots, oldest first, with the current position. */
  readonly history: { readonly stack: readonly string[]; readonly index: number }
  /** Level state by absolute directory path; a path absent here was never asked for. */
  readonly levels: Record<string, LevelState>
  /** Expanded absolute directory paths (paths opened INSIDE the current root). */
  readonly expanded: readonly string[]
  /**
   * Why the last shell jump failed, until the next reading clears it.
   *
   * A jump leaves no trace in the pane — the shell moves in the terminal, not
   * here — so a refused one has to say so somewhere the reader is already
   * looking, or the button would look dead.
   */
  readonly notice?: string | undefined
}

/** Every tab's navigator, keyed by tab id. */
export interface FilesState {
  byTab: Record<TabId, FilesTabState>
}

/** The navigator's write set; every action names the tab it writes. */
type FilesActions = {
  seed: (draft: FilesState, tabId: TabId, home: string) => void
  loading: (draft: FilesState, tabId: TabId, path: string) => void
  loaded: (draft: FilesState, tabId: TabId, path: string, level: DirectoryLevel) => void
  failed: (draft: FilesState, tabId: TabId, path: string, message: string) => void
  toggled: (draft: FilesState, tabId: TabId, path: string) => void
  /** Stand on a directory, recording it in history. */
  navigated: (draft: FilesState, tabId: TabId, path: string) => void
  /** Record why a shell jump was refused, for the pane to show. */
  refused: (draft: FilesState, tabId: TabId, message: string) => void
  back: (draft: FilesState, tabId: TabId) => void
  forward: (draft: FilesState, tabId: TabId) => void
  /** Drop every cached level; the current root is listed again after. */
  reset: (draft: FilesState, tabId: TabId) => void
  forget: (draft: FilesState, tabId: TabId) => void
}

/**
 * One tab's bucket, which every writer after `seed` relies on: the face only
 * dispatches while the record's signal is live, and `forget` runs on its abort.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @returns the tab's navigator.
 */
function bucket(state: FilesState, tabId: TabId): FilesTabState {
  const tab = state.byTab[tabId]
  if (tab === undefined) throw new Error(`dshell-files: no navigator for tab "${tabId}"`)
  return tab
}

/**
 * Land one tab on a directory: the root moves, the position is recorded, and
 * anything ahead of it in history is dropped — the browser rule.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @param path - the directory to stand on.
 */
function standOn(state: FilesState, tabId: TabId, path: string): void {
  const tab = bucket(state, tabId)
  const stack = [...tab.history.stack.slice(0, tab.history.index + 1), path]
  state.byTab[tabId] = {
    ...tab,
    root: path,
    history: { stack, index: stack.length - 1 },
    expanded: [path],
    notice: undefined,
  }
}

/**
 * Declare the navigator's store.
 *
 * A factory rather than a shared handle: the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createDshellFilesStore(): EngineStoreHandle<FilesState, FilesActions> {
  return defineStore({
    init: (): FilesState => ({ byTab: {} }),
    actions: {
      /**
       * Open one tab on the session's directory, with nothing listed yet.
       *
       * Seeding does not list: the body lists the root through one effect, so a
       * fresh tab makes exactly one request instead of racing two.
       */
      seed: (d, tabId: TabId, home: string) => {
        d.byTab[tabId] = { home, root: home, history: { stack: [home], index: 0 }, levels: {}, expanded: [home] }
      },
      /** Mark one directory as being listed. */
      loading: (d, tabId: TabId, path: string) => {
        bucket(d, tabId).levels[path] = { kind: 'loading' }
      },
      /**
       * Record one directory's contents.
       *
       * When the world spells the listed directory differently than the tab
       * asked for — a device session's mount directory is answered as the
       * device's own path — the tab re-bases onto that spelling, history
       * position included, so every later gesture (`..`, a crumb, the child
       * paths) speaks the world's namespace.
       */
      loaded: (d, tabId: TabId, path: string, level: DirectoryLevel) => {
        const tab = bucket(d, tabId)
        if (path === tab.root && level.path !== path) {
          const levels = { ...tab.levels }
          delete levels[path]
          levels[level.path] = { kind: 'ready', level }
          const stack = [...tab.history.stack]
          stack[tab.history.index] = level.path
          d.byTab[tabId] = {
            ...tab,
            root: level.path,
            levels,
            expanded: [level.path],
            history: { stack, index: tab.history.index },
            notice: undefined,
          }
          return
        }
        const levels = { ...tab.levels }
        levels[path] = { kind: 'ready', level }
        d.byTab[tabId] = { ...tab, levels, notice: undefined }
      },
      /** Record why one directory could not be listed. */
      failed: (d, tabId: TabId, path: string, message: string) => {
        bucket(d, tabId).levels[path] = { kind: 'failed', message }
      },
      /**
       * Open a collapsed directory, or collapse an open one.
       *
       * A collapsed level keeps what it loaded, so reopening it draws at once.
       */
      toggled: (d, tabId: TabId, path: string) => {
        const tab = bucket(d, tabId)
        const at = tab.expanded.indexOf(path)
        const expanded = [...tab.expanded]
        if (at >= 0) expanded.splice(at, 1)
        else expanded.push(path)
        d.byTab[tabId] = { ...tab, expanded }
      },
      /** Stand on a directory, recording it in history. */
      navigated: (d, tabId: TabId, path: string) => {
        standOn(d, tabId, path)
      },
      /** Record why a shell jump was refused. */
      refused: (d, tabId: TabId, message: string) => {
        d.byTab[tabId] = { ...bucket(d, tabId), notice: message }
      },
      /** Step one entry back in history. */
      back: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        if (tab.history.index <= 0) return
        const index = tab.history.index - 1
        const root = tab.history.stack[index] as string
        d.byTab[tabId] = { ...tab, root, history: { ...tab.history, index }, expanded: [root] }
      },
      /** Step one entry forward in history. */
      forward: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        if (tab.history.index >= tab.history.stack.length - 1) return
        const index = tab.history.index + 1
        const root = tab.history.stack[index] as string
        d.byTab[tabId] = { ...tab, root, history: { ...tab.history, index }, expanded: [root] }
      },
      /** Drop every cached level, keeping where the tab stands. */
      reset: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        d.byTab[tabId] = { ...tab, levels: {} }
      },
      /** Forget one tab's navigator, for a tab record that is gone. */
      forget: (d, tabId: TabId) => {
        d.byTab = Object.fromEntries(Object.entries(d.byTab).filter(([id]) => id !== tabId))
      },
    },
  })
}

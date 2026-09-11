/**
 * The file navigator's body: one movable tree, rooted wherever the tab stands.
 *
 * The stock Files pane lists the session's working directory and nothing else.
 * This one keeps that tree — a directory still expands in place on a click, a
 * file still opens through the tab owner's `openResource` — and adds the two
 * things a directory browser needs to be walkable:
 *
 *  - a **root** that moves. Double-clicking a directory makes it the new root,
 *    the header's crumbs jump anywhere above it, and a `..` row at the top goes
 *    up one level. The session's own directory is only where the tab opens.
 *  - **history** per tab, with back and forward in the header. Every landing
 *    pushes an entry and drops what was ahead of it, the browser rule, so back
 *    then forward returns to exactly where the reader was.
 *
 * The walk is unbounded on purpose: the listing route reads through the
 * session's own filesystem seam, so a device-bound session walks the device
 * (`/etc` is the device's `/etc`), and a local one walks this machine.
 *
 * The body never awaits anything: it calls the injected face and draws the
 * store. Anything the store does not hold is a request the face has not made
 * yet — the single effect below turns that into exactly one listing.
 */

import { createElement, Fragment, useEffect, type DragEvent as ReactDragEvent, type ReactNode } from 'react'
import {
  FileTypeIcon, IconChevronLeftOutline14, IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline16, IconRightUpOutline16, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the session standard props (`sessionId`, `useSessions`).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the right-Sidebar SlotMap merge (the tab-body seat + its hooks).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DshellFileEntry } from '../protocol.js'
import { parentOf, pathSegments, sessionFileAddress } from './address.js'
import { installDirectoryDrop, startDirectoryDrag } from './drop.js'
import type { FilesInjected } from './face.js'
import type {} from './locales.js'
import * as styles from './styles.js'
import type { FilesTabState, createDshellFilesStore } from './store.js'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createDshellFilesStore>>
  & FilesInjected
  & PropsLocale<'dshellFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name.
 * @param entries - the listing as the route returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly DshellFileEntry[]): DshellFileEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.kind === 'directory') - Number(left.kind === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Row-hover treatment. Inline styles cannot express `:hover`, and a highlighted
 * row is most of what tells a reader which line the pointer is on, so one
 * packaged style element carries it. Scoped to the navigator's own data
 * attributes, so it cannot affect stock chrome.
 */
function injectHoverCss(): () => void {
  const style = document.createElement('style')
  style.dataset.dshell = 'files-nav'
  style.textContent = [
    '[data-dshell-file-row]:hover { background: rgba(127,127,127,.09); border-radius: 6px; }',
    '[data-dshell-file-row][aria-expanded="true"] { background: rgba(127,127,127,.06); border-radius: 6px; }',
    '[data-dshell-file-path]::-webkit-scrollbar { display: none; }',
  ].join('\n')
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** What every level shares: the tab's tree and the gestures. */
interface TreeContext {
  readonly state: FilesTabState
  /** Single click on a directory: open or collapse it in place. */
  readonly onToggle: (path: string) => void
  /** Double click on a directory, or the `..` row: stand there. */
  readonly onEnter: (path: string) => void
  /** A file: hand it to the tab owner for a viewer to claim. */
  readonly onOpen: (path: string) => void
  readonly t: TranslateNS<'dshellFiles'>
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: DshellFileEntry; tree: TreeContext }): ReactNode {
  const path = `${parent.replace(/[/\\]+$/u, '')}/${entry.name}`
  if (entry.kind === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return createElement('li', {
      key: entry.name,
      'data-dshell-file-entry': 'directory',
      'data-dshell-file-path': path,
      // The row is the drag source, not the button inside it: a directory can
      // be dragged to the terminal to move the shell there, and a button is
      // also the click target that expands it.
      draggable: true,
      onDragStart: (event: ReactDragEvent<HTMLLIElement>) => { startDirectoryDrag(event.dataTransfer, path) },
    },
      createElement('button', {
        type: 'button',
        style: styles.rowStyle,
        'data-dshell-file-row': 'directory',
        'aria-expanded': expanded,
        title: entry.name,
        onClick: () => { tree.onToggle(path) },
        onDoubleClick: () => { tree.onEnter(path) },
      },
        createElement('span', { style: styles.iconStyle },
          expanded
            ? createElement(IconFolderOpen16, { size: 16 })
            : createElement(IconFolderClose16, { size: 16 })),
        createElement('span', { style: styles.nameStyle }, entry.name),
      ),
      expanded
        ? createElement('ul', { style: styles.levelStyle }, createElement(Level, { path, tree }))
        : null,
    )
  }
  if (entry.kind === 'file') {
    return createElement('li', {
      key: entry.name, 'data-dshell-file-entry': 'file', 'data-dshell-file-path': path,
    },
      createElement('button', {
        type: 'button',
        style: styles.rowStyle,
        'data-dshell-file-row': 'file',
        title: entry.name,
        onClick: () => { tree.onOpen(path) },
        onDoubleClick: () => { tree.onOpen(path) },
      },
        createElement('span', { style: styles.iconStyle },
          createElement(FileTypeIcon, { kind: classifyFileType(entry.name), size: 16 })),
        createElement('span', { style: styles.nameStyle }, entry.name),
      ),
    )
  }
  return createElement('li', { key: entry.name, 'data-dshell-file-entry': 'other', 'data-dshell-file-path': path },
    createElement('span', {
      style: { ...styles.rowStyle, opacity: 0.5, cursor: 'default' },
      'data-dshell-file-row': 'other',
      title: tree.t('entry.other'),
    }, createElement('span', { style: styles.nameStyle }, entry.name)))
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return createElement('li', { style: styles.noteStyle, 'data-dshell-file-row': 'loading' }, t('loading'))
  }
  if (level.kind === 'failed') {
    return createElement('li', { style: styles.errorStyle, 'data-dshell-file-row': 'failed' },
      t('error.unavailable', { message: level.message }))
  }
  const entries = orderEntries(level.level.entries)
  const rows: ReactNode[] = entries.map(entry => createElement(Entry, { key: entry.name, parent: path, entry, tree }))
  if (entries.length === 0) {
    rows.push(createElement('li', { key: '__empty__', style: styles.noteStyle, 'data-dshell-file-row': 'empty' }, t('empty')))
  }
  if (level.level.truncated) {
    rows.push(createElement('li', { key: '__truncated__', style: styles.noteStyle, 'data-dshell-file-row': 'truncated' }, t('truncated')))
  }
  return createElement(Fragment, null, rows)
}

/** The file navigator's body. */
export function DshellFilesBody({
  useTabInfo, sessionId, useSessions, useStore, start, load, toggle, navigate, cd, back, forward, reload, t,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  // The level the tab stands on, read here rather than at the draw so the drop
  // effect below can be declared with the other hooks, before any early return.
  const rootLevel = state === undefined ? undefined : state.levels[state.root]

  useEffect(injectHoverCss, [])

  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  // Wherever the tab stands with nothing listed is one request. Landing,
  // stepping back or forward, and reloading all arrive here, so the store stays
  // the single source of truth for what is on screen.
  useEffect(() => {
    if (state === undefined || signal.aborted) return
    if (state.levels[state.root] !== undefined) return
    load(tab.id, state.root, signal)
  }, [state, tab.id, signal, load])

  // Dropping a directory on the terminal is the jump button by another gesture,
  // so it goes through the same call and needs the same capability.
  useEffect(() => {
    if (rootLevel === undefined || rootLevel.kind !== 'ready' || !rootLevel.level.canCd) return undefined
    return installDirectoryDrop((path) => { cd(tab.id, path) })
  }, [rootLevel, cd, tab.id])

  if (cwd === undefined) {
    return createElement('div', { style: styles.noteStyle, 'data-dshell-files-state': 'no-workspace' }, t('noWorkspace'))
  }
  if (state === undefined) return null

  const enter = (path: string): void => { navigate(tab.id, path) }
  const tree: TreeContext = {
    state,
    onToggle: (path) => { toggle(tab.id, path, state.levels[path] !== undefined, signal) },
    onEnter: enter,
    onOpen: (path) => { tabActions.openResource(sessionFileAddress(String(sessionId), path)) },
    t,
  }

  const atStart = state.history.index <= 0
  const atEnd = state.history.index >= state.history.stack.length - 1
  // The host says whether it can drive a shell at all; without one the button
  // is absent rather than dead.
  const canCd = rootLevel !== undefined && rootLevel.kind === 'ready' && rootLevel.level.canCd
  const segments = pathSegments(state.root)
  const crumbs = segments.flatMap((segment, index) => {
    const last = index === segments.length - 1
    const nodes: ReactNode[] = []
    // The root crumb IS a `/`, so a separator after it would double it.
    if (index >= 2) nodes.push(createElement('span', { key: `sep:${segment.path}`, style: styles.separatorStyle }, '/'))
    nodes.push(createElement('button', {
      key: segment.path,
      type: 'button',
      style: last ? styles.crumbCurrentStyle : styles.crumbStyle,
      disabled: last,
      title: segment.path,
      'data-dshell-file-crumb': last ? 'current' : 'ancestor',
      onClick: () => { if (!last) enter(segment.path) },
    }, segment.label))
    return nodes
  })

  const parent = parentOf(state.root)
  const rows: ReactNode[] = []
  if (state.notice !== undefined) {
    rows.push(createElement('li', {
      key: '__notice__', style: styles.errorStyle, 'data-dshell-file-row': 'refused',
    }, t('error.cd', { message: state.notice })))
  }
  if (parent !== undefined) {
    rows.push(createElement('li', {
      key: '__parent__',
      'data-dshell-file-entry': 'parent',
      'data-dshell-file-path': parent,
      draggable: true,
      onDragStart: (event: ReactDragEvent<HTMLLIElement>) => { startDirectoryDrag(event.dataTransfer, parent) },
    },
      createElement('button', {
        type: 'button',
        style: styles.rowStyle,
        'data-dshell-file-row': 'parent',
        title: `${t('parent')} · ${parent}`,
        onDoubleClick: () => { enter(parent) },
      },
        createElement('span', { style: styles.iconStyle }, createElement(IconFolderClose16, { size: 16 })),
        createElement('span', { style: styles.parentNameStyle }, '..'),
      )))
  }
  rows.push(createElement(Level, { key: state.root, path: state.root, tree }))

  return createElement('div', {
    style: styles.rootStyle,
    'data-dshell-files-state': 'tree',
    'data-dshell-files-root': state.root,
  },
    createElement('div', { style: styles.headerStyle },
      createElement('button', {
        type: 'button',
        style: atStart ? styles.navButtonOffStyle : styles.navButtonStyle,
        disabled: atStart,
        'aria-label': t('back'),
        title: t('back'),
        'data-dshell-file-nav': 'back',
        onClick: () => { back(tab.id) },
      }, createElement(IconChevronLeftOutline14, { size: 16 })),
      createElement('button', {
        type: 'button',
        style: atEnd ? styles.navButtonOffStyle : styles.navButtonStyle,
        disabled: atEnd,
        'aria-label': t('forward'),
        title: t('forward'),
        'data-dshell-file-nav': 'forward',
        onClick: () => { forward(tab.id) },
      }, createElement(IconChevronRightOutline14, { size: 16 })),
      createElement('div', { style: styles.pathStyle, 'data-dshell-file-path': '', title: state.root }, crumbs),
      canCd
        ? createElement('button', {
          type: 'button',
          style: styles.navButtonStyle,
          'aria-label': t('cd'),
          title: t('cd'),
          'data-dshell-file-nav': 'cd',
          onClick: () => { cd(tab.id, state.root) },
        }, createElement(IconRightUpOutline16, { size: 16 }))
        : null,
      createElement('button', {
        type: 'button',
        style: styles.navButtonStyle,
        'aria-label': t('reload'),
        title: t('reload'),
        'data-dshell-file-nav': 'reload',
        onClick: () => { reload(tab.id, state.root, signal) },
      }, createElement(IconRefreshOutline16, { size: 16 })),
    ),
    createElement('div', { style: styles.bodyStyle },
      createElement('ul', { style: styles.levelStyle }, rows),
    ),
  )
}

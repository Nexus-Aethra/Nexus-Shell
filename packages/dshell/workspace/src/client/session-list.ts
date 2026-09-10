/**
 * Flat session browser: dshell's replacement for the workspace-grouped list
 * (design 4.7), plus the archive group and the session actions built on the
 * package's own session-panel route.
 *
 * One list, two sections: ordinary sessions newest-first, then a collapsed
 * `已归档` group holding the sessions carrying the archive tag. Archiving a
 * session only removes it from the active section — the log stays untouched —
 * so restoring one puts it back exactly where it was. Deleting is the
 * destructive action and always goes through a confirmation dialog.
 *
 * The section's chrome is deliberately quiet: rows are plain lines on the
 * background, and the row actions only appear on hover, so the list reads as
 * a session list rather than a toolbar.
 */

import {
  createElement, useEffect, useState, useSyncExternalStore,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement,
} from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SshSnapshot } from '@deepseek-ai/dsh-dshell-ssh/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPanelClient } from './archive.js'
import { newSessionDialog } from './dialog-store.js'
import { NewSessionDialog } from './new-session-dialog.js'
import { ordinaryRows, type PresetChoice, type SessionRow } from './rows.js'
import {
  archivedRowStyle, backdropStyle, cancelButtonStyle, dangerButtonStyle, dialogActionsStyle,
  dialogBodyStyle, dialogErrorStyle, dialogStyle, dialogTitleStyle, emptyStyle, groupCountStyle,
  groupHeaderStyle, headerStyle, listStyle, newButtonStyle, noticeStyle, rowActionStyle, rowActionsStyle,
  rowStyle, rowTitleStyle, scrollStyle,
} from './list-styles.js'

/** The device face another plugin provides, when the SSH plugin is composed. */
export interface DeviceSeat {
  getSnapshot: () => SshSnapshot
  subscribe: (listener: () => void) => () => void
  /** Registered devices, for the new-session picker. */
  devices: () => readonly { id: string; name: string; remoteRoot: string }[]
  /** Assign a created session to a device (null keeps it local). */
  bind: (sessionId: SessionId, deviceId: string | null) => Promise<void>
}

/** Props the sidebar slot injects into the flat session list. */
export interface FlatSessionListProps {
  sessions: {
    getSnapshot: () => SessionListState
    subscribe: (listener: () => void) => () => void
  }
  panel: SessionPanelClient
  /** Present only when the SSH plugin is part of the composition. */
  device?: DeviceSeat | undefined
  /** Re-read the host session list (after a purge removed a log). */
  refresh: () => Promise<void>
  createSession(
    name: string | undefined,
    cwd: string | undefined,
    presetId: string | undefined,
  ): Promise<SessionId>
  listPresets: () => Promise<PresetChoice[]>
  open(sessionId: SessionId): void
}

/** Empty device snapshot, so the list renders before the SSH plugin answers. */
const NO_DEVICES: SshSnapshot = {
  devices: [], bindings: [], testResult: undefined, error: undefined, loaded: false,
}

/** Stable no-op subscription for a composition without the SSH plugin. */
function noopSubscribe(): () => void {
  return () => {}
}

/**
 * Row-action hover rule. Inline styles cannot express `:hover`, and the action
 * buttons must not reserve space in a 13px row, so one packaged style element
 * reveals them. Scoped to dshell's own data attributes, so it cannot affect
 * stock chrome.
 */
function injectListCss(): () => void {
  const style = document.createElement('style')
  style.dataset.dshell = 'session-list'
  style.textContent = [
    '[data-dshell-row-actions] { opacity: 0; transition: opacity .12s ease; }',
    '[data-dshell-row]:hover [data-dshell-row-actions], [data-dshell-row-actions]:focus-within { opacity: 1; }',
    '[data-dshell-row]:hover { background: rgba(127,127,127,.08); }',
  ].join('\n')
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Chevron for the archived group: one glyph, rotated when open. */
function Chevron({ open }: { open: boolean }): ReactElement {
  return createElement('span', {
    style: {
      display: 'inline-block',
      transition: 'transform .12s ease',
      transform: open ? 'rotate(90deg)' : 'none',
      fontSize: 11,
    } as CSSProperties,
  }, '›')
}

/** One row's visible label, with the running marker the list has always used. */
function rowLabel(row: SessionRow): string {
  return `${row.running ? '● ' : ''}${row.displayTitle}`
}

/** Delete confirmation; the purge is irreversible, so it always asks. */
function DeleteDialog(props: {
  title: string
  busy: boolean
  error: string | undefined
  onCancel: () => void
  onConfirm: () => void
}): ReactElement {
  return createElement('div', {
    style: backdropStyle,
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !props.busy) props.onCancel()
    },
  },
    createElement('div', { style: dialogStyle, onClick: (event: ReactMouseEvent<HTMLDivElement>) => { event.stopPropagation() } },
      createElement('div', { style: dialogTitleStyle }, '删除会话'),
      createElement('div', { style: dialogBodyStyle },
        `将清除「${props.title}」的全部历史：agent 对话记录与终端日志一并删除，无法恢复。`,
        createElement('div', { style: { marginTop: 6, opacity: 0.75 } },
          '仍然装载在本进程里的会话会先释放终端并收进「已归档」，日志在下次启动 dsh 时清除。')),
      props.error !== undefined ? createElement('div', { style: dialogErrorStyle }, props.error) : null,
      createElement('div', { style: dialogActionsStyle },
        createElement('button', {
          style: cancelButtonStyle,
          disabled: props.busy,
          onClick: props.onCancel,
        }, '取消'),
        createElement('button', {
          style: dangerButtonStyle,
          disabled: props.busy,
          onClick: props.onConfirm,
        }, props.busy ? '删除中…' : '删除'),
      ),
    ))
}

export function FlatSessionList(props: FlatSessionListProps): ReactElement {
  const state = useSyncExternalStore(props.sessions.subscribe, props.sessions.getSnapshot)
  const dialogOpen = useSyncExternalStore(newSessionDialog.subscribe, newSessionDialog.getSnapshot)
  const archive = useSyncExternalStore(props.panel.subscribe, props.panel.getSnapshot)
  const deviceSeat = props.device
  const ssh = useSyncExternalStore(
    deviceSeat?.subscribe ?? noopSubscribe,
    deviceSeat?.getSnapshot ?? (() => NO_DEVICES),
  )
  /** The device a session runs on, as a row suffix; local sessions get none. */
  const deviceLabel = (sessionId: SessionId): string => {
    const binding = ssh.bindings.find(entry => entry.sessionId === String(sessionId))
    if (binding === undefined) return ''
    const device = ssh.devices.find(candidate => candidate.id === binding.deviceId)
    return device === undefined ? '' : ` ⌁ ${device.name}`
  }
  const [archivedOpen, setArchivedOpen] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<{ id: SessionId; title: string } | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  useEffect(injectListCss, [])
  useEffect(() => { void props.panel.load() }, [props.panel])

  const rows = ordinaryRows(state)
  const archivedSet = new Set(archive.archived)
  const active = rows.filter(row => !archivedSet.has(String(row.id)))
  const byId = new Map(rows.map(row => [String(row.id), row]))
  // A tag can outlive the row it names (the log was removed outside dshell),
  // so the archived section falls back to the bare id instead of dropping it.
  const archivedRows = archive.archived.map(id => byId.get(id) ?? {
    id: id as SessionId,
    cwd: undefined,
    blank: false,
    origin: undefined,
    running: false,
    displayTitle: id,
    updatedAt: 0,
  } satisfies SessionRow)

  const pendingSet = new Set(archive.pending)

  const confirmDelete = async (): Promise<void> => {
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteError(undefined)
    // Deleting the session on stage would leave the shell pointing at a
    // session dshell just released, so step off it first. A shell with no
    // other session lands in a fresh blank one, the same target the new-
    // session affordance uses.
    if (state.current === deleteTarget.id) {
      const next = active.find(row => row.id !== deleteTarget.id)
      if (next === undefined) await props.createSession(undefined, undefined, undefined)
      else props.open(next.id)
    }
    const refusal = await props.panel.remove(String(deleteTarget.id))
    setDeleting(false)
    if (refusal !== undefined) {
      setDeleteError(refusal)
      return
    }
    setDeleteTarget(undefined)
    await props.refresh()
  }

  const children = [
    createElement(
      'div',
      { key: 'header', style: headerStyle },
      createElement('span', null, `会话 (${active.length})`),
      createElement(
        'button',
        { style: newButtonStyle, onClick: () => { newSessionDialog.set(true) } },
        '＋ 新会话',
      ),
    ),
    createElement('div', { key: 'rows', style: scrollStyle },
      active.length === 0
        ? createElement('div', { key: 'empty', style: emptyStyle }, rows.length === 0 ? '暂无会话' : '所有会话都已归档')
        : null,
      ...active.map((row) => {
        const selected = state.current === row.id
        return createElement('div', {
          key: row.id,
          'data-dshell-row': 'session',
          style: { ...rowStyle, fontWeight: selected ? 600 : 400, opacity: selected ? 1 : 0.8 },
          onClick: () => { props.open(row.id) },
        },
          createElement('span', { style: rowTitleStyle }, `${rowLabel(row)}${deviceLabel(row.id)}`),
          createElement('span', { 'data-dshell-row-actions': 'archive', style: rowActionsStyle },
            createElement('button', {
              style: rowActionStyle,
              title: '归档：从主列表移入已归档分组，日志保留',
              onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                event.stopPropagation()
                void props.panel.archive(String(row.id))
              },
            }, '归档'),
          ),
        )
      }),
      archive.archived.length === 0 ? null : createElement('div', { key: 'archive-group' },
        createElement('div', {
          'data-dshell-row': 'archive-header',
          style: groupHeaderStyle,
          onClick: () => { setArchivedOpen(open => !open) },
        },
          createElement(Chevron, { open: archivedOpen }),
          createElement('span', null, '已归档'),
          createElement('span', { style: groupCountStyle }, String(archive.archived.length)),
        ),
        ...archivedOpen
          ? archivedRows.map((row) => {
            const pending = pendingSet.has(String(row.id))
            return createElement('div', {
              key: `archived-${row.id}`,
              'data-dshell-row': 'archived',
              style: { ...archivedRowStyle, fontWeight: state.current === row.id ? 600 : 400 },
              onClick: () => { props.open(row.id) },
            },
              createElement('span', { style: rowTitleStyle }, pending
                ? `${rowLabel(row)} · 重启后清除`
                : rowLabel(row)),
              createElement('span', { 'data-dshell-row-actions': 'archived', style: rowActionsStyle },
                createElement('button', {
                  style: rowActionStyle,
                  title: pending ? '取消：撤销删除并移回主列表' : '恢复：移回主列表',
                  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation()
                    void props.panel.unarchive(String(row.id))
                  },
                }, pending ? '取消' : '恢复'),
                // A scheduled row's removal is already committed; deleting it
                // again would only re-schedule the same purge.
                pending ? null : createElement('button', {
                  style: rowActionStyle,
                  title: '删除：清除该会话的全部历史',
                  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation()
                    setDeleteError(undefined)
                    setDeleteTarget({ id: row.id, title: row.displayTitle })
                  },
                }, '删除'),
              ),
            )
          })
          : [],
      ),
      archive.error === undefined ? null : createElement('div', { key: 'notice', style: noticeStyle }, archive.error),
    ),
  ]
  return createElement('div', { style: listStyle }, children,
    dialogOpen
      ? createElement(NewSessionDialog, {
        key: 'dialog',
        defaultCwd: rows.find(row => !row.blank)?.cwd,
        createSession: props.createSession,
        listPresets: props.listPresets,
        ...deviceSeat === undefined ? {} : {
          devices: deviceSeat.devices(),
          bind: deviceSeat.bind,
        },
      })
      : null,
    deleteTarget === undefined
      ? null
      : createElement(DeleteDialog, {
        key: 'delete',
        title: deleteTarget.title,
        busy: deleting,
        error: deleteError,
        onCancel: () => { setDeleteTarget(undefined); setDeleteError(undefined) },
        onConfirm: () => { void confirmDelete() },
      }))
}

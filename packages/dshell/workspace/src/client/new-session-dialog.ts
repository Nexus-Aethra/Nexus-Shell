/**
 * The new-session dialog (design 4.7 naming paragraph): optional name and
 * starting directory, defaulted to terminal continuity (the most recent
 * session's cwd). Confirm creates the session, renames it durably, and opens
 * it; failures surface inline and keep the dialog up.
 */

import {
  createElement, useEffect, useState,
  type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactElement,
} from 'react'
import { newSessionDialog } from './dialog-store.js'
import type { PresetChoice } from './rows.js'
import {
  backdropStyle, cancelButtonStyle, createButtonStyle, dialogActionsStyle, dialogErrorStyle,
  dialogStyle, dialogTitleStyle, fieldInputStyle, fieldLabelStyle,
} from './list-styles.js'

/** Props the flat list hands the dialog when it opens. */
export interface NewSessionDialogProps {
  defaultCwd: string | undefined
  listPresets: () => Promise<PresetChoice[]>
  createSession(name: string | undefined, cwd: string | undefined, presetId: string | undefined): Promise<void>
}

export function NewSessionDialog(props: NewSessionDialogProps): ReactElement {
  const [name, setName] = useState('')
  const [dir, setDir] = useState(props.defaultCwd ?? '')
  const [preset, setPreset] = useState('')
  const [presets, setPresets] = useState<PresetChoice[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The roster is read once per dialog open; a failure just hides the field
  // (the host default still applies). The dialog is mounted fresh each open,
  // so the loader identity in deps is deliberately ignored.
  useEffect(() => {
    let alive = true
    void props.listPresets().then(
      (rows) => { if (alive) setPresets(rows) },
      () => { if (alive) setPresets([]) },
    )
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [])
  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await props.createSession(
        name.trim() === '' ? undefined : name.trim(),
        dir.trim() === '' ? undefined : dir.trim(),
        preset === '' ? undefined : preset,
      )
      newSessionDialog.set(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  const presetOptions = presets ?? []
  const presetField = presetOptions.length === 0
    ? null
    : createElement('div', null,
      createElement('div', { style: fieldLabelStyle }, 'Agent 预设'),
      createElement('select', {
        style: fieldInputStyle,
        value: preset,
        disabled: busy,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => { setPreset(event.target.value) },
      },
        createElement('option', { value: '' }, '跟随默认'),
        ...presetOptions.map(choice => createElement('option', { key: choice.id, value: choice.id, title: choice.description ?? '' }, choice.label)),
      ))
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
      presetField,
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

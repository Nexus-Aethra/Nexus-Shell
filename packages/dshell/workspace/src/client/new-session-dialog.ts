/**
 * The new-session dialog (design 4.7 naming paragraph): optional name and
 * starting directory, defaulted to terminal continuity (the most recent
 * session's cwd). Confirm creates the session, renames it durably, and opens
 * it; failures surface inline and keep the dialog up.
 */

import {
  createElement, useEffect, useState,
  type CSSProperties, type ChangeEvent, type MouseEvent as ReactMouseEvent, type ReactElement,
} from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { newSessionDialog } from './dialog-store.js'
import type { PresetChoice } from './rows.js'
import {
  backdropStyle, cancelButtonStyle, createButtonStyle, dialogActionsStyle, dialogErrorStyle,
  dialogStyle, dialogTitleStyle, fieldInputStyle, fieldLabelStyle,
} from './list-styles.js'

/** Where a new session runs. */
type SessionTarget = 'local' | 'ssh'

/**
 * Sliding segmented control for the run target. The two choices are mutually
 * exclusive and the first one is safe (nothing remote is implied), so a picker
 * reads better here than a checkbox: the device list only appears once SSH is
 * chosen.
 */
function TargetSwitch(props: {
  value: SessionTarget
  disabled: boolean
  onChange: (next: SessionTarget) => void
}): ReactElement {
  const options: readonly { id: SessionTarget; label: string }[] = [
    { id: 'local', label: '本机' },
    { id: 'ssh', label: 'SSH 设备' },
  ]
  return createElement('div', {
    style: {
      position: 'relative', display: 'grid', gridTemplateColumns: '1fr 1fr',
      border: '0.5px solid #3a3a42', borderRadius: 999, padding: 2,
      background: '#101013',
    },
  },
    createElement('div', {
      'aria-hidden': true,
      style: {
        position: 'absolute', top: 2, bottom: 2, left: 2, width: 'calc(50% - 2px)',
        borderRadius: 999, background: '#1f1f25', border: '0.5px solid #3a3a42',
        transition: 'transform .16s ease',
        transform: props.value === 'ssh' ? 'translateX(100%)' : 'none',
      } as CSSProperties,
    }),
    ...options.map(option => createElement('button', {
      key: option.id,
      type: 'button',
      'aria-pressed': props.value === option.id,
      disabled: props.disabled,
      onClick: () => { props.onChange(option.id) },
      style: {
        position: 'relative', zIndex: 1, border: 'none', background: 'transparent',
        color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: 13, padding: '6px 0',
        opacity: props.value === option.id ? 1 : 0.7,
      },
    }, option.label)),
  )
}

/** Props the flat list hands the dialog when it opens. */
export interface NewSessionDialogProps {
  defaultCwd: string | undefined
  listPresets: () => Promise<PresetChoice[]>
  createSession(
    name: string | undefined,
    cwd: string | undefined,
    presetId: string | undefined,
  ): Promise<SessionId>
  /** Registered devices, when the SSH plugin is composed. */
  devices?: readonly { id: string; name: string; remoteRoot: string }[] | undefined
  /** Assign the created session to a device; absent keeps it local. */
  bind?: ((sessionId: SessionId, deviceId: string | null) => Promise<void>) | undefined
}

export function NewSessionDialog(props: NewSessionDialogProps): ReactElement {
  const [name, setName] = useState('')
  const [dir, setDir] = useState(props.defaultCwd ?? '')
  const [preset, setPreset] = useState('')
  const [target, setTarget] = useState<SessionTarget>('local')
  const [deviceId, setDeviceId] = useState('')
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
  const devices = props.devices ?? []
  const selectedDevice = devices.find(candidate => candidate.id === deviceId)

  // The directory stays local: it is what the harness itself reads (git root,
  // instructions files). The device's own directory is what the commands run
  // in, and routing applies it on the remote side.
  const targetHint = selectedDevice === undefined
    ? null
    : createElement('div', { style: fieldLabelStyle },
      `该设备上的命令在 ${selectedDevice.remoteRoot} 下执行`)

  /** Choosing SSH lands on the first device, so the picker never means "none". */
  const pickTarget = (next: SessionTarget): void => {
    setTarget(next)
    if (next === 'local') return
    const device = selectedDevice ?? devices[0]
    if (device !== undefined) setDeviceId(device.id)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const sessionId = await props.createSession(
        name.trim() === '' ? undefined : name.trim(),
        dir.trim() === '' ? undefined : dir.trim(),
        preset === '' ? undefined : preset,
      )
      // The assignment is what makes this session's commands run remotely, so
      // a failure here must surface rather than silently run them locally.
      await props.bind?.(sessionId, target === 'ssh' && deviceId !== '' ? deviceId : null)
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
      devices.length === 0
        ? null
        : createElement('div', null,
          createElement('div', { style: fieldLabelStyle }, '运行位置'),
          createElement(TargetSwitch, { value: target, disabled: busy, onChange: pickTarget })),
      target !== 'ssh' || devices.length === 0
        ? null
        : createElement('div', null,
          createElement('div', { style: fieldLabelStyle }, 'SSH 设备'),
          createElement('select', {
            style: fieldInputStyle,
            value: deviceId,
            disabled: busy,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => {
              setDeviceId(event.target.value)
            },
          },
            ...devices.map(device => createElement('option', {
              key: device.id,
              value: device.id,
            }, `${device.name}（${device.remoteRoot}）`)),
          )),
      targetHint,
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

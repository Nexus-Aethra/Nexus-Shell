/**
 * The new-session dialog (design 4.7 naming paragraph): optional name, a run
 * target, and the directory that target starts in. Confirm proves the device
 * when one was chosen (one real ssh round trip, plus the session's remote
 * directory), then creates the session, assigns the device and opens it;
 * failures surface inline and keep the dialog up, so a session that cannot
 * reach its device is never created at all.
 *
 * The two targets ask for different directories, and neither question is
 * interchangeable. A LOCAL session starts in a directory on this machine. An
 * SSH session asks where on the DEVICE to start, and gets a local MOUNT
 * directory here that stands in for that tree: the harness owns the session
 * directory (it creates it, then reads it for instructions files, project
 * discovery and sandbox roots), so it must be a real, empty, readable path on
 * this machine, and the execution seams translate it back to the device.
 */

import {
  createElement, useEffect, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement,
} from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls this namespace's key set (TranslateNS<'dshellWorkspace'>).
import type {} from './locales.js'
import { newSessionDialog } from './dialog-store.js'
import type { PresetChoice } from './rows.js'
import {
  backdropStyle, cancelButtonStyle, createButtonStyle, dialogActionsStyle, dialogErrorStyle,
  dialogStyle, dialogTitleStyle, emptyDeviceStyle, fieldInputStyle, fieldLabelStyle,
  linkButtonStyle,
} from './list-styles.js'
import { SelectMenu } from './select-menu.js'

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
  /** This package's bound translate, threaded from the dialog. */
  t: TranslateNS<'dshellWorkspace'>
}): ReactElement {
  // The option ids are identifiers the switch logic matches on; only the
  // labels are copy, so they are resolved from the dictionary here.
  const options: readonly { id: SessionTarget; label: string }[] = [
    { id: 'local', label: props.t('dialog.new.target.local') },
    { id: 'ssh', label: props.t('dialog.new.target.ssh') },
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
  /** This package's bound translate seat, threaded from the list. */
  t: TranslateNS<'dshellWorkspace'>
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
  bind?: ((
    sessionId: SessionId,
    deviceId: string | null,
    remoteRoot?: string | null,
    mount?: string | null,
  ) => Promise<void>) | undefined
  /**
   * Probe a device before anything is created: one real ssh round trip, plus
   * the session's remote directory. Refuses by throwing, which keeps this
   * dialog open — the point is that a session which cannot reach its device is
   * never created, so no unbound session is left pointing at a mount directory.
   */
  test?: ((deviceId: string, remoteRoot: string | null) => Promise<void>) | undefined
  /** Local mount directory for a device tree; absent disables SSH sessions. */
  mountFor?: ((deviceId: string, remoteRoot: string | null) => Promise<string | undefined>) | undefined
  /**
   * Take the user to the SSH plugin's settings card. Absent when the SSH
   * plugin is not composed, in which case the SSH target is not offered.
   */
  revealSettings?: (() => boolean) | undefined
  /**
   * Whether a directory is a device mount. A local session must never adopt
   * one: the execution seams resolve a mount back to its device, so a session
   * created "local" in a mount directory would run on the device while the
   * sidebar shows no device at all.
   */
  isMountPath?: ((path: string) => boolean) | undefined
}

export function NewSessionDialog(props: NewSessionDialogProps): ReactElement {
  const t = props.t
  const [name, setName] = useState('')
  // Terminal continuity, with one exclusion: the previous session's directory
  // is only a sensible default when it is a real working directory. An SSH
  // session's directory is a mount standing in for a device tree, and adopting
  // it here is what made a new "local" session run on that device.
  const inheritedMount = props.defaultCwd !== undefined && props.isMountPath?.(props.defaultCwd) === true
  const [dir, setDir] = useState(inheritedMount ? '' : props.defaultCwd ?? '')
  const [preset, setPreset] = useState('')
  const [target, setTarget] = useState<SessionTarget>('local')
  const [deviceId, setDeviceId] = useState('')
  const [remoteDir, setRemoteDir] = useState('')
  /** Set once the user edits the remote directory, so a device change stops prefilling it. */
  const [remoteTyped, setRemoteTyped] = useState(false)
  const [presets, setPresets] = useState<PresetChoice[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  /** Which half of a submit is running, so the button can say what it is doing. */
  const [phase, setPhase] = useState<'idle' | 'testing' | 'creating'>('idle')
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

  /**
   * Choosing SSH lands on the first device, so the picker never means "none",
   * and prefills that device's directory. The directory follows the device
   * until the user types one of their own, so changing devices never
   * overwrites a path they just entered.
   */
  const pickDevice = (next: string): void => {
    setDeviceId(next)
    if (remoteTyped) return
    setRemoteDir(devices.find(candidate => candidate.id === next)?.remoteRoot ?? '')
  }
  const pickTarget = (next: SessionTarget): void => {
    setTarget(next)
    if (next === 'local') return
    const device = selectedDevice ?? devices[0]
    if (device !== undefined) pickDevice(device.id)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setPhase('idle')
    setError(null)
    try {
      // A chosen target with nothing to run on must not fall back to local:
      // the session would silently be a local one under an SSH label.
      if (target === 'ssh' && deviceId === '') throw new Error(t('dialog.new.error.sshDevice'))
      // The mirror of that mistake: a local session created in a mount
      // directory is routed to the device by every execution seam.
      if (target === 'local' && dir.trim() !== '' && props.isMountPath?.(dir.trim()) === true) {
        throw new Error(t('dialog.new.error.mountLocal'))
      }
      // An empty directory is not "no choice": dsh then inherits the current
      // session's directory, which can be the mount this dialog just refused
      // to prefill. Asking for one is the only way to keep a local session
      // local, so it is a refusal rather than a silent inherited mount.
      if (target === 'local' && dir.trim() === '' && inheritedMount) {
        throw new Error(t('dialog.new.error.inheritedMount'))
      }
      const remote = target === 'ssh' && deviceId !== ''
      const remoteRoot = remote ? remoteDir.trim() === '' ? null : remoteDir.trim() : null
      // The connection is proved BEFORE the session exists. A device that
      // cannot be reached (or cannot host the directory) is a refusal here,
      // which leaves this dialog open with the reason on it; creating first
      // would leave a session whose commands run locally in an empty mount
      // directory, which is exactly the state that looks like a working
      // remote session and is not one.
      if (remote && props.test !== undefined) {
        setPhase('testing')
        await props.test(deviceId, remoteRoot)
      }
      setPhase('creating')
      // The mount is the session's directory here, so the session cannot be
      // created without it: a device-bound session whose cwd were a normal
      // local directory would look plausible and quietly point nowhere.
      const mount = remote ? await props.mountFor?.(deviceId, remoteRoot) : undefined
      if (remote && mount === undefined) throw new Error(t('dialog.new.error.mountResolve'))
      const sessionId = await props.createSession(
        name.trim() === '' ? undefined : name.trim(),
        remote ? mount : dir.trim() === '' ? undefined : dir.trim(),
        preset === '' ? undefined : preset,
      )
      // The assignment is what makes this session's operations run remotely,
      // so a failure here must surface rather than silently run them locally.
      await props.bind?.(sessionId, remote ? deviceId : null, remoteRoot, mount ?? null)
      newSessionDialog.set(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
      setPhase('idle')
    }
  }
  // Adding a device from inside the dialog leaves the select empty, and no
  // change event ever fires for it; adopt the first device once one exists.
  useEffect(() => {
    if (target !== 'ssh' || deviceId !== '' || devices.length === 0) return
    pickDevice(devices[0]?.id ?? '')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- pickDevice is a plain closure over the same state
  }, [target, deviceId, devices.length])

  const presetOptions = presets ?? []
  const presetField = presetOptions.length === 0
    ? null
    : createElement('div', null,
      createElement('div', { style: fieldLabelStyle }, t('dialog.new.preset')),
      // A SelectMenu rather than a native <select>: the OS-drawn option list
      // cannot be positioned by the page and pops up detached from the
      // control inside this webview.
      createElement(SelectMenu, {
        value: preset,
        disabled: busy,
        options: [
          { id: '', label: t('dialog.new.preset.follow') },
          ...presetOptions.map(choice => ({
            id: choice.id,
            label: choice.label,
            ...(choice.description === undefined ? {} : { title: choice.description }),
          })),
        ],
        onChange: setPreset,
      }))
  return createElement('div', {
    style: backdropStyle,
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !busy) newSessionDialog.set(false)
    },
  },
    createElement('div', { style: dialogStyle, onClick: (event: ReactMouseEvent<HTMLDivElement>) => { event.stopPropagation() } },
      createElement('div', { style: dialogTitleStyle }, t('dialog.new.title')),
      props.revealSettings === undefined
        ? null
        : createElement('div', null,
          createElement('div', { style: fieldLabelStyle }, t('dialog.new.target')),
          createElement(TargetSwitch, { value: target, disabled: busy, onChange: pickTarget, t })),
      target !== 'ssh' || devices.length > 0
        ? null
        : createElement('div', { style: emptyDeviceStyle },
          createElement('span', null, t('dialog.new.noDevices')),
          createElement('button', {
            type: 'button',
            style: linkButtonStyle,
            disabled: busy,
            onClick: () => {
              // The device card lives in Settings → 插件. If the shell's own
              // controls are not where we expect them, say the path instead of
              // silently doing nothing.
              if (props.revealSettings?.() !== true) {
                setError(t('dialog.new.error.settings'))
              }
            },
          }, t('dialog.new.addDevice'))),
      target !== 'ssh' || devices.length === 0
        ? null
        : createElement('div', null,
          createElement('div', { style: fieldLabelStyle }, t('dialog.new.device')),
          createElement(SelectMenu, {
            value: deviceId,
            disabled: busy,
            options: devices.map(device => ({ id: device.id, label: device.name })),
            onChange: pickDevice,
          })),
      target !== 'ssh' || devices.length === 0
        ? null
        : createElement('div', null,
          createElement('div', { style: fieldLabelStyle }, t('dialog.new.remoteDir')),
          createElement('input', {
            style: fieldInputStyle,
            value: remoteDir,
            autoFocus: true,
            placeholder: selectedDevice === undefined ? t('dialog.new.remoteDir.placeholder') : selectedDevice.remoteRoot,
            onChange: (event) => { setRemoteTyped(true); setRemoteDir(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
          })),
      createElement('div', null,
        createElement('div', { style: fieldLabelStyle }, t('dialog.new.name')),
        createElement('input', {
          style: fieldInputStyle,
          value: name,
          placeholder: t('dialog.new.name.placeholder'),
          onChange: (event) => { setName(event.target.value) },
          onKeyDown: (event) => { if (event.key === 'Enter') void submit() },
        })),
      target === 'ssh'
        ? null
        : createElement('div', null,
          createElement('div', { style: fieldLabelStyle }, t('dialog.new.dir')),
          createElement('input', {
            style: fieldInputStyle,
            value: dir,
            placeholder: props.defaultCwd === undefined ? t('dialog.new.dir.placeholderDefault') : t('dialog.new.dir.placeholderSession'),
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
        }, t('dialog.new.cancel')),
        createElement('button', {
          style: createButtonStyle,
          disabled: busy,
          onClick: () => { void submit() },
        }, busy ? phase === 'testing' ? t('dialog.new.testing') : t('dialog.new.creating') : t('dialog.new.create')),
      ),
    ))
}

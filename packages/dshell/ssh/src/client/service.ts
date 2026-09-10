/**
 * The browser half's device state: one snapshot of the registry plus the
 * session assignments, refreshed from the route after every mutation.
 *
 * Other dshell client plugins (the session picker) reach this through the
 * `dshellSsh` service rather than by importing the module, which is the only
 * collaboration path between client bundles.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  DSHELL_SSH_PATH, type DeviceBinding, type DeviceInput, type DeviceView, type SshRequest, type SshResponse,
} from '../protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Device registry mirror provided by dshell-ssh's browser half. */
    dshellSsh: SshClientService
  }
}

/** What the UI renders from. */
export interface SshSnapshot {
  readonly devices: readonly DeviceView[]
  readonly bindings: readonly DeviceBinding[]
  /** Result line of the last successful connection test. */
  readonly testResult: string | undefined
  /** The last refusal or transport failure, shown until the next call. */
  readonly error: string | undefined
  /** Whether the host has answered at least once. */
  readonly loaded: boolean
}

const EMPTY: SshSnapshot = {
  devices: [], bindings: [], testResult: undefined, error: undefined, loaded: false,
}

/** Device registry mirror plus its mutations. */
export class SshClientService extends Service {
  private snapshot: SshSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'dshellSsh')
  }

  getSnapshot = (): SshSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The device one session runs on, or undefined for local execution. */
  deviceOf(sessionId: string): DeviceView | undefined {
    const binding = this.bindingOf(sessionId)
    return binding === undefined
      ? undefined
      : this.snapshot.devices.find(device => device.id === binding.deviceId)
  }

  /** One session's assignment, including any directory override. */
  bindingOf(sessionId: string): DeviceBinding | undefined {
    return this.snapshot.bindings.find(entry => entry.sessionId === sessionId)
  }

  /**
   * Take the user to this plugin's card in the settings panel.
   *
   * There is no service for opening settings: the panel's open state and its
   * selected section are component-local viewing state inside the stock shell
   * (`ui-settings-general`'s `SettingsRoot`), so the only way in is the shell's
   * own controls. This clicks them, then scrolls our card into view — the
   * `data-dshell-card` hook below is what makes the landing point exact rather
   * than "somewhere in the plugins tab".
   *
   * Best-effort by nature: it depends on two stock control labels. A false
   * return tells the caller to describe the path in words instead.
   *
   * @returns whether the settings entry was found and opened.
   */
  revealInSettings(): boolean {
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-expanded]')
    if (trigger === null) return false
    trigger.click()
    // The panel and its section body mount on later frames.
    window.requestAnimationFrame(() => {
      const nav = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find(candidate => ['插件', 'Plugins'].includes(candidate.textContent?.trim() ?? ''))
      nav?.click()
      window.requestAnimationFrame(() => {
        document.querySelector('[data-dshell-card="ssh"]')?.scrollIntoView({ block: 'center' })
      })
    })
    return true
  }

  /** Read the registry. */
  async load(): Promise<void> {
    await this.send({ action: 'list' })
  }

  /** Create or update a device. */
  async save(device: DeviceInput): Promise<void> {
    await this.send({ action: 'save', device })
  }

  /** Remove a device and its stored key. */
  async remove(deviceId: string): Promise<void> {
    await this.send({ action: 'delete', deviceId })
  }

  /** Open one connection and report what answered. */
  async test(deviceId: string): Promise<void> {
    await this.send({ action: 'test', deviceId })
  }

  /**
   * Assign a session to a device, or pass null to run it locally.
   * @param remoteRoot - directory to run in on that device; null uses the
   *   device's own.
   * @param mount - local mount directory for that tree; null keeps the
   *   session's file operations local.
   */
  async bind(
    sessionId: string,
    deviceId: string | null,
    remoteRoot: string | null = null,
    mount: string | null = null,
  ): Promise<void> {
    await this.send({ action: 'bind', sessionId, deviceId, remoteRoot, mount })
  }

  /**
   * The local mount directory for one device tree. The rule lives host-side
   * (it depends on `$DSH_HOME`), so ask rather than deriving it here.
   * @param deviceId - device the tree belongs to.
   * @param remoteRoot - directory on that device; null uses the device's own.
   * @returns the absolute local directory, or undefined if the host refused.
   */
  async mountFor(deviceId: string, remoteRoot: string | null): Promise<string | undefined> {
    const body = await this.send({ action: 'mount', deviceId, remoteRoot })
    return body.mountPath
  }

  /** Clear the last result line. */
  clearResult(): void {
    if (this.snapshot.testResult === undefined && this.snapshot.error === undefined) return
    this.publish({ ...this.snapshot, testResult: undefined, error: undefined })
  }

  private async send(request: SshRequest): Promise<SshResponse> {
    try {
      const response = await fetch(DSHELL_SSH_PATH, {
        method: request.action === 'list' ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...request.action === 'list' ? {} : { body: JSON.stringify(request) },
      })
      const body = await response.json() as SshResponse
      this.publish({
        devices: body.devices,
        bindings: body.bindings,
        testResult: body.testResult,
        error: body.error,
        loaded: true,
      })
      return body
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.publish({ ...this.snapshot, error: reason })
      return { devices: this.snapshot.devices, bindings: this.snapshot.bindings, error: reason }
    }
  }

  private publish(snapshot: SshSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

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
   * Whether a directory is one of this plugin's mount directories.
   *
   * A mount directory stands in for a device tree and every execution seam
   * resolves it back to the device, so it must never become the working
   * directory of a session that is NOT bound to that device. The new-session
   * dialog asks before it reuses a previous session's directory as the local
   * continuity default — that directory can be a mount, and inheriting one is
   * exactly how a "local" session ends up with a remote terminal.
   *
   * @param path - absolute directory to test.
   * @returns whether the path is a mount directory of a current assignment.
   */
  isMountPath(path: string): boolean {
    return this.snapshot.bindings.some(entry => entry.mount === path)
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

  /**
   * Open one connection and report what answered.
   *
   * Throws on refusal: the caller is usually the new-session dialog, which
   * must not create a session it cannot bind. The same failure is published on
   * the snapshot for the settings card, which shows it instead of throwing.
   *
   * @param deviceId - device to connect to.
   * @param remoteRoot - session directory to also prove creatable.
   */
  async test(deviceId: string, remoteRoot: string | null = null): Promise<void> {
    await this.send({ action: 'test', deviceId, remoteRoot }, { strict: true })
  }

  /**
   * Assign a session to a device, or pass null to run it locally.
   *
   * Throws on refusal. A session that stayed unbound while its directory is a
   * device mount is worse than a visible error: nothing routes its commands,
   * so they would run on this machine inside an empty stand-in directory. The
   * dialog keeps itself open on a throw instead of closing over that state.
   *
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
    await this.send({ action: 'bind', sessionId, deviceId, remoteRoot, mount }, { strict: true })
  }

  /**
   * The local mount directory for one device tree. The rule lives host-side
   * (it depends on `$DSH_HOME`), so ask rather than deriving it here.
   * @param deviceId - device the tree belongs to.
   * @param remoteRoot - directory on that device; null uses the device's own.
   * @returns the absolute local directory, or undefined if the host refused.
   */
  async mountFor(deviceId: string, remoteRoot: string | null): Promise<string | undefined> {
    const body = await this.send({ action: 'mount', deviceId, remoteRoot }, { strict: true })
    return body.mountPath
  }

  /** Clear the last result line. */
  clearResult(): void {
    if (this.snapshot.testResult === undefined && this.snapshot.error === undefined) return
    this.publish({ ...this.snapshot, testResult: undefined, error: undefined })
  }

  /**
   * One route call. The refusal is always published on the snapshot so a view
   * that renders from it (the settings card) sees it; `strict` additionally
   * throws it, for callers whose flow must not continue — creating a session
   * that was never bound, or closing the dialog that reported the problem.
   * @param request - request body; `list` travels as a GET.
   * @param options - `strict` rethrows the refusal after publishing it.
   * @returns the response body, or a body synthesized from a transport failure.
   */
  private async send(request: SshRequest, options?: { strict?: boolean }): Promise<SshResponse> {
    const strict = options?.strict === true
    let body: SshResponse
    try {
      const response = await fetch(DSHELL_SSH_PATH, {
        method: request.action === 'list' ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        ...request.action === 'list' ? {} : { body: JSON.stringify(request) },
      })
      body = await response.json() as SshResponse
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.publish({ ...this.snapshot, error: reason })
      if (strict) throw new Error(reason)
      return { devices: this.snapshot.devices, bindings: this.snapshot.bindings, error: reason }
    }
    this.publish({
      devices: body.devices,
      bindings: body.bindings,
      testResult: body.testResult,
      error: body.error,
      loaded: true,
    })
    if (strict && body.error !== undefined) throw new Error(body.error)
    return body
  }

  private publish(snapshot: SshSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

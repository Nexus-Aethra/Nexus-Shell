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
    const binding = this.snapshot.bindings.find(entry => entry.sessionId === sessionId)
    return binding === undefined
      ? undefined
      : this.snapshot.devices.find(device => device.id === binding.deviceId)
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

  /** Assign a session to a device, or pass null to run it locally. */
  async bind(sessionId: string, deviceId: string | null): Promise<void> {
    await this.send({ action: 'bind', sessionId, deviceId })
  }

  /** Clear the last result line. */
  clearResult(): void {
    if (this.snapshot.testResult === undefined && this.snapshot.error === undefined) return
    this.publish({ ...this.snapshot, testResult: undefined, error: undefined })
  }

  private async send(request: SshRequest): Promise<void> {
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.publish({ ...this.snapshot, error: reason })
    }
  }

  private publish(snapshot: SshSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

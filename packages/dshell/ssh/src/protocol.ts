/**
 * dshell-ssh wire — one exact `/api/dshell/ssh` route, plus the device shapes
 * both halves agree on.
 *
 * The route carries what must not travel through the settings document: the
 * private keys themselves. A device's durable record is small JSON; its key is
 * a separate file written 0600 under `$DSH_HOME/dshell/ssh/keys/`.
 *
 * This module is imported by the browser half through the package's
 * `./protocol` subpath, so it must stay free of value imports: anything it
 * pulls in would be bundled into the client.
 */

/** Exact `/api` route path owned by the SSH device registry. */
export const DSHELL_SSH_PATH = '/api/dshell/ssh'

/** Settings namespace owned by this plugin; also the device card's slot key. */
export const SSH_SETTINGS_NAMESPACE = 'dshell-ssh'

/** One configured device as the UI sees it — never includes key material. */
export interface DeviceView {
  readonly id: string
  /** Display name the session picker lists. */
  readonly name: string
  /** Hostname or IP `ssh` connects to. */
  readonly host: string
  /** TCP port; 22 unless the device listens elsewhere. */
  readonly port: number
  /** Login user. */
  readonly user: string
  /** Directory a session bound to this device starts in (the remote path). */
  readonly remoteRoot: string
  /** Whether a private key was stored for this device. */
  readonly hasKey: boolean
}

/** One device as submitted by the UI; `key` is write-only. */
export interface DeviceInput {
  readonly id?: string | undefined
  readonly name: string
  readonly host: string
  readonly port?: number | undefined
  readonly user: string
  readonly remoteRoot?: string | undefined
  /**
   * PEM/OpenSSH private key contents. Omitted keeps the stored key; empty
   * string removes it (the device then relies on the harness user's own ssh
   * agent and config).
   */
  readonly key?: string | undefined
}

/** One session's device binding, kept host-side because execution routing needs it. */
export interface DeviceBinding {
  readonly sessionId: string
  readonly deviceId: string
}

/** One request body the route accepts; `list` is also the GET shape. */
export type SshRequest =
  | { readonly action: 'list' }
  | { readonly action: 'save'; readonly device: DeviceInput }
  | { readonly action: 'delete'; readonly deviceId: string }
  | { readonly action: 'test'; readonly deviceId: string }
  | { readonly action: 'bind'; readonly sessionId: string; readonly deviceId: string | null }

/** One response body; `error` is a refusal the UI shows verbatim. */
export interface SshResponse {
  readonly devices: readonly DeviceView[]
  readonly bindings: readonly DeviceBinding[]
  /** Human-readable result of the last `test`, when one was requested. */
  readonly testResult?: string | undefined
  readonly error?: string | undefined
}

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

/** How a device authenticates. */
export type DeviceAuth = 'key' | 'password'

/** One configured device as the UI sees it — never includes secret material. */
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
  /** Selected login method. */
  readonly auth: DeviceAuth
  /** Whether the secret for {@link auth} (key or password) is stored. */
  readonly hasSecret: boolean
}

/** One device as submitted by the UI; `key` is write-only. */
export interface DeviceInput {
  readonly id?: string | undefined
  readonly name: string
  readonly host: string
  readonly port?: number | undefined
  readonly user: string
  readonly remoteRoot?: string | undefined
  /** Login method; defaults to `key` on create. */
  readonly auth?: DeviceAuth | undefined
  /**
   * PEM/OpenSSH private key contents, used when `auth` is `key`. Omitted keeps
   * the stored secret; empty string removes it (the device then relies on the
   * harness user's own ssh agent and config).
   */
  readonly key?: string | undefined
  /**
   * Password, used when `auth` is `password`. Same omitted/empty semantics as
   * {@link key}.
   */
  readonly password?: string | undefined
}

/** One session's device binding, kept host-side because execution routing needs it. */
export interface DeviceBinding {
  readonly sessionId: string
  readonly deviceId: string
  /**
   * Directory the session's commands run in on that device, when the session
   * overrides the device's own. Absent means the device's `remoteRoot`.
   */
  readonly remoteRoot?: string | undefined
  /**
   * Local directory standing in for that remote tree, which is also the
   * session's own working directory. Absent on bindings written before
   * mount directories existed.
   */
  readonly mount?: string | undefined
}

/** One request body the route accepts; `list` is also the GET shape. */
export type SshRequest =
  | { readonly action: 'list' }
  | { readonly action: 'save'; readonly device: DeviceInput }
  | { readonly action: 'delete'; readonly deviceId: string }
  | {
    readonly action: 'test'
    readonly deviceId: string
    /**
     * Session directory to also prove creatable, so a failing `mkdir` is found
     * before a session is created rather than after. Absent checks only the
     * connection.
     */
    readonly remoteRoot?: string | null
  }
  | {
    readonly action: 'bind'
    readonly sessionId: string
    readonly deviceId: string | null
    /** Remote directory for this session; null or absent uses the device's. */
    readonly remoteRoot?: string | null
    /** Local mount directory for that tree, as returned by `mount`. */
    readonly mount?: string | null
  }
  | {
    /**
     * The local mount directory for one device tree. The rule is host-owned
     * (it depends on `$DSH_HOME`), so the browser asks rather than deriving it.
     */
    readonly action: 'mount'
    readonly deviceId: string
    readonly remoteRoot?: string | null
  }

/** One response body; `error` is a refusal the UI shows verbatim. */
export interface SshResponse {
  readonly devices: readonly DeviceView[]
  readonly bindings: readonly DeviceBinding[]
  /** Human-readable result of the last `test`, when one was requested. */
  readonly testResult?: string | undefined
  /** Local mount directory, answering the `mount` action. */
  readonly mountPath?: string | undefined
  readonly error?: string | undefined
}

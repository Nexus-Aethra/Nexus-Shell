/**
 * Which session runs where, and the one seam that acts on it.
 *
 * Routing is decided per call, not per session object: `ctx.agents.currentInitiator()`
 * is the ambient agent of the executing tool call (the agent loop establishes
 * that boundary for the whole turn), so a bound session's `bash` calls can be
 * redirected without changing any tool signature or re-registering anything.
 *
 * The seam is `ctx.shell.resolve`: the local executor has already applied its
 * defaults and caps by then, so wrapping the resolved command leaves every
 * other property — timeout, output caps, signal, streaming and background
 * handles — in the hands of the stock implementation. Only the command line
 * and the working directory change.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-subprocess'
import { DeviceStore, type DeviceConnection } from './devices.js'
import { sshDeviceRoot } from './paths.js'
import { mountFor, remoteDirFor } from './mount.js'
import { localCwd, remoteShellLine, sshArgv, sshEnv } from './runner.js'

/**
 * Service name under which the router is published.
 *
 * The filesystem provider is loaded as its own plugin — it has to be, to take
 * the stock backend's place — and it resolves a call's session through this
 * router. A provided service is how two plugins in one package share a value
 * without either reaching into the other's instance.
 */
export const SSH_ROUTING_SERVICE = 'dshellSshRouting'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session→device assignments, published by the dshell-ssh plugin. */
    dshellSshRouting: SshRouter
  }
}

/**
 * The one method this module replaces, typed structurally: the concrete
 * executor's own `resolve` signature is all that matters here, and taking the
 * shape rather than an exported class keeps the seam working for any
 * `ctx.shell` provider (`bash-local`, `bash-sandbox`, the win32 rows).
 */
interface ShellExecutorShape {
  resolve(this: unknown, request: ShellExecRequest): ShellExecSpec
}

/** Where one session runs: the device, the directory on it, and its local mount. */
interface Assignment {
  readonly deviceId: string
  /** Session-level directory override; undefined uses the device's own. */
  readonly remoteRoot?: string | undefined
  /** Local directory standing in for that tree; undefined on pre-mount bindings. */
  readonly mount?: string | undefined
}

/** Session → device assignments, durable because routing must survive a restart. */
class BindingStore {
  private loaded = false
  private entries = new Map<string, Assignment>()

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null) return
      for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
        // A bare string is the shape written before sessions could pick their
        // own remote directory; it still means "this device, its directory".
        if (typeof value === 'string' && value.length > 0) {
          this.entries.set(sessionId, { deviceId: value })
          continue
        }
        if (typeof value !== 'object' || value === null) continue
        const record = value as Record<string, unknown>
        const deviceId = record.deviceId
        if (typeof deviceId !== 'string' || deviceId.length === 0) continue
        const remoteRoot = record.remoteRoot
        const mount = record.mount
        this.entries.set(sessionId, {
          deviceId,
          ...typeof remoteRoot === 'string' && remoteRoot.length > 0 ? { remoteRoot } : {},
          ...typeof mount === 'string' && mount.length > 0 ? { mount } : {},
        })
      }
    } catch {
      // No assignments yet.
    }
  }

  get(sessionId: string): Assignment | undefined {
    return this.entries.get(sessionId)
  }

  all(): readonly { sessionId: string; deviceId: string; remoteRoot?: string | undefined; mount?: string | undefined }[] {
    return [...this.entries].map(([sessionId, entry]) => ({ sessionId, ...entry }))
  }

  /**
   * Assign or clear one session's device, durably.
   * @param sessionId - session to assign.
   * @param deviceId - device, or null to run locally again.
   * @param remoteRoot - session directory on that device; null clears the
   *   override so the device's own directory applies.
   * @param mount - local directory standing in for that tree; null omits it,
   *   which leaves the session with no remote file operations (only the shell
   *   path, which needs no mount).
   */
  async set(
    sessionId: string,
    deviceId: string | null,
    remoteRoot: string | null = null,
    mount: string | null = null,
  ): Promise<void> {
    await this.load()
    if (deviceId === null) this.entries.delete(sessionId)
    else {
      const override = remoteRoot === null || remoteRoot.trim() === '' ? {} : { remoteRoot: remoteRoot.trim() }
      const mounted = mount === null || mount.trim() === '' ? {} : { mount: mount.trim() }
      this.entries.set(sessionId, { deviceId, ...override, ...mounted })
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.entries), null, 2), 'utf8')
    await rename(temporary, this.path)
  }
}

/** Devices, their assignments, and the per-call decision they drive. */
export class SshRouter {
  private readonly devices: DeviceStore
  private readonly bindings: BindingStore
  private connections = new Map<string, DeviceConnection>()
  private ready: Promise<void>

  /** @param root - device directory (`$DSH_HOME/dshell/ssh`). */
  constructor(root: string) {
    this.devices = new DeviceStore(root)
    this.bindings = new BindingStore(join(root, 'bindings.json'))
    this.ready = this.reload()
  }

  /** Every configured device. */
  async list() {
    await this.ready
    return await this.devices.list()
  }

  /** Every session→device assignment. */
  async assignments(): Promise<readonly { sessionId: string; deviceId: string; remoteRoot?: string | undefined; mount?: string | undefined }[]> {
    await this.bindings.load()
    return this.bindings.all()
  }

  /**
   * Assign a session to a device, or clear it with `null`.
   * @param sessionId - session to assign.
   * @param deviceId - device, or null to run locally again.
   * @param remoteRoot - directory to run in on that device; null uses the
   *   device's own `remoteRoot`.
   * @param mount - local mount directory for that tree, from {@link mountPath};
   *   null keeps the session's file operations local-only.
   */
  async bind(
    sessionId: string,
    deviceId: string | null,
    remoteRoot: string | null = null,
    mount: string | null = null,
  ): Promise<void> {
    if (deviceId !== null && this.connections.get(deviceId) === undefined) {
      await this.refreshDevices()
      if (this.connections.get(deviceId) === undefined) throw new Error(`未知设备：${deviceId}`)
    }
    await this.bindings.set(sessionId, deviceId, remoteRoot, mount)
  }

  /**
   * Create or update a device, then refresh the routing cache.
   * @param input - submitted device.
   */
  async saveDevice(input: Parameters<DeviceStore['save']>[0]) {
    const view = await this.devices.save(input)
    await this.refreshDevices()
    return view
  }

  /**
   * Remove a device; sessions assigned to it fall back to local execution.
   * @param deviceId - device to remove.
   */
  async removeDevice(deviceId: string): Promise<void> {
    await this.devices.remove(deviceId)
    await this.refreshDevices()
  }

  /**
   * Where one session runs, or undefined for local execution.
   *
   * Synchronous on purpose: it is read inside `spawn`/`resolve`, which cannot
   * await. The caches it reads are filled at load and on every mutation.
   *
   * @param sessionId - ambient agent id of the executing call.
   * @returns the connection, the remote directory and the local mount standing
   *   in for it; `mount` is undefined for a binding written before mounts, so
   *   only the shell path is routed for those.
   */
  targetForSession(
    sessionId: string,
  ): { device: DeviceConnection; remoteRoot: string; mount: string | undefined } | undefined {
    const assignment = this.bindings.get(sessionId)
    if (assignment === undefined) return undefined
    const device = this.connections.get(assignment.deviceId)
    return device === undefined
      ? undefined
      : { device, remoteRoot: assignment.remoteRoot ?? device.remoteRoot, mount: assignment.mount }
  }

  /**
   * The local mount directory for one device tree.
   * @param deviceId - device the tree belongs to.
   * @param remoteRoot - directory on that device; null uses the device's own.
   * @returns absolute local directory (not created here — the session's
   *   creation already creates its working directory).
   */
  async mountPath(deviceId: string, remoteRoot: string | null): Promise<string> {
    if (this.connections.get(deviceId) === undefined) {
      await this.refreshDevices()
      if (this.connections.get(deviceId) === undefined) throw new Error(`未知设备：${deviceId}`)
    }
    const device = this.connections.get(deviceId)
    const root = remoteRoot === null || remoteRoot.trim() === '' ? device?.remoteRoot ?? '~' : remoteRoot.trim()
    return mountFor(deviceId, root)
  }

  /** Connect once and report what answered, for the UI's Test action. */
  async test(deviceId: string, ctx: Context): Promise<string> {
    await this.refreshDevices()
    const device = this.connections.get(deviceId)
    if (device === undefined) throw new Error(`未知设备：${deviceId}`)
    const started = Date.now()
    const argv = sshArgv(device, 'printf "%s|%s|%s" "$(hostname)" "$(id -un)" "$(uname -sr)"')
    const env = sshEnv(device)
    const spec = {
      argv,
      cwd: localCwd(),
      ...Object.keys(env).length === 0 ? {} : { env },
      stdio: {
        stdin: 'ignore' as const,
        stdout: { maxBytes: 8 * 1024 },
        stderr: { maxBytes: 8 * 1024 },
      },
      graceMs: 5_000,
    }
    const handle = ctx.subprocess.spawn(spec)
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text.trim() ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
    if (outcome.exitCode !== 0) {
      throw new Error(stderr !== '' ? stderr : `ssh 退出码 ${String(outcome.exitCode ?? 'signal')}`)
    }
    const [host, user, system] = stdout.split('|')
    return `已连接 ${user ?? ''}@${host ?? device.host}（${system ?? '未知系统'}） · ${String(Date.now() - started)}ms`
  }

  /** Reload the device cache from disk. */
  private async refreshDevices(): Promise<void> {
    const views = await this.devices.list()
    const next = new Map<string, DeviceConnection>()
    for (const view of views) {
      const connection = await this.devices.connection(view.id)
      if (connection !== undefined) next.set(view.id, connection)
    }
    this.connections = next
  }

  private async reload(): Promise<void> {
    // The connection-sharing socket lives here; ssh creates the socket, not
    // the directory, so it has to exist first.
    await mkdir(join(sshDeviceRoot(), 'ctl'), { recursive: true, mode: 0o700 })
    await this.bindings.load()
    await this.refreshDevices()
  }
}

/**
 * Redirect a bound session's shell commands to its device.
 *
 * Only `resolve` is wrapped: it is the single funnel every caller passes
 * through before `run`/`start`, and it already carries the executor's own
 * defaults, so the rewrite cannot drift from the stock behaviour.
 *
 * The wrap is installed on the prototype that OWNS `resolve`, not on the
 * service object. A service is reachable through several access paths —
 * `ctx.shell` and `ctx.get('shell')` are not the same object once a preset
 * realm is involved — while the prototype holding the method is shared by all
 * of them, so one write there is what actually covers every caller. An
 * own-property wrap on one access path silently routes nothing.
 *
 * @param ctx - host context holding the shell service.
 * @param router - device assignments.
 * @returns disposer restoring the original method.
 */
export function installShellRouting(ctx: Context, router: SshRouter): () => void {
  const shell = ctx.get('shell')
  if (shell === undefined) return () => {}
  // The seam goes on the PROTOTYPE, not on the service object. A service is
  // reached through more than one access path — `ctx.shell` and `ctx.get`
  // hand back different objects in a preset realm — and `resolve` is an
  // inherited method, so an own-property wrapper would only cover whichever
  // path happened to be used at install time. The prototype that owns
  // `resolve` is shared by every path, which makes it the one place where a
  // single write is guaranteed to be the funnel all callers pass through.
  let owner = Object.getPrototypeOf(shell) as Record<string, unknown> | null
  while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'resolve')) {
    owner = Object.getPrototypeOf(owner) as Record<string, unknown> | null
  }
  if (owner === null) return () => {}
  const target = owner as unknown as ShellExecutorShape
  const original = target.resolve
  target.resolve = function resolve(this: unknown, request: ShellExecRequest): ShellExecSpec {
    const spec = original.call(this, request)
    const agent = ctx.agents.currentInitiator()
    const target = agent === undefined ? undefined : router.targetForSession(String(agent.id))
    if (target === undefined) return spec
    const { device, remoteRoot, mount } = target
    ctx.logger.info(`dshell-ssh: session "${String(agent?.id)}" runs on device "${device.name}"`)
    // The directory the command runs in follows the caller's, translated: a
    // tool that resolved a relative workdir against the session directory
    // lands in the matching place on the device, and an absolute path the
    // model gave is already a device path. A binding without a mount (written
    // before mounts existed) has nothing to translate and uses the root.
    const remoteDir = mount === undefined
      ? remoteRoot
      : remoteDirFor({ mount, remoteRoot }, spec.workdir)
    return {
      ...spec,
      command: remoteShellLine(device, spec.command, remoteDir),
      workdir: localCwd(),
      // The session's access mode describes what may happen on THIS machine,
      // and the only thing running here now is the `ssh` client. Leaving the
      // policy in place would confine that client — a workspace-write sandbox
      // denies the network, so the connection itself would fail — while the
      // command that actually matters executes under the device's own policy.
      ...spec.sandboxPolicy === undefined
        ? {}
        : { sandboxPolicy: { ...spec.sandboxPolicy, mode: 'danger-full-access' } },
    }
  }
  return () => { target.resolve = original }
}

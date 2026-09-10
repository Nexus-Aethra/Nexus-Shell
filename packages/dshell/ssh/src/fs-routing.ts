/**
 * `ctx.fs`, made device-aware.
 *
 * This provider is loaded INSTEAD of the stock sandbox backend, which is the
 * swap dsh documents for exactly this kind of overlay. It extends that backend
 * (so the local half is the stock implementation verbatim, including the
 * sandbox fence on mutations) and adds one decision per call: which session
 * does this call belong to, and is that session bound to a device?
 *
 * Unbound → `super`, byte-for-byte the behaviour a composition without this
 * package has. Bound → the same operations against the device, over SSH.
 *
 * Dispatch is by the ambient initiator agent, the same signal the shell seam
 * uses, because a call carries no session field: the tool layer resolves paths
 * against its session's cwd and hands the backend only a target.
 *
 * The remote directory a call operates in is derived from the same mapping the
 * session's cwd encodes, so a relative path in a tool argument means the same
 * place to the model, the shell, and the file tools.
 */

import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo,
  FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
// Type-only: pulls the host agent service merge (ctx.agents).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the sandbox-policy service merge (ctx.sandboxPolicy).
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isUnder, toMountPath, type MountMapping } from './mount.js'
import { RemoteFileSystem } from './remote-fs.js'
import { SSH_ROUTING_SERVICE } from './router.js'

/** Remote temp areas a `workspace-write` session may also write, mirroring the local backend's temp allowance. */
const REMOTE_TEMP_ROOTS = ['/tmp', '/var/tmp'] as const

/**
 * The filesystem seam for dshell. Constructing it registers `ctx.fs`, so the
 * composition must disable the stock `fs-sandbox` row: a service name has
 * exactly one provider, and a second registration fails loudly.
 *
 * Deliberately NOT a class plugin: the base class already declares a static
 * `inject`, and a subclass's longer tuple is not assignable to it, so the
 * declaration lives on the exported plugin object instead.
 */
export class DshellFileSystem extends SandboxedFileSystem {
  /** Per-target serialization for remote mutations; the local half has its own. */
  private readonly remoteLocks = new Map<string, Promise<unknown>>()

  /**
   * The device backend for the ambient call, or undefined for a local session.
   *
   * A binding without a mount (written before mount directories existed, or
   * created by hand) routes only the shell path, so file operations stay local
   * rather than guessing at a mapping that was never recorded.
   */
  private remote(): RemoteFileSystem | undefined {
    const agent = this.ctx.agents.currentInitiator()
    if (agent === undefined) return undefined
    const target = this.ctx[SSH_ROUTING_SERVICE].targetForSession(String(agent.id))
    if (target === undefined || target.mount === undefined) return undefined
    const mapping: MountMapping = { mount: target.mount, remoteRoot: target.remoteRoot }
    return new RemoteFileSystem({
      ctx: this.ctx,
      device: target.device,
      mapping,
      diffBasisMaxBytes: this.config.diffBasisMaxBytes,
    })
  }

  /** The mapping for the ambient call, for the policy fence. */
  private mapping(): MountMapping | undefined {
    const agent = this.ctx.agents.currentInitiator()
    if (agent === undefined) return undefined
    const target = this.ctx[SSH_ROUTING_SERVICE].targetForSession(String(agent.id))
    return target === undefined || target.mount === undefined
      ? undefined
      : { mount: target.mount, remoteRoot: target.remoteRoot }
  }

  /** Run one remote mutation under a per-target lock. */
  private async withRemoteLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prior = this.remoteLocks.get(key) ?? Promise.resolve()
    const run = prior.then(op, op)
    const tail = run.then(() => undefined, () => undefined)
    this.remoteLocks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.remoteLocks.get(key) === tail) this.remoteLocks.delete(key)
    }
  }

  /**
   * Apply the per-call policy to a remote mutation.
   *
   * The device has its own permissions; this fence is the harness's own policy
   * statement, so it is enforced here in trusted code against the device path
   * rather than delegated. `workspace-write` contains to the session's remote
   * root (plus the device's temp areas), which is the remote analogue of the
   * local backend's workspace root.
   */
  private fence(mapping: MountMapping, remotePath: string, sandboxPolicy?: SandboxExecutionPolicy): void {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${remotePath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    const allowed = [mapping.remoteRoot, ...REMOTE_TEMP_ROOTS].some(root => isUnder(root, remotePath))
    if (!allowed) {
      throw new FsError(`cannot write "${remotePath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const remote = this.remote()
    return remote === undefined ? await super.resolve(path, opts) : await remote.resolve(path, opts)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const remote = this.remote()
    return remote === undefined ? await super.stat(target, signal) : await remote.stat(target, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const remote = this.remote()
    return remote === undefined ? await super.lstat(path, opts, signal) : await remote.lstat(path, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const remote = this.remote()
    return remote === undefined ? await super.readText(target, signal) : await remote.readText(target, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const remote = this.remote()
    return remote === undefined ? await super.streamText(target, signal) : await remote.streamText(target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const remote = this.remote()
    return remote === undefined
      ? await super.readBytes(target, signal, maxBytes)
      : await remote.readBytes(target, signal, maxBytes)
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const remote = this.remote()
    return remote === undefined
      ? await super.readByteRange(target, range, signal)
      : await remote.readByteRange(target, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const remote = this.remote()
    return remote === undefined ? await super.listDir(target, signal) : await remote.listDir(target, signal)
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const remote = this.remote()
    const mapping = this.mapping()
    if (remote === undefined || mapping === undefined) {
      return await super.writeText(target, content, expected, signal, sandboxPolicy)
    }
    return await this.withRemoteLock(String(target.targetKey), async () => {
      this.fence(mapping, String(target.targetKey), sandboxPolicy)
      return await remote.writeText(target, content, expected, signal)
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const remote = this.remote()
    const mapping = this.mapping()
    if (remote === undefined || mapping === undefined) {
      return await super.editText(target, edit, expected, signal, sandboxPolicy)
    }
    return await this.withRemoteLock(String(target.targetKey), async () => {
      this.fence(mapping, String(target.targetKey), sandboxPolicy)
      return await remote.editText(target, edit, expected, signal)
    })
  }

  /**
   * For a remote target, the URL points at the local mount directory — the one
   * local path that stands for this file. It is an empty shadow by design, so
   * the URL resolves (rather than naming a path that does not exist) without
   * pretending the device's file is on this machine.
   */
  override fileUrl(target: FsTarget): string {
    const mapping = this.mapping()
    if (mapping === undefined) return super.fileUrl(target)
    return pathToFileURL(toMountPath(mapping, String(target.targetKey))).href
  }
}

/**
 * Services this provider needs before it may start.
 *
 * `subprocess` is not incidental: the device half of every operation is an
 * `ssh` invocation, and reaching for a service a context did not inject throws
 * in cordis rather than resolving lazily.
 */
export const inject = ['agents', 'sandboxPolicy', 'subprocess', SSH_ROUTING_SERVICE] as const

/** Config schema, re-exported so the loader applies the base defaults. */
export const Config = DshellFileSystem.Config

/** Plugin entry: one provider instance per composition. */
export function apply(ctx: Context, config: ConstructorParameters<typeof DshellFileSystem>[1]): void {
  new DshellFileSystem(ctx, config)
}

export default { name: 'dshell-fs', inject, Config, apply }

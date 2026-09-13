/**
 * The device's filesystem, as `ctx.fs` sees it.
 *
 * Every operation is one `ssh` invocation running a small POSIX command
 * remotely; the results are parsed back into the seam's vocabulary. Nothing is
 * cached: the harness's staleness guards compare opaque version tokens, so a
 * cache could only ever report a version the device no longer has.
 *
 * Two things are deliberately borrowed from the local backend instead of being
 * re-implemented here, because they are the semantics a wrong copy would
 * silently drift from:
 *
 *  - the literal-edit rules (empty match, ambiguity, replace-all) and the
 *    line-ending discipline (detect, normalize for the diff basis, restore on
 *    write) — mirrored in `./literal-edit.ts` from the local backend, with the
 *    reasoning for the copy recorded there.
 *
 * The device is assumed to have a GNU userland (`stat`, `realpath`, `find`,
 * `mktemp`, `chmod --reference`), which is what a Linux server gives.
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo,
  FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { DeviceConnection } from './devices.js'
import {
  applyLiteralEdit, detectLineEndings, normalizeLineEndings, restoreLineEndings,
} from './literal-edit.js'
import { type MountMapping, remoteDirFor, toRemotePath } from './mount.js'
import { localCwd, quote, sshArgv, sshEnv } from './runner.js'

/** What the remote backend needs to reach one device tree. */
export interface RemoteFsDeps {
  /** Host context, for the subprocess seam. */
  readonly ctx: Context
  /** Device the session runs on. */
  readonly device: DeviceConnection
  /** The session's remote root and the local directory mirroring it. */
  readonly mapping: MountMapping
  /** Overwrite-diff basis limit, matching the local backend's knob. */
  readonly diffBasisMaxBytes: number
}

/** One finished remote command. */
interface RemoteRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly truncated: boolean
}

/** Filesystem type as `stat`/`find` spell it, mapped to the seam's vocabulary. */
type RemoteKind = 'file' | 'directory' | 'other' | 'symlink'

/** One `stat` record. */
interface RemoteStat {
  readonly kind: RemoteKind
  readonly size: number
  readonly version: FsVersion
}

const STAT_FORMAT = '%F|%s|%d|%i|%y|%z'
// The separators are spelled `\0` (backslash, zero) rather than embedded NUL
// bytes on purpose: this string travels as one argv element of the local `ssh`
// process, and a real NUL cannot cross that boundary at all — Node refuses the
// spawn. The remote login shell passes the two characters through its single
// quotes untouched, and GNU `find -printf` turns `\0` into the NUL it emits.
const FIND_FORMAT = '%f\\0%y\\0%s\\0%d\\0%i\\0%T@\\0'

/**
 * One device's filesystem.
 *
 * Not a Service: it is a value the routing backend constructs per call for the
 * session that call belongs to, so nothing here is shared across sessions and
 * there is no per-device state to invalidate.
 */
export class RemoteFileSystem {
  constructor(private readonly deps: RemoteFsDeps) {}

  /** The device's absolute path for a path in this machine's namespace. */
  private remote(path: string): string {
    return toRemotePath(this.deps.mapping, path)
  }

  /** Resolve a caller path (relative to `cwd`) into a device path. */
  private remoteFrom(cwd: string | undefined, path: string): string {
    const base = cwd ?? this.deps.mapping.mount
    const local = isAbsolute(path) ? path : join(base, path)
    return this.remote(local)
  }

  /** Run one command on the device and collect its output. */
  private async run(
    command: string,
    options: { signal?: AbortSignal | undefined; stdin?: string | undefined; maxBytes?: number | undefined } = {},
  ): Promise<RemoteRun> {
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    const handle = this.deps.ctx.subprocess.spawn({
      argv: sshArgv(this.deps.device, command),
      cwd: localCwd(),
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 5_000,
      env: sshEnv(this.deps.device),
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (outcome.exitCode === null) {
      throw new FsError(`远端命令被信号中断（${String(outcome.signal ?? 'unknown')}）`, 'FS_ABORTED')
    }
    return {
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
      exitCode: outcome.exitCode,
      truncated: stdout?.lossy === true,
    }
  }

  /**
   * Run one command and collect its stdout as raw bytes.
   *
   * Text collection decodes and would corrupt binary output, so image and
   * byte-range reads go through a raw pipe instead.
   */
  private async runBinary(command: string, signal?: AbortSignal): Promise<Buffer> {
    const handle = this.deps.ctx.subprocess.spawn({
      argv: sshArgv(this.deps.device, command),
      cwd: localCwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
      env: sshEnv(this.deps.device),
      ...signal === undefined ? {} : { signal },
    })
    const chunks: Buffer[] = []
    if (handle.stdout !== undefined) {
      for await (const chunk of handle.stdout as AsyncIterable<Buffer>) chunks.push(chunk)
    }
    const outcome = await handle.done
    if (outcome.exitCode === null) {
      throw new FsError(`远端命令被信号中断（${String(outcome.signal ?? 'unknown')}）`, 'FS_ABORTED')
    }
    if (outcome.exitCode !== 0) {
      throw classifyRemoteFailure({ stdout: '', stderr: '', exitCode: outcome.exitCode, truncated: false }, command)
    }
    return Buffer.concat(chunks)
  }

  /** Run one command that must succeed, mapping its failure onto the seam's codes. */
  private async runOrThrow(
    command: string,
    displayPath: string,
    options: { signal?: AbortSignal | undefined; stdin?: string | undefined; maxBytes?: number | undefined } = {},
  ): Promise<RemoteRun> {
    const result = await this.run(command, options)
    if (result.exitCode === 0) return result
    throw classifyRemoteFailure(result, displayPath)
  }

  /** `stat` one device path, following symlinks when asked. */
  private async statRemote(remotePath: string, follow: boolean, signal?: AbortSignal): Promise<RemoteStat | undefined> {
    const flag = follow ? '-Lc' : '-c'
    const result = await this.run(`LC_ALL=C stat ${flag} ${quote(STAT_FORMAT)} -- ${quote(remotePath)}`, { signal })
    if (result.exitCode !== 0) {
      if (isMissing(result)) return undefined
      throw classifyRemoteFailure(result, remotePath)
    }
    const [kind, size, device, inode, mtime, ctime] = result.stdout.trimEnd().split('|')
    return {
      kind: kindFromStat(kind ?? ''),
      size: Number(size ?? '0'),
      version: FsVersion(`${device ?? ''}:${inode ?? ''}:${mtime ?? ''}:${ctime ?? ''}`),
    }
  }

  /** Resolve a caller path into a target identity on the device. */
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.signal?.aborted === true) throw new FsError('resolve aborted', 'FS_ABORTED')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const remote = this.remoteFrom(opts?.cwd, path)
    // `-m` canonicalizes a path that does not exist yet, the way the local
    // backend resolves a missing file through its nearest existing ancestor.
    const result = await this.runOrThrow(`realpath -m -- ${quote(remote)}`, remote, { signal: opts?.signal })
    return { targetKey: FsTargetKey(result.stdout.trim()), displayPath: remote }
  }

  /** Metadata for a resolved target; `undefined` when the device has no such file. */
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const info = await this.statRemote(String(target.targetKey), true, signal)
    if (info === undefined) return undefined
    return { version: info.version, type: info.kind === 'file' || info.kind === 'directory' ? info.kind : 'other', size: info.size }
  }

  /** Metadata for a path without following a final symlink. */
  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const remote = this.remoteFrom(opts?.cwd, path)
    const info = await this.statRemote(remote, false, signal)
    if (info === undefined) return undefined
    return { version: info.version, type: info.kind, size: info.size }
  }

  /** Read one file as UTF-8 text. */
  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const raw = await this.readBytes(target, signal, 64 * 1024 * 1024, target.displayPath)
    return decodeText(raw, target.displayPath)
  }

  /** Stream one file's text. */
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const remote = String(target.targetKey)
    const displayPath = target.displayPath
    const deps = this.deps
    const generator = async function* stream(): AsyncIterable<string> {
      const handle = deps.ctx.subprocess.spawn({
        argv: sshArgv(deps.device, `cat -- ${quote(remote)}`),
        cwd: localCwd(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
        graceMs: 5_000,
        env: sshEnv(deps.device),
        ...signal === undefined ? {} : { signal },
      })
      if (handle.stdout === undefined) throw new FsError(`cannot read "${displayPath}"`, 'FS_IO_ERROR')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      try {
        for await (const chunk of handle.stdout as AsyncIterable<Buffer>) {
          yield decoder.decode(chunk, { stream: true })
        }
        const tail = decoder.decode()
        if (tail.length > 0) yield tail
      } catch (error) {
        if (signal?.aborted === true) throw new FsError('read aborted', 'FS_ABORTED', { cause: error })
        throw new FsError(`cannot read "${displayPath}": not valid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
      }
      const outcome = await handle.done
      if (outcome.exitCode !== 0) throw classifyRemoteFailure({ stdout: '', stderr: '', exitCode: outcome.exitCode ?? 1, truncated: false }, displayPath)
    }
    return Promise.resolve(generator())
  }

  /** Read at most `maxBytes` bytes of one file. */
  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number, displayPath = target.displayPath): Promise<Uint8Array> {
    const remote = String(target.targetKey)
    const bytes = await this.runBinary(`head -c ${String(maxBytes + 1)} -- ${quote(remote)}`, signal)
    if (bytes.byteLength > maxBytes) {
      throw new FsError(`cannot read "${displayPath}": file exceeds the ${String(maxBytes)} byte limit`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  /** Read one byte window of a file. */
  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const remote = String(target.targetKey)
    const skip = range.offset + 1
    return await this.runBinary(
      `tail -c +${String(skip)} -- ${quote(remote)} | head -c ${String(range.length)}`,
      signal,
    )
  }

  /** Direct children of a directory. */
  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const remote = String(target.targetKey)
    const result = await this.runOrThrow(
      `LC_ALL=C find -- ${quote(remote)} -mindepth 1 -maxdepth 1 -printf ${quote(FIND_FORMAT)}`,
      target.displayPath,
      { signal },
    )
    const fields = result.stdout.split('\0')
    const entries: FsDirEntry[] = []
    for (let index = 0; index + 5 < fields.length; index += 6) {
      const name = fields[index] ?? ''
      if (name === '') continue
      const kind = kindFromFind(fields[index + 1] ?? '')
      const size = Number(fields[index + 2] ?? '0')
      const device = fields[index + 3] ?? ''
      const inode = fields[index + 4] ?? ''
      const mtime = fields[index + 5] ?? ''
      const child = join(remote, name)
      entries.push({
        name,
        type: kind === 'symlink' ? 'other' : kind,
        target: { targetKey: FsTargetKey(child), displayPath: join(target.displayPath, name) },
        version: FsVersion(`${device}:${inode}:${mtime}`),
        size,
      })
    }
    return entries
  }

  /** Write one file, honouring the caller's guard. */
  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    const remote = String(target.targetKey)
    const existing = await this.statRemote(remote, true, signal)
    if (existing !== undefined && existing.kind !== 'file') {
      throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
      if (existing.version !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    const diffable = existing !== undefined
      && Buffer.byteLength(content, 'utf8') < this.deps.diffBasisMaxBytes
    const before = diffable ? await this.readText(target, signal).catch(() => null) : null
    await this.publish(remote, content, signal)
    const after = await this.statRemote(remote, true, signal)
    return {
      operation: existing === undefined ? 'create' : 'update',
      version: after?.version ?? FsVersion(`missing:${remote}`),
      before: before === null ? null : normalizeLineEndings(before),
      after: normalizeLineEndings(content),
    }
  }

  /** Apply one literal edit, honouring the caller's version guard. */
  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const remote = String(target.targetKey)
    const existing = await this.statRemote(remote, true, signal)
    if (existing === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    if (existing.kind !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && existing.version !== expected.version) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const raw = await this.readText(target, signal)
    const lineEndings = detectLineEndings(raw)
    const original = normalizeLineEndings(raw)
    const edited = applyLiteralEdit(original, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
    await this.publish(remote, restoreLineEndings(edited.content, lineEndings), signal)
    const after = await this.statRemote(remote, true, signal)
    return {
      version: after?.version ?? FsVersion(`missing:${remote}`),
      before: original,
      after: edited.content,
    }
  }

  /**
   * Replace a file's contents atomically.
   *
   * The staging file is created in the destination directory by `mktemp`, so
   * the final `mv` is a same-filesystem rename, and an existing file's mode is
   * carried over before the rename — the same two properties the local
   * backend's atomic write provides.
   */
  private async publish(remote: string, content: string, signal?: AbortSignal): Promise<void> {
    const script = [
      'd=$(dirname -- "$1")',
      'mkdir -p -- "$d"',
      't=$(mktemp --tmpdir="$d" .dshell-XXXXXX)',
      'cat > "$t"',
      'if [ -e "$1" ]; then chmod --reference="$1" "$t" 2>/dev/null || true; fi',
      'mv -f -- "$t" "$1"',
    ].join(' && ')
    const result = await this.run(`sh -c ${quote(script)} sh ${quote(remote)}`, { signal, stdin: content })
    if (result.exitCode !== 0) throw classifyRemoteFailure(result, remote)
  }

  /**
   * The directory a device-bound call runs in, given the local directory the
   * caller resolved. Used by the subprocess seam for routed searches.
   */
  remoteDir(localDir: string | undefined): string {
    return remoteDirFor(this.deps.mapping, localDir)
  }
}

/** Map a `stat -c %F` word onto the seam's type vocabulary. */
function kindFromStat(word: string): RemoteStat['kind'] {
  if (word === 'regular file' || word === 'regular empty file') return 'file'
  if (word === 'directory') return 'directory'
  if (word === 'symbolic link') return 'symlink'
  return 'other'
}

/** Map a `find -printf %y` code onto the seam's type vocabulary. */
function kindFromFind(code: string): 'file' | 'directory' | 'other' | 'symlink' {
  if (code === 'f') return 'file'
  if (code === 'd') return 'directory'
  if (code === 'l') return 'symlink'
  return 'other'
}

/** Decode UTF-8 bytes, reporting the seam's not-text code for binary content. */
function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new FsError(`cannot read "${displayPath}": not valid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

/** Whether a failed command means "no such path" rather than a real fault. */
function isMissing(result: RemoteRun): boolean {
  return /No such file or directory|cannot statx? .*No such/i.test(result.stderr)
}

/** Turn a failed remote command into the seam's error vocabulary. */
function classifyRemoteFailure(result: RemoteRun, displayPath: string): FsError {
  const message = result.stderr.trim() === '' ? `远端命令失败（退出码 ${String(result.exitCode)}）` : result.stderr.trim()
  const code = /Permission denied/i.test(message)
    ? 'FS_PERMISSION_DENIED'
    : /No such file or directory/i.test(message)
      ? 'FS_NOT_FOUND'
      : /Not a directory/i.test(message)
        ? 'FS_NOT_DIRECTORY'
        : /Is a directory/i.test(message)
          ? 'FS_NOT_REGULAR_FILE'
          : 'FS_IO_ERROR'
  return new FsError(`${displayPath}: ${message}`, code)
}

/**
 * The translation between a device's remote tree and its local mount
 * directory.
 *
 * A session that runs on a device still has a working directory on THIS
 * machine, because the harness owns that value: it creates the directory when
 * the session is created, and later reads it for instruction files, project
 * discovery and sandbox roots. Handing it a remote path is not an option —
 * those reads happen locally and would fail (or, worse, silently match an
 * unrelated local directory). So the session's directory is a local, empty
 * MOUNT directory that stands in for the device's tree, and the seams that
 * actually execute something translate it back.
 *
 * The mapping is one-way in practice but stored both ways:
 *
 *   mount + '/etc/nginx'   ->  '/etc/nginx'      on the device
 *   any other absolute path -> itself            (the model may address the
 *                                                 device's own absolute paths)
 *
 * `remoteRoot` is the session's directory on the device; `mount` is the local
 * directory standing in for it. Both travel in the session's binding, so a
 * later device rename or a change to the device's own directory cannot make an
 * existing session's mapping drift.
 */

import { isAbsolute, join, relative, sep } from 'node:path'
import { mountBase } from './paths.js'

/** One session's directory on a device, and the local directory mirroring it. */
export interface MountMapping {
  /** Local directory standing in for the device tree; an existing path. */
  readonly mount: string
  /** Directory the device's commands and file operations start in. */
  readonly remoteRoot: string
}

/**
 * The mount directory for one device tree.
 *
 * Keyed by device and remote root, so sessions on the same tree share it (and
 * therefore group under one project directory in the session log, which is the
 * honest grouping: they really are the same tree).
 *
 * @param deviceId - device the tree belongs to.
 * @param remoteRoot - directory on that device; `/` maps to a named segment
 *   because an empty path segment would collapse the mount onto the device
 *   directory itself.
 * @returns absolute local directory.
 */
export function mountFor(deviceId: string, remoteRoot: string): string {
  const trimmed = remoteRoot.trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return join(mountBase(), deviceId, trimmed === '' ? 'root' : trimmed)
}

/** Whether `child` is `parent` or lies inside it; lexical, like the sandbox's own check. */
export function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Translate a path the harness/machine sees into the path the device sees.
 *
 * A path inside the mount maps to the corresponding remote path. Any other
 * absolute path is returned unchanged: on a device-bound session the model is
 * addressing the device, so `/var/log` means the device's `/var/log`, and
 * making that work is the whole point of the session.
 *
 * @param mapping - the session's mapping.
 * @param path - absolute path in this machine's namespace.
 * @returns absolute path in the device's namespace.
 */
export function toRemotePath(mapping: MountMapping, path: string): string {
  if (!isUnder(mapping.mount, path)) return path
  const rest = relative(mapping.mount, path)
  if (rest === '') return mapping.remoteRoot
  const base = mapping.remoteRoot === '/' ? '' : mapping.remoteRoot
  return join(base === '' ? '/' : base, rest)
}

/**
 * The inverse, for showing a remote path as the local path that stands in for
 * it. Paths outside the device tree cannot be represented locally and are
 * returned unchanged.
 *
 * @param mapping - the session's mapping.
 * @param remotePath - absolute path in the device's namespace.
 * @returns path under the mount, or the input when it is outside the tree.
 */
export function toMountPath(mapping: MountMapping, remotePath: string): string {
  if (!isUnder(mapping.remoteRoot, remotePath)) return remotePath
  const rest = relative(mapping.remoteRoot, remotePath)
  return rest === '' ? mapping.mount : join(mapping.mount, rest)
}

/**
 * The directory a device-bound call runs in, given the directory the caller
 * resolved locally. Falls back to the session's remote root when the caller's
 * directory is not part of this device's tree (for example a caller that
 * resolved against the process default).
 *
 * @param mapping - the session's mapping.
 * @param localDir - absolute directory in this machine's namespace, or undefined.
 * @returns absolute directory in the device's namespace.
 */
export function remoteDirFor(mapping: MountMapping, localDir: string | undefined): string {
  if (localDir === undefined) return mapping.remoteRoot
  return toRemotePath(mapping, localDir)
}

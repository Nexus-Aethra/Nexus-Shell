/**
 * Where dshell-ssh keeps its own files under the harness home.
 *
 * Kept apart from `index.ts` so the modules that need a path (the device
 * registry, the mount mapping, the router) can share one resolution rule
 * without importing the plugin entry — which would be a cycle, since the entry
 * imports them.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The harness home these paths live under, honouring `DSH_HOME`. */
export function harnessHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Device directory: registry, secrets, askpass helper, bindings, control sockets. */
export function sshDeviceRoot(): string {
  return join(harnessHome(), 'dshell', 'ssh')
}

/**
 * The host keys this plugin has trusted, one file for all devices.
 *
 * Deliberately not the harness user's `~/.ssh/known_hosts`: a device's host key
 * is this plugin's own record, and mixing the two would make dshell's
 * first-contact decisions that user's ssh client's as well.
 */
export function sshKnownHostsPath(): string {
  return join(sshDeviceRoot(), 'known_hosts')
}

/**
 * Root of the local mount directories that stand in for remote trees.
 *
 * A device-bound session's working directory has to exist on THIS machine —
 * the harness creates it when the session is created and reads it later for
 * instructions and project discovery — so a remote path cannot be the cwd.
 * Instead each device tree is mirrored by an empty local directory here, and
 * every execution seam translates between the two.
 */
export function mountBase(): string {
  return join(harnessHome(), 'dshell', 'mnt')
}

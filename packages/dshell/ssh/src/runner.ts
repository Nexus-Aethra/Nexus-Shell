/**
 * Running one command on a device.
 *
 * Everything goes through the system `ssh` client rather than an embedded SSH
 * implementation: it already owns agent support, host-key policy, config
 * files, and jump hosts, and the harness's own process primitives then keep
 * working unchanged (the local executor spawns `ssh`; its stdin/stdout/stderr
 * plumbing, cancellation and output collection apply to the remote command
 * too, because `ssh` forwards them).
 *
 * One consequence is deliberate and documented at the call sites: killing the
 * local `ssh` is how a remote command is cancelled, so the remote side sees
 * the session close (sshd then hangs up the command's process group).
 */

import type { DeviceConnection } from './devices.js'
import type { DeviceView } from './protocol.js'

/** Options every harness-spawned `ssh` carries. */
const BASE_OPTIONS = [
  // Never prompt: a missing key must fail the command, not hang a turn.
  '-o', 'BatchMode=yes',
  // Trust on first use. The alternative — refusing unknown hosts — would make
  // a freshly added device unusable without a manual known_hosts edit.
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=10',
  // No pseudo-terminal on the piped paths: callers asked for byte streams.
  '-T',
] as const

/** Quote one word for a POSIX shell. */
export function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/** `user@host` spelling. */
function destination(target: { user: string; host: string }): string {
  return `${target.user}@${target.host}`
}

/**
 * The `ssh` argv that runs one remote command line.
 * @param device - device to connect to.
 * @param remoteCommand - shell line executed by the remote login shell.
 * @returns argv for the local `ssh` process.
 */
export function sshArgv(device: DeviceConnection, remoteCommand: string): string[] {
  return [
    'ssh',
    ...BASE_OPTIONS,
    '-p', String(device.port),
    ...device.keyFile === undefined ? [] : ['-i', device.keyFile],
    destination(device),
    '--',
    remoteCommand,
  ]
}

/**
 * The local shell line that runs a command on the device in a remote
 * directory. The caller's command is transported verbatim: it is quoted for
 * the local shell, and the remote side re-quotes it for `bash -lc`, so no
 * layer re-interprets the user's own quoting.
 * @param device - device to connect to.
 * @param command - the command as the user/tool wrote it.
 * @param remoteCwd - directory to run in; empty means the login directory.
 * @returns one shell line for the local executor.
 */
export function remoteShellLine(device: DeviceConnection, command: string, remoteCwd: string): string {
  const cd = remoteCwd.trim() === '' ? '' : `cd ${quote(remoteCwd)} && `
  const payload = `${cd}exec bash -lc ${quote(command)}`
  return sshArgv(device, payload).map(quote).join(' ')
}

/** A device's connection parameters, resolved for display. */
export function describeTarget(device: DeviceView): string {
  return `${device.user}@${device.host}:${String(device.port)}`
}

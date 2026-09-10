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
 * Password logins use OpenSSH's askpass hook, since `ssh` deliberately has no
 * password flag: an environment variable names the helper, and the helper
 * reads the password file belonging to that connection.
 *
 * One consequence is deliberate and documented at the call sites: killing the
 * local `ssh` is how a remote command is cancelled, so the remote side sees
 * the session close (sshd then hangs up the command's process group).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DeviceConnection } from './devices.js'
import { sshDeviceRoot } from './paths.js'

/**
 * Options every harness-spawned `ssh` carries, apart from authentication.
 *
 * BatchMode is deliberately NOT here: it disables prompting wholesale, which
 * includes the askpass hook, so a password device would send no password at
 * all and fail with a bare "Permission denied". Key devices add it back (they
 * have nothing to be prompted for), and password devices cap the attempts
 * instead, so a refused password fails the command rather than looping.
 */
const BASE_OPTIONS = [
  // Trust on first use. The alternative — refusing unknown hosts — would make
  // a freshly added device unusable without a manual known_hosts edit.
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ConnectTimeout=10',
  // No pseudo-terminal on the piped paths: callers asked for byte streams.
  '-T',
  // Connection reuse. One tool call is several `ssh` invocations — a file read
  // is a resolve, a stat and a cat — and each fresh connection costs a TCP
  // handshake plus authentication (about a second against a remote host,
  // against roughly ten milliseconds over a shared master). `%C` lets OpenSSH
  // derive the socket name from the destination, so no id has to be escaped
  // into a path here. Failure to create the socket is non-fatal under `auto`.
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${join(sshDeviceRoot(), 'ctl', '%C')}`,
  '-o', 'ControlPersist=120s',
] as const

/** Quote one word for a POSIX shell. */
export function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

/** `user@host` spelling. */
function destination(target: { user: string; host: string }): string {
  return `${target.user}@${target.host}`
}

/** Environment a device's connection needs, beyond the harness defaults. */
export function sshEnv(device: DeviceConnection): Record<string, string> {
  if (device.auth !== 'password' || device.secretFile === undefined) return {}
  return {
    // ssh runs $SSH_ASKPASS and reads the password from its stdout. REQURE
    // forces the hook even where a tty could be probed for one.
    SSH_ASKPASS: device.askpassFile,
    SSH_ASKPASS_REQUIRE: 'force',
    // Some builds still require a DISPLAY before consulting askpass.
    DISPLAY: 'dshell:0',
    DSHELL_SSH_PASSWORD_FILE: device.secretFile,
  }
}

/** Authentication arguments for one device. */
function authArgs(device: DeviceConnection): string[] {
  if (device.auth === 'password') {
    return [
      // One attempt: the secret comes from askpass, so a second prompt would
      // only replay the same rejected password and turn a refusal into a wait.
      '-o', 'NumberOfPasswordPrompts=1',
      // Without this, a reachable key or agent would silently be preferred and
      // the device would connect as someone else.
      '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
    ]
  }
  return [
    // Nothing to prompt for on a key device: fail instead of waiting.
    '-o', 'BatchMode=yes',
    ...device.secretFile === undefined ? [] : ['-i', device.secretFile],
  ]
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
    ...authArgs(device),
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
 *
 * @param device - device to connect to.
 * @param command - the command as the user/tool wrote it.
 * @param remoteCwd - directory to run in; empty means the login directory.
 * @returns one shell line for the local executor.
 */
export function remoteShellLine(device: DeviceConnection, command: string, remoteCwd: string): string {
  const cd = remoteCwd.trim() === '' ? '' : `cd ${quote(remoteCwd)} && `
  const payload = `${cd}exec bash -lc ${quote(command)}`
  // An assignment word carries its value quoted exactly once. Quoting the
  // whole `NAME='value'` word again would turn those quotes into literal
  // characters, and bash would read the assignment as a command name.
  const env = Object.entries(sshEnv(device)).map(([name, value]) => `${name}=${quote(value)}`)
  return [...env, ...sshArgv(device, payload).map(quote)].join(' ')
}

/** A device's connection parameters, resolved for display. */
export function deviceLabel(device: DeviceConnection): string {
  return `${device.name} · ${device.user}@${device.host}:${String(device.port)}`
}

/** Default working directory for locally-spawned `ssh` processes. */
export function localCwd(): string {
  return homedir()
}

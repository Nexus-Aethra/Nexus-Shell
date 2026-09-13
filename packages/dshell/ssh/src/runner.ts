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

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DeviceConnection } from './devices.js'
import { sshDeviceRoot } from './paths.js'

/**
 * The control socket path for one device.
 *
 * `%C` is OpenSSH's own hash of the local host, the remote host and port and
 * the remote user — it says nothing about which device record or which
 * credential is in play, so two devices reaching the same account would share
 * one master connection, and whichever authenticated first would serve the
 * other. The device id is appended as a short digest: that separates them, and
 * keeps the path well inside the ~108 byte limit a unix socket path has (the
 * id itself may be up to 64 characters, so it cannot be appended verbatim).
 *
 * @param device - device the connection belongs to.
 * @returns the `ControlPath` value for that device.
 */
function controlPath(device: DeviceConnection): string {
  const tag = createHash('sha256').update(device.id).digest('hex').slice(0, 12)
  return join(sshDeviceRoot(), 'ctl', `%C-${tag}`)
}

/**
 * Options every harness-spawned `ssh` carries, apart from authentication.
 *
 * BatchMode is deliberately NOT here: it disables prompting wholesale, which
 * includes the askpass hook, so a password device would send no password at
 * all and fail with a bare "Permission denied". Key devices add it back (they
 * have nothing to be prompted for), and password devices cap the attempts
 * instead, so a refused password fails the command rather than looping.
 *
 * @param device - device the connection belongs to.
 * @returns the `-o` option words, in order.
 */
function baseOptions(device: DeviceConnection): string[] {
  return [
    // Trust on first use. The alternative — refusing unknown hosts — would make
    // a freshly added device unusable without a manual known_hosts edit.
    '-o', 'StrictHostKeyChecking=accept-new',
    // A device's host key is this plugin's own record of trust, not the harness
    // user's. Without this, `accept-new` writes it into their personal
    // ~/.ssh/known_hosts, which makes dshell's first-contact decision their own
    // ssh client's too — and they never saw the fingerprint it trusted.
    '-o', `UserKnownHostsFile=${join(sshDeviceRoot(), 'known_hosts')}`,
    '-o', 'ConnectTimeout=10',
    // Connection reuse. One tool call is several `ssh` invocations — a file read
    // is a resolve, a stat and a cat — and each fresh connection costs a TCP
    // handshake plus authentication (about a second against a remote host,
    // against roughly ten milliseconds over a shared master). Failure to create
    // the socket is non-fatal under `auto`.
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath(device)}`,
    '-o', 'ControlPersist=120s',
    // Keepalives bound a master whose peer has gone away. Without them a
    // connection that dies half-open leaves a live control socket in front of a
    // dead sshd, and every later command and terminal hangs behind it with no
    // error — the shell simply never starts. Probing means the master notices and
    // exits, and the next invocation dials a fresh connection.
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ]
}

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
    ...device.secretFile === undefined ? [] : [
      // With a stored key, use ONLY it. Without this the harness user's ssh
      // agent is still consulted — `ssh -vv` shows the agent's identity being
      // offered *before* the explicit one — so a host that also authorises a
      // personal key authenticates as that identity, and a device whose key was
      // rotated or revoked keeps looking like it works.
      '-o', 'IdentitiesOnly=yes',
      '-i', device.secretFile,
    ],
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
    ...baseOptions(device),
    // No pseudo-terminal on the piped paths: callers asked for byte streams.
    '-T',
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

/**
 * The `ssh` argv that puts an interactive login shell on the device.
 *
 * Distinct from {@link sshArgv} in exactly one way that matters: it asks for a
 * remote pseudo-terminal (`-t`), because this backs the user's own visible
 * terminal — resize, Ctrl+C, job control and full-screen programs all have to
 * work there. Nothing about the *local* pty changes: the harness spawns `ssh`
 * inside it, so the line discipline stays local and the remote shell gets a
 * tty of its own.
 *
 * `bash -l` (not `--norc`) on purpose: the user's real login shell is what
 * they expect to land in. The bridge overwrites PS1 and PROMPT_COMMAND right
 * after startup for its own settle marker, so the prompt looks the same on
 * every device regardless of the remote profile.
 *
 * @param device - device to connect to.
 * @param remoteCwd - directory the shell starts in; empty means the login dir.
 * @returns argv for the local `ssh` process.
 */
export function interactiveShellArgv(device: DeviceConnection, remoteCwd: string): string[] {
  // A missing directory must not cost the user their terminal. Chaining with
  // `&&` would short-circuit `exec bash` and end the session on a typo, with
  // nothing on screen to explain it; the shell lands in the login directory
  // instead and says why.
  const root = remoteCwd.trim()
  const cd = root === ''
    ? ''
    : `cd ${quote(root)} 2>/dev/null || echo ${quote(`dshell: 远端目录 ${root} 不存在，已回到登录目录`)} >&2; `
  return [
    'ssh',
    ...baseOptions(device),
    // Force a remote tty: this is the one path that needs one.
    '-t',
    '-p', String(device.port),
    ...authArgs(device),
    destination(device),
    '--',
    `${cd}exec bash -l`,
  ]
}

/** A device's connection parameters, resolved for display. */
export function deviceLabel(device: DeviceConnection): string {
  return `${device.name} · ${device.user}@${device.host}:${String(device.port)}`
}

/** Default working directory for locally-spawned `ssh` processes. */
export function localCwd(): string {
  return homedir()
}

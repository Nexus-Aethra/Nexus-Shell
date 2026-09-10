/**
 * Redirect a bound session's ripgrep runs to its device.
 *
 * `glob` and `grep` do not go through `ctx.fs`: the search tool spawns the
 * packaged ripgrep binary directly, with the session's cwd as the process
 * working directory (`dsh-tool-fs-search`'s `runRipgrep`). So the seam that
 * moves them is `ctx.subprocess.spawn`, wrapped on the prototype that owns it —
 * the same technique the shell seam uses, and for the same reason: a method on
 * the prototype is reached identically through `ctx.subprocess` and
 * `ctx.get('subprocess')`.
 *
 * Only one shape is touched: a session bound to a device, spawning something
 * whose program is named `rg`. Anything else — the shell's own `bash`, an LSP
 * server, a subagent — passes through untouched, and so does every unbound
 * session. The shell path is deliberately NOT re-routed here: it has already
 * been rewritten into an `ssh` line by `installShellRouting`, and rewriting it
 * twice would nest one ssh inside another.
 *
 * Paths in the results need no translation. The command runs `cd <remote dir>`
 * and ripgrep prints paths relative to that directory, which the search tool
 * passes through unchanged — and a relative path means the same place to this
 * session's file operations, because they resolve against the same mount.
 * An absolute path the model supplied is already a device path.
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { remoteDirFor } from './mount.js'
import { localCwd, quote, sshArgv, sshEnv } from './runner.js'
import type { SshRouter } from './router.js'

/** The one method this module replaces, typed structurally. */
interface SubprocessShape {
  spawn(this: unknown, spec: SubprocessSpawnSpec): SubprocessHandle
}

/**
 * The device's ripgrep, with a failure the model can act on.
 *
 * The binary that runs locally is the one bundled with the search tool; on a
 * device the only sensible equivalent is the platform's `rg`. Missing it is a
 * setup fact, not a search error, so say which one it is instead of letting
 * the shell report a bare "not found".
 */
const REQUIRE_RG = 'command -v rg >/dev/null 2>&1'
  + ' || { echo "dshell-ssh: the device has no rg (ripgrep) on PATH; glob and grep run there" >&2; exit 127; }'

/**
 * Install the subprocess seam.
 * @param ctx - host context holding the subprocess service.
 * @param router - device assignments.
 * @returns disposer restoring the original method.
 */
export function installSpawnRouting(ctx: Context, router: SshRouter): () => void {
  const subprocess: SubprocessRuntime | undefined = ctx.get('subprocess')
  if (subprocess === undefined) return () => {}
  let owner = Object.getPrototypeOf(subprocess) as Record<string, unknown> | null
  while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'spawn')) {
    owner = Object.getPrototypeOf(owner) as Record<string, unknown> | null
  }
  if (owner === null) return () => {}
  const target = owner as unknown as SubprocessShape
  const original = target.spawn
  target.spawn = function spawn(this: unknown, spec: SubprocessSpawnSpec): SubprocessHandle {
    const agent = ctx.agents.currentInitiator()
    const assignment = agent === undefined ? undefined : router.targetForSession(String(agent.id))
    if (assignment === undefined || assignment.mount === undefined) return original.call(this, spec)
    if (basename(spec.argv[0] ?? '') !== 'rg') return original.call(this, spec)
    const remoteDir = remoteDirFor(
      { mount: assignment.mount, remoteRoot: assignment.remoteRoot },
      spec.cwd,
    )
    // The local program path is dropped, not translated: the device resolves
    // `rg` itself, and the remaining arguments are the search tool's own
    // (already an argv, never a shell line), quoted exactly once for the
    // remote shell.
    const args = spec.argv.slice(1).map(quote).join(' ')
    const command = `cd ${quote(remoteDir)} && ${REQUIRE_RG} && exec rg ${args}`
    return original.call(this, {
      ...spec,
      argv: sshArgv(assignment.device, command),
      cwd: localCwd(),
      env: { ...spec.env, ...sshEnv(assignment.device) },
    })
  }
  return () => { target.spawn = original }
}

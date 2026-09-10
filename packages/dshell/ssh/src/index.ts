/**
 * dshell-ssh host face.
 *
 * A session can be assigned to a device; every shell command that session's
 * agent then runs executes on that device instead of this machine. The three
 * pieces are the device registry (name, host, port, user, remote directory and
 * private key), the durable session assignment, and the seam that acts on it
 * (`ctx.shell.resolve`, see router.ts).
 *
 * Scope, stated where it is decided: this routes the harness's *shell*
 * commands. Tools that reach the filesystem directly (read/write/edit) and the
 * ripgrep-backed search tools (glob/grep) still act locally, and so does the
 * visible dshell terminal; each needs its own seam (`ctx.fs`, `ctx.subprocess`,
 * the PTY backend) and is not claimed here.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the host agent service merge (ctx.agents.currentInitiator).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the host connection merge (ctx.connection.fetch).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the settings service merge (optional ctx.settings).
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: pulls the shell and subprocess service merges.
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-subprocess'
import DshellFsPlugin from './fs-routing.js'
import { sshDeviceRoot } from './paths.js'
import { createSshRoute } from './route.js'
import { installShellRouting, SSH_ROUTING_SERVICE, SshRouter } from './router.js'
import { installSpawnRouting } from './spawn-routing.js'
import { SSH_SETTINGS_NAMESPACE, SshSettingsSchema } from './ssh-settings.js'

export const name = '@deepseek-ai/dsh-dshell-ssh'

export { DSHELL_SSH_PATH, type DeviceView, type SshResponse } from './protocol.js'
export { harnessHome, mountBase, sshDeviceRoot } from './paths.js'
export { mountFor, toMountPath, toRemotePath, type MountMapping } from './mount.js'
export type { SshSettings } from './ssh-settings.js'

export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SSH_SETTINGS_NAMESPACE, SshSettingsSchema)
  })
  const router = new SshRouter(sshDeviceRoot())
  // Published so the filesystem provider — loaded as its own plugin, in place
  // of the stock backend — can resolve a call's session without this module
  // handing it anything directly.
  ctx.provide(SSH_ROUTING_SERVICE, router)
  // `ctx.fs` for device-bound sessions. The composition disables the stock
  // `fs-sandbox` row, because a service name has exactly one provider.
  ctx.plugin(DshellFsPlugin)
  // Routing waits for both services: the shell executor is what gets wrapped,
  // and the agent registry is how the wrapped call learns whose session it is.
  ctx.inject(['shell', 'agents'], (routingCtx) => {
    routingCtx.effect(
      () => installShellRouting(routingCtx, router),
      'dshell-ssh: shell routing',
    )
  })
  // `glob`/`grep` spawn ripgrep directly rather than going through `ctx.fs`,
  // so their routing lives on the subprocess seam.
  ctx.inject(['agents', 'subprocess'], (spawnCtx) => {
    spawnCtx.effect(
      () => installSpawnRouting(spawnCtx, router),
      'dshell-ssh: search routing',
    )
  })
  // The connection test spawns `ssh` through the harness's own process
  // primitive, so that context needs the subprocess service injected.
  ctx.inject(['connection', 'subprocess'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register(createSshRoute({ router, ctx: connectionCtx })),
      'dshell-ssh: device route',
    )
  })
}

export default { name, apply }

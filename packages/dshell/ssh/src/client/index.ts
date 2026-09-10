/**
 * dshell-ssh browser face: the device card in the Plugins settings section and
 * the `dshellSsh` service the session picker reads.
 *
 * The card is keyed by the settings namespace this plugin registers on the
 * Host, which is what makes the Plugins section dispatch it.
 */

import { type Context } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the plugin-card SlotMap (`settings.plugin.item`).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SSH_SETTINGS_NAMESPACE } from '../protocol.js'
import { DshellSshCard } from './card.js'
import { SshClientService } from './service.js'

export const name = '@deepseek-ai/dsh-dshell-ssh/client'

export const inject = ['slots'] as const

export type { DeviceView, DeviceInput, DeviceBinding } from '../protocol.js'
export type { SshSnapshot, SshClientService } from './service.js'

export function apply(ctx: Context): void {
  const ssh = new SshClientService(ctx)
  void ssh.load()
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: SSH_SETTINGS_NAMESPACE },
    () => DshellSshCard({ ssh }),
  ))
}

export default { name, inject, apply }

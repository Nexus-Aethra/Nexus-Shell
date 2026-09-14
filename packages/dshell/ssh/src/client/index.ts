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
// Type-only: pulls the locale service (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the plugin-card SlotMap (`settings.plugin.item`).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SSH_SETTINGS_NAMESPACE } from '../protocol.js'
import { DshellSshCard } from './card.js'
import { en, zh } from './locales.js'
import { SshClientService } from './service.js'

export const name = '@nexus-aethra/dshell-ssh/client'

export const inject = ['slots', 'locale'] as const

/** This package's copy namespace. */
const NS = 'dshellSsh'

export type { DeviceView, DeviceInput, DeviceBinding } from '../protocol.js'
export type { SshSnapshot, SshClientService } from './service.js'
export type { DshellSshKey } from './locales.js'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-ssh: dictionaries')
  const ssh = new SshClientService(ctx)
  void ssh.load()
  // The card itself is the registered component: its `t` seat comes from the
  // declared namespace, and the device service travels as the inject face, so
  // both reach it as composed props (the same shape the shipped cards use).
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: SSH_SETTINGS_NAMESPACE, locale: NS, inject: () => ({ ssh }) },
    DshellSshCard,
  ))
}

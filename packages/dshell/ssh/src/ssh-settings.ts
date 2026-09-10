/**
 * The dshell-ssh settings namespace.
 *
 * Device records and keys stay in this plugin's own directory (a settings
 * document is the wrong home for secrets), but the *preference* — which device
 * a new session offers first — is ordinary plugin configuration, and
 * registering the namespace is also what makes the Plugins settings section
 * dispatch this plugin's device card.
 */

import z from '@deepseek-ai/schemastery'
import { SSH_SETTINGS_NAMESPACE } from './protocol.js'

export { SSH_SETTINGS_NAMESPACE }

/** Field carrying the device preselected for new sessions. */
export const DEFAULT_DEVICE_FIELD = 'defaultDevice'

/** The durable section. */
export interface SshSettings {
  /** Device id preselected in the new-session picker; empty means local. */
  defaultDevice: string
}

/** Default when the settings document carries no override. */
export const DEFAULT_SSH_SETTINGS: SshSettings = { defaultDevice: '' }

/** Schema resolving the namespace, on the Host and on the wire. */
export const SshSettingsSchema = z.object({
  [DEFAULT_DEVICE_FIELD]: z.string().default(''),
}) as unknown as z<SshSettings>

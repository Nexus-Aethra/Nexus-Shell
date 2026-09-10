/**
 * The Host-side schema for dshell's settings section.
 *
 * Split from `theme-settings.ts` because schema construction must not reach the
 * browser bundle: the client build resolves only the platform module table, and
 * pulling schemastery in through a shared import breaks the whole client
 * plugin load with a missing-module error.
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_THEME_ID, DSHELL_SETTINGS_NAMESPACE, THEME_FIELD, THEME_IDS } from './theme-settings.js'

export { DSHELL_SETTINGS_NAMESPACE, THEME_FIELD }

/** Schema resolving the namespace, on the Host and on the wire. */
export const DshellSettingsSchema: z<Record<string, unknown>> = z.object({
  [THEME_FIELD]: z.union([...THEME_IDS]).default(DEFAULT_THEME_ID),
})

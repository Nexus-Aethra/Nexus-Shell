/**
 * The Host-side schema for dshell's settings section.
 *
 * Split from `settings.ts` because schema construction must not reach the
 * browser bundle: the client build resolves only the platform module table, and
 * pulling schemastery in through a shared import breaks the whole client
 * plugin load with a missing-module error.
 */

import z from '@deepseek-ai/schemastery'
import {
  COMMAND_HINT_FIELD, DEFAULT_THEME_ID, DSHELL_SETTINGS_NAMESPACE, HISTORY_LIST_FIELD,
  SHELL_HELPER_DEFAULT, TAB_COMPLETION_FIELD, THEME_FIELD, THEME_IDS,
} from './settings.js'

export { DSHELL_SETTINGS_NAMESPACE, THEME_FIELD }

/**
 * Schema resolving the namespace, on the Host and on the wire.
 *
 * Each helper switch is a plain boolean with the shared default, so an empty or
 * older document resolves to the assists being ON — the composer those settings
 * govern is built around them.
 */
export const DshellSettingsSchema: z<Record<string, unknown>> = z.object({
  [THEME_FIELD]: z.union([...THEME_IDS]).default(DEFAULT_THEME_ID),
  [TAB_COMPLETION_FIELD]: z.boolean().default(SHELL_HELPER_DEFAULT),
  [HISTORY_LIST_FIELD]: z.boolean().default(SHELL_HELPER_DEFAULT),
  [COMMAND_HINT_FIELD]: z.boolean().default(SHELL_HELPER_DEFAULT),
})

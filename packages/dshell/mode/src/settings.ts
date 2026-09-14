/**
 * The durable dshell section in the user-settings document.
 *
 * Everything dshell configures lives here, because a settings namespace is one
 * document and the Plugins section dispatches ONE card per namespace: the
 * terminal palette the composer draws with, and the switches for the shell
 * helpers that read the composer's line (Tab completion, the ↑ history list,
 * the ghost command hint).
 *
 * What travels is only the vocabulary: the palette id, and three booleans.
 * Nothing here is a fact the Host acts on — the colours stay in the browser
 * (`client/theme.ts`) and each switch gates a gesture in the key interceptor —
 * so the Host stores them and the browser half reads them.
 *
 * Only the vocabulary lives here, with no schema import: the browser half
 * merges it into the client bundle (which has no module table entry for
 * schemastery), while the Host half adds the schema from `settings-schema.ts`.
 * Sharing this file is why it sits beside `index.ts` rather than under
 * `client/`.
 */

/** Settings namespace owned by dshell. */
export const DSHELL_SETTINGS_NAMESPACE = 'dshell'

/** Field carrying the selected terminal palette. */
export const THEME_FIELD = 'theme'

/** Field enabling Tab path completion in the composer. */
export const TAB_COMPLETION_FIELD = 'tabCompletion'

/** Field enabling the ↑ history list. */
export const HISTORY_LIST_FIELD = 'historyList'

/** Field enabling the ghost command hint. */
export const COMMAND_HINT_FIELD = 'commandHint'

/**
 * Palette ids, in the order the picker shows them. The colours for each id
 * live in `client/theme.ts`; only the vocabulary is shared, so the Host schema
 * and the browser registry cannot drift apart.
 */
export const THEME_IDS = ['midnight', 'solarized', 'dracula', 'forest'] as const

/** One selectable terminal palette id. */
export type DshellThemeId = typeof THEME_IDS[number]

/** Palette used when the settings document carries no override. */
export const DEFAULT_THEME_ID: DshellThemeId = 'midnight'

/**
 * Whether a shell helper is available when the document carries no override.
 *
 * On, because these are assists the composer was built around: a shell-mode
 * line with Tab, ↑ and the hint all live is the surface the rest of dshell
 * assumes. Turning one off is a deliberate act, so the default never has to be
 * the quiet one.
 */
export const SHELL_HELPER_DEFAULT = true

/** The three shell-helper switches, as the settings document names them. */
export type DshellShellHelper = 'tabCompletion' | 'historyList' | 'commandHint'

/** The shell-helper switches, in the order the settings card shows them. */
export const SHELL_HELPER_FIELDS: readonly DshellShellHelper[] = [
  'tabCompletion', 'historyList', 'commandHint',
]

/** The durable dshell section. */
export interface DshellSettings {
  /** Selected terminal palette. */
  theme: DshellThemeId
  /** Whether Tab completes a path in the composer. */
  tabCompletion: boolean
  /** Whether ↑ opens the command history. */
  historyList: boolean
  /** Whether a recent command is ghosted after the caret. */
  commandHint: boolean
}

/**
 * Narrow a value crossing the settings, registry, or storage boundary.
 * @param value - candidate palette id.
 * @returns whether the value names a known palette.
 */
export function isThemeId(value: unknown): value is DshellThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

/**
 * Read one helper switch from a settings value of unknown shape.
 *
 * The document is user data: a hand-edited file, an older version, or another
 * browser's write can carry anything. A value that is not a boolean therefore
 * falls back to the default rather than to "off" — a switch is only off when
 * the document says so.
 *
 * @param value - the bound settings value, possibly partial or absent.
 * @param field - which switch to read.
 * @returns the stored switch, or the default.
 */
export function readShellHelper(value: unknown, field: DshellShellHelper): boolean {
  if (value === null || typeof value !== 'object') return SHELL_HELPER_DEFAULT
  const stored = (value as Record<string, unknown>)[field]
  return typeof stored === 'boolean' ? stored : SHELL_HELPER_DEFAULT
}

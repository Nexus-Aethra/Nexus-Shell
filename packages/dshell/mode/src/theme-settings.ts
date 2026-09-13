/**
 * The durable dshell section in the user-settings document.
 *
 * The terminal palette is a plugin setting, so it lives where every other
 * plugin's settings live: a namespace registered by this package's Host half
 * and edited through the card the browser half contributes to the Plugins
 * settings section. Only the palette *id* travels — the colours stay in the
 * browser (`client/theme.ts`), because a palette is a rendering choice, not a
 * fact the Host can act on.
 *
 * Only the vocabulary lives here, with no schema import: the browser half
 * merges it into the client bundle (which has no module table entry for
 * schemastery), while the Host half adds the schema from
 * `theme-settings-schema.ts`. Sharing this file is why it sits beside
 * `index.ts` rather than under `client/`.
 */

/** Settings namespace owned by dshell. */
export const DSHELL_SETTINGS_NAMESPACE = 'dshell'

/** Field carrying the selected terminal palette. */
export const THEME_FIELD = 'theme'

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

/** The durable dshell section. */
export interface DshellSettings {
  /** Selected terminal palette. */
  theme: DshellThemeId
}

/**
 * Narrow a value crossing the settings, registry, or storage boundary.
 * @param value - candidate palette id.
 * @returns whether the value names a known palette.
 */
export function isThemeId(value: unknown): value is DshellThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

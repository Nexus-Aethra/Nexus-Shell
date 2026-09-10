/**
 * Dshell palettes and the xterm mapping.
 *
 * The registry is a module-level snapshot store so a palette switch re-renders
 * every seat (chips, canvas, settings row) without prop drilling.
 */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ITheme } from '@xterm/xterm'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import { XTERM_CSS } from './xterm-css.js'

export interface Theme {
  readonly id: string
  readonly label: string
  readonly bg: string
  readonly text: string
  readonly muted: string
  readonly border: string
  readonly borderStrong: string
  readonly inputBar: string
  readonly accent: string
  readonly accentText: string
  readonly accentBorder: string
  readonly accentFaint: string
  readonly menuBg: string
  readonly menuBorder: string
  /** Bash PS1 ANSI SGR for the user@host segment. */
  readonly ps1User: string
  /** Bash PS1 ANSI SGR for the path segment. */
  readonly ps1Path: string
}

export const THEMES: readonly Theme[] = [
  {
    id: 'midnight',
    label: '午夜',
    bg: 'transparent',
    text: '#e8e8ec',
    muted: '#9d9da6',
    border: '#1c1d22',
    borderStrong: '#2c2c33',
    inputBar: 'rgba(8, 8, 11, 0.6)',
    accent: '#7c3aed',
    accentText: '#cbb5ff',
    accentBorder: '#4c2a8a',
    accentFaint: 'rgba(124, 58, 237, 0.12)',
    menuBg: '#131418',
    menuBorder: '#2a2b31',
    ps1User: '1;32',
    ps1Path: '1;34',
  },
  {
    id: 'solarized',
    label: '柔和',
    bg: 'transparent',
    text: '#93a1a1',
    muted: '#657b83',
    border: '#0f3a44',
    borderStrong: '#268bd2',
    inputBar: 'rgba(7, 38, 43, 0.55)',
    accent: '#b58900',
    accentText: '#fdf6e3',
    accentBorder: '#8a6a00',
    accentFaint: 'rgba(181, 137, 0, 0.14)',
    menuBg: '#002b36',
    menuBorder: '#0f3a44',
    ps1User: '1;33',
    ps1Path: '1;32',
  },
  {
    id: 'dracula',
    label: '神秘',
    bg: 'transparent',
    text: '#f8f8f2',
    muted: '#6272a4',
    border: '#44475a',
    borderStrong: '#6272a4',
    inputBar: 'rgba(40, 42, 54, 0.6)',
    accent: '#ff79c6',
    accentText: '#ffb3da',
    accentBorder: '#bd4188',
    accentFaint: 'rgba(255, 121, 198, 0.14)',
    menuBg: '#282a36',
    menuBorder: '#44475a',
    ps1User: '1;35',
    ps1Path: '1;36',
  },
  {
    id: 'forest',
    label: '森林',
    bg: 'transparent',
    text: '#d0d7c5',
    muted: '#8a9a76',
    border: '#1f2e1c',
    borderStrong: '#4a6b3a',
    inputBar: 'rgba(15, 25, 18, 0.6)',
    accent: '#7fb069',
    accentText: '#bce09a',
    accentBorder: '#4a6b3a',
    accentFaint: 'rgba(127, 176, 105, 0.14)',
    menuBg: '#141c14',
    menuBorder: '#2a3a26',
    ps1User: '1;32',
    ps1Path: '1;33',
  },
]

export const DEFAULT_THEME_ID = 'midnight'

export function getTheme(id: string): Theme {
  return THEMES.find(t => t.id === id) ?? THEMES[0]!
}

export const THEME_STORAGE_KEY = 'dshell.theme'

/** Module-level theme store; single subscription feeds every dock instance. */
export const themeStore = createSnapshotStore<string>(
  (() => {
    if (typeof localStorage === 'undefined') return DEFAULT_THEME_ID
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      return getTheme(stored ?? DEFAULT_THEME_ID).id
    } catch {
      return DEFAULT_THEME_ID
    }
  })(),
)

export function setTheme(id: string): void {
  const theme = getTheme(id)
  themeStore.set(theme.id)
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme.id) } catch { /* ignore */ }
  }
}

/** React binding for the module-level theme store. */
export function useDshellTheme(): Theme {
  const id = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  return getTheme(id)
}

export let xtermCssInjected = false

/** The combo loader serves one client.js per plugin — inject the stylesheet at runtime. */
export function injectXtermCss(): void {
  if (xtermCssInjected) return
  xtermCssInjected = true
  const style = document.createElement('style')
  // xterm's own CSS leaves the viewport opaque in some renderers; force the
  // whole terminal tree transparent so the canvas blends with the app
  // surface instead of painting a black card.
  style.textContent = `${XTERM_CSS}\n.xterm,.xterm-viewport,.xterm-screen,.xterm-scrollable-element{background-color:transparent !important;}`
  document.head.append(style)
}

/** Map a dock theme palette onto the xterm renderer. The background stays
 * fully transparent so the terminal blends with the app surface instead of
 * painting its own black card (the palette's `bg` is `transparent` too). */
/**
 * The one live canvas terminal. The composer's key router needs it to copy the
 * terminal selection (Ctrl+Shift+C) while the keyboard sits in the input line
 * rather than the canvas.
 */
export const activeTerm: { current: XtermTerminal | null } = { current: null }

export function xtermTheme(theme: Theme): ITheme {
  return {
    background: '#00000000',
    foreground: theme.text,
    cursor: theme.accent,
    cursorAccent: '#00000000',
    // Reverse-video selection, keyed to the active palette: the highlight is
    // the theme's own accent and the glyphs invert to its dark surface
    // (`menuBg`), so a selection reads as part of the current theme rather
    // than a fixed system blue. Both pairs are set — focus usually sits in
    // the composer while the user drags across the canvas, and xterm would
    // otherwise paint its near-invisible inactive colour.
    selectionBackground: theme.accent,
    selectionInactiveBackground: theme.accent,
    selectionForeground: theme.menuBg,
  }
}

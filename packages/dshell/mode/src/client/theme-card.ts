/**
 * The dshell plugin card in the Plugins settings section: the terminal
 * palette picker.
 *
 * This is a card without a form. A palette applies the moment it is picked —
 * that is what the user is judging — so there is no staged edit and no save
 * button; the write goes to the Host settings document immediately (see
 * `theme.ts`), and every other seat follows the store.
 *
 * The card is keyed by the settings namespace it edits (`dshell`), which is
 * how the Plugins section pairs it with the namespace the Host serves. It
 * draws its own chrome rather than importing dsh's `PluginCard`, because a
 * client plugin reaches another client plugin through slots and services, not
 * through value imports.
 */

import { createElement, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { THEMES, setTheme, themeStore } from './theme.js'

const cardStyle: CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)',
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const headStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const descStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  opacity: 0.7,
}

/**
 * Render the terminal-palette card.
 * @returns the card element.
 */
export function DshellThemeCard(): ReactElement {
  const current = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  return createElement('li', { style: cardStyle, 'data-dshell-card': 'theme' },
    createElement('div', { style: headStyle },
      createElement('div', {
        style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
      }, '终端配色'),
      createElement('div', { style: descStyle },
        '主终端（画布、块视图与命令行）使用的调色板；选择立即生效并保存到主机设置。'),
    ),
    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      THEMES.map(theme => createElement('button', {
        key: theme.id,
        type: 'button',
        'aria-pressed': current === theme.id,
        onClick: () => { setTheme(theme.id) },
        style: {
          flex: '1 1 140px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: '14px 16px',
          borderRadius: 16,
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 13,
          color: 'var(--dsw-alias-label-primary)',
          border: current === theme.id
            ? '1px solid var(--dsw-alias-brand-primary)'
            : '0.5px solid var(--dsw-alias-border-l4)',
          background: current === theme.id ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
        },
      },
        createElement('span', {
          style: {
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: 999,
            background: theme.accent,
            border: `1px solid ${theme.borderStrong}`,
          },
        }),
        theme.label,
      )),
    ),
  )
}

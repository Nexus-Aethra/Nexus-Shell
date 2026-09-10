/**
 * The dshell plugin card in the Plugins settings section: the terminal
 * palette picker.
 *
 * It follows the section's card shape — a header button naming the plugin over
 * the line that says what its settings govern, collapsed until opened — so it
 * reads as one of the cards rather than a permanently open panel. The chevron
 * is the same `›`-rotated control dshell uses for its other fold affordances.
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

import { createElement, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react'
import { THEMES, setTheme, themeStore } from './theme.js'

const cardStyle: CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 16,
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

/** An open card reads as the one being worked on, not merely taller. */
const openCardStyle: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}

const headerStyle: CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 12,
}

/** Name over description: the description is what tells two cards apart. */
const headTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const descStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
  opacity: 0.7,
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  padding: '0 16px 16px',
}

/**
 * Disclosure chevron, drawn rather than imported: it must read as the same
 * control as the cards this one sits among (down when collapsed, rotated when
 * open), and a client plugin cannot import dsh's icon set.
 */
function Chevron({ open }: { open: boolean }): ReactElement {
  return createElement('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    style: {
      flex: '0 0 auto',
      opacity: 0.7,
      transition: 'transform .16s ease',
      transform: open ? 'rotate(180deg)' : 'none',
    } as CSSProperties,
  },
    createElement('path', {
      d: 'M4 6.5 L8 10.5 L12 6.5',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

/**
 * Render the terminal-palette card.
 * @returns the card element.
 */
export function DshellThemeCard(): ReactElement {
  const [open, setOpen] = useState(false)
  const current = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  return createElement('li', {
    style: open ? { ...cardStyle, ...openCardStyle } : cardStyle,
    'data-dshell-card': 'theme',
  },
    createElement('button', {
      type: 'button',
      style: headerStyle,
      'aria-expanded': open,
      onClick: () => { setOpen(value => !value) },
    },
      createElement('span', { style: headTextStyle },
        createElement('span', {
          style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
        }, '终端配色'),
        createElement('span', { style: descStyle },
          `主终端（画布、块视图与命令行）的调色板 · 当前：${THEMES.find(t => t.id === current)?.label ?? current}`),
      ),
      createElement(Chevron, { open }),
    ),
    open
      ? createElement('div', { style: bodyStyle },
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
        createElement('div', {
          style: { flexBasis: '100%', fontSize: 12, opacity: 0.6, marginTop: 2 },
        }, '选择立即生效，并保存到主机设置（同一主机所有浏览器共用）。'),
      )
      : null,
  )
}

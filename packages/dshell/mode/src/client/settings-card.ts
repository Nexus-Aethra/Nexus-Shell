/**
 * The dshell card in the Plugins settings section: the terminal palette, and
 * the switches for the shell helpers that read the composer's line.
 *
 * One card per settings namespace — the section dispatches the card for the
 * namespace the Host registered — so both groups live here rather than in a
 * second card that could never be reached.
 *
 * It follows the section's card shape — a header button naming what the card
 * governs over a line that says what its settings are set to, collapsed until
 * opened — so it reads as one of the cards rather than a permanently open
 * panel. The chevron is the same `›`-rotated control dshell uses for its other
 * fold affordances.
 *
 * This is a card without a form. A palette applies the moment it is picked and
 * a switch takes effect on its click — that is what the user is judging — so
 * there is no staged edit and no save button; each write goes to the Host
 * settings document immediately (see `theme.ts` and `shell-settings.ts`), and
 * every other seat follows the store.
 *
 * The card is keyed by the settings namespace it edits (`dshell`), which is
 * how the Plugins section pairs it with the namespace the Host serves. It
 * draws its own chrome rather than importing dsh's `PluginCard`, because a
 * client plugin reaches another client plugin through slots and services, not
 * through value imports. `Switch` is the exception that proves that rule: it
 * comes from the platform primitive set the module table serves, the same place
 * the file icons come from.
 */

import { createElement, useSyncExternalStore, useState, type CSSProperties, type ReactElement } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DshellShellHelper } from '../settings.js'
import { THEMES, setTheme, themeStore } from './theme.js'
import { setShellHelper, useShellHelpers } from './shell-settings.js'

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

/** A group heading inside the card, on its own line above what it governs. */
const groupStyle: CSSProperties = {
  flexBasis: '100%',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.02em',
  color: 'var(--dsw-alias-label-primary)',
  opacity: 0.55,
}

const noteStyle: CSSProperties = {
  flexBasis: '100%',
  fontSize: 12,
  opacity: 0.6,
  marginTop: 2,
}

/** One helper switch: what it is, what it does, and the control. */
const helperRowStyle: CSSProperties = {
  flexBasis: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 12,
}

const helperTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const helperLabelStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
}

const helperDetailStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  opacity: 0.62,
}

/**
 * The switches, in the order the card shows them.
 *
 * The labels live here rather than in the shared settings vocabulary because
 * they are the card's own copy — the Host stores three booleans and never reads
 * a word of this.
 */
const HELPER_ROWS: readonly { field: DshellShellHelper; label: string; detail: string }[] = [
  {
    field: 'tabCompletion',
    label: 'Tab 补全',
    detail: 'Tab 列出路径候选，大小写不敏感；唯一候选直接补全并纠正大小写',
  },
  {
    field: 'historyList',
    label: '历史列表',
    detail: '↑ 打开本会话的历史命令，↑↓ 选择、Enter 填入',
  },
  {
    field: 'commandHint',
    label: '智能提示',
    detail: '按最近命令在光标后显示虚影，→ 逐词采纳',
  },
]

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
 * Render the dshell settings card.
 * @returns the card element.
 */
export function DshellSettingsCard(): ReactElement {
  const [open, setOpen] = useState(false)
  const current = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)
  const helpers = useShellHelpers()
  // The header says what the card is set TO, so the two groups are readable
  // without opening it: the palette by name, the assists by how many are off.
  const off = HELPER_ROWS.filter(row => !helpers[row.field])
  const themeLabel = THEMES.find(theme => theme.id === current)?.label ?? current
  const helperSummary = off.length === 0
    ? '全部开启'
    : `已关闭 ${off.map(row => row.label).join('、')}`
  return createElement('li', {
    style: open ? { ...cardStyle, ...openCardStyle } : cardStyle,
    'data-dshell-card': 'settings',
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
        }, '终端与输入辅助'),
        createElement('span', { style: descStyle },
          `配色：${themeLabel} · 输入辅助：${helperSummary}`),
      ),
      createElement(Chevron, { open }),
    ),
    open
      ? createElement('div', { style: bodyStyle },
        createElement('div', { style: groupStyle }, '终端配色'),
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
        createElement('div', { style: noteStyle },
          '主终端（画布、块视图与命令行）的调色板 · 选择立即生效，并保存到主机设置（同一主机所有浏览器共用）。'),
        createElement('div', { style: groupStyle }, '输入辅助'),
        HELPER_ROWS.map(row => createElement('div', {
          key: row.field,
          style: helperRowStyle,
          'data-dshell-helper': row.field,
        },
          createElement('div', { style: helperTextStyle },
            createElement('div', { style: helperLabelStyle }, row.label),
            createElement('div', { style: helperDetailStyle }, row.detail),
          ),
          createElement(Switch, {
            checked: helpers[row.field],
            onChange: (next: boolean) => { setShellHelper(row.field, next) },
            label: row.label,
          }),
        )),
        createElement('div', { style: noteStyle },
          '关闭后对应按键回到浏览器的默认行为（Tab 移动焦点、↑ 移动光标、→ 移动光标）· 设置保存在主机，同一主机所有浏览器共用。'),
      )
      : null,
  )
}

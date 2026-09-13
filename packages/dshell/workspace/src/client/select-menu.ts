/**
 * A dropdown select built on dsh's Menu primitive.
 *
 * The native `<select>`'s opened list is drawn outside the page, and inside
 * this webview its placement has been seen to detach from the control
 * entirely — anchored to the wrong corner and scaled past the control's own
 * size. That is a surface no page CSS can reach, so the dialog's selects are
 * this wrapper instead: a closed face styled exactly like the neighbouring
 * text fields, opening dsh's own anchored menu, which the page places,
 * themes, and can screenshot.
 */

import {
  createElement, useEffect, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement,
} from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { fieldInputStyle } from './list-styles.js'

/** The Menu wrapper span is inline-flex; a form field must fill its column. */
const ROOT_CLASS = 'dshell-select-root'
const LAYOUT_CSS = `.${ROOT_CLASS} { display: flex; width: 100%; }`

/** One choice in a {@link SelectMenu}. */
export interface SelectOption {
  readonly id: string
  readonly label: string
  /** Hover tooltip on the row (the preset's description, for instance). */
  readonly title?: string
}

export interface SelectMenuProps {
  readonly value: string
  readonly options: readonly SelectOption[]
  readonly disabled?: boolean | undefined
  readonly onChange: (id: string) => void
}

/** The closed face: the dialog's field look, plus the chevron a select implies. */
const triggerStyle: CSSProperties = {
  ...fieldInputStyle,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  cursor: 'pointer',
  textAlign: 'left',
}
const chevronStyle: CSSProperties = { opacity: 0.55, flex: '0 0 auto', fontSize: 11 }

/** A select-looking control whose opened list is dsh's own anchored menu. */
export function SelectMenu(props: SelectMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  // The wrapper class rule is injected once for every instance on the page.
  useEffect(() => {
    if (document.querySelector('style[data-dshell-select-css]') !== null) return
    const style = document.createElement('style')
    style.setAttribute('data-dshell-select-css', '')
    style.textContent = LAYOUT_CSS
    document.head.append(style)
  }, [])
  const current = props.options.find(option => option.id === props.value)
  const items: readonly MenuEntry[] = props.options.map(option => ({
    id: option.id,
    // Menu rows are buttons with no title hook; the tooltip rides the label.
    label: option.title === undefined
      ? option.label
      : createElement('span', { title: option.title }, option.label),
  }))
  return createElement(Menu, {
    open,
    portal: true,
    align: 'start',
    side: 'bottom',
    className: ROOT_CLASS,
    selectedId: props.value,
    items,
    onSelect: (id: string) => { setOpen(false); props.onChange(id) },
    onClose: () => { setOpen(false) },
    anchor: createElement('button', {
      type: 'button',
      style: { ...triggerStyle, opacity: props.disabled === true ? 0.5 : 1 },
      disabled: props.disabled === true,
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        if (props.disabled !== true) setOpen(currentOpen => !currentOpen)
      },
    },
      createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        current?.label ?? props.options[0]?.label ?? ''),
      createElement('span', { style: chevronStyle, 'aria-hidden': true }, '▾'),
    ),
  })
}

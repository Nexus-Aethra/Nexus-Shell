/**
 * The task card.
 *
 * dsh docks its `TodoPanel` at the bottom of the conversation, where it lies
 * across the transcript and covers the last lines of output. For a terminal
 * that is the wrong place: the reader is watching the tail of the stream. The
 * card floats in the top-right corner instead, out of the reading flow, and
 * the docked panel is suppressed while this view is mounted.
 *
 * The list is read from the session's own `todo/write` events — the same
 * source the stock panel uses — and cleared when a new turn starts, matching
 * that projection's lifetime.
 */

import { createElement, type ReactElement } from 'react'
import { SPAN_FONT } from './block-terminal.js'
import type { Theme } from './theme.js'

/** One item of the session's task list, as the `todo/write` event carries it. */
export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
}

/** Suppress the docked panel for as long as the block view owns the surface. */
export function setTodoPanelSuppressed(suppressed: boolean): void {
  if (typeof document === 'undefined') return
  if (suppressed) document.body.dataset.dshellTodoFloating = ''
  else delete document.body.dataset.dshellTodoFloating
}

/** Injected once per page: the docked panel yields to the floating card. */
export function injectTodoCardCss(): void {
  if (typeof document === 'undefined' || document.getElementById('dshell-todo-card-css') !== null) return
  const style = document.createElement('style')
  style.id = 'dshell-todo-card-css'
  style.textContent = 'body[data-dshell-todo-floating] [data-testid="todo-panel"]{display:none !important;}'
  document.head.append(style)
}

/** Floating task card: progress by default, the list on click. */
export function TodoCard(props: { todos: readonly TodoItem[]; theme: Theme }): ReactElement | null {
  const { todos, theme } = props
  if (todos.length === 0) return null
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.filter(item => item.status === 'in_progress').length
  const pending = todos.length - done - active
  const parts = [
    done > 0 ? `${String(done)} 已完成` : '',
    active > 0 ? `${String(active)} 进行中` : '',
    pending > 0 ? `${String(pending)} 待办` : '',
  ].filter(part => part.length > 0)
  const current = todos.find(item => item.status === 'in_progress') ?? todos.find(item => item.status === 'pending')
  const complete = active === 0 && pending === 0
  return createElement('details', {
    'data-dshell-todo-card': '',
    style: {
      position: 'absolute',
      top: 8,
      right: 12,
      zIndex: 5,
      maxWidth: 'min(420px, 60%)',
      background: theme.menuBg,
      border: `1px solid ${theme.border}`,
      borderRadius: '8px',
      padding: '5px 9px',
      fontFamily: SPAN_FONT,
      fontSize: 12,
      color: theme.muted,
      boxShadow: '0 6px 20px rgba(0,0,0,.35)',
    },
  },
    createElement('summary', {
      style: { cursor: 'pointer', listStyle: 'none', display: 'flex', gap: '6px', alignItems: 'baseline', whiteSpace: 'nowrap' },
    },
      createElement('span', { style: { color: complete ? theme.muted : theme.accentText } }, '⌘'),
      createElement('span', null, `任务 · ${parts.join(' · ')}`),
      current === undefined ? null : createElement('span', {
        style: { opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '220px' },
      }, `· ${current.content}`),
    ),
    createElement('div', { style: { marginTop: '6px', display: 'grid', gap: '3px', maxHeight: '40vh', overflowY: 'auto' } },
      ...todos.map(item => createElement('div', {
        key: item.content,
        style: {
          display: 'grid',
          gridTemplateColumns: '14px 1fr',
          gap: '6px',
          color: item.status === 'completed' ? theme.muted : theme.text,
          textDecoration: item.status === 'completed' ? 'line-through' : 'none',
          whiteSpace: 'pre-wrap',
        },
      },
        createElement('span', { style: { opacity: 0.8 } }, STATUS_GLYPH[item.status]),
        createElement('span', null, item.content),
      )),
    ),
  )
}

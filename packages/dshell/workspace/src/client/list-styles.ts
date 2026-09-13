/**
 * Inline styles for the sidebar session list and its dialogs. Kept apart from
 * the components so the list file stays about behaviour; the values are the
 * ones dshell's flat list has always used, plus the row-action and archived
 * group geometry, which follow the same density.
 */

import type { CSSProperties } from 'react'

export const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: 1,
  overflow: 'hidden',
}
export const scrollStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: 1,
  overflowY: 'auto',
}
export const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 8px',
  fontSize: 12,
  opacity: 0.75,
}
export const newButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 6px',
}
export const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: 13,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}
export const rowTitleStyle: CSSProperties = {
  flex: '1 1 auto',
  // Without this the flex child refuses to shrink below its content width and
  // the ellipsis below never engages.
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
/**
 * The `SSH` badge: a session that runs on a device, not on this machine.
 *
 * Deliberately a different colour from the title it sits beside — the whole
 * point is that a glance down the list separates the sessions whose shell is a
 * local fork from the ones whose shell is an ssh process. An outline pill in
 * the theme's info colour reads as a classification rather than as an alert,
 * and `currentColor` on the border keeps the two in step in either theme.
 */
export const sshBadgeStyle: CSSProperties = {
  flex: '0 0 auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: '0.06em',
  lineHeight: '14px',
  padding: '0 4px',
  borderRadius: 3,
  color: 'var(--dsw-alias-state-business-primary, #679efe)',
  border: '1px solid currentColor',
}
/** Row actions stay invisible until the row is hovered (CSS drives it). */
export const rowActionsStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  flex: '0 0 auto',
}
export const rowActionStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 11,
  opacity: 0.65,
  padding: '1px 4px',
  borderRadius: 4,
}
export const emptyStyle: CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  opacity: 0.5,
}
/** The collapsible archive header: one quiet line above the archived rows. */
export const groupHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '6px 10px 4px',
  marginTop: 4,
  borderTop: '1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.25))',
  fontSize: 12,
  cursor: 'pointer',
  opacity: 0.7,
}
export const groupCountStyle: CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11,
  opacity: 0.7,
}
export const archivedRowStyle: CSSProperties = {
  ...rowStyle,
  opacity: 0.6,
}
export const noticeStyle: CSSProperties = {
  padding: '4px 10px 6px',
  fontSize: 11,
  color: '#f87171',
}
export const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}
export const dialogStyle: CSSProperties = {
  background: '#1b1b1f',
  border: '1px solid #33333a',
  borderRadius: 10,
  padding: 18,
  width: 400,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  color: '#e8e8ec',
}
export const dialogTitleStyle: CSSProperties = { fontSize: 15, fontWeight: 600 }
export const dialogBodyStyle: CSSProperties = { fontSize: 13, opacity: 0.8, lineHeight: 1.5 }
export const fieldLabelStyle: CSSProperties = { fontSize: 12, opacity: 0.7, marginBottom: 4 }
export const fieldInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  // dsh's input tokens (ui-primitives Input.module.css): the same fill, border,
  // and focus the stock settings forms draw with, so the dialog's fields don't
  // read as a different surface. Selects additionally carry `colorScheme:
  // 'dark'` (set where they render) — the opened option list is OS-rendered,
  // and without the scheme hint it pops up in the system's light theme.
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  color: 'var(--dsw-alias-label-primary)',
  padding: '7px 9px',
  fontSize: 13,
  outline: 'none',
}
/** Focus twin of {@link fieldInputStyle} for the dialog's fields. */
export const fieldInputFocusStyle: CSSProperties = {
  borderColor: 'var(--dsw-alias-brand-primary)',
}
/** A native select rendered with {@link fieldInputStyle}: the opened list is
 *  OS-drawn, and `color-scheme: dark` is what keeps it dark instead of white. */
export const fieldSelectStyle: CSSProperties = {
  ...fieldInputStyle,
  colorScheme: 'dark',
  appearance: 'auto',
  cursor: 'pointer',
}
export const dialogErrorStyle: CSSProperties = { color: '#f87171', fontSize: 12 }
/** Empty-registry line in the dialog: the statement plus the way out of it. */
export const emptyDeviceStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75,
}
/** Inline text button that reads as a link next to that statement. */
export const linkButtonStyle: CSSProperties = {
  border: 'none', background: 'none', padding: 0, font: 'inherit',
  color: '#7aa2f7', cursor: 'pointer', textDecoration: 'underline',
}
export const dialogActionsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  justifyContent: 'flex-end',
}
export const cancelButtonStyle: CSSProperties = {
  border: '1px solid #3a3a42',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
}
export const createButtonStyle: CSSProperties = {
  border: 'none',
  background: '#4f6bed',
  color: '#fff',
  cursor: 'pointer',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
}
export const dangerButtonStyle: CSSProperties = {
  ...createButtonStyle,
  background: '#b3261e',
}

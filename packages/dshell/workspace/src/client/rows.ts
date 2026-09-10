/**
 * The sidebar's row model: one dsh session list state flattened to the rows
 * dshell actually shows (subagent children stay out of the shell's own list),
 * newest activity first.
 */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-presets/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One ordinary session as the sidebar renders it. */
export interface SessionRow {
  id: SessionId
  cwd: string | undefined
  blank: boolean
  origin: 'subagent' | undefined
  running: boolean
  displayTitle: string
  updatedAt: number
}

/**
 * Flatten a list state into ordinary rows, newest first.
 * @param state - the sessions store snapshot.
 * @returns visible rows; subagent children are dropped.
 */
export function ordinaryRows(state: SessionListState): SessionRow[] {
  const rows: SessionRow[] = []
  for (const id of state.ids) {
    const row = state.byId[id]
    if (row === undefined || row.origin === 'subagent') continue
    rows.push({
      id: row.id,
      cwd: row.cwd,
      blank: row.blank,
      origin: row.origin,
      running: row.running,
      displayTitle: row.displayTitle,
      updatedAt: row.updatedAt,
    })
  }
  return rows.sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * Ordinary rows minus the archived ones: what the main section shows and what
 * continuity flows (boot selection, new-session cwd) are allowed to land on.
 * @param state - the sessions store snapshot.
 * @param archived - archived session ids, as strings.
 * @returns visible rows, newest first.
 */
export function activeRows(state: SessionListState, archived: readonly string[]): SessionRow[] {
  const hidden = new Set(archived)
  return ordinaryRows(state).filter(row => !hidden.has(String(row.id)))
}

/** One agent preset the new-session dialog offers. */
export interface PresetChoice {
  id: string
  label: string
  description?: string
}

/**
 * Filter roster rows down to the ones a session can actually be composed
 * from — a broken composition is dropped here, not deferred to a failed
 * session start.
 * @param rows - roster rows as the host reported them.
 * @returns the selectable presets, in roster order.
 */
export function presetChoices(rows: readonly AgentPresetRow[]): PresetChoice[] {
  return rows
    .filter(row => row.broken === undefined)
    .map(row => ({
      id: row.id,
      label: row.isDefault ? `${row.name ?? row.id}（默认）` : row.name ?? row.id,
      ...(row.description === undefined ? {} : { description: row.description }),
    }))
}

/**
 * Last path segment, so an empty name can fall back to the directory name
 * the dialog's placeholder promises.
 * @param path - absolute directory the session starts in.
 * @returns the final segment, or undefined for a root path.
 */
export function directoryName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const parts = path.split(/[\\/]/).filter(part => part.length > 0)
  return parts.at(-1)
}

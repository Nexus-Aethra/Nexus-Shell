/**
 * The block view's timeline model.
 *
 * One ordered list of blocks, whatever produced them: a shell command run
 * (sliced from the PTY stream on the shell's own end-of-command markers) or an
 * agent task (folded from the durable session window). Both carry a wall-clock
 * anchor, so a single sort reconstructs the order the user actually saw —
 * shell output that arrived between two tasks stays between them.
 */

import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PtyCommand } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import { createFold, foldEvent, type TurnBlock } from './blocks.js'
import { SESSION_ROW_LABEL, sanitizeRowText, type SessionRow } from './session-rows.js'

/** One rendered block of the view. */
export type ViewItem =
  | { readonly kind: 'shell'; readonly key: string; readonly time: number; readonly command: PtyCommand }
  | { readonly kind: 'agent'; readonly key: string; readonly time: number; readonly block: TurnBlock }
  | { readonly kind: 'notice'; readonly key: string; readonly time: number; readonly text: string }

/** One-line summary of a row, for a collapsed block's preview. */
export function rowSummary(row: SessionRow): string {
  const label = row.label ?? SESSION_ROW_LABEL[row.role]
  const first = sanitizeRowText(row.text).split('\n')[0] ?? ''
  return `${label} ${first}`.trim()
}

/** Preview lines of a collapsed agent block: its newest content, oldest first. */
export function blockPreview(block: TurnBlock, lines: number): readonly string[] {
  const rows = block.stream === undefined ? block.rows : [...block.rows, block.stream]
  const summaries = rows.map(rowSummary)
  if (summaries.length <= lines) return summaries
  return summaries.slice(-lines)
}

/**
 * Fold the durable window and merge it with the PTY command runs.
 * @param entries - the session event window.
 * @param commands - the shell command runs, oldest first.
 * @returns the items in display order.
 */
export function assembleTimeline(
  entries: readonly SessionEventLikeEntry[],
  commands: readonly PtyCommand[],
): ViewItem[] {
  const fold = createFold()
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    foldEvent(fold, entry.event)
  }
  const items: ViewItem[] = []
  // Commands are pushed first so that a timestamp tie (the bridge flushes
  // batched frames) keeps shell output above the task it raced with, matching
  // the canvas merge's tie-break.
  for (const [index, command] of commands.entries()) {
    items.push({ kind: 'shell', key: `shell:${String(index)}`, time: command.time, command })
  }
  for (const block of fold.blocks) {
    items.push({ kind: 'agent', key: block.key, time: block.startedAt, block })
  }
  for (const [index, notice] of fold.notices.entries()) {
    items.push({ kind: 'notice', key: `notice:${String(index)}`, time: notice.time, text: notice.text })
  }
  const ranks = new Map<ViewItem['kind'], number>([['shell', 0], ['agent', 1], ['notice', 2]])
  // Array.prototype.sort is stable, so equal (time, rank) pairs keep the
  // insertion order established above — shell first, then blocks in fold
  // order, then their notices.
  items.sort((left, right) => left.time - right.time
    || (ranks.get(left.kind) ?? 0) - (ranks.get(right.kind) ?? 0))
  return items
}

/** Wall-clock `HH:MM` for a block header. */
export function clockOf(time: number): string {
  return new Date(time).toTimeString().slice(0, 5)
}

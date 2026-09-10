/**
 * The block view's timeline model.
 *
 * A block is a *stretch of the session*, not a single command: the view
 * alternates shell regions with agent tasks. Everything the terminal printed
 * while no task was running belongs to one shell region — prompt, commands and
 * output in stream order, exactly the terminal's own design, with no synthetic
 * per-command chrome. A task starts a block; the shell output that follows it
 * opens the next region.
 *
 * Regions are cut from the PTY arrival segments, so the split happens at the
 * task boundaries the reader actually saw, not at the commands inside a
 * region.
 */

import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { sanitizeRowText } from './session-rows.js'
import type { TurnBlock } from './blocks.js'
import type { TodoItem } from './todo-card.js'

/** One rendered element of the view. */
export type ViewItem =
  | { readonly kind: 'shell'; readonly key: string; readonly time: number; readonly text: string }
  | { readonly kind: 'agent'; readonly key: string; readonly time: number; readonly block: TurnBlock }

/** Whether a shell region holds anything a reader would see. */
function visible(text: string): boolean {
  return sanitizeRowText(text).replace(/\s/gu, '').length > 0
}

/**
 * Merge the shell stream with the agent task blocks.
 *
 * Each PTY segment is assigned to the region that was current when it arrived:
 * the count of task blocks that had already started. Segments sharing a region
 * are contiguous in the stream, so concatenating them rebuilds that stretch of
 * terminal output verbatim.
 * @param blocks - the folded agent task blocks, in start order.
 * @param segments - the PTY text with its arrival times, oldest first.
 * @returns the items in display order: region, task, region, task, … region.
 */
export function assembleTimeline(
  blocks: readonly TurnBlock[],
  slices: readonly { text: string; time: number }[],
): ViewItem[] {
  const items: ViewItem[] = []
  for (const [index, block] of blocks.entries()) {
    const text = slices[index]?.text ?? ''
    if (visible(text)) items.push({ kind: 'shell', key: `shell:${String(index)}`, time: block.startedAt, text })
    items.push({ kind: 'agent', key: block.key, time: block.startedAt, block })
  }
  const tail = slices[blocks.length]?.text ?? ''
  if (visible(tail)) {
    items.push({
      kind: 'shell',
      key: `shell:${String(blocks.length)}`,
      time: slices[blocks.length]?.time ?? 0,
      text: tail,
    })
  }
  return items
}

/**
 * The session's current task list, from its own `todo/write` events. A new
 * turn clears it, matching the lifetime of dsh's `todos` projection.
 * @param entries - the session event window.
 * @returns the items, or an empty list when no plan is active.
 */
export function todosOf(entries: readonly SessionEventLikeEntry[]): TodoItem[] {
  let todos: TodoItem[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    if (entry.event.type === 'turn/start') { todos = []; continue }
    if (entry.event.type === 'todo/write') {
      const data = entry.event.data as { todos?: readonly TodoItem[] }
      todos = [...(data.todos ?? [])]
    }
  }
  return todos
}

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
import type { PtyBlock } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
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
  hostBlocks: readonly PtyBlock[],
  fold: { readonly blocks: readonly TurnBlock[] },
): ViewItem[] {
  const items: ViewItem[] = []
  const used = new Set<string>()
  for (const host of hostBlocks) {
    if (host.kind === 'shell') {
      if (visible(host.text)) {
        items.push({ kind: 'shell', key: `shell:${String(host.seq)}`, time: host.startedAt, text: host.text })
      }
      continue
    }
    // One turn can fold into several blocks (a supervised phase change splits
    // it), so consume every block that carries this turn.
    for (const block of fold.blocks) {
      if (block.turn !== host.turn || used.has(block.key)) continue
      used.add(block.key)
      items.push({ kind: 'agent', key: block.key, time: block.startedAt, block })
    }
  }
  // Tasks the host has no block for — history from before the block log
  // existed — are older than what it does have, so they slot in by time
  // rather than collecting at one end.
  for (const block of fold.blocks) {
    if (used.has(block.key)) continue
    used.add(block.key)
    const at = items.findIndex(item => item.time > block.startedAt)
    const node: ViewItem = { kind: 'agent', key: block.key, time: block.startedAt, block }
    if (at < 0) items.push(node)
    else items.splice(at, 0, node)
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

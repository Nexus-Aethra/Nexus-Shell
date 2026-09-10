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

import { sanitizeRowText } from './session-rows.js'
import type { TurnBlock } from './blocks.js'

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

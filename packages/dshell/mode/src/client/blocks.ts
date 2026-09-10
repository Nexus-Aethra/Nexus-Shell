/**
 * Agent task blocks: the fold that turns a session event window into one
 * collapsible block per task (or supervised phase), and its renderers.
 */

import type { SessionEventLike, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  GUTTER_COLUMNS,
  type GutterStyle,
  type SessionRow,
  renderSessionRow,
  sanitizeRowText,
  sessionRowsOf,
  wrapBlockLine,
} from './session-rows.js'

export const BLOCK_LINES = 3

/** One agent task or supervised phase, folded into a collapsible block. */
export interface TurnBlock {
  /** Stable identity for collapse state and the clicked-line table. */
  readonly key: string
  /** Turn number, once `turn/start` names it. */
  turn: number | undefined
  /** Header title: the in-progress todo item, else the request's first line. */
  title: string
  status: 'running' | 'done' | 'aborted' | 'failed'
  /** The block's rows, oldest first. */
  readonly rows: SessionRow[]
  /** Newest live-streamed row while the model writes; folded in until settle. */
  stream: SessionRow | undefined
  /** Timeline anchor: when the block opened. */
  readonly startedAt: number
  /** `step/start` count and summed tokens, for the closing notice. */
  steps: number
  tokens: number
  /** `turn:step` pairs already counted, so any carrier can report a step. */
  readonly seen: Set<string>
}

/** Record the (turn, step) an event belongs to, for the block's step count. */
export function noteStep(block: TurnBlock, event: SessionEventLike): void {
  const data = event.data as { turn?: number; step?: number }
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return
  const key = `${String(data.turn)}:${String(data.step)}`
  if (block.seen.has(key)) return
  block.seen.add(key)
  block.steps = block.seen.size
}

/** One item of the merged canvas timeline. */
export type TimelineItem =
  | { readonly kind: 'pty'; readonly time: number; readonly order: number; readonly text: string }
  | { readonly kind: 'block'; readonly time: number; readonly order: number; readonly block: TurnBlock }
  | { readonly kind: 'notice'; readonly time: number; readonly order: number; readonly text: string }

/** Incremental fold of the session window into task blocks. */
export interface BlockFold {
  readonly toolNames: Map<string, string>
  readonly blocks: TurnBlock[]
  readonly notices: { readonly time: number; readonly text: string }[]
  open: TurnBlock | undefined
  /** Monotonic key suffix; two blocks may share a start time. */
  seq: number
  /** The todo item the open block is working on. */
  phase: string | undefined
}

export function createFold(): BlockFold {
  return { toolNames: new Map(), blocks: [], notices: [], open: undefined, seq: 0, phase: undefined }
}

export function emptyBlock(key: string, time: number, title: string): TurnBlock {
  return {
    key, turn: undefined, title, status: 'running', rows: [], stream: undefined,
    startedAt: time, steps: 0, tokens: 0, seen: new Set(),
  }
}

/** Open a new block, appending it to the fold. */
export function openBlock(fold: BlockFold, time: number, title: string): TurnBlock {
  fold.seq += 1
  const block = emptyBlock(`block:${String(time)}:${String(fold.seq)}`, time, title)
  fold.blocks.push(block)
  fold.open = block
  return block
}

/** Highest durable seq a window holds, so appends never replay the window. */
export function maxSeq(entries: readonly SessionEventLikeEntry[]): number {
  let max = 0
  for (const entry of entries) if (entry.type === 'event' && entry.event.seq > max) max = entry.event.seq
  return max
}

/** Last element satisfying the predicate, without ES2023's findLast. */
export function findLast<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && match(item)) return item
  }
  return undefined
}

/** First line of a row's text, trimmed — the block title fallback. */
export function firstLineOf(text: string): string {
  const line = sanitizeRowText(text).split('\n')[0] ?? ''
  return line.trim().length > 0 ? line.trim() : text.trim()
}

/** Tokens one assistant message reported, if any. */
export function usageTokens(event: SessionEventLike): number {
  if (event.type !== 'assistant/message') return 0
  const usage = (event.data as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }).usage
  if (usage === undefined) return 0
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/** Status a turn-end reason maps to. */
export function statusOfReason(reason: { kind: string }): TurnBlock['status'] {
  if (reason.kind === 'completed') return 'done'
  if (reason.kind === 'aborted' || reason.kind === 'interrupted') return 'aborted'
  return 'failed'
}

/** One-line closing notice for a finished block. */
export function noticeOf(block: TurnBlock, reason: { kind: string; error?: { message?: string } }): string {
  const at = new Date().toTimeString().slice(0, 5)
  const facts = [`${String(block.steps)} 步`]
  if (block.tokens > 0) facts.push(`${(block.tokens / 1000).toFixed(1)}k tok`)
  facts.push(at)
  if (block.status === 'done') return `✓ AI 回答完成 · ${facts.join(' · ')}`
  if (block.status === 'aborted') return `◼ AI 回答已中断 · ${at}`
  const detail = reason.error?.message ?? (reason.kind === 'max-tokens' ? '达到输出上限' : reason.kind)
  return `✗ AI 回答出错 · ${detail} · ${at}`
}

/**
 * Fold one durable event into the block model. Blocks open on a user request
 * or a turn start, split on a supervised phase change (a new in-progress todo
 * item), and close on `turn/end`. Every other event contributes rows.
 * @param fold - the mutable fold state.
 * @param event - the durable session event, in seq order.
 */
export function foldEvent(fold: BlockFold, event: SessionEventLike): void {
  const time = event.time
  if (event.type === 'turn/start') {
    const turn = event.data.turn
    const block = fold.open
    if (block === undefined) openBlock(fold, time, '').turn = turn
    else if (block.turn === undefined) block.turn = turn
    else if (block.turn !== turn) openBlock(fold, time, '').turn = turn
    return
  }
  if (event.type === 'step/start') {
    if (fold.open !== undefined) noteStep(fold.open, event)
    return
  }
  if (event.type === 'todo/write') {
    const todos = event.data.todos
    const active = todos.find(todo => todo.status === 'in_progress')?.content
      ?? todos.find(todo => todo.status === 'pending')?.content
    if (active === undefined || active === fold.phase) return
    fold.phase = active
    // A supervised phase change closes the running block and pushes a new one;
    // a first plan (nothing rendered yet) just titles the open block.
    if (fold.open !== undefined && fold.open.rows.length > 0) {
      fold.open.status = 'done'
      fold.open = undefined
    }
    const block = fold.open ?? openBlock(fold, time, active)
    block.title = active
    return
  }
  if (event.type === 'turn/end') {
    const turn = event.data.turn
    // A second request can open a new block while an earlier turn is still
    // running, so closers match on the turn they name, not on the open block.
    const block = fold.open !== undefined && (fold.open.turn === undefined || fold.open.turn === turn)
      ? fold.open
      : findLast(fold.blocks, candidate => candidate.turn === turn && candidate.status === 'running')
    if (block === undefined) return
    block.status = statusOfReason(event.data.reason)
    if (block === fold.open) {
      fold.open = undefined
      fold.phase = undefined
    }
    fold.notices.push({ time, text: noticeOf(block, event.data.reason as { kind: string; error?: { message?: string } }) })
    return
  }
  const rows = sessionRowsOf(event, fold.toolNames)
  if (rows.length === 0) return
  if (event.type === 'user/message') {
    const title = firstLineOf(rows[0]?.text ?? '')
    // `turn/start` usually opens the block first; a request adopts that empty
    // block instead of leaving a stray running one behind.
    const open = fold.open
    if (open !== undefined && open.rows.length === 0) {
      open.title = title
      open.rows.push(...rows)
      noteStep(open, event)
      return
    }
    fold.open = undefined
    fold.phase = undefined
    const block = openBlock(fold, time, title)
    block.rows.push(...rows)
    noteStep(block, event)
    return
  }
  const block = fold.open ?? openBlock(fold, time, '')
  block.rows.push(...rows)
  noteStep(block, event)
  block.tokens += usageTokens(event)
}

/** ANSI color of a block header, by status. */
export const BLOCK_COLOR: Record<TurnBlock['status'], string> = {
  running: '\u001b[36m', // cyan
  done: '\u001b[32m', // green
  aborted: '\u001b[33m', // yellow
  failed: '\u001b[31m', // red
}

/** Header text of a block, without color. */
export function blockLabel(block: TurnBlock): string {
  const turn = block.turn === undefined ? '' : `#${String(block.turn)} · `
  const status = block.status === 'running'
    ? '运行中'
    : block.status === 'done' ? '✓ 完成' : block.status === 'aborted' ? '◼ 已中断' : '✗ 出错'
  const title = block.title.length > 60 ? `${block.title.slice(0, 57)}…` : block.title
  return `${turn}${status}${title.length === 0 ? '' : ` · ${title}`}`
}

/** Gutter style a block's rule carries. */
export function blockGutter(block: TurnBlock): GutterStyle {
  if (block.status === 'running') return 'busy'
  return block.status === 'done' ? 'done' : 'failed'
}

/**
 * The rendered content lines of a block, newest last. Lines keep the gutter
 * indent, so they are already wrapped to the canvas width and can be stacked
 * without re-wrapping. Rows are folded to summaries: a collapsed block is a
 * window onto the newest content, not a second copy of the full rows.
 */
export function blockBodyLines(block: TurnBlock, cols: number): string[] {
  const lines: string[] = []
  const push = (text: string): void => {
    const parts = text.split('\r\n')
    for (const line of parts) if (line.length > 0) lines.push(line)
  }
  for (const row of block.rows) push(renderSessionRow(row, true, cols, false))
  if (block.stream !== undefined) push(renderSessionRow(block.stream, true, cols, false))
  return lines
}

/**
 * One drawn piece of a block plus the click/fold identity of its lines.
 * Splitting the header from the rows is what lets a click fold the block on
 * its header and an individual row inside an expanded block.
 */
export interface BlockSegment {
  readonly text: string
  readonly key: string
  readonly collapsible: boolean
  readonly defaultCollapsed: boolean
}

/** Lines one rendered segment occupies (each line is newline-terminated). */
export function segmentLines(text: string): number {
  return text.split('\r\n').length - 1
}

/**
 * Segments of one block: the header, then either the fixed folded window or
 * every row. A collapsed block is exactly {@link BLOCK_LINES} lines including
 * its header — the fixed height is what lets the in-place repaint rewrite the
 * same rows while the model is still writing, leaving the shell's rows below
 * untouched.
 * @param block - the block to draw.
 * @param cols - canvas width in cells.
 * @param expanded - whether the user unfolded it.
 * @param folded - per-row fold state inside an expanded block.
 * @returns the segments, in draw order.
 */
export function blockSegments(
  block: TurnBlock,
  cols: number,
  expanded: boolean,
  folded: (row: SessionRow) => boolean,
): BlockSegment[] {
  const width = Math.max(16, cols - GUTTER_COLUMNS)
  const reset = '\u001b[0m'
  const dim = '\u001b[2m'
  const header = (hint: string): string =>
    wrapBlockLine(`${BLOCK_COLOR[block.status]}▸ ${blockLabel(block)}${reset}${hint}`, width)
  const owner: BlockSegment = { text: '', key: block.key, collapsible: true, defaultCollapsed: true }
  if (!expanded) {
    const body = blockBodyLines(block, cols)
    const tail = body.slice(-(BLOCK_LINES - 1))
    while (tail.length < BLOCK_LINES - 1) tail.unshift('  ')
    const hint = block.status === 'running' ? '' : ` ${dim}[点击展开]${reset}`
    const text = `${header(hint)}${tail.join('\r\n')}${tail.length > 0 ? '\r\n' : ''}`
    return [{ ...owner, text }]
  }
  const segments: BlockSegment[] = [{ ...owner, text: header(` ${dim}[▾ 点击收起]${reset}`) }]
  for (const row of block.rows) {
    segments.push({
      text: renderSessionRow(row, folded(row), cols),
      key: `${block.key}:${row.key}`,
      collapsible: row.collapsible,
      defaultCollapsed: row.defaultCollapsed,
    })
  }
  if (block.stream !== undefined) {
    segments.push({ text: renderSessionRow(block.stream, true, cols), key: `${block.key}:stream`, collapsible: false, defaultCollapsed: false })
  }
  return segments.map(segment => ({ ...segment, text: segment.text }))
}

/**
 * Render a collapsed block exactly as the canvas draws it. Exposed for the
 * in-place repaint, which must produce the identical line count.
 */
export function renderBlockCollapsed(block: TurnBlock, cols: number): string {
  return blockSegments(block, cols, false, () => true).map(segment => segment.text).join('')
}

/** One-line closing notice, drawn outside any block. */
export function renderNotice(text: string, cols: number): string {
  const reset = '\u001b[0m'
  const color = text.startsWith('✓') ? '\u001b[32m' : text.startsWith('◼') ? '\u001b[33m' : '\u001b[31m'
  return wrapBlockLine(`${color}${text.slice(0, 1)}${reset}\u001b[2m${text.slice(1)}${reset}`, Math.max(16, cols - GUTTER_COLUMNS))
}


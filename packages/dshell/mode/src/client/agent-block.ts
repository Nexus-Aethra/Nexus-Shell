/**
 * Agent task card: the step timeline of one task, in the transcript style the
 * reader is used to — a header with how long the task took, thinking rows that
 * report their own duration, terminal calls as one-line monospace previews,
 * consecutive calls folded into a counted group, and a paired result opened as
 * a `$ command` + output card.
 */

import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { TurnBlock } from './blocks.js'
import { SESSION_ROW_LABEL, sanitizeRowText, type SessionRow } from './session-rows.js'
import { SPAN_FONT, SPAN_FONT_SIZE } from './block-terminal.js'
import { renderMarkdown } from './markdown.js'
import type { Theme } from './theme.js'

/**
 * The transcript is monochrome by design: steps are told apart by their glyph,
 * label and weight, not by colour, and everything sits directly on the page
 * background. Only a failure earns a colour.
 */
const FAIL_COLOR = '#cc0000'

/** Kind marker style: fixed width, so labels line up down the transcript. */
const MARK_STYLE = { flex: '0 0 auto', width: '14px', textAlign: 'center' } as const

/** A foldable row: one hover target, so the whole line reads as the control. */
const FOLD_STYLE = { margin: '0 -6px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer' } as const

let foldCssInjected = false

/** The plugin ships one client bundle, so the fold stylesheet is injected once. */
function injectFoldCss(): void {
  if (foldCssInjected || typeof document === 'undefined') return
  foldCssInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '[data-dshell-fold]:hover{background:rgba(127,127,127,.10)}',
    '[data-dshell-chevron]{opacity:.65;transition:transform 120ms ease,opacity 120ms ease}',
    '[data-dshell-fold]:hover [data-dshell-chevron]{opacity:1}',
  ].join('\n')
  document.head.append(style)
}

type ToolStepModel = { key: string; label: string; command: string | undefined; output: string | undefined }
type Step =
  | { kind: 'text'; key: string; row: SessionRow; duration: number | undefined }
  | { kind: 'tool'; key: string; label: string; command: string | undefined; output: string | undefined }
  | { kind: 'group'; key: string; label: string; items: ToolStepModel[] }

/** Tool names the reader knows by their job rather than their identifier. */
const TOOL_LABEL: Record<string, string> = {
  bash: '终端', shell: '终端', terminal: '终端', exec: '终端',
  execute_command: '终端', run_command: '终端', run_terminal_cmd: '终端',
  read_file: '读取', read: '读取', write_file: '写入', write: '写入',
  edit_file: '编辑', edit: '编辑', replace: '编辑', grep: '搜索', glob: '搜索',
}

/** Display name of a tool call. */
function toolLabel(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z_]/gu, '')
  return TOOL_LABEL[key] ?? name
}

/** Human duration: `11 秒`, `2 分 5 秒`, `1 小时 2 分`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分 ${String(seconds % 60)} 秒`
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`
}

/**
 * Turn a task's rows into transcript steps: tool calls paired with their
 * results, runs of consecutive calls grouped, everything else kept in order.
 * @param rows - the block's rows, oldest first.
 * @param startedAt - when the task opened, the first row's baseline.
 * @returns the steps, in display order.
 */
export function buildSteps(rows: readonly SessionRow[], startedAt: number): Step[] {
  const results = new Map<string, SessionRow>()
  for (const row of rows) {
    if (row.role === 'tool' && row.callId !== undefined) results.set(row.callId, row)
  }
  const steps: Step[] = []
  for (const [index, row] of rows.entries()) {
    if (row.role === 'tool') continue // rendered with its call
    // A thinking row's span is the wait *before* it: thinking and the answer
    // it produces are sections of one event and share that event's timestamp.
    const previous = rows[index - 1]?.time ?? startedAt
    if (row.role === 'call') {
      const result = row.callId === undefined ? undefined : results.get(row.callId)
      steps.push({
        kind: 'tool',
        key: row.key,
        label: toolLabel(row.label ?? SESSION_ROW_LABEL.call),
        command: row.command,
        output: result?.text,
      })
      continue
    }
    steps.push({
      kind: 'text',
      key: row.key,
      row,
      duration: row.role === 'reasoning' ? Math.max(0, row.time - previous) : undefined,
    })
  }
  return groupRuns(steps)
}

/** A run of consecutive tool calls collapses to one counted group. */
function groupRuns(steps: readonly Step[]): Step[] {
  const out: Step[] = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) continue
    if (step.kind !== 'tool') { out.push(step); continue }
    const run: ToolStepModel[] = []
    let cursor = index
    for (let scan = steps[cursor]; scan?.kind === 'tool'; scan = steps[cursor]) {
      run.push({ key: scan.key, label: scan.label, command: scan.command, output: scan.output })
      cursor += 1
    }
    if (run.length === 1 && run[0] !== undefined) {
      out.push({ kind: 'tool', key: run[0].key, label: run[0].label, command: run[0].command, output: run[0].output })
    } else if (run.length > 1) {
      out.push({ kind: 'group', key: `group:${run[0]?.key ?? String(index)}`, label: run[0]?.label ?? '终端', items: run })
    }
    index = cursor - 1
  }
  return out
}

/** Lines of a result card shown before it is clipped. */
const OUTPUT_LINES = 18

function clip(text: string, limit: number): { text: string; hidden: number } {
  const lines = text.split('\n')
  if (lines.length <= limit) return { text, hidden: 0 }
  return { text: lines.slice(0, limit).join('\n'), hidden: lines.length - limit }
}

/** A terminal call: one line folded, a `$ command` + output card expanded. */
function ToolStep(props: { step: Extract<Step, { kind: 'tool' }>; theme: Theme }): ReactElement {
  const { step, theme } = props
  const [open, setOpen] = useState(false)
  const preview = step.command ?? '…'
  const output = step.output === undefined ? undefined : sanitizeRowText(step.output)
  const clipped = output === undefined ? undefined : clip(output, OUTPUT_LINES)
  return createElement('div', { style: { margin: '2px 0' } },
    createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setOpen(value => !value) },
      style: {
        display: 'flex', alignItems: 'baseline', gap: '6px',
        fontFamily: SPAN_FONT, fontSize: SPAN_FONT_SIZE,
        ...FOLD_STYLE,
      },
    },
      createElement('span', { style: { ...MARK_STYLE, color: theme.muted } }, '▤'),
      createElement('span', { style: { color: theme.muted, flex: '0 0 auto' } }, step.label),
      createElement('span', {
        style: { color: theme.text, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, preview),
      step.output === undefined ? null : createElement(Chevron, { open, theme }),
    ),
    !open || clipped === undefined ? null : createElement('div', {
      style: {
        borderRadius: '6px',
        background: theme.inputBar,
        margin: '4px 0 4px 22px',
        padding: '6px 8px',
        fontFamily: SPAN_FONT,
        fontSize: SPAN_FONT_SIZE,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: theme.text,
      },
    },
      step.command === undefined ? null : createElement('div', { style: { color: theme.muted } }, `$ ${step.command}`),
      clipped.text,
      clipped.hidden > 0 ? createElement('div', { style: { color: theme.muted } }, `… 还有 ${String(clipped.hidden)} 行`) : null,
    ),
  )
}

/** A run of terminal calls: one counted line, the calls listed when opened. */
function ToolGroup(props: { step: Extract<Step, { kind: 'group' }>; theme: Theme }): ReactElement {
  const { step, theme } = props
  const [open, setOpen] = useState(false)
  return createElement('div', { style: { margin: '2px 0' } },
    createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setOpen(value => !value) },
      style: {
        display: 'flex', alignItems: 'baseline', gap: '6px',
        color: theme.muted, fontFamily: SPAN_FONT, fontSize: SPAN_FONT_SIZE,
        ...FOLD_STYLE,
      },
    },
      createElement('span', { style: MARK_STYLE }, '▤'),
      createElement('span', null, `${step.label} · ${String(step.items.length)} 个命令`),
      createElement(Chevron, { open, theme }),
    ),
    ...(open
      ? step.items.map(item => createElement('div', { key: item.key, style: { marginLeft: '20px' } },
          createElement(ToolStep, { step: { kind: 'tool', ...item }, theme })))
      : []),
  )
}

/** Prose and thinking steps. */
function TextStep(props: { step: Extract<Step, { kind: 'text' }>; theme: Theme }): ReactElement {
  const { step, theme } = props
  const row = step.row
  const [open, setOpen] = useState(false)
  if (row.role === 'reasoning') {
    return createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setOpen(value => !value) },
      style: { margin: '2px -6px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer' },
    },
      createElement('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: '6px', color: theme.muted, fontSize: 12 },
      },
        createElement('span', { style: MARK_STYLE }, '◌'),
        createElement('span', null, SESSION_ROW_LABEL.reasoning),
        step.duration === undefined ? null : createElement('span', null, `· 持续了 ${formatDuration(step.duration)}`),
        createElement(Chevron, { open, theme }),
      ),
      open ? createElement('div', {
        style: { color: theme.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginLeft: '20px', fontSize: 12 },
      }, sanitizeRowText(row.text)) : null,
    )
  }
  if (row.role === 'user') {
    return createElement('div', {
      style: {
        borderRadius: '10px',
        background: theme.inputBar,
        padding: '7px 11px',
        margin: '6px 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: theme.text,
      },
    }, sanitizeRowText(row.text))
  }
  return createElement('div', {
    style: {
      margin: '6px 0',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      lineHeight: 1.6,
      color: theme.text,
    },
  }, sanitizeRowText(row.text))
}

/**
 * The one expand affordance. Every foldable row uses this: the same glyph, the
 * same size, rotated by CSS rather than swapped for a different character, so
 * open and closed read as one control instead of two.
 */
function Chevron(props: { open: boolean; theme: Theme }): ReactElement {
  return createElement('span', {
    'data-dshell-chevron': '',
    style: {
      display: 'inline-block',
      fontSize: 14,
      lineHeight: '14px',
      color: props.theme.muted,
      transform: props.open ? 'rotate(90deg)' : 'none',
      transition: 'transform 120ms ease',
    },
  }, '›')
}

/** Token count in the compact form the transcript uses. */
function formatTokens(tokens: number): string | undefined {
  if (tokens <= 0) return undefined
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${String(tokens)} tok`
}

/**
 * One agent task.
 *
 * Folding hides the *process* only. What the user asked and what the model
 * answered stay on screen either way; the thinking and the terminal calls
 * collapse behind a single summary line — `已工作 6 秒 · 1.2k tok ›` — the way
 * the transcript this is modelled on reads.
 */
export function AgentBlock(props: { block: TurnBlock; theme: Theme }): ReactElement {
  const { block, theme } = props
  const [expanded, setExpanded] = useState(false)
  const running = block.status === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [running])
  useEffect(() => { injectFoldCss() }, [])
  const endedAt = block.notice?.time ?? now
  const asked = block.rows.filter(row => row.role === 'user')
  const answers = block.rows.filter(row => row.role === 'assistant')
  const process = block.rows.filter(row => row.role !== 'user' && row.role !== 'assistant')
  const steps = useMemo(() => buildSteps(process, block.startedAt), [process, block.startedAt])
  const tokens = formatTokens(block.tokens)
  const failed = block.status === 'failed' || block.status === 'aborted'
  return createElement('div', {
    'data-dshell-block': 'agent',
    // The same 13px the terminal regions render at, so an answer and the
    // stream it came from read at one size.
    style: { margin: '14px 0 18px', overflow: 'hidden', fontSize: SPAN_FONT_SIZE, lineHeight: 1.6 },
  },
    ...asked.map(row => createElement('div', {
      key: row.key,
      style: {
        borderRadius: '10px',
        background: theme.inputBar,
        padding: '7px 11px',
        // The request sits on the right, the way the transcript separates
        // who is speaking without labelling it.
        margin: '6px 0 6px auto',
        width: 'fit-content',
        maxWidth: '78%',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: theme.text,
      },
    }, sanitizeRowText(row.text))),
    createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setExpanded(value => !value) },
      style: {
        display: 'flex', alignItems: 'baseline', gap: '6px',
        color: failed ? FAIL_COLOR : theme.muted, fontSize: 12,
        margin: '6px -6px 4px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer',
      },
    },
      createElement('span', { style: { fontSize: 9 } }, running ? '◐' : failed ? '◼' : '●'),
      createElement('span', null, running
        ? `工作中 ${formatDuration(endedAt - block.startedAt)}`
        : `已工作 ${formatDuration(endedAt - block.startedAt)}`),
      tokens === undefined ? null : createElement('span', null, `· ${tokens}`),
      createElement(Chevron, { open: expanded, theme }),
    ),
    ...(expanded
      ? steps.map(step => (step.kind === 'tool'
          ? createElement(ToolStep, { key: step.key, step, theme })
          : step.kind === 'group'
            ? createElement(ToolGroup, { key: step.key, step, theme })
            : createElement(TextStep, { key: step.key, step, theme })))
      : []),
    // An answer is written to be read: render its markdown rather than the
    // raw syntax it arrived in.
    ...answers.flatMap(row => renderMarkdown(sanitizeRowText(row.text), theme, row.key)),
    block.notice === undefined || !failed ? null : createElement('div', {
      style: { color: FAIL_COLOR, fontSize: 12, marginTop: '4px' },
    }, block.notice.text),
  )
}

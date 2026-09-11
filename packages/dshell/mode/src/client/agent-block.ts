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
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Theme } from './theme.js'

/** A foldable row: one hover target, so the whole line reads as the control. */
const FOLD_STYLE = { margin: '0 -6px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer' } as const

/**
 * dsh's official fish silhouette path, inlined so this package stays free of an
 * extra `@deepseek-ai/dsh-client-ui-primitives` import. The source is
 * `dsh/packages/client/ui-primitives/src/FishLogo.tsx` (the `FISH_LOGO_PATH`
 * constant), reproduced verbatim — same viewBox, same geometry — and used at
 * 16px in the agent-block fold header so the running state reads as the brand
 * mark rather than a generic character glyph.
 */
const FISH_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

/** The fish silhouette's intrinsic box, in user units. */
const FISH_VB_W = 23.16
const FISH_VB_H = 17.04

let foldCssInjected = false

/** The plugin ships one client bundle, so the fold stylesheet is injected once. */
function injectFoldCss(): void {
  if (foldCssInjected || typeof document === 'undefined') return
  foldCssInjected = true
  const style = document.createElement('style')
  style.textContent = [
    // Hover affordance on the fold row.
    '[data-dshell-fold]:hover{background:rgba(127,127,127,.10)}',
    // Chevron rotation.
    '[data-dshell-chevron]{opacity:.65;transition:transform 120ms ease,opacity 120ms ease}',
    '[data-dshell-fold]:hover [data-dshell-chevron]{opacity:1}',
    // Brand-coloured shimmer on the running agent block's "深度求索中…" line,
    // adapted from dsh's stock turnStatus (ChatView.module.css): the same
    // linear-gradient sweep on the text. This is the only place the transcript
    // uses the brand blue — internal rows stay monochrome and let the
    // header's colour do the running-signal work.
    '[data-dshell-running-text]{',
    '  background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,var(--dsw-static-deepseek-500) 40%,var(--dsw-static-deepseek-200) 50%,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-deepseek-500) 100%);',
    '  background-position:100% 0;background-size:250% 100%;',
    '  -webkit-background-clip:text;background-clip:text;',
    '  color:transparent;-webkit-text-fill-color:transparent;',
    '  animation:dshell-running-shimmer 1.8s linear infinite;',
    '}',
    '@keyframes dshell-running-shimmer{to{background-position:0 0}}',
    // The running fish mark in the fold header shares the same brand
    // colour as the running text so the row reads as one piece.
    '[data-dshell-running-fish]{color:var(--dsw-static-deepseek-500)}',
    // A slow opacity breath on a live thinking label, so the reader can
    // see the row is still in flight without re-reading the label.
    '[data-dshell-thinking-glyph]{animation:dshell-thinking-breathe 1.4s ease-in-out infinite}',
    '@keyframes dshell-thinking-breathe{0%,100%{opacity:.35}50%{opacity:1}}',
    // Internal rows adopt dsh's stock "running" affordance: a 300px sweep
    // band that crosses the row on the page background, not on the text.
    // The band is the page's own skeleton tone so the running signal reads
    // as "the page is paying attention", not "this row is coloured".
    // Column-specific overrides aren't needed because every internal row
    // is the same height as the fold body.
    '[data-dshell-running-row]{position:relative;overflow:hidden}',
    '[data-dshell-running-row]::after{',
    '  content:"";position:absolute;inset-block:0;left:0;width:300px;',
    '  background:linear-gradient(90deg,transparent 0%,var(--dsw-alias-bg-skeleton) 55%,transparent 100%);',
    '  animation:dshell-row-sweep 2.6s ease-out infinite;',
    '  pointer-events:none;',
    '}',
    '@keyframes dshell-row-sweep{0%{left:-300px}90%,100%{left:100%}}',
    // Honour the OS-level reduced-motion preference: stop every animation
    // and fall back to the static brand colour on the header.
    '@media (prefers-reduced-motion:reduce){',
    '  [data-dshell-running-text]{background-position:0 0;background-size:100% 100%;animation:none}',
    '  [data-dshell-running-row]::after{animation:none;display:none}',
    '  [data-dshell-thinking-glyph]{animation:none;opacity:1}',
    '}',
  ].join('\n')
  document.head.append(style)
}

type ToolStepModel = { key: string; label: string; command: string | undefined; output: string | undefined; images: readonly unknown[] | undefined }

/**
 * Resolves an attachment ref to a displayable URL. Spelled as the conversation
 * contract's own loader, so the service's implementation assigns without a
 * cast and the attachment shape stays that package's business.
 */
export type ImageLoader = MessageImageLoader
type Step =
  | { kind: 'text'; key: string; row: SessionRow; duration: number | undefined }
  | { kind: 'tool'; key: string; label: string; command: string | undefined; output: string | undefined; images: readonly unknown[] | undefined }
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
        images: result?.images,
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
      run.push({ key: scan.key, label: scan.label, command: scan.command, output: scan.output, images: scan.images })
      cursor += 1
    }
    if (run.length === 1 && run[0] !== undefined) {
      out.push({ kind: 'tool', key: run[0].key, label: run[0].label, command: run[0].command, output: run[0].output, images: run[0].images })
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
function ToolStep(props: { step: Extract<Step, { kind: 'tool' }>; theme: Theme; loadImage: ImageLoader | undefined }): ReactElement {
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
      createElement(ToolMark),
      createElement('span', {
        // Internal rows stay on the same tertiary label tier dsh's stock
        // command/thinking rows use. Brand colour is reserved for the fold
        // header's running shimmer — internal rows are archival regardless
        // of whether the parent block is still running; the parent's
        // sweep container is what signals "live".
        style: { color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
      }, step.label),
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
    createElement(RowImages, { images: step.images, loadImage: props.loadImage, theme }),
  )
}

/**
 * The reader's own words: a right-aligned bubble, the way the transcript
 * separates who is speaking without labelling it.
 *
 * Exported because a just-sent message is rendered from the session's pending
 * submission echo — before it is durable, so the reader sees what they sent
 * while the model is still starting up — and it must look identical to the
 * durable row that replaces it.
 */
export function UserBubble(props: {
  text: string
  images?: readonly unknown[] | undefined
  loadImage: ImageLoader | undefined
  theme: Theme
}): ReactElement {
  return createElement('div', {
    style: {
      borderRadius: '10px',
      background: props.theme.inputBar,
      padding: '7px 11px',
      margin: '6px 0 6px auto',
      width: 'fit-content',
      maxWidth: '78%',
      color: props.theme.text,
    },
  },
    createElement('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, sanitizeRowText(props.text)),
    createElement(RowImages, { images: props.images, loadImage: props.loadImage, theme: props.theme }),
  )
}

/**
 * Attachments carried by one row, resolved to URLs through the conversation
 * service. Rendering them is what lets the reader confirm the model was handed
 * the image at all.
 */
function RowImages(props: { images: readonly unknown[] | undefined; loadImage: ImageLoader | undefined; theme: Theme }): ReactElement | null {
  const { images, loadImage } = props
  const [urls, setUrls] = useState<readonly string[]>([])
  const key = JSON.stringify(images ?? [])
  useEffect(() => {
    if (images === undefined || images.length === 0 || loadImage === undefined) { setUrls([]); return }
    let live = true
    void Promise.all(images.map(image => loadImage(image as Parameters<ImageLoader>[0]).catch(() => '')))
      .then(resolved => { if (live) setUrls(resolved.filter(url => url.length > 0)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for the array identity
  }, [key, loadImage])
  if (urls.length === 0) return null
  return createElement('div', {
    'data-dshell-block-images': '',
    style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '6px 0 2px' },
  }, ...urls.map((url, index) => createElement('img', {
    key: `${url}:${String(index)}`,
    src: url,
    alt: '附件图片',
    onClick: () => { window.open(url, '_blank', 'noopener') },
    style: {
      maxWidth: 'min(420px, 100%)',
      maxHeight: '260px',
      borderRadius: '8px',
      border: `1px solid ${props.theme.border}`,
      cursor: 'zoom-in',
      objectFit: 'contain',
    },
  })))
}

/** A run of terminal calls: one counted line, the calls listed when opened. */
function ToolGroup(props: { step: Extract<Step, { kind: 'group' }>; theme: Theme; loadImage: ImageLoader | undefined }): ReactElement {
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
      createElement(ToolMark),
      createElement('span', null, `${step.label} · `),
      createElement('span', {
        // The count is the only fresh fact in the row; bold pulls it
        // forward without a colour swap, so the rest of the transcript
        // doesn't gain a second accent tier.
        style: { fontWeight: 600, color: theme.muted },
      }, String(step.items.length)),
      createElement('span', null, ' 个命令'),
      createElement(Chevron, { open, theme }),
    ),
    ...(open
      ? step.items.map(item => createElement('div', { key: item.key, style: { marginLeft: '20px' } },
          createElement(ToolStep, { step: { kind: 'tool', ...item }, theme, loadImage: props.loadImage })))
      : []),
  )
}

/** Prose and thinking steps. */
function TextStep(props: { step: Extract<Step, { kind: 'text' }>; theme: Theme; loadImage: ImageLoader | undefined }): ReactElement {
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
        // Thinking rows get dsh's official `IconThinkOutline14` mark — the
        // same small brain glyph dsh's stock ReasoningRow uses. Live
        // thinking rows (duration === undefined) carry a 1.4s opacity
        // breath on the label so the reader can see one is still in
        // flight without re-reading it. Reduced-motion drops the breath.
        createElement(ThinkMark),
        createElement('span', {
          'data-dshell-thinking-glyph': step.duration === undefined ? '' : undefined,
          style: { color: 'var(--dsw-alias-label-tertiary)' },
        }, SESSION_ROW_LABEL.reasoning),
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
/**
 * The dsh brand fish, drawn at 16px in the fold header. It signals "this
 * block" rather than "any row of this block" — dsh's stock ChatView uses
 * the same fish for the parent turn surface, and reserves the running
 * affordance for the header alone. The body rows use a small per-action
 * icon (see ThinkMark, ToolMark), not the fish.
 *
 * `tone: 'shimmer'` lets the surrounding text shimmer paint the fish via
 * `currentColor`; `tone: 'error'` is the failed-block variant, which is
 * the same shape painted with the dsw error alias.
 */
function FishMark(props: { tone: 'shimmer' | 'muted' | 'error' }): ReactElement {
  const h = (16 * FISH_VB_H) / FISH_VB_W
  const style: Record<string, string | number> = { flex: '0 0 auto', alignSelf: 'center' }
  if (props.tone === 'shimmer') {
    // The brand colour comes from the `[data-dshell-running-fish]` rule so
    // the same animation hook can re-paint the fish when the running state
    // changes; a future palette swap is one rule change.
    style['data-dshell-running-fish'] = ''
  } else if (props.tone === 'error') {
    style.color = 'var(--dsw-alias-state-error-primary)'
  }
  return createElement('svg', {
    width: 16,
    height: h,
    viewBox: `0 0 ${FISH_VB_W} ${FISH_VB_H}`,
    fill: 'currentColor',
    'aria-hidden': 'true',
    style,
  },
    createElement('path', { d: FISH_PATH }),
  )
}

/**
 * Internal-row mark for a thinking step: the dsh official `IconThinkOutline14`
 * glyph, inlined so this package does not have to take
 * `@deepseek-ai/dsh-client-ui-primitives` as a link dep. The path is
 * reproduced verbatim from
 * `dsh/packages/client/ui-primitives/src/icons/index.tsx`; the viewBox is
 * 14×14 and the mark fills the parent `currentColor` so it picks up the
 * row's label tier without a per-row rule.
 */
function ThinkMark(): ReactElement {
  return createElement('svg', {
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
    style: { flex: '0 0 auto', alignSelf: 'center', color: 'var(--dsw-alias-label-tertiary)' },
  },
    createElement('path', {
      d: 'M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z',
      fill: 'currentColor',
    }),
    createElement('path', {
      fillRule: 'evenodd', clipRule: 'evenodd',
      d: 'M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z',
      fill: 'currentColor',
    }),
  )
}

/**
 * Internal-row mark for a generic tool call: the dsh official
 * `IconApiOutline14` glyph (the same `</api>`-style API plugin icon dsh's
 * stock `GenericCommandCard` uses), inlined for the same reason as
 * ThinkMark. The error-tone variant draws the same path with the dsw error
 * alias and overlays a small red dot, mirroring dsh's "StateDot state=error"
 * affordance.
 */
function ToolMark(props: { tone?: 'muted' | 'error' }): ReactElement {
  return createElement('span', {
    style: {
      flex: '0 0 auto',
      alignSelf: 'center',
      position: 'relative',
      display: 'inline-flex',
      width: 14, height: 14,
      color: props.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
    },
  },
    createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true',
      style: { position: 'absolute', inset: 0 },
    },
      createElement('path', {
        transform: 'translate(0.6689 1.073)',
        d: 'M11.4818 5.57813C11.4818 4.45301 11.4807 3.66237 11.4075 3.05908C11.3359 2.46953 11.2024 2.13852 10.9939 1.89441C10.9247 1.81341 10.8493 1.73801 10.7683 1.66882C10.5242 1.46033 10.1932 1.32686 9.60364 1.25525C9.00034 1.18198 8.20974 1.18091 7.0846 1.18091L5.57813 1.18091C4.45301 1.18091 3.66238 1.18198 3.05908 1.25525C2.46953 1.32686 2.13852 1.46033 1.89441 1.66882C1.81341 1.73801 1.73801 1.81341 1.66882 1.89441C1.46033 2.13852 1.32686 2.46953 1.25525 3.05908C1.18198 3.66238 1.18091 4.45301 1.18091 5.57813L1.18091 6.2771C1.18091 7.40218 1.18197 8.19288 1.25525 8.79614C1.32687 9.38553 1.46036 9.71674 1.66882 9.96082C1.73797 10.0417 1.81347 10.1173 1.89441 10.1864C2.13851 10.3948 2.46965 10.5275 3.05908 10.5991C3.66238 10.6724 4.45298 10.6735 5.57813 10.6735L7.0846 10.6735C8.20977 10.6735 9.00033 10.6724 9.60364 10.5991C10.1931 10.5275 10.5242 10.3948 10.7683 10.1864C10.8493 10.1173 10.9247 10.0417 10.9939 9.96082C11.2024 9.71674 11.3358 9.38553 11.4075 8.79614C11.4808 8.19288 11.4818 7.40218 11.4818 6.2771L11.4818 5.57813ZM12.6627 6.2771C12.6627 7.37222 12.6637 8.247 12.5798 8.93799C12.4942 9.64284 12.3133 10.2359 11.8928 10.7282C11.7834 10.8562 11.6637 10.9751 11.5356 11.0845C11.0434 11.5049 10.4511 11.6867 9.74634 11.7723C9.05525 11.8563 8.17999 11.8552 7.0846 11.8552L5.57813 11.8552C4.48273 11.8552 3.60747 11.8563 2.91638 11.7723C2.21157 11.6867 1.61933 11.5049 1.12708 11.0845C0.99901 10.9751 0.879281 10.8562 0.769898 10.7282C0.349454 10.2359 0.168506 9.64284 0.0828864 8.93799C-0.00101964 8.247 4.88512e-07 7.37222 6.47206e-07 6.2771L6.47206e-07 5.57813C6.47206e-07 4.48273 -0.00106163 3.60747 0.0828864 2.91638C0.168502 2.21168 0.349594 1.61928 0.769898 1.12708C0.879302 0.998981 0.998981 0.879302 1.12708 0.769898C1.61928 0.349594 2.21168 0.168502 2.91638 0.0828864C3.60747 -0.00106163 4.48273 6.47206e-07 5.57813 6.47206e-07L7.0846 6.47206e-07C8.17999 6.47206e-07 9.05525 -0.00106163 9.74634 0.0828864C10.451 0.168505 11.0434 0.349587 11.5356 0.769898C11.6637 0.879302 11.7834 0.998981 11.8928 1.12708C12.3131 1.61928 12.4942 2.21169 12.5798 2.91638C12.6638 3.60747 12.6627 4.48273 12.6627 5.57813L12.6627 6.2771Z',
        fill: 'currentColor',
      }),
      createElement('path', {
        transform: 'translate(0.6689 1.073)',
        d: 'M6.02607 5.50955L6.44306 5.9274L3.84284 8.52762L3.425 8.11063L3.00715 7.69278L4.77253 5.9274L3.00715 4.16202L3.84284 3.32633L6.02607 5.50955Z',
        fill: 'currentColor',
      }),
      createElement('path', {
        transform: 'translate(0.6689 1.073)',
        d: 'M9.23789 7.35397L9.23789 8.53488L6.96238 8.53488L6.96238 7.35397L9.23789 7.35397Z',
        fill: 'currentColor',
      }),
    ),
  )
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
export function AgentBlock(props: { block: TurnBlock; theme: Theme; loadImage: ImageLoader | undefined }): ReactElement {
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
  // The fold mutates `rows` in place, so the array identity stays put while a
  // step streams and its length is what says a row was appended. Partitioning
  // with fresh filters on every render would defeat both memos below and
  // re-parse the whole answer on every streamed frame.
  const { asked, answers, process } = useMemo(() => ({
    asked: block.rows.filter(row => row.role === 'user'),
    answers: block.rows.filter(row => row.role === 'assistant'),
    process: block.rows.filter(row => row.role !== 'user' && row.role !== 'assistant'),
  }), [block.rows, block.rows.length])
  const steps = useMemo(() => buildSteps(process, block.startedAt), [process, block.startedAt])
  const tokens = formatTokens(block.tokens)
  const failed = block.status === 'failed' || block.status === 'aborted'
  // Answers are written to be read: render their markdown rather than the raw
  // syntax they arrived in, and keep the result until the rows change.
  const answerNodes = useMemo(
    () => answers.flatMap(row => [
      ...renderMarkdown(sanitizeRowText(row.text), theme, row.key),
      createElement(RowImages, { key: `${row.key}:img`, images: row.images, loadImage: props.loadImage, theme }),
    ]),
    [answers, theme, props.loadImage],
  )
  // The live line the model is still writing. It renders through the same
  // paths, in the same position, as the durable rows that supersede it, so
  // settlement neither moves nor restyles the text.
  const stream = block.stream
  const liveReasoning = stream === undefined || stream.reasoning.length === 0
    ? null
    : createElement(TextStep, {
      key: 'stream:reason',
      step: {
        kind: 'text',
        key: 'stream:reason',
        row: {
          role: 'reasoning',
          key: 'stream:reason',
          text: stream.reasoning,
          collapsible: false,
          defaultCollapsed: false,
          time: stream.time,
          label: SESSION_ROW_LABEL.reasoning,
        },
        duration: undefined,
      },
      theme,
      loadImage: props.loadImage,
    })
  const liveText = stream === undefined || stream.text.length === 0
    ? undefined
    : `${sanitizeRowText(stream.text)}${running ? '▍' : ''}`
  return createElement('div', {
    'data-dshell-block': 'agent',
    // The bookmark rail looks each block up by its stable key, so the
    // scroll-into-view can land on the right one.
    'data-dshell-block-key': block.key,
    // The same 13px the terminal regions render at, so an answer and the
    // stream it came from read at one size.
    style: { margin: '14px 0 18px', overflow: 'hidden', fontSize: SPAN_FONT_SIZE, lineHeight: 1.6 },
  },
    ...asked.map(row => createElement(UserBubble, {
      key: row.key,
      text: row.text,
      images: row.images,
      loadImage: props.loadImage,
      theme,
    })),
    createElement('div', {
      'data-dshell-fold': '',
      onClick: () => { setExpanded(value => !value) },
      style: {
        display: 'flex', alignItems: 'baseline', gap: '6px',
        // A failed block reads as a stopped session, not an alert. The whole
        // row stays on the same muted label tier as a normal-done block; the
        // failure is signalled by a thin left rail in the error alias, the
        // error-toned fish, and the "已中断" word. This matches dsh's stock
        // philosophy: colour is reserved for the part of the line the
        // reader has to act on, not the whole row.
        color: theme.muted, fontSize: 12,
        margin: '6px -6px 4px', padding: '1px 6px 1px 8px', borderRadius: '6px', cursor: 'pointer',
        borderLeft: failed ? '2px solid var(--dsw-alias-state-error-primary)' : '2px solid transparent',
      },
    },
      running
        ? createElement(FishMark, { tone: 'shimmer' })
        : createElement(FishMark, { tone: failed ? 'error' : 'muted' }),
      running
        ? createElement('span', { 'data-dshell-running-text': '' },
            `深度求索中 · ${formatDuration(endedAt - block.startedAt)}`)
        : createElement('span', null,
            failed ? `已中断 · ${formatDuration(endedAt - block.startedAt)}` : `已工作 ${formatDuration(endedAt - block.startedAt)}`),
      tokens === undefined ? null : createElement('span', null, `· ${tokens}`),
      createElement(Chevron, { open: expanded, theme }),
    ),
    // Fold body: when the block is running, a single running-row container
    // gives every internal step dsh's stock "sweep" running signal. When
    // the block is done or failed, no container — the steps read as a quiet
    // monochrome archive. The notice line that used to render below the
    // answer (a red "AI 回答已中断 · 22:43") was a duplicate of the fold
    // header; the header now carries the failure state on its own, so the
    // duplicate is gone.
    expanded ? createElement('div', running ? { 'data-dshell-running-row': '' } : undefined,
      ...steps.map(step => (step.kind === 'tool'
        ? createElement(ToolStep, { key: step.key, step, theme, loadImage: props.loadImage })
        : step.kind === 'group'
          ? createElement(ToolGroup, { key: step.key, step, theme, loadImage: props.loadImage })
          : createElement(TextStep, { key: step.key, step, theme, loadImage: props.loadImage }))),
      liveReasoning,
    ) : null,
    ...answerNodes,
    liveText === undefined
      ? null
      : createElement('div', { 'data-dshell-stream': '' }, ...renderMarkdown(liveText, theme, 'stream')),
  )
}

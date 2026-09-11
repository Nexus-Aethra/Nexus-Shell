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

/**
 * The transcript is monochrome by design: steps are told apart by their glyph,
 * label and weight, not by colour, and everything sits directly on the page
 * background. Only a failure earns a colour.
 */
const FAIL_COLOR = '#cc0000'

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
    // linear-gradient sweep on the text, but sized to the dshell 12px row.
    '[data-dshell-running-text]{',
    '  background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,var(--dsw-static-deepseek-500) 40%,var(--dsw-static-deepseek-200) 50%,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-deepseek-500) 100%);',
    '  background-position:100% 0;background-size:250% 100%;',
    '  -webkit-background-clip:text;background-clip:text;',
    '  color:transparent;-webkit-text-fill-color:transparent;',
    '  animation:dshell-running-shimmer 1.8s linear infinite;',
    '}',
    '@keyframes dshell-running-shimmer{to{background-position:0 0}}',
    // A slow breath on the live thinking label, so the reader can see a
    // thinking row is still in flight without re-reading the label.
    '[data-dshell-thinking-glyph]{animation:dshell-thinking-breathe 1.4s ease-in-out infinite}',
    '@keyframes dshell-thinking-breathe{0%,100%{opacity:.35}50%{opacity:1}}',
    // The running fish mark shares the same brand colour as the running text
    // so the row reads as one piece, not two; reduced-motion takes it back
    // to a flat static brand colour.
    '[data-dshell-running-fish]{color:var(--dsw-static-deepseek-500)}',
    // Internal steps (thinking, tool, tool-group) use a smaller 12px fish
    // mark, still in the brand colour, so the agent block reads as a single
    // branded surface top to bottom.
    '[data-dshell-step-fish]{color:var(--dsw-static-deepseek-500)}',
    // Honour the OS-level reduced-motion preference: stop the shimmer and
    // breath, fall back to the static brand colour.
    '@media (prefers-reduced-motion:reduce){',
    '  [data-dshell-running-text]{background-position:0 0;background-size:100% 100%;animation:none}',
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
      createElement(StepMark),
      createElement('span', {
        style: {
          // Same family as the fold header's running text but muted for
          // archived steps, so the row reads as "the same brand, lower volume"
          // instead of a different palette.
          color: 'var(--dsw-static-deepseek-500)',
          opacity: 0.78,
          flex: '0 0 auto',
        },
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
      createElement(StepMark),
      createElement('span', null, `${step.label} · `),
      // The count is the only fresh fact in the row, so it's the only part
      // that earns the brand colour; the rest stays muted so the rest of
      // the transcript doesn't lose its quiet baseline.
      createElement('span', {
        style: { color: 'var(--dsw-static-deepseek-500)', fontWeight: 500 },
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
        // Thinking rows get the same fish mark as tool rows, in the same
        // brand colour, so the transcript reads as one surface. The breath
        // attribute still rides on a separate target (`data-dshell-thinking-
        // glyph`) so a future marker redesign doesn't have to re-derive
        // which children animate.
        createElement(StepMark),
        createElement('span', {
          'data-dshell-thinking-glyph': step.duration === undefined ? '' : undefined,
          style: {
            color: 'var(--dsw-static-deepseek-500)',
            opacity: 0.78,
            // Live thinking rows still want the breathing marker; the data
            // attribute also lives on the label here so a label redesign
            // doesn't lose the running signal.
            ...(step.duration === undefined
              ? { animation: 'dshell-thinking-breathe 1.4s ease-in-out infinite' }
              : {}),
          },
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
 * The dsh brand fish, drawn at 16px in the running fold header.
 *
 * `tone: 'shimmer'` lets the surrounding text shimmer paint the fish via
 * `currentColor`; the parent text element is what carries the gradient, so the
 * fish picks up the same animated brand colour for free.
 */
function FishMark(_props: { tone: 'shimmer' }): ReactElement {
  const h = (16 * FISH_VB_H) / FISH_VB_W
  return createElement('svg', {
    width: 16,
    height: h,
    viewBox: `0 0 ${FISH_VB_W} ${FISH_VB_H}`,
    fill: 'currentColor',
    'aria-hidden': 'true',
    // The shared brand colour is set by the `[data-dshell-running-fish]`
    // selector, so a future palette swap is one rule change. The static
    // brand colour (var(--dsw-static-deepseek-500)) is the same family the
    // shimmer text gradients through, so the fish and the label read as one.
    'data-dshell-running-fish': '',
    style: { flex: '0 0 auto', alignSelf: 'center' },
  },
    createElement('path', { d: FISH_PATH }),
  )
}

/**
 * A 12px fish used as the leading mark on internal steps (thinking rows, tool
 * calls, grouped runs). Same dsh brand path as the fold header, smaller so
 * the visual weight doesn't compete with the running shimmer on the parent
 * row; every internal step is brand-coloured so the transcript reads as one
 * branded surface, not "agent header in colour, body in grey".
 */
function StepMark(): ReactElement {
  const h = (12 * FISH_VB_H) / FISH_VB_W
  return createElement('svg', {
    width: 12,
    height: h,
    viewBox: `0 0 ${FISH_VB_W} ${FISH_VB_H}`,
    fill: 'currentColor',
    'aria-hidden': 'true',
    'data-dshell-step-fish': '',
    style: { flex: '0 0 auto', alignSelf: 'center', opacity: 0.85 },
  },
    createElement('path', { d: FISH_PATH }),
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
        color: failed ? FAIL_COLOR : theme.muted, fontSize: 12,
        margin: '6px -6px 4px', padding: '1px 6px', borderRadius: '6px', cursor: 'pointer',
      },
    },
      running
        ? createElement(FishMark, { tone: 'shimmer' })
        : createElement('span', { style: { fontSize: 9, color: failed ? FAIL_COLOR : theme.muted } },
            failed ? '◼' : '●'),
      running
        ? createElement('span', { 'data-dshell-running-text': '' },
            `深度求索中 · ${formatDuration(endedAt - block.startedAt)}`)
        : createElement('span', null,
            failed ? 'AI 回答已中断' : `已工作 ${formatDuration(endedAt - block.startedAt)}`),
      tokens === undefined ? null : createElement('span', null, `· ${tokens}`),
      createElement(Chevron, { open: expanded, theme }),
    ),
    ...(expanded
      ? steps.map(step => (step.kind === 'tool'
          ? createElement(ToolStep, { key: step.key, step, theme, loadImage: props.loadImage })
          : step.kind === 'group'
            ? createElement(ToolGroup, { key: step.key, step, theme, loadImage: props.loadImage })
            : createElement(TextStep, { key: step.key, step, theme, loadImage: props.loadImage })))
      : []),
    expanded ? liveReasoning : null,
    ...answerNodes,
    liveText === undefined
      ? null
      : createElement('div', { 'data-dshell-stream': '' }, ...renderMarkdown(liveText, theme, 'stream')),
    block.notice === undefined || !failed ? null : createElement('div', {
      style: { color: FAIL_COLOR, fontSize: 12, marginTop: '4px' },
    }, block.notice.text),
  )
}

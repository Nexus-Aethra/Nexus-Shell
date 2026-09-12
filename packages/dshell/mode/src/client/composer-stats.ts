/**
 * The composer dock's session readings: turn/step counts with output speed, and
 * the token total with cache-hit share.
 *
 * This row used to belong to dsh's `ui-chat`, which registered its `StatsPills`
 * on `conversation.composer.dock`. Disabling that client row (its `chat` entry
 * would otherwise appear beside dshell's block view as a duplicate tab) took
 * the dock entry with it, so dshell re-registers the same two readings from the
 * same two sources — the `sessionStats` and `tokenUsage` projections — which
 * are served by their own packages, not by ui-chat.
 *
 * Deliberately display-only: the stock pills also open time/usage dialogs, and
 * those dialogs are ui-chat internals. Every figure a dialog would show is
 * carried in the pills' `title` instead, so the readings stay inspectable
 * without owning a portal, a measurement pass, or a second open/close state.
 */

import { createElement, memo, type ReactElement } from 'react'
import { IconDatabaseOutline16, IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Conversation SlotMap (`conversation.composer.dock`) and
// the SessionStandardProps that carry `useProjection` to a dock entry.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `sessionStats` projection merge for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
// Type-only: pulls the `tokenUsage` projection merge for useProjection.
import type {} from '@deepseek-ai/dsh-token-meter/client'

/** The dock entry's props: the session standard kit, `useProjection` included. */
export type ComposerStatsProps = PropsRuntime<'conversation.composer.dock'>

/** The row's own chrome; the dock supplies placement, not looks. */
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '2px 2px 0',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
  lineHeight: '16px',
} as const

const pillStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  whiteSpace: 'nowrap',
} as const

const iconStyle = { display: 'inline-flex', flex: '0 0 auto', opacity: 0.75 } as const

/** Compact token count: 517 / 12.2K / 1.2M — the stock pills' own scale. */
function formatTokens(value: number): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

/** Tokens per second, one decimal below ten. */
function formatSpeed(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
function formatDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${String(Math.round(seconds * 10) / 10)}s`
  const whole = Math.round(seconds)
  return `${String(Math.floor(whole / 60))}m${String(whole % 60)}s`
}

/**
 * Cache-hit share of the prompt side, floored rather than rounded.
 *
 * Flooring is the honesty rule the stock pill enforces: a partial hit must
 * never display as a full 100%, so a 99.96% hit reads as 99.9%.
 */
function cacheHitPercent(cacheReadTokens: number, billedInputTokens: number): string | null {
  if (billedInputTokens <= 0) return null
  if (cacheReadTokens >= billedInputTokens) return '100'
  const tenths = Math.floor((cacheReadTokens * 1_000) / billedInputTokens)
  return String(tenths / 10)
}

/**
 * The stats row. Renders nothing until the session has produced a step or
 * billed a token, so a fresh session's composer stays clean.
 */
export const DshellComposerStats = memo(function DshellComposerStats({
  useProjection,
}: ComposerStatsProps & { readonly useProjection: UseProjection }): ReactElement | null {
  const stats = useProjection('sessionStats')
  const usage = useProjection('tokenUsage')

  const billedInput = usage === undefined
    ? 0
    : usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const totalTokens = usage === undefined ? 0 : billedInput + usage.outputTokens
  const hasTokens = usage !== undefined && (billedInput > 0 || usage.outputTokens > 0)
  if ((stats === undefined || stats.steps === 0) && !hasTokens) return null

  const speed = stats !== undefined && stats.decodeMs > 0
    ? formatSpeed(stats.decodeTokens / (stats.decodeMs / 1_000))
    : null
  const hit = usage === undefined ? null : cacheHitPercent(usage.cacheReadTokens, billedInput)

  const timeTitle = stats === undefined
    ? undefined
    : `轮次 ${String(stats.turns)} · 步骤 ${String(stats.steps)}`
      + (stats.llmMs > 0 ? ` · 模型耗时 ${formatDuration(stats.llmMs)}` : '')
      + (stats.toolMs > 0 ? ` · 工具耗时 ${formatDuration(stats.toolMs)}` : '')
      + (stats.ttftSteps > 0 ? ` · 首字 ${formatDuration(stats.ttftMs / stats.ttftSteps)}` : '')
      + (speed === null ? '' : ` · 输出速度 ${speed} tok/s`)
  const usageTitle = usage === undefined
    ? undefined
    : `合计 ${totalTokens.toLocaleString()} tok`
      + ` · 未命中输入 ${usage.uncachedInputTokens.toLocaleString()}`
      + ` · 缓存读取 ${usage.cacheReadTokens.toLocaleString()}`
      + (usage.cacheWriteTokens === 0 ? '' : ` · 缓存写入 ${usage.cacheWriteTokens.toLocaleString()}`)
      + ` · 输出 ${usage.outputTokens.toLocaleString()}`

  return createElement('div', { style: rowStyle, 'data-composer-stats': '' },
    stats === undefined || stats.steps === 0
      ? null
      : createElement('span', { style: pillStyle, title: timeTitle },
        createElement('span', { style: iconStyle }, createElement(IconGaugeOutline16, { size: 14 })),
        createElement('span', null,
          `${String(stats.turns)} 轮 ${String(stats.steps)} 步`,
          speed === null ? '' : ` · ${speed} tok/s`,
        ),
      ),
    !hasTokens || usage === undefined
      ? null
      : createElement('span', { style: pillStyle, title: usageTitle },
        createElement('span', { style: iconStyle }, createElement(IconDatabaseOutline16, { size: 14 })),
        createElement('span', null,
          `${formatTokens(totalTokens)} tok`,
          hit === null ? '' : ` · 缓存命中 ${hit}%`,
        ),
      ),
  )
})

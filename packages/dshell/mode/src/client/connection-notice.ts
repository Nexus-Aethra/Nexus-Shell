/**
 * What a broken terminal connection looks like.
 *
 * A device session's terminal is an `ssh` process, so "cannot connect" is not
 * an exception anywhere in this program — it is a process that exits after
 * printing a line. Which of two very different situations that is, only the
 * host can tell: a shell that HAD reached a prompt and then lost its link
 * deserves a marker appended to the output the user was reading, while a shell
 * that never came up has nothing to append to and deserves a screen of its
 * own. `ready` (host-reported) is that distinction, and {@link connectionView}
 * is the single place it becomes a presentation.
 *
 * Nothing here talks to the wire: the caller passes the facts plus the two
 * actions, so the rules stay in one readable function.
 */

import { createElement, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { PtyStreamState } from '@deepseek-ai/dsh-dshell-terminal-bridge/client'
import { useDshellTheme, type Theme } from './theme.js'

/** Error red, matching the sidebar's notice colour. */
const DANGER = '#f87171'

/** What the view should draw for one session's connection state. */
export type ConnectionView =
  | { kind: 'none' }
  /**
   * The intermediate screen: a device session's terminal is being established
   * (`connecting`) or never succeeded (`failed`). Drawn over the seat, because
   * there is nothing behind it worth reading.
   */
  | { kind: 'panel'; phase: 'connecting' | 'failed' }
  /**
   * A line appended after the output: either the link is up but the shell has
   * not answered, or a working terminal's connection ended.
   */
  | { kind: 'notice'; tone: 'connecting' | 'failed' }

/** The session facts the decision needs. */
export interface ConnectionFacts {
  /** The wire state for the current session. */
  status: PtyStreamState['status']
  /** Whether this shell ever reached a prompt (host-reported). */
  ready: boolean
  /** Automatic reconnect attempts spent. */
  attempt: number
  /** Whether the session is bound to a device; local sessions never get a panel. */
  bound: boolean
}

/**
 * Turn the wire state into the one thing to draw.
 *
 * Everything here turns on one fact: whether the session is BOUND to a device.
 * A bound session's terminal is an `ssh` process — a handshake over a network
 * that takes seconds, that can stall, and that has a host on the far end worth
 * naming — so its startup is an event the user needs a screen for. A local
 * session's terminal is a fork of this very process, up in milliseconds, with
 * nothing to narrate and nobody to blame.
 *
 * The rules, in order:
 *  - a bound session that has never reached a prompt keeps the intermediate
 *    screen while it is connecting, and switches it to the failure form once
 *    the host says the shell is gone;
 *  - a bound session that HAD reached a prompt shows only the end-of-output
 *    marker, so the output the user was reading stays where it is;
 *  - a local session never gets the intermediate screen, and its first bind is
 *    not announced either — a notice flashing on every session switch is noise.
 *    A local RETRY is announced, because that only happens after something
 *    failed, and the notice is where the failure and its count stay readable.
 *
 * @param facts - the session's connection state.
 * @returns what to render.
 */
export function connectionView(facts: ConnectionFacts): ConnectionView {
  const { status, ready, attempt, bound } = facts
  if (status === 'idle') return { kind: 'none' }
  if (status === 'connecting') {
    if (bound) {
      // Never answered: this is the handshake the intermediate screen exists
      // for. Already answered once: the user was reading output, so say it at
      // the end of that output instead of covering it — and say "connecting",
      // not "exited", because a rebind of a live shell is not a death.
      return ready
        ? { kind: 'notice', tone: 'connecting' }
        : { kind: 'panel', phase: 'connecting' }
    }
    return attempt > 0 ? { kind: 'notice', tone: 'connecting' } : { kind: 'none' }
  }
  if (status === 'open') {
    // The wire is up but the shell has not answered: a device that accepts the
    // connection and then stalls — the usual shape of a half-dead host, or of
    // a ControlMaster sitting in front of a dead sshd. A local shell that has
    // not answered yet is simply still starting.
    return bound && !ready ? { kind: 'notice', tone: 'connecting' } : { kind: 'none' }
  }
  // closed | error
  if (bound && !ready) return { kind: 'panel', phase: 'failed' }
  return { kind: 'notice', tone: 'failed' }
}

/** Whole seconds since `from`, re-rendered once a second while mounted. */
function useElapsed(from: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [from])
  return Math.max(0, Math.floor((now - from) / 1000))
}

/** A button that reads as part of the terminal rather than of a dialog. */
function actionStyle(theme: Theme, primary: boolean): CSSProperties {
  return {
    fontFamily: 'inherit',
    fontSize: 12,
    lineHeight: 1.4,
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    border: `1px solid ${primary ? theme.accentBorder : theme.borderStrong}`,
    background: primary ? theme.accentFaint : 'transparent',
    color: primary ? theme.accentText : theme.muted,
  }
}

/** The diagnostic line, set apart so it reads as the machine's words. */
function detailStyle(theme: Theme): CSSProperties {
  return {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 1.5,
    color: theme.muted,
    wordBreak: 'break-all',
    borderLeft: '2px solid rgba(248, 113, 113, 0.5)',
    paddingLeft: 8,
  }
}

/** The actions a connection failure offers. */
interface ConnectionActions {
  /** Try the connection again now, on a fresh retry budget. */
  onRetry: () => void
  /**
   * Open the device settings. Returns false when the shell's settings entry
   * could not be found, in which case the component states the path in words
   * instead of leaving a button that does nothing.
   */
  onSettings?: (() => boolean) | undefined
}

/**
 * The "go to settings" button, plus the hint to show when it cannot reach the
 * panel. Hooks are unconditional: the caller always renders both slots.
 */
function useSettingsLink(
  theme: Theme,
  onSettings: (() => boolean) | undefined,
  sessionKey: string | undefined,
): { node: ReactElement | null; hint: string | undefined } {
  const [hint, setHint] = useState<string | undefined>(undefined)
  // A different session's failure is a different situation.
  useEffect(() => { setHint(undefined) }, [sessionKey])
  const node = onSettings === undefined
    ? null
    : createElement('button', {
      type: 'button',
      style: actionStyle(theme, false),
      onClick: () => {
        if (onSettings() !== true) setHint('请在「设置 → 插件 → SSH 设备」中检查该设备')
      },
    }, '去设置')
  return { node, hint }
}

/** Props of the intermediate screen. */
export interface ConnectionPanelProps extends ConnectionActions {
  /** Device display name, when the session is bound to one; undefined otherwise. */
  device: string | undefined
  /** `connecting` while the shell has not answered; `failed` once it cannot. */
  phase: 'connecting' | 'failed'
  /** Why it failed, as the host reported it. */
  reason: string | undefined
  /** The connection diagnostic found in the terminal output, if any. */
  detail: string | undefined
  /** When the current attempt started, for the elapsed counter. */
  since: number
  /** Automatic attempts spent, and the budget they come from. */
  attempt: number
  maxAttempts: number
  /** Whether the automatic retries are spent, so the failure reads as final. */
  exhausted: boolean
  /** Identifies the session, so a switch clears the settings hint. */
  sessionKey: string | undefined
}

/**
 * The intermediate screen for a device session that is not up.
 *
 * Deliberately centred and opaque: what it covers is either nothing or a
 * single ssh error line, and the user needs to know this is not a terminal yet
 * rather than read a prompt-less black area. A retry is always offered, since
 * the two ways out are "the network came back" and "the device needs fixing".
 */
export function ConnectionPanel(props: ConnectionPanelProps): ReactElement {
  const theme = useDshellTheme()
  const seconds = useElapsed(props.since)
  const settings = useSettingsLink(theme, props.onSettings, props.sessionKey)
  const failed = props.phase === 'failed'
  const address = props.device === undefined ? '设备' : props.device
  const detail = failed ? props.detail ?? props.reason : undefined
  const progress = props.attempt > 0
    ? `正在自动重连（第 ${String(props.attempt)}/${String(props.maxAttempts)} 次）…`
    : `已等待 ${String(seconds)} 秒`
  return createElement('div', {
    'data-dshell-connection-panel': props.phase,
    style: {
      position: 'absolute',
      inset: 0,
      zIndex: 3,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      background: 'rgba(6, 6, 9, 0.72)',
    },
  },
    createElement('div', {
      style: {
        width: '100%',
        maxWidth: 460,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '18px 20px',
        borderRadius: 10,
        border: `1px solid ${failed ? 'rgba(248, 113, 113, 0.45)' : theme.borderStrong}`,
        background: theme.menuBg,
        color: theme.text,
        fontSize: 13,
      },
    },
      createElement('div', {
        style: { fontSize: 14, fontWeight: 600, color: failed ? DANGER : theme.text },
      }, failed ? `⚠ 无法连接到 ${address}` : `◌ 正在连接 ${address}`),
      createElement('div', { style: { color: theme.muted, lineHeight: 1.5 } },
        failed
          ? props.exhausted
            ? `已自动重试 ${String(props.maxAttempts)} 次均未成功。`
            : '这个会话的终端没有建立起来。'
          : progress),
      detail === undefined || detail === ''
        ? null
        : createElement('div', { style: detailStyle(theme) }, detail),
      settings.hint === undefined
        ? null
        : createElement('div', { style: { fontSize: 11, color: theme.muted } }, settings.hint),
      createElement('div', { style: { display: 'flex', gap: 8, marginTop: 2 } },
        createElement('button', {
          type: 'button',
          style: actionStyle(theme, true),
          onClick: props.onRetry,
        }, '重试连接'),
        settings.node,
      ),
    ),
  )
}

/** Props of the end-of-output marker. */
export interface ConnectionNoticeProps extends ConnectionActions {
  /** `connecting` while the shell has not answered; `failed` once it ended. */
  tone: 'connecting' | 'failed'
  /** Device display name, when the session is bound to one; undefined otherwise. */
  device: string | undefined
  /** Why it ended, as the host reported it. */
  reason: string | undefined
  /** The connection diagnostic found in the terminal output, if any. */
  detail: string | undefined
  /** Automatic attempts spent, the budget, and whether it is gone. */
  attempt: number
  maxAttempts: number
  exhausted: boolean
  /** When the current attempt started, for the elapsed counter. */
  since: number
  /** Identifies the session, so a switch clears the settings hint. */
  sessionKey: string | undefined
}

/**
 * The marker drawn after the last line of a terminal whose connection ended.
 *
 * It is a live element, not output: it sits where the shell stopped and
 * disappears once the shell is back, which is the honest reading — the marker
 * describes the connection, not the session. The scrollback behind it belongs
 * to the host, so a successful reconnect continues from exactly this point.
 */
export function ConnectionNotice(props: ConnectionNoticeProps): ReactElement {
  const theme = useDshellTheme()
  const seconds = useElapsed(props.since)
  const settings = useSettingsLink(theme, props.onSettings, props.sessionKey)
  const lost = props.tone === 'failed'
  const title = lost
    ? `${props.device === undefined ? '终端已退出' : '连接已断开'}${props.reason === undefined ? '' : ` · ${props.reason}`}`
    : `◌ 正在连接${props.device === undefined ? '' : ` ${props.device}`}… ${String(seconds)} 秒`
  // Retrying is a state, not a message: while an attempt is in flight say so,
  // and once the budget is gone say that, rather than leaving "connecting" up
  // forever.
  const progress = props.attempt > 0
    ? `正在自动重连（第 ${String(props.attempt)}/${String(props.maxAttempts)} 次）…`
    : undefined
  const stopped = lost && props.exhausted
  return createElement('div', {
    'data-dshell-connection-notice': props.tone,
    style: {
      margin: '10px 0 4px',
      padding: '8px 10px',
      borderRadius: 6,
      border: `1px solid ${lost ? 'rgba(248, 113, 113, 0.35)' : theme.borderStrong}`,
      borderLeft: `2px solid ${lost ? DANGER : theme.accentBorder}`,
      background: lost ? 'rgba(248, 113, 113, 0.06)' : theme.accentFaint,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontSize: 12,
      color: theme.text,
    },
  },
    createElement('div', {
      style: { color: lost ? DANGER : theme.text, fontWeight: lost ? 500 : 400 },
    }, title),
    props.detail === undefined || props.detail === ''
      ? null
      : createElement('div', { style: detailStyle(theme) }, props.detail),
    stopped
      ? createElement('div', { style: { color: DANGER } },
        `✗ 自动重连已停止（${String(props.maxAttempts)} 次均失败）`)
      : progress === undefined
        ? null
        : createElement('div', { style: { color: theme.muted } }, progress),
    settings.hint === undefined
      ? null
      : createElement('div', { style: { fontSize: 11, color: theme.muted } }, settings.hint),
    createElement('div', { style: { display: 'flex', gap: 8 } },
      createElement('button', {
        type: 'button',
        style: actionStyle(theme, true),
        onClick: props.onRetry,
      }, props.device === undefined ? '重新打开终端' : '重试连接'),
      settings.node,
    ),
  )
}

/**
 * Shell-mode path completion for the composer, and the list that shows it.
 *
 * The composer IS dshell's input line: the terminal region in the block view is
 * a read-only mirror (`disableStdin`), so every keystroke the user aims at their
 * shell is typed here and routed to the PTY on Enter. dsh's own completion menu
 * cannot help with that text — it only fires on the `/` and `@` triggers — so
 * `cd /home/wp<Tab>` had nowhere to go and Tab simply moved focus out.
 *
 * This module is the missing half: the state the Tab interceptor in
 * `controls.ts` writes and the floating list above the composer reads, plus the
 * two route calls behind it. Completion itself belongs to the host (`complete`
 * and `resolve` in dshell-files), because the path has to be resolved in the
 * SESSION'S world — this machine for a local session, the device for a bound one
 * — and the browser cannot know which that is.
 *
 * The wire shapes are restated here rather than imported: dshell-files has no
 * `/client` namespace, and importing its root would drag host-only code
 * (`node:os`, the terminal bridge) into this bundle.
 */

import {
  createElement, useEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactElement, type RefObject,
} from 'react'
import { FileTypeIcon, classifyFileType, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the Conversation SlotMap (`conversation.input.overlay`) and
// the SessionStandardProps that hand a slot its `useInput`/`inputActions`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useDshellTheme } from './theme.js'

/** The files route, restated: dshell-files owns it (`DSHELL_FILES_PATH`). */
const FILES_PATH = '/api/dshell/files'

/** One candidate, as the route answers it. */
export interface CompletionCandidate {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'other'
  readonly size?: number | undefined
  readonly hint?: string | undefined
}

/** One open completion over the composer's draft. */
export interface CompletionState {
  readonly sessionId: string
  /** Offsets in the draft the candidates replace (the basename, not the prefix). */
  readonly start: number
  readonly end: number
  /** The directory the candidates came from, in the session's world. */
  readonly dir: string
  readonly items: readonly CompletionCandidate[]
  /** Which candidate is highlighted. */
  readonly index: number
  /** Why the list is empty, when the host had something to say about it. */
  readonly note: string | undefined
  /** The draft exactly as this completion left it, so a foreign edit closes it. */
  readonly draft: string
}

/** The smallest store the two ends need: a snapshot plus subscribers. */
class CompletionStore {
  private state: CompletionState | null = null
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): CompletionState | null => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: CompletionState | null): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/** What the interceptor and the list share. */
export interface ShellCompletion {
  readonly store: CompletionStore
  /** The directory the session's terminal stands in, once known. */
  cwdFor(sessionId: string): string | undefined
  /**
   * Ask the host what `cd <line>` did, so the next completion resolves against
   * the right directory. The shell's own directory is process state with no
   * channel back, so the line the composer routes is the source of truth.
   */
  trackCd(sessionId: string, line: string): void
  /**
   * One completion for the draft's line at the caret.
   *
   * @returns the state to show, or null when the host had nothing (no request
   *   was possible, or the token is not a path).
   */
  request(sessionId: string, line: string, cursor: number): Promise<CompletionState | null>
  /** The draft with candidate `index` substituted, and the state that follows. */
  apply(state: CompletionState, index: number, draft: string): { text: string; state: CompletionState } | undefined
}

/** One route call; the same shape the file navigator uses. */
async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(FILES_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await response.json() as Record<string, unknown>
}

/** A `cd` argument the composer can hand to the host, or undefined for none. */
export function cdTargetOf(line: string): string | undefined | null {
  const trimmed = line.trim()
  if (!/^cd(\s|$)/u.test(trimmed)) return null
  const rest = trimmed.slice(2).trim()
  if (rest.length === 0) return '~'
  // Anything with expansion or chaining is beyond "which directory did we
  // land in": leave the tracked cwd alone rather than guess wrong.
  if (/[$`(){};&|<>]/u.test(rest)) return null
  const target = rest.startsWith('-') ? undefined : rest.split(/\s/u)[0]
  if (target === undefined || target === '' || target === '-') return null
  const unquoted = target.replace(/^(['"])(.*)\1$/u, '$2')
  return unquoted
}

/** Create the shared completion state for one browser face. */
export function createShellCompletion(): ShellCompletion {
  const store = new CompletionStore()
  const cwds = new Map<string, string>()

  return {
    store,
    cwdFor: sessionId => cwds.get(sessionId),

    trackCd(sessionId, line) {
      const target = cdTargetOf(line)
      if (target === undefined || target === null) return
      void post({ action: 'resolve', sessionId, path: target, ...(cwds.get(sessionId) === undefined ? {} : { cwd: cwds.get(sessionId) as string }) })
        .then((body) => {
          const resolved = body.resolved
          if (typeof resolved === 'string' && resolved.length > 0) cwds.set(sessionId, resolved)
        })
        .catch(() => { /* the shell still moved; only our mirror is stale */ })
    },

    async request(sessionId, line, cursor) {
      const cwd = cwds.get(sessionId)
      const body = await post({
        action: 'complete',
        sessionId,
        line,
        cursor,
        ...cwd === undefined ? {} : { cwd },
      })
      const completion = body.completion
      if (completion === null || typeof completion !== 'object') return null
      const value = completion as {
        start: number
        end: number
        dir: string
        candidates: readonly CompletionCandidate[]
        note?: string
      }
      return {
        sessionId,
        start: value.start,
        end: value.end,
        dir: value.dir,
        items: value.candidates,
        index: 0,
        note: value.note,
        draft: line,
      }
    },

    apply(state, index, draft) {
      const item = state.items[index]
      if (item === undefined) return undefined
      const name = item.kind === 'directory' ? `${item.name}/` : item.name
      const text = draft.slice(0, state.start) + name + draft.slice(state.end)
      return {
        text,
        state: { ...state, index, end: state.start + name.length, draft: text },
      }
    },
  }
}

/** Design cap on the list height, clamped at runtime to the space above. */
const MAX_LIST_HEIGHT = 240

/**
 * The list's own card: the overlay layer is a zero-height absolutely
 * positioned box at the card's top edge, so entries float THEMSELVES — the
 * same `bottom: calc(100% + 4px)` the stock trigger menu uses. Flow layout
 * here would spill the list down over the composer card instead of lifting it
 * above, which is what made the first cut unreadable.
 */
function listStyle(theme: ReturnType<typeof useDshellTheme>, maxHeight: number): CSSProperties {
  return {
    position: 'absolute',
    bottom: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    zIndex: 100,
    // Border-box so the runtime clamp is the card's real height, padding and
    // border included.
    boxSizing: 'border-box',
    maxHeight,
    overflowY: 'auto',
    borderRadius: 10,
    padding: '4px 0',
    fontSize: 12,
    background: theme.menuBg,
    border: `1px solid ${theme.menuBorder}`,
    boxShadow: '0 8px 22px rgba(0,0,0,.28)',
  }
}

/** One row: name left, hint right, the highlighted row washed. */
function row(
  item: CompletionCandidate,
  active: boolean,
  theme: ReturnType<typeof useDshellTheme>,
  onPick: () => void,
  activeRef: RefObject<HTMLDivElement>,
): ReactElement {
  return createElement('div', {
    key: item.name,
    // The highlighted row is the one the list keeps in view (see the effect in
    // ShellCompletionList): a long directory would otherwise walk the selection
    // off the bottom edge with no way to see it.
    ref: active ? activeRef : null,
    'data-dshell-completion-item': item.kind,
    onMouseDown: (event: { preventDefault: () => void }) => { event.preventDefault(); onPick() },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 10px',
      cursor: 'pointer',
      background: active ? theme.accentFaint : 'transparent',
      color: active ? theme.accentText : theme.text,
    },
  },
    createElement('span', { style: { display: 'flex', alignItems: 'center', flex: '0 0 auto', opacity: 0.85 } },
      createElement(FileTypeIcon, {
        kind: item.kind === 'directory' ? 'folder' : classifyFileType(item.name),
        size: 14,
      })),
    createElement('span', {
      style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, item.kind === 'directory' ? `${item.name}/` : item.name),
    // Only files carry a hint (their size): the icon and the trailing slash
    // already say "directory", so the host's kind word would just repeat them.
    item.kind !== 'directory' && item.hint !== undefined && item.hint !== ''
      ? createElement('span', {
        style: { opacity: 0.6, flex: '0 0 auto' },
      }, item.hint)
      : null,
  )
}

/**
 * The completion list, mounted in the composer card's floating overlay — the
 * same seat dsh's own trigger menu uses, so it sits above the input line
 * without pushing the layout.
 */
export function ShellCompletionList(
  props: { readonly completion: ShellCompletion } & PropsRuntime<'conversation.input.overlay'>,
): ReactElement | null {
  const theme = useDshellTheme()
  const state = useSyncExternalStore(props.completion.store.subscribe, props.completion.store.getSnapshot)
  // The draft and its writer come from the composer's own standard kit, so the
  // list stays in step with typing it did not initiate.
  const draft = props.useInput(state2 => state2.draft)
  // Bottom-anchored, so only the top edge can collide with the viewport; the
  // clamp is dsh's own (the slash menu uses the same hook).
  const listRef = useRef<HTMLDivElement>(null)
  const maxHeight = useAnchoredMaxHeight(listRef, MAX_LIST_HEIGHT, state)
  // Keep the highlight visible. The browser never scrolls a row into view by
  // itself here — the keyboard moved the selection, not the caret — so Tab/arrow
  // walking past the bottom edge would leave the user selecting something they
  // cannot see. Same treatment the stock trigger menu gives its own list.
  const activeRef = useRef<HTMLDivElement>(null)
  const activeIndex = state?.index ?? -1
  useEffect(() => {
    if (activeIndex < 0) return
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  if (state === null) return null
  const pick = (index: number): void => {
    const next = props.completion.apply(state, index, draft)
    if (next === undefined) return
    props.inputActions.setDraft(next.text)
    props.completion.store.set(next.state)
  }
  return createElement('div', {
    ref: listRef,
    style: listStyle(theme, maxHeight),
    'data-dshell-completion': '',
    role: 'listbox',
    title: state.dir,
  },
    state.items.length === 0
      ? createElement('div', { style: { padding: '3px 10px', opacity: 0.6 } }, state.note ?? '无匹配')
      : state.items.map((item, index) => row(item, index === state.index, theme, () => { pick(index) }, activeRef)),
  )
}

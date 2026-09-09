/**
 * dshell-conversation browser face — Phase 4 (activity marker).
 *
 * The single registration here is an always-active ConversationView
 * Definition on the `terminal` target with no renderer. Its only job is
 * to count the Session as active conversation activity so the framework
 * skips the centered hero layout and engages the docked composer (the
 * terminal-style dock lives in `dshell-mode` and shadows
 * `conversation.composer.bar`). The dock itself is the visible content
 * surface — no separate view tab — keeping PTY output and the input
 * line fused in one column.
 *
 * The plugin also auto-activates `terminal` whenever a new Session
 * becomes current. The stock view-restore path falls back to `chat` when
 * no preference exists, which would put the conversation back in `hero`
 * phase; activating `terminal` first forces `active` phase immediately.
 * A subsequent `selectView('chat')` from the user (the header still
 * shows the chat tab in the view ledger for advanced use) takes
 * precedence via the stock selectView path — we only steer the default.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the sessions service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationViewBuilder,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

export const name = '@deepseek-ai/dsh-dshell-conversation/client'

export const inject = ['uiConversation', 'sessions'] as const

interface TerminalSnapshot {
  readonly rows: readonly never[]
}

class TerminalViewBuilder implements ConversationViewBuilder<never, TerminalSnapshot> {
  readonly empty: TerminalSnapshot = { rows: [] }

  replace(): TerminalSnapshot {
    return this.empty
  }

  apply(): TerminalSnapshot {
    return this.empty
  }
}

const viewDefinition: ConversationViewDefinition<never, TerminalSnapshot> = {
  target: 'terminal',
  create: () => new TerminalViewBuilder(),
  // The terminal surface IS dshell's content (design 4.1): it counts as
  // visible activity even in a blank session, so the conversation renders
  // its docked composer instead of the centered hero.
  isActive: () => true,
}

/** Register the always-active `terminal` target and auto-activate it per current session. */
export function apply(ctx: Context): void {
  // Cast through unknown: the 'sessions' key collides across faces in one
  // tsc program (host SessionStore vs client ISessions); see terminal-bridge.
  const sessions = ctx.get('sessions') as unknown as ISessions

  ctx.effect(() => ctx.uiConversation.views.register(viewDefinition))

  const activated = new Set<string>()
  ctx.effect(() => {
    const reconcile = (): void => {
      const current = sessions.list.getSnapshot().current
      if (current === undefined || activated.has(String(current))) return
      activated.add(String(current))
      try {
        ctx.uiConversation.binding(current).activate('terminal')
      } catch (error) {
        console.warn('dshell-conversation: terminal activation failed:', error)
      }
    }
    const dispose = sessions.list.subscribe(reconcile)
    reconcile()
    return dispose
  }, 'dshell-conversation: open into terminal view')
}

export default { name, inject, apply }
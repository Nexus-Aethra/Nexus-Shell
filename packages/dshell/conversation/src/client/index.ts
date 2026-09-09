/**
 * dshell-conversation browser face — Phase 1.
 *
 * Registers the `terminal` target's ConversationViewDefinition on the
 * browser-side `ctx.uiConversation` registry. The ViewBuilder returns an
 * empty rows array; Phase 4 will materialize that into one xterm.js
 * canvas with PTY bytes interleaved against session event nodes per the
 * merge rule in docs/dshell-architecture.md § 4.
 *
 * The ViewBuilder and its empty snapshot live in this file (browser
 * side) because `ctx.uiConversation` is a browser-side service — dsh
 * itself only registers ViewDefinitions in client apply functions.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationViewBuilder,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

export const name = '@deepseek-ai/dsh-dshell-conversation/client'

export const inject = ['uiConversation'] as const

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
}

export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.uiConversation.views.register(viewDefinition),
  )
}

export default { name, inject, apply }
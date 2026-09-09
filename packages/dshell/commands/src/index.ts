/**
 * dshell-commands host face — Phase 6/8 stub.
 *
 * Phase 6 registers /clear, /new, /compact on ctx.commands. Phase 8 adds
 * the dshell_get_main_terminal model-facing tool on ctx.tools.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '@deepseek-ai/dsh-dshell-commands'

export function apply(_ctx: Context): void {
  // Reserved for Phase 6 (commands) and Phase 8 (model tool).
}

export default { name, apply }
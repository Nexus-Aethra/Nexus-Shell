/**
 * dshell-mode host face — Phase 7 stub.
 *
 * Phase 5 lands the mode toggle and Enter dispatch on the browser side.
 * Phase 7 adds the host-side terminal-context injection that runs
 * immediately before agent.inject() in agent mode, reading from
 * ctx.dshellPtyBuffer maintained by dshell-terminal-bridge.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '@deepseek-ai/dsh-dshell-mode/host'

export function apply(_ctx: Context): void {
  // Reserved for Phase 7: terminal-context injection shim.
}

export default { name, apply }
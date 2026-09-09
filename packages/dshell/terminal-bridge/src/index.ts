/**
 * dshell-terminal-bridge host face — Phase 2 stub.
 *
 * Phase 2 lands the bridge-owned `main` PTY lifecycle (ensureMainShell,
 * kill-on-dispose, owner fencing). Phase 3 adds the /dshell/pty ws
 * upgrade route. Phase 7+ contributes the rolling PtyBuffer consumed by
 * dshell-mode for terminal-context injection.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '@deepseek-ai/dsh-dshell-terminal-bridge/host'

export function apply(_ctx: Context): void {
  // Reserved for Phase 2+: ctx.dshellMainPty Map, ctx.dshellPtyBuffer Map.
}

export default { name, apply }
/**
 * dshell-terminal-bridge browser face — Phase 3 stub.
 *
 * Phase 3 will open the ws client against /dshell/pty, encode frames per
 * docs/dshell-architecture.md § 4, and forward bytes to the xterm.js
 * canvas owned by dshell-conversation.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '@deepseek-ai/dsh-dshell-terminal-bridge/client'

export function apply(_ctx: Context): void {
  // Reserved for Phase 3 ws client registration.
}

export default { name, apply }
/**
 * dshell-mode browser face — Phase 5 stub.
 *
 * Phase 5 will install the per-session SessionModeStore and patch
 * inputActions to dispatch by mode and parse /agent /shell prefixes.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = '@deepseek-ai/dsh-dshell-mode/client'

export function apply(_ctx: Context): void {
  // Reserved for Phase 5 composer Enter dispatch.
}

export default { name, apply }
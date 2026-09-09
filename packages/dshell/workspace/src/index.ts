/**
 * dshell-workspace host face — design decision 4.7.
 *
 * Provides the `workspaceRegistry` Cordis key with a minimal stub so the
 * stock web-app `workspace` row can be disabled without leaving
 * session-controller's inject pending forever. The registry is not
 * simulated: `get()` always misses and `list()` is always empty, which is
 * the honest projection of a shell that has no workspaces. dshell session
 * creation never passes a workspaceId (sessions are created by cwd, design
 * 4.7), so the rejection paths below stay cold in normal operation.
 */

import { Service, type Context } from '@deepseek-ai/cordis'

export const name = '@deepseek-ai/dsh-dshell-workspace'

/** `workspaceRegistry` stand-in: every lookup misses, every mutation rejects. */
class DshellWorkspaceRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  get(): undefined {
    return undefined
  }

  list(): readonly never[] {
    return []
  }

  get archivedSessionIds(): readonly never[] {
    return []
  }

  async create(): Promise<never> {
    throw new Error('dshell: workspaces are removed (dshell design 4.7)')
  }

  async delete(): Promise<boolean> {
    return false
  }

  async insertBefore(): Promise<readonly never[]> {
    return []
  }

  async archiveSession(): Promise<void> {}

  async resolveByPath(): Promise<undefined> {
    return undefined
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(DshellWorkspaceRegistry)
}

export default { name, apply }

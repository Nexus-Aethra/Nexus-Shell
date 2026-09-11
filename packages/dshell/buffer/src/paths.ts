/**
 * Where dshell-buffer keeps its own files under the harness home.
 *
 * Kept apart from `index.ts` so the store and the service can share one
 * resolution rule without importing the plugin entry — which would be a cycle,
 * since the entry imports them.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

/** The harness home these paths live under, honouring `DSH_HOME`. */
export function harnessHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Buffer state root: one document holding links, tickets and grants. */
export function bufferRoot(): string {
  return join(harnessHome(), 'dshell', 'buffer')
}

/**
 * Whether `child` lies at or beneath `parent`, compared lexically.
 *
 * Deliberately the same rule the sandbox and the SSH mount mapping use: both
 * sides of every comparison here are already canonical (`ctx.fs.resolve`
 * returns a realpath-shaped `targetKey` on both the local and the device
 * backend), so a lexical prefix test is sound and costs nothing. It is a
 * policy check over a model-controlled path, not a kernel boundary — a symlink
 * created after the check is out of scope for every fence in this codebase.
 *
 * @param parent - absolute directory the containment is measured from.
 * @param child - absolute path to test.
 * @returns whether `child` is inside `parent`.
 */
export function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

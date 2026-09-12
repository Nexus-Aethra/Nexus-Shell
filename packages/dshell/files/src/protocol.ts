/**
 * The file navigator's wire vocabulary, shared by the host route and the
 * browser face.
 *
 * Deliberately free of value imports: the browser half imports this module, and
 * anything it pulls in would be bundled into `client.js`.
 *
 * A path on the wire is always the CANONICAL absolute path **in the session's
 * own execution world** — the host path for a local session, the device path
 * for a device-bound one. That is the string the client shows, splits into
 * segments, trims for `..`, and hands back to list again, so both ends agree on
 * one spelling without either knowing which world produced it.
 */

/** The exact `/api` path the file navigator talks to. */
export const DSHELL_FILES_PATH = '/api/dshell/files'

/** One entry's kind, in the filesystem seam's own vocabulary. */
export type DshellFileKind = 'file' | 'directory' | 'other'

/** One directory entry, with only the facts a row draws. */
export interface DshellFileEntry {
  readonly name: string
  readonly kind: DshellFileKind
  /** Byte size for a regular file, when the backend reports one. */
  readonly size?: number | undefined
}

/** One directory's listing, as the route answers it. */
export interface DshellFilesListing {
  /** Canonical absolute path of the listed directory, in the session's world. */
  readonly path: string
  readonly entries: readonly DshellFileEntry[]
  /** The listing hit the route's entry cap, so entries are missing. */
  readonly truncated: boolean
  /**
   * Whether the host can move the session's shell into a directory (`cd`).
   *
   * False when the composition has no terminal bridge, which is the only thing
   * that can drive a session's main shell; the pane then draws no jump button
   * rather than one that cannot work. It is a fact about the composition, so it
   * is the same on every listing of one boot.
   */
  readonly canCd: boolean
}

/** One browser face request. */
export interface DshellFilesRequest {
  /**
   * `list` reads a directory, `cd` sends the session's shell into one,
   * `resolve` canonicalizes a path in the session's world (how the composer
   * learns what `cd` did), and `complete` answers a shell line's last token
   * from that same world.
   */
  readonly action: 'list' | 'cd' | 'resolve' | 'complete'
  /** The session whose execution world the path belongs to. */
  readonly sessionId: string
  /** Absolute path in that world; omitted means the session's own directory. */
  readonly path?: string | undefined
  /** The directory a relative path resolves against, for `resolve`/`complete`. */
  readonly cwd?: string | undefined
  /** The composer's draft, for `complete`. */
  readonly line?: string | undefined
  /** Caret offset within `line`, for `complete`. */
  readonly cursor?: number | undefined
}

/** One candidate for the shell line's last token. */
export interface DshellCompletionCandidate {
  readonly name: string
  readonly kind: DshellFileKind
  /** Byte size for a regular file, when the backend reports one. */
  readonly size?: number | undefined
  /** A short right-hand hint (kind, size) the list draws. */
  readonly hint?: string | undefined
}

/**
 * One completion answer: the span of the line to replace, plus the candidates.
 *
 * `start`/`end` are offsets into the line the caller sent, so the composer
 * substitutes exactly the basename while everything the user typed before it
 * (including a `~` or a relative prefix) stays as written.
 */
export interface DshellCompletion {
  readonly start: number
  readonly end: number
  /** The directory the candidates came from, in the session's world. */
  readonly dir: string
  readonly candidates: readonly DshellCompletionCandidate[]
  /** The listing hit the route's cap, so candidates are missing. */
  readonly truncated: boolean
  /** Why there are no candidates, when the reason is worth showing. */
  readonly note?: string | undefined
}

/** One browser face response: whichever subject was asked for, or why none was produced. */
export interface DshellFilesResponse {
  readonly listing?: DshellFilesListing | undefined
  /** The directory the session's shell was sent to, for the `cd` action. */
  readonly cdTo?: string | undefined
  /** The canonical path, for the `resolve` action. */
  readonly resolved?: string | undefined
  /** The token's candidates, for the `complete` action. */
  readonly completion?: DshellCompletion | undefined
  readonly error?: string | undefined
}

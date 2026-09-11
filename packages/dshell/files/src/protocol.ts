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
}

/** One browser face request. */
export interface DshellFilesRequest {
  readonly action: 'list'
  /** The session whose execution world the path belongs to. */
  readonly sessionId: string
  /** Absolute path in that world; omitted lists the session's own directory. */
  readonly path?: string | undefined
}

/** One browser face response: the listing, or why there is none. */
export interface DshellFilesResponse {
  readonly listing?: DshellFilesListing | undefined
  readonly error?: string | undefined
}

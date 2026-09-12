/**
 * The file-transfer wire vocabulary: one device session's two file trees, and
 * the copies between them.
 *
 * Separate from `./protocol.ts` because it is a different route with a
 * different subject. The navigator's route answers about ONE world (the
 * session's); this one is about the pair — this machine and the device the
 * session runs on — and about work that outlives one request.
 *
 * Deliberately free of value imports: the browser face imports this module, and
 * anything it pulled in would be bundled into `client.js`. `Buffer`-style host
 * types are not needed on the browser side at all.
 */

/** The exact `/api` path the transfer view talks to. */
export const DSHELL_TRANSFER_PATH = '/api/dshell/transfer'

/**
 * Which end of the pair a request names.
 *
 * `local` is the machine the harness runs on — for a device session, the side
 * the user is sitting at. `remote` is the device that session is bound to.
 * Both spell paths in their OWN namespace: a local path is a host path, a
 * remote path is a device path.
 */
export type TransferSide = 'local' | 'remote'

/** One entry of one side, with only the facts a row draws. */
export interface TransferEntry {
  readonly name: string
  readonly kind: 'file' | 'directory' | 'other'
  /** Byte size for a regular file, when the backend reports one. */
  readonly size?: number | undefined
}

/** One directory listing of one side. */
export interface TransferListing {
  /** Canonical absolute path of the listed directory, in that side's namespace. */
  readonly path: string
  readonly entries: readonly TransferEntry[]
  /** The listing hit the route's entry cap, so entries are missing. */
  readonly truncated: boolean
}

/** What the view needs before it can draw two trees. */
export interface TransferSetup {
  /** The local pane's starting directory: the harness user's home. */
  readonly localRoot: string
  /** The device pane's starting directory, when the session is bound. */
  readonly remoteRoot?: string | undefined
  /** The device this session runs on, when it is bound. */
  readonly device?: { readonly id: string; readonly name: string } | undefined
  /**
   * Whether a transfer is possible at all.
   *
   * False for a session with no device (nothing to transfer between) and for a
   * binding without a mount directory — the filesystem seam then stays local
   * while the shell seam is remote, so the two sides would silently disagree
   * about which machine a path names.
   */
  readonly canTransfer: boolean
  /** Why not, when `canTransfer` is false. */
  readonly reason?: string | undefined
}

/** Where one copy is in its life. */
export type TransferJobState = 'walking' | 'copying' | 'done' | 'failed' | 'cancelled'

/** One copy, as the view draws it. */
export interface TransferJobView {
  readonly id: string
  readonly from: TransferSide
  readonly to: TransferSide
  /** The copied entry's own absolute path, in the source side's namespace. */
  readonly fromPath: string
  /** The destination DIRECTORY, in the destination side's namespace. */
  readonly toDir: string
  readonly state: TransferJobState
  /** Entries written so far; for a file, 0 then 1. */
  readonly files: number
  /** Known after the walk: how many entries the copy will write. */
  readonly totalFiles?: number | undefined
  /** Bytes written so far. */
  readonly bytes: number
  /** Known after the walk: how large the copy is. */
  readonly totalBytes?: number | undefined
  /** Chunked relay progress, when the current file rides it. */
  readonly chunksDone?: number | undefined
  readonly chunksTotal?: number | undefined
  /** The entry being written, relative to the copied root; empty for one file. */
  readonly current?: string | undefined
  /** Source entries that are neither files nor directories, so were not copied. */
  readonly skipped: number
  /** Why the copy stopped, or why it is waiting for a decision. */
  readonly error?: string | undefined
  /**
   * The copy stopped because an entry already exists and `overwrite` was not
   * given. The view offers to retry with it instead of showing a bare failure,
   * because a name collision is a question, not an error.
   */
  readonly conflict?: boolean | undefined
  readonly createdAt: number
  readonly settledAt?: number | undefined
}

/** One browser face request. */
export type TransferRequest =
  | { readonly action: 'state'; readonly sessionId: string }
  | { readonly action: 'list'; readonly sessionId: string; readonly side: TransferSide; readonly path: string }
  | {
    readonly action: 'copy'
    readonly sessionId: string
    readonly from: TransferSide
    /** The side the bytes land on; always the other one today, named on the wire. */
    readonly to: TransferSide
    /** The entry to copy: an absolute path in the source side's namespace. */
    readonly fromPath: string
    /** The destination directory, in the destination side's namespace. */
    readonly toDir: string
    /** Replace files that already exist; without it a collision stops the copy. */
    readonly overwrite?: boolean | undefined
  }
  | { readonly action: 'job'; readonly jobId: string }
  | { readonly action: 'cancel'; readonly jobId: string }

/** One browser face response: whichever of the three subjects was asked for. */
export interface TransferResponse {
  readonly setup?: TransferSetup | undefined
  readonly listing?: TransferListing | undefined
  readonly job?: TransferJobView | undefined
  readonly error?: string | undefined
}

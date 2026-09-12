/**
 * Every dshell wire contract: the `/api/dshell/*` paths and the shapes that
 * cross them.
 *
 * Layering rule for this file, and for this package as a whole: it declares
 * FACTS, not behaviour. No imports, no dsh packages, no runtime state — so both
 * halves of every plugin (host route and browser face) can import the same
 * declaration, and a contract change is a compile error on both sides instead of
 * a silent drift. The browser faces used to restate these shapes by hand
 * precisely because there was nowhere shared to put them.
 *
 * Sections below were moved verbatim from the packages' own protocol modules,
 * which now re-export from here; the package-local headers are kept because they
 * carry the reasoning for each shape.
 */

// ─── files — the file navigator: listing, completion, their requests/responses ───
// moved from packages/dshell/files/src/protocol.ts

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

// ─── files — the two-world transfer view ───
// moved from packages/dshell/files/src/transfer-protocol.ts

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

// ─── buffer — the cross-session pipe: links, tickets, grants, transfers ───
// moved from packages/dshell/buffer/src/protocol.ts

/**
 * The buffer's wire vocabulary, shared by the host route and the browser face.
 *
 * Deliberately free of value imports: the browser half imports this module, and
 * anything it pulls in would be bundled into `client.js`. Identifiers that the
 * host validates against (a request `action`, a ticket `state`) are plain
 * strings here and narrowed on the host side.
 *
 * Session ids travel as plain strings rather than the branded `SessionId`
 * because this is a JSON boundary; the host converts at the edges.
 */

/** The exact `/api` path the pipe UI talks to. */
export const DSHELL_BUFFER_PATH = '/api/dshell/buffer'

/** The plugin name every buffer-authored message carries as its provenance. */
export const BUFFER_PLUGIN = 'dshell-buffer'

/** Lifecycle of one deferred request. */
export type BufferTicketState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'cancelled'

/** States after which a ticket is settled and never changes again. */
export const SETTLED_STATES: readonly BufferTicketState[] = ['done', 'failed', 'timeout', 'cancelled']

/** One directory the grant may confer on an area. */
export type BufferRight = 'read' | 'write'

/**
 * One directory (or file) the grant confers on an area, with the rights it
 * holds there.
 *
 * `as` is the area's name in the grantee's buffer namespace: the grantee
 * addresses everything under it as `/name/sub/file` instead of by the
 * granter's real path. One segment, no separators — it is a mount name, not a
 * path. The service ASSIGNS it at creation (the caller's `as`, else the path's
 * last segment, suffixed to stay unique among the names that session already
 * holds), and it is the only handle the two sessions exchange. It is optional
 * in the type alone: state written before names existed has none until the
 * service names it at load.
 */
export interface BufferArea {
  /** Absolute path in the GRANTER's namespace, or one relative to its cwd. */
  readonly path: string
  readonly rights: readonly BufferRight[]
  /** The area's name in the grantee's buffer namespace. */
  readonly as?: string | undefined
}

/**
 * A durable link between two sessions, established by the user.
 *
 * Undirected: the user connects two sessions, and either may then delegate to
 * the other. Direction belongs to the ticket and to the grant, not to the link
 * — a "pipe" is a relationship, not a one-way channel.
 */
export interface BufferLink {
  readonly id: string
  /** The two connected sessions, ordered as the user created them. */
  readonly a: string
  readonly b: string
  readonly label?: string | undefined
  readonly createdAt: number
}

/** One progress report a worker filed against a ticket. */
export interface BufferReport {
  readonly time: number
  readonly text: string
  readonly kind: 'progress' | 'blocked'
}

/**
 * One deferred request from one session to another.
 *
 * The lifecycle fields are mutable by design: the service is the single writer,
 * and a ticket is a state machine advanced in place before it is persisted.
 */
export interface BufferTicket {
  readonly id: string
  readonly linkId: string
  /** The requesting session. */
  readonly from: string
  /** The working session. */
  readonly to: string
  readonly subject: string
  readonly detail?: string | undefined
  state: BufferTicketState
  /** Grants this ticket holds open; each is released when it settles. */
  readonly grantIds: readonly string[]
  readonly createdAt: number
  startedAt?: number | undefined
  settledAt?: number | undefined
  /** When the watchdog settles the ticket as `timeout`, if nothing else did. */
  readonly deadlineAt: number
  result?: string | undefined
  error?: string | undefined
  readonly reports: BufferReport[]
}

/** A scoped, revocable folder grant, alive while at least one ticket references it. */
export interface BufferGrant {
  readonly id: string
  /** The granting session — the tree these areas live in. */
  readonly from: string
  /** The session allowed to touch them. */
  readonly to: string
  /** The granter's own account of what the areas are for. */
  readonly description: string
  readonly areas: readonly BufferArea[]
  /** Outstanding tickets; reaching zero revokes the grant immediately. */
  count: number
  readonly createdAt: number
  revokedAt?: number | undefined
}

/**
 * One cross-world chunked transfer, in flight or freshly finished.
 *
 * In-memory only: it exists so progress surfaces (the status card) can show
 * live movement, and entries drop shortly after they settle. Nothing here is
 * durable state — a restart simply loses the progress view, never the data.
 */
export interface BufferTransfer {
  readonly id: string
  /** The session whose tool call drives the transfer. */
  readonly sessionId: string
  /** Human label: source path → destination path. */
  readonly label: string
  readonly bytesDone: number
  readonly bytesTotal: number
  readonly chunksDone: number
  readonly chunksTotal: number
  readonly startedAt: number
  readonly finishedAt?: number | undefined
  readonly error?: string | undefined
}

/** Everything the pipe UI renders from. */
export interface BufferState {
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  readonly grants: readonly BufferGrant[]
  /** Transfers in flight, plus the freshly settled ones (pruned after a beat). */
  readonly transfers: readonly BufferTransfer[]
}

/**
 * One row of the pipe detail page's buffer browser.
 *
 * A ROOT entry (one per mapped area) carries the grant it belongs to and its
 * provenance, so the user can see which side offered it and descend into it;
 * entries below the root are plain directory children.
 */
export interface BufferUserEntry {
  /** Last segment for children; the mapped name (`as`) for a root. */
  readonly name: string
  readonly kind: 'directory' | 'file' | 'other'
  readonly size?: number | undefined
  /** Root entries only: the grant this mapping belongs to. */
  readonly grantId?: string
  /** Root entries only: the mapped name and its rights. */
  readonly as?: string
  readonly rights?: readonly string[]
  /** Root entries only: the two ends of the grant (granter → grantee). */
  readonly from?: string
  readonly to?: string
  /** Root entries only: the real path behind the mapping, in the granter's world. */
  readonly origin?: string
}

/** One answer to a `buffer-ls` request. */
export interface BufferListing {
  /** The real path listed (root listings answer `/`). */
  readonly path: string
  readonly entries: readonly BufferUserEntry[]
  readonly truncated: boolean
}

/** One browser face request. `state` also travels as the GET shape. */
export type BufferRequest =
  | { readonly action: 'state' }
  | { readonly action: 'link'; readonly a: string; readonly b: string; readonly label?: string }
  | { readonly action: 'unlink'; readonly linkId: string }
  | { readonly action: 'revoke'; readonly grantId: string }
  | { readonly action: 'cancel'; readonly ticketId: string }
  | { readonly action: 'buffer-ls'; readonly linkId: string; readonly grantId?: string; readonly path?: string }

/** One browser face response: the committed state plus an optional refusal. */
export interface BufferResponse extends BufferState {
  readonly error?: string | undefined
  /** Present only on a `buffer-ls` request. */
  readonly listing?: BufferListing | undefined
}

// ─── ssh — devices, bindings, their requests/responses ───
// moved from packages/dshell/ssh/src/protocol.ts

/**
 * dshell-ssh wire — one exact `/api/dshell/ssh` route, plus the device shapes
 * both halves agree on.
 *
 * The route carries what must not travel through the settings document: the
 * private keys themselves. A device's durable record is small JSON; its key is
 * a separate file written 0600 under `$DSH_HOME/dshell/ssh/keys/`.
 *
 * This module is imported by the browser half through the package's
 * `./protocol` subpath, so it must stay free of value imports: anything it
 * pulls in would be bundled into the client.
 */

/** Exact `/api` route path owned by the SSH device registry. */
export const DSHELL_SSH_PATH = '/api/dshell/ssh'

/** Settings namespace owned by this plugin; also the device card's slot key. */
export const SSH_SETTINGS_NAMESPACE = 'dshell-ssh'

/** How a device authenticates. */
export type DeviceAuth = 'key' | 'password'

/** One configured device as the UI sees it — never includes secret material. */
export interface DeviceView {
  readonly id: string
  /** Display name the session picker lists. */
  readonly name: string
  /** Hostname or IP `ssh` connects to. */
  readonly host: string
  /** TCP port; 22 unless the device listens elsewhere. */
  readonly port: number
  /** Login user. */
  readonly user: string
  /** Directory a session bound to this device starts in (the remote path). */
  readonly remoteRoot: string
  /** Selected login method. */
  readonly auth: DeviceAuth
  /** Whether the secret for {@link auth} (key or password) is stored. */
  readonly hasSecret: boolean
}

/** One device as submitted by the UI; `key` is write-only. */
export interface DeviceInput {
  readonly id?: string | undefined
  readonly name: string
  readonly host: string
  readonly port?: number | undefined
  readonly user: string
  readonly remoteRoot?: string | undefined
  /** Login method; defaults to `key` on create. */
  readonly auth?: DeviceAuth | undefined
  /**
   * PEM/OpenSSH private key contents, used when `auth` is `key`. Omitted keeps
   * the stored secret; empty string removes it (the device then relies on the
   * harness user's own ssh agent and config).
   */
  readonly key?: string | undefined
  /**
   * Password, used when `auth` is `password`. Same omitted/empty semantics as
   * {@link key}.
   */
  readonly password?: string | undefined
}

/** One session's device binding, kept host-side because execution routing needs it. */
export interface DeviceBinding {
  readonly sessionId: string
  readonly deviceId: string
  /**
   * Directory the session's commands run in on that device, when the session
   * overrides the device's own. Absent means the device's `remoteRoot`.
   */
  readonly remoteRoot?: string | undefined
  /**
   * Local directory standing in for that remote tree, which is also the
   * session's own working directory. Absent on bindings written before
   * mount directories existed.
   */
  readonly mount?: string | undefined
}

/** One request body the route accepts; `list` is also the GET shape. */
export type SshRequest =
  | { readonly action: 'list' }
  | { readonly action: 'save'; readonly device: DeviceInput }
  | { readonly action: 'delete'; readonly deviceId: string }
  | {
    readonly action: 'test'
    readonly deviceId: string
    /**
     * Session directory to also prove creatable, so a failing `mkdir` is found
     * before a session is created rather than after. Absent checks only the
     * connection.
     */
    readonly remoteRoot?: string | null
  }
  | {
    readonly action: 'bind'
    readonly sessionId: string
    readonly deviceId: string | null
    /** Remote directory for this session; null or absent uses the device's. */
    readonly remoteRoot?: string | null
    /** Local mount directory for that tree, as returned by `mount`. */
    readonly mount?: string | null
  }
  | {
    /**
     * The local mount directory for one device tree. The rule is host-owned
     * (it depends on `$DSH_HOME`), so the browser asks rather than deriving it.
     */
    readonly action: 'mount'
    readonly deviceId: string
    readonly remoteRoot?: string | null
  }

/** One response body; `error` is a refusal the UI shows verbatim. */
export interface SshResponse {
  readonly devices: readonly DeviceView[]
  readonly bindings: readonly DeviceBinding[]
  /** Human-readable result of the last `test`, when one was requested. */
  readonly testResult?: string | undefined
  /** Local mount directory, answering the `mount` action. */
  readonly mountPath?: string | undefined
  readonly error?: string | undefined
}

// ─── workspace — the session archive routes ───
// moved from packages/dshell/workspace/src/protocol.ts

/**
 * dshell session-panel wire — design 4.7 follow-up.
 *
 * The sidebar's session rows need two things dsh does not offer: an archive
 * tag that hides a session without touching its log, and a history purge.
 * Both are dshell concepts, so they travel over dshell's own exact route on
 * the shared `/api` channel rather than through the Typert Remote table
 * (whose client artifacts are generated from dsh's own packages).
 *
 * The path sits below the shared channel exactly like file-upload's: the
 * physical carrier applies dsh's trust and authentication policy before the
 * handler ever runs, so the route itself does no authorization.
 *
 * Shared by both halves of the package, so the constant and the shapes live
 * in one file that neither the host nor the client bundle owns.
 */

/** Exact `/api` route path owned by the dshell session panel. */
export const DSHELL_SESSIONS_PATH = '/api/dshell/sessions'

/** One request body the route accepts; `list` is also the GET shape. */
export type SessionRequest =
  | { readonly action: 'list' }
  | { readonly action: 'archive'; readonly sessionId: string }
  | { readonly action: 'unarchive'; readonly sessionId: string }
  | { readonly action: 'delete'; readonly sessionId: string }

/**
 * One response body. `archived` rides on every response — the tag set after
 * the request, so one round trip leaves the caller's snapshot current.
 * `error` is a refusal the sidebar shows verbatim; it is not a transport
 * failure, so the response still carries a 2xx status.
 */
export interface SessionResponse {
  readonly archived: readonly string[]
  /**
   * Archived ids whose log is scheduled for removal at the next start (the
   * session was still loaded in this process, so its writer would have
   * recreated the directory). Always a subset of `archived`.
   */
  readonly pendingPurge?: readonly string[]
  readonly error?: string
}

// ─── terminal-bridge — the shell's history read ───
// moved from packages/dshell/terminal-bridge/src/route.ts

export const DSHELL_PTY_PATH = '/api/dshell/pty'

export interface DshellPtyRequest {
  readonly action: 'history'
  /** The session whose shell history to read. */
  readonly sessionId: string
  /** Newest-commands cap; omitted means the bridge's own retention cap. */
  readonly limit?: number | undefined
}

/** One command the shell ran, as the composer lists it. */
export interface DshellPtyCommand {
  /** The assembled command line. */
  readonly command: string
  /** Bash's exit status, or null when the marker carried none. */
  readonly exitCode: number | null
  /** Epoch ms the command finished. */
  readonly at: number
}

/** One answer: the commands, oldest first (the order they ran in). */
export interface DshellPtyResponse {
  readonly commands?: readonly DshellPtyCommand[] | undefined
  readonly error?: string | undefined
}


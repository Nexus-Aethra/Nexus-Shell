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

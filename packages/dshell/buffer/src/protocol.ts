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

/** One right a grant may confer on an area. */
export type BufferRight = 'read' | 'write'

/** One directory the grantee may touch, with the rights it holds there. */
export interface BufferArea {
  /** Absolute path in the GRANTER's namespace, or one relative to its cwd. */
  readonly path: string
  readonly rights: readonly BufferRight[]
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

/** Everything the pipe UI renders from. */
export interface BufferState {
  readonly links: readonly BufferLink[]
  readonly tickets: readonly BufferTicket[]
  readonly grants: readonly BufferGrant[]
}

/** One browser face request. `state` also travels as the GET shape. */
export type BufferRequest =
  | { readonly action: 'state' }
  | { readonly action: 'link'; readonly a: string; readonly b: string; readonly label?: string }
  | { readonly action: 'unlink'; readonly linkId: string }
  | { readonly action: 'revoke'; readonly grantId: string }
  | { readonly action: 'cancel'; readonly ticketId: string }

/** One browser face response: the committed state plus an optional refusal. */
export interface BufferResponse extends BufferState {
  readonly error?: string | undefined
}

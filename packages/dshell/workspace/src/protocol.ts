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

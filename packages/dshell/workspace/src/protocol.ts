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

// Moved to the shared standard layer: these are wire contracts, not this
// package's, and both halves of every plugin read the same declaration there.
// Re-exported so existing importers keep one import site per package.
export { DSHELL_SESSIONS_PATH } from '@deepseek-ai/dsh-dshell-std'
export type { SessionRequest, SessionResponse } from '@deepseek-ai/dsh-dshell-std'

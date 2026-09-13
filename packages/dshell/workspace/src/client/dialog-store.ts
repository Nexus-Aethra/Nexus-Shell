/**
 * New-session dialog signal. The `uiWorkspace.startSession` stand-in is
 * called by dsh's sidebar chrome button, which cannot render dshell UI — this
 * store bridges that service call to the dialog living inside the flat list.
 * Module-level on purpose: one browser window owns one shell (design § 2).
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export const newSessionDialog = createSnapshotStore(false)

/**
 * The browser half's one call: list a directory in a session's execution world.
 *
 * Not a client Service: nothing else in the composition reads a listing, so a
 * module-level call behind the tab's inject face is the whole interface.
 */

import { DSHELL_FILES_PATH, type DshellFilesRequest, type DshellFilesResponse } from '../protocol.js'
import type { DshellFilesListing } from '../protocol.js'

/** Either a listing, or the reason there is none. */
export type DshellFilesListOutcome =
  | { readonly ok: true; readonly listing: DshellFilesListing }
  | { readonly ok: false; readonly message: string }

/** List one directory of one session's world. */
export type ListDirectory = (
  sessionId: string,
  path: string,
  signal: AbortSignal,
) => Promise<DshellFilesListOutcome>

/** Build the listing call the tab's face performs. */
export function createListDirectory(): ListDirectory {
  return async (sessionId, path, signal): Promise<DshellFilesListOutcome> => {
    const request: DshellFilesRequest = { action: 'list', sessionId, path }
    try {
      const response = await fetch(DSHELL_FILES_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      })
      const body = await response.json() as DshellFilesResponse
      if (body.listing === undefined) return { ok: false, message: body.error ?? '文件列表没有返回内容' }
      return { ok: true, listing: body.listing }
    } catch (error) {
      // An abort is the tab going away, not a directory that failed; the face
      // drops the outcome either way, and this keeps the message honest.
      if (signal.aborted) return { ok: false, message: '已取消' }
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}

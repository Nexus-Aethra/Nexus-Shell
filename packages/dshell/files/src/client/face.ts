/**
 * The navigator's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `load` / `toggle` /
 * `navigate` / `back` / `forward` / `reload`, and this face performs the listing
 * and writes the outcome through the store's own actions — the Slot-standard
 * `inject` shape, so the session id is resolved by the framework and the write
 * set stays the store's.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten.
 */

import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { ListDirectory } from './client.js'
import type { createDshellFilesStore } from './store.js'

/** The navigator's injected business face, as the body receives it. */
export interface FilesInjected {
  /**
   * Open this tab on a directory, with nothing listed yet.
   * @param tabId - the tab being drawn.
   * @param home - the session's directory, where the tab opens.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, home: string, signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path in the session's world.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, listing it the first time it opens.
   * @param loaded - whether this level already has state.
   */
  readonly toggle: (tabId: TabId, path: string, loaded: boolean, signal: AbortSignal) => void
  /** Stand this tab on a directory, recording it in history. */
  readonly navigate: (tabId: TabId, path: string) => void
  /** Step one entry back in history. */
  readonly back: (tabId: TabId) => void
  /** Step one entry forward in history. */
  readonly forward: (tabId: TabId) => void
  /**
   * Drop every cached level and list the directory the tab stands on again.
   * @param path - the tab's current directory.
   */
  readonly reload: (tabId: TabId, path: string, signal: AbortSignal) => void
}

/**
 * Bind the navigator's face to one directory listing.
 * @param list - the bound listing call.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function createFilesFace(
  list: ListDirectory,
): (sessionId: string, actions: BoundActions<ReturnType<typeof createDshellFilesStore>>) => FilesInjected {
  return (
    sessionId: string,
    actions: BoundActions<ReturnType<typeof createDshellFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match. */
    const generations = new Map<TabId, Map<string, number>>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = (tabId: TabId, path: string, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      void list(sessionId, path, signal).then((outcome) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (generations.get(tabId)?.get(path) !== generation) return
        if (signal.aborted) return
        if (outcome.ok) actions.loaded(tabId, path, outcome.listing)
        else actions.failed(tabId, path, outcome.message)
      })
    }
    return {
      start(tabId, home, signal) {
        actions.seed(tabId, home)
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
      },
      load,
      toggle(tabId, path, loaded, signal) {
        actions.toggled(tabId, path)
        if (!loaded) load(tabId, path, signal)
      },
      navigate(tabId, path) {
        actions.navigated(tabId, path)
      },
      back(tabId) {
        actions.back(tabId)
      },
      forward(tabId) {
        actions.forward(tabId)
      },
      reload(tabId, path, signal) {
        actions.reset(tabId)
        load(tabId, path, signal)
      },
    }
  }
}

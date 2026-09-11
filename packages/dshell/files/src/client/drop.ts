/**
 * Dragging a directory out of the pane and dropping it on the terminal.
 *
 * The gesture starts here and ends in another package's DOM — the terminal view
 * the block view mounts — so this listens on the document and decides by where
 * the pointer landed, rather than asking the terminal to know about the pane.
 * The marker it looks for, `data-dshell-terminal-view`, is the block view's own
 * seat: the whole content area the terminal surface fills.
 *
 * A drop there lands the session's shell in the dragged directory, the same
 * thing the jump button does, through the same call. While the pointer is over
 * that area the whole area is outlined — a gesture with no feedback cannot be
 * told apart from one that is not supported — and `dragover` is defaulted so
 * the browser offers a drop at all.
 *
 * The drop itself is defaulted away as well. The terminal's own input element
 * is a real textarea, and a dropped payload of type `text/plain` would be
 * typed into the shell; carrying the path under a private type instead of
 * `text/plain` means no other drop target — the composer, a text field, the
 * terminal's textarea — can receive so much as a stray path.
 */

/** The private drag type that carries one directory's absolute path. */
export const DIRECTORY_DRAG_TYPE = 'application/x-dshell-directory'

/** The block view's seat: the area a drop counts as "on the terminal". */
const TERMINAL_VIEW = '[data-dshell-terminal-view]'

/** The area a drop must land on, from the event's own target. */
function terminalViewAt(event: DragEvent): HTMLElement | undefined {
  const target = event.target
  if (!(target instanceof Element)) return undefined
  return target.closest<HTMLElement>(TERMINAL_VIEW) ?? undefined
}

/**
 * Start dragging one directory.
 *
 * Must run inside `dragstart`, and synchronously: a drag with no data set does
 * not start at all.
 * @param transfer - the drag's data channel.
 * @param path - absolute directory path in the session's world.
 */
export function startDirectoryDrag(transfer: DataTransfer | null, path: string): void {
  if (transfer === null) return
  transfer.setData(DIRECTORY_DRAG_TYPE, path)
  transfer.effectAllowed = 'link'
}

/**
 * Watch for a directory dropped on the terminal, until the returned disposer.
 * @param land - called with the dropped directory's absolute path.
 * @returns the disposer, for the effect that installed it.
 */
export function installDirectoryDrop(land: (path: string) => void): () => void {
  /** The area currently outlined, so the outline can be put back. */
  let outlined: HTMLElement | undefined
  const unoutline = (): void => {
    if (outlined === undefined) return
    outlined.style.outline = ''
    outlined.style.outlineOffset = ''
    outlined = undefined
  }
  const onDragOver = (event: DragEvent): void => {
    // Another drag (a file from outside, text from another app) is not ours.
    if (event.dataTransfer?.types.includes(DIRECTORY_DRAG_TYPE) !== true) return
    const view = terminalViewAt(event)
    if (view === undefined) {
      unoutline()
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'link'
    if (view === outlined) return
    unoutline()
    view.style.outline = '2px dashed rgba(127,127,127,.65)'
    view.style.outlineOffset = '-2px'
    outlined = view
  }
  const onDrop = (event: DragEvent): void => {
    const view = terminalViewAt(event)
    const path = event.dataTransfer?.getData(DIRECTORY_DRAG_TYPE) ?? ''
    unoutline()
    if (view === undefined || path.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    land(path)
  }
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDrop, true)
  document.addEventListener('dragend', unoutline, true)
  return () => {
    unoutline()
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('drop', onDrop, true)
    document.removeEventListener('dragend', unoutline, true)
  }
}

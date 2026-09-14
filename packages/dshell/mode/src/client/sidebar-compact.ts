/**
 * Hide dsh's sidebar section labels in the compact rail.
 *
 * dsh's sidebar narrows to a compact rail when collapsed; the rail keeps
 * showing the section headings as small rotated text, which crowds the icons
 * and adds nothing the user could act on. This module injects one stylesheet
 * and a small DOM walker that marks the offending labels with
 * `data-dshell-rail-label`, and the stylesheet hides them in the collapsed
 * state. Expanded, the labels return to their normal width and position.
 *
 * The CSS-module class names are build-dependent, so the stylesheet targets
 * the data attribute this module adds. The DOM walker no longer matches the
 * headings' *text* — dshell-workspace renders those through its own locale
 * dictionary, so an English switch changed `会话 (6)`/`已归档` into
 * `Sessions (6)`/`Archived` and the old matcher stopped firing. It instead
 * anchors on the stable `data-dshell-row` attributes dshell-workspace already
 * emits for the group headers (`archive-header`, `pending-header`; the latter
 * was never covered by the old text list, so `待删除` showed in the rail) and,
 * for the main `Sessions (N)` header — which carries no attribute — on the
 * list's structural shape: it is the plain sibling immediately above the
 * element that holds the `data-dshell-row` rows.
 */

const STYLE_ID = 'dshell-sidebar-compact-css'
/**
 * Marker added to the elements that should disappear in the rail. The
 * selector `[class*="_root"][class*="_collapsed"]` scopes the rule to
 * the collapsed sidebar; the data attribute picks the right elements
 * inside it.
 */
const LABEL_ATTR = 'data-dshell-rail-label'

/** The row marker dshell-workspace puts on every session-list row/header. */
const ROW_ATTR = 'data-dshell-row'

/** The row markers of the two section headers. Locale-independent by construction. */
const GROUP_HEADER_ROWS = ['archive-header', 'pending-header'] as const

/**
 * The element that directly holds the `data-dshell-row` rows.
 *
 * The session rows are direct children of it; the archive/pending group
 * headers are one level deeper (inside their own group wrapper). Any of the
 * three is enough to recover the same container, so the walk still works when
 * a group is empty or every session has been archived.
 */
function rowsContainer(root: ParentNode): Element | null {
  const session = root.querySelector(`[${ROW_ATTR}="session"]`)
  if (session !== null) return session.parentElement
  const archive = root.querySelector(`[${ROW_ATTR}="archive-header"]`)
  if (archive !== null) return archive.parentElement?.parentElement ?? null
  const pending = root.querySelector(`[${ROW_ATTR}="pending-header"]`)
  return pending?.parentElement?.parentElement ?? null
}

/**
 * Walk the AppFrame's sidebar and mark the label elements. Safe to call
 * repeatedly: every call clears previous markers before reapplying, so
 * the sidebar can be re-rendered (a session switch, a layout toggle)
 * without leaving stale attributes behind.
 */
function markRailLabels(): void {
  if (typeof document === 'undefined') return
  const root = document.querySelector<HTMLElement>('[class*="_root"]')
  if (root === null) return
  // First, clear previous markers.
  for (const old of document.querySelectorAll(`[${LABEL_ATTR}]`)) {
    old.removeAttribute(LABEL_ATTR)
  }
  // Then mark the section headers by their stable row marker.
  for (const name of GROUP_HEADER_ROWS) {
    for (const el of root.querySelectorAll(`[${ROW_ATTR}="${name}"]`)) {
      el.setAttribute(LABEL_ATTR, '')
    }
  }
  // The main `Sessions (N)` header has no row marker of its own; it is the
  // plain sibling immediately above the rows container.
  const header = rowsContainer(root)?.previousElementSibling
  if (header != null && !header.hasAttribute(ROW_ATTR)) {
    header.setAttribute(LABEL_ATTR, '')
  }
}

/**
 * Inject the rule and run the marker once. The stylesheet only acts on
 * marked elements inside the collapsed sidebar; the DOM walker finds the
 * actual labels. A `MutationObserver` re-runs the walker on relevant
 * layout changes so the markers stay in sync.
 */
export function injectSidebarCompactCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
[class*="_root"][class*="_collapsed"] [${LABEL_ATTR}] {
  display: none !important;
}
`.trim()
    document.head.append(style)
  }
  // Run the marker at least once for the current DOM. The observer below
  // keeps it accurate on every layout mutation.
  markRailLabels()
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => { markRailLabels() })
    observer.observe(document.body, { childList: true, subtree: true })
  }
}

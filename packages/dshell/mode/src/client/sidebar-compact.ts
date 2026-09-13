/**
 * Hide dsh's sidebar section labels in the compact rail.
 *
 * dsh's sidebar narrows to a compact rail when collapsed; the rail keeps
 * showing the section headings ("会话 (6)", "已归档") as small rotated
 * text, which crowds the icons and adds nothing the user could act on.
 * This module injects one stylesheet and a small DOM walker that marks
 * the offending labels with `data-dshell-rail-label`, and the stylesheet
 * hides them in the collapsed state. Expanded, the labels return to
 * their normal width and position.
 *
 * The CSS-module class names are build-dependent, so the stylesheet
 * targets the data attribute this module adds. The DOM walker uses text
 * content to find the labels — there are no stable class names to hook
 * otherwise.
 */

const STYLE_ID = 'dshell-sidebar-compact-css'
/**
 * Marker added to the elements that should disappear in the rail. The
 * selector `[class*="_root"][class*="_collapsed"]` scopes the rule to
 * the collapsed sidebar; the data attribute picks the right elements
 * inside it.
 */
const LABEL_ATTR = 'data-dshell-rail-label'

/**
 * Section labels that should disappear in the compact rail. The "新会话"
 * button keeps its plus icon in the rail, so its text is the actionable
 * affordance and is left alone.
 */
const LABEL_TEXTS = ['会话 (', '已归档'] as const

/**
 * Walk the AppFrame's sidebar and mark the label spans. Safe to call
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
  // Then mark the matches. The label strings are exact prefixes or
  // equality matches against the element's own text content — a label
  // span carries the text directly, with no nested element splitting it.
  const candidates = Array.from(root.querySelectorAll('span, button, div'))
  for (const el of candidates) {
    const text = (el.textContent ?? '').trim()
    if (text === '') continue
    for (const target of LABEL_TEXTS) {
      if (text === target || text.startsWith(target)) {
        el.setAttribute(LABEL_ATTR, '')
        break
      }
    }
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

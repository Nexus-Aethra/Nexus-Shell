/**
 * dshell-files browser face: the movable file browser, registered as the
 * implementation of the right Sidebar's `files` tab kind.
 *
 * Registration is dsh's public two-stage path, unmodified: the TYPE into
 * `ctx.sidebarRightTabs`, the body into the keyed `sidebar.right.pane.tab` seat
 * and the chip title into `sidebar.right.pane.tab.title`, both under this
 * definition's own `id` — which is the id the seat dispatches once this
 * `extension` type takes the kind from the shipped `builtin` one.
 *
 * The file split is this package's layering: what the type IS (`definition.ts`),
 * what it keeps (`store.ts`), how it lists (`client.ts`, `face.ts`), how it
 * names a file (`address.ts`), what it draws (`body.ts`, `title.ts`,
 * `styles.ts`), what it says (`locales.ts`), and this module, which only wires
 * them together.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the tab registry service (ctx.sidebarRightTabs) and the slot keys.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: pulls the locale service (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createListDirectory } from './client.js'
import { dshellFilesDefinition, DSHELL_FILES_ID } from './definition.js'
import { DshellFilesBody } from './body.js'
import { createFilesFace } from './face.js'
import { en, zh } from './locales.js'
import { createDshellFilesStore } from './store.js'
import { DshellFilesTitle } from './title.js'

export const name = '@deepseek-ai/dsh-dshell-files/client'

/** Required browser services: the tab registry, the keyed seat, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs'] as const

/** This package's copy namespace. */
const NS = 'dshellFiles'

export type { DshellFilesKey } from './locales.js'
export type { DirectoryLevel, FilesState, FilesTabState, LevelState } from './store.js'

/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, and the locale service.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(dshellFilesDefinition(t)), 'dshell-files: files type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-files: dictionaries')

  const store = createDshellFilesStore()
  const injectFace = createFilesFace(createListDirectory())
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: DSHELL_FILES_ID, locale: NS, store, inject: injectFace },
    DshellFilesBody,
  )), 'dshell-files: files tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: DSHELL_FILES_ID },
    DshellFilesTitle,
  )), 'dshell-files: files tab title')
}

export default { name, inject, apply }

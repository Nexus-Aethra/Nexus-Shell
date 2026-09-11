/**
 * dshell-files browser face: the movable file browser — registered as the
 * implementation of the right Sidebar's `files` tab kind — and the two-pane
 * file transfer, registered beside it as a page type of this package's own.
 *
 * Registration is dsh's public two-stage path, unmodified: the TYPE into
 * `ctx.sidebarRightTabs`, the body into the keyed `sidebar.right.pane.tab` seat
 * and the chip title into `sidebar.right.pane.tab.title`, both under this
 * definition's own `id` — which is the id the seat dispatches once this
 * `extension` type takes the `files` kind from the shipped `builtin` one.
 *
 * The two tabs share ONE store handle, which is what makes them one subject
 * rather than two: the framework mints one instance per handle per session, so
 * the browser's tree and the transfer's pair of trees live side by side and
 * neither can hold a stale idea of which session it belongs to.
 *
 * The file split is this package's layering: what a type IS (`definition.ts`,
 * `transfer-definition.ts`), what it keeps (`store.ts`), how it lists
 * (`client.ts`, `face.ts`, `transfer-client.ts`, `transfer-face.ts`), how it
 * names a file (`address.ts`) and a drag (`drag.ts`, `transfer-drag.ts`), what
 * it draws (`body.ts`, `transfer-body.ts`, `title.ts`, `transfer-title.ts`,
 * `styles.ts`, `transfer-styles.ts`, `transfer-glyph.ts`), what it says
 * (`locales.ts`), and this module, which only wires them together.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the tab registry service (ctx.sidebarRightTabs) and the slot keys.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: pulls the locale service (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createListDirectory, createMoveShell } from './client.js'
import { dshellFilesDefinition, DSHELL_FILES_ID } from './definition.js'
import { DshellFilesBody } from './body.js'
import { createFilesFace, type TransferAvailability } from './face.js'
import { en, zh } from './locales.js'
import { createDshellFilesStore } from './store.js'
import { DshellFilesTitle } from './title.js'
import { createTransferApi } from './transfer-client.js'
import { dshellTransferDefinition, DSHELL_TRANSFER_ID, TRANSFER_KIND } from './transfer-definition.js'
import { DshellTransferBody } from './transfer-body.js'
import { createTransferFace } from './transfer-face.js'
import { DshellTransferTitle } from './transfer-title.js'

export const name = '@deepseek-ai/dsh-dshell-files/client'

/** Required browser services: the tab registry, the keyed seat, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs'] as const

/** This package's copy namespace. */
const NS = 'dshellFiles'

/**
 * The slice of dshell-ssh's browser service the transfer button asks about.
 *
 * Structural on purpose, exactly as the host half reads that package's router:
 * this package must not depend on the SSH bundle, and a composition without it
 * simply has no device session, so the button never appears.
 */
interface DeviceBindingSeat {
  bindingOf(sessionId: string): { readonly mount?: string | undefined } | undefined
}

export type { DshellFilesKey } from './locales.js'
export type { DirectoryLevel, FilesState, FilesTabState, LevelState, TransferTabState, TreeState } from './store.js'

/**
 * Client plugin body: register both types, their dictionaries, bodies, and chip
 * titles.
 * @param ctx - client root context carrying the registry, the slots, and the locale service.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(dshellFilesDefinition(t)), 'dshell-files: files type')
  ctx.effect(() => ctx.sidebarRightTabs.register(dshellTransferDefinition(t)), 'dshell-files: transfer type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshell-files: dictionaries')

  // One handle, two tab types: the framework mints one instance per session, so
  // both tabs read and write the same state.
  const store = createDshellFilesStore()
  const availability: TransferAvailability = {
    registered: () => ctx.sidebarRightTabs.get(TRANSFER_KIND) !== undefined,
    deviceSession: (sessionId) => {
      const binding = (ctx.get('dshellSsh') as DeviceBindingSeat | undefined)?.bindingOf(sessionId)
      // A binding without a mount routes only the shell, so its file operations
      // stay local — a transfer would then silently mix the two machines.
      return binding !== undefined && binding.mount !== undefined && binding.mount.length > 0
    },
  }
  const filesFace = createFilesFace(createListDirectory(), createMoveShell(), availability)
  const transferFace = createTransferFace(createTransferApi())

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: DSHELL_FILES_ID, locale: NS, store, inject: filesFace },
    DshellFilesBody,
  )), 'dshell-files: files tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: DSHELL_FILES_ID },
    DshellFilesTitle,
  )), 'dshell-files: files tab title')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: DSHELL_TRANSFER_ID, locale: NS, store, inject: transferFace },
    DshellTransferBody,
  )), 'dshell-files: transfer tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: DSHELL_TRANSFER_ID },
    DshellTransferTitle,
  )), 'dshell-files: transfer tab title')
}

export default { name, inject, apply }

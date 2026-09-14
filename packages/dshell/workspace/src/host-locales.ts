/**
 * `dshellWorkspace`'s HOST dictionaries — the copy this package's route
 * composes that a reader sees.
 *
 * A route refusal travels back to the sidebar, which renders it verbatim, so
 * its language has to match the screen even though the host is the one writing
 * it. `ctx.dshellHostCopy` answers which language that is (see the std
 * contract); these dictionaries are what it binds.
 *
 * The browser face keeps its own dictionaries in `client/locales.ts`: the two
 * sets are disjoint by construction — this one is text the host authors, that
 * one is text the browser authors — and only this file is reachable from the
 * host half.
 */

import type { HostCopyDictionaries } from '@nexus-aethra/dshell-std'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'error.running': '会话正在运行，等它结束后再删除',
  'error.unknownAction': '未知操作',
} satisfies Record<string, string>

/** Host dictionary key union. */
export type DshellWorkspaceHostKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'error.running': 'That session is still running — delete it once it finishes',
  'error.unknownAction': 'Unknown action',
} satisfies Record<DshellWorkspaceHostKey, string>

/** The pair `ctx.dshellHostCopy.bind()` takes. */
export const hostCopy: HostCopyDictionaries<DshellWorkspaceHostKey> = { zh, en }

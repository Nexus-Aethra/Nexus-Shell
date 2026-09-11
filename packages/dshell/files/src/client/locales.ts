/**
 * `dshellFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'dshellFiles'>` or `PropsLocale<'dshellFiles'>` needs only this
 * file, whichever entry a program loads first.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-navigator type name, guide entry, row states, and failure lines. */
    dshellFiles: DshellFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '文件',
  'guide.title': '可移动的文件浏览器',
  'guide.description': '在本机或设备上前后移动地浏览文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作目录。',
  reload: '重新读取',
  back: '后退',
  forward: '前进',
  parent: '双击进入上一级',
  root: '跳到根目录',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.unavailable': '读取失败：{message}',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type DshellFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Files',
  'guide.title': 'Movable file browser',
  'guide.description': 'Move back and forth through files on this machine or a device',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no working directory.',
  reload: 'Reload',
  back: 'Back',
  forward: 'Forward',
  parent: 'Double-click to go up one level',
  root: 'Jump to the root',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.unavailable': 'Read failed: {message}',
} satisfies Record<DshellFilesKey, string>

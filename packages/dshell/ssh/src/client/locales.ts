/**
 * `dshellSsh` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'dshellSsh'>` or `PropsLocale<'dshellSsh'>` needs only this
 * file, whichever entry a program loads first.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** SSH device card: title, header summaries, rows, actions, and add/edit form. */
    dshellSsh: DshellSshKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'card.title': 'SSH 设备',
  'card.empty': '添加远程设备，开新会话时可以直接选择它',
  'card.summary': '{count} 台设备 · {names}',
  'card.nameSeparator': '、',
  'auth.key': '密钥',
  'auth.password': '密码',
  'device.login': '{method}登录',
  'device.noSecret': '（未存凭据）',
  'device.test': '测试',
  'device.testTooltip': '测试连接',
  'device.edit': '编辑',
  'device.remove': '删除',
  'form.namePlaceholder': '名称，例如 构建机',
  'form.hostPlaceholder': 'host 或 IP',
  'form.portPlaceholder': '端口 22',
  'form.userPlaceholder': '用户名',
  'form.remoteRootPlaceholder': '远端工作目录，例如 /srv/app',
  'form.remoteRootNote': '留空的目录表示登录目录；会话绑定该设备后，命令默认在这个目录下执行。',
  'form.authLabel': '登录方式',
  'form.passwordPlaceholder': '登录密码（可留空以使用本机 ssh agent / ~/.ssh/config）',
  'form.keyPlaceholder': '私钥内容（OpenSSH 格式，可留空以使用本机 ssh agent / ~/.ssh/config）',
  'form.passwordNote': '密码写入 $DSH_HOME/dshell/ssh/keys/<设备>.password（0600），连接时通过 OpenSSH 的 askpass 钩子交给 ssh，不出现在命令行里。',
  'form.keyNote': '私钥写入 $DSH_HOME/dshell/ssh/keys/ 并设为 0600；编辑时留空表示不改动已存的凭据。',
  'form.submitAdd': '添加设备',
  'form.submitSave': '保存修改',
} satisfies Record<string, string>

/** SSH card dictionary key union. */
export type DshellSshKey = keyof typeof zh

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'card.title': 'SSH devices',
  'card.empty': 'Add a remote device to pick directly when starting a new session',
  'card.summary': '{count} devices · {names}',
  'card.nameSeparator': ', ',
  'auth.key': 'Key',
  'auth.password': 'Password',
  'device.login': '{method} login',
  'device.noSecret': ' (no credential stored)',
  'device.test': 'Test',
  'device.testTooltip': 'Test connection',
  'device.edit': 'Edit',
  'device.remove': 'Delete',
  'form.namePlaceholder': 'Name, e.g. build machine',
  'form.hostPlaceholder': 'host or IP',
  'form.portPlaceholder': 'Port 22',
  'form.userPlaceholder': 'Username',
  'form.remoteRootPlaceholder': 'Remote working directory, e.g. /srv/app',
  'form.remoteRootNote': 'An empty directory means the login directory; once a session is bound to the device, commands run there by default.',
  'form.authLabel': 'Login method',
  'form.passwordPlaceholder': 'Login password (leave empty to use the local ssh agent / ~/.ssh/config)',
  'form.keyPlaceholder': 'Private key contents (OpenSSH format; leave empty to use the local ssh agent / ~/.ssh/config)',
  'form.passwordNote': 'The password is written to $DSH_HOME/dshell/ssh/keys/<device>.password (0600) and handed to ssh at connection time through the OpenSSH askpass hook, never on the command line.',
  'form.keyNote': 'The private key is written to $DSH_HOME/dshell/ssh/keys/ and set to 0600; leaving it empty while editing keeps the stored credential unchanged.',
  'form.submitAdd': 'Add device',
  'form.submitSave': 'Save changes',
} satisfies Record<DshellSshKey, string>

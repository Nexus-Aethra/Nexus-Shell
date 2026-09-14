/**
 * `dshellSsh`'s HOST dictionaries — the copy this package's host half composes
 * that a reader sees.
 *
 * These are the messages the host writes for a browser that cannot see its own
 * language: route refusals, device errors, the connection test's result line,
 * the reason a spawn failed, and the errors a remote command surfaces. The
 * browser face keeps its own dictionaries in `client/locales.ts`; the two sets
 * are disjoint, and only this file is reachable from the host half.
 *
 * `ctx.dshellHostCopy` answers which language to write (see the std contract);
 * `hostCopy` below is the pair it binds.
 */

import type { HostCopyDictionaries, HostCopyParams } from '@nexus-aethra/dshell-std'

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'error.unknownAction': '未知操作',
  'error.unknownDevice': '未知设备：{id}',
  'error.hostUserRequired': 'host 与 user 不能为空',
  'error.remoteSignal': '远端命令被信号中断（{signal}）',
  'error.remoteFailed': '远端命令失败（退出码 {code}）',
  'mount.createFailed': '无法在设备上创建 {root}',
  'mount.unbound': '该会话没有绑定设备，但它的目录是设备挂载目录（{cwd}）：'
    + '在这里本机执行只会落在一个空目录里，因此已拒绝。'
    + '请检查该设备是否已被删除；若设备仍在，请在会话里重试连接或新建会话。',
  'test.connected': '已连接 {user}@{host}（{system}） · {ms}ms',
  'test.unknownSystem': '未知系统',
  'test.exitCode': 'ssh 退出码 {code}',
  'test.hostKeyFirst': '主机密钥 {fingerprint}（首次信任，请与服务器管理员核对）',
  'test.hostKeyTrusted': '主机密钥 {fingerprint}（已信任）',
  'shell.missingRemoteDir': 'dshell: 远端目录 {root} 不存在，已回到登录目录',
} satisfies Record<string, string>

/** Host dictionary key union. */
export type DshellSshHostKey = keyof typeof zh

/** A translator bound to this package's host dictionaries. */
export type DshellSshTranslate = (key: DshellSshHostKey, params?: HostCopyParams) => string

/** English dictionary, checked complete against the Chinese key set. */
export const en = {
  'error.unknownAction': 'Unknown action',
  'error.unknownDevice': 'Unknown device: {id}',
  'error.hostUserRequired': 'Host and user are required',
  'error.remoteSignal': 'Remote command interrupted by signal ({signal})',
  'error.remoteFailed': 'Remote command failed (exit code {code})',
  'mount.createFailed': 'Could not create {root} on the device',
  'mount.unbound': 'This session is not bound to a device, but its directory is a device mount directory ({cwd}): '
    + 'running locally here would only land in an empty directory, so it was refused. '
    + 'Check whether the device was deleted; if it still exists, retry the connection in the session or start a new session.',
  'test.connected': 'Connected {user}@{host} ({system}) · {ms}ms',
  'test.unknownSystem': 'unknown system',
  'test.exitCode': 'ssh exit code {code}',
  'test.hostKeyFirst': 'Host key {fingerprint} (first contact; verify it with the server administrator)',
  'test.hostKeyTrusted': 'Host key {fingerprint} (already trusted)',
  'shell.missingRemoteDir': 'dshell: remote directory {root} does not exist; falling back to the login directory',
} satisfies Record<DshellSshHostKey, string>

/** The pair `ctx.dshellHostCopy.bind()` takes. */
export const hostCopy: HostCopyDictionaries<DshellSshHostKey> = { zh, en }

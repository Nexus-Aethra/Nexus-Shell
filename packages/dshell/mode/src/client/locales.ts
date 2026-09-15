/**
 * `dshellMode` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'dshellMode'>` or `PropsLocale<'dshellMode'>` needs only this
 * file, whichever entry a program loads first.
 *
 * Keys are lowercase and dotted, grouped by the surface they belong to:
 * `mode.*` (the `/shell` · `/agent` menu and its switch notices), `composer.*`
 * (the mode chip and its legend), `status.*` (the floating status card),
 * `settings.*` (the Plugins settings card), `theme.*` (palette names),
 * `agent.*` (the task card's fold header and body), `notice.*` (the closing
 * notice), `duration.*`/`row.*`/`tool.*`/`bookmark.*`/`completion.*`, and
 * `connection.*` (the connection panel and end-of-output marker).
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { DshellCompletionNote } from '@nexus-aethra/dshell-std'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Mode chip, composer legend, status card, settings card, blocks, and connection copy. */
    dshellMode: DshellModeKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  // The `/` menu rows and the switch feedback. `{name}` is the typed alias.
  'mode.menu.shell': '切换到 shell 模式：Enter 直接执行命令',
  'mode.menu.agent': '切换到 agent 模式：Enter 发送给 AI',
  'mode.switch.hint': '切换模式',
  'mode.switch.shell': '已切换到 shell 模式 · Enter 直接执行命令',
  'mode.switch.agent': '已切换到 agent 模式 · Enter 发送给 AI',
  'mode.attachmentsUnsupported': '/{name} 不支持附件',
  // The `conversation.view` tab, beside dsh's own Trajectory tab.
  'view.tab': '会话',

  // The composer chip and its legend. The chip names the mode identifier, which
  // stays canonical; only its displayed label comes from here.
  'composer.mode.shell': 'shell',
  'composer.mode.agent': 'agent',
  'composer.legend.idle': '直接输入',
  'composer.legend.tab': 'Tab 补全',
  'composer.legend.history': '↑ 历史',
  'composer.legend.ctrlC': 'Ctrl+C 中断',
  'composer.legend.acceptWord': '→ 采纳一个词',
  'composer.legend.continueHint': '继续 → 补完',
  'composer.legend.completionOpen': 'Tab 下一个 · ↑↓ 选择 · Enter 填入 · Esc 关闭',
  'composer.legend.attachments': '有附件：Enter 发送给 AI · 附件已转对话',
  'composer.legend.agent': 'Enter 发送对话 · /agent 切终端',

  // The settings card.
  'settings.title': '终端与输入辅助',
  'settings.group.theme': '终端配色',
  'settings.group.helpers': '输入辅助',
  'settings.note.theme': '主终端（画布、块视图与命令行）的调色板 · 选择立即生效，并保存到主机设置（同一主机所有浏览器共用）。',
  'settings.note.helpers': '关闭后对应按键回到浏览器的默认行为（Tab 移动焦点、↑ 移动光标、→ 移动光标）· 设置保存在主机，同一主机所有浏览器共用。',
  'settings.summary': '配色：{theme} · 输入辅助：{helpers}',
  'settings.helpers.allOn': '全部开启',
  'settings.helpers.off': '已关闭 {list}',
  'settings.helpers.joiner': '、',
  'settings.helper.tabCompletion.label': 'Tab 补全',
  'settings.helper.tabCompletion.detail': 'Tab 列出路径候选，大小写不敏感；唯一候选直接补全并纠正大小写',
  'settings.helper.historyList.label': '历史列表',
  'settings.helper.historyList.detail': '↑ 打开本会话的历史命令，↑↓ 选择、Enter 填入',
  'settings.helper.commandHint.label': '智能提示',
  'settings.helper.commandHint.detail': '按最近命令在光标后显示虚影，→ 逐词采纳',

  // Palette names. The ids (`midnight`, `solarized`, `dracula`, `forest`) are
  // identifiers and never translated.
  'theme.midnight': '午夜',
  'theme.solarized': '柔和',
  'theme.dracula': '神秘',
  'theme.forest': '森林',

  // The status card: the collapsed headline, then every row.
  'status.idle': '空闲',
  'status.working': 'AI 正在工作',
  'status.waiting': '等待 {peer} 回信',
  'status.owed': '{count} 个管道任务待处理',
  'status.terminalRunning': 'AI 终端运行中',
  'status.agentsRunning': '{count} 个智能体运行中',
  'status.transferring': '传输中 {pct}%',
  'status.jobsRunning': '{count} 个后台任务运行中',
  'status.terminalEnded': 'AI 终端已结束',
  'status.linkBroken': '终端连接中断',
  'status.plan': '计划',
  'status.terminal': 'AI 终端',
  'status.ended': '已结束',
  'status.off': '未开启',
  'status.runningReadonly': '运行中 · 只读',
  'status.starting': '启动中…',
  'status.openTerminal': '为 AI 开启一个终端',
  'status.reopen': '重新开启',
  'status.startingShell': '正在启动它自己的 shell…',
  'status.switchToSession': '切换到会话后可用。',
  'status.agents': '智能体',
  'status.loading': '读取中…',
  'status.agents.count': '{count} 个',
  'status.agents.running': ' · {count} 运行中',
  'status.noAgents': '还没有派生子智能体。',
  'status.jobs': '后台任务',
  'status.jobs.live': '{count} 个运行中',
  'status.jobs.count': '{count} 个',
  'status.transfers': '缓冲区传输',
  'status.transfers.live': '{count} 个传输中 · {pct}%',
  'status.transfers.done': '刚刚完成',
  'status.failed': '失败',
  'status.breakpoint': '中断点',
  'status.breakpoint.more': ' · {count} 个',
  'status.breakpoint.detail': '已把活交给别的会话并结束本轮，对方回信后会自动唤醒。',
  'status.breakpoint.to': '→ {peer}：{subject}',
  'status.reports': '{count} 条进展',
  'status.withdraw': '撤回',
  'status.pipe': '管道任务',
  'status.pipe.value': '{count} 个待处理 · {peer}',
  'status.pipe.from': '← {peer}：{subject}',
  'status.openPipePanel': '打开管道面板',
  'status.link': '连接',
  'status.disconnected': '已断开',
  'status.connecting': '连接中…',
  'status.reconnect': '重新连接',
  // Background-job statuses.
  'status.job.running': '运行中',
  'status.job.stopping': '停止中',
  'status.job.completed': '已完成',
  'status.job.killed': '已终止',
  'status.job.failed': '失败',
  // Pipe-ticket states.
  'status.ticket.queued': '待领取',
  'status.ticket.running': '对方处理中',
  'status.ticket.done': '已完成',
  'status.ticket.failed': '失败',
  'status.ticket.timeout': '已超时',
  'status.ticket.cancelled': '已撤回',
  // How long a job has run, in at most two units.
  'duration.seconds': '{seconds} 秒',
  'duration.minutesSeconds': '{minutes} 分 {seconds} 秒',
  'duration.hoursMinutes': '{hours} 时 {minutes} 分',
  // How long a pipe ticket has left before the watchdog settles it.
  'status.remaining.expired': '已到期限',
  'status.remaining.minutes': '剩 {minutes} 分钟',
  'status.remaining.seconds': '剩 {seconds} 秒',

  // The agent task card.
  'tool.terminal': '终端',
  'tool.read': '读取',
  'tool.write': '写入',
  'tool.edit': '编辑',
  'tool.search': '搜索',
  'row.user': '你',
  // A message sent into a turn that was already running, drawn inside the card
  // it steered: the reader has to be able to tell it from the request that
  // opened that card.
  'row.steering': '插话',
  'row.assistant': 'AI',
  'row.reasoning': '思考过程',
  'row.call': '调用',
  'row.tool': '工具',
  'row.command': '⚡ 命令',
  'agent.output.moreLines': '… 还有 {count} 行',
  'agent.group.commands': ' 个命令',
  'agent.reasoning.duration': '· 持续了 {duration}',
  'agent.running': '深度求索中 · {duration}',
  'agent.interrupted': '已中断 · {duration}',
  'agent.worked': '已工作 {duration}',
  'agent.attachmentAlt': '附件图片',
  // The agent card's own long duration form (`1 小时 2 分`).
  'agent.duration.seconds': '{seconds} 秒',
  'agent.duration.minutesSeconds': '{minutes} 分 {seconds} 秒',
  'agent.duration.hoursMinutes': '{hours} 小时 {minutes} 分',

  // The one-line closing notice (stored on the fold; rendered with the block).
  'notice.steps': '{count} 步',
  'notice.done': '✓ AI 回答完成 · {facts}',
  'notice.aborted': '◼ AI 回答已中断 · {at}',
  'notice.failed': '✗ AI 回答出错 · {detail} · {at}',
  'notice.maxTokens': '达到输出上限',

  // Row-model fallbacks and the ANSI row renderer's fold hints.
  'row.expandMore': '+{count} 行 ▸ 点击展开',
  'row.expand': '点击展开',
  'row.collapse': '▾ 点击收起',
  'row.command.failed': '失败:{text}',
  'row.command.done': '完成',

  // The composer dock's stats pills.
  'stats.turnsSteps': '{turns} 轮 {steps} 步',
  'stats.speed': ' · {speed} tok/s',
  'stats.tokens': '{tokens} tok',
  'stats.cacheHit': ' · 缓存命中 {hit}%',
  'stats.title.time': '轮次 {turns} · 步骤 {steps}',
  'stats.title.llm': ' · 模型耗时 {duration}',
  'stats.title.tools': ' · 工具耗时 {duration}',
  'stats.title.ttft': ' · 首字 {duration}',
  'stats.title.speed': ' · 输出速度 {speed} tok/s',
  'stats.title.usage': '合计 {total} tok · 未命中输入 {uncached} · 缓存读取 {cached}',
  'stats.title.cacheWrite': ' · 缓存写入 {written}',
  'stats.title.output': ' · 输出 {output}',

  // Shell completion: the path side (a file or a directory in the session's
  // world) and the command side (a name the world's shell can run). The four
  // empty answers arrive from the host as CODES (`DshellCompletionNote`) rather
  // than sentences, because the host knows the reason and this file owns the
  // language.
  'completion.historyCount': '{count} 条历史命令',
  'completion.noMatch': '无匹配',
  'completion.noDirectory': '目录不存在',
  'completion.notDirectory': '不是目录',
  'completion.noCommand': '本会话的世界里没有以这个前缀开头的命令',
  'completion.command': '命令',

  // The bookmark rail.
  'bookmark.empty': '(空消息)',

  // A broken connection.
  'connection.settingsHint': '请在「设置 → 插件 → SSH 设备」中检查该设备',
  'connection.goSettings': '去设置',
  'connection.device': '设备',
  'connection.reconnecting': '正在自动重连（第 {attempt}/{max} 次）…',
  'connection.waited': '已等待 {seconds} 秒',
  'connection.panel.failed': '⚠ 无法连接到 {address}',
  'connection.panel.connecting': '◌ 正在连接 {address}',
  'connection.retriesFailed': '已自动重试 {max} 次均未成功。',
  'connection.notEstablished': '这个会话的终端没有建立起来。',
  'connection.retry': '重试连接',
  'connection.notice.terminalExited': '终端已退出',
  'connection.notice.disconnected': '连接已断开',
  'connection.notice.connecting': '◌ 正在连接{device}… {seconds} 秒',
  'connection.reconnectStopped': '✗ 自动重连已停止（{max} 次均失败）',
  'connection.reopenTerminal': '重新打开终端',
} satisfies Record<string, string>

/** Mode dictionary key union. */
export type DshellModeKey = keyof typeof zh

/**
 * The key each empty-completion reason is written with.
 *
 * The host answers with a reason code (`DshellCompletionNote`) so the line the
 * reader sees is chosen here, where the language is known. Typed as a total
 * map, so a reason added to the wire cannot be silently rendered as "no
 * matches".
 */
export const NOTE_KEYS: Record<DshellCompletionNote, DshellModeKey> = {
  noMatch: 'completion.noMatch',
  noDirectory: 'completion.noDirectory',
  notDirectory: 'completion.notDirectory',
  noCommand: 'completion.noCommand',
}

/** English dictionary, checked exactly against the Chinese key set. */
export const en = {
  'mode.menu.shell': 'Switch to shell mode: Enter runs the command directly',
  'mode.menu.agent': 'Switch to agent mode: Enter sends to the AI',
  'mode.switch.hint': 'Switch mode',
  'mode.switch.shell': 'Switched to shell mode · Enter runs the command directly',
  'mode.switch.agent': 'Switched to agent mode · Enter sends to the AI',
  'mode.attachmentsUnsupported': '/{name} does not support attachments',
  'view.tab': 'Conversation',

  'composer.mode.shell': 'shell',
  'composer.mode.agent': 'agent',
  'composer.legend.idle': 'Type directly',
  'composer.legend.tab': 'Tab completes',
  'composer.legend.history': '↑ history',
  'composer.legend.ctrlC': 'Ctrl+C interrupts',
  'composer.legend.acceptWord': '→ accepts a word',
  'composer.legend.continueHint': 'keep → to finish',
  'composer.legend.completionOpen': 'Tab next · ↑↓ select · Enter insert · Esc close',
  'composer.legend.attachments': 'Attachment: Enter sends to the AI · attachment moved to the conversation',
  'composer.legend.agent': 'Enter sends the conversation · /agent for the terminal',

  'settings.title': 'Terminal and input assists',
  'settings.group.theme': 'Terminal palette',
  'settings.group.helpers': 'Input assists',
  'settings.note.theme': 'Palette for the main terminal (canvas, block view, and command line). A pick takes effect immediately and is saved to the host settings (shared by every browser on this host).',
  'settings.note.helpers': 'When off, the key returns to the browser default (Tab moves focus, ↑ moves the caret, → moves the caret). Settings are saved on the host and shared by every browser on this host.',
  'settings.summary': 'Palette: {theme} · Input assists: {helpers}',
  'settings.helpers.allOn': 'All on',
  'settings.helpers.off': 'Off: {list}',
  'settings.helpers.joiner': ', ',
  'settings.helper.tabCompletion.label': 'Tab completion',
  'settings.helper.tabCompletion.detail': 'Tab lists path candidates, case-insensitively; a single candidate completes directly and fixes its case',
  'settings.helper.historyList.label': 'History list',
  'settings.helper.historyList.detail': '↑ opens this session\'s command history; ↑↓ selects, Enter inserts',
  'settings.helper.commandHint.label': 'Smart hints',
  'settings.helper.commandHint.detail': 'Shows a ghost of a recent command after the caret; → accepts it word by word',

  'theme.midnight': 'Midnight',
  'theme.solarized': 'Solarized',
  'theme.dracula': 'Dracula',
  'theme.forest': 'Forest',

  'status.idle': 'Idle',
  'status.working': 'AI is working',
  'status.waiting': 'Waiting for {peer} to reply',
  'status.owed': '{count} pipe tasks pending',
  'status.terminalRunning': 'AI terminal running',
  'status.agentsRunning': '{count} agents running',
  'status.transferring': 'Transferring {pct}%',
  'status.jobsRunning': '{count} background jobs running',
  'status.terminalEnded': 'AI terminal ended',
  'status.linkBroken': 'Terminal connection lost',
  'status.plan': 'Plan',
  'status.terminal': 'AI terminal',
  'status.ended': 'Ended',
  'status.off': 'Off',
  'status.runningReadonly': 'Running · read-only',
  'status.starting': 'Starting…',
  'status.openTerminal': 'Open a terminal for the AI',
  'status.reopen': 'Reopen',
  'status.startingShell': 'Starting its own shell…',
  'status.switchToSession': 'Available after switching to the session.',
  'status.agents': 'Agents',
  'status.loading': 'Reading…',
  'status.agents.count': '{count} agents',
  'status.agents.running': ' · {count} running',
  'status.noAgents': 'No subagents yet.',
  'status.jobs': 'Background jobs',
  'status.jobs.live': '{count} running',
  'status.jobs.count': '{count} jobs',
  'status.transfers': 'Buffer transfers',
  'status.transfers.live': '{count} transferring · {pct}%',
  'status.transfers.done': 'Just finished',
  'status.failed': 'Failed',
  'status.breakpoint': 'Breakpoint',
  'status.breakpoint.more': ' · {count} more',
  'status.breakpoint.detail': 'Handed the work to another session and ended this turn; it wakes automatically when the reply arrives.',
  'status.breakpoint.to': '→ {peer}: {subject}',
  'status.reports': '{count} updates',
  'status.withdraw': 'Withdraw',
  'status.pipe': 'Pipe tasks',
  'status.pipe.value': '{count} pending · {peer}',
  'status.pipe.from': '← {peer}: {subject}',
  'status.openPipePanel': 'Open pipe panel',
  'status.link': 'Connection',
  'status.disconnected': 'Disconnected',
  'status.connecting': 'Connecting…',
  'status.reconnect': 'Reconnect',
  'status.job.running': 'Running',
  'status.job.stopping': 'Stopping',
  'status.job.completed': 'Completed',
  'status.job.killed': 'Terminated',
  'status.job.failed': 'Failed',
  'status.ticket.queued': 'Queued',
  'status.ticket.running': 'Peer working',
  'status.ticket.done': 'Done',
  'status.ticket.failed': 'Failed',
  'status.ticket.timeout': 'Timed out',
  'status.ticket.cancelled': 'Withdrawn',
  'duration.seconds': '{seconds}s',
  'duration.minutesSeconds': '{minutes}m {seconds}s',
  'duration.hoursMinutes': '{hours}h {minutes}m',
  'status.remaining.expired': 'Deadline reached',
  'status.remaining.minutes': '{minutes} min left',
  'status.remaining.seconds': '{seconds}s left',

  'tool.terminal': 'Terminal',
  'tool.read': 'Read',
  'tool.write': 'Write',
  'tool.edit': 'Edit',
  'tool.search': 'Search',
  'row.user': 'You',
  'row.steering': 'Interjection',
  'row.assistant': 'AI',
  'row.reasoning': 'Thinking',
  'row.call': 'Call',
  'row.tool': 'Tool',
  'row.command': '⚡ Command',
  'agent.output.moreLines': '… {count} more lines',
  'agent.group.commands': ' commands',
  'agent.reasoning.duration': '· lasted {duration}',
  'agent.running': 'DeepSeeking · {duration}',
  'agent.interrupted': 'Interrupted · {duration}',
  'agent.worked': 'Worked {duration}',
  'agent.attachmentAlt': 'Attached image',
  'agent.duration.seconds': '{seconds}s',
  'agent.duration.minutesSeconds': '{minutes}m {seconds}s',
  'agent.duration.hoursMinutes': '{hours}h {minutes}m',

  'notice.steps': '{count} steps',
  'notice.done': '✓ AI answer complete · {facts}',
  'notice.aborted': '◼ AI answer interrupted · {at}',
  'notice.failed': '✗ AI answer failed · {detail} · {at}',
  'notice.maxTokens': 'Output limit reached',

  'row.expandMore': '+{count} lines ▸ click to expand',
  'row.expand': 'Click to expand',
  'row.collapse': '▾ click to collapse',
  'row.command.failed': 'Failed:{text}',
  'row.command.done': 'Done',

  'stats.turnsSteps': '{turns} turns {steps} steps',
  'stats.speed': ' · {speed} tok/s',
  'stats.tokens': '{tokens} tok',
  'stats.cacheHit': ' · cache hit {hit}%',
  'stats.title.time': 'Turns {turns} · Steps {steps}',
  'stats.title.llm': ' · model {duration}',
  'stats.title.tools': ' · tools {duration}',
  'stats.title.ttft': ' · first token {duration}',
  'stats.title.speed': ' · output speed {speed} tok/s',
  'stats.title.usage': 'Total {total} tok · uncached input {uncached} · cache read {cached}',
  'stats.title.cacheWrite': ' · cache write {written}',
  'stats.title.output': ' · output {output}',

  'completion.historyCount': '{count} command history entries',
  'completion.noMatch': 'No matches',
  'completion.noDirectory': 'No such directory',
  'completion.notDirectory': 'Not a directory',
  'completion.noCommand': 'No command in this session\'s world starts with that',
  'completion.command': 'command',

  'bookmark.empty': '(empty message)',

  'connection.settingsHint': 'Check this device under "Settings → Plugins → SSH devices"',
  'connection.goSettings': 'Settings',
  'connection.device': 'the device',
  'connection.reconnecting': 'Reconnecting automatically ({attempt}/{max})…',
  'connection.waited': 'Waited {seconds}s',
  'connection.panel.failed': '⚠ Cannot connect to {address}',
  'connection.panel.connecting': '◌ Connecting to {address}',
  'connection.retriesFailed': 'Automatic retry failed {max} times.',
  'connection.notEstablished': 'The terminal for this session could not be established.',
  'connection.retry': 'Retry connection',
  'connection.notice.terminalExited': 'Terminal exited',
  'connection.notice.disconnected': 'Connection lost',
  'connection.notice.connecting': '◌ Connecting{device}… {seconds}s',
  'connection.reconnectStopped': '✗ Auto-reconnect stopped ({max} failed)',
  'connection.reopenTerminal': 'Reopen terminal',
} satisfies Record<DshellModeKey, string>

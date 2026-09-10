/**
 * Shell command runs sliced out of the raw PTY stream.
 *
 * The dsh shell integration emits `OSC 133 ; D ; <exit-code> BEL` after every
 * command, so the byte range between two markers is exactly one command: its
 * echoed line, then its output. Slices keep their raw ANSI, so the view can
 * hand them to a real terminal instead of re-implementing escape sequences.
 *
 * Nothing here knows about time: the caller passes a resolver that maps a byte
 * offset to its arrival time.
 */

/** `OSC 133 ; D ; <code> BEL` — the shell's end-of-command marker. */
const COMMAND_END = /\u001b\]133;D;(\d*)\u0007/g

/** Bracketed-paste mode toggles the shell brackets every command with. */
const PASTE_MODE = /^\u001b\[\?2004[hl]/

/** Every escape sequence a captured terminal line may carry. */
const ESCAPES = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu

/** C0 controls that are neither tab nor newline. */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu

/** One shell command run. */
export interface PtyCommand {
  /** The command line as typed, prompt stripped. Empty for the live tail. */
  readonly command: string
  /** Raw output bytes (ANSI included), prompt line excluded. */
  readonly output: string
  /** Exit status from the marker; `undefined` when the shell reported none. */
  readonly exitCode: number | undefined
  /** Arrival time of the command's first byte. */
  readonly time: number
  /** Arrival time of the marker that closed it. */
  readonly endTime: number
  /** True for the still-running tail after the last marker. */
  readonly live: boolean
}

/**
 * Strip ANSI escapes and the prompt prefix from a command's echoed line.
 *
 * readline repaints the prompt before it commits a line, so the echo is really
 * `prompt \r ESC[K \r prompt command` — the prompt appears twice and the last
 * carriage-return segment is the one carrying the command.
 * @param line - the first line of a command slice.
 * @returns the command text as typed.
 */
export function commandOf(line: string): string {
  const pieces = line.split('\r')
  let tail = ''
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]
    if (piece !== undefined && piece.trim().length > 0) { tail = piece; break }
  }
  const plain = tail.replace(PASTE_MODE, '').replace(ESCAPES, '').replace(CONTROLS, '')
  // The prompt is whatever precedes the first `$ ` / `# ` / `% ` / `❯ `.
  const boundary = /\$ |# |% |❯ /u.exec(plain)
  return (boundary === null ? plain : plain.slice(boundary.index + boundary[0].length)).trim()
}

/** Whether a slice holds anything a reader would see: text, not just modes. */
function hasVisible(text: string): boolean {
  return text.replace(ESCAPES, '').replace(/\s/gu, '').length > 0
}

/**
 * Slice a session's PTY text into command runs.
 * @param text - the session's full text, oldest byte first.
 * @param resolveTime - maps a byte offset to its arrival time.
 * @returns the runs in execution order; always at least one, the live tail,
 *   when the text is non-empty.
 */
export function splitCommands(text: string, resolveTime: (offset: number) => number): readonly PtyCommand[] {
  if (text.length === 0) return []
  const commands: PtyCommand[] = []
  let cursor = 0
  COMMAND_END.lastIndex = 0
  for (let match = COMMAND_END.exec(text); match !== null; match = COMMAND_END.exec(text)) {
    const code = match[1] === undefined || match[1] === '' ? undefined : Number(match[1])
    const run = sliceCommand(text, cursor, match.index, code, false, resolveTime)
    // An empty Enter, or the marker the shell emits before its first prompt,
    // carries neither a command nor output: it is a boundary, not a run.
    if (run.command.length > 0 || hasVisible(run.output)) commands.push(run)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) {
    const run = sliceCommand(text, cursor, text.length, undefined, true, resolveTime)
    if (hasVisible(run.output)) commands.push(run)
  }
  return commands
}

/** One command run from the byte range between two markers. */
function sliceCommand(
  text: string,
  start: number,
  end: number,
  exitCode: number | undefined,
  live: boolean,
  resolveTime: (offset: number) => number,
): PtyCommand {
  const slice = text.slice(start, end)
  const breakAt = slice.indexOf('\n')
  const head = breakAt < 0 ? slice : slice.slice(0, breakAt)
  // Everything after the echoed command line is its output; a live tail has no
  // command yet, so the whole slice is output.
  const output = live ? slice : (breakAt < 0 ? '' : slice.slice(breakAt + 1))
  return {
    command: live ? '' : commandOf(head),
    output,
    exitCode,
    time: resolveTime(start),
    endTime: resolveTime(end),
    live,
  }
}

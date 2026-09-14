/**
 * The file navigator's route: one exact `/api` endpoint behind dsh's existing
 * trust and authentication fence, mirroring the other dshell routes.
 *
 * Two actions, both against ONE directory, in the session's own execution
 * world. The world is chosen by the filesystem seam itself, not here: every call
 * runs inside `ctx.agents.withInitiator`, and `ctx.fs` resolves the ambient
 * session — a device-bound session's tree is read over its own SSH route, this
 * machine's otherwise. That is also why the walk is unbounded: the routing
 * helper passes an absolute path outside the session's mount directory through
 * unchanged, so on a device `/etc` means the device's `/etc`.
 *
 *  - `list` reads the directory.
 *  - `cd` moves the session's main shell into it, which is the one way to move
 *    an interactive shell: its working directory is process state, so a command
 *    run through the shell seam would not touch it. The input therefore goes to
 *    the terminal bridge's own input path, the same one a keystroke takes, so
 *    the command is tracked and rendered like any command the user types. It is
 *    the bridge's session-keyed entry, so the path handed over is the canonical
 *    one in that world — a device session's shell cds on the device.
 *
 * Listing is a read, and every sandbox mode permits reads (the policy fence
 * covers mutations only), so this route adds no gate the session did not
 * already have through `read`.
 */

import { homedir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import type { DshellTerminalBridge } from '@nexus-aethra/dshell-terminal-bridge'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
// Type-only: pulls the session-controller service merge (`ctx.sessionController`).
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DSHELL_FILES_PATH, type DshellCompletion, type DshellCompletionCandidate, type DshellFileEntry,
  type DshellFileKind, type DshellFilesListing, type DshellFilesRequest, type DshellFilesResponse,
} from './protocol.js'
import type { TransferRoutingSeat } from './transfer.js'

/**
 * Entries one listing returns before it is reported truncated.
 *
 * A directory of this size is already unusable as a list, and the cap keeps one
 * request from pushing a whole tree through the browser in a single frame.
 */
const MAX_ENTRIES = 1000

/**
 * Candidates one completion answers with.
 *
 * A completion menu is read by eye, and past a screenful the useful move is to
 * keep typing rather than scroll — so the cap is small and the answer says it
 * was cut.
 */
const MAX_COMPLETIONS = 60

/** JSON response in the shape the browser face parses. */
function respond(body: DshellFilesResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** One shell argument, safely: single quotes, closed and reopened around each quote in the value. */
function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Resolve one session, and one directory in its world.
 *
 * Both actions start here, so "the session can be resumed" and "this is really
 * a directory" are stated once. The resolved target is canonical, and its key is
 * the absolute path in that world — the string both the listing and the shell
 * command are built from.
 */
async function openDirectory(
  ctx: Context,
  sessionId: string,
  path: string | undefined,
): Promise<{ agent: Agent; target: FsTarget }> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
  const agent = resolved.agent
  const cwd = agent.session.header.cwd
  const start = path === undefined || path.trim().length === 0 ? cwd : path.trim()
  if (start === undefined) throw new Error('这个会话没有工作目录，且请求没有给出路径')
  const options = cwd === undefined ? {} : { cwd }

  // Every call is made as the session, synchronously entering the seam so the
  // provider reads the right initiator.
  const target = await ctx.agents.withInitiator(agent, () => ctx.fs.resolve(start, options))
  const info = await ctx.agents.withInitiator(agent, () => ctx.fs.stat(target))
  if (info === undefined) throw new Error(`目录不存在：${String(target.targetKey)}`)
  if (info.type !== 'directory') throw new Error(`不是目录：${String(target.targetKey)}`)
  return { agent, target }
}

/** One directory reading, as the session that owns the world. */
async function list(
  ctx: Context,
  sessionId: string,
  path: string | undefined,
  canCd: boolean,
): Promise<DshellFilesListing> {
  const { agent, target } = await openDirectory(ctx, sessionId, path)
  const children = await ctx.agents.withInitiator(agent, () => ctx.fs.listDir(target))
  const entries: DshellFileEntry[] = children.slice(0, MAX_ENTRIES).map(child => ({
    name: child.name,
    kind: child.type,
    ...child.size === undefined ? {} : { size: child.size },
  }))
  return {
    path: String(target.targetKey),
    entries,
    truncated: children.length > MAX_ENTRIES,
    canCd,
  }
}

/** Send the session's shell into one directory, and answer with that directory. */
async function cd(
  ctx: Context,
  bridge: DshellTerminalBridge,
  sessionId: string,
  path: string | undefined,
): Promise<string> {
  const directory = String((await openDirectory(ctx, sessionId, path)).target.targetKey)
  // `\r` is the byte dsh's own terminal backend appends for "run this"; the
  // bridge's input path is raw, so the newline is ours to add.
  bridge.feed(sessionId, `cd ${quote(directory)}\r`)
  return directory
}

/**
 * The last token of a shell line, with the span the composer should replace.
 *
 * Whitespace splits tokens, except inside single or double quotes; the token is
 * split again at its last `/` so the basename is the part substituted and
 * everything before it — a relative prefix, `~/`, an absolute directory — stays
 * exactly as the user typed it.
 */
function lastToken(before: string): { start: number; dirPart: string; prefix: string } | undefined {
  let quote: '"' | "'" | undefined
  let tokenStart = 0
  for (let index = 0; index < before.length; index += 1) {
    const char = before[index]
    if (quote === undefined && (char === '"' || char === "'")) { quote = char; continue }
    if (quote !== undefined && char === quote) { quote = undefined; continue }
    if (quote === undefined && /\s/u.test(char as string)) tokenStart = index + 1
  }
  // An unterminated quote means the token is still being written: keep it whole.
  const token = before.slice(tokenStart)
  if (token.length === 0) {
    // A line that ends in whitespace is starting a NEW argument — `ls ` wants
    // the shell's directory listed, so the completion is a bare prefix against
    // it. Nothing before the space means there is no argument yet.
    if (before.slice(0, tokenStart).trim().length === 0) return undefined
    return { start: before.length, dirPart: '', prefix: '' }
  }
  // A leading dash is a flag, not a path.
  if (token.startsWith('-')) return undefined
  const slash = token.lastIndexOf('/')
  const dirPart = slash < 0 ? '' : token.slice(0, slash + 1)
  return { start: tokenStart + dirPart.length, dirPart, prefix: token.slice(slash + 1) }
}

/** The home of a session's world: a device's remote root, or this machine's. */
function worldHome(routing: () => TransferRoutingSeat | undefined, sessionId: string): string {
  return routing()?.targetForSession(sessionId)?.remoteRoot ?? homedir()
}

/**
 * Expand a leading `~` against that home. The filesystem seam does not do it —
 * `resolve('~')` answers `<cwd>/~` — so both the completion and the `cd` mirror
 * have to, in the session's own world rather than this process's.
 */
function expandHome(value: string, home: string): string {
  if (!value.startsWith('~')) return value
  return `${home.replace(/\/+$/u, '')}${value.slice(1)}`
}

/**
 * Fold A–Z in a name, so a typed prefix can be compared the way a reader reads
 * it rather than the way the filesystem stores it.
 *
 * Every path this route looks up stays exact — the lookup is the shell's, in
 * the shell's own world — but a *completion* is a guess about what the reader
 * meant. Typing the wrong case is the ordinary way to miss a directory whose
 * name is already on the screen, and the answer costs nothing: fold for the
 * comparison, hand back the real spelling, and choosing that candidate (or
 * being the only one, which applies it outright) rewrites the line with the
 * true name. The key that opens the list is then the key that corrects it.
 *
 * Only capitals fold, and only the ASCII ones. The mistake being repaired is a
 * missed shift on a Latin letter; a locale-aware fold would start equating
 * names that are not the same name in other scripts (a Turkish dotless i, the
 * Kelvin sign), and could change the length of the string the candidate offsets
 * are measured in.
 */
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/gu, char => char.toLowerCase())
}

/**
 * One directory reading inside the session's world.
 *
 * The two misses are kept apart because the reader is told which one happened:
 * an absent path and a path that is a file are different mistakes, and only the
 * first is worth recovering from capitals.
 */
type DirectoryReading =
  | { readonly ok: true; readonly dir: string; readonly children: readonly FsDirEntry[] }
  | { readonly ok: false; readonly dir: string; readonly note: '目录不存在' | '不是目录' }

/** Read one directory as the session that owns the world it lives in. */
async function readDirectory(
  ctx: Context,
  agent: Agent,
  path: string,
  base: string | undefined,
): Promise<DirectoryReading> {
  const options = base === undefined ? {} : { cwd: base }
  const target = await ctx.agents.withInitiator(agent, () => ctx.fs.resolve(path, options))
  const info = await ctx.agents.withInitiator(agent, () => ctx.fs.stat(target))
  const dir = String(target.targetKey)
  if (info === undefined) return { ok: false, dir, note: '目录不存在' }
  if (info.type !== 'directory') return { ok: false, dir, note: '不是目录' }
  const children = await ctx.agents.withInitiator(agent, () => ctx.fs.listDir(target))
  return { ok: true, dir, children }
}

/**
 * Complete the directory a token ended with, when the exact path was not one.
 *
 * `ls neXus-shell/<Tab>` asks for the contents of a directory stored as
 * `Nexus-shell`. The reading misses, but only because of capitals, and the
 * repair is the one the trailing segment already gets: the answer completes
 * THAT segment — one candidate per folded match, spelled the way the
 * filesystem spells it, replacing the segment and the slash the reader typed.
 * The line is corrected, and the next Tab lists the directory, which is what
 * the slash asked for.
 *
 * Only a miss reaches here, so a path that exists is used exactly as written
 * and a correctly spelled directory is never re-read as a different one that
 * happens to differ in case. A file is no candidate: the reader wrote a slash,
 * and only a directory can answer one.
 *
 * @returns the completion for the segment, or undefined when the token has no
 *   segment of its own, the parent cannot be read, or nothing folds to it — the
 *   caller then reports its own miss for the path as typed.
 */
async function completeDirectorySegment(
  ctx: Context,
  agent: Agent,
  token: { start: number; dirPart: string; prefix: string },
  base: string | undefined,
  home: string,
): Promise<DshellCompletion | undefined> {
  // `dirPart` ends AT the last slash, so its own last segment is the name to
  // complete and everything before it is the directory to complete it in.
  const head = token.dirPart.replace(/\/+$/u, '')
  const slash = head.lastIndexOf('/')
  const parentPart = slash < 0 ? '' : head.slice(0, slash + 1)
  const segment = head.slice(slash + 1)
  // Something after the last slash means the reader is completing a name INSIDE
  // a directory that did not resolve; correcting the directory would have to
  // rewrite text the candidate does not own, so this stays a plain miss.
  if (segment.length === 0 || token.prefix.length > 0) return undefined
  const rawParent = expandHome(parentPart, home)
  const parent = rawParent.length === 0 ? base : rawParent
  if (parent === undefined) return undefined
  const reading = await readDirectory(ctx, agent, parent, base)
  if (!reading.ok) return undefined
  const needle = foldAscii(segment)
  const matched = reading.children
    .filter(child => child.type === 'directory' && foldAscii(child.name).startsWith(needle))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (matched.length === 0) return undefined
  // The segment starts after everything the token keeps, and — because the token
  // ends at its slash — runs to the cursor, so the reader's slash goes with it.
  const segmentStart = token.start - token.dirPart.length + parentPart.length
  const candidates: DshellCompletionCandidate[] = matched.slice(0, MAX_COMPLETIONS).map(child => ({
    name: child.name,
    kind: 'directory' as DshellFileKind,
    hint: '目录',
  }))
  return {
    start: segmentStart,
    end: token.start,
    dir: reading.dir,
    candidates,
    truncated: matched.length > MAX_COMPLETIONS,
  }
}

/** One line's completion, resolved in the session's own world. */
async function complete(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  line: string,
  cursor: number,
  cwd: string | undefined,
  shellCwd: string | undefined,
): Promise<DshellCompletion | undefined> {
  const before = line.slice(0, Math.max(0, Math.min(cursor, line.length)))
  const token = lastToken(before)
  if (token === undefined) return undefined
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
  const agent = resolved.agent
  // The shell runs in the session's world, so a bare token completes against
  // the directory the terminal stands in. Where the shell IS outranks every
  // mirror of it: the bridge reads a local shell's own process cwd, so a `cd`
  // typed in, fed by the file navigator, or spelled in a way the composer's
  // line scanner refuses all land here. The composer's tracked value is the
  // fallback for a session whose shell cannot be read (a device's `ssh`), and
  // `~` resolves against that world's home either way.
  const base = shellCwd ?? (cwd !== undefined && cwd.length > 0 ? cwd : agent.session.header.cwd)
  const home = worldHome(routing, sessionId)
  // A lonely `~` names a directory, and nothing is named "~": the answer is the
  // tilde itself, so the composer writes `~/` and the next Tab lists it.
  if (token.dirPart === '' && token.prefix === '~') {
    return {
      start: token.start,
      end: before.length,
      dir: home,
      candidates: [{ name: '~', kind: 'directory', hint: '目录' }],
      truncated: false,
    }
  }
  const rawDir = expandHome(token.dirPart, home)
  const start = rawDir.length === 0 ? base : rawDir
  if (start === undefined) throw new Error('这个会话没有工作目录，无法补全相对路径')
  const reading = await readDirectory(ctx, agent, start, base)
  if (!reading.ok) {
    // A directory the reader spelled with the wrong capitals is the same mistake
    // the trailing segment is repaired for, so the miss is given that one chance
    // before it is reported.
    const recovered = await completeDirectorySegment(ctx, agent, token, base, home)
    return recovered ?? {
      start: token.start, end: before.length, dir: reading.dir, candidates: [], truncated: false, note: reading.note,
    }
  }
  // Case-folded on the reader's side only: a name that matches regardless of
  // capitals is still answered with its own spelling, so `nexus-sh` completes to
  // `Nexus-shell/`, and a set that matches either way — `nexus-study` beside
  // `Nexus-shell` under `nexus-` — is listed rather than guessed at.
  const needle = foldAscii(token.prefix)
  const matched = reading.children
    .filter(child => foldAscii(child.name).startsWith(needle))
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  const candidates: DshellCompletionCandidate[] = matched.slice(0, MAX_COMPLETIONS).map(child => ({
    name: child.name,
    kind: (child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other') as DshellFileKind,
    ...child.size === undefined ? {} : { size: child.size },
    hint: child.type === 'directory' ? '目录' : child.size === undefined ? '' : `${String(child.size)} B`,
  }))
  return {
    start: token.start,
    end: before.length,
    dir: reading.dir,
    candidates,
    truncated: matched.length > MAX_COMPLETIONS,
    ...candidates.length === 0 ? { note: '无匹配' } : {},
  }
}

/**
 * Canonicalize one path in the session's world.
 *
 * This is how the composer learns what a `cd` did: the shell's own working
 * directory is process state with no channel back (see the terminal bridge), so
 * every line the composer routes to it is inspected, and a `cd` is resolved
 * through the same seam the navigator uses — which is also what makes `~` and a
 * device session's paths come out right.
 *
 * A `cd` that could not land must not move the composer's mirror: the shell
 * stays where it was, so answering with the path the user typed would point
 * every later relative completion at a directory the shell never entered. Only
 * a directory answers.
 */
async function resolvePath(
  ctx: Context,
  routing: () => TransferRoutingSeat | undefined,
  sessionId: string,
  path: string,
  cwd: string | undefined,
): Promise<string | undefined> {
  const resolved = await ctx.sessionController.resolveAgent(SessionId(sessionId))
  if ('error' in resolved) throw new Error(`会话不可用：${resolved.error.code}`)
  const agent = resolved.agent
  const options = cwd === undefined ? {} : { cwd }
  const target = await ctx.agents.withInitiator(
    agent,
    () => ctx.fs.resolve(expandHome(path, worldHome(routing, sessionId)), options),
  )
  const info = await ctx.agents.withInitiator(agent, () => ctx.fs.stat(target))
  if (info === undefined || info.type !== 'directory') return undefined
  return String(target.targetKey)
}

/**
 * Bind the route to the filesystem seam and, when one is composed, the terminal
 * bridge.
 *
 * The bridge arrives as a getter rather than a value because the two are
 * optional to each other: a composition without dshell-terminal-bridge has no
 * way to drive a session's shell, and this route then answers every listing
 * with `canCd: false` and refuses `cd`. Reading it per request also keeps the
 * question "is it composed *now*" honest across a later load or unload.
 */
export function createFilesRoute(
  ctx: Context,
  terminal: () => DshellTerminalBridge | undefined,
  routing: () => TransferRoutingSeat | undefined = () => undefined,
): ConnectionFetchRoute {
  const handle = async (request: Request): Promise<DshellFilesResponse> => {
    if (request.method === 'GET') return { error: '文件列表只接受 POST' }
    const input = await request.json() as DshellFilesRequest
    const bridge = terminal()
    switch (input.action) {
      case 'list':
        return { listing: await list(ctx, input.sessionId, input.path, bridge !== undefined) }
      case 'cd': {
        if (bridge === undefined) return { error: '本次组合没有终端桥，无法把终端切换到该目录' }
        return { cdTo: await cd(ctx, bridge, input.sessionId, input.path) }
      }
      case 'resolve':
        return { resolved: await resolvePath(ctx, routing, input.sessionId, input.path ?? '.', input.cwd) }
      case 'complete':
        return {
          completion: await complete(
            ctx, routing, input.sessionId, input.line ?? '', input.cursor ?? 0, input.cwd,
            bridge?.shellCwd(input.sessionId),
          ),
        }
      default:
        return { error: '未知操作' }
    }
  }

  return {
    path: DSHELL_FILES_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return respond({ error: reason }, 400)
      }
    },
  }
}

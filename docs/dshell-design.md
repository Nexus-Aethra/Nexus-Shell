# dshell Design Document

Status: contract for implementation. Any change to this document must be
re-confirmed before the corresponding code is written.

## 1. Goal

Build a dsh plugin suite (`dshell-*`) that turns the default chat-style Web
UI into a terminal-first single-stream surface. The user sees one xterm.js
canvas per session. The canvas carries both PTY bytes from a single canonical
"main" shell and agent turn fragments from `session/event`, interleaved in
the order they occurred. The user can choose, per message, whether the next
input goes to the PTY or to `ctx.agents.inject()`, by mode toggle or by an
inline `/agent` / `/shell` prefix.

The plugin suite must not require changes to dsh source. Everything ships as
Cordis plugins and bundles that dsh loads at boot through its profile
mechanism (dsh `architecture.md` § "Profiles and bundles"). Composition
mechanics: `dsh --profile web --dump-config` lists the running tree; each
`dshell-*` row is a patch layer.

## 2. Non-goals

- Multiple browser tabs / windows. The user runs one browser process. dsh
  session isolation is sufficient; per-tab PTY sharing is out of scope.
- PTY state surviving a harness restart. dsh `packages/terminal/terminal/
  README.md` § "Known Limitations and Deferred Work" makes
  `process-local` an explicit decision. dshell accepts this; PTY context
  injected into agent turns is the substitute.
- Multiple user-visible PTYs in one session. Each session has exactly one
  `main` shell. Other PTYs the agent opens are backend-only and never
  rendered.
- Cross-process PTY hosting. No tmux server, no remote shell. If the user
  later needs PTY durability, that is a new design.

## 3. Architectural stance

`dshell-*` extends dsh through already-documented extension points only. The
relevant extension points used:

| Goal | Mechanism | Why this and not a fork |
|---|---|---|
| Render interleaved PTY + session event in one view | `ctx.uiConversation.events.register(...)` + `ctx.uiConversation.views.register(...)` for a new target `terminal` | dsh `architecture.md` row 152 names this exact mechanism for "Add a Web Client Chat node". |
| Direct user actions that skip the agent turn | `ctx.commands.register(...)` | dsh `packages/interaction/commands/README.md` § "Use this package". |
| Forward keystrokes from browser to PTY | `ctx.webServer.registerUpgrade('/dshell/pty', ...)` | dsh `packages/host/webserver/README.md` § "Registering routes". |
| Drive PTY | reuse shipped `ctx.terminals` via `dsh-terminal-bash` backend | dsh `architecture.md` row 142. |
| Inject terminal context into next agent turn | `agent.inject({ ..., source: { kind: 'plugin', plugin: 'dshell-terminal-context' } })` | dsh `architecture.md` row 150; verified in `packages/core/agent-loop/tests/loop.spec.ts:964`. |
| Session persistence | reuse shipped `ctx.sessionPersistence` (`dsh-session-persistence-jsonl`) | dsh `docs/subsystems/persistence.md`. |

Everything the user sees in dshell is either an existing dsh event projected
through a registered target or a PTY byte stream surfaced through a ws
upgrade route owned by `dshell-terminal-bridge`.

## 4. Seven decisions

### 4.1 Session isolation

Each dsh session is a self-contained working surface. dsh already provides
this: `packages/client/ui-conversation/src/client/conversation/
assembly.ts:220` exposes `binding(source)` returning one
identity-stable binding per `SessionId`. The browser-side
`ConversationViewDefinition.create()` is called once per session per target,
so the `terminal` target gets one `ViewBuilder` instance per session.

Consequences:

- Mode toggle state is held in the per-session store, not in module-scope.
  Switching sessions switches mode.
- The PTY buffer held by each `ViewBuilder` belongs to one session; it
  cannot leak into another session's rendering.
- `dshell-terminal-bridge` looks up the target `ViewBuilder` by the
  `SessionId` carried in ws messages; it never holds a cross-session
  reference.

### 4.2 Main shell ownership

The `name: 'main'` PTY belongs to `dshell-terminal-bridge`, not to the
agent. The bridge calls `ctx.terminals.spawn(agent, { type: 'shell',
name: 'main', cwd: agent.cwd })` on first need. The agent may also call
`terminal_open` with `name: 'main'`, but because `ctx.terminals`
discriminates by the `TerminalSessionId` returned by `spawn`, the agent's
call creates a second PTY session, never replaces the bridge's. The
bridge records `mainPtyByAgent: Map<Agent, TerminalSessionId>` and
references that map throughout the session lifetime.

Consequences:

- The user's `main` shell cannot be hijacked by agent behavior.
- `name: 'main'` is the dsh-idiomatic owner-local label (verified in
  `packages/terminal/tool-terminal/src/index.ts:167` and the same package's
  tests). Using it keeps dshell compatible with dsh's documented contract.
- Agent-owned "secondary" PTYs (`name: 'gdb'`, unnamed, etc.) are kept
  alive in `ctx.terminals` and reachable via `tool-terminal`, but dshell
  never subscribes to their output.

### 4.3 Secondary shell pass-through

PTYs the agent opens via `terminal_open` with any name other than `main`
(or with no name) are not rendered by dshell. They remain accessible to
the agent through `terminal_send` / `terminal_read` / `terminal_signal`
/ `terminal_close` / `terminal_list`. Their results reach the user
indirectly:

- The agent's tool calls and results land in the session log as
  `tool/call` and `tool/result` events.
- The dshell `ViewBuilder` renders those events as ordinary chat-style
  cards (see 4.4), so the user sees "agent ran `terminal_send` on
  session `pty-7` and got back `hello\n`".

This is enough for the user to know the agent did something in a
secondary shell; the user does not need to see the raw bytes.

### 4.4 Interleaved rendering

`ViewBuilder` for target `terminal` holds a Snapshot with two internal
lists, merged at materialization:

- `sessionNodes: readonly ConversationViewNode[]` — driven by
  dsh's `replace` / `apply` calls. Each node carries an event `time`.
- `ptyRows: PtyRow[]` — owned by dshell. Each row carries a wall-clock
  `time` taken at chunk arrival.

Merge rule: stable ascending sort by `time`; ties broken by `kind`
(`'pty'` before `'session'`, so a PTY byte emitted at the same instant
as a session event shows just above it).

Both kinds of rows are drawn into one xterm.js buffer. Session nodes are
serialized to ANSI sequences with a `┃` left margin and a dimmed tint;
PTY rows pass through verbatim (xterm.js renders them natively with
ANSI color support).

The merge runs in the browser; the host never sees xterm.js state.

### 4.5 Mode state and `/agent` / `/shell`

Two modes per session, `shell` and `agent`, held in a per-session store:

- `shell` mode: composer Enter sends the input as one `startSend` to
  the `main` PTY session.
- `agent` mode: composer Enter calls `agent.inject(userMessage)`.

Prefix interception happens at composer submit, not via
`ctx.commands.register`:

- `/agent <text>` in `shell` mode: switch mode to `agent`, drop the
  `/agent` token, treat the rest as the user message for
  `agent.inject`.
- `/shell <cmd>` in `agent` mode: switch mode to `shell`, drop the
  `/shell` token, run the rest as one `startSend` against `main`.
- `/clear`, `/new`, `/compact` are real `ctx.commands` registrations;
  they never reach the agent turn (verified in
  `packages/interaction/commands/README.md` § "Dispatching from an
  adapter"). `/clear` clears the xterm buffer and the bridge's per-session
  PTY scrollback; `/new` opens a new session through dsh's standard
  creation path; `/compact` triggers dsh's compaction service.

Composer Enter submit is rewritten by patching the `inputActions` flow
exposed through `ctx.uiSession.provide()` (dsh
`packages/client/ui-conversation/README.md` § "Shell and standard
props"). Submit dispatches to the per-mode handler; the `/agent` and
`/shell` prefix parses happen first.

### 4.6 Terminal context injection

When the user is in `agent` mode and submits a message, dshell injects a
PTY context block immediately before the user message:

- The context is a snapshot of the recent `main` PTY output, anchored on
  the last `$` prompt (or other shell prompt marker configured by the
  user) and bounded to the lines after it.
- Hard cap: 100 lines or 4 KiB, whichever is smaller. The cap is checked
  after UTF-8 boundary alignment.
- Injection uses `agent.inject(createUserMessage({ content: [{ type:
  'text', text: wrapAsContextBlock(buf) }], source: { kind: 'plugin',
  plugin: 'dshell-terminal-context' } }))`.
- `inject()` while idle stages the message into the inbox without
  opening a turn (verified in `packages/core/agent-loop/tests/
  loop.spec.ts:959` "idle inject() durably stages context without
  opening a turn"). The next admitted request includes it.
- The wrapped block uses triple-backtick fencing so the model can
  distinguish context from user message.

The agent's `terminal_open` calls carry `name: 'main'` semantics by
default through a new model-facing tool `dshell_get_main_terminal`,
which returns the `TerminalSessionId` of the bridge-owned main shell.
The agent uses this id when interacting with the user's shell. Without
this tool, the agent has no reliable way to refer to `main` — `name`
is owner-local display metadata only, not an addressable handle.

### 4.7 Workspace removal

dsh's workspace registry groups sessions under a user-picked directory,
and the stock web UI gates the composer behind a "选择工作区" picker.
A terminal-first shell has no use for this: the terminal's "workspace"
is the PTY's current directory, which changes constantly. The runtime
half of dsh never reads the registry anyway — agent spawn, PTY, file
tools, sandbox, subagents, ACP, and hooks all consume
`session.header.cwd` (a one-time copy taken at session creation), and
dsh's own docs call the feature optional
(`dsh/docs/subsystems/workspace.md`: "an optional host-side capability,
not part of the agent-loop spine"). Only the web-app bundle mounts it.

dshell removes the concept through a dedicated package
`dshell-workspace` (Phase 1.5), without forking:

- The dshell bundle patch disables the four web-app rows `workspace`,
  `workspace-controller`, `ui-workspace`, and `directory-picker`.
- Disabling alone would hang the shell: `session-controller` (host)
  and `ui-conversation` / `ui-sidebar` (client) hard-inject
  `workspaceRegistry` / `workspaces` / `uiWorkspace`, and
  ConversationRoot requires the `slots.provideRoot({ hooks: {
  workspaces } })` root hook. The package therefore provides same-key
  replacement services (Cordis service keys are plain strings): a
  minimal host registry stub covering the consumed surface, and client
  stubs plus the root hook.
- The hero picker and sidebar workspace grouping disappear with the
  `ui-workspace` row; the composer's inert gate
  (`sessionId === undefined || (hero && chipTitle === undefined)`)
  reduces to plain "no session open".

Sessions are created via `sessions.create({ cwd })` (workspaceId
omitted) — a stock dsh creation path, workspaceId and cwd being
alternatives by contract.

Consequences:

- Session creation never asks for a workspace. The sidebar falls back
  to dsh's built-in flat session list.
- Session cwd is immutable after creation (`ApiSessionCwdConflict`):
  one session = one fixed agent working root. The PTY `cd`s freely;
  Phase 7's context injection reports the live PTY cwd to the agent so
  it always knows where the user is. Cross-directory work means a new
  session (`/new`) — matching the terminal habit of cd-then-work.
- The removed registry is not backed up or migrated; existing
  `$DSH_HOME/storages/workspace` data is simply no longer read.

## 5. Wire protocol

`dshell-terminal-bridge` exposes a single ws upgrade route at
`/dshell/pty`. The protocol is JSON framed; messages are:

- Client → server:
  - `{ kind: 'bind', sessionId: string }` — associate this ws with the
    dsh session id. Required as the first message after upgrade.
  - `{ kind: 'input', sessionId: string, text: string }` — `startSend`
    against the `main` PTY session.
  - `{ kind: 'resize', sessionId: string, cols: number, rows: number }`
    — resize the PTY.
  - `{ kind: 'signal', sessionId: string, signal: 'SIGINT' | 'SIGTERM'
    | 'SIGTSTP' }` — signal the foreground process group.
- Server → client:
  - `{ kind: 'output', sessionId: string, chunk: string, time: number }`
    — PTY bytes to render.
  - `{ kind: 'status', sessionId: string, status: TerminalSessionStatus }`
    — `main` PTY status changed.
  - `{ kind: 'closed', sessionId: string, reason: string }` — `main` PTY
    was closed by either side.

The `SessionId` in every message is part of authorization: a ws frame
naming a session the bridge has not bound is rejected.

## 6. Failure modes

- `main` PTY dies (`session_exit` or signaled): bridge removes it from
  `mainPtyByAgent`; next user input triggers `ensureMainShell` again.
- Browser disconnects: bridge holds the PTY until session disposal.
  Re-connection re-subscribes to byte stream from current scrollback.
- Multiple ws clients connect for one session: bridge accepts the first
  and rejects subsequent binds. Single browser, single ws per session.
- Session disposed by user: bridge closes the bound ws and calls
  `ctx.terminals.kill(agent, mainId)` in the session dispose path.

## 7. Out-of-scope follow-ups (for later)

- Split-pane rendering for multiple user-visible PTYs in one session.
- PTY durability across harness restart (external backend).
- Inline syntax highlighting for shell prompt in xterm.js buffer.
- Per-line agent attribution coloring in xterm output.
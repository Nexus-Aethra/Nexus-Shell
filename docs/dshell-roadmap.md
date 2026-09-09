# dshell Development Roadmap

Each phase ends with a runnable artifact that exercises a real slice of
dsh's existing extension points. Do not move to the next phase until the
current one ships its acceptance check.

The phases are ordered so that each one adds one decision from
[`dshell-design.md`](./dshell-design.md). Skipping ahead risks rebuilding
because decision points become load-bearing later.

## Phase 0 — Repo scaffold

Goal: the dshell workspace exists as a sibling to `dsh/` and pnpm picks
it up.

Deliverables:

- `/home/wpp/nexus/Nexus-Shell/` initialized as a pnpm workspace.
- A workspace `package.json` that references `dsh/` as a local workspace
  root or pulls dsh packages via npm `@deepseek-ai/dsh-*` ranges.
- One placeholder `packages/dshell-meta/` package with an empty plugin
  to prove the workspace builds.

Acceptance check:

```
cd /home/wpp/nexus/Nexus-Shell
pnpm install
pnpm -F @deepseek-ai/dsh-* run build
# (dsh's bundled CLI runs against this workspace)
npx @deepseek-ai/dsh web
# Web UI loads at 127.0.0.1:3080
```

## Phase 1 — Bundle + empty target

Goal: register a `terminal` target that renders nothing yet, but proves
the target registration path works.

Covers decision: 4.1 (session isolation) at the registration level.

Plugins touched:

- `dshell-bundle` (new) — patches the `web` profile to include the
  browser half packages.
- `dshell-conversation` (new, host face only) — registers a
  `ConversationViewDefinition` for target `terminal` whose
  `ViewBuilder.empty` returns a `Snapshot` with an empty `rows` array.

Acceptance check:

```
npx @deepseek-ai/dsh web --profile web
# Sidebar lists sessions. Main panel shows the new "terminal" target
# (selected via settings) with an empty viewport. session/event still
# drives the chat target because nothing changes that one.
```

## Phase 1.5 — Workspace removal

Goal: the workspace concept is gone from the running shell — no picker
gate, no sidebar grouping, sessions created directly by cwd.

Covers decision: 4.7 (workspace removal).

Plugins touched:

- `dshell-workspace` (new, two-faced) — host face provides a minimal
  `workspaceRegistry` stub so `session-controller`'s inject resolves;
  client face provides `workspaces` + `uiWorkspace` stubs and the
  root `workspaces` hook that ConversationRoot requires.
- `dshell-bundle` — inserts the `dshell-workspace` row and disables
  the stock rows `workspace`, `workspace-controller`, `ui-workspace`,
  `directory-picker`.

Acceptance check:

- dsh web boots with the four stock rows disabled and dshell's
  replacements active; no pending-fiber hang, no missing-root-hook
  crash.
- The composer is live without any workspace pick; creating a session
  goes through `sessions.create({ cwd })` with no workspace attached.
- The sidebar shows one flat session list; no workspace picker or
  grouping anywhere in the UI.

## Phase 1.6 — New-session dialog

Goal: session naming and start directory are chosen at creation time.

Covers decision: 4.7 (naming paragraph).

Plugins touched:

- `dshell-workspace` (browser face) — the flat list gains a new-session
  dialog (optional name + starting directory); `uiWorkspace.startSession`
  (the shell's stock New-Session button) opens the same dialog instead of
  creating silently; the stock hero workspace chip is hidden by an
  interim stylesheet until the Phase 4 scaffold takeover removes the
  whole hero row.

Acceptance check:

- `＋ 新会话` (list header) and the shell's `新会话` button both open the
  dialog.
- Creating with a name lands in the sidebar under that name; creating
  with a custom directory creates the session in it.
- The hero workspace chip no longer renders.

## Phase 2 — Main shell lifecycle

Goal: bridge owns a `name: 'main'` PTY for the active agent; the PTY
streams bytes into a host-side buffer; nothing is rendered yet.

Covers decision: 4.2 (main shell ownership).

Plugins touched:

- `dshell-terminal-bridge` (new, host face) — owns
  `mainPtyByAgent: Map<Agent, TerminalSessionId>`; calls
  `ctx.terminals.spawn` lazily; reads bytes through `readOutput`.
- `dshell-conversation` (host face) — exposes a typed channel from the
  bridge's PTY buffer to the browser-side `ViewBuilder`.

Acceptance check:

- A test agent (`ctx.agents.create({ sessionId })`) gets a main shell
  on first access; `ctx.terminals.list(agent)` contains
  `{ name: 'main' }`.
- A second `terminal_open({ name: 'main' })` from the agent creates a
  separate session; `mainPtyByAgent` is untouched.
- The bridge's per-session buffer accumulates bytes after `startSend`.
- The buffer persists to `$DSH_HOME/dshell-pty/<session-id>.log`
  (design 4.9); memory holds only the fixed window; a fresh main shell
  for the same session seeds from the file tail.

Status: implemented together with Phase 3 (the ws transport is the
first consumer of the buffer and the tail loop).

## Phase 3 — WebSocket transport

Goal: a browser running the dsh Web UI can connect a ws to
`/dshell/pty` and see main shell bytes stream into the page.

Covers decisions: 4.2 (routing), 4.4 (delivery, host half).

Plugins touched:

- `dshell-terminal-bridge` (host face) — adds `registerUpgrade` on
  `ctx.webServer`.
- `dshell-terminal-bridge` (browser face, new) — opens ws from the
  active session binding; relays bytes to a console log first, before
  any rendering.

Acceptance check:

- With dsh web running, opening the browser console shows PTY bytes
  arriving as the agent (or a test agent) writes to `main`.
- The ws respects `{ kind: 'bind', sessionId }` authorization: a bind
  with a wrong id is rejected and closed.

## Phase 4 — Fused terminal surface

Goal: dshell owns the whole conversation surface. The stock
`conversation.composer.bar` slot is shadowed at priority -1 by the
dshell terminal dock (design 4.8): one full-bleed vertical column — the
PTY scrollback streams above a monospace input line pinned to the
bottom. Mode chip + model chip live inline with the input line; the
stock chat composer and centered hero are gone.

The Phase 1 interim terminal-tab approach (`conversation.view` slot
with `id: 'terminal'`) was tried and abandoned. It split PTY output
and the input dock into separate slot occupants whose layouts fought
each other, and forced the stock `selectView` path through a `chat`
default. Replacing it with a single composer-bar shadow that owns the
entire column avoids both issues — the dock IS the surface.

Covers decisions: 4.1 (terminal-first surface), 4.5 (mode state),
4.8 (terminal layout).

Plugins touched:

- `dshell-mode` (browser face) — registers the shadowing dock as a
  full-height flex column: scrollback above, input bar at the bottom.
  Per-session mode store; Enter dispatch by mode (`shell` → bridge
  `send`, `agent` → `scopedConversation.send`); `/agent` / `/shell`
  prefix parsing; model chip over `ctx.modelDirectories` (shared with
  `/model`, no child-hole collision).
- `dshell-conversation` (browser face) — registers a no-renderer
  `ConversationViewDefinition` on target `terminal` whose `isActive`
  returns `true`. The framework treats the target as visible activity
  even in a blank session, so the conversation stays in `active` phase
  instead of the centered `hero`. The same plugin auto-activates
  `terminal` on every new session.
- `dshell-workspace` (browser face) — keeps the interim CSS that
  hides the hero chrome (`heroWorkspaceRow`, `headline`), pins the
  dock to the bottom of the scroll column in `hero` phase, and in
  `active` phase neutralizes the slot chain's `display:contents` /
  `flex:0 1 auto` wrappers so the dock flex-grows to fill the seat.

Acceptance check (current state — see screenshot in conversation):

- New session creation opens straight into a full-column fused
  terminal: PTY scrollback fills the column above a fixed input line
  pinned to the bottom. The hero banner ("探索未至之境") and centered
  composer are gone.
- Shell input roundtrips: typing `echo hi` in the dock and pressing
  Enter sends to the main PTY; the next prompt appears in the
  scrollback above.
- Mode toggles: clicking the `⌨ shell` / `✳ agent` chip flips mode
  and the input placeholder. `/agent` and `/shell` prefixes from
  the dock dispatch immediately and flip mode in one keystroke.
- Model chip lists the shared directory and updates selection in
  sync with `/model`.

### 4.x Shell-interaction mechanics (hard-won constraints)

- **The main shell is a push-based raw PTY, not a polled tail**
  (superseded in Phase 5). The bridge registers its own
  `TerminalBackend` (`dshell-pty`: plain node-pty bash,
  `TERM=xterm-256color`) and pushes raw ANSI chunks to the browser
  canvas. The original pull model — poll `ctx.terminals.read`, diff
  the retained text against the previous tick, broadcast the prefix
  extension — existed because dsh's scrollback is a mutating stream:
  the trailing prompt is a partial line that grows in place, echo
  completion rewrites the last line, and `split('\n')` counts all of
  it. A seen-lines cursor double-consumed the prompt line (duplicate
  prompts/commands) and consumed phantom empty lines (lost echoes);
  even the content-diff variant lagged a tick behind. Raw push
  deleted the whole class: ANSI colors reach xterm.js untouched, and
  agent-facing reads strip ANSI on demand.
- **`clear` is a bridge operation, not bash's ANSI clear.** The
  sanitizer historically stripped ANSI clear from scrollback, so the
  bridge owns the wipe: truncate the retained buffer, broadcast a
  replay (the canvas redraws the merged timeline), queue a newline so
  bash prints a fresh prompt. Init writes the custom PS1 +
  `PROMPT_COMMAND` (OSC 133;D marker) once, then `clear`; every
  session open starts from a replayed clean prompt.
- **Readline keys the browser would swallow are mapped in the dock:**
  Tab → `\t` (completion), ArrowUp/Down → `\x10`/`\x0e` (history, no
  ESC bytes — those never survive the PTY input path), Ctrl+C →
  `signalForeground(SIGINT)`. readline redraws erase with backspace
  bytes; the canvas renders them natively (xterm.js), plain-text
  reads collapse them.
- **Send settle with a custom PS1 (now agent-side only):** dsh's fast
  settle needs the stock `dsh> ` cue after the OSC 133;D marker
  (`promptTextSeen`); a custom PS1 disables it permanently, so sends
  held the exclusive startSend slot until the 3s `inferred_idle`
  timeout and back-to-back commands crawled. The bundle patch pins
  the dshell-terminal-bash row — since Phase 5 only the agent's
  `terminal_send` path; main shells moved to the raw backend — to
  `idleSilenceMs: 300` / `handoffGraceMs: 50`. The raw backend
  settles its own sends instead: marker + 60ms quiet fast path,
  350ms inferred-idle fallback, 15s timeout.
- **The ws client must guard socket handover:** `sessions.list` churns
  several times around a session switch, and a redundant `openSocket`
  used to leave two live sockets feeding one history (every frame
  ingested twice). `bind` is idempotent while the session's socket is
  connecting/open, and a superseded socket's frames/closes are ignored.
- **Dev-workflow trap:** composite `tsbuildinfo` caching silently skips
  tsc/tsdown emit — a rebuilt lib can stay stale (the browser then runs
  old client code and everything looks "already broken"). When in doubt
  `rm -rf packages/dshell/*/lib packages/dshell/*/tsbuildinfo lib types`
  and `pnpm build` fresh; verify the change actually landed in
  `lib/client.js` before restarting dsh.

## Phase 5 — ANSI canvas (raw PTY backend + xterm.js + 4.4 merge)

Goal: the conversation column becomes a real terminal canvas — raw
ANSI PTY bytes stream into a full-bleed xterm.js instance, and durable
session events interleave as `┃` rows (design 4.4).

Covers decisions: 4.4 (interleaved rendering), 4.8 (terminal layout).
Retires the Phase 4 pull-model tail (see 4.x).

Plugins touched:

- `dshell-terminal-bridge` (host face) — registers its own
  `TerminalBackend` (`type: 'dshell-pty'`) on `ctx.terminals` next to
  dsh's bash backend: plain node-pty `/bin/bash -i` with
  `TERM=xterm-256color`. Output pushes to subscribers raw
  (`onOutput`), exit pushes (`onExit`), resize is real (the canvas
  drives cols/rows), agent-facing reads strip ANSI on demand, and
  sends settle on the bridge's own logic (marker + 60ms quiet fast
  path, 350ms inferred-idle fallback, 15s timeout; Ctrl+C cancels the
  active send). The bridge spawns one `main` shell per dsh session;
  init sets the PS1 + `PROMPT_COMMAND` marker once and replays a
  clean prompt, and the same truncate + replay is how `/clear` wipes
  both sides.
- `dshell-mode` (browser face) — the dock's scrollback div becomes a
  full-bleed xterm.js canvas. xterm.js and its CSS are inlined into
  the client bundle (rolldown `noExternal` + CSS-as-string module —
  the combo loader only resolves dsh platform modules, so anything
  else must ship inside the bundle). A hidden probe span measures
  char metrics; a ResizeObserver fits cols/rows and resizes the PTY.
  The theme maps the dock palette (bg/text/cursor/selection).
- `dshell-mode` (browser face, 4.4 merge) — `PtyCanvas` subscribes to
  the session's event window (`sessions.binding(id).eventSource`,
  retried until the binding materializes — it is `undefined` for a
  session neither listed nor scoped) and draws durable events as `┃`
  rows: `┃ 你` (user), `┃ AI` (assistant), `┃✦ 工具` (tool results),
  `┃⚡ 命令` (command run/done). Window `replace`/`prepend` replays
  the merged timeline (pty chunks + rows, stable sort by time, pty
  first on ties); appends draw at arrival, on their own line. A pty
  replay chunk schedules one coalesced redraw (~150ms) and suppresses
  row appends meanwhile, so a command's rows never interleave with
  the prompts its wipe just printed. Reload replays the persisted
  window the same way.

Notes:

- Phase 7 deviation: the design's plugin-source injection
  (`agent.inject(createUserMessage({source: {kind: 'plugin'}}))`) is
  host-only — the client wire always stamps `user`. Implemented
  client-side as a fenced `[dshell 终端上下文]` block prepended to the
  user message (verified in the captured request body).
- The `terminal` view builder from Phase 1/4 stays: it renders
  nothing and only marks the session as active activity.
- Composer-targeting note for browser automation: the dock input is
  the `input[placeholder^="输入命令"]` element; xterm.js also renders
  a hidden `xterm-helper-textarea` labeled `Terminal input` — typing
  into that goes to xterm, not the composer.

Acceptance check (verified in the browser):

- Raw ANSI colors: `ls --color=auto /etc` renders blue dirs / cyan
  symlinks in the canvas (xterm.js, not sanitized plain text).
- `/clear` from the dock: canvas shows `┃⚡ 命令 clear` +
  `┃⚡ 命令 终端已清空。` above the fresh prompt; the notice confirms
  admission; `command/run` + `command/done` land in the event window.
- Page reload: the persisted session window replays merged — rows
  above, retained prompt below.
- Tab completion, ↑/↓ history, Ctrl+C still work end-to-end (raw
  control chars through the bridge ws → PTY).

Follow-ups: assistant live-chunk streaming rows (transient events
currently settle into `assistant/message` only on completion);
canvas-focus mode (design 4.8 — the canvas holds focus in shell
mode); PTY scrollback persistence across bridge restarts (4.9).

## Phase 6 — Real commands (`/clear`, `/new`, `/compact`)

Goal: the three dsh commands that dshell exposes are real
`ctx.commands` registrations.

Covers decision: 4.5 (commands).

Plugins touched:

- `dshell-commands` (new, host face) — registers `/clear`,
  `/new`, `/compact` on `ctx.commands`.

Acceptance check:

- `/clear` clears the xterm buffer and the main PTY scrollback in one
  operation.
- `/new` opens a new session through dsh's standard creation path;
  the new session starts in `shell` mode with no PTY until first
  access.
- `/compact` triggers dsh's compaction service and reports its result.

## Phase 7 — Terminal context injection

Goal: agent turns include the recent `main` PTY output as a leading
context block.

Covers decision: 4.6 (injection).

Plugins touched:

- `dshell-mode` (host face) — when the composer submits in `agent`
  mode, inject the truncated recent-output block before the user
  message.
- `dshell-mode` (browser face) — none; the cap and the prompt-anchor
  detection are host-side.

Acceptance check:

- Run `ls /tmp` in shell mode, switch to agent mode, ask "what was the
  last command output?".
- The model's reply references the captured output verbatim.
- The injection respects the 100-line / 4 KiB cap; a runaway command's
  output is truncated at a UTF-8 boundary.

## Phase 8 — `dshell_get_main_terminal` tool

Goal: the agent has a reliable way to learn the `main` PTY session id.

Covers decision: 4.6 (agent access to `main`).

Plugins touched:

- `dshell-commands` (host face) — adds a model-facing tool registered
  on `ctx.tools`.

Acceptance check:

- After agent start, `dshell_get_main_terminal()` returns the
  `TerminalSessionId` of the bridge's `main` PTY.
- Agent can call `terminal_send` against that id to run a command in
  the user's shell; the bytes stream back into the user's xterm.

## Phase 9 — Hardening

Goal: failure modes from `dshell-design.md` § 6 are observed and
handled.

Plugins touched:

- `dshell-terminal-bridge` (host face) — handles `session_exit`,
  signal-driven close, browser disconnect, and session disposal.
- `dshell-mode` (browser face) — UI feedback when the `main` PTY
  restarts.

Acceptance check:

- `exit` in `main` shell: ws receives `{ kind: 'closed' }`; next user
  input opens a new `main` PTY automatically.
- Browser reload: bridge keeps `main` alive; on reconnection, ws
  re-subscribes to byte stream.
- Closing a session in the sidebar: bridge closes ws and calls
  `ctx.terminals.kill(agent, mainId)` cleanly.

## Phase 10 — Packaging

Goal: `dshell-*` packages install with `pnpm add` and dsh loads them
through `dsh.bundle`.

Deliverables:

- Each `dshell-*` package's `dsh.bundle` row in `package.json`.
- A combined `dshell-suite` bundle package that lists every
  `dshell-*` package as a bundle row.
- A README at the repo root with installation instructions:
  ```
  pnpm add -D @deepseek-ai/dsh-shell-suite
  dsh web --profile web
  ```

Acceptance check:

- `pnpm run constraints && pnpm run typecheck && pnpm run lint`
  passes.
- `pnpm run doc-sync` generates catalog entries without warnings.
- A clean dsh install with only `@deepseek-ai/dsh-shell-suite` added
  loads dshell with no manual config.
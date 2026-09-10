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

Goal: session naming, start directory, and agent preset are chosen at
creation time.

Covers decision: 4.7 (naming paragraph).

Plugins touched:

- `dshell-workspace` (browser face) — the flat list gains a new-session
  dialog (optional name + starting directory + agent-preset picker);
  `uiWorkspace.startSession` (the shell's stock New-Session button)
  opens the same dialog instead of creating silently; the stock hero
  workspace chip is hidden by an interim stylesheet until the Phase 4
  scaffold takeover removes the whole hero row. The preset roster comes
  from `ctx.remote.agentPresets.list()` (injected as
  `remote.agentPresets`), broken compositions are dropped from the
  picker, and the choice is applied with `select(sessionId, presetId)`
  while the session is still blank — a started session refuses the
  switch. The name falls back to the start directory's basename, so an
  empty name still pins a title and the first message's automatic
  title cannot rename the session.

Acceptance check (verified in the browser):

- `＋ 新会话` (list header) and the shell's `新会话` button both open the
  dialog.
- The preset picker lists `跟随默认` + the shipped roster
  (`标准模式（默认）` / `PTC 模式` / `极简模式` / `创造模式`); picking
  `极简模式` shows that mode in the session header.
- Creating with a name lands in the sidebar under that name; creating
  with a custom directory creates the session in it; creating with no
  name lands under the directory's basename and keeps it after the
  first agent turn.
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
  for the same session seeds from the file tail, and the prompt-rewrite
  init restores that snapshot instead of emptying the log — truncating
  it wholesale (the first cut) erased the previous shell's scrollback on
  every harness restart, since the seed had already been loaded.

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

Goal: dshell owns the conversation surface without forking dsh's
layout. The stock `conversation.bar` composer stays in place — it is
dsh's InputBar, and dshell borrows it wholesale for its `/` | `@`
trigger popup, context-occupancy ring, model select, attachment
surface, and send/stop. dshell contributes exactly two entries into
the stock slot tree:

- `conversation.input.left` — the dual-mode chip (`$ shell` /
  `✦ agent`) plus the shell-mode hint.
- `conversation.view` (id `chat`, shadowed) — the PTY canvas takes
  over the stock chat cell rather than registering a sibling tab:
  the view preference falls back to `chat`, so the canvas is what
  renders there with no second view and no tab split. The canvas
  interleaves PTY output with session records (design 4.4) and long
  assistant/tool records render collapsed with a click-to-expand
  header. The terminal background is transparent so the canvas blends
  with the app surface instead of painting its own card.

The earlier attempt to shadow `conversation.composer.bar` with a
self-built dock was abandoned: it dropped every stock composer feature
(no `/` popup, no context meter, no model select) and left the page
layout to hand-written CSS overrides that fought the stock flex chain.
Borrowing the composer and adding slots keeps the stock layout intact.

Covers decisions: 4.1 (terminal-first surface), 4.5 (mode state),
4.8 (terminal layout).

Plugins touched:

- `dshell-mode` (browser face) — registers the mode chip, the canvas
  view, the `/shell` `/agent` slash source, and the Settings palette
  row. The per-session mode store (`shell` | `agent`, default `shell`)
  drives both rendering and input: in `shell` mode a capture-phase
  listener routes the composer's Enter (and its primary send button) to
  the bridge PTY and clears the stock draft through
  `inputActions.setDraft`; a leading `/` is always left to the stock
  trigger pipeline so `/clear`, `/new`, skills, *and* dshell's own
  `/shell` `/agent` keep working. In `agent` mode the stock submit path
  runs untouched.
  - `/shell` and `/agent` are **client-side** commands, not host
    `ctx.commands` rows: they flip a browser store, which no host
    handler can reach. Registered through `ctx.inputTriggers` as a `/`
    source (`name: 'dshell'`): menu rows in the `/` popup plus a
    `matchEnter` claim whose local `CommandClaim.submit` sets the mode
    and returns a notice — no RPC and no durable `command/run`/`done`
    pollution. `/terminal` stays a typed alias for shell; typed args
    (`/shell ls`) run immediately after the switch.
  - The palette picker is a `settings.general.item` row (Settings ›
    General), not a composer chip: four palettes write the module-level
    theme store, and the canvas view + mode chip read it through a
    `useSyncExternalStore` hook, so a palette change re-themes xterm in
    place.
- `dshell-conversation` (browser face) — registers the no-renderer
  `ConversationViewDefinition` on target `terminal` (`isActive` →
  `true`) and re-asserts `terminal` activation on every sessions-list
  and view-slot change. The shell hides the view-tab strip, so there is
  no user view choice to preserve and activation must not race the
  stock `chat` fallback.
- `dshell-workspace` (browser face) — hero chrome hiding
  (`heroWorkspaceRow`, `headline`), the hero composer bottom-pin, and
  the composer's input-line restyle: the stock card's 22px radius,
  surface fill, elevation shadow, and hairline stroke are stripped and
  replaced with a single bottom rule spanning the column (design 4.8).
  The old `[data-phase="active"]` overrides (including `viewArea
  { display: none }`) are gone: the stock active layout is where the
  canvas and composer belong. The `uiWorkspace` stub also implements
  dsh rc.1's added navigation actions (`openSession`, `openWorkspace`,
  `forkSession`) against the cwd-session model: selecting a session is
  the stock `open`, "open workspace" lands on the terminal-continuity
  blank session, and fork uses the session controller's `fork`.

Acceptance check (current state — see screenshot in conversation):

- New session creation opens straight into a full-column fused
  terminal: PTY scrollback fills the column above an input line pinned
  to the bottom, separated by one rule rather than a dialog card. The
  hero banner ("探索未至之境") and centered composer are gone.
- Shell input roundtrips: typing `echo hi` and pressing Enter sends to
  the main PTY; the next prompt appears in the scrollback above.
- Mode toggles: clicking the `$ shell` / `✦ agent` chip flips mode;
  typing `/shell` and `/agent` in the composer flips mode with a
  notice; the two commands also appear in the `/` popup under a
  "dshell" group.
- Model chip lists the shared directory and updates selection in
  sync with `/model`.
- Settings › General carries the "终端配色" row; picking a palette
  re-themes the canvas and the mode chip.

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
- **Focus follows mode (design 4.8), and the terminal chords work from
  both focus owners.** Shell mode focuses the xterm canvas so raw keys
  reach the PTY: `term.onData` forwards them while the mode ref says
  `shell`, so Ctrl+C arrives as `\x03` (SIGINT), and Tab / arrows /
  every readline key pass through untouched. `agent` mode blurs the
  canvas and focuses the stock composer editor. A 400 ms heartbeat
  re-claims the keyboard only when focus has fallen back to `body`
  (page load, a modal closing), never stealing a deliberate click.
  Because the composer is also an input line, its capture-phase router
  mirrors the terminal chords in shell mode: Ctrl+C clears the draft
  and sends `\x03`; Ctrl+Shift+C copies the canvas selection
  (`term.getSelection()` through the module-level live-terminal
  handle); Ctrl+Shift+V pastes into the PTY. The old dock's readline
  key mapping is gone — raw mode makes it unnecessary.
- **Selection is reverse video in the active palette.** xterm paints
  the selection with the theme's `selectionBackground`; the old
  12%-alpha accent was effectively invisible, and the *inactive* pair
  is what shows while focus sits in the composer. Both pairs now use
  the palette's `accent` for the highlight and `menuBg` for the glyphs,
  so a selection reads as part of the current theme (`森林` highlights
  green, `神秘` pink, …).
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
session events interleave as rule-marked rows (design 4.4).

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
  char width; the cell height comes from the rendered `.xterm-screen`
  (its height is rows × cell height), because xterm's own measurement
  is 16px where the probe's CSS line box is 15px. A ResizeObserver
  fits cols/rows from the container minus its computed padding and
  resizes the PTY. Trusting the probe overshot by a row or two, and
  the overflow was clipped — the live prompt vanished under the
  composer as soon as output filled the canvas.
  The theme maps the dock palette (bg/text/cursor/selection).
- `dshell-mode` (browser face, 4.4 merge) — `PtyCanvas` subscribes to
  the session's event window (`sessions.binding(id).eventSource`,
  retried until the binding materializes — it is `undefined` for a
  session neither listed nor scoped) and draws the agent's work as task
  blocks. One block covers one turn: it opens on the request (or
  `turn/start`, whichever comes first — a request adopts the empty
  block), splits when `todo/write` moves the `in_progress` item (a
  supervised phase), and closes on `turn/end` with a one-line notice at
  the timeline's tail (`✓ AI 回答完成 · N 步 · M tok · HH:MM`; `◼` for
  aborted, `✗` for failed). Rows inside a block keep their roles: `你`
  (user), `AI` (assistant), `⎿ 思考过程` (reasoning), `→ <tool>`
  (call), `← <tool>` (result), `⚡ 命令` (command run/done).
  A collapsed block is **exactly three lines** — a status header plus
  the newest two content lines — and that fixed height is the contract:
  while the model is still writing, the block is repainted in place
  (`ESC[s` → CUU → rewrite each row with `ESC[K` → `ESC[u`), so the
  shell's rows below never move. The repaint is skipped when the view
  is scrolled away or the block is off-screen; the next full replay
  corrects it. Clicking a block unfolds it to every row (each row keeps
  its own fold and click identity) through a full replay, and clicking
  again folds it back. Live `assistant/live-chunk` transients
  (`text-delta` / `reasoning-delta`) feed a streaming row at the block's
  tail, coalesced to ~80ms and dropped on `settle-assistant` or the
  durable `assistant/message`, so progress shows during a step instead
  of only between steps.
  Each block's rule is a CSS band painted per buffer row
  (`paintGutter`, repainted from `onRender`), not the `┃` glyph: a
  stacked glyph inks ~14px of the 16px cell and reads as a dashed line,
  while the band fills the row box and stays unbroken across blank
  lines and column re-wraps. The gutter only reads as a separator when
  no glyph ever reaches it, which takes three rules: every logical line
  is hard-wrapped to `cols - 2` and indented, so xterm's soft wrap
  never restarts a continuation at column 0 under the rule; a block
  starts on its own line whenever the pty did not end its last line
  with `\n` (a bare `\r` means readline still owns that line and will
  erase it); and row text is sanitized — captured terminal output
  carries real `\r`s that otherwise rewind to column 0 and overwrite
  the row's own indent and fold hint. Window `replace`/`prepend`
  replays the merged timeline (pty chunks + blocks, stable sort by
  time, pty first on ties) and anchors the event watermark at the
  window's newest seq, so an append can never re-fold history into
  duplicate blocks. A pty replay chunk schedules one coalesced redraw
  (~150ms) and suppresses block appends meanwhile, so a command's rows
  never interleave with the prompts its wipe just printed. Reload
  replays the persisted window the same way. The pty side of that merge
  is timed by arrival frames, not by the replayed chunk: a bind replay
  is a single frame, so timing it by the chunk would drag the whole
  scrollback to the bind moment and bunch every shell record after
  every block. Each live frame's `(time, length)` is persisted per
  session in localStorage, and the replayed text is sliced back into
  timed segments from the end (`segments()`); a resync trims the
  timeline to what the replayed text still covers, and a session this
  browser never watched falls back to its raw chunks. Verified in
  `block-test`: shell output injected between two turns keeps its place
  across a reload.

Blocks as the view's primary unit (in progress). The single-canvas
surface caps presentation at the character grid — per-cell colour, no
rounded corners, no element-level type, no hover states. The block view
(`block-view.ts`, registered as a sibling `conversation.view` tab
labelled 块视图) makes a DOM column the surface, and a block is a
*stretch of the session*, not a command:

- Everything the terminal printed between two agent tasks is one shell
  region, rendered by a real xterm (`block-terminal.ts`) with no chrome
  of its own: PS1 line, command echoes and output exactly as the shell
  produced them. Regions are cut by wall-clock task boundaries
  (`splitByTime` in the bridge), so a stretch spanning several tasks is
  split between them and interleaving survives — verified live with a
  shell/agent/shell/agent run yielding `S A…A S A S A`.
- An agent task is a card: coloured, labelled rows in the canvas's own
  role palette, a two-line preview folded, every row expanded, and its
  closing line.
- The seat mirrors the canvas's view shell. Its scrolling column is
  absolutely positioned so it contributes no intrinsic height — without
  that the view area grows to content and the composer lands on top of
  the output (522px view area vs a composer starting at 604px).

Dropped along the way: slicing shell output per command. A block per
`OSC 133;D` run gave every command a synthetic header card and destroyed
the terminal's own design; the marker scanner and its `commands()` API
were removed again.

Still open: terminal input parity (the canvas owns `onData` for Tab,
arrows and Ctrl+C, so interactive shell work still needs that tab),
full-screen programs (PTY rows follow the seat, but a region renders at
its own content height), per-row folding inside an expanded task card,
and virtualizing long sessions.

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

## Phase 7 — Terminal context management (cursor + command records)

Goal: agent turns carry the main shell's activity **incrementally** — only
what the model has not seen — and the agent can look back at commands on
demand.

Covers decision: 4.6 (injection).

Plugins touched:

- `dshell-terminal-bridge` (host face) — the bridge now owns a per-shell
  **absolute cursor** on top of the PtyBuffer window:
  - `absOffset` counts every appended byte and survives window trims, so
    an offset means the same thing after retention slides;
  - a pure splitter (`commands.ts`) joins the two streams the bridge
    already sees — the input it forwards to the PTY and the raw output —
    into `{command, exitCode, output}` records. Bash's own
    `OSC 133;D;<code>` prompt marker (already installed by the init PS1)
    closes each record; input is assembled through backspace / Ctrl+C /
    Ctrl+U / CSI handling. Untracked commands (history recall, an
    external writer) still yield a record with empty `command` and real
    output;
  - `since(sessionId, cursor?)` returns the delta: sanitized text,
    commands closed since the cursor, `dropped` when retention slid past
    the request, `cleared` when the cursor belonged to an earlier
    **generation** (respawn or `/clear` take a fresh generation);
  - `history(sessionId, limit)` returns the latest retained commands;
  - both never spawn a shell, so subagent and never-opened sessions stay
    context-free.
- `dshell-mode` (host face) — keeps a per-Agent **watermark**. On
  `agent/pre-step`, a step carrying a genuine `source.kind === 'user'`
  message injects one plugin-sourced (`form: 'notice'`, summary
  "主终端增量") message with the command summary and the sanitized new
  output, then advances the watermark. A first read (no watermark)
  delivers the retained window once; a stale cursor (`cleared`) advances
  and injects nothing, so a respawn never replays the seeded scrollback.
  Output is capped at 8 KiB, kept from the newest end.
- `dshell-commands` (host face) — `dshell_terminal_read({cursor?, limit?,
  includeOutput?})`: without a cursor, the latest commands; with one, only
  what happened since. The tool result ends with the new cursor so the
  model can continue from it.
- `dshell-mode` (browser face) — filters `user/message` events whose
  source is not `user` out of the canvas row extractor, so injected
  context and guard notices never paint as fake `你` rows.

The old whole-tail snapshot (re-sent every turn, escaping control codes
and prompt markers into the prompt) is gone. The Phase 7 client-side
deviation (a fence prepended to the user's own message) stays gone:
injection is host-side at the step, where the message source is durable.

Acceptance check (verified end-to-end with a live model):

- `echo ctx-one` then `pwd` in shell mode, then an agent turn: the
  durable log shows one injected block listing exactly those two
  commands with exit codes and sanitized output (no `\u001b]133;D`
  markers, no `\r`).
- A second command + turn injects only the new command — no repetition
  of the first block.
- `dshell_terminal_read` called by the model returns the command records
  plus a `g<generation>:<offset>:<seq>` cursor.
- The injected block does not appear as a user row in the canvas.
- 12 pure-function checks cover the splitter and window math:
  `pnpm tsx packages/dshell/terminal-bridge/scripts/check-commands.ts`.

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
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

Blocks as the view's primary unit. The single-canvas surface caps
presentation at the character grid — per-cell colour, no rounded
corners, no element-level type, no hover states. The block view
(`block-view.ts`) makes a DOM column the surface, and a block is a
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

The block view occupies the stock `chat` view cell (same id, lower
priority), which is `DEFAULT_VIEW_ID` in
`ui-conversation/src/client/view-selection.ts`. That placement is
load-bearing, not cosmetic: a sibling tab is reachable only through a
stored view selection, and dshell hides the tab strip, so while the
canvas held `chat` a fresh session silently opened the old surface.

The canvas is now deleted — `canvas.ts`, its `DshellTerminalView`, the
ANSI block renderers in `blocks.ts` (`blockSegments`, `renderNotice`, the
gutter/colour helpers) and `activeTerm`, which existed only so the
composer could copy the canvas selection. The block view is the only
conversation surface.

How the block view stays live (each of these was a visible defect before it
was written down):

- **Streaming.** The event window delivers the model's partial answer as
  client-only `transient` entries (`assistant/live-chunk`); the durable
  `assistant/message` only lands when the attempt settles. The view folds the
  deltas into `TurnBlock.stream` and drops that line the moment the message
  arrives (`settle-assistant` carries it), so the answer grows token by token
  and is then replaced in place rather than duplicated. The fold is advanced
  incrementally with a durable watermark and renders on one `requestAnimationFrame`
  at most, instead of re-folding the whole window per event.
- **A sent message is on screen immediately.** The durable `user/message` is
  appended when the first step begins — measured at 8–11 s after `turn/start` on
  this route — so waiting for it left the request invisible for that whole
  window. Three sources cover the path, all keyed by prompt id (`rpcId`) and all
  retired by the durable row: the durable `agent/inbox/spliced` event (the host
  admitting the prompt, ~1 ms after the turn opens), the host queue, and the
  client's local submission echo (`beginSubmission`). A rejected prompt clears
  them via `promptError`.
- **A shell region renders at the width its output was produced at.** The grid
  spans the column and widens only as far as a *redraw* needs (a stretch drawn
  and then drawn again), measured by simulating the cursor column: `\r` and
  `ESC 8` rewinds are what move a repaint's origin, while a long echoed line that
  merely ends with a carriage return is left to wrap. Without this a padded
  progress bar stacked one row per repaint. The PTY itself is
  driven to the same width, so this normally matches; see Phase 9.6 for the
  resize path.
- **The font size is one value for the whole view.** A session's PTY width
  changes over its life — it starts at the backend's default and is resized to
  the column once the view measures one — so historical regions legitimately
  hold lines printed at a different width than today's. Scaling each region's
  font to fit its own widest line rendered those stretches at different sizes in
  the same view (13px for the ones at the column's width, 9px for the ones
  printed wider), which reads as a broken terminal rather than as history. Every
  region now renders at the base size, and a grid wider than the column scrolls
  horizontally instead: correct redraws are unaffected, since the grid is what
  keeps them on one row, not the font.
- **Regions update in place.** A region's React key is its identity alone: keying
  it by the PTY version remounted every terminal on every output chunk, which
  threw away its scroll position and re-parsed the whole region per frame.

Still open: terminal input parity (`onData` for Tab, arrows and Ctrl+C
had no owner once the canvas went: shell input goes through the composer,
so interactive full-screen programs still need a terminal that owns the
keyboard), full-screen programs (PTY rows follow the seat, but a region
renders at its own content height), per-row folding inside an expanded
task card, virtualizing long sessions, and image attachments on a
not-yet-durable bubble (its text shows, its previews do not).

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

## Phase 9.5 — Session panel (archive + purge)

Goal: the sidebar can put a session away and remove one.

Shipped:

- Archive is a dshell-owned durable tag (`$DSH_HOME/dshell/tags.json`),
  rendered as the collapsible `已归档` group; dsh's own archive lives on
  the disabled workspace registry, so it is unusable here.
- Purge removes the session directory, its projection-cache entry and
  the dshell PTY log plus sidecars (`dshell-workspace/src/purge.ts`),
  and frees the session's shell via
  `DshellTerminalBridge.releaseSession`.
- Both travel over one exact `/api/dshell/sessions` route behind dsh's
  own trust fence, not the Typert Remote table (whose client artifacts
  are generated from dsh's packages).

Hard-won constraint — a *loaded* session cannot be deleted immediately:
dsh discards the only teardown capability at
`packages/api/session-controller/src/agent.ts` (`(await
ctx.agents.resume(...)).agent` throws the `AgentHandle` away), and
`SessionStore` exposes no per-session detach. So while a session is in
`ctx.sessions`, its log writer stays open and would recreate a deleted
directory on the next event. The delete branch therefore has three
outcomes: running → refused; loaded-and-idle → terminal released now,
log removal scheduled and executed at the next start (before any client
can resume); cold → purged immediately.

## Phase 9.6 — SSH device sessions

Goal: a session can run on a remote device instead of this machine.

Shipped:

- `dshell-ssh` (new host+client package): a durable device registry
  (name, host, port, user, remote directory, login method) whose secrets
  are separate 0600 files under `$DSH_HOME/dshell/ssh/keys/`, a card in
  the Plugins settings section to add/edit/test/delete them, and a durable
  session→device assignment chosen in the new-session dialog (the row then
  reads `名称 ⌁ 设备:远端目录`). The dialog asks for the run target first —
  a 本机 / SSH 设备 slider — and only shows the device list once SSH is
  chosen, with a 远端目录 field beside it (it follows the device until the
  user types their own). An SSH session's local directory is not the user's
  to choose: it is the mount directory described below.
- Login method is per device: `key` (stored private key, or the harness
  user's own agent/config when none is stored) or `password` (stored
  0600, handed to ssh through OpenSSH's askpass hook — ssh has no password
  flag, and the secret never appears in a command line).
- Routing: `ctx.shell.resolve` is wrapped, so a bound session's shell
  commands are rewritten to `ssh … 'cd <dir> && exec bash -lc <command>'`
  and the stock executor keeps owning timeouts, caps, streaming,
  background handles and cancellation. The target is resolved per call
  from `ctx.agents.currentInitiator()`, so nothing about tool signatures
  or registrations changes.
- The local hop runs unconfined (`danger-full-access`): the session's
  access mode describes THIS machine, and confining the `ssh` client
  would deny it the network while the command that matters executes
  under the device's own policy.

Verified live against a private sshd on 127.0.0.1:2222 with its own host
and client keys: a bound session's `echo $SSH_CONNECTION` returns the
tunnel's addresses, an unbound session returns nothing.

Shipped since (the session now works in ONE place):

- The **mount directory**: a bound session's own directory is a local,
  empty directory standing in for the device tree
  (`$DSH_HOME/dshell/mnt/<device>/<remote path>`), and `remoteRoot` +
  `mount` travel together in the binding. The harness owns the session
  directory — it creates it at session creation and reads it later for
  instruction files, project discovery and sandbox roots, all locally — so
  a remote path fails those reads (EACCES on `/root/.git`) and a
  coincidentally existing local path would silently be the wrong tree. An
  empty local directory satisfies every one of those readers while
  claiming nothing: the `.git` walk finds no marker and stops at the
  session directory instead of reaching upward. This is why no preset has
  to be forked.
- **`ctx.fs` is dshell's provider**: loaded in place of the stock
  `fs-sandbox` row and extending it, so an unbound session's calls are the
  stock implementation verbatim while a bound session's
  resolve/stat/read/list/write/edit run on the device over ssh
  (`RemoteFileSystem`). Dispatch is by `ctx.agents.currentInitiator()`,
  the same ambient signal the shell seam uses, because a filesystem call
  carries no session field. The literal-edit and line-ending rules are
  mirrored in `literal-edit.ts` (the local backend exposes them only
  through its source subpath, which an emitting build cannot import) and
  the per-call sandbox mode is enforced against the device's own tree.
- **`ctx.subprocess.spawn`** is wrapped for the search tools: `glob`/`grep`
  spawn ripgrep directly rather than through `ctx.fs`, so a bound session's
  `rg` run is rewritten into `ssh … 'cd <dir> && exec rg …'`. Paths need no
  translation — ripgrep prints them relative to the directory it ran in,
  and a relative path means the same place to the session's file
  operations. The shell path is deliberately not re-routed here (it is
  already an `ssh` line). **The device needs `rg` on PATH**; a missing one
  fails with a message that says so (install ripgrep on the device, or the
  search tools have nothing to run).
- **Connections are multiplexed** (`ControlMaster`, one socket per
  destination under `$DSH_HOME/dshell/ssh/ctl/`): one file read is a
  resolve, a stat and a cat, and a fresh connection each time costs a full
  handshake and authentication.
- The new-session dialog keeps the run target visible when no device is
  registered (hiding it made SSH undiscoverable exactly when it was
  needed) and links to Settings → 插件, scrolled to the device card. That
  jump is best-effort — the settings panel keeps its open state and
  selected section in component state, so its own controls are the only
  way in — and falls back to naming the path.

Verified live against the same private sshd: a bound session's relative
`read` resolves to the device's file while the local mount directory stays
empty, a relative `write` lands in the device's tree, and `grep` over `.`
returns the device's files (the mount is empty, so those results could only
come from the device). An unbound session's `read` and `glob` are unchanged.

The visible terminal, too:

- The main PTY now runs the **device's** shell when the session is bound:
  `DshellPtyBackend` asks for a spawn plan per session, and dshell-ssh hands
  it `ssh … -t 'cd <dir> 2>/dev/null || echo …; exec bash -l'` (with the
  askpass environment for password logins). The local pty is unchanged — the
  harness spawns `ssh` inside it, so line discipline, resize and Ctrl+C stay
  local while the remote shell gets a tty of its own. Interactive commands
  verified on the device (`pwd`, `hostname` → `VM-0-6-ubuntu`, `whoami` →
  `root`), and an unbound session's terminal is still the local shell.
- The plan is resolved by **session identity** (`spec.owner.id`), not by
  directory: one device tree's mount directory is shared by every session
  bound to that device and root, so a directory match cannot tell a bound
  session from an unbound one whose cwd merely looks like a mount — and the
  latter would get a device shell it has no binding for. The resolver may also
  *wait* briefly (≤1s) when the session's cwd is already a mount path but its
  assignment has not landed yet, because creating a session and recording its
  binding are two round trips and the terminal can attach in between.
- The `cd` is tolerant and the remote root is created **before** the binding
  is recorded: the assignment is what makes a session routable, so a binding
  that exists must imply the directory exists. Without that ordering the shell
  spawned in the window between the two, failed to `cd`, and silently landed
  in the login directory.
- Consequences worth knowing: PS1 and PROMPT_COMMAND are still rewritten by
  the bridge right after startup, so a remote prompt looks identical to a local
  one (that rewrite is also what drives the send settle); an unreachable device
  fails the terminal spawn instead of quietly falling back to a local shell;
  and a terminal's first prompt is pushed as a snapshot when it opens a block,
  so a brand-new session renders immediately instead of staying blank until
  the next reload.

Not routed yet:

- The persona's prompt variable `{{cwd}}` still renders the session's own
  directory, which for a bound session is the mount path. Overriding it
  needs a per-agent registration (`ctx.agents.get` returns a bare agent and
  the variable is registered per agent by the agent loop), so the honest
  fix is a dshell-owned preset row — the one place a preset fork would pay
  for itself.
- Remote instruction files and project skills are not loaded: the mount
  directory is empty by design, so `agent-instructions` and
  `skill-filesystem` find nothing there. The model can read them with the
  file tools, which now work on the device.
- `@`-file references index the empty mount directory, so a bound session
  gets no candidates until file-reference search has its own seam.
- Remote commands assume a POSIX/GNU userland (`stat`, `realpath`, `find`,
  `mktemp`, `chmod --reference`).

## Phase 9.7 — Connection failures and reconnection

Goal: a device session that cannot connect says so, in the right place, and
offers the one action that can fix it.

Before this phase the failure was silent in three separate ways: a failed
`bind` was published on the snapshot and never thrown, so the new-session
dialog closed over a session that had no assignment and whose directory was a
device mount (its shell — and the agent's `bash` — then ran on the local
machine inside an empty stand-in directory); a shell that died during startup
lost ssh's own stderr with the discarded session and reported only "the shell
exited"; and the browser retried the socket every two seconds forever, which
is indistinguishable from a hang.

Decisions:

- **The connection is proved before the session exists.** The dialog runs one
  real ssh round trip (`test`) *plus* the session's remote directory
  (`ensureRemoteRoot`) before `createSession`. A device that answers but
  cannot host the directory is therefore a refusal in the dialog, not a broken
  session later. `SshClientService.send` gained a `strict` mode so
  `test`/`mountFor`/`bind` throw while the settings card keeps rendering the
  published `error` (its Test button catches, since the refusal is already on
  screen).
- **The host classifies the death, because only the host can.** A device
  session's "cannot connect" is an `ssh` process that printed a line and
  exited; node-pty reports an exit code only. So `markDead` ships
  `{reason, detail, ready}`: the reason from the exit (signal first, since
  node-pty calls a SIGHUP `exitCode: 0`), the last ssh diagnostic found in the
  output (`diagnosticTail`, patterns only — a line that is not a diagnostic is
  never presented as the cause), and `ready`, whether that shell ever reached
  a prompt (the init send settles only once the shell answers).
- **`ready` decides which of two presentations a failure gets.** A shell that
  *had* reached a prompt gets a marker appended after the output the reader was
  looking at; one that never did has nothing to append to, so it gets the
  intermediate screen. `connectionView` in the mode client is the single place
  that turns `{status, ready, attempt, bound}` into one of `none | panel |
  notice`, and untested branches (a local session's first bind) render nothing
  at all rather than flashing a panel on every session switch.
- **Reconnection is bounded and visible.** The client spends at most three
  automatic attempts (1s / 2s / 4s) on whichever layer is broken — a live
  socket means the shell died, so the host is asked for a new one with a new
  `reconnect` frame; a dead socket is reopened — and then stops and says so
  ("自动重连已停止（3 次均失败）"). The button (`PtyStreamService.reconnect`)
  clears the budget and tries immediately, which is also the only way out of
  the exhausted state.
- **A spawn failure no longer closes the socket.** `bindClient` keeps the
  client bound and answers with an `error` frame instead of `close(1008)`;
  closing threw away the connection the retry needs and made the client
  reconnect into the same wall.
- **No silent local fallback.** `interactiveShellPlan` and the shell seam's
  `resolve` now refuse a session whose directory is under the mount base but
  which has no assignment, naming the reason. That state is reachable by
  deleting a device, and previously produced a local shell (or local `bash`
  tool calls) inside an empty directory that looks like a working terminal.
- **The dialog stops inheriting a mount.** Clearing the directory field was
  not enough: dsh then inherits the *current* session's cwd, which can be the
  mount the dialog just refused to prefill. The list now offers the most recent
  non-mount directory, and a local session with an empty directory that would
  inherit a mount is refused with the reason.

Acceptance check (driven from the browser):

- A device pointed at a closed port: the dialog reports
  `ssh: connect to host 127.0.0.1 port 9: Connection refused`, stays open, and
  no session is created.
- A session that never connected (page reloaded while the device is down) shows
  the centred screen — `⚠ 无法连接到 <device>`, the ssh diagnostic,
  `已自动重试 3 次均未成功。`, 重试连接 / 去设置 — and nothing behind it.
- A session that *had* a working terminal and lost it gets the red marker at
  the end of its output (`连接已断开 · <reason>`, the diagnostic, the retry
  count, then the exhausted line), with the scrollback intact above it.
- Restarting the device and clicking 重试连接 brings the terminal back at the
  same place in the history; a local session shows neither treatment.

## Phase 9.8 — Cross-session pipe

Goal: one session's agent can hand a task to another session's agent, wait
without blocking, and get an outcome back — with the files it opens to the
other side scoped and automatically reclaimed.

Shipped:

- `dshell-buffer` (new host+client package): a durable link between two
  sessions that **only the user** can create (there is no agent-facing
  linking action at all), a deferred-request queue with claim / progress /
  finish / fail, and scoped revocable folder grants.
- The pipe panel enters the frame-wide `shell.overlay` seat, opened from the
  sidebar header — the duplicated `＋ 新会话` button there becomes `管道`
  (the stock shell already offers session creation). A composition without
  `dshell-buffer` keeps the original button.
- The wait semantics follow the one constraint dsh imposes: **a turn cannot
  be suspended and resumed**. So `delegate` returns a ticket id immediately
  and the requester's turn ends naturally; when the ticket settles, the
  buffer delivers a new message that reopens the turn — the same
  completion-delivery policy dsh's own job registry uses (idle → `followup`,
  busy → `inject`).
- Reachability is checked, never guessed: `ctx.sessionController.resolveAgent`
  is dsh's own resume path, and a device-bound target is probed over its SSH
  connection before admission, so an unreachable target is refused with the
  real reason instead of timing out later.
- Nothing can wait forever: a ticket past its deadline is settled `timeout`
  by the host watchdog, a disposed worker session settles its live tickets
  `failed`, and every settlement path wakes the requester.
- Grants are directories in the **granter's** namespace, resolved as the
  granter (so a device session's tree is read over its own route), with
  containment checked on the canonical target keys — `..` and symlinks in a
  request cannot escape the granted area. A write is fenced by the granter's
  own sandbox policy, so a grant can never widen it.
- Grants are reference-counted by unsettled tickets: count 0 revokes
  immediately, and the panel's 回收 button is the manual escape hatch.
- **Transfer** moves one file, bytes intact, between the granted area's
  execution world and the caller's own. `ctx.fs` has no byte write (both
  its mutations take text), so the bytes ride base64 on the `ctx.shell`
  seam's stdin and the destination world's own `base64 -d` decodes them.
  That seam rather than a new filesystem method because it already routes
  per initiator — a device session decodes on the device with no new
  transport — and it already fences the run by the session's resolved
  policy, so a transfer is bounded exactly where `writeText` is. With no
  `dest` the file lands at the same relative path, i.e. the corresponding
  location in the other world; binary files travel, which read/write
  cannot carry. `side="from"` needs read, `side="to"` needs write, and
  one call is capped at 8 MiB by default (32 MiB hard cap).

Model experience: one `dshell_buffer` tool with five families of action
(links, ticket lifecycle, the grant view, granted file access, transfer)
plus one system-prompt section stating the protocol — delegate
asynchronously, never wait, and always settle a request you received.

Acceptance check (driven from the browser, two local sessions):

- The `管道` button opens the panel; two sessions are connected there and the
  connection survives a reload.
- A `delegate` in one session wakes the other with a framed request; `tickets
  direction="in"` shows it, `claim` / `progress` / `finish` advance it, and
  the requester receives the result as a new message.
- A request nobody answers, with a short `deadline_ms`, is settled `timeout`
  and the requester is still woken.
- A grant is visible to the grantee with the granter's description, areas and
  remaining count; `read` returns the granter's file text, `write` writes
  back, and a path outside the granted area is refused.
- `transfer` pulls the granter's file to the grantee's machine and pushes it
  back, byte-for-byte including a binary file, with no `dest` landing on the
  same relative path; a source over `max_bytes` is refused, and `side="to"`
  without a write right is refused.
- Settling the ticket removes the grant from `grants` and from the panel.

## Phase 9.9 — Unbounded file navigator

Goal: the right sidebar's file pane moves like a file browser — up with
`..`, sideways through clickable path segments, back and forward through
visited directories, and on a device session through the **device's**
tree, all the way to `/`.

Shipped:

- `dshell-files` (new host+client package). The host face adds one
  connection route, `/api/dshell/files`, action `list`: it resolves the
  session's agent, then inside `withInitiator` — so a device session
  lists over its own SSH route with no new transport — resolves the
  target, requires it to be a directory, and answers with the canonical
  absolute path in that world plus the entries and a `truncated` flag.
- Why a dshell route rather than dsh's `workspaceFiles.list`: that
  endpoint is deliberately fenced to the session's workspace root
  (`workspace-file/outside-workspace`), and the request was to walk to
  `/`. `ctx.fs` is the same seam underneath without the fence, the
  sandbox fences only writes, and `toRemotePath` passes an absolute path
  outside the mount through unchanged, so `..` out of the mount on a
  device means the device's own `/`. Listing is therefore at the same
  trust level as the `read` tool, which already reaches outside the
  workspace.
- The browser face registers its own `SidebarRightTabDefinition` for the
  `files` kind at `priority: 'extension'`. dsh is built for this: an
  extension-band definition shadows the builtin of the same kind, the
  pane's keyed seat switches to the extension's id, and removing the row
  restores the stock body. The definition also contributes the required
  guide entry, which is what keeps the pane's default page — the seed
  takes the sole guide entry's kind.
- Interaction: a `..` row drawn like a folder (hidden at `/`), single
  click on a folder still expands or collapses it, double click on a
  folder makes it the new root, double click on `..` goes to the parent
  as an ordinary navigation (so back returns), a file click still opens
  the preview, clickable path crumbs jump anywhere on the path, and
  `←` / `→` / `⟳` drive history and reload. Two clicks on a folder
  cancel out, so no double-click delay is imposed on expand.
- Navigation state (root, history stack and index, per-path level cache,
  expanded set) lives in a declared per-session store bucketed by tab
  id, because the pane mounts only the active tab's body while the store
  outlives tab switches. Forward history is truncated on a new
  navigation, browser-style; a revisited level draws from the cache.
- Listings are generation-guarded per (tab, path) so the latest request
  wins, and the tab record's abort signal ends a bucket: no request is
  made for a dead tab and no late settlement writes to one.
- One listing is capped at 1000 entries with a `truncated` notice, and
  failures are graded by cause (missing / not a directory / permission /
  other). Read-only: no delete, rename, or create.
- A jump button left of the reload button sends the session's shell into the
  directory on screen, so browsing to a place and working there are one
  gesture. It has to be input, not a command: a shell's working directory is
  process state, so a command run through the shell seam would not move the
  interactive shell. The line goes to the terminal bridge's own input path —
  the same one a keystroke takes — so it is tracked and rendered like any
  command the user types, and it is the canonical path of the session's own
  world, so on a device session the device's shell cds on the device. The
  listing carries `canCd` so a composition without the bridge draws no button
  rather than a dead one, and a refused jump says why in the pane, because the
  shell moves off-pane and would otherwise look like a dead click.
- Directory rows and the `..` row are also drag sources: dropping one on the
  terminal runs the same jump. It is **pointer events, not HTML5 drag and
  drop**. A native drag session is a black box — when the drop is refused there
  is no event to observe and no handler to correct, only the "no drop" cursor,
  which is exactly what a real mouse hit here (the drag started, carried the
  right payload and reached the terminal, and the browser still refused the
  drop; nothing in the page or in dsh could account for it). Pointer events
  carry the same gesture with nothing to arbitrate: the press, the move and the
  release are the pane's own, the target is decided by where the pointer is,
  and touch and pen work by the same code. The gesture stays a click until it
  moves past a threshold, so one click still expands a folder and two still
  open it. The pane installs the listeners while it draws a tree whose host can
  drive a shell; the terminal view gets an outline and the page cursor says a
  drop is possible, and both are put back when the gesture ends. File rows are
  not drag sources — there is no directory to jump to.

Acceptance check (driven from the browser):

- The right sidebar's file tab draws the new pane with its chip and its
  guide capsule, and the stock file tree is not reachable.
- `..` walks from the session's working directory to `/`; the row is
  absent at `/`; a path crumb jumps to that ancestor; double-clicking a
  folder inside current root makes it the root, and `←` returns.
- Single click still expands a folder, a file click still opens the
  preview, `⟳` re-lists the current root, and switching to another tab
  and back keeps the current directory.
- In a device session the same pane lists the device's tree — entering
  `/etc` proves the listing was inherited from the session's routing.
- The jump button sits between the path and the reload button; on the local
  session it moves that session's shell to the directory on screen, and on the
  device session the device's shell — the prompt's own `cwd` report moves with
  it — while the command shows up in the session's terminal record like a typed
  one.
- Dragging a directory row onto the terminal moves the shell there too, with
  the drop area outlined while the pointer is over it and the cursor changed
  until the release; releasing the same row over the sidebar does nothing at
  all, and file rows cannot be dragged. The folder still expands on one click
  and still opens on two — the drag is the only thing the pointer tracking
  adds.

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
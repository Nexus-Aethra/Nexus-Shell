# dshell Plugin Inventory

This document lists every package that dshell introduces. Each entry
states its role, the dsh service it depends on, and the phase in
[`dshell-roadmap.md`](./dshell-roadmap.md) that brings it in.

All packages follow the dsh monorepo conventions laid out in
[`docs/cookbook/adding-a-package.md`](../../dsh/docs/cookbook/
adding-a-package.md): each lives under `packages/<group>/<pkg>/`, has a
`package.json` with `dsh.bundle` (where applicable), exposes a default
Cordis plugin, and ships a `README.md` with the Model Experience section
when it contributes to model-visible state.

## Naming

- Host-side packages: `@deepseek-ai/dsh-*` names follow the dsh
  convention. The dshell packages live in the `dshell` group and use
  `@deepseek-ai/dsh-dshell-*` to match the existing `@deepseek-ai/dsh-*`
  pattern.

  Pragmatic note: until a dsh contribution slot is open, the dshell
  packages live in this separate workspace and use a different name
  prefix (`dshell-*`) so they are unmistakable as the dshell extension
  set.

- Each package name uses one dash-separated role token after `dshell`:
  `bundle`, `conversation`, `terminal-bridge`, `mode`, `commands`,
  `workspace`, `ssh`, `buffer`.

## The packages

### `dshell-bundle`

- Role: dsh `bundle` package that lists every other dshell package as a
  Cordis patch row. This is the single install point — users add this
  package and dshell comes online.
- dsh services depended on: `dsh-web-app` (or whichever profile is in
  use) — bundle patches land on the active profile.
- Introduced in: Phase 1.
- Touches decisions: none directly; exists to satisfy dsh's bundle
  composition.

### `dshell-conversation`

- Role: the `terminal` target. Two-faced Cordis package:
  - **Host face** registers a `ConversationViewDefinition` for target
    `terminal`. Its `ViewBuilder.create()` returns a builder that
    consumes both `replace` / `apply` from the dsh engine (session
    events) and the PTY byte stream from `dshell-terminal-bridge`.
    Merge happens in the Snapshot per design 4.4.
  - **Browser face** materializes the Snapshot into one xterm.js
    buffer. Session nodes are serialized to ANSI sequences; PTY bytes
    pass through verbatim.
- dsh services depended on: `ctx.uiConversation.events`,
  `ctx.uiConversation.views`, `ctx.uiSession`, browser-side xterm.js.
- Introduced in: Phase 1 (host empty); expanded in Phases 2, 4.
- Touches decisions: 4.1 (per-session ViewBuilder), 4.4 (interleaved
  rendering).

### `dshell-terminal-bridge`

- Role: host-side bridge between browser ws and `ctx.terminals`. Owns
  one `main` PTY per session (the user's shell) and, spawned lazily,
  one `agent` PTY (the agent's own shell, Phase 9.11), each with its
  own persisted buffer and block log. Exposes the ws upgrade route at
  `/dshell/pty`, where a `bind` frame names the stream (`main` or
  `agent`). Implements the wire protocol in `dshell-design.md` § 5.
- dsh services depended on: `ctx.webServer` (upgrade route),
  `ctx.terminals` (PTY lifecycle), `ctx.agents` (resolve agent by
  sessionId), browser-side `dshell-conversation` (channel for byte
  push).
- Introduced in: Phase 2 (host only); expanded in Phase 3 (browser
  ws), Phase 9.11 (agent shell + agent stream).
- Touches decisions: 4.2 (main shell ownership), 4.3 (secondary pass-
  through), 4.4 (host half of byte stream), 4.10 (two shells per
  session).

### `dshell-mode`

- Role: per-session mode state (`shell` / `agent`) and composer Enter
  dispatch. Patches the `inputActions` exposed by
  `ctx.uiSession.provide()` to route Enter according to mode. Handles
  `/agent` and `/shell` prefix parsing. On agent-mode submit, injects
  the truncated PTY context block before the user message. Its view
  also carries the status card (Phase 9.11): a permanent one-line head,
  with plan / AI terminal / subagents / sessions / link rows whose
  details open on click.
- dsh services depended on: `ctx.uiSession`, `ctx.agents.inject`,
  `dshell-terminal-bridge` (for main PTY id, the agent stream and
  context buffer read), `ctx.sessions` (the status card's session and
  subagent rows).
- Introduced in: Phase 5 (state and dispatch); expanded in Phase 7
  (injection), Phase 9.11 (status card).
- Touches decisions: 4.5 (mode state and prefix handling), 4.6
  (injection), 4.10 (status surface).

### `dshell-commands`

- Role: registers `/clear`, `/new`, `/compact` on `ctx.commands`, and
  one model-facing tool `dshell_get_agent_terminal` on `ctx.tools`
  (Phase 9.11; it was `dshell_get_main_terminal` while the agent shared
  the user's shell).
- dsh services depended on: `ctx.commands`, `ctx.tools`,
  `dshell-terminal-bridge` (for the agent shell's PTY id returned by
  the tool, and the read-only view of the user's shell).
- Introduced in: Phase 6 (commands); expanded in Phase 8 (tool),
  Phase 9.11 (own shell).
- Touches decisions: 4.5 (real commands), 4.6 (agent access to a PTY
  id), 4.10 (agent-owned shell).

### `dshell-workspace`

- Role: removes dsh's workspace concept from the running shell
  (design 4.7). Two-faced Cordis package:
  - **Host face** provides a `workspaceRegistry`-keyed stub covering
    the surface `session-controller` consumes, so the stock row
    `workspace` can be disabled without hanging the host boot.
  - **Browser face** provides `workspaces`- and `uiWorkspace`-keyed
    stubs plus the root `workspaces` hook, so the stock row
    `ui-workspace` can be disabled without hanging ui-conversation /
    ui-sidebar or crashing ConversationRoot. It also occupies
    `sidebar.workspaces` with a flat session list, adds the
    new-session dialog (optional name + starting directory, design
    4.7 naming paragraph), and hides the stock hero workspace chip
    with an interim stylesheet until the Phase 4 scaffold takeover
    (design 4.8) removes the whole hero.
- dsh services depended on: none beyond the replaced keys; it
  *provides* `workspaceRegistry` (host), `workspaces` + `uiWorkspace`
  (client).
- Introduced in: Phase 1.5; dialog in Phase 1.6.
- Touches decisions: 4.7 (workspace removal) and indirectly 4.5 —
  `/new` creates sessions via `sessions.create({ cwd })` with no
  workspace attached.

### `dshell-ssh`

- Role: device sessions. Two-faced Cordis package:
  - **Host face** owns the durable device registry (name, host, port,
    user, remote directory, login method; secrets in separate 0600 files
    under `$DSH_HOME/dshell/ssh/keys/`), the durable session→device
    assignment, and three seams: a wrapped `ctx.shell.resolve`, a
    subprocess route for `glob`/`grep`, and a replacement `ctx.fs`
    provider that resolves a bound session's tree over SSH. It also
    publishes `dshellSshRouting` for packages that need to know which
    device a session runs on.
  - **Browser face** provides the device card in the Plugins settings
    section and the `dshellSsh` service the session picker and the
    new-session dialog read.
- dsh services depended on: `ctx.settings`, `ctx.shell`,
  `ctx.subprocess`, `ctx.fs`, `ctx.agents`, `ctx.connection.fetch`.
- Introduced in: Phase 9.6; connection failure handling in Phase 9.7.

### `dshell-buffer`

- Role: the cross-session pipe. Two-faced Cordis package:
  - **Host face** owns links (created only by the user, never by an
    agent), deferred requests with a claim/progress/finish/fail
    lifecycle, scoped revocable folder grants, and the watchdog that
    settles anything nobody settled. It contributes one model-facing
    tool, `dshell_buffer`, as the single door to all of it, plus one
    system-prompt section stating the protocol.
  - **Browser face** provides the pipe panel in the frame-wide
    `shell.overlay` seat and the `dshellBuffer` service the sidebar
    header button toggles.
- dsh services depended on: `ctx.tools`, `ctx.systemPrompt`, `ctx.fs`,
  `ctx.agents`, `ctx.sessionController`, `ctx.sandboxPolicy` (optional),
  `ctx.shell` (cross-world byte transfer), `ctx.connection.fetch`; the
  browser face uses `ctx.slots` and `ctx.sessions`.
- Reads `dshellSshRouting` structurally when present, to probe a
  device-bound target before admitting a delegation; a composition
  without dshell-ssh simply has no device to check.
- Introduced in: Phase 9.8.

### `dshell-files`

- Role: the right sidebar's file navigator, roaming without bound, plus
  the two-pane file transfer beside it. Two-faced Cordis package:
  - **Host face** registers two connection routes. `/api/dshell/files`
    has two actions: `list` resolves the session's agent, then inside
    `withInitiator` resolves `stat` (must be a directory) and `listDir`
    and answers with the canonical absolute path in that session's own
    execution world; `cd` sends the session's main shell into one such
    directory, through the terminal bridge's own input path — the same
    one a keystroke takes, so the command is tracked and rendered like
    any typed command. The route exists because dsh's own
    `workspaceFiles.list` is fenced to the workspace root; `ctx.fs` is
    the same seam, just without that fence, and the sandbox only fences
    writes, so listing is at the same trust level as `read`.
    `/api/dshell/transfer` serves the transfer view: `state` (both roots,
    the device, whether a transfer is possible at all), `list` (one side's
    directory), `copy` (starts a job and answers with it), `job` and
    `cancel`. Its two worlds are the session's own (a device tree over the
    same routing, this machine otherwise) and **this machine**, reached
    through the explicit agentless boundary; reads go through `ctx.fs` as
    each side, and writes go through `ctx.shell` with the payload riding
    stdin as base64 (the filesystem seam has no byte write) for a device
    destination, and through `node:fs` in process for a local one — which
    is what that world already is, the same assumption the local pane's
    root makes by asking `os.homedir()`.
  - **Browser face** registers its own `SidebarRightTabDefinition` for
    the `files` kind at `priority: 'extension'`, shadowing the stock
    body (which resumes if this row is removed) and contributing the
    required guide entry that keeps the pane's default page. The pane
    draws a `..` row, clickable path crumbs, back/forward history and a
    reload button, plus a jump button that moves the session's shell
    into the directory on screen — drawn only when the host reports it
    can (no terminal bridge, no button) — and, for a device session, the
    button that opens the transfer tab. Directory rows and the `..` row
    are drag sources for the same jump, carried by pointer events rather
    than HTML5 drag and drop (a native drag session cannot be observed or
    corrected when the browser refuses the drop), released over the
    terminal view the block view mounts, which is outlined while the
    pointer is over it. Navigation state lives in a declared
    per-session store bucketed by tab id, because the pane unmounts the
    inactive tab's body but the store survives.
  - The transfer tab is the same package's second `SidebarRightTabDefinition`
    (`kind: 'transfer'`, a page type, and deliberately **no guide entry**:
    the pane's default page is the sole guide entry's kind, so a second entry
    would move every session's default page onto the guide). Its body draws
    two trees — this machine on the left, the device on the right — over the
    navigator's own rows and levels, and drags an entry from one to the other
    with the same pointer-event technique; a drop lands in the directory row
    under the pointer, or in the receiving pane's own directory. Copies are
    jobs the view polls, so a long directory copy has a progress line, a
    cancel and a conflict question ("overwrite?") instead of a request that
    hangs; the two tab types share one store instance.
- dsh services depended on: host — `ctx.connection.fetch`,
  `ctx.agents`, `ctx.sessionController`, `ctx.fs`, `ctx.shell` (the
  byte-write seam of the transfer), optionally
  `ctx.dshellTerminalBridge` for the shell jump and `ctx.dshellSshRouting`
  for the device side of a transfer; browser — `ctx.slots`, `ctx.locale`,
  `ctx.sidebarRightTabs`, optionally `ctx.dshellSsh` (is this session a
  device session with a mount?), and the `sidebar.right.pane.tab` standard
  props (`ctx.sessions` for the session id and cwd).
- Introduced in: Phase 9.9.

## What is not a dshell package

The following dsh components are reused unchanged. They are listed here
so the inventory is complete; do not introduce wrappers for them.

- `dsh-terminal-bash` — supplies the `shell` backend for
  `ctx.terminals`. Picked up by `dsh-bundle` (dsh's own bundle) already.
- `dsh-tool-terminal` — supplies `terminal_open`, `terminal_send`,
  etc. as model-facing tools. Picked up the same way. Agent's
  secondary-shell operations go through these tools, not through
  dshell.
- `dsh-session-persistence-jsonl` — supplies session log storage.
  dshell never touches this; the session log stays where dsh puts it.
- `dsh-compaction` and `dsh-session-title-*` — used unchanged by
  `/compact` and by session naming. dshell does not override them.
- `xterm.js` — third-party browser dependency. Imported from
  `dshell-conversation`'s browser face; not a Cordis package.

## Dependency graph

```
dshell-bundle
  ├── dshell-conversation
  │     ├── dshell-terminal-bridge (host face)
  │     └── xterm.js (browser face)
  ├── dshell-mode
  │     ├── dshell-conversation
  │     └── dshell-terminal-bridge
  ├── dshell-commands
  │     └── dshell-terminal-bridge
  ├── dshell-workspace        (replaces the disabled stock rows)
  │     └── dshell-buffer     (optional: the sidebar `管道` entry)
  ├── dshell-buffer           (optional: reads dshell-ssh's routing face)
  │     └── dshell-ssh        (optional: target reachability probe)
  └── dshell-files            (shadows the stock `files` sidebar tab; also
        │                       registers the `transfer` page type)
        ├── dshell-terminal-bridge  (optional: the pane's shell jump)
        └── dshell-ssh              (optional: the device side of a transfer,
                                     read as a structural seat)
```

There are no cycles. `dshell-bundle` is the install root; the others
  are leaves or single-level consumers of the bridge. The two optional
  edges exist only when both rows are composed — each side reads the
  other through a structural seat, never an import.

## Cordis `ctx` keys dshell publishes or subscribes to

### Subscribes to

- `ctx.uiConversation.events` — registers the target `terminal`'s
  NodeDefinitions (in `dshell-conversation`, host face).
- `ctx.uiConversation.views` — registers the `terminal` ViewDefinition
  (in `dshell-conversation`, host face).
- `ctx.webServer` — registers `/dshell/pty` upgrade (in
  `dshell-terminal-bridge`, host face).
- `ctx.terminals` — `spawn` / `startSend` / `readOutput` /
  `signal` / `kill` / `list` (in `dshell-terminal-bridge`).
- `ctx.agents` — `inject` (in `dshell-mode`) and session id lookup
  (in `dshell-terminal-bridge`).
- `ctx.commands` — registers commands (in `dshell-commands`).
- `ctx.tools` — registers `dshell_get_agent_terminal` and
  `dshell_terminal_read` (in `dshell-commands`).
- `ctx.uiSession` — patches `inputActions` (in `dshell-mode`).
- `ctx.systemPrompt` — registers one section stating the pipe protocol
  (in `dshell-buffer`, host face).
- `ctx.sessionController` — `resolveAgent` for the target and, at
  settlement, for the requester (in `dshell-buffer`, host face).
- `ctx.sandboxPolicy` — resolved against the granter's session to fence a
  granted write; optional (in `dshell-buffer`, host face).
- `ctx.sessions` — peer labels in the pipe panel (in `dshell-buffer`,
  browser face).
- `ctx.connection.fetch` — registers the `/api/dshell/files` listing
  route and the `/api/dshell/transfer` job route (in `dshell-files`, host
  face).
- `ctx.shell` — resolves and runs one base64-payload command per file
  written into a device world (in `dshell-files`, host face, the
  transfer's byte-write seam).
- `ctx.dshellSshRouting` — the device a session runs on, for the transfer's
  remote side; optional, read structurally (in `dshell-files`, host face).
- `ctx.sidebarRightTabs` — registers the `files` tab definition that
  shadows the stock kind, and the `transfer` page type beside it (in
  `dshell-files`, browser face).
- `ctx.dshellSsh` — whether a session is a device session with a mount,
  which is what the transfer button's presence depends on; optional, read
  structurally (in `dshell-files`, browser face).
- `ctx.dshellTerminalBridge` — `feed` moves a session's shell into a
  directory for the pane's jump button; optional, and its absence is
  what the pane reports as `canCd: false` (in `dshell-files`, host face).

### Publishes

- `ctx.dshellMainPty` — `Map<Agent, TerminalSessionId>`. Read by
  `dshell-mode` and `dshell-commands`. Exposed for inter-plugin
  coordination only; not a service consumed by dsh.
- `ctx.dshellPtyBuffer` — per-session rolling buffer of recent
  `main` PTY output (≤ 100 lines / 4 KiB). Read by `dshell-mode`
  when injecting context.
- `ctx.dshellSshRouting` — dshell-ssh's router, so dshell-buffer can ask
  which device a session runs on and probe it before admitting a
  delegation.
- `ctx.dshellBuffer` (client) — the pipe state and its mutations. Read by
  dshell-workspace's sidebar `管道` entry.

### Replaces (same-key providers over disabled stock rows)

- `workspaceRegistry` (host) — stubbed by `dshell-workspace` so
  `session-controller` resolves after the stock `workspace` row is
  disabled.
- `workspaces` + `uiWorkspace` (client) + the root `workspaces` hook —
  stubbed by `dshell-workspace` so ui-conversation / ui-sidebar
  resolve and ConversationRoot mounts after the stock `ui-workspace`
  row is disabled.

No new public `ctx` key is added to dsh itself.
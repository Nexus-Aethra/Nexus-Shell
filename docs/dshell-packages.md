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
  `bundle`, `conversation`, `terminal-bridge`, `mode`, `commands`.

## The five packages

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
  `mainPtyByAgent`. Exposes the ws upgrade route at `/dshell/pty`.
  Implements the wire protocol in `dshell-design.md` § 5.
- dsh services depended on: `ctx.webServer` (upgrade route),
  `ctx.terminals` (PTY lifecycle), `ctx.agents` (resolve agent by
  sessionId), browser-side `dshell-conversation` (channel for byte
  push).
- Introduced in: Phase 2 (host only); expanded in Phase 3 (browser
  ws).
- Touches decisions: 4.2 (main shell ownership), 4.3 (secondary pass-
  through), 4.4 (host half of byte stream).

### `dshell-mode`

- Role: per-session mode state (`shell` / `agent`) and composer Enter
  dispatch. Patches the `inputActions` exposed by
  `ctx.uiSession.provide()` to route Enter according to mode. Handles
  `/agent` and `/shell` prefix parsing. On agent-mode submit, injects
  the truncated PTY context block before the user message.
- dsh services depended on: `ctx.uiSession`, `ctx.agents.inject`,
  `dshell-terminal-bridge` (for main PTY id and context buffer
  read).
- Introduced in: Phase 5 (state and dispatch); expanded in Phase 7
  (injection).
- Touches decisions: 4.5 (mode state and prefix handling), 4.6
  (injection).

### `dshell-commands`

- Role: registers `/clear`, `/new`, `/compact` on `ctx.commands`, and
  one model-facing tool `dshell_get_main_terminal` on `ctx.tools`.
- dsh services depended on: `ctx.commands`, `ctx.tools`,
  `dshell-terminal-bridge` (for the main PTY id returned by the
  tool).
- Introduced in: Phase 6 (commands); expanded in Phase 8 (tool).
- Touches decisions: 4.5 (real commands), 4.6 (agent access to main
  PTY id).

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
  └── dshell-commands
        └── dshell-terminal-bridge
```

There are no cycles. `dshell-bundle` is the install root; the others
  are leaves or single-level consumers of the bridge.

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
- `ctx.tools` — registers `dshell_get_main_terminal` (in
  `dshell-commands`).
- `ctx.uiSession` — patches `inputActions` (in `dshell-mode`).

### Publishes

- `ctx.dshellMainPty` — `Map<Agent, TerminalSessionId>`. Read by
  `dshell-mode` and `dshell-commands`. Exposed for inter-plugin
  coordination only; not a service consumed by dsh.
- `ctx.dshellPtyBuffer` — per-session rolling buffer of recent
  `main` PTY output (≤ 100 lines / 4 KiB). Read by `dshell-mode`
  when injecting context.

No new public `ctx` key is added to dsh itself.
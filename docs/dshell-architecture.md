# dshell Plugin Architecture

Companion to [`dshell-design.md`](./dshell-design.md). That document
states the decisions; this one fixes the wire shape, the Cordis surface,
and the package layout that the code must follow.

The contract is normative for `dshell-*` packages. Any change to a
shape here is a breaking change for sibling packages and must be
updated in lockstep.

## 1. Workspace layout

```
Nexus-Shell/
├── package.json              # pnpm workspace root; references `dsh/` as a workspace
├── pnpm-workspace.yaml       # globs `packages/*/*` (matches dsh convention)
├── tsconfig.base.json        # local base, does NOT extend dsh's base
├── tsconfig.host.json        # local host aggregate references
├── tsconfig.client.json      # local client aggregate references
├── tsdown.config.ts          # root tsdown preset selector
├── cordis.patch.yml          # dshell bundle's own patch layer
├── docs/                     # dshell-design, roadmap, packages, architecture
├── packages/
│   ├── dshell-bundle/        # dsh bundle: one cordis.patch.yml + package.json
│   ├── dshell-conversation/  # dual-face: host registers target; browser renders
│   ├── dshell-terminal-bridge/ # dual-face: host upgrade route + agent/PTY glue
│   ├── dshell-mode/          # dual-face: composer patch on browser, agent-side helpers on host
│   └── dshell-commands/      # host-only: ctx.commands + ctx.tools registrations
└── dsh/                      # local reference checkout (NEVER TRACKED, see .gitignore)
```

The `dsh/` directory is a local clone used for reference while
developing. dshell does **not** import dsh source code directly; it
imports `@deepseek-ai/dsh-*` packages from a sibling workspace or a
matching npm range. `pnpm-workspace.yaml` lists `dsh/packages/*/*`
under a sibling workspace link so the build resolves.

## 2. Build face model

Every dshell package that contributes to the browser follows the
`dsh` dual-face discipline described in
[`dsh/packages/client/AGENTS.md`](../../dsh/packages/client/AGENTS.md)
and the [`dsh-tsdown preset`](../../dsh/packages/client/tsdown.client.ts):

- `src/index.ts` — Node half (host side). Default export is a Cordis
  plugin: `{ name, inject, apply? }`.
- `src/client/index.ts` — Browser half. Default export is a Cordis
  plugin under `@deepseek-ai/cordis` with the client convention.
- `src/invariant.ts` — only if a runtime invariant companion is needed;
  we do not need one in any current dshell package.

`package.json` declares both halves:

```jsonc
{
  "name": "@deepseek-ai/dsh-dshell-<role>",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./lib/types/client/index.d.ts",
      "default": "./lib/client.js"
    }
  },
  "dsh": {
    "client": {
      "platform": "web",
      "external": ["@xterm/xterm", "@xterm/addon-fit"]
    }
  }
}
```

`tsdown.config.ts` uses `clientBundle('@deepseek-ai/dsh-dshell-<role>', ['lib/types/index.js'])`
so the same preset emits both the Node lib half and the browser client
bundle. CSS Modules and global CSS use the same virtual-id pipeline as
dsh (`@deepseek-ai/dsh-dshell-<role>.module.css` → hashed class map,
injected style tag).

## 3. Cordis surface used and contributed

The set is the same as the design document, repeated here in wire
form so implementers can match identifiers exactly.

### Subscribed services (read)

| `ctx` key | Used by | Reason |
|---|---|---|
| `ctx.uiConversation.events` | `dshell-conversation` host | register NodeDefinitions for target `terminal` |
| `ctx.uiConversation.views` | `dshell-conversation` host | register ViewDefinition for target `terminal` |
| `ctx.uiSession` | `dshell-mode` browser | patch `inputActions` exposed via `provide()` |
| `ctx.connection` | `dshell-terminal-bridge` host | `connection.fetch.register` for the frame stream (`/api/dshell/stream`, `/api/dshell/stream/send`) and the history read |
| `ctx.webServer` | `dshell-terminal-bridge` host | `registerUpgrade('/dshell/pty', ...)` — the browser's ws fast path |
| `ctx.terminals` | `dshell-terminal-bridge` host | spawn/startSend/readOutput/signal/kill/list |
| `ctx.agents` | `dshell-terminal-bridge` host, `dshell-mode` host | `inject`, agent lookup by sessionId |
| `ctx.commands` | `dshell-commands` host | register `/clear`, `/new`, `/compact` |
| `ctx.tools` | `dshell-commands` host | register `dshell_get_agent_terminal`, `dshell_terminal_read` |
| `ctx.dshellMainPty` | `dshell-mode`, `dshell-commands` | consume the `Map<Agent, TerminalSessionId>` |
| `ctx.dshellPtyBuffer` | `dshell-mode` host | consume the per-session rolling buffer |

### Published services (contribute)

| `ctx` key | Published by | Shape | Consumers |
|---|---|---|---|
| `ctx.dshellMainPty` | `dshell-terminal-bridge` | `Map<Agent, TerminalSessionId>` | `dshell-mode`, `dshell-commands` |
| `ctx.dshellPtyBuffer` | `dshell-terminal-bridge` | `Map<Agent, PtyBuffer>` | `dshell-mode` (Phase 7+) |

Neither service is exposed outside the dshell composition; no dsh
package reads them. The names follow dsh's "namespace-prefixed
plural" rule (see [`adding-a-package.md`](../../dsh/docs/cookbook/adding-a-package.md#3-decide-the-package-topology)).

## 4. Browser↔host wire protocol

The frames below are carrier-independent. `dshell-terminal-bridge` serves
them over two carriers, and the browser face picks one by what the page can
reach:

- **ws** (`/dshell/pty`, registered through `ctx.webServer.registerUpgrade`):
  one socket for the session's life with no per-frame request — the browser's
  fast path.
- **stream** (`ctx.connection.fetch` routes): a long-lived
  `GET /api/dshell/stream?clientId=…&sessionId=…&stream=main|agent` whose body
  is newline-delimited frames, plus one `POST /api/dshell/stream/send` per
  client frame carrying the same `clientId`. This is the desktop shell's only
  option (its page runs on the `dsh-app://` scheme with no listening port), and
  it exists precisely because `connection` is composed there while `webServer`
  is not.

Both carriers are authenticated by dsh's own gate — the ws by
`connection.requestRejection` on the upgrade, the stream by whatever carrier
serves `/api` (the web server's `/api` prefix, or the desktop pipe).

The frame model is unchanged: JSON UTF-8 text, one object per frame. Newline is
the stream carrier's delimiter and nothing else's.

### 4.1 Client → host frames

```tsc
type ClientFrame =
  | { kind: 'bind',     sessionId: SessionId }
  | { kind: 'unbind',   sessionId: SessionId }
  | { kind: 'input',    sessionId: SessionId, text: string, submit: boolean }
  | { kind: 'resize',   sessionId: SessionId, cols: number, rows: number }
  | { kind: 'signal',   sessionId: SessionId, signal: 'SIGINT' | 'SIGTERM' | 'SIGTSTP' }
```

`bind` must be the first frame after upgrade. Frames that name a
`sessionId` not currently bound are rejected by closing the ws with code
`4403` and reason `unbound-session`.

`input.submit=true` appends `\n` before writing through `startSend`;
`input.submit=false` writes text without a trailing newline (rare; for
PTY apps that consume partial lines).

`resize` is a no-op when the bound agent has no live `main` PTY; the
host queues the latest size and applies it on `ensureMainShell`.

`signal` translates the string to the corresponding POSIX signal via
`ctx.terminals.signal(owner, id, signal)`.

### 4.2 Host → client frames

```tsc
type ServerFrame =
  | { kind: 'ready',     sessionId: SessionId, mainPtyId: TerminalSessionId }
  | { kind: 'output',    sessionId: SessionId, chunk: string, time: number }
  | { kind: 'status',    sessionId: SessionId, status: TerminalSessionStatus }
  | { kind: 'closed',    sessionId: SessionId, reason: string }
  | { kind: 'error',     sessionId: SessionId, code: string, message: string }
  | { kind: 'context',   sessionId: SessionId, snapshot: string, byteLength: number }
```

`ready` is sent once per `bind` after `ensureMainShell` resolves. It
carries the `TerminalSessionId` the browser will display in the
header strip and pass to subsequent frames.

`output.chunk` is **one** PTY byte chunk as returned by
`TerminalBackendSession.startSend(...).readOutput()`. The browser
must render it through xterm.js as ANSI. `time` is `Date.now()` at
host receive, used by the cross-source merge in `ViewBuilder`.

`status` mirrors `ctx.terminals` lifecycle changes
(`running` / `exited`). It does not replace dsh's session log; it is
display-only.

`closed` is terminal: the host will not send more `output` for this
`sessionId`. Subsequent `input` for the same `sessionId` will trigger
`ensureMainShell` again.

`error` reports recoverable failures (e.g. a signal sent with no
live session). Non-recoverable failures close the ws with code `4500`.

`context` is sent on demand (when the browser requests context via
host Remote call, not via this ws; see § 5.3). It is included here
for completeness because the host-side buffer snapshot may also be
pushed to the browser on bind for late subscribers.

### 4.3 Ordering and back-pressure

The host does not implement application-level back-pressure. xterm.js
ingests `output` chunks synchronously into its parser; a slow browser
does not block `readOutput()` because the host copies each chunk into
a per-session ring buffer and reads it on the next loop tick.

The ring buffer cap is **64 KiB**. A new chunk that would overflow
truncates the oldest bytes from the front and prepends a single
`\x1b[2J` clear-and-redraw sequence so xterm.js reaches a consistent
state. The browser-side buffer mirror is bounded separately (see § 6).

### 4.4 Reconnection

If the browser ws disconnects, the host retains the PTY session and
the per-session ring buffer. The next `bind` from the same browser
sessionId receives:

1. `ready` with the existing `mainPtyId`,
2. `context` containing the latest ring buffer snapshot,
3. live `output` resumes.

If the harness restarts, `ready` reports a new `mainPtyId` (or none,
if `ensureMainShell` fails). Browser-side state is reset; xterm.js
shows a fresh prompt.

## 5. RPC contracts (host ↔ browser Remote)

dshell uses the existing Typert Remote stream only for control
operations. Byte transfer goes over the ws upgrade route above.

### 5.1 Browser → host methods

| Method | Args | Returns | Notes |
|---|---|---|---|
| `dshell.getMode` | `{ sessionId }` | `{ mode: 'shell' \| 'agent' }` | per-session |
| `dshell.setMode` | `{ sessionId, mode }` | `{ ok: true }` | rejects invalid mode |
| `dshell.getContext` | `{ sessionId, maxBytes? }` | `{ snapshot: string, byteLength: number }` | reads `ctx.dshellPtyBuffer`; maxBytes defaults to 4096 |
| `dshell.getMainPty` | `{ sessionId }` | `{ mainPtyId: TerminalSessionId \| null }` | for header strip; null if main not open |

These are registered via the standard `api/remotes` infrastructure on
the host and exposed to the browser through `ctx.connection.rpc.open`
or equivalent. They are **not** sent over the ws upgrade route; that
route is reserved for byte flow.

### 5.2 Host → browser notifier

A `dshell.contextChanged` notifier is published on `ctx.dshellPtyBuffer`
when the buffer rotates by more than 25% of its cap. The browser side
subscribes and refreshes its mode-toggle badge.

### 5.3 Why split RPC and ws

`dsh-client-connection` exposes Remote streams without opening a ws
(["provide equivalent Remote streams through `connection.rpc.open`
without opening a WebSocket"](../../dsh/packages/client/connection/README.md)).
The ws upgrade route is added on top for byte transfer because:

1. PTY chunks are high-frequency and unbounded; Remote RPC frames
   carry per-call envelopes unsuitable for sustained stream pressure.
2. xterm.js consumes ANSI sequences synchronously; routing through
   Remote adds a serialization round-trip per chunk.
3. The ws upgrade is the only host-supported stream primitive for
   browser-originated persistent bidirectional channels
   ([`webserver/README.md` § Registering routes](../../dsh/packages/host/webserver/README.md#registering-routes)).

## 6. PtyBuffer shape (host)

```tsc
interface PtyBufferEntry {
  /** Wall-clock ms at chunk arrival. Used by ViewBuilder merge. */
  time: number
  /** Raw bytes; never ANSI-parsed or normalized. */
  bytes: string
}

interface PtyBuffer {
  /** Rolling entries; oldest at index 0. */
  readonly entries: readonly PtyBufferEntry[]
  /** Trimmed to 100 entries or 4 KiB total, whichever is smaller. */
  readonly byteLength: number
}
```

`dshell-mode` reads `ctx.dshellPtyBuffer.get(agent)` at agent-mode
submit time. The 4 KiB cap is checked at UTF-8 boundary alignment.

## 7. Per-session mode store (browser)

```tsc
type Mode = 'shell' | 'agent'

interface SessionModeStore {
  get(sessionId: SessionId): Mode
  set(sessionId: SessionId, mode: Mode): void
  reset(sessionId: SessionId): void
}
```

Default is `shell`. The store is implemented as a `createSessionModeStore()`
factory in `dshell-mode/src/client/`, exported by the `/client` entry and
consumed type-only by sibling client packages (per dsh
[`AGENTS.md` § Export discipline](../../dsh/packages/client/AGENTS.md#export-discipline-client-plugin-packages)
rule 1: only `apply`, `inject`, store factories, and shared types are
exported).

The store is per-browser (process-wide), keyed by `SessionId`. The
mode does not survive a browser reload; the user starts in `shell`
mode on each reload (this is acceptable per `dshell-design.md` § 2).

## 8. Composer patch

`dshell-mode` browser face calls
`ctx.uiSession.provide(sessionId).inputActions` and replaces `submit`
with a wrapper that:

1. Reads current `Mode` from `SessionModeStore`.
2. Parses `/agent` and `/shell` prefixes from the trimmed text.
3. Routes accordingly:
   - `mode='shell'`, no prefix → ws `input` frame.
   - `mode='agent'`, no prefix → `agent.inject(...)` Remote call.
   - `/agent <rest>` → switch mode to `agent`, then `agent.inject(rest)`.
   - `/shell <rest>` → switch mode to `shell`, then ws `input` frame
     with `<rest>`.
   - `/clear`, `/new`, `/compact` → `ctx.commands.execute(...)` via
     the standard command surface; this path **does not** patch
     `inputActions`, it goes through the existing `/`-dispatcher that
     `ui-input-trigger` and `ui-commands` already own.

The wrapper calls the original `submit` after the prefix is stripped,
so `ui-commands` and the standard input trigger pipeline still run
on the post-stripped text.

## 9. CSS and styling

dshell uses the dsh token system. CSS Modules follow dsh's
`lightningcss`-hashed class map pipeline:

- `x.module.css` → hashed class map + injected `<style data-plugin-css>` tag.
- `x.css` (global) → injected as one `<style>` per import, deduped by
  tag id.
- `x.css?inline` → exported as text for plugin-owned lifecycle.

All colors come from `--dsw-*` tokens; no literal colors. The xterm
canvas theme uses CSS vars `var(--dsw-canvas-bg)` and `var(--dsw-canvas-fg)`
mapped in xterm's ITheme on mount.

## 10. Localization

Every user-visible string is locale-owned. dshell registers a single
locale namespace per dsh convention:

```
'@deepseek-ai/dsh-dshell/locale/<package-name>'
```

Three namespaces for now:

- `dshell-conversation` — terminal title, mode toggle labels.
- `dshell-mode` — `/agent`, `/shell`, `/clear`, `/new`, `/compact`
  command descriptions and input hints.
- `dshell-terminal-bridge` — connection status badge strings.

## 11. Test layout

Each package follows dsh's three-tier model (data / host / GUI):

- **Data layer specs** (Node side) for `dshell-terminal-bridge`
  (`PtyBuffer`, ring buffer, mode-id resolution) and `dshell-mode`
  (prefix parsing, context truncation).
- **Host specs** (Node + Cordis) for the bundle, registering against a
  test profile and asserting the ws upgrade route, target
  registration, and Cordis service shape.
- **GUI specs** (jsdom) for `dshell-conversation` ViewBuilder and
  `dshell-mode` composer patch. `// @vitest-environment jsdom` per
  file.

Coverage gate follows the client `100%` rule on browser halves and
the standard Node-side target on host halves.

## 12. What dshell does not introduce

- No changes to dsh source. No fork.
- No new model-facing tool *other than* the two terminal tools
  (`dshell_get_agent_terminal`, `dshell_terminal_read`), which exist
  solely to give the agent a shell of its own and a read-only view of
  the user's (Phase 9.11).
- No new session events. PTY bytes never reach `ctx.sessionPersistence`.
- No cross-process PTY. Session restart loses PTY scrollback.
- No multi-tab browser surface.

These mirror `dshell-design.md` § 2 and are normative.

## 13. Phase plan

See [`dshell-roadmap.md`](./dshell-roadmap.md). The architecture above
fully specifies what each phase's plugins must produce. The next
practical step is Phase 0 (`dshell-bundle` skeleton) followed by Phase 1
(empty `terminal` target registration).
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
│   ├── dshell-std/           # the standard layer: wire contracts + the storage contract (no dsh deps)
│   ├── dshell-storage/       # host-only library: the media behind the storage contract (node:sqlite)
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
  "name": "@nexus-aethra/dshell-<role>",
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

`tsdown.config.ts` uses `clientBundle('@nexus-aethra/dshell-<role>', ['lib/types/index.js'])`
so the same preset emits both the Node lib half and the browser client
bundle. CSS Modules and global CSS use the same virtual-id pipeline as
dsh (`@nexus-aethra/dshell-<role>.module.css` → hashed class map,
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
| `ctx.commands` | `dshell-commands` host | register `/new` (`/compact` stays dsh's own) |
| `ctx.tools` | `dshell-commands` host | register `dshell_get_agent_terminal`, `dshell_terminal_read`, `dshell_terminal_output` |
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
   - `/new`, `/compact` → `ctx.commands.execute(...)` via
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

Every user-visible string in a browser face is locale-owned. dshell uses dsh's
own mechanism — `ctx.locale` from `@deepseek-ai/dsh-client-locale` — rather than
inventing one, so the Language row dsh already ships (**设置 → 通用设置 → 语言**)
drives dshell's surfaces too.

One namespace per package, named after the package's camel-cased id:

| Package | Namespace | Keys |
|---|---|---|
| `mode` | `dshellMode` | 161 |
| `workspace` | `dshellWorkspace` | 62 |
| `buffer` | `dshellBuffer` | 58 |
| `files` | `dshellFiles` | 25 |
| `ssh` | `dshellSsh` | 25 |
| `terminal-bridge` | `dshellTerminalBridge` | 1 |

The shape, per package:

- `src/client/locales.ts` merges the namespace into `LocaleNamespaceMap` (from
  `@deepseek-ai/dsh-client-ui-slots`) and exports `zh` (`satisfies
  Record<string, string>` — the key set's **source of truth**), the key union
  derived from it, and `en` as `satisfies Record<Key, string>`. A missing or
  extra English key is a compile error, and registration requires both locales.
- The client `apply` adds `'locale'` to `inject`, registers the dictionaries in
  `ctx.effect(() => ctx.locale.register(NS, { zh, en }), …)`, and declares
  `locale: NS` on every `ctx.slots.register({ … })` — that field is what makes
  the renderer synthesize the `t` seat into the component's props.
- Sites outside a slot — services, `label: () => …` callbacks, injected faces —
  bind `ctx.locale.bind(NS)` and hold the result (`private readonly t`).
- Lookups resolve **at call time**, so a language switch re-renders live: no
  reload, no re-registration.

Three rules the retrofit established:

- **No copy in module scope.** A `const LABELS = { … }` built at import cannot
  see a `t` bound later in `apply`. Such a table becomes an identifier→key map
  resolved at render (`TICKET_STATE_KEY[ticket.state]`) or a factory that takes
  `t` (`makeRightsLabel(t)`).
- **A slot registration must pass the component, not a call to it.**
  `register({ … }, () => Card(props))` discards the injected props, `t`
  included; declare the extra face as `inject: () => ({ … })` and pass `Card`.
- **Never translate a value the code also matches on.** Two surfaces find
  elements by rendered text. The compact rail marks the sidebar's section
  headings through `data-dshell-row="archive-header"` / `"pending-header"` plus a
  structural walk for the main header, which is locale-proof and finally covers
  `待删除`; dshell-ssh's settings-nav matcher already lists both languages
  (`['插件', 'Plugins']`).

### Host-side copy

A host half authors text a reader sees: route refusals, device errors, the SSH
Test result, a spawn-failure reason, the `/new` result, and the pipe notices a
delegated request carries. That text needs the same language as the screen, and
the browser's choice is not visible to the host — dsh's `ctx.locale` is
browser-side only. dshell therefore states the direction itself:

- `dshell-terminal-bridge` provides **`ctx.dshellHostCopy`** (`std` declares the
  shape — `locale()`, `bind(dicts)`) and registers **`POST
  /api/dshell/locale`**; every browser face reports the locale it resolved on
  boot and on every change.
- `bind` resolves the language **at call time**, in order: the reported locale →
  the durable `locale.preference` dsh's Language row writes → `zh`, the
  source-of-truth language the dictionaries follow. A switch reaches the next
  host-composed string with no restart and no re-binding.
- Each package keeps its own host dictionaries in `src/host-locales.ts` — `zh`
  as the key-set source of truth, `en` complete, the same `satisfies` discipline
  the browser dictionaries use — and binds them once where the strings are
  composed.

The provider's placement is forced by the activation graph, not chosen for
tidiness: `dshell-mode` owns the presentation surfaces, but it **waits** for this
package's PTY service, so a provider mode owned would deadlock the profile —
mode pending on the bridge, the bridge pending on mode. Every writer of host copy
waiting for the bridge is what it was already doing.

Consumers read the service structurally (`ctx.get('dshellHostCopy') as HostCopy`)
rather than through the typed `Context` accessor: the accessor's declaration
lives with the provider, and a consumer's tsc program does not include that
package's source.

Deliberately **outside** the host copy: **tool results and prompt sections**.
Those are the agent's interface — written once and read by the model — and a
per-language variant would make the model's data depend on the UI language. They
stay single-language, exactly as dsh's own tool copy does.

## 11. Buffer addressing

A buffer path is rooted at `/`, and its first segment is a **mapping name** —
the `as` a grant declared, unique across every live grant the reader holds, not
across the pipe that produced it. Everything after that name is a path inside
the mapped area.

The split lives in exactly one place: `splitBufferPath` in
`packages/dshell/buffer/src/paths.ts`. Its contract is what makes the two halves
of a resolution fit together:

- `name` selects the grant (`BufferService.resolveBufferPath` searches every
  live grant addressed to the caller and refuses an ambiguous name rather than
  guessing).
- `rest` is **area-relative**: never absolute, never leading with a separator,
  `''` for the area itself (which the service turns into `.`).

`rest` in that shape is then joined onto the area's canonical root and put
through the containment test. That test expects a relative path by design — an
absolute one is refused as a path-escape attempt — so the invariant is
load-bearing in the direction that is easy to get wrong: stripping a mapping
name must consume its separator **and** the caller's leading `/`, or
`/name/file` arrives at the containment test as `/file` and every subpath under
a mapped directory is refused. The refusal reads to the caller as a permissions
problem ("这个位置不在受权的范围内"), not as a path-shape problem, which is what
made it expensive to diagnose from the outside: `ls` on the mapped root
succeeded throughout, because a lone name resolves to `.`.

Tool arguments are the only place this form is authored by a model; the panel's
buffer browser navigates a grant directly and never re-derives the split, so one
rule serves both surfaces.

## 12. The block view's fold, and dsh's trajectory

`dshell-mode` owns the `chat` view cell (the 会话 tab); dsh's trajectory (轨迹)
stays dsh's. Both show one session, and they are built from different models: a
**card** per turn (or per supervised phase inside a turn) here, a **timeline** of
turns there. Keeping the two in step is a requirement, not a nicety — the reader
compares one against the other.

The case that used to break it: a **human message admitted into a running
turn**. dsh supports this (its composer can steer), and such a message belongs to
the turn it steered — the trajectory draws it at that turn's step. The fold must
therefore append it to the running block:

- A card of its own would carry no turn number. `assembleTimeline` orders
  turn-carrying blocks against the PTY's own turn blocks and places turn-less
  ones by timestamp against the shell regions, so the card could land between
  the wrong regions; and the next `turn/start` adopts any open block with no turn
  number, so the interjection's card would be relabelled as the *next* turn.
- The two surfaces would then disagree about the session's shape while showing
  the same events.

Steering is not a property of the durable `user/message`; it has to be
reconstructed, and dsh's own client already defines how (ui-chat's
`SteeringHistory`, which this fold mirrors): a `next-step` inbox splice that is
not cancelled hands its removed prompt ids to the running turn, and the
`user/message` naming one of them was claimed by that turn. `foldEvent` reads the
splices itself for this reason — the rule belongs to the fold, not to the view
that drives it.

Within a card, rows are cut into one **segment** per human message: the request,
then the work and the answers it produced. A card with one request cuts into one
segment and renders exactly as it always has.

### A shell region is as tall as its screen, not as its log

The terminal stretches between the cards are the PTY's own bytes, rendered
through a real xterm instance (`dshell-mode`'s `block-terminal.ts`), and the
region's height is **measured** rather than guessed: the region's text is walked
once, the column each line would end on is simulated (so `\r` redraws and
`ESC 7`/`ESC 8` overlays do not read as one enormous line), and the rows that
follow from that width are what the region renders at. Trailing blank rows are
dropped — a region is exactly as tall as its ink.

The bytes are a LOG, and a log holds things a screen does not. A respawn (a
harness restart, an ssh reconnect) makes the bridge reprint its startup line and
run `clear`, and the persisted log keeps those bytes — so a region cut from the
log can carry several copies of a banner that is not on screen at all. That is
the same convention § 4.3's ring buffer already relies on: `ESC[2J` means the
display was reset, and what came before it is gone. So the walk starts over
there — `ESC[2J` forgets the rows measured so far, while `ESC[3J` (the
scrollback alone) deliberately does not, and neither the text nor the buffer
loses anything.

Without that rule the region is measured as tall as every banner copy in its
log, which renders a wall of empty rows under the last real line — one banner
taller per reconnect, and past `SPAN_MAX_ROWS` a scroll box that is 95% blank.
The pre-erase bytes stay in the region's own scrollback, where a reader who
scrolls up can still find them.

## 13. Completing the shell line

The composer IS the session's input line (the block view's terminal is a
read-only mirror), so `Tab` is dshell's to answer: dsh's own menu only fires on
the `/` and `@` triggers, and the browser cannot resolve anything itself, because
a path means one thing on this machine and another on a device.

The first question is not *what* to offer but *where the caret is*: `dock` names
a command, `cd dock` an argument, `tee > dock` a file — and none of that is
visible in the word itself, only in the line around it. So the rule is one pure
function over the line, in the shared layer
(`packages/dshell/std/src/shell-line.ts`), and BOTH halves call it: the host to
decide which source answers, the browser to decide when an empty answer is worth
showing. It used to be two functions — a host-side "the first word is the
command" and a client-side "a slash means a path" — and the two copies drifted
the first time a line had more than one word in it.

`readShellCaret(line, cursor)` tokenizes the line up to the caret (quotes
respected, unterminated quotes kept whole because they are still being typed),
walks the tokens before the caret, and reports a position, the command the word
belongs to, and the span a completion replaces. The walk is a table, not a
parser, and every entry exists because bash's grammar says so:

- `;` `&` `&&` `||` `|` `(` `$(` `` ` `` open a **command position**, and a new
  command position clears the command it belonged to.
- Wrapper words (`sudo`, `env`, `time`, `xargs`, `nice`, `nohup`, …) and the
  keywords that open a list (`if`, `then`, `do`) do **not** become the command:
  they hand the command position to the next word. This is why `sudo dock<Tab>`
  completes commands, which it never did.
- A redirection with a target (`>`, `>>`, `<`, `2>`) expects a **file**; a
  descriptor duplication (`2>&1`, `>&2`) names no file at all and leaves the
  expectation alone — the one distinction that decides whether the next Tab
  offers a filename or a digit.
- A `-word` after the command is a **flag**, and a lone `-` is not (`docker r -`
  is the stdin convention).
- `>` with the caret right after it is a file slot holding an EMPTY word, so Tab
  there lists the directory — which is exactly what bash does.

The position then picks the source, in the session's own world:

| position | answer |
| --- | --- |
| `command` | the world's command names: every directory on its `PATH` (listed CONCURRENTLY — a device world pays a round trip per directory) plus the shell's interactive builtins, cached per session by holding the in-flight PROMISE. A local shell is spawned by the bridge as a child of this process with `--noprofile --norc`, so its `PATH` is the harness's, read directly; a device's is asked once through the same read-only shell seam the transfer writes through. |
| `argument` | a path in the world, resolved against where the shell actually stands (the bridge reads a local shell's own `cwd`; the composer's tracked value is the fallback for a device's `ssh`). Directories sort first, and a name typed with the wrong capitals is answered with the file system's spelling. |
| `argument`, after `cd`/`pushd`/`popd` | directories only — a file in that list is a candidate the shell would refuse. What is NOT expressible this way is "files only": a path is completed a segment at a time, so `> logs/app.log<Tab>` must pass through `logs/`. |
| `redir` | the same path listing, files and directories, for the same reason. |
| `flag` | **the shell's answer.** `-la` cannot come from a directory at all, so this position is asked of the world's own shell (below) and answered with nothing until that answer arrives. |
| `argument`, a bare word | the shell first, exactly as for a flag — that is where subcommands, targets and branches live (`git ch<Tab>`, `systemctl sta<Tab>`) — and the path listing only as the fallback for a shell that turns out to have nothing. A word with a path in it, or after `cd`, is not asked at all: those are the file system's questions and this side already knows more. |

The two shell-first rows are why a Tab is cheap on a device. The listing they
*used* to take before asking is three round trips in that world, and on a device
a round trip is not a network packet — see "Why a device Tab was slow" below.

Nothing to complete — a blank line, or an operator under the caret that names no
word — is a definite answer too, and the client swallows the Tab rather than
letting it move focus to the composer's buttons.

### The shell oracle

The file system cannot know that `--force` belongs to `docker rm`, and no PATH
walk knows that `git` has a `cherry-pick`. What knows is the shell: bash-completion
registers a completion function per command, and a reader pressing Tab in a real
terminal has been getting those answers all along. dshell asks the same question,
in a process of its own — `bash -c <probe> dshell-probe <line> <caret>`, run in
the session's world through the same shell seam the transfer writes through (and
so, for a device session, on the device).

Five things make that safe and usable rather than clever:

- **The line is data.** It travels as an argument, quoted once; the probe script
  itself is written without a single quote character, which
  `files/tests/shell-completion.spec.ts` asserts rather than asks future editors
  to notice.
- **Nothing executes the reader's line.** A completion function is handed the
  words and reads them. The probe also never touches the session's terminal: one
  PTY allows one active send, and that seat belongs to the reader.
- **The functions are code on that machine.** That is the point — it is the user's
  own Tab — and it happens in a separate, short-lived process with a read-only
  policy (honest for a local session; for a device the command runs under the
  device's own policy, because the only process here is `ssh`).
- **The answer is asked for AFTER the fast one.** Two phases: the host answers
  from what it already knows — memory, not a fresh round trip, when the line is
  one the shell will answer (see below) — and says `pending` when the shell might
  know more, the browser draws that answer at once and asks again with `refine`.
  A late refine is applied only while the store still holds the very state it was
  asked about — Escape, a cycled candidate, a keystroke or another Tab all drop it
  — so a slow world can never rewrite a line the reader has moved on from.
- **A blank answer keeps the fast one.** `NOSPEC` (no completion registered),
  an empty list, a world that will not answer: all of them leave the file
  system's answer standing. A refine can only ever give more, never take away.

Answers are cached per WORLD and line context (the world, the command, the word
before the caret), each entry under the prefix it was asked for; a request that
extends a cached prefix is filtered locally, which is what makes the second Tab
free. The world is part of the key because two sessions are not always the same
machine. A flag the shell does not answer stays silent, as it does in a real
terminal: the reader is typing a spelling there, not asking about the world.

### Why a device Tab was slow, and what makes it fast

A device Tab used to be **1.2–1.6 s** where the same Tab on this machine was
6 ms, and the network was not the reason. Measured against the SSH device this
project tests with:

| what | cost |
| --- | --- |
| one `ssh` command over the shared control master | 23 ms |
| the oracle probe (a `bash` that sources bash-completion) | 125 ms |
| **one call through dsh's subprocess seam** | **0.39 s** |
| a path completion: three of those calls (`realpath`, `stat`, `find`) | 1.17 s |
| a flag or bare-word Tab: the same three, then the probe | 1.6 s |

The 0.39 s is not the wire: every command dsh runs locally is wrapped as
`systemd-run --user --scope … node --import tsx …/subprocess-local/src/bin.ts --
ssh …`, so each call pays a transient systemd scope, a Node process and tsx
transpiling dsh's runner. That price belongs to the harness, not to dshell, and
the only thing this side controls is **how many calls a keystroke makes**.

So, four rules:

- **The fast pass stops reading when the shell is going to answer.** For a flag
  or a bare word, the directory listing is the *fallback* for a shell that turns
  out to have nothing, so it is deferred to the refine pass that discovers that —
  and paid for only then. The answer the reader sees first is the shell's.
- **A reading is remembered, and answered from memory while it is merely old**
  (`files/src/readings.ts`): fresh for three seconds, still served for up to a
  minute — with the refresh started BEHIND the answer rather than in front of the
  reader — and not served at all past that. This is what makes a Tab instant
  after a pause without ever presenting a listing nobody has checked as if it
  were current: the next Tab sees the refreshed one.
- **The reading happens when a command settles.** The client watches the same
  shell-integration marker the host's splitter reads (`ESC ] 133 ; D`), and a
  settled command is exactly the moment the world changed while the reader is
  reading its output — so the directory the shell now stands in is read then, in
  the background, along with the command list. One warm also goes out when a
  session is opened, so the first Tab of a session nobody has typed in is warm.
  This is the trigger that makes `cd <Tab>` fast, because what that key reads is
  the directory the *previous* command left the shell in.
- **The host is also sent to look while the reader types.** On an edit, debounced
  250 ms and keyed by everything before the word being typed (so a word costs one
  warm rather than one per character), the browser sends `warm` — the same
  question `complete` would ask with the answer thrown away. A Tab that arrives
  while a warm is still on the wire JOINS it: both caches are single-flight, so
  the keystroke waits for the answer already on its way instead of buying a
  second one.
- **A `cd` that resolves warms the directory it landed in.** The composer routes
  every `cd` line through the route's `resolve` to learn where the shell went,
  and that answer is the earliest moment the next Tab's question is knowable: the
  reader is standing somewhere new and will complete inside it. So the route
  reads that listing behind the answer — the "first Tab in a directory I just
  entered" case, which no keystroke can cover, because the key comes before this
  side knows the directory exists.
- **Taking a directory warms what is inside it.** Every way a candidate is
  applied (the auto-applied single one, the cycled one, the clicked one) goes
  through one function, and a directory landing there is a promise about the next
  keystroke: the composer holds `logs/` and the next Tab asks what is inside it.
  So the directory just entered is read at once, which is what keeps a Tab-Tab
  walk down a tree from being the slow one.

Measured after all of it, same device: a Tab for a directory nobody has read
still costs 1.1 s — and with these triggers that is now a directory the reader has
not `cd`-ed into, has not completed inside, and has not been standing in when a
command settled. Everything they actually feel is **2–3 ms**: `cd <Tab>` 2.9 ms
(was 1.07 s, the case the keystroke warm alone could not cover — that warm fires
250 ms after the last key, so a reader who types and presses Tab inside that
window still waited: measured warm 34 ms, the Tab behind it 1.07 s); a Tab inside
a directory a `cd` just entered 34 ms, then 2.5 ms; a Tab 12 s after the last read
35 ms, with the re-read landing behind it. In the browser, a real `cd /tmp` was
observed to send `resolve` (770 ms) with the warm for `/tmp` behind it, so the
directory the shell moved into was already read before the next key. On this
machine nothing regressed: the same requests are 6 ms as before, and a warm is a
no-op nobody waits for.

An empty answer carries a **reason code**, not a sentence
(`DshellCompletionNote`): the route knows why and the browser knows the language,
so the same division the rest of the wire uses decides who writes the line. The
answer also carries the **position** it was produced for, which is what the
client's silence rule reads: a non-path argument with no match is usually not a
path at all (`echo hi<Tab>` stays quiet), while a command with no match is a real
answer about the world (本会话的世界里没有以这个前缀开头的命令) and a word
carrying a slash is a path request whose miss is worth reporting (`ls none/<Tab>`
→ 目录不存在).

The whole second phase can be switched off (`子命令与选项` in the settings card,
and the label is the promise: off, Tab still completes command names and paths and
never starts a process for it).

**Not covered**, and deliberately: anything an `alias`, a shell FUNCTION, or a
`PATH` a profile changed would add, when it is not what the command's own
completion function knows. The command list is the file system plus the shell's
own builtins, and the oracle answers only what bash-completion has a spec for; a
name that exists solely in the reader's shell profile is in neither.

## 14. Test layout

The repo had no test runner until completion needed one, so this is the smallest
rig that fits the feature rather than a copy of dsh's:

- Root `vitest` devDependency and one `vitest.config.ts`: node environment,
  `packages/*/*/tests/**/*.spec.ts`, and an alias mapping
  `@nexus-aethra/dshell-std` to its SOURCE, so a spec never depends on a build
  having run. `pnpm test` runs it.
- `packages/dshell/std/tests/shell-line.spec.ts` drives the scanner with lines
  that were actually typed — the project's own history, `sudo rm -rf ./*`,
  `pwd; hostname; id -un`, `sudo apt list | grep mini`, the init line the terminal
  bridge feeds, `make 2>&1 | tail -5`, `ls > out` — because the failure that
  matters is not "the code throws" but "the code reads a real line the way bash
  would".
- `packages/dshell/files/tests/shell-completion.spec.ts` drives the oracle's
  edges without a shell: the probe's quoting invariant, the markers a completion
  function's own stdout must not be able to forge, and the cache's reuse, expiry,
  boundedness, and the single probe two overlapping askers share.
- `packages/dshell/files/tests/readings.spec.ts` drives the caches the warm path
  fills: that a reading lives for seconds and not forever, that two callers of one
  key are answered by ONE read, that a failure is not remembered, and that the
  world is part of the key — the mistake that once served a device's directory out
  of this machine's memory.
- `packages/dshell/mode/tests/data-root.spec.ts` drives the data root against a
  real directory tree: which trees travel and which stay, that nothing at the
  destination is ever overwritten, that a drained root has nothing left to move,
  and that going out, coming home and going out again to the same directory all
  work.
- `packages/dshell/terminal-bridge/tests/dirs-route.spec.ts` drives the picker's
  path rules: `~`, a relative path (resolved against the home, never the
  process's cwd, which a browser cannot see), a path that merely looks like
  `~someone`, and what counts as a directory below the listed one — including a
  symlink to one, which is how people actually move a data root to another disk.

Both specs are about RULES. The route's dispatch, the two-phase timing and the
client's silence rule are verified by hand — a `fetch` against
`/api/dshell/files` on a local and on a device session, then real key events in
the browser (including with the shell switch OFF). dsh's three-tier model (data /
host / GUI) stays the target if the other packages grow rules of their own.

## 15. Where dshell keeps its files

dshell's own data sits under a harness home, exactly as dsh's does: `dshell/`
(device registry and keys, buffer links and grants, session tags, the mount
points device sessions stand in) and `dshell-pty/` (transcripts, their timelines,
the command-history database). The home itself comes from dsh — `$DSH_HOME`, else
`~/.dsh` — and for a long time that was the whole story: to put dshell's files on
another disk you had to move the harness with them.

The settings card now names that directory itself (`dshell` → `dataDir`), and the
distinction is the feature rather than a detail: moving dsh's home moves sessions,
settings and storage, while a reader with a full disk and a big transcript
directory wants only the second. The field is applied by `dshell-mode`'s host
half, and everything about how it is applied follows from two decisions.

**It takes effect at the next start, and the files MOVE.** A running harness
cannot relocate the files it is writing — the transcript of the session on screen
is an open handle — so the choice is stored now and settled when the process next
starts. The settlement runs before anything reads a path: it moves what the old
root was holding, records where the data came from, and reports what it did as a
line on stderr (the harness's own logger has no console exporter, so
`ctx.logger.info` alone is written where nobody looks). What travels is stated as
a list, not derived by scanning, so a tree dshell adds later has to be considered
on purpose:

| what | where it goes |
| --- | --- |
| `dshell/ssh` (minus `ctl/` and the regenerated `askpass.sh`), `dshell/buffer`, `dshell/tags.json`, `dshell-pty` | moves — dshell's own records, which mean the same thing under either root |
| `dshell/mnt/**` | **stays** — each directory is a session's working directory, and dsh recorded that as an absolute path when the session was created; moving them would break every existing device session |
| `dshell/ssh/ctl/**` | stays — Unix sockets belonging to the process that is running right now, recreated on demand |

Nothing at the destination is ever replaced. A file that is already there is
reported and left alone, on both sides, so a reader whose new directory happens
to hold dshell data can diff the two rather than discover a silent overwrite. A
file that cannot move is reported too, and stays where it is.

**The default root remembers where the data went.** The setting can be cleared
again, and "follow the default" has to mean the files come home: a record file in
the default root's `dshell/` names the root currently in force, and the next start
moves everything back. Without it, clearing the field would be a one-way door —
the harness would start with an empty registry while the reader's devices and
transcripts sat on the other disk, intact and undiscovered.

### Why the root is a service and not an environment variable

The obvious shape for this is dsh's own: read an environment variable per call.
The first cut did exactly that — `DSHELL_HOME`, set by the host half at
composition — and it broke a device registry in testing.

The reason is that a SETTING is readable only once the settings service is up,
and by then other plugins have already applied. `dshell-ssh` builds its device
registry during its own apply AND fills a cache that `targetForSession` reads
synchronously (because `spawn` and `resolve` cannot await), so the directory it
resolves at that moment is the one it keeps for the life of the process. Setting
the variable a few milliseconds later was too late: the reader's devices
disappeared, their `devices.json` sitting intact under the old root.

Declaring a dependency is what makes the order a fact instead of a race. The
settlement publishes a seat (`std/src/data-root.ts`,
`DSHELL_DATA_ROOT_SERVICE`) whose value is a promise that settles with the
decision; `dshell-ssh` and `dshell-workspace` declare it in their `inject` lists,
so their applies do not even start until the root is known. A package that only
reads a path LATER — a route call, a shell spawn, a file listing — needs no such
declaration: those all happen after composition, and reading the path where it is
used is the cheaper and equally safe rule. `DSHELL_HOME` still exists as an
override for a deployment that wants to pin the directory from outside, in which
case it wins and nothing moves.

### The picker is dshell's own, and it has to be

The field is a directory on the host machine, and there is no browser primitive
for choosing one: a page cannot read the host's file system, and in the
compositions dshell runs in the browser is not even necessarily on that machine
(a remote `dsh web`, the desktop shell). The host therefore lists its own
directories (`/api/dshell/dirs`, `terminal-bridge/src/dirs-route.ts`) and the card
draws a picker: breadcrumb, up, home, a path field for typing or pasting, and one
button that takes the directory being shown. The route reads DIRECTORIES only
(this names a data root), counts a symlink to a directory as one — `~/dshell-data
-> /mnt/big/dshell` is the normal way to move a data root to another disk — and
reports why it could not read a path (`noDirectory`, `notDirectory`, `noAccess`)
and whether the directory it listed can be written to, because a read-only choice
is refused in words rather than becoming a failure to write after a restart.

## 16. What dshell does not introduce

- No changes to dsh source. No fork.
- No new model-facing tool *other than* the two terminal tools
  (`dshell_get_agent_terminal`, `dshell_terminal_read`), which exist
  solely to give the agent a shell of its own and a read-only view of
  the user's (Phase 9.11).
- No new session events. PTY bytes never reach `ctx.sessionPersistence`.
- No cross-process PTY. Session restart loses PTY scrollback.
- No multi-tab browser surface.

These mirror `dshell-design.md` § 2 and are normative.

## 17. Phase plan

See [`dshell-roadmap.md`](./dshell-roadmap.md). The architecture above
fully specifies what each phase's plugins must produce. The next
practical step is Phase 0 (`dshell-bundle` skeleton) followed by Phase 1
(empty `terminal` target registration).
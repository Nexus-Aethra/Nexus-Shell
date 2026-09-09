# dshell Phase 0 — Setup notes

The minimum toolchain and workspace shape required to boot dsh with
the dshell bundle active. Read this once before touching the repo on
a fresh machine.

## Required tools

| Tool | Version | Source |
|---|---|---|
| Node | **24.21.0** | nvm |
| pnpm | **9.15.0** | wrapper at `~/.local/bin/pnpm` |
| corepack | bundled with Node 24 | (none — provided) |

These versions are pinned because:

- **Node 24** matches dsh CI (`PRIMARY_NODE_VERSION: '24'` in
  `dsh/.github/workflows/build-preview-cloudflare.yml`); pnpm 11.7.0
  crashes on Node 22 with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.
- **pnpm 9.15.0** is the last release whose default workspace hoist
  matches what `dsh/packages/client/tsdown.client.ts` expects. pnpm 10
  leaves workspace packages un-hoisted and breaks `workspaceManifest`
  inside the bundled build.

## Environment

`~/.bashrc` already exports Node 24 bin and `~/.local/bin` (where the
pnpm wrapper lives). It also sets `npm_config_registry` to the
npmmirror mirror; `~/.npmrc` and `~/.config/pnpm/rc` carry the same
for any tool that does not honor env vars.

If you fork or refresh the machine, recreate the bootstrap in this
order:

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 24

# Pin pnpm by direct wrapper (bypass corepack auto-dispatch):
corepack prepare pnpm@9.15.0 --activate
cat > "$HOME/.local/bin/pnpm" <<'WRAP'
#!/usr/bin/env node
require('/home/wpp/.cache/node/corepack/pnpm/9.15.0/bin/pnpm.cjs')
WRAP
chmod +x "$HOME/.local/bin/pnpm"

# npm mirror
cat > ~/.npmrc <<'EOF'
registry=https://registry.npmmirror.com/
fetch-retries=5
fetch-retry-mtimeout=60000
EOF
mkdir -p ~/.config/pnpm
cat > ~/.config/pnpm/rc <<'EOF'
registry=https://registry.npmmirror.com/
strict-peer-dependencies=false
auto-install-peers=true
EOF
```

## Workspace shape

The Nexus-Shell repository lives next to the dsh checkout:

```
~/.bashrc                 # node + pnpm bootstrap (created by setup, outside the repo)
Nexus-Shell/
├── dsh/                   # local reference checkout, never tracked
├── docs/                  # design contract and roadmap
├── packages/dshell/
│   ├── bundle/            # dsh bundle: profile patch layer
│   ├── conversation/      # target `terminal`: host stub + browser ViewBuilder
│   ├── terminal-bridge/   # ws upgrade + PtyBuffer (Phase 2+)
│   ├── mode/              # composer toggle (Phase 5+)
│   └── commands/          # /clear /new /compact + model tool (Phase 6/8)
├── scripts/
│   ├── install-into-dsh-profile.sh
│   └── bootstrap-profile-client.sh
├── tsdown.dshell.preset.ts
└── (root) package.json + pnpm-workspace.yaml + tsconfig.*.json
```

`dsh/` is git-ignored in `.gitignore` so the upstream reference is
never accidentally pushed.

## Build order

```
1. dsh/         pnpm install --no-frozen-lockfile   (one-time, pnpm 10 lockfile write is fine)
                pnpm run build:lib
                pnpm run build:web
2. Nexus-Shell/ pnpm install
                pnpm --filter "@deepseek-ai/dsh-dshell-*" run build
3. (one-time)   ./scripts/install-into-dsh-profile.sh
4. (one-time)   ./scripts/bootstrap-profile-client.sh
5. (each session) cd dsh && pnpm dsh web
```

After step 4, the dsh web profile picks up dshell automatically — no
`--patch` flag needed — and both the host stack and the client bundle
roster are materialized.

## Why three pnpm operations for the dshell side

- `pnpm install` populates `Nexus-Shell/node_modules` with the dsh
  sibling packages via `link:` paths in each dshell `package.json`.
- `pnpm --filter ... run build` runs `tsc` to emit `lib/index.js` and
  `lib/client/index.js` for every dshell package. dsh resolves those
  files at boot, not the source TypeScript.
- `./scripts/install-into-dsh-profile.sh` runs `pnpm dsh plugin add`
  five times against `$DSH_HOME/profiles/web`, which materializes the
  dshell packages (plus their transitive deps) inside the profile's
  own `node_modules`. Only `dshell-bundle` becomes a `dsh.bundle`
  layer; the other four are plain runtime deps of the bundle.

Re-running the script is safe: pnpm no-ops when packages are already
installed.

## Client bundles: the `__ModuleLoader__` closure contract

dsh's browser side does not load plugins as ES modules. Every client
bundle must be a CJS closure handed to the module table:

```js
window.__ModuleLoader__.load({ id: '<pkg-name>', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* ... compiled plugin face ... */
  return module.exports; } });
```

A raw ESM bundle (`export const apply = ...`) throws a syntax error
inside the combo loader, which **kills the whole module table** — the
page then fails with `loaded without registering "<pkg>" via
__ModuleLoader__.load` for *every* dsh package, not just the malformed
one. Symptom: `Failed to load plugins` on boot.

dsh builds its own bundles with `dsh/packages/client/tsdown.client.ts`,
but that preset cannot run outside the dsh repository (its
`workspaceManifest` globs `dsh/packages/*/*` only). The repo-root
`tsdown.dshell.preset.ts` reproduces the artifact contract locally:

- `format: 'cjs'`, `platform: 'browser'`, and `entryFileNames:
  'client.js'` — dsh's bundle server (`dsh-client-modules`) serves
  exactly `lib/client.js` per package under `/plugins/`.
- `banner` / `intro` / `footer` must sit **inside `outputOptions`**,
  matching dsh's own preset. A top-level `banner` is honored but a
  top-level `intro` is silently dropped, and the `intro` is what
  defines the `exports` the CJS interop writes to — losing it yields
  `exports is not defined` at load time.
- The banner stamps the package id into the `__ModuleLoader__.load`
  handoff; it must match the `name` in the package manifest exactly.

Client-face packages (`conversation`, `terminal-bridge`, `mode`) wrap
the preset in `tsdown.config.ts` and run it via
`tsdown --config-loader tsx` — `tsx` is a root devDependency because
tsdown cannot resolve its own config loader from a foreign workspace.
The `MIXED_EXPORTS` warning during `build:client` is benign: dsh
consumes the factory closure, not the CJS `module.exports`.

The `dshell-bundle` patch also disables dsh's `client-hmr` row. HMR is
dev-only but ships in the client roster, and a missing HMR bundle is a
hard load failure outside the dsh dev workflow.

## Common pitfalls

- **`Cannot find package '@deepseek-ai/dsh-dshell-...' imported from /home/wpp/.dsh/profiles/web/`** — the dshell packages have
  not been installed into the profile. Run
  `./scripts/install-into-dsh-profile.sh`.
- **`Cannot find module '...lib/index.js'`** — the dshell package was
  built but its sibling copy in the profile's `node_modules` is
  stale. Run `pnpm --filter ... run build` again, then
  `./scripts/install-into-dsh-profile.sh`.
- **`Cannot get property "uiConversation" without inject`** — the
  `ConversationViewDefinition` registration belongs in the browser
  face (`src/client/index.ts`), not the host face. `uiConversation` is
  a browser-only service. See
  `packages/dshell/conversation/src/client/index.ts` for the working
  shape.
- **`service "sandbox" has been registered`** — never re-add
  `dsh-sandbox-local` or `dsh-subprocess-local` in the dshell bundle
  patch; dsh's web profile already mounts them. The dshell patch only
  inserts new ids.
- **`tsdown: no packages/*/*/package.json declares the name ...`** —
  dsh's `tsdown.client.ts` globs `dsh/packages/*/*` only. Do not
  reuse it from dshell packages — use the local
  `tsdown.dshell.preset.ts` instead.
- **`loaded without registering "<pkg>" via __ModuleLoader__.load`
  for many packages at once** — one bundle in the combo failed to
  execute. For dshell bundles the usual cause is raw ESM output; see
  the closure-contract section above. Rebuild with
  `pnpm --filter "@deepseek-ai/dsh-dshell-*" run build:client`, then
  reinstall and restart.
- **`exports is not defined`** — the tsdown preset's
  `banner`/`footer`/`intro` were hoisted out of `outputOptions`. Only
  the nested form survives; see above.

## Verifying Phase 0

After the build and install steps:

```sh
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/
# Expected: 401 (dsh's cookie auth gate, the post-install default)
```

If you see `000`, the server is not up. If you see `200`, you bypassed
the gate — make sure you are not following a redirect from a
tokenized URL.

### What Phase 0 actually proves

The 401 response confirms **three** things and **only** those:

1. dsh's host-side boot succeeded with the `web` profile stack.
2. The `dshell-bundle` patch layer landed in `dsh.profile.bundles`
   (see `$DSH_HOME/profiles/web/package.json`) and the dshell Cordis
   plugins activated without throwing.
3. dsh's cookie-auth gate (`ctx.connection.authorizeIndex`) is
   reachable.

The 401 alone does **not** prove the browser UI renders. dsh's web
profile populates its `client/` roster from `apps/web/package.json`'s
dev deps plus the `dsh.client` rows in
`bundle/web-app/cordis.patch.yml`, and the corresponding
`lib/client.js` files must exist under
`$HOME/.dsh/profiles/web/node_modules/@deepseek-ai/...`. On a fresh
profile **none of those client bundles are materialised** — dsh
assumes the profile lives inside the dsh monorepo and reaches every
package via workspace `link:` paths, but dshell runs the profile as an
independent workspace. Two provisioning steps close the gap:

1. `./scripts/install-into-dsh-profile.sh` — registers the four dshell
   plugins plus the bundle layer (see *Why three pnpm operations*).
2. `./scripts/bootstrap-profile-client.sh` — mirrors dsh's monorepo
   dependency closure into the profile by adding every
   `@deepseek-ai/dsh-*` runtime dep of `dsh-web-app` as a `link:` spec
   pointing at the sibling `dsh/` checkout (~82 packages), which also
   exposes the built `dsh-web-frontend` dist. Re-running is safe.

Browser-side acceptance after both steps: the page renders the full
dsh UI with no `Failed to load plugins` banner, and the boot payload
(`window.__DSH_BOOT__.entries`) advertises all client entries including
the three dshell bundles (`dsh-dshell-conversation`,
`dsh-dshell-terminal-bridge`, `dsh-dshell-mode`). Verified in-browser
on 2026-09-09.

## Where to go next

- Read [`dshell-design.md`](./dshell-design.md) and
  [`dshell-architecture.md`](./dshell-architecture.md) before
  touching Phase 1+ code.
- Phase 0.5 (client provisioning, closure-format bundles, in-browser
  verification) is complete — its artifacts are the two
  `scripts/*.sh` files and `tsdown.dshell.preset.ts`. Continue with
  Phase 1+ in [`dshell-roadmap.md`](./dshell-roadmap.md).
- The `terminal` target's browser ViewBuilder keeps its empty snapshot
  shape until Phase 4 adds the xterm.js canvas.
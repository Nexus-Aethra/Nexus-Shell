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
Nexus-Shell/
├── .bashrc                # node + pnpm bootstrap (created by setup)
├── dsh/                   # local reference checkout, never tracked
├── docs/                  # design contract and roadmap
├── packages/dshell/
│   ├── bundle/            # dsh bundle: profile patch layer
│   ├── conversation/      # target `terminal`: host stub + browser ViewBuilder
│   ├── terminal-bridge/   # ws upgrade + PtyBuffer (Phase 2+)
│   ├── mode/              # composer toggle (Phase 5+)
│   └── commands/          # /clear /new /compact + model tool (Phase 6/8)
├── scripts/
│   └── install-into-dsh-profile.sh
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
4. (each session) cd dsh && pnpm dsh web
```

After step 3, the dsh web profile picks up dshell automatically — no
`--patch` flag needed.

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
  reuse it from dshell packages — they should emit with plain
  `tsc --emitDeclarationOnly false` instead.

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

It does **not** prove the browser UI renders. dsh's web profile
populates its `client/` roster from `apps/web/package.json`'s dev
deps plus the `dsh.client` rows in `bundle/web-app/cordis.patch.yml`,
and the corresponding `lib/client.js` files must exist under
`$DSH_HOME/profiles/web/node_modules/@deepseek-ai/...`. When you run
`pnpm dsh web` for the first time on a fresh profile, **none of those
client bundles are materialised** — dsh does not invoke
`pnpm --filter @deepseek-ai/dsh-web-frontend run build` itself. The
host-side stack works because it never touches the browser half;
the browser stack fails on first render with
`client-modules: bundle /plugins/...?@deepseek-ai/dsh-client-hmr/client.js
loaded without registering "@deepseek-ai/dsh-client-hmr" via
__ModuleLoader__.load` and similar errors for every other dsh
client package.

This is a dsh provisioning gap, not a dshell bug. Phase 0 ends at
the 401 boundary; rendering the full Web UI is a Phase 1 prerequisite
that lives outside dshell's design. Phase 1 adds the client bundles
by whatever means dsh upstream eventually ships — likely a
`pnpm --filter @deepseek-ai/dsh-web-frontend run build` invocation
followed by a profile reinstall.

If a future dsh release ships a built dist inside the profile setup,
the 401 + browser-render checks will collapse into one. Until then,
treat the browser half as a downstream check, not a Phase 0
deliverable.

## Where to go next

- Read [`dshell-design.md`](./dshell-design.md) and
  [`dshell-architecture.md`](./dshell-architecture.md) before
  touching Phase 1+ code.
- Phase 1 lands the first non-stub: the `terminal` target's browser
  ViewBuilder must keep its empty snapshot shape until Phase 4 adds the
  xterm.js canvas.
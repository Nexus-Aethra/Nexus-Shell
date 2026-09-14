// Shared tsdown preset for dshell client bundles.
//
// dsh's module table loads every browser plugin as a closure artifact:
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
//
// The upstream preset lives at dsh/packages/client/tsdown.client.ts, but it
// cannot run outside the dsh repository (its workspaceManifest globs the
// dsh packages tree only). This preset reproduces the artifact contract
// locally for dshell packages: CJS output, browser platform, the same
// banner/intro/footer, and the emitted file name lib/client.js that dsh's
// client bundle server expects.
//
// The config is a plain object: importing tsdown from this repo-root file
// would fail because tsdown is a per-package devDependency, not a root one.

interface DshellClientBundleConfig {
  entry: Record<string, string>
  outDir: string
  format: 'cjs'
  platform: 'browser'
  target: string
  dts: false
  sourcemap: boolean
  clean: false
  define: Record<string, string>
  deps: {
    /** Specifiers the loader's `require` answers; never inlined. */
    neverBundle: string[]
    /** Dependency specifiers to force-inline (rolldown auto-externals deps). */
    alwaysBundle: string[]
    /** `false` silences the unintended-bundling hint; see the call site. */
    onlyBundle: false
  }
  outputOptions: {
    entryFileNames: string
    sourcemapExcludeSources: false
    // The closure handoff lives here rather than at the top level: tsdown
    // honors a top-level `banner` but not a top-level `intro`, and the intro is
    // what defines the `module`/`exports` bindings the CJS interop writes to.
    banner: string
    footer: string
    intro: string
  }
}

/**
 * Build the client bundle config for one dshell package.
 * @param id - package name; stamped into the __ModuleLoader__.load handoff.
 * @param entry - tsc-emitted JS entry for the browser face (lib/client/index.js).
 * @param inline - dependency specifiers to bundle instead of `require`-ing:
 *   the combo loader's require only knows the dsh platform modules, so any
 *   runtime dependency outside that table must be inlined here.
 * @returns tsdown config emitting lib/client.js in the closure format.
 */
export function dshellClientBundle(
  id: string,
  entry = 'lib/client/index.js',
  inline: string[] = [],
): DshellClientBundleConfig {
  return {
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    // Inlined libraries reference Node's `process.env.NODE_ENV` for their
    // dev/prod switches; the closure bundle runs in a browser with no
    // `process`, so the reference is baked to production at build time.
    define: { 'process.env.NODE_ENV': '"production"' },
    deps: {
      // dsh's module table only serves its own PLATFORM_MODULES plus registered
      // client plugins, so a `require` of one of OUR support packages fails the
      // plugin load — which is exactly what happened when the contracts moved
      // into `dshell-std` and the bundler externalized it as a dependency. The
      // standard layer is contracts and seam helpers: tiny, stateless, and safe
      // to inline into every face, so it is always inlined rather than listed
      // per package.
      alwaysBundle: ['@nexus-aethra/dshell-std', ...inline],
      // Module-table specifiers (dsh packages/client/web/src/platform.ts
      // PLATFORM_MODULES) that dshell client faces resolve through the
      // injected require instead of inlining. Extend when a face gains
      // another runtime import; type-only imports are erased by tsc before
      // this bundler runs.
      neverBundle: [
        'react',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-store',
        // The icon/primitive set dsh's own panes draw with (dshell-files uses
        // it); present in PLATFORM_MODULES, so the loader serves it rather than
        // us bundling a second copy.
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
      // `alwaysBundle` above is the intent, and a strict whitelist would have
      // to enumerate every transitive dependency of the inlined libraries
      // (@xyflow/react's graph engine alone pulls several); `false` silences
      // the unintended-bundling hint without turning that list into a chore
      // that fails the build whenever a library gains a dependency.
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      // banner/footer/intro belong under outputOptions (matching dsh's own
      // preset): top-level banner is honored but intro is not, and the
      // intro is what defines the `exports` the CJS interop writes to.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
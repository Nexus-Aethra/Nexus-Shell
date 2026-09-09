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
  external: string[]
  outputOptions: {
    entryFileNames: string
    sourcemapExcludeSources: false
  }
  banner: string
  footer: string
  intro: string
}

/**
 * Build the client bundle config for one dshell package.
 * @param id - package name; stamped into the __ModuleLoader__.load handoff.
 * @param entry - tsc-emitted JS entry for the browser face (lib/client/index.js).
 * @returns tsdown config emitting lib/client.js in the closure format.
 */
export function dshellClientBundle(
  id: string,
  entry = 'lib/client/index.js',
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
    // Module-table specifiers (dsh packages/client/web/src/platform.ts
    // PLATFORM_MODULES) that dshell client faces resolve through the
    // injected require instead of inlining. Extend when a face gains
    // another runtime import; type-only imports are erased by tsc before
    // this bundler runs.
    external: ['react', '@deepseek-ai/cordis'],
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
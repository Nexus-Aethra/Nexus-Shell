import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Specs for dshell's PURE logic — the parts that answer a question rather than
 * talk to a service: the shell line's tokenizer and position rule table
 * (`std`), and the parsers and caches the host halves keep next to them.
 *
 * Two deliberate limits, both about keeping the suite independent of the
 * harness: the environment is plain Node (no DOM, no jsdom), and specs import
 * SOURCE — the workspaces link each package's built `lib/`, so without the
 * alias below a spec would silently test a stale artifact instead of the code
 * it is next to. Anything needing a session, a PTY, or a browser is verified
 * against a live harness instead (see docs/dshell-roadmap.md).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@nexus-aethra/dshell-std': fileURLToPath(new URL('./packages/dshell/std/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/*/tests/**/*.spec.ts'],
  },
})

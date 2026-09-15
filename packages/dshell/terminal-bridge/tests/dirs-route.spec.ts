/**
 * The directory browser: what a typed path resolves to, and what the picker is
 * shown below it.
 *
 * Two things are pinned down here and both are about the reader's expectations
 * rather than about the code being clever. First, the path rules: `~` means the
 * host user's home, a relative path means "below that home" (never below the
 * harness's working directory, which a browser cannot see and would therefore
 * misread), and a path that merely LOOKS like `~someone` is left alone because
 * it names another account. Second, what counts as a directory: a symlink to
 * one does — moving a data root to another disk is usually exactly that — while
 * a file and a symlink to a file do not.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDirectories, resolveBrowsePath } from '../src/dirs-route.js'

/** Every tree a spec made, removed afterwards. */
const made: string[] = []

/** A directory under the system temp root, removed when the spec ends. */
function scratch(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `dshell-dirs-${name}-`))
  made.push(path)
  return path
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('resolving a typed path', () => {
  const home = '/home/u'

  it('opens at the home directory when nothing was asked for', () => {
    expect(resolveBrowsePath(undefined, home)).toBe(home)
    expect(resolveBrowsePath('', home)).toBe(home)
    expect(resolveBrowsePath('   ', home)).toBe(home)
    expect(resolveBrowsePath('~', home)).toBe(home)
  })

  it('expands ~ and resolves a relative path against the home, not the cwd', () => {
    expect(resolveBrowsePath('~/dshell-data', home)).toBe('/home/u/dshell-data')
    expect(resolveBrowsePath('dshell-data', home)).toBe('/home/u/dshell-data')
    expect(resolveBrowsePath('data/../dshell', home)).toBe('/home/u/dshell')
  })

  it('leaves an absolute path alone and refuses to guess another account', () => {
    expect(resolveBrowsePath('/mnt/big', home)).toBe('/mnt/big')
    expect(resolveBrowsePath('/', home)).toBe('/')
    // `~someone` is not a home this process can expand, and silently resolving
    // it against the READER's home would list a directory they never named.
    expect(resolveBrowsePath('~someone/dir', home)).toBe('/home/u/~someone/dir')
  })
})

describe('listing the directories below a path', () => {
  it('lists directories and links to them, sorted, and never files', () => {
    const root = scratch('tree')
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'notes.txt'), 'x\n')
    symlinkSync(join(root, 'alpha'), join(root, 'link-to-dir'))
    symlinkSync(join(root, 'notes.txt'), join(root, 'link-to-file'))

    return listDirectories(root).then(({ entries, truncated }) => {
      expect(entries.map(entry => entry.name)).toEqual(['.hidden', 'alpha', 'link-to-dir', 'zeta'])
      expect(truncated).toBe(false)
      // Every entry carries the absolute path the field will store.
      expect(entries[1]?.path).toBe(join(root, 'alpha'))
    })
  })

  it('reports an empty directory as empty rather than as a failure', async () => {
    const root = scratch('empty')
    expect(await listDirectories(root)).toEqual({ entries: [], truncated: false })
  })
})

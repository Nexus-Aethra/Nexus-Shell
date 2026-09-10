/**
 * Pure-function checks for the command splitter.
 *
 * Run: `pnpm --filter @deepseek-ai/dsh-dshell-terminal-bridge exec tsx scripts/check-commands.ts`
 * (or from the repo root: `pnpm tsx packages/dshell/terminal-bridge/scripts/check-commands.ts`).
 *
 * The splitter is the only piece of the context-management cursor that can be
 * checked without a live PTY, so it is checked here rather than only through
 * the browser.
 */

import assert from 'node:assert/strict'
import {
  createSplitter, sanitizeTerminalText, sliceWindow, splitOutput, stripAnsi, trackInput,
} from '../src/commands.js'

const MARK = (code: number): string => `\u001b]133;D;${String(code)}\u0007`
const PROMPT = 'wpp@wpp:~/x$ '
const CRLF = '\r\n'

let passed = 0
function check(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`ok  ${name}`)
}

check('pairs a typed command with its output and exit code', () => {
  const state = createSplitter()
  trackInput(state, 'ls -la\r')
  const records = splitOutput(state, `${PROMPT}ls -la${CRLF}total 0${CRLF}${MARK(0)}`, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0]!.command, 'ls -la')
  assert.equal(records[0]!.exitCode, 0)
  assert.equal(records[0]!.output.trim(), 'total 0')
})

check('records a non-zero exit code', () => {
  const state = createSplitter()
  trackInput(state, 'false\r')
  const records = splitOutput(state, `${PROMPT}false${CRLF}${MARK(1)}`, 1)
  assert.equal(records[0]!.exitCode, 1)
  assert.equal(records[0]!.command, 'false')
})

check('handles a marker split across chunks', () => {
  const state = createSplitter()
  trackInput(state, 'echo hi\r')
  const first = splitOutput(state, `${PROMPT}echo hi${CRLF}hi${CRLF}\u001b]133;D`, 1)
  assert.equal(first.length, 0)
  const second = splitOutput(state, `;0\u0007`, 2)
  assert.equal(second.length, 1)
  assert.equal(second[0]!.exitCode, 0)
  assert.equal(second[0]!.output.trim(), 'hi')
})

check('tracks backspace, Ctrl+C and Ctrl+U edits', () => {
  const state = createSplitter()
  trackInput(state, 'lss\u007f\r') // "lss" then backspace -> "ls"
  trackInput(state, 'ignored\u0003') // Ctrl+C abandons
  trackInput(state, 'also ignored\u0015') // Ctrl+U abandons
  trackInput(state, 'pwd\r')
  const records = splitOutput(
    state,
    `${PROMPT}ls${CRLF}${MARK(0)}${PROMPT}${MARK(0)}${PROMPT}pwd${CRLF}/tmp${CRLF}${MARK(0)}`,
    1,
  )
  assert.deepEqual(records.map(r => r.command), ['ls', 'pwd'])
})

check('ignores ANSI/CSI input sequences (arrows do not leak into the line)', () => {
  const state = createSplitter()
  trackInput(state, '\u001b[A\u001b[Cgit status\r') // up, right, then text
  const records = splitOutput(state, `${PROMPT}git status${CRLF}${MARK(0)}`, 1)
  assert.equal(records[0]!.command, 'git status')
})

check('an untracked command still yields a record with its output', () => {
  const state = createSplitter()
  // No trackInput: the shell printed a prompt and a command we never saw
  // (history recall, a marker-only shell, an external writer).
  const records = splitOutput(state, `${PROMPT}mystery${CRLF}answer${CRLF}${MARK(0)}`, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0]!.command, '')
  assert.equal(records[0]!.output.trim(), 'answer')
})

check('two commands in one chunk keep their own outputs', () => {
  const state = createSplitter()
  trackInput(state, 'a\r')
  trackInput(state, 'b\r')
  const records = splitOutput(
    state,
    `${PROMPT}a${CRLF}out-a${CRLF}${MARK(0)}${PROMPT}b${CRLF}out-b${CRLF}${MARK(2)}`,
    1,
  )
  assert.deepEqual(records.map(r => r.command), ['a', 'b'])
  assert.deepEqual(records.map(r => r.output.trim()), ['out-a', 'out-b'])
  assert.deepEqual(records.map(r => r.exitCode), [0, 2])
})

check('strips OSC markers and control sequences for the model', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red')
  assert.equal(stripAnsi('\u001b]0;title\u0007body'), 'body')
  assert.equal(sanitizeTerminalText(`${PROMPT}ls${CRLF}${MARK(0)}`), `${PROMPT}ls\n`)
  assert.equal(sanitizeTerminalText('a\r\nb\rc'), 'a\nbc')
})

check('truncates oversized output with an explicit marker', () => {
  const state = createSplitter()
  const huge = 'x'.repeat(20 * 1024)
  trackInput(state, 'cat big\r')
  const records = splitOutput(state, `${PROMPT}cat big${CRLF}${huge}${CRLF}${MARK(0)}`, 1)
  assert.match(records[0]!.output, /省略/)
})

check('sliceWindow returns only what the cursor has not seen', () => {
  const full = 'aaa\nbbb\nccc\n'
  const abs = Buffer.byteLength(full, 'utf8')
  const first = sliceWindow(full, abs, 0)
  assert.equal(first.text, full)
  assert.equal(first.dropped, false)
  const cursor = Buffer.byteLength('aaa\nbbb\n', 'utf8')
  const rest = sliceWindow(full, abs, cursor)
  assert.equal(rest.text, 'ccc\n')
  assert.equal(rest.dropped, false)
  // Re-reading the same cursor is empty: no duplication across turns.
  assert.equal(sliceWindow(full, abs, abs).text, '')
})

check('sliceWindow flags an offset that fell out of the retained window', () => {
  const windowText = 'ccc\nddd\n' // aaa/bbb already dropped from memory
  const abs = 20
  const slice = sliceWindow(windowText, abs, 4) // window starts at 20 - 8 = 12
  assert.equal(slice.dropped, true)
  assert.equal(slice.text, windowText)
  assert.equal(slice.start, 12)
})

check('sliceWindow clamps an offset past the end', () => {
  const slice = sliceWindow('abc', 3, 99)
  assert.equal(slice.dropped, true)
  assert.equal(slice.text, '')
  assert.equal(slice.start, 3)
})

console.log(`\n${String(passed)} checks passed`)

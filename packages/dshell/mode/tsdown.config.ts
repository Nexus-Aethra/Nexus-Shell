import { dshellClientBundle } from '../../../tsdown.dshell.preset.ts'

// @xterm/xterm ships the canvas renderer; the combo loader's require only
// knows the dsh platform modules, so it must be inlined into client.js.
export default dshellClientBundle('@deepseek-ai/dsh-dshell-mode', 'lib/client/index.js', ['@xterm/xterm'])

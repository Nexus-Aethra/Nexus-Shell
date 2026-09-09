import { clientBundle } from '../../../dsh/packages/client/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-dshell-commands', [
  'lib/types/index.js',
], { hostPhase: true })
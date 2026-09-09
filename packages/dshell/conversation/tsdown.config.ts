/**
 * dshell-conversation build face: the dsh client.tsdown preset produces
 * one node-half lib and one browser-half lib/client.js. Phase 1 ships
 * only the empty ViewDefinition; the bundle row's cordis patch installs
 * this package under id `dshell-conversation`.
 */
import { clientBundle } from '../../../dsh/packages/client/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-dshell-conversation', [
  'lib/types/index.js',
])
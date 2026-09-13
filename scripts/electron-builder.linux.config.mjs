/**
 * electron-builder configuration for the linux-x64 desktop build.
 *
 * Upstream's own config is used for everything — targets, extraResources, the
 * signing hooks, the update feed — and only one field is added. Upstream's
 * package name is `@deepseek-ai/dsh-desktop`, electron-builder derives
 * `executableName` from it as `@deepseek-aidsh-desktop`, and the AppImage target
 * then refuses to build it: "executableName contains characters that cannot be
 * safely used in file paths". The `--dir` target tolerates the character, so this
 * only surfaces the moment an AppImage is requested. Naming the executable here
 * keeps `dsh/` untouched and also matches the `artifactName` upstream already
 * sets (`deepseek-harness-<version>-<os>-<arch>.<ext>`).
 */

import { createElectronBuilderConfig } from '../dsh/apps/desktop/electron-builder.config.mjs'

export default {
  ...createElectronBuilderConfig(process.env),
  executableName: 'deepseek-harness',
}

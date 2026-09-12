/**
 * dshell-ssh wire — one exact `/api/dshell/ssh` route, plus the device shapes
 * both halves agree on.
 *
 * The route carries what must not travel through the settings document: the
 * private keys themselves. A device's durable record is small JSON; its key is
 * a separate file written 0600 under `$DSH_HOME/dshell/ssh/keys/`.
 *
 * This module is imported by the browser half through the package's
 * `./protocol` subpath, so it must stay free of value imports: anything it
 * pulls in would be bundled into the client.
 */

/** Exact `/api` route path owned by the SSH device registry. */

// Moved to the shared standard layer: these are wire contracts, not this
// package's, and both halves of every plugin read the same declaration there.
// Re-exported so existing importers keep one import site per package.
export { DSHELL_SSH_PATH, SSH_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-dshell-std'
export type { DeviceAuth, DeviceView, DeviceInput, DeviceBinding, SshRequest, SshResponse } from '@deepseek-ai/dsh-dshell-std'

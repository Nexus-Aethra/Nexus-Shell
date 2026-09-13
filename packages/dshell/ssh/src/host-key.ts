/**
 * What this machine will accept as a device's host key.
 *
 * Read back from this plugin's OWN known_hosts rather than asked of the device:
 * anything the device reports travels over the very connection whose identity is
 * in question, so an interposed host can answer with whatever fingerprint it
 * likes. The local store is the only source that means "what dshell will accept
 * the next time it connects".
 *
 * `ssh-keygen` is spawned directly rather than through `ctx.subprocess`: this is
 * a local, read-only lookup with no output to stream and nothing to sandbox,
 * resolved from the same PATH the `ssh` client is already spawned by name from.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { sshKnownHostsPath } from './paths.js'

const run = promisify(execFile)

/**
 * The spelling OpenSSH stores a destination under: bare host on the default
 * port, `[host]:port` otherwise. Getting this wrong silently reports "nothing
 * trusted" for every non-default port.
 *
 * @param host - device host.
 * @param port - device port.
 * @returns the known_hosts host field.
 */
export function knownHostsLookup(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${String(port)}`
}

/** The key blob of one known_hosts entry, wherever the host field sits. */
function entryBlob(line: string): string | undefined {
  const fields = line.trim().split(/\s+/)
  const at = fields.findIndex(field => /^(ssh-|ecdsa-|sk-)/.test(field))
  return at < 0 ? undefined : fields[at + 1]
}

/** OpenSSH's fingerprint spelling: SHA-256 of the blob, base64, unpadded. */
export function fingerprintOf(blob: string): string {
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

/**
 * The host key fingerprint dshell trusts for one destination.
 *
 * @param host - device host.
 * @param port - device port.
 * @returns the fingerprint, or undefined when nothing is recorded yet (or the
 *   lookup itself is unavailable — every such case means "nothing to report").
 */
export async function trustedHostKey(host: string, port: number): Promise<string | undefined> {
  try {
    const { stdout } = await run('ssh-keygen', [
      '-F', knownHostsLookup(host, port), '-f', sshKnownHostsPath(),
    ])
    const entry = stdout.split('\n').find(line => line.trim() !== '' && !line.startsWith('#'))
    const blob = entry === undefined ? undefined : entryBlob(entry)
    return blob === undefined ? undefined : fingerprintOf(blob)
  } catch {
    // Not trusted yet, no store, or no ssh-keygen on PATH: all the same answer.
    return undefined
  }
}

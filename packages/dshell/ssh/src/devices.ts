/**
 * The durable SSH device registry and its key material.
 *
 * Records live in one JSON document (`$DSH_HOME/dshell/ssh/devices.json`);
 * private keys are separate files under `keys/<device-id>` written 0600, so a
 * key never appears in a document that other features might read or echo.
 * Both are read lazily on the first operation and rewritten atomically.
 *
 * Key material is write-only from the API's point of view: `DeviceView` reports
 * only whether a key exists, never its contents.
 */

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeviceInput, DeviceView } from './protocol.js'

/** A stored device record; `keyFile` is the basename of its key, when one exists. */
interface DeviceRecord {
  id: string
  name: string
  host: string
  port: number
  user: string
  remoteRoot: string
  /** Absolute path of the private key file, absent when the device has none. */
  keyFile?: string
}

/** A device id safe to interpolate into a path. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Connection parameters resolved for one `ssh` invocation. */
export interface DeviceConnection {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  readonly user: string
  readonly remoteRoot: string
  readonly keyFile: string | undefined
}

/** Coerce one parsed record, dropping anything that cannot be used. */
function asRecord(value: unknown): DeviceRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return undefined
  if (typeof raw.host !== 'string' || raw.host.length === 0) return undefined
  if (typeof raw.user !== 'string' || raw.user.length === 0) return undefined
  const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65_536
    ? raw.port
    : 22
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.host,
    host: raw.host,
    port,
    user: raw.user,
    remoteRoot: typeof raw.remoteRoot === 'string' && raw.remoteRoot.length > 0 ? raw.remoteRoot : '~',
    ...typeof raw.keyFile === 'string' && raw.keyFile.length > 0 ? { keyFile: raw.keyFile } : {},
  }
}

/** Derive a stable, path-safe id from a device name. */
function idFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug.length > 0 ? slug : `device-${Date.now().toString(36)}`
}

/** The registry. */
export class DeviceStore {
  private loaded = false
  private records: DeviceRecord[] = []

  /**
   * @param root - device directory (`$DSH_HOME/dshell/ssh`).
   */
  constructor(private readonly root: string) {}

  /** The device document path. */
  private get documentPath(): string {
    return join(this.root, 'devices.json')
  }

  /** The key directory. */
  private get keyDir(): string {
    return join(this.root, 'keys')
  }

  /** Every device, in registration order. */
  async list(): Promise<readonly DeviceView[]> {
    await this.ensure()
    return this.records.map(record => this.view(record))
  }

  /** Resolve one device for execution, or undefined when unknown. */
  async connection(deviceId: string): Promise<DeviceConnection | undefined> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === deviceId)
    if (record === undefined) return undefined
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      user: record.user,
      remoteRoot: record.remoteRoot,
      keyFile: record.keyFile,
    }
  }

  /**
   * Create or update one device. A supplied key replaces the stored one; an
   * empty key removes it; an omitted key leaves it alone.
   * @param input - the submitted device; `id` absent means create.
   * @returns the saved view.
   */
  async save(input: DeviceInput): Promise<DeviceView> {
    await this.ensure()
    const id = input.id ?? this.uniqueId(idFor(input.name))
    const existing = this.records.find(record => record.id === id)
    if (input.id !== undefined && existing === undefined) throw new Error(`未知设备：${input.id}`)
    const record: DeviceRecord = {
      id,
      name: input.name.trim() !== '' ? input.name.trim() : (existing?.name ?? input.host),
      host: input.host.trim(),
      port: input.port ?? existing?.port ?? 22,
      user: input.user.trim(),
      remoteRoot: input.remoteRoot?.trim() !== undefined && input.remoteRoot.trim() !== ''
        ? input.remoteRoot.trim()
        : (existing?.remoteRoot ?? '~'),
      ...existing?.keyFile === undefined ? {} : { keyFile: existing.keyFile },
    }
    if (record.host === '' || record.user === '') throw new Error('host 与 user 不能为空')
    if (input.key !== undefined) {
      if (input.key.trim() === '') {
        await this.removeKey(record)
      } else {
        const keyFile = await this.writeKey(record.id, input.key)
        record.keyFile = keyFile
      }
    }
    this.records = existing === undefined
      ? [...this.records, record]
      : this.records.map(candidate => candidate.id === id ? record : candidate)
    await this.saveDocument()
    return this.view(record)
  }

  /**
   * Remove one device and its key.
   * @param deviceId - device to remove.
   */
  async remove(deviceId: string): Promise<void> {
    await this.ensure()
    const record = this.records.find(candidate => candidate.id === deviceId)
    if (record === undefined) return
    await this.removeKey(record)
    this.records = this.records.filter(candidate => candidate.id !== deviceId)
    await this.saveDocument()
  }

  private view(record: DeviceRecord): DeviceView {
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      user: record.user,
      remoteRoot: record.remoteRoot,
      hasKey: record.keyFile !== undefined,
    }
  }

  /** Mint an id that is not taken yet. */
  private uniqueId(base: string): string {
    if (!this.records.some(record => record.id === base)) return base
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${String(n)}`
      if (!this.records.some(record => record.id === candidate)) return candidate
    }
  }

  /** Write one private key with owner-only permissions. */
  private async writeKey(deviceId: string, key: string): Promise<string> {
    await mkdir(this.keyDir, { recursive: true, mode: 0o700 })
    const path = join(this.keyDir, deviceId)
    // A trailing newline is required by OpenSSH's key parser.
    const body = key.endsWith('\n') ? key : `${key}\n`
    await writeFile(path, body, { mode: 0o600 })
    await chmod(path, 0o600)
    return path
  }

  private async removeKey(record: DeviceRecord): Promise<void> {
    if (record.keyFile === undefined) return
    await rm(record.keyFile, { force: true })
    delete record.keyFile
  }

  /** Load once; a missing or unreadable document is an empty registry. */
  private async ensure(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.documentPath, 'utf8')) as unknown
      const raw = Array.isArray(parsed) ? parsed : (parsed as { devices?: unknown }).devices
      this.records = (Array.isArray(raw) ? raw : []).flatMap((entry) => {
        const record = asRecord(entry)
        return record === undefined ? [] : [record]
      })
    } catch {
      this.records = []
    }
  }

  /** Rewrite the document atomically. */
  private async saveDocument(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const temporary = `${this.documentPath}.tmp`
    await writeFile(temporary, JSON.stringify({ devices: this.records }, null, 2), 'utf8')
    await rename(temporary, this.documentPath)
  }
}

/**
 * Whether a stored key file still exists (a device whose key was removed
 * out-of-band must fail loud rather than fall back to an ambient identity).
 * @param path - key file recorded on the device.
 * @returns whether the file is present.
 */
export async function keyExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

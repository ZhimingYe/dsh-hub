import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { hashSecret, isBcryptHash } from './hash.js'

export const AGENT_SECRET_MIN_LENGTH = 16

export interface HubUser {
  username: string
  /** bcrypt hash from `hub.yaml` `users.<name>`. */
  passwordHash: string
}

export interface HubConfig {
  host: string
  port: number
  sessionTtlSeconds: number
  users: HubUser[]
  /** bcrypt hash of the `/agent` Bearer secret; plaintext is never stored. */
  agentSecretHash: string
  /** When true, Hub may bind a non-loopback address over cleartext HTTP. */
  allowPlainHttp: boolean
  /** TCP peers allowed to supply `X-Forwarded-For` / `X-Forwarded-Proto`. Empty means ignore those headers. */
  trustedProxies: string[]
}

interface RawConfig {
  host?: string
  port?: number
  sessionTtlSeconds?: number
  users?: Record<string, string>
  agentSecret?: string
  allowPlainHttp?: boolean
  trustedProxies?: unknown
}

export function isLoopbackBind(host: string): boolean {
  const value = host.toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === 'localhost'
}

/**
 * Load `hub.yaml`. `users.*` and `agentSecret` must already be bcrypt hashes.
 * @param path - config file path.
 * @returns parsed config.
 */
export function loadHubConfig(path: string): HubConfig {
  const raw = parse(readFileSync(resolve(path), 'utf8')) as RawConfig | null
  if (raw === null || typeof raw !== 'object') throw new Error(`invalid config: ${path}`)
  const users = Object.entries(raw.users ?? {}).map(([username, passwordHash]) => {
    if (typeof passwordHash !== 'string' || !isBcryptHash(passwordHash)) {
      throw new Error(`users.${username} must be a bcrypt hash (dsh-hub hash)`)
    }
    return { username, passwordHash }
  })
  if (users.length === 0) throw new Error('users is required')
  const port = raw.port ?? 8787
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${String(raw.port)}`)
  }
  if (typeof raw.agentSecret !== 'string' || !isBcryptHash(raw.agentSecret)) {
    throw new Error('agentSecret must be a bcrypt hash; first `dsh-hub serve` writes it')
  }
  if (raw.allowPlainHttp !== undefined && typeof raw.allowPlainHttp !== 'boolean') {
    throw new Error('allowPlainHttp must be a boolean')
  }
  const host = raw.host ?? '127.0.0.1'
  const allowPlainHttp = raw.allowPlainHttp ?? false
  return {
    host,
    port,
    sessionTtlSeconds: raw.sessionTtlSeconds ?? 60 * 60 * 24 * 7,
    users,
    agentSecretHash: raw.agentSecret,
    allowPlainHttp,
    trustedProxies: parseTrustedProxies(raw.trustedProxies),
  }
}

export function assertBindPolicy(config: HubConfig): void {
  if (!isLoopbackBind(config.host) && !config.allowPlainHttp) {
    throw new Error(
      `host ${config.host} is not loopback; bind 127.0.0.1 behind TLS or set allowPlainHttp: true`,
    )
  }
}

export function findUser(config: HubConfig, username: string): HubUser | undefined {
  return config.users.find(user => user.username === username)
}

/**
 * Render a new `hub.yaml` with bcrypt hashes of `password` and `agentSecret`.
 * @param options.port - listen port.
 * @param options.username - first user.
 * @param options.password - plaintext password; not written.
 * @param options.agentSecret - plaintext Bearer secret; not written; min {@link AGENT_SECRET_MIN_LENGTH}.
 * @returns yaml text with hashed secrets.
 */
export function renderHubConfig(options: {
  port: number
  username: string
  password: string
  agentSecret: string
}): string {
  if (options.password.length === 0) throw new Error('password is required')
  if (options.agentSecret.length < AGENT_SECRET_MIN_LENGTH) {
    throw new Error(`agentSecret is required (min ${String(AGENT_SECRET_MIN_LENGTH)} characters)`)
  }
  return [
    `port: ${String(options.port)}`,
    `agentSecret: ${JSON.stringify(hashSecret(options.agentSecret))}`,
    'users:',
    `  ${options.username}: ${JSON.stringify(hashSecret(options.password))}`,
    '',
  ].join('\n')
}

/**
 * Create `hub.yaml` only if `path` does not exist.
 * @param path - destination path.
 * @param yaml - file contents from {@link renderHubConfig}.
 * @throws if `path` already exists.
 */
export function writeNewHubConfig(path: string, yaml: string): void {
  writeFileSync(path, yaml, { flag: 'wx', mode: 0o600 })
}

function parseTrustedProxies(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('trustedProxies must be a list of IP addresses')
  return raw.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`trustedProxies[${String(index)}] must be a non-empty IP address`)
    }
    return item.trim()
  })
}

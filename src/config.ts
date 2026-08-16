import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { hashSecret, isBcryptHash } from './hash.js'

export const AGENT_SECRET_MIN_LENGTH = 16

/** Login names written to or loaded from `hub.yaml`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** Smallest accepted `sessionTtlSeconds` in `hub.yaml`. */
export const SESSION_TTL_MIN_SECONDS = 60

/** Largest accepted `sessionTtlSeconds` in `hub.yaml`. */
export const SESSION_TTL_MAX_SECONDS = 60 * 60 * 24 * 30

/** `sessionTtlSeconds` when the field is omitted. */
export const SESSION_TTL_DEFAULT_SECONDS = 60 * 60 * 24 * 7

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
  const resolved = resolve(path)
  assertPrivateConfigFile(resolved)
  const raw = parse(readFileSync(resolved, 'utf8')) as RawConfig | null
  if (raw === null || typeof raw !== 'object') throw new Error(`invalid config: ${path}`)
  const users = Object.entries(raw.users ?? {}).map(([username, passwordHash]) => {
    assertUsername(username)
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
    sessionTtlSeconds: parseSessionTtl(raw.sessionTtlSeconds),
    users,
    agentSecretHash: raw.agentSecret,
    allowPlainHttp,
    trustedProxies: parseTrustedProxies(raw.trustedProxies),
  }
}

/**
 * Login names must be a single YAML key: letters, digits, `.`, `_`, `-`, 1–64 long.
 * @param username - candidate from `--user`, the prompt, or `hub.yaml`.
 */
export function assertUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('username must be 1–64 characters in [A-Za-z0-9._-]')
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
  assertUsername(options.username)
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

function parseSessionTtl(raw: unknown): number {
  if (raw === undefined) return SESSION_TTL_DEFAULT_SECONDS
  if (typeof raw !== 'number' || !Number.isInteger(raw)
    || raw < SESSION_TTL_MIN_SECONDS || raw > SESSION_TTL_MAX_SECONDS) {
    throw new Error(
      `sessionTtlSeconds must be an integer from ${String(SESSION_TTL_MIN_SECONDS)} to ${String(SESSION_TTL_MAX_SECONDS)}`,
    )
  }
  return raw
}

function parseTrustedProxies(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('trustedProxies must be a list of IP addresses')
  return raw.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`trustedProxies[${String(index)}] must be a non-empty IP address`)
    }
    const address = item.trim()
    if (isIP(address) === 0) {
      throw new Error(`trustedProxies[${String(index)}] must be an IPv4 or IPv6 address`)
    }
    return address
  })
}

function assertPrivateConfigFile(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`${path}: hub.yaml must not be a symlink`)
  if (!info.isFile()) throw new Error(`${path}: hub.yaml must be a regular file`)
  if ((info.mode & 0o044) !== 0) {
    throw new Error(`${path}: mode ${(info.mode & 0o777).toString(8)} is readable by others (use 0600)`)
  }
}

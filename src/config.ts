import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

export const AGENT_SECRET_MIN_LENGTH = 16

export interface HubUser {
  username: string
  password: string
}

export interface HubConfig {
  host: string
  port: number
  sessionTtlSeconds: number
  users: HubUser[]
  /** Shared secret required on every `/agent` WebSocket upgrade (`Authorization: Bearer`). */
  agentSecret: string
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

export function loadHubConfig(path: string): HubConfig {
  const raw = parse(readFileSync(resolve(path), 'utf8')) as RawConfig | null
  if (raw === null || typeof raw !== 'object') throw new Error(`invalid config: ${path}`)
  const users = Object.entries(raw.users ?? {}).map(([username, password]) => {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error(`empty password for ${username}`)
    }
    return { username, password }
  })
  if (users.length === 0) throw new Error('users is required')
  const port = raw.port ?? 8787
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${String(raw.port)}`)
  }
  if (typeof raw.agentSecret !== 'string' || raw.agentSecret.length < AGENT_SECRET_MIN_LENGTH) {
    throw new Error(`agentSecret is required (min ${String(AGENT_SECRET_MIN_LENGTH)} characters)`)
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
    agentSecret: raw.agentSecret,
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

export function renderHubConfig(options: {
  port: number
  username: string
  password: string
  agentSecret: string
}): string {
  return [
    `port: ${String(options.port)}`,
    `agentSecret: ${JSON.stringify(options.agentSecret)}`,
    'users:',
    `  ${options.username}: ${JSON.stringify(options.password)}`,
    '',
  ].join('\n')
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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const SESSION_COOKIE = 'dsh_hub_session'
export const AUTH_FAILURE_WINDOW_MS = 15 * 60_000
export const AUTH_FAILURE_MAX = 5

export interface SessionRecord {
  username: string
  expiresAt: number
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly ttlMs: number) {}

  create(username: string): string {
    const id = randomBytes(32).toString('base64url')
    this.sessions.set(id, { username, expiresAt: Date.now() + this.ttlMs })
    return id
  }

  get(id: string | undefined): SessionRecord | undefined {
    if (id === undefined) return undefined
    const record = this.sessions.get(id)
    if (record === undefined) return undefined
    if (record.expiresAt <= Date.now()) {
      this.sessions.delete(id)
      return undefined
    }
    return record
  }

  revoke(id: string | undefined): void {
    if (id !== undefined) this.sessions.delete(id)
  }
}

export class FailureLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  limited(key: string): boolean {
    this.prune(key)
    return (this.hits.get(key) ?? []).length >= this.max
  }

  add(key: string): void {
    const list = this.hits.get(key) ?? []
    list.push(Date.now())
    this.hits.set(key, list)
  }

  private prune(key: string): void {
    const now = Date.now()
    const list = (this.hits.get(key) ?? []).filter(time => now - time < this.windowMs)
    if (list.length === 0) this.hits.delete(key)
    else this.hits.set(key, list)
  }
}

export function normalizeIp(address: string): string {
  if (address.startsWith('::ffff:')) return address.slice('::ffff:'.length)
  if (address === '::1') return '127.0.0.1'
  return address
}

export function peerAddress(req: IncomingMessage): string {
  return normalizeIp(req.socket.remoteAddress ?? '')
}

export function isTrustedProxy(req: IncomingMessage, trustedProxies: readonly string[]): boolean {
  if (trustedProxies.length === 0) return false
  const peer = peerAddress(req)
  if (peer.length === 0) return false
  return trustedProxies.some(proxy => normalizeIp(proxy) === peer)
}

/**
 * Rate-limit key for login and `/agent` register.
 * `X-Forwarded-For` is used only when the TCP peer is in `trustedProxies`; the rightmost hop is the proxy-observed client.
 */
export function clientKey(req: IncomingMessage, trustedProxies: readonly string[] = []): string {
  const peer = peerAddress(req)
  if (!isTrustedProxy(req, trustedProxies)) {
    return peer.length > 0 ? peer : 'unknown'
  }
  const hops = forwardedForHops(req.headers['x-forwarded-for'])
  const client = hops.at(-1)
  if (client !== undefined && client.length > 0) return normalizeIp(client)
  return peer.length > 0 ? peer : 'unknown'
}

export function isForwardedHttps(req: IncomingMessage, trustedProxies: readonly string[] = []): boolean {
  if (!isTrustedProxy(req, trustedProxies)) return false
  const proto = req.headers['x-forwarded-proto']
  const value = Array.isArray(proto) ? proto[0] : proto
  const first = value?.split(',')[0]?.trim().toLowerCase()
  return first === 'https'
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(\S+)/i.exec(header)
  return match?.[1]
}

export function passwordsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) {
    const dummy = createHmac('sha256', 'dsh-hub').update(a).digest()
    timingSafeEqual(dummy, dummy)
    return false
  }
  return timingSafeEqual(a, b)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (header === undefined || header.length === 0) return out
  for (const part of header.split(';')) {
    const cut = part.indexOf('=')
    if (cut <= 0) continue
    const key = part.slice(0, cut).trim()
    const value = part.slice(cut + 1).trim()
    out[key] = decodeCookieValue(value)
  }
  return out
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // malformed percent-encoding (e.g. "%zz") is not a value this server set
    return value
  }
}

export function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE]
}

export function sessionCookie(id: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function forwardedForHops(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (raw === undefined || raw.length === 0) return []
  return raw.split(',').map(part => part.trim()).filter(part => part.length > 0)
}

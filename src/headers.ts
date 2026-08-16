import type { IncomingHttpHeaders } from 'node:http'
import type { HeaderPair } from './protocol.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
])

const STRIP_TO_DSH = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
])

const STRIP_TO_BROWSER = new Set([
  ...HOP_BY_HOP,
  'set-cookie',
  'set-cookie2',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-private-network',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-request-headers',
  'access-control-request-method',
  'clear-site-data',
  'refresh',
])

/**
 * Headers on Hub-owned HTML (login, offline).
 * Inline CSS and the offline reload script are the only script/style sources.
 */
export const HUB_HTML_SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
}

/**
 * Headers on Hub-owned JSON and plain-text replies that are not tunneled dsh.
 */
export const HUB_API_SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
}

const TUNNEL_SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
}

export function incomingToPairs(headers: IncomingHttpHeaders): HeaderPair[] {
  const pairs: HeaderPair[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) pairs.push({ name, value: item })
    } else {
      pairs.push({ name, value })
    }
  }
  return pairs
}

export function pairsToRecord(pairs: HeaderPair[], extra?: Record<string, string>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { ...extra }
  for (const { name, value } of pairs) {
    const key = name.toLowerCase()
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}

export function filterPairs(pairs: HeaderPair[], drop: Set<string>): HeaderPair[] {
  return pairs.filter(pair => !drop.has(pair.name.toLowerCase()))
}

export function headersForDsh(pairs: HeaderPair[]): Record<string, string> {
  const record = pairsToRecord(filterPairs(pairs, STRIP_TO_DSH), { host: '127.0.0.1' })
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  out.host = '127.0.0.1'
  return out
}

/**
 * Forward dsh response headers to the browser. Drops hop-by-hop headers,
 * `Set-Cookie` so a tunneled plugin cannot overwrite `dsh_hub_session`, and
 * CORS / `Clear-Site-Data` / `Refresh` so a plugin cannot widen the Hub origin
 * or evict the session cookie. Always sets frame-denial and `nosniff`.
 */
export function headersForBrowser(pairs: HeaderPair[]): Record<string, string | string[]> {
  const out = pairsToRecord(filterPairs(pairs, STRIP_TO_BROWSER))
  for (const [name, value] of Object.entries(TUNNEL_SECURITY_HEADERS)) out[name] = value
  return out
}

export function wsHeadersForDsh(pairs: HeaderPair[]): Record<string, string> {
  const record = headersForDsh(pairs)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'sec-websocket-key' || key === 'sec-websocket-version' || key === 'sec-websocket-extensions') continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  out.host = '127.0.0.1'
  return out
}

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
])

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
 * Forward dsh response headers to the browser. Drops hop-by-hop headers and
 * `Set-Cookie` so a tunneled plugin cannot overwrite `dsh_hub_session`.
 */
export function headersForBrowser(pairs: HeaderPair[]): Record<string, string | string[]> {
  return pairsToRecord(filterPairs(pairs, STRIP_TO_BROWSER))
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

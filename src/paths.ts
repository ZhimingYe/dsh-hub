import { join } from 'node:path'

export function internalSocketPath(): string {
  const uid = String(process.getuid?.() ?? 0)
  const root = process.env.XDG_RUNTIME_DIR ?? '/tmp'
  return join(root, `dsh-hub-${uid}`, 'workstation.sock')
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

export function requireSecureHubUrl(input: string, allowPlainHttp: boolean): void {
  const url = new URL(input.includes('://') ? input : `http://${input}`)
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  if (secure || isLoopbackHostname(url.hostname) || allowPlainHttp) return
  throw new Error(`明文 ${url.protocol}// 不能指向非回环地址；改用 https:// 或加 --allow-plain-http`)
}

export function agentUrlFromHub(input: string): string {
  const url = new URL(input.includes('://') ? input : `http://${input}`)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`不支持的地址: ${input}`)
  }
  url.pathname = '/agent'
  url.search = ''
  url.hash = ''
  return url.href
}

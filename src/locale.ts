import type { IncomingMessage } from 'node:http'
import { parseCookies } from './auth.js'

export const LANG_COOKIE = 'dsh_hub_lang'
export const LANG_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

export type HubLang = 'en' | 'zh'
export type LoginError = 'tooMany' | 'badCredentials'

export const COPY = {
  en: {
    loginTitle: 'Sign in',
    username: 'Username',
    password: 'Password',
    submit: 'Sign in',
    tooMany: 'Too many login attempts',
    badCredentials: 'Incorrect username or password',
    offlineTitle: 'Offline',
    noWorkstation: (user: string) => `${user}: no workstation online.`,
    refresh: 'Refresh',
    signOut: 'Sign out',
  },
  zh: {
    loginTitle: '登录',
    username: '用户名',
    password: '密码',
    submit: '登录',
    tooMany: '登录次数过多',
    badCredentials: '用户名或密码不正确',
    offlineTitle: '离线',
    noWorkstation: (user: string) => `${user}：无在线工作站。`,
    refresh: '刷新',
    signOut: '退出',
  },
} as const

/**
 * Hub HTML locale. Default is English; `zh` only when the cookie is exactly `zh`.
 */
export function parseHubLang(value: string | undefined): HubLang {
  return value === 'zh' ? 'zh' : 'en'
}

export function hubLangFromRequest(req: IncomingMessage): HubLang {
  return parseHubLang(parseCookies(req.headers.cookie)[LANG_COOKIE])
}

export function langCookie(lang: HubLang, secure: boolean): string {
  const parts = [
    `${LANG_COOKIE}=${lang}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${String(LANG_MAX_AGE_SECONDS)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Relative path for the post-switch redirect. Rejects scheme-relative and
 * backslash paths so `/lang?next=` cannot leave the Hub origin.
 */
export function safeNextPath(raw: string | null): string {
  if (raw === null || raw.length === 0) return '/login'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('\0')) {
    return '/login'
  }
  return raw
}

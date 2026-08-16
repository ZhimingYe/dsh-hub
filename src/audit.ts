import { appendFileSync } from 'node:fs'
import { USERNAME_PATTERN } from './config.js'

export type LoginAuditEvent = 'login.ok' | 'login.fail' | 'login.limited'

export interface LoginAuditRecord {
  ts: string
  event: LoginAuditEvent
  ip: string
  user?: string
}

/**
 * A username safe to persist on an audit line. Rejects values that are not
 * Hub login names so a crafted POST cannot inject into the log.
 * @param username - presented login name, already trimmed.
 * @returns the username, or `undefined` when it is not a Hub login name.
 */
export function auditUsername(username: string): string | undefined {
  return USERNAME_PATTERN.test(username) ? username : undefined
}

/**
 * One JSONL login-audit record. Callers must not put secrets on `record`.
 * @param record - event, client IP, and optional login name.
 * @returns a single JSON line including a trailing newline.
 */
export function formatLoginAuditLine(record: {
  event: LoginAuditEvent
  ip: string
  user?: string
  ts?: string
}): string {
  const line: LoginAuditRecord = {
    ts: record.ts ?? new Date().toISOString(),
    event: record.event,
    ip: record.ip,
  }
  if (record.user !== undefined) line.user = record.user
  return `${JSON.stringify(line)}\n`
}

/**
 * Append one login-audit line. A write failure is reported and swallowed so
 * a full disk cannot block login.
 * @param path - destination file; created at mode `0600` if missing.
 * @param record - event, client IP, and optional login name.
 */
export function appendLoginAudit(
  path: string,
  record: { event: LoginAuditEvent; ip: string; user?: string },
): void {
  try {
    appendFileSync(path, formatLoginAuditLine(record), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`dsh-hub: cannot write audit log ${path}: ${message}`)
  }
}

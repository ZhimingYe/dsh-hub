/** bcrypt hash and verify for Hub passwords and the agent secret stored in `hub.yaml`. */

import bcrypt from 'bcryptjs'

/** bcrypt cost for values written to `hub.yaml`. */
export const BCRYPT_ROUNDS = 12

/** bcrypt refuses costs outside 4–31; Hub also rejects those hashes at load. */
export const BCRYPT_MIN_COST = 4

/** bcrypt refuses costs outside 4–31; Hub also rejects those hashes at load. */
export const BCRYPT_MAX_COST = 31

/** bcrypt only consumes this many UTF-8 bytes; Hub rejects longer secrets instead of truncating. */
export const BCRYPT_MAX_BYTES = 72

const DUMMY_SECRET = 'dsh-hub dummy password for missing-user verify'

const BCRYPT_HASH = /^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/

/**
 * Whether `value` is a bcrypt hash Hub will accept in `hub.yaml`.
 * @param value - candidate from config.
 * @returns whether Hub will accept the value as a stored hash (cost 4–31).
 */
export function isBcryptHash(value: string): boolean {
  return BCRYPT_HASH.test(value)
}

/**
 * bcrypt cost encoded in a hash Hub has already accepted.
 * @param hash - a value that passed {@link isBcryptHash}.
 * @returns the numeric cost, or `undefined` if `hash` is not a Hub bcrypt hash.
 */
export function bcryptCost(hash: string): number | undefined {
  if (!isBcryptHash(hash)) return undefined
  return Number(hash.slice(4, 6))
}

/**
 * Hash a password or agent secret for `hub.yaml`.
 * @param plaintext - the value Hub will later verify; must be non-empty and at most {@link BCRYPT_MAX_BYTES} UTF-8 bytes.
 * @param rounds - bcrypt cost; defaults to {@link BCRYPT_ROUNDS}.
 * @returns a bcrypt hash.
 */
export function hashSecret(plaintext: string, rounds: number = BCRYPT_ROUNDS): string {
  if (plaintext.length === 0) throw new Error('cannot hash an empty secret')
  if (Buffer.byteLength(plaintext, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new Error(`secret exceeds bcrypt's ${String(BCRYPT_MAX_BYTES)}-byte limit`)
  }
  return bcrypt.hashSync(plaintext, rounds)
}

/**
 * Hash used when a login or register names a missing user, so bcrypt cost matches a real user.
 * Matching this plaintext does not authenticate.
 * @param cost - bcrypt cost copied from a stored user hash.
 * @returns a bcrypt hash of an unusable dummy secret.
 */
export function dummyPasswordHash(cost: number): string {
  return hashSecret(DUMMY_SECRET, cost)
}

/**
 * Verify a presented secret against a bcrypt hash from `hub.yaml`.
 * @param plaintext - login password, agent password, or Bearer agent secret.
 * @param hash - stored bcrypt hash.
 * @returns whether they match.
 */
export function verifySecret(plaintext: string, hash: string): boolean {
  if (!isBcryptHash(hash)) return false
  return bcrypt.compareSync(plaintext, hash)
}

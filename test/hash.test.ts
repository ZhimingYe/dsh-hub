import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BCRYPT_MAX_BYTES,
  hashSecret,
  isBcryptHash,
  verifySecret,
} from '../src/hash.ts'
import { BCRYPT_TEST_ROUNDS } from './hashed-yaml.ts'

test('hashSecret round-trips and rejects an empty secret', () => {
  const hash = hashSecret('alice-secret', BCRYPT_TEST_ROUNDS)
  assert.equal(isBcryptHash(hash), true)
  assert.equal(verifySecret('alice-secret', hash), true)
  assert.equal(verifySecret('nope', hash), false)
  assert.throws(() => hashSecret(''), /empty/)
})

test('hashSecret rejects secrets longer than 72 UTF-8 bytes', () => {
  assert.equal(hashSecret('a'.repeat(BCRYPT_MAX_BYTES), BCRYPT_TEST_ROUNDS).startsWith('$2'), true)
  assert.throws(() => hashSecret('a'.repeat(BCRYPT_MAX_BYTES + 1)), /72-byte/)
  assert.throws(() => hashSecret('é'.repeat(37)), /72-byte/)
})

test('verifySecret rejects plaintext and a cost Hub does not accept', () => {
  assert.equal(isBcryptHash('test-agent-secret-1'), false)
  assert.equal(verifySecret('test-agent-secret-1', 'test-agent-secret-1'), false)
  const hash = hashSecret('alice-secret', BCRYPT_TEST_ROUNDS)
  assert.equal(verifySecret('alice-secret', hash.slice(0, 20)), false)
  const lowCost = hash.replace(/\$\d{2}\$/, '$03$')
  assert.equal(isBcryptHash(lowCost), false)
  assert.equal(verifySecret('alice-secret', lowCost), false)
})

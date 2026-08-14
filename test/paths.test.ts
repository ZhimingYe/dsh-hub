import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentUrlFromHub, requireSecureHubUrl } from '../src/paths.ts'
import { assertBindPolicy, loadHubConfig } from '../src/config.ts'
import { composeDshArgv, isDshOneShot, parseConnectArgs } from '../src/connect-args.ts'
import { FailureLimiter, clientKey, isForwardedHttps } from '../src/auth.ts'

test('portal address becomes the agent websocket url', () => {
  assert.equal(agentUrlFromHub('http://10.0.0.8:8787'), 'ws://10.0.0.8:8787/agent')
  assert.equal(agentUrlFromHub('https://hub.example.com'), 'wss://hub.example.com/agent')
  assert.equal(agentUrlFromHub('10.0.0.8:8787'), 'ws://10.0.0.8:8787/agent')
})

test('config requires users and agentSecret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-cfg-'))
  const path = join(dir, 'hub.yaml')
  writeFileSync(path, 'port: 9\nagentSecret: "test-agent-secret-1"\nusers:\n  alice: "secret"\n')
  const config = loadHubConfig(path)
  assert.equal(config.users[0]?.username, 'alice')
  assert.equal(config.port, 9)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.agentSecret, 'test-agent-secret-1')
  assert.equal(config.allowPlainHttp, false)
  rmSync(dir, { recursive: true, force: true })
})

test('connect peels hub login flags and forwards the rest to dsh', () => {
  const parsed = parseConnectArgs([
    'http://10.0.0.8:8787',
    '--user', 'alice',
    '--password-file', '/tmp/pw',
    '--patch', 'extra.yml',
    '--trusted-host', 'lab.example.com',
  ])
  assert.equal(parsed.hubUrl, 'http://10.0.0.8:8787')
  assert.equal(parsed.username, 'alice')
  assert.equal(parsed.passwordFile, '/tmp/pw')
  assert.equal(parsed.allowPlainHttp, false)
  assert.deepEqual(parsed.dshArgs, ['--patch', 'extra.yml', '--trusted-host', 'lab.example.com'])
})

test('connect rejects --password on argv', () => {
  assert.throws(
    () => parseConnectArgs(['http://hub:8787', '--user', 'alice', '--password', 'secret']),
    /--password is not supported/,
  )
})

test('connect -- passes following tokens to dsh even if they look like hub flags', () => {
  const parsed = parseConnectArgs([
    'http://hub:8787',
    '--user', 'alice',
    '--',
    '--password', 'for-dsh',
  ])
  assert.equal(parsed.passwordFile, undefined)
  assert.deepEqual(parsed.dshArgs, ['--password', 'for-dsh'])
})

test('composeDshArgv injects workstation profile only when missing', () => {
  assert.deepEqual(
    composeDshArgv(['--patch', 'extra.yml'], '/tmp/overlay.yml'),
    ['--profile', 'workstation', '--patch', '/tmp/overlay.yml', '--patch', 'extra.yml'],
  )
  assert.deepEqual(
    composeDshArgv(['web', '--port', '0'], '/tmp/overlay.yml'),
    ['web', '--patch', '/tmp/overlay.yml', '--port', '0'],
  )
  assert.deepEqual(
    composeDshArgv(['--profile', 'mine', '--patch', 'a.yml'], '/tmp/overlay.yml'),
    ['--patch', '/tmp/overlay.yml', '--profile', 'mine', '--patch', 'a.yml'],
  )
})

test('failed-auth limiter trips after the window fills', () => {
  const limiter = new FailureLimiter(60_000, 3)
  assert.equal(limiter.limited('10.0.0.1'), false)
  limiter.add('10.0.0.1')
  limiter.add('10.0.0.1')
  limiter.add('10.0.0.1')
  assert.equal(limiter.limited('10.0.0.1'), true)
  assert.equal(limiter.limited('10.0.0.2'), false)
})

test('dump-default-config and plugin are not wrapped with extra patches', () => {
  assert.equal(isDshOneShot(['--dump-default-config']), true)
  assert.deepEqual(
    composeDshArgv(['--dump-default-config'], '/tmp/overlay.yml'),
    ['--profile', 'workstation', '--dump-default-config'],
  )
  assert.deepEqual(
    composeDshArgv(['plugin', '--profile', 'workstation', 'add', 'foo'], '/tmp/overlay.yml'),
    ['plugin', '--profile', 'workstation', 'add', 'foo'],
  )
})

test('connect peels agent secret file and allow-plain-http', () => {
  const parsed = parseConnectArgs([
    'http://10.0.0.8:8787',
    '--user', 'alice',
    '--agent-secret-file', '/tmp/secret',
    '--allow-plain-http',
    '--patch', 'extra.yml',
  ])
  assert.equal(parsed.agentSecretFile, '/tmp/secret')
  assert.equal(parsed.allowPlainHttp, true)
  assert.deepEqual(parsed.dshArgs, ['--patch', 'extra.yml'])
})

test('connect rejects --agent-secret on argv', () => {
  assert.throws(
    () => parseConnectArgs(['http://hub:8787', '--user', 'alice', '--agent-secret', 'secret']),
    /--agent-secret is not supported/,
  )
})

test('plain http to a non-loopback hub url is refused unless opted in', () => {
  assert.throws(() => requireSecureHubUrl('http://10.0.0.8:8787', false), /明文/)
  requireSecureHubUrl('http://127.0.0.1:8787', false)
  requireSecureHubUrl('https://hub.example.com', false)
  requireSecureHubUrl('http://10.0.0.8:8787', true)
})

test('non-loopback bind requires allowPlainHttp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-bind-'))
  const path = join(dir, 'hub.yaml')
  writeFileSync(path, `
host: 0.0.0.0
port: 9
agentSecret: "test-agent-secret-1"
users:
  alice: "secret"
`)
  const config = loadHubConfig(path)
  assert.throws(() => assertBindPolicy(config), /allowPlainHttp/)
  config.allowPlainHttp = true
  assertBindPolicy(config)
  rmSync(dir, { recursive: true, force: true })
})

test('config rejects a missing or short agentSecret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-secret-'))
  const path = join(dir, 'hub.yaml')
  writeFileSync(path, 'port: 9\nusers:\n  alice: "secret"\n')
  assert.throws(() => loadHubConfig(path), /agentSecret/)
  writeFileSync(path, 'port: 9\nagentSecret: "short"\nusers:\n  alice: "secret"\n')
  assert.throws(() => loadHubConfig(path), /agentSecret/)
  rmSync(dir, { recursive: true, force: true })
})

function fakeReq(remote: string, headers: Record<string, string | string[] | undefined>) {
  return { socket: { remoteAddress: remote }, headers } as Parameters<typeof clientKey>[0]
}

test('rate-limit key ignores X-Forwarded-For unless the peer is a trusted proxy', () => {
  const spoofed = fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })
  assert.equal(clientKey(spoofed, []), '127.0.0.1')
  assert.equal(isForwardedHttps(spoofed, []), false)

  const behindProxy = fakeReq('127.0.0.1', {
    'x-forwarded-for': '198.51.100.7, 203.0.113.9',
    'x-forwarded-proto': 'https',
  })
  assert.equal(clientKey(behindProxy, ['127.0.0.1']), '203.0.113.9')
  assert.equal(isForwardedHttps(behindProxy, ['127.0.0.1']), true)

  const mapped = fakeReq('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.10' })
  assert.equal(clientKey(mapped, ['127.0.0.1']), '203.0.113.10')
})

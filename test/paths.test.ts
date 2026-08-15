import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, writeFileSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentUrlFromHub, requireSecureHubUrl } from '../src/paths.ts'
import { headersForBrowser } from '../src/headers.ts'
import { ensurePrivateDirectory } from '../webserver-unix/src/private-dir.js'
import { parseHubLang, safeNextPath } from '../src/locale.ts'
import { assertBindPolicy, loadHubConfig, renderHubConfig, writeNewHubConfig } from '../src/config.ts'
import { isBcryptHash, verifySecret } from '../src/hash.ts'
import { hashedHubYaml, TEST_AGENT_SECRET } from './hashed-yaml.ts'
import { composeDshArgv, isDshOneShot, parseConnectArgs } from '../src/connect-args.ts'
import { FailureLimiter, clientKey, isForwardedHttps } from '../src/auth.ts'
import { assertHubPluginsResolvable, ensureHubPluginLinks, hubPluginLinkRoots, hubPlugins } from '../src/setup-workstation.ts'

test('portal address becomes the agent websocket url', () => {
  assert.equal(agentUrlFromHub('http://10.0.0.8:8787'), 'ws://10.0.0.8:8787/agent')
  assert.equal(agentUrlFromHub('https://hub.example.com'), 'wss://hub.example.com/agent')
  assert.equal(agentUrlFromHub('10.0.0.8:8787'), 'ws://10.0.0.8:8787/agent')
})

test('config requires users and a bcrypt agentSecret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-cfg-'))
  const path = join(dir, 'hub.yaml')
  writeFileSync(path, hashedHubYaml({ port: 9, users: { alice: 'secret' } }))
  const config = loadHubConfig(path)
  assert.equal(config.users[0]?.username, 'alice')
  assert.equal(config.port, 9)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(isBcryptHash(config.agentSecretHash), true)
  assert.equal(verifySecret(TEST_AGENT_SECRET, config.agentSecretHash), true)
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
  assert.throws(() => requireSecureHubUrl('http://10.0.0.8:8787', false), /cleartext/)
  requireSecureHubUrl('http://127.0.0.1:8787', false)
  requireSecureHubUrl('https://hub.example.com', false)
  requireSecureHubUrl('http://10.0.0.8:8787', true)
})

test('non-loopback bind requires allowPlainHttp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-bind-'))
  const path = join(dir, 'hub.yaml')
  writeFileSync(path, hashedHubYaml({
    host: '0.0.0.0',
    port: 9,
    users: { alice: 'secret' },
  }))
  const config = loadHubConfig(path)
  assert.throws(() => assertBindPolicy(config), /allowPlainHttp/)
  config.allowPlainHttp = true
  assertBindPolicy(config)
  rmSync(dir, { recursive: true, force: true })
})

test('config rejects a missing, plaintext, or malformed agentSecret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-secret-'))
  const path = join(dir, 'hub.yaml')
  const hashed = hashedHubYaml({ port: 9, users: { alice: 'secret' } })
  writeFileSync(path, hashed.replace(/^agentSecret: .*\n/m, ''))
  assert.throws(() => loadHubConfig(path), /agentSecret/)
  writeFileSync(path, hashed.replace(/agentSecret: .*/, 'agentSecret: "test-agent-secret-1"'))
  assert.throws(() => loadHubConfig(path), /bcrypt/)
  writeFileSync(path, hashed.replace(/agentSecret: .*/, 'agentSecret: "short"'))
  assert.throws(() => loadHubConfig(path), /bcrypt/)
  rmSync(dir, { recursive: true, force: true })
})

test('config rejects a plaintext user password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-pw-'))
  const path = join(dir, 'hub.yaml')
  writeFileSync(path, hashedHubYaml({ port: 9, users: { alice: 'secret' } }).replace(/alice: .*/, 'alice: "secret"'))
  assert.throws(() => loadHubConfig(path), /bcrypt/)
  rmSync(dir, { recursive: true, force: true })
})

test('renderHubConfig writes bcrypt hashes, not plaintext', () => {
  const yaml = renderHubConfig({
    port: 9,
    username: 'alice',
    password: 'alice-secret',
    agentSecret: TEST_AGENT_SECRET,
  })
  assert.doesNotMatch(yaml, /alice-secret/)
  assert.doesNotMatch(yaml, new RegExp(TEST_AGENT_SECRET))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-render-'))
  const path = join(dir, 'hub.yaml')
  writeFileSync(path, yaml)
  const config = loadHubConfig(path)
  assert.equal(verifySecret('alice-secret', config.users[0]?.passwordHash ?? ''), true)
  assert.equal(verifySecret(TEST_AGENT_SECRET, config.agentSecretHash), true)
  rmSync(dir, { recursive: true, force: true })
})

test('writeNewHubConfig creates mode 0600 and refuses to overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-wx-'))
  const path = join(dir, 'hub.yaml')
  writeNewHubConfig(path, hashedHubYaml({ port: 9, users: { alice: 'secret' } }))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.throws(() => writeNewHubConfig(path, 'port: 1\n'), /EEXIST/)
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

test('hub plugins link into the dsh install and the workstation profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-link-'))
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'workstation')
  const dshRoot = join(root, 'prefix', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dshRoot, { recursive: true })
  const roots = hubPluginLinkRoots(home, profileDir, dshRoot)
  assert.deepEqual(roots, [
    join(profileDir, 'node_modules'),
    join(home, 'profiles', 'node_modules'),
    join(dshRoot, 'node_modules'),
    join(root, 'prefix', 'node_modules'),
  ])
  ensureHubPluginLinks(home, profileDir, dshRoot)
  const preview = hubPlugins().find(plugin => plugin.name === '@dsh-hub/preview')
  assert.ok(preview)
  const expected = realpathSync(preview.dir)
  for (const rootDir of roots) {
    assert.equal(realpathSync(join(rootDir, '@dsh-hub', 'preview')), expected)
  }
  writeFileSync(join(profileDir, 'package.json'), '{}\n')
  writeFileSync(join(dshRoot, 'package.json'), '{}\n')
  assertHubPluginsResolvable(profileDir, dshRoot)
  rmSync(root, { recursive: true, force: true })
})

test('hub lang cookie is English unless exactly zh, and next stays on this origin', () => {
  assert.equal(parseHubLang(undefined), 'en')
  assert.equal(parseHubLang('en'), 'en')
  assert.equal(parseHubLang('zh'), 'zh')
  assert.equal(parseHubLang('fr'), 'en')
  assert.equal(safeNextPath(null), '/login')
  assert.equal(safeNextPath('/'), '/')
  assert.equal(safeNextPath('/login'), '/login')
  assert.equal(safeNextPath('https://evil.example'), '/login')
  assert.equal(safeNextPath('//evil.example'), '/login')
  assert.equal(safeNextPath('/\\evil'), '/login')
})

test('headersForBrowser drops Set-Cookie', () => {
  const out = headersForBrowser([
    { name: 'content-type', value: 'text/plain' },
    { name: 'Set-Cookie', value: 'dsh_hub_session=stolen' },
    { name: 'set-cookie2', value: 'other=1' },
  ])
  assert.equal(out['content-type'], 'text/plain')
  assert.equal(out['set-cookie'], undefined)
  assert.equal(out['set-cookie2'], undefined)
})

test('ensurePrivateDirectory creates mode 0700 and tightens a too-open dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-sockdir-'))
  const nested = join(root, 'nested')
  ensurePrivateDirectory(nested)
  assert.equal(statSync(nested).mode & 0o777, 0o700)

  chmodSync(nested, 0o755)
  ensurePrivateDirectory(nested)
  assert.equal(statSync(nested).mode & 0o777, 0o700)
  rmSync(root, { recursive: true, force: true })
})

test('ensurePrivateDirectory refuses a symlink or a file', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-sockdir-'))
  const target = mkdtempSync(join(tmpdir(), 'dsh-hub-sockdir-target-'))
  const link = join(root, 'link')
  symlinkSync(target, link)
  assert.throws(() => { ensurePrivateDirectory(link) }, /symlink/)

  const file = join(root, 'file')
  writeFileSync(file, 'x')
  assert.throws(() => { ensurePrivateDirectory(file) })
  rmSync(root, { recursive: true, force: true })
  rmSync(target, { recursive: true, force: true })
})

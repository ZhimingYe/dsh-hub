import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { HubServer } from '../src/server.ts'
import { HubAgent } from '../src/agent.ts'
import { AUDIT_LOG_BASENAME, loadHubConfig } from '../src/config.ts'
import { writeHashedHubYaml, TEST_AGENT_SECRET } from './hashed-yaml.ts'

const SECRET = TEST_AGENT_SECRET
const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-sec-'))
const socketPath = join(dir, 'dsh.sock')
const configPath = join(dir, 'hub.yaml')
writeHashedHubYaml(configPath, {
  host: '127.0.0.1',
  port: 0,
  users: { alice: 'alice-secret' },
})

const hub = new HubServer({ config: loadHubConfig(configPath) })
let origin = ''
let port = 0

before(async () => {
  port = await hub.listen()
  origin = `http://127.0.0.1:${String(port)}`
})

after(async () => {
  await hub.close()
  rmSync(dir, { recursive: true, force: true })
})

test('/agent upgrade without the agent secret is 401', async () => {
  const status = await upgradeStatus(`${origin.replace('http', 'ws')}/agent`)
  assert.equal(status, 401)
})

test('/agent upgrade with a wrong agent secret is 401', async () => {
  const status = await upgradeStatus(`${origin.replace('http', 'ws')}/agent`, 'Bearer wrong-agent-secret')
  assert.equal(status, 401)
})

test('agent with secret and wrong password is rejected after upgrade', async () => {
  const agent = new HubAgent({
    hubUrl: `ws://127.0.0.1:${String(port)}/agent`,
    username: 'alice',
    password: 'nope',
    agentSecret: SECRET,
    socketPath,
  })
  await assert.rejects(() => agent.start(), /register rejected/)
  await agent.stop()
})

test('agent with secret and password registers', async () => {
  const agent = new HubAgent({
    hubUrl: `ws://127.0.0.1:${String(port)}/agent`,
    username: 'alice',
    password: 'alice-secret',
    agentSecret: SECRET,
    socketPath,
  })
  await agent.start()
  assert.equal(hub.agentOnline('alice'), true)
  await agent.stop()
})

test('a takeover agent keeps its reconnect token when the replaced agent drops', async () => {
  const first = new HubAgent({
    hubUrl: `ws://127.0.0.1:${String(port)}/agent`,
    username: 'alice',
    password: 'alice-secret',
    agentSecret: SECRET,
    socketPath,
  })
  await first.start()
  assert.equal(hub.agentOnline('alice'), true)
  const second = new HubAgent({
    hubUrl: `ws://127.0.0.1:${String(port)}/agent`,
    username: 'alice',
    password: 'alice-secret',
    agentSecret: SECRET,
    socketPath,
  })
  await second.start()
  // Registering the second agent terminated the first; the first's drop must
  // not delete the second agent's reconnect token.
  const firstWs = first['ws']
  assert.ok(firstWs)
  if (firstWs.readyState !== WebSocket.CLOSED) {
    await new Promise<void>(resolve => firstWs.once('close', resolve))
  }
  assert.equal(hub.agentOnline('alice'), true)
  await second.stop()
  await first.stop()
})

test('login audit records success and failure, ignoring spoofed X-Forwarded-For', async () => {
  const auditPath = join(dir, AUDIT_LOG_BASENAME)
  const before = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(line => line.length > 0) : []
  const failed = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '203.0.113.9',
    },
    body: 'username=nobody&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(failed.status, 401)
  const ok = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '203.0.113.9',
    },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(ok.status, 302)
  const lines = readFileSync(auditPath, 'utf8').trim().split('\n')
    .filter(line => line.length > 0)
    .slice(before.length)
    .map(line => JSON.parse(line) as { event: string; ip: string; user?: string })
  const fail = lines.find(line => line.event === 'login.fail')
  const success = lines.find(line => line.event === 'login.ok')
  assert.ok(fail)
  assert.equal(fail.ip, '127.0.0.1')
  assert.equal(fail.user, 'nobody')
  assert.ok(success)
  assert.equal(success.ip, '127.0.0.1')
  assert.equal(success.user, 'alice')
})

test('login audit uses the rightmost X-Forwarded-For hop from a trusted proxy', async () => {
  const proxyDir = mkdtempSync(join(tmpdir(), 'dsh-hub-audit-'))
  const proxyConfig = join(proxyDir, 'hub.yaml')
  writeHashedHubYaml(proxyConfig, {
    host: '127.0.0.1',
    port: 0,
    users: { alice: 'alice-secret' },
    extra: 'trustedProxies:\n  - 127.0.0.1',
  })
  const proxyHub = new HubServer({ config: loadHubConfig(proxyConfig) })
  const proxyPort = await proxyHub.listen()
  try {
    const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '198.51.100.7, 203.0.113.50',
      },
      body: 'username=alice&password=alice-secret',
      redirect: 'manual',
    })
    assert.equal(response.status, 302)
    const lines = readFileSync(join(proxyDir, AUDIT_LOG_BASENAME), 'utf8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { event: string; ip: string; user?: string }
    assert.equal(last.event, 'login.ok')
    assert.equal(last.ip, '203.0.113.50')
    assert.equal(last.user, 'alice')
  } finally {
    await proxyHub.close()
    rmSync(proxyDir, { recursive: true, force: true })
  }
})

test('login with an unknown username is 401', async () => {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=nobody&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(response.status, 401)
  const body = await response.text()
  assert.match(body, /Incorrect username or password/)
  assert.match(body, /<html lang="en">/)
})

test('login page is English by default and switches to Chinese via cookie', async () => {
  const english = await fetch(`${origin}/login`)
  assert.equal(english.status, 200)
  const englishHtml = await english.text()
  assert.match(englishHtml, /<html lang="en">/)
  assert.match(englishHtml, /<h1>Sign in<\/h1>/)
  assert.match(englishHtml, /href="\/lang\?set=zh&amp;next=%2Flogin"/)

  const switched = await fetch(`${origin}/lang?set=zh&next=/login`, { redirect: 'manual' })
  assert.equal(switched.status, 302)
  assert.equal(switched.headers.get('location'), '/login')
  const setCookie = switched.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /dsh_hub_lang=zh/)

  const chinese = await fetch(`${origin}/login`, { headers: { cookie: 'dsh_hub_lang=zh' } })
  const chineseHtml = await chinese.text()
  assert.match(chineseHtml, /<html lang="zh-CN">/)
  assert.match(chineseHtml, /<h1>登录<\/h1>/)

  const blocked = await fetch(`${origin}/lang?set=zh&next=https://evil.example`, { redirect: 'manual' })
  assert.equal(blocked.status, 302)
  assert.equal(blocked.headers.get('location'), '/login')

  const invalid = await fetch(`${origin}/lang?set=fr`)
  assert.equal(invalid.status, 400)
})

test('login ignores spoofed X-Forwarded-Proto when trustedProxies is empty', async () => {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.9',
    },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(response.status, 302)
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.doesNotMatch(setCookie, /Secure/)
})

test('malformed cookie percent-encoding on upgrade is 401, not a crash', async () => {
  const status = await rawRequestStatus([
    'GET /api/events.mux HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Cookie: dsh_hub_session=%zz',
  ])
  assert.equal(status, 401)
  const health = await fetch(`${origin}/hub/health`)
  assert.equal(health.status, 200)
})

test('invalid absolute-form request target on upgrade is 400, not a crash', async () => {
  const status = await rawRequestStatus([
    'GET http://evil.example:99999/ HTTP/1.1',
    'Host: evil.example',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
  ])
  assert.equal(status, 400)
  const health = await fetch(`${origin}/hub/health`)
  assert.equal(health.status, 200)
})

test('cross-site login POST is rejected', async () => {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'origin': 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(response.status, 403)
})

test('same-site and null-origin login POSTs are rejected', async () => {
  const sameSite = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-site' },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(sameSite.status, 403)
  const nullOrigin = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'null' },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(nullOrigin.status, 403)
})

test('same-origin login POST still works', async () => {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'origin': origin,
    },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(response.status, 302)
})

test('same-origin login with a default-port Host is accepted', async () => {
  const body = 'username=alice&password=alice-secret'
  const status = await rawRequestStatus([
    'POST /login HTTP/1.1',
    'Host: 127.0.0.1:80',
    'Origin: http://127.0.0.1',
    'Content-Type: application/x-www-form-urlencoded',
    `Content-Length: ${String(body.length)}`,
    '',
    body,
  ])
  assert.equal(status, 302)
})

test('a Host port that differs from the Origin port is rejected', async () => {
  const body = 'username=alice&password=alice-secret'
  const status = await rawRequestStatus([
    'POST /login HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Origin: http://127.0.0.1:9999',
    'Content-Type: application/x-www-form-urlencoded',
    `Content-Length: ${String(body.length)}`,
    '',
    body,
  ])
  assert.equal(status, 403)
})

test('login HTML carries clickjacking and nosniff headers', async () => {
  const response = await fetch(`${origin}/login`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow')
})

test('login page has no brand name and is not indexed', async () => {
  const english = await fetch(`${origin}/login`)
  const html = await english.text()
  assert.doesNotMatch(html, /DeepSeek Harness/)
  assert.match(html, /<title>Sign in<\/title>/)
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/)
  const switched = await fetch(`${origin}/lang?set=zh&next=/login`, { redirect: 'manual' })
  const cookie = switched.headers.get('set-cookie') ?? ''
  const chinese = await fetch(`${origin}/login`, { headers: { cookie } })
  const zhHtml = await chinese.text()
  assert.match(zhHtml, /<title>登录<\/title>/)
  assert.doesNotMatch(zhHtml, /DeepSeek Harness/)
})

test('cross-site browser websocket upgrade is 403', async () => {
  const login = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  const setCookie = login.headers.get('set-cookie') ?? ''
  const match = /dsh_hub_session=([^;]+)/.exec(setCookie)
  assert.ok(match)
  const status = await rawRequestStatus([
    'GET /api/events.mux HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Origin: https://evil.example',
    `Cookie: dsh_hub_session=${match[1]}`,
  ])
  assert.equal(status, 403)
})

test('cross-site logout is rejected', async () => {
  const viaSite = await fetch(`${origin}/logout`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'cross-site' },
    redirect: 'manual',
  })
  assert.equal(viaSite.status, 403)
  const viaOrigin = await fetch(`${origin}/logout`, {
    method: 'POST',
    headers: { 'origin': 'https://evil.example' },
    redirect: 'manual',
  })
  assert.equal(viaOrigin.status, 403)
})

function rawRequestStatus(lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('connect', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`raw request timeout; got:\n${data}`))
    }, 3000)
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data)
      if (match !== null) {
        clearTimeout(timer)
        socket.destroy()
        resolve(Number(match[1]))
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function upgradeStatus(url: string, authorization?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      perMessageDeflate: false,
      ...authorization !== undefined ? { headers: { authorization } } : {},
    })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('upgrade timeout'))
    }, 3000)
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      const status = res.statusCode ?? 0
      res.resume()
      ws.terminate()
      resolve(status)
    })
    ws.on('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve(101)
    })
    ws.on('error', () => {})
  })
}

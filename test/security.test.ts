import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { HubServer } from '../src/server.ts'
import { HubAgent } from '../src/agent.ts'
import { loadHubConfig } from '../src/config.ts'
import { hashedHubYaml, TEST_AGENT_SECRET } from './hashed-yaml.ts'

const SECRET = TEST_AGENT_SECRET
const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-sec-'))
const socketPath = join(dir, 'dsh.sock')
const configPath = join(dir, 'hub.yaml')
writeFileSync(configPath, hashedHubYaml({
  host: '127.0.0.1',
  port: 0,
  users: { alice: 'alice-secret' },
}))

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

test('login with an unknown username is 401', async () => {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=nobody&password=alice-secret',
    redirect: 'manual',
  })
  assert.equal(response.status, 401)
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

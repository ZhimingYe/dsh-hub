import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { HubServer } from '../src/server.ts'
import { HubAgent } from '../src/agent.ts'
import { loadHubConfig } from '../src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-re-'))
const socketPath = join(dir, 'dsh.sock')
const configPath = join(dir, 'hub.yaml')
writeFileSync(configPath, `
host: 127.0.0.1
port: 0
agentSecret: "test-agent-secret-1"
users:
  alice: "alice-secret"
`)

const dsh = createServer((_req, res) => {
  res.writeHead(200)
  res.end('ok')
})
const baseConfig = loadHubConfig(configPath)
let hub = new HubServer({ config: baseConfig })
let port = 0
let agent: HubAgent

before(async () => {
  await new Promise<void>((resolve, reject) => {
    dsh.listen({ path: socketPath }, () => {
      chmodSync(socketPath, 0o600)
      resolve()
    })
    dsh.once('error', reject)
  })
  port = await hub.listen()
  agent = new HubAgent({
    hubUrl: `ws://127.0.0.1:${String(port)}/agent`,
    username: 'alice',
    password: 'alice-secret',
    agentSecret: 'test-agent-secret-1',
    socketPath,
  })
  void agent.runForever()
  await waitFor(() => hub.agentOnline('alice'))
})

after(async () => {
  await agent.stop()
  await hub.close()
  await new Promise<void>(resolve => { dsh.close(() => { resolve() }) })
  rmSync(dir, { recursive: true, force: true })
})

test('agent reconnects after the tunnel socket is dropped', async () => {
  const previous = agent['ws']
  assert.ok(previous)
  previous.terminate()
  await waitFor(() => hub.agentOnline('alice') && agent['ws'] !== previous, 15_000)
  const response = await loginFetch()
  assert.equal(response.status, 200)
})

test('agent reconnects after hub restart', async () => {
  await hub.close()
  hub = new HubServer({ config: { ...baseConfig, port } })
  await hub.listen()
  await waitFor(() => hub.agentOnline('alice'), 15_000)
  const response = await loginFetch()
  assert.equal(response.status, 200)
})

async function loginFetch(): Promise<Response> {
  const login = await fetch(`http://127.0.0.1:${String(port)}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=alice&password=alice-secret',
    redirect: 'manual',
  })
  const setCookie = login.headers.get('set-cookie')
  assert.ok(setCookie)
  const match = /dsh_hub_session=([^;]+)/.exec(setCookie)
  assert.ok(match)
  return fetch(`http://127.0.0.1:${String(port)}/hello`, {
    headers: { cookie: `dsh_hub_session=${match[1]}` },
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
}

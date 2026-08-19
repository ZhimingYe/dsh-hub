import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'
import { HubServer } from '../src/server.ts'
import { HubAgent } from '../src/agent.ts'
import { loadHubConfig } from '../src/config.ts'
import { writeHashedHubYaml, TEST_AGENT_SECRET } from './hashed-yaml.ts'
import { wrapGzipResponse } from '../webserver-unix/src/gzip.js'

const HISTORY_LIKE = JSON.stringify({ events: Array.from({ length: 40 }, (_, seq) => ({
  type: 'assistant/message',
  seq,
  text: 'history-line '.repeat(8),
})) })

const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-'))
const socketPath = join(dir, 'dsh.sock')
const configPath = join(dir, 'hub.yaml')

writeHashedHubYaml(configPath, {
  host: '127.0.0.1',
  port: 0,
  users: { alice: 'alice-secret', bob: 'bob-secret' },
})

const dsh = createServer((req, res) => {
  if (req.url === '/history-like') {
    const out = wrapGzipResponse(req, res)
    out.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(HISTORY_LIKE)),
    })
    out.end(HISTORY_LIKE)
    return
  }
  if (req.url === '/hello') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-dsh-host': String(req.headers.host),
      'x-dsh-cookie': String(req.headers.cookie ?? ''),
      'x-dsh-origin': String(req.headers.origin ?? ''),
    })
    res.end('from-dsh')
    return
  }
  if (req.url === '/echo' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    req.pipe(res)
    return
  }
  if (req.url === '/set-cookie') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'set-cookie': 'dsh_hub_session=stolen',
    })
    res.end('cookie')
    return
  }
  res.writeHead(404)
  res.end('missing')
})

const dshWss = new WebSocketServer({ noServer: true })
dsh.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/api/events.mux') {
    socket.destroy()
    return
  }
  dshWss.handleUpgrade(req, socket, head, ws => {
    ws.on('message', (data, binary) => { ws.send(data, { binary }) })
  })
})

const hub = new HubServer({ config: loadHubConfig(configPath) })
let port = 0
let agent: HubAgent
let origin = ''
let cookie = ''

before(async () => {
  await new Promise<void>((resolve, reject) => {
    dsh.listen({ path: socketPath }, () => {
      chmodSync(socketPath, 0o600)
      resolve()
    })
    dsh.once('error', reject)
  })
  port = await hub.listen()
  origin = `http://127.0.0.1:${String(port)}`
  agent = new HubAgent({
    hubUrl: `ws://127.0.0.1:${String(port)}/agent`,
    username: 'alice',
    password: 'alice-secret',
    agentSecret: TEST_AGENT_SECRET,
    socketPath,
  })
  await agent.start()
  await waitFor(() => hub.agentOnline('alice'))
})

after(async () => {
  await agent.stop()
  await hub.close()
  await new Promise<void>(resolve => { dsh.close(() => { resolve() }) })
  rmSync(dir, { recursive: true, force: true })
})

test('anonymous browser is sent to login, not to DSH', async () => {
  const response = await fetch(`${origin}/hello`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login')
})

test('wrong password is rejected', async () => {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=alice&password=nope',
    redirect: 'manual',
  })
  assert.equal(response.status, 401)
  assert.match(await response.text(), /Incorrect username or password/)
})

test('tunneled gzip JSON stays compressed through Hub to the browser', async () => {
  const session = cookie.length > 0 ? cookie : await login('alice', 'alice-secret')
  const raw = await rawTunnelGet('/history-like', {
    cookie: session,
    'accept-encoding': 'gzip',
  })
  assert.equal(raw.status, 200)
  assert.equal(raw.headers['content-encoding'], 'gzip')
  assert.equal(gunzipSync(raw.body).toString('utf8'), HISTORY_LIKE)
  assert.ok(raw.body.length < Buffer.byteLength(HISTORY_LIKE))
})

test('alice can log in and reach DSH through the tunnel', async () => {
  cookie = await login('alice', 'alice-secret')
  const response = await fetch(`${origin}/hello`, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'from-dsh')
  assert.equal(response.headers.get('x-dsh-host'), '127.0.0.1')
  assert.equal(response.headers.get('x-dsh-cookie'), '')
  assert.equal(response.headers.get('x-dsh-origin'), '')
})

test('tunneled Set-Cookie is not forwarded to the browser', async () => {
  const session = cookie.length > 0 ? cookie : await login('alice', 'alice-secret')
  const response = await fetch(`${origin}/set-cookie`, { headers: { cookie: session } })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'cookie')
  assert.equal(response.headers.get('set-cookie'), null)
})

test('POST bodies stream through the tunnel', async () => {
  const response = await fetch(`${origin}/echo`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain' },
    body: 'payload-xyz',
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'payload-xyz')
})

test('browser websocket is relayed to DSH', async () => {
  const session = cookie.length > 0 ? cookie : await login('alice', 'alice-secret')
  await relayPing(session)
})

test('websocket target with a fragment is stripped and the agent survives', async () => {
  const session = cookie.length > 0 ? cookie : await login('alice', 'alice-secret')
  const status = await rawRequestStatus([
    'GET /api/events.mux#frag HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    `Cookie: ${session}`,
  ])
  assert.equal(status, 101)
  assert.equal(hub.agentOnline('alice'), true)
  await relayPing(session)
})

test('GET with a body streams through the tunnel without breaking the agent', async () => {
  const session = cookie.length > 0 ? cookie : await login('alice', 'alice-secret')
  const status = await rawRequestStatus([
    'GET /hello HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    `Cookie: ${session}`,
    'Content-Length: 18',
    '',
    'some-body-payload!',
  ])
  assert.equal(status, 200)
  assert.equal(hub.agentOnline('alice'), true)
  const after = await fetch(`${origin}/hello`, { headers: { cookie: session } })
  assert.equal(await after.text(), 'from-dsh')
})

test('bob is authenticated but has no agent', async () => {
  const bob = await login('bob', 'bob-secret')
  const response = await fetch(`${origin}/hello`, { headers: { cookie: bob } })
  assert.equal(response.status, 503)
  assert.match(await response.text(), /no workstation online/)
})

test('logout revokes the session', async () => {
  const session = await login('alice', 'alice-secret')
  const loggedOut = await fetch(`${origin}/logout`, {
    method: 'POST',
    headers: { cookie: session },
    redirect: 'manual',
  })
  assert.equal(loggedOut.status, 302)
  assert.equal(loggedOut.headers.get('location'), '/login')
  const setCookie = loggedOut.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /dsh_hub_session=/)
  assert.match(setCookie, /Max-Age=0/)
  const again = await fetch(`${origin}/hello`, { headers: { cookie: session }, redirect: 'manual' })
  assert.equal(again.status, 302)
  assert.equal(again.headers.get('location'), '/login')
})

test('GET /logout also signs out', async () => {
  const session = await login('alice', 'alice-secret')
  const loggedOut = await fetch(`${origin}/logout`, {
    headers: { cookie: session },
    redirect: 'manual',
  })
  assert.equal(loggedOut.status, 302)
  assert.equal(loggedOut.headers.get('location'), '/login')
  const again = await fetch(`${origin}/hello`, { headers: { cookie: session }, redirect: 'manual' })
  assert.equal(again.status, 302)
})

test('unauthenticated /api is 401', async () => {
  const response = await fetch(`${origin}/api/session.list`, { method: 'POST' })
  assert.equal(response.status, 401)
})

test('DSH is not listening on TCP', async () => {
  const address = dsh.address()
  assert.equal(typeof address, 'string')
  assert.equal(address, socketPath)
})

function rawTunnelGet(
  path: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${String(port)}${path}`, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => { chunks.push(chunk as Buffer) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
    }).on('error', reject)
  })
}

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `username=${username}&password=${password}`,
    redirect: 'manual',
  })
  assert.equal(response.status, 302)
  const setCookie = response.headers.get('set-cookie')
  assert.ok(setCookie)
  const match = /dsh_hub_session=([^;]+)/.exec(setCookie)
  assert.ok(match)
  return `dsh_hub_session=${match[1]}`
}

async function relayPing(session: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/events.mux`, {
      headers: { cookie: session },
      perMessageDeflate: false,
    })
    const timer = setTimeout(() => { reject(new Error(`reply timeout readyState=${String(ws.readyState)}`)) }, 3000)
    const ping = (): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping-mux')
    }
    ws.on('open', ping)
    const interval = setInterval(ping, 50)
    ws.on('message', (data) => {
      clearTimeout(timer)
      clearInterval(interval)
      try {
        assert.equal(String(data), 'ping-mux')
        ws.close()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    ws.on('error', error => { clearTimeout(timer); clearInterval(interval); reject(error) })
  })
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for agent')
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
}

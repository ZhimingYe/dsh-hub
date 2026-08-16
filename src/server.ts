import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  decodeFrame,
  decodeJson,
  encodeWsData,
  decodeWsData,
  sendFrame,
  sendJson,
  toBuffer,
  FrameType,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  type Frame,
  type HttpOpenPayload,
  type HttpRespOpenPayload,
  type RegisterPayload,
  type RegisterOkPayload,
  type WsOpenPayload,
} from './protocol.js'
import { appendLoginAudit, auditUsername } from './audit.js'
import { findUser, assertBindPolicy, type HubConfig, type HubUser } from './config.js'
import { BCRYPT_ROUNDS, bcryptCost, dummyPasswordHash, verifySecret } from './hash.js'
import {
  AUTH_FAILURE_MAX,
  AUTH_FAILURE_WINDOW_MS,
  FailureLimiter,
  SessionStore,
  bearerToken,
  clearSessionCookie,
  clientKey,
  isForwardedHttps,
  passwordsEqual,
  sessionCookie,
  sessionIdFromRequest,
} from './auth.js'
import { HUB_API_SECURITY_HEADERS, HUB_HTML_SECURITY_HEADERS, headersForBrowser, incomingToPairs } from './headers.js'
import { FAVICON_SVG, loginPage, offlinePage } from './pages.js'
import { hubLangFromRequest, langCookie, safeNextPath } from './locale.js'

interface HttpStream {
  kind: 'http'
  res: ServerResponse
}

interface WsStream {
  kind: 'ws'
  client: WebSocket
}

type Stream = HttpStream | WsStream

interface AgentLink {
  agentId: string
  user: string
  token: string
  ws: WebSocket
  nextStreamId: number
  streams: Map<number, Stream>
  lastBeat: number
}

export interface HubListenOptions {
  config: HubConfig
}

export class HubServer {
  private readonly config: HubConfig
  private readonly dummyPasswordHash: string
  private readonly sessions: SessionStore
  private readonly http: Server
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES })
  private readonly agentsByUser = new Map<string, AgentLink>()
  private readonly agentTokens = new Map<string, string>()
  private readonly loginFailures = new FailureLimiter(AUTH_FAILURE_WINDOW_MS, AUTH_FAILURE_MAX)
  private readonly registerFailures = new FailureLimiter(AUTH_FAILURE_WINDOW_MS, AUTH_FAILURE_MAX)
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(options: HubListenOptions) {
    this.config = options.config
    const sample = options.config.users[0]?.passwordHash
    this.dummyPasswordHash = dummyPasswordHash(bcryptCost(sample ?? '') ?? BCRYPT_ROUNDS)
    this.sessions = new SessionStore(options.config.sessionTtlSeconds * 1000)
    const listener = (req: IncomingMessage, res: ServerResponse): void => {
      void this.handleHttp(req, res)
    }
    this.http = createHttpServer(listener)
    this.http.on('upgrade', (req, socket, head) => { this.handleUpgrade(req, socket, head) })
  }

  get port(): number {
    const address = this.http.address()
    if (address === null || typeof address === 'string') return this.config.port
    return address.port
  }

  async listen(): Promise<number> {
    assertBindPolicy(this.config)
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.off('error', reject)
        resolve()
      })
    })
    this.heartbeat = setInterval(() => { this.sweepHeartbeats() }, HEARTBEAT_MS)
    this.heartbeat.unref()
    return this.port
  }

  async close(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    for (const link of this.agentsByUser.values()) {
      this.failStreams(link, 'hub stopping')
      link.ws.close()
    }
    this.agentsByUser.clear()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { resolve() }, 1000)
      this.http.close(error => {
        clearTimeout(timer)
        if (error !== undefined) reject(error)
        else resolve()
      })
      this.http.closeAllConnections()
    })
  }

  agentOnline(username: string): boolean {
    const link = this.agentsByUser.get(username)
    return link !== undefined && link.ws.readyState === WebSocket.OPEN
  }

  private userFromRequest(req: IncomingMessage): string | undefined {
    return this.sessions.get(sessionIdFromRequest(req))?.username
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub.local')
    try {
      if (req.method === 'GET' && url.pathname === '/favicon.svg') {
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=86400',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff',
        })
        res.end(FAVICON_SVG)
        return
      }
      if (req.method === 'GET' && url.pathname === '/lang') {
        const set = url.searchParams.get('set')
        if (set !== 'en' && set !== 'zh') {
          res.writeHead(400, { ...HUB_API_SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
          res.end('invalid lang')
          return
        }
        const next = safeNextPath(url.searchParams.get('next'))
        res.writeHead(302, {
          ...HUB_API_SECURITY_HEADERS,
          location: next,
          'set-cookie': langCookie(set, isForwardedHttps(req, this.config.trustedProxies)),
        })
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        this.html(res, 200, loginPage(hubLangFromRequest(req)))
        return
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        if (!isSameOriginRequest(req)) {
          this.json(res, 403, { error: 'forbidden' })
          return
        }
        await this.handleLogin(req, res)
        return
      }
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/logout') {
        if (!isSameOriginRequest(req)) {
          this.json(res, 403, { error: 'forbidden' })
          return
        }
        this.sessions.revoke(sessionIdFromRequest(req))
        res.writeHead(302, {
          ...HUB_API_SECURITY_HEADERS,
          location: '/login',
          'set-cookie': clearSessionCookie(isForwardedHttps(req, this.config.trustedProxies)),
        })
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/hub/health') {
        this.json(res, 200, { ok: true })
        return
      }
      const username = this.userFromRequest(req)
      if (req.method === 'GET' && url.pathname === '/hub/status') {
        if (username === undefined) {
          this.json(res, 401, { error: 'unauthorized' })
          return
        }
        this.json(res, 200, { user: username, agentOnline: this.agentOnline(username) })
        return
      }
      if (username === undefined) {
        if (url.pathname.startsWith('/api') || req.headers.upgrade !== undefined) {
          res.writeHead(401, { ...HUB_API_SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
          res.end('unauthorized')
          return
        }
        res.writeHead(302, { ...HUB_API_SECURITY_HEADERS, location: '/login' })
        res.end()
        return
      }
      if (!this.agentOnline(username)) {
        this.html(res, 503, offlinePage(hubLangFromRequest(req), username))
        return
      }
      await this.tunnelHttp(username, req, res, url)
    } catch (error) {
      console.error(error instanceof Error ? error : new Error(String(error)))
      if (!res.headersSent) {
        res.writeHead(500, { ...HUB_API_SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      } else {
        res.destroy()
      }
    }
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, 64 * 1024)
    const params = new URLSearchParams(body.toString('utf8'))
    const username = (params.get('username') ?? '').trim()
    const password = params.get('password') ?? ''
    const key = clientKey(req, this.config.trustedProxies)
    if (this.loginFailures.limited(key)) {
      console.warn(`dsh-hub: login rate-limited from ${key}`)
      this.html(res, 429, loginPage(hubLangFromRequest(req), 'tooMany'))
      return
    }
    const user = findUser(this.config, username)
    if (!this.passwordMatches(user, password)) {
      this.loginFailures.add(key)
      this.auditLogin('login.fail', key, auditUsername(username))
      console.warn(`dsh-hub: login failed from ${key}`)
      this.html(res, 401, loginPage(hubLangFromRequest(req), 'badCredentials'))
      return
    }
    this.auditLogin('login.ok', key, user.username)
    console.log(`dsh-hub: login ok for ${user.username} from ${key}`)
    const id = this.sessions.create(user.username)
    res.writeHead(302, {
      ...HUB_API_SECURITY_HEADERS,
      location: '/',
      'set-cookie': sessionCookie(
        id,
        this.config.sessionTtlSeconds,
        isForwardedHttps(req, this.config.trustedProxies),
      ),
    })
    res.end()
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let upgraded = false
    try {
      const url = new URL(req.url ?? '/', 'http://hub.local')
      if (url.pathname === '/agent') {
        const key = clientKey(req, this.config.trustedProxies)
        if (this.registerFailures.limited(key)) {
          socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        if (!this.agentSecretOk(req)) {
          this.registerFailures.add(key)
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        this.wss.handleUpgrade(req, socket, head, ws => {
          upgraded = true
          this.onAgentSocket(req, ws)
        })
        return
      }
      const username = this.userFromRequest(req)
      if (username === undefined) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (!isSameOriginRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (!this.agentOnline(username)) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        upgraded = true
        void this.tunnelBrowserSocket(username, req, ws, url).catch(error => {
          console.error(error instanceof Error ? error : new Error(String(error)))
          ws.close(1011, 'tunnel setup failed')
        })
      })
    } catch (error) {
      console.error(error instanceof Error ? error : new Error(String(error)))
      // after a completed handshake the socket carries WebSocket frames, not HTTP
      if (!upgraded && !socket.destroyed) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      }
      socket.destroy()
    }
  }

  private onAgentSocket(req: IncomingMessage, ws: WebSocket): void {
    let registered = false
    const timer = setTimeout(() => {
      if (!registered) ws.close(4001, 'register timeout')
    }, 10_000)
    ws.on('message', (raw, isBinary) => {
      if (!isBinary && !Buffer.isBuffer(raw)) {
        ws.close(4002, 'binary frames required')
        return
      }
      let frame: Frame
      try {
        frame = decodeFrame(toBuffer(raw))
      } catch {
        ws.close(4003, 'bad frame')
        return
      }
      if (!registered) {
        if (frame.type !== FrameType.Register) {
          ws.close(4004, 'first frame must be register')
          return
        }
        clearTimeout(timer)
        registered = this.acceptRegister(req, ws, frame)
        return
      }
      this.onAgentFrame(ws, frame)
    })
    ws.on('close', () => {
      clearTimeout(timer)
      this.dropAgent(ws)
    })
    ws.on('error', () => { ws.terminate() })
    enableKeepAlive(ws)
  }

  private acceptRegister(req: IncomingMessage, ws: WebSocket, frame: Frame): boolean {
    const key = clientKey(req, this.config.trustedProxies)
    if (this.registerFailures.limited(key)) {
      sendJson(ws, FrameType.RegisterErr, 0, { error: 'rate limited' })
      ws.close(4009, 'rate limited')
      return false
    }
    let payload: RegisterPayload
    try {
      payload = decodeJson<RegisterPayload>(frame.payload)
    } catch {
      sendJson(ws, FrameType.RegisterErr, 0, { error: 'invalid register payload' })
      ws.close(4005, 'invalid register')
      return false
    }
    const user = findUser(this.config, payload.username)
    const storedToken = user === undefined ? undefined : this.agentTokens.get(user.username)
    const passwordOk = payload.password !== undefined && this.passwordMatches(user, payload.password)
    const tokenOk = user !== undefined && payload.token !== undefined && storedToken !== undefined
      && passwordsEqual(payload.token, storedToken)
    if (user === undefined || (!passwordOk && !tokenOk)) {
      this.registerFailures.add(key)
      console.warn(`dsh-hub: agent register rejected for ${sanitizeLogUsername(payload.username)}`)
      sendJson(ws, FrameType.RegisterErr, 0, { error: 'unauthorized' })
      ws.close(4006, 'unauthorized')
      return false
    }
    const previous = this.agentsByUser.get(user.username)
    if (previous !== undefined && previous.ws !== ws) {
      previous.ws.terminate()
      this.failStreams(previous, 'agent replaced')
    }
    const token = randomToken()
    this.agentTokens.set(user.username, token)
    const link: AgentLink = {
      agentId: user.username,
      user: user.username,
      token,
      ws,
      nextStreamId: 1,
      streams: new Map(),
      lastBeat: Date.now(),
    }
    this.agentsByUser.set(user.username, link)
    const ok: RegisterOkPayload = { user: user.username, token }
    sendJson(ws, FrameType.RegisterOk, 0, ok)
    return true
  }

  private dropAgent(ws: WebSocket): void {
    for (const [user, link] of this.agentsByUser) {
      if (link.ws !== ws) continue
      this.failStreams(link, 'agent disconnected')
      this.agentsByUser.delete(user)
      // Only the replaced agent's token is dropped; a newer agent that took
      // over this user keeps its token, or the takeover would force a
      // password re-register on the first reconnect.
      if (this.agentTokens.get(user) === link.token) this.agentTokens.delete(user)
    }
  }

  private failStreams(link: AgentLink, reason: string): void {
    for (const stream of link.streams.values()) {
      if (stream.kind === 'http') {
        if (!stream.res.headersSent) {
          stream.res.writeHead(502, { ...HUB_API_SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' })
          stream.res.end(reason)
        } else {
          stream.res.destroy()
        }
      } else {
        stream.client.close(1011, reason)
      }
    }
    link.streams.clear()
  }

  private onAgentFrame(ws: WebSocket, frame: Frame): void {
    const link = [...this.agentsByUser.values()].find(item => item.ws === ws)
    if (link === undefined) return
    link.lastBeat = Date.now()
    if (frame.type === FrameType.Heartbeat) {
      sendFrame(ws, FrameType.Heartbeat, 0)
      return
    }
    const stream = link.streams.get(frame.streamId)
    if (stream === undefined) return
    if (stream.kind === 'http') this.onHttpFrame(link, stream, frame)
    else this.onWsFrame(link, stream, frame)
  }

  private onHttpFrame(link: AgentLink, stream: HttpStream, frame: Frame): void {
    const { res } = stream
    try {
      if (frame.type === FrameType.HttpRespOpen) {
        const open = decodeJson<HttpRespOpenPayload>(frame.payload)
        if (!res.headersSent) res.writeHead(open.status, headersForBrowser(open.headers))
        return
      }
      if (frame.type === FrameType.HttpRespData) {
        if (!res.headersSent) res.writeHead(200)
        res.write(frame.payload)
        return
      }
      if (frame.type === FrameType.HttpRespEnd || frame.type === FrameType.Abort) {
        link.streams.delete(frame.streamId)
        if (!res.writableEnded) res.end()
      }
    } catch {
      link.streams.delete(frame.streamId)
      res.destroy()
    }
  }

  private onWsFrame(link: AgentLink, stream: WsStream, frame: Frame): void {
    if (frame.type === FrameType.WsData) {
      const { binary, data } = decodeWsData(frame.payload)
      if (stream.client.readyState === WebSocket.OPEN) stream.client.send(data, { binary })
      return
    }
    if (frame.type === FrameType.WsClose || frame.type === FrameType.WsOpenErr || frame.type === FrameType.Abort) {
      link.streams.delete(frame.streamId)
      stream.client.close()
    }
  }

  private async tunnelHttp(username: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const link = this.agentsByUser.get(username)
    if (link === undefined) {
      this.html(res, 503, offlinePage(hubLangFromRequest(req), username))
      return
    }
    const streamId = link.nextStreamId++
    link.streams.set(streamId, { kind: 'http', res })
    const open: HttpOpenPayload = {
      method: req.method ?? 'GET',
      url: url.pathname + url.search,
      headers: incomingToPairs(req.headers),
    }
    sendJson(link.ws, FrameType.HttpOpen, streamId, open)
    let ended = false
    const finish = (): void => {
      if (ended) return
      ended = true
      sendFrame(link.ws, FrameType.HttpEnd, streamId)
    }
    req.on('data', (chunk: Buffer) => {
      sendFrame(link.ws, FrameType.HttpData, streamId, chunk)
    })
    req.on('end', finish)
    req.on('aborted', () => {
      sendFrame(link.ws, FrameType.Abort, streamId)
      link.streams.delete(streamId)
    })
    if (req.readableEnded) finish()
    else req.resume()
  }

  private async tunnelBrowserSocket(username: string, req: IncomingMessage, client: WebSocket, url: URL): Promise<void> {
    const link = this.agentsByUser.get(username)
    if (link === undefined) {
      client.close(1011, 'agent offline')
      return
    }
    const streamId = link.nextStreamId++
    link.streams.set(streamId, { kind: 'ws', client })
    const open: WsOpenPayload = {
      url: url.pathname + url.search,
      headers: incomingToPairs(req.headers),
    }
    sendJson(link.ws, FrameType.WsOpen, streamId, open)
    client.on('message', (raw, isBinary) => {
      sendFrame(link.ws, FrameType.WsData, streamId, encodeWsData(isBinary, toBuffer(raw)))
    })
    const close = (): void => {
      if (link.streams.delete(streamId)) sendFrame(link.ws, FrameType.WsClose, streamId)
    }
    client.on('close', close)
    client.on('error', close)
  }

  private sweepHeartbeats(): void {
    this.sessions.sweepExpired()
    this.loginFailures.sweep()
    this.registerFailures.sweep()
    const now = Date.now()
    for (const [user, link] of this.agentsByUser) {
      if (now - link.lastBeat > HEARTBEAT_TIMEOUT_MS) {
        this.failStreams(link, 'heartbeat timeout')
        this.agentsByUser.delete(user)
        link.ws.terminate()
        continue
      }
      sendFrame(link.ws, FrameType.Heartbeat, 0)
      if (link.ws.readyState === WebSocket.OPEN) link.ws.ping()
    }
  }

  private html(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { ...HUB_HTML_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...HUB_API_SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  private auditLogin(event: 'login.ok' | 'login.fail', ip: string, user?: string): void {
    appendLoginAudit(this.config.auditLogPath, { event, ip, ...user !== undefined ? { user } : {} })
  }

  /** bcrypt-verify against the user hash or a dummy hash so a missing username is not a fast reject. */
  private passwordMatches(user: HubUser | undefined, password: string): user is HubUser {
    const hash = user?.passwordHash ?? this.dummyPasswordHash
    const ok = verifySecret(password, hash)
    return user !== undefined && ok
  }

  private agentSecretOk(req: IncomingMessage): boolean {
    const token = bearerToken(req)
    if (token === undefined) return false
    return verifySecret(token, this.config.agentSecretHash)
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.byteLength
    if (total > maxBytes) throw new Error('dsh-hub: request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/**
 * Whether a state-changing request is same-origin. Rejects browser cross-site
 * form posts (login/logout CSRF): `Sec-Fetch-Site` is browser-controlled, and
 * an `Origin` hostname that differs from the request `Host` is a different
 * origin. Requests without an Origin header (direct navigation, non-browser
 * clients) pass.
 */
function isSameOriginRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  const header = req.headers.origin
  if (typeof header !== 'string' || header.length === 0) return true
  if (header === 'null') return false
  let origin: URL
  try {
    origin = new URL(header)
  } catch {
    // an unparseable Origin is never the Hub origin
    return false
  }
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host.trim()}`)
  } catch {
    // an unparseable Host cannot prove the request is same-origin
    return false
  }
  if (hostUrl.hostname.toLowerCase() !== origin.hostname.toLowerCase()) return false
  // A proxy may drop the Host port; the hostname match already rules out
  // cross-site origins, so a portless Host is accepted.
  if (hostUrl.port === '') return true
  const originPort = origin.port === '' ? (origin.protocol === 'https:' ? '443' : '80') : origin.port
  return hostUrl.port === originPort
}

function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Control characters in a register frame's username must not reach the log. */
function sanitizeLogUsername(username: string): string {
  return username.replace(/[\x00-\x1f\x7f]/g, '?')
}

function enableKeepAlive(ws: WebSocket): void {
  const socket = (ws as unknown as { _socket?: { setKeepAlive(on: boolean, delay: number): void; setNoDelay(on: boolean): void } })._socket
  socket?.setKeepAlive(true, 30_000)
  socket?.setNoDelay(true)
}

export type { AddressInfo }

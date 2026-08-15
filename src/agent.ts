import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { WebSocket } from 'ws'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  DATA_CHUNK,
  FrameType,
  HANDSHAKE_TIMEOUT_MS,
  HEALTHY_RESET_MS,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  decodeFrame,
  decodeJson,
  decodeWsData,
  encodeWsData,
  sendFrame,
  sendJson as sendJsonFrame,
  toBuffer,
  type Frame,
  type HttpOpenPayload,
  type RegisterOkPayload,
  type RegisterPayload,
  type WsOpenPayload,
} from './protocol.js'
import { headersForDsh, incomingToPairs } from './headers.js'
import { isLoopbackHostname } from './paths.js'

export interface AgentOptions {
  hubUrl: string
  username: string
  password: string
  agentSecret: string
  socketPath: string
}

export class HubAgent {
  private ws: WebSocket | undefined
  private stopped = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private lastInbound = 0
  private sessionToken: string | undefined
  private retryPasswordNow = false
  private readonly httpStreams = new Map<number, ReturnType<typeof httpRequest>>()
  private readonly wsStreams = new Map<number, WebSocket>()

  constructor(private readonly options: AgentOptions) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.teardown()
  }

  async runForever(): Promise<void> {
    this.stopped = false
    let delay = BACKOFF_MIN_MS
    while (!this.stopped) {
      const began = Date.now()
      try {
        await this.connect()
        await this.waitUntilDead()
        if (Date.now() - began >= HEALTHY_RESET_MS) delay = BACKOFF_MIN_MS
      } catch (error) {
        if (this.stopped) return
        if (this.retryPasswordNow) {
          this.retryPasswordNow = false
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        console.error(`reconnect in ${String(delay)}ms: ${message}`)
        await sleep(withJitter(delay), () => this.stopped)
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
        continue
      }
      if (this.stopped) return
      console.error(`reconnect in ${String(delay)}ms`)
      await sleep(withJitter(delay), () => this.stopped)
      if (Date.now() - began < HEALTHY_RESET_MS) delay = Math.min(delay * 2, BACKOFF_MAX_MS)
    }
  }

  private connect(): Promise<void> {
    this.detachSocket()
    this.teardownStreams('reconnect')
    return new Promise((resolve, reject) => {
      const proxy = proxyForHub(this.options.hubUrl)
      const ws = new WebSocket(this.options.hubUrl, {
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        perMessageDeflate: false,
        followRedirects: false,
        maxPayload: MAX_FRAME_BYTES,
        headers: { authorization: `Bearer ${this.options.agentSecret}` },
        ...proxy !== undefined ? { agent: new HttpsProxyAgent(proxy) } : {},
      })
      this.ws = ws
      let timer = setTimeout(() => {
        ws.terminate()
        fail(new Error('handshake timeout'))
      }, HANDSHAKE_TIMEOUT_MS)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        ws.off('open', onOpen)
        ws.off('error', onFail)
        ws.off('unexpected-response', onHttp)
        ws.removeAllListeners()
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate()
        reject(error)
      }
      const onFail = (error: Error): void => { fail(error) }
      const onHttp = (_req: IncomingMessage, res: IncomingMessage): void => {
        const status = res.statusCode ?? 0
        res.resume()
        fail(new Error(`http ${String(status)}`))
      }
      const onOpen = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => { fail(new Error('register timeout')) }, 15_000)
        this.lastInbound = Date.now()
        enableKeepAlive(ws)
        const register: RegisterPayload = this.sessionToken === undefined
          ? { username: this.options.username, password: this.options.password }
          : { username: this.options.username, token: this.sessionToken }
        sendJsonFrame(ws, FrameType.Register, 0, register)
        const onFirst = (raw: WebSocket.RawData): void => {
          this.lastInbound = Date.now()
          let frame: Frame
          try {
            frame = decodeFrame(toBuffer(raw))
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
            return
          }
          if (frame.type === FrameType.RegisterOk) {
            clearTimeout(timer)
            const ok = decodeJson<RegisterOkPayload>(frame.payload)
            this.sessionToken = ok.token
            ws.on('message', (next) => {
              this.lastInbound = Date.now()
              this.onMessage(toBuffer(next))
            })
            ws.on('ping', () => { this.lastInbound = Date.now() })
            ws.on('pong', () => { this.lastInbound = Date.now() })
            ws.on('close', () => { this.teardownStreams('hub closed') })
            ws.on('error', () => { ws.terminate() })
            this.heartbeat = setInterval(() => { this.beat() }, HEARTBEAT_MS)
            this.heartbeat.unref()
            resolve()
            return
          }
          if (frame.type === FrameType.RegisterErr) {
            if (this.sessionToken !== undefined) {
              this.sessionToken = undefined
              this.retryPasswordNow = true
            }
            fail(new Error('register rejected'))
            return
          }
          fail(new Error('unexpected register reply'))
        }
        ws.once('message', onFirst)
      }
      ws.once('open', onOpen)
      ws.once('error', onFail)
      ws.once('unexpected-response', onHttp)
    })
  }

  private beat(): void {
    const ws = this.ws
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - this.lastInbound > HEARTBEAT_TIMEOUT_MS) {
      ws.terminate()
      return
    }
    sendFrame(ws, FrameType.Heartbeat, 0)
    ws.ping()
  }

  private waitUntilDead(): Promise<void> {
    const ws = this.ws
    if (ws === undefined || ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise(resolve => {
      const done = (): void => {
        ws.off('close', done)
        resolve()
      }
      ws.once('close', done)
    })
  }

  private detachSocket(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    const ws = this.ws
    this.ws = undefined
    if (ws === undefined) return
    ws.removeAllListeners()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate()
  }

  private teardown(): void {
    this.teardownStreams('agent stopping')
    this.detachSocket()
  }

  private teardownStreams(reason: string): void {
    for (const req of this.httpStreams.values()) req.destroy(new Error(reason))
    this.httpStreams.clear()
    for (const socket of this.wsStreams.values()) socket.close()
    this.wsStreams.clear()
  }

  private send(type: number, streamId: number, payload?: Buffer): void {
    const ws = this.ws
    if (ws === undefined) return
    sendFrame(ws, type, streamId, payload)
  }

  private sendJson(type: number, streamId: number, value: unknown): void {
    const ws = this.ws
    if (ws === undefined) return
    sendJsonFrame(ws, type, streamId, value)
  }

  private onMessage(raw: Buffer): void {
    let frame: Frame
    try {
      frame = decodeFrame(raw)
    } catch (error) {
      console.error(`bad frame: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    switch (frame.type) {
      case FrameType.RegisterOk:
        console.log(`connected as ${this.options.username}`)
        return
      case FrameType.RegisterErr:
        console.error(`register rejected: ${frame.payload.toString('utf8')}`)
        this.ws?.close(4006, 'register rejected')
        return
      case FrameType.Heartbeat:
        return
      case FrameType.HttpOpen:
        this.onHttpOpen(frame)
        return
      case FrameType.HttpData:
        this.httpStreams.get(frame.streamId)?.write(frame.payload)
        return
      case FrameType.HttpEnd:
        this.httpStreams.get(frame.streamId)?.end()
        return
      case FrameType.WsOpen:
        this.onWsOpen(frame)
        return
      case FrameType.WsData:
        this.onWsData(frame)
        return
      case FrameType.WsClose:
      case FrameType.Abort:
        this.abortStream(frame.streamId)
        return
      default:
        return
    }
  }

  private onHttpOpen(frame: Frame): void {
    let open: HttpOpenPayload
    try {
      open = decodeJson<HttpOpenPayload>(frame.payload)
    } catch {
      this.sendJson(FrameType.HttpRespOpen, frame.streamId, { status: 400, headers: [] })
      this.send(FrameType.HttpRespEnd, frame.streamId)
      return
    }
    const req = httpRequest({
      socketPath: this.options.socketPath,
      path: open.url,
      method: open.method,
      headers: headersForDsh(open.headers),
    }, res => { this.pipeHttpResponse(frame.streamId, res) })
    req.on('error', error => {
      this.httpStreams.delete(frame.streamId)
      console.error(error)
      this.sendJson(FrameType.HttpRespOpen, frame.streamId, {
        status: 502,
        headers: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }],
      })
      this.send(FrameType.HttpRespData, frame.streamId, Buffer.from('bad gateway', 'utf8'))
      this.send(FrameType.HttpRespEnd, frame.streamId)
    })
    this.httpStreams.set(frame.streamId, req)
    if (open.method === 'GET' || open.method === 'HEAD') req.end()
  }

  private pipeHttpResponse(streamId: number, res: IncomingMessage): void {
    this.sendJson(FrameType.HttpRespOpen, streamId, {
      status: res.statusCode ?? 502,
      headers: incomingToPairs(res.headers),
    })
    res.on('data', (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += DATA_CHUNK) {
        this.send(FrameType.HttpRespData, streamId, chunk.subarray(offset, offset + DATA_CHUNK))
      }
    })
    res.on('end', () => {
      this.httpStreams.delete(streamId)
      this.send(FrameType.HttpRespEnd, streamId)
    })
    res.on('error', () => {
      this.httpStreams.delete(streamId)
      this.send(FrameType.Abort, streamId)
    })
  }

  private onWsOpen(frame: Frame): void {
    let open: WsOpenPayload
    try {
      open = decodeJson<WsOpenPayload>(frame.payload)
    } catch {
      this.sendJson(FrameType.WsOpenErr, frame.streamId, { error: 'bad ws open' })
      return
    }
    const pathname = open.url
    const target = new WebSocket(`ws://127.0.0.1${pathname}`, {
      agent: new HttpAgent({ socketPath: this.options.socketPath } as ConstructorParameters<typeof HttpAgent>[0]),
      headers: { host: '127.0.0.1' },
    })
    this.wsStreams.set(frame.streamId, target)
    target.on('open', () => { this.sendJson(FrameType.WsOpenOk, frame.streamId, { ok: true }) })
    target.on('message', (raw, isBinary) => {
      this.send(FrameType.WsData, frame.streamId, encodeWsData(isBinary, toBuffer(raw)))
    })
    target.on('close', () => {
      this.wsStreams.delete(frame.streamId)
      this.send(FrameType.WsClose, frame.streamId)
    })
    target.on('error', error => {
      this.wsStreams.delete(frame.streamId)
      console.error(error)
      this.sendJson(FrameType.WsOpenErr, frame.streamId, { error: 'bad gateway' })
    })
  }

  private onWsData(frame: Frame): void {
    const socket = this.wsStreams.get(frame.streamId)
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return
    const { binary, data } = decodeWsData(frame.payload)
    socket.send(data, { binary })
  }

  private abortStream(streamId: number): void {
    const req = this.httpStreams.get(streamId)
    if (req !== undefined) {
      this.httpStreams.delete(streamId)
      req.destroy()
    }
    const socket = this.wsStreams.get(streamId)
    if (socket !== undefined) {
      this.wsStreams.delete(streamId)
      socket.close()
    }
  }
}

function enableKeepAlive(ws: WebSocket): void {
  const socket = (ws as unknown as { _socket?: { setKeepAlive(on: boolean, delay: number): void; setNoDelay(on: boolean): void } })._socket
  socket?.setKeepAlive(true, 30_000)
  socket?.setNoDelay(true)
}

function proxyForHub(hubUrl: string): string | undefined {
  let hostname: string
  try {
    hostname = new URL(hubUrl).hostname
  } catch {
    return undefined
  }
  if (isLoopbackHostname(hostname)) return undefined
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (proxy === undefined || proxy.length === 0) return undefined
  return proxy
}

function withJitter(delay: number): number {
  return delay + Math.floor(Math.random() * delay * 0.25)
}

function sleep(ms: number, stopped: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const end = Date.now() + ms
    const tick = (): void => {
      if (stopped() || Date.now() >= end) {
        resolve()
        return
      }
      setTimeout(tick, Math.min(200, end - Date.now()))
    }
    tick()
  })
}

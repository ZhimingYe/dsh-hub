export const FrameType = {
  Register: 1,
  RegisterOk: 2,
  RegisterErr: 3,
  Heartbeat: 4,
  HttpOpen: 5,
  HttpData: 6,
  HttpEnd: 7,
  HttpRespOpen: 8,
  HttpRespData: 9,
  HttpRespEnd: 10,
  WsOpen: 11,
  WsOpenOk: 12,
  WsOpenErr: 13,
  WsData: 14,
  WsClose: 15,
  Abort: 16,
} as const

export type FrameTypeId = (typeof FrameType)[keyof typeof FrameType]

export interface Frame {
  type: number
  streamId: number
  payload: Buffer
}

export interface HeaderPair {
  name: string
  value: string
}

export interface RegisterPayload {
  username: string
  password?: string
  token?: string
}

export interface RegisterOkPayload {
  user: string
  token: string
}

export interface HttpOpenPayload {
  method: string
  url: string
  headers: HeaderPair[]
}

export interface HttpRespOpenPayload {
  status: number
  headers: HeaderPair[]
}

export interface WsOpenPayload {
  url: string
  headers: HeaderPair[]
}

export interface WsDataPayload {
  binary: boolean
}

export const DATA_CHUNK = 64 * 1024
export const HEARTBEAT_MS = 15_000
export const HEARTBEAT_TIMEOUT_MS = 75_000
export const HANDSHAKE_TIMEOUT_MS = 20_000
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 300_000
export const HEALTHY_RESET_MS = 60_000
/** Largest tunnel WebSocket payload. HTTP bodies are already split at {@link DATA_CHUNK}. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export function encodeFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const buf = Buffer.allocUnsafe(5 + payload.length)
  buf.writeUInt8(type, 0)
  buf.writeUInt32BE(streamId >>> 0, 1)
  payload.copy(buf, 5)
  return buf
}

export function encodeJson(type: number, streamId: number, value: unknown): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(value), 'utf8'))
}

export function sendFrame(ws: { send(data: Buffer, opts: { binary: boolean }): void; readyState: number }, type: number, streamId: number, payload?: Buffer): void {
  if (ws.readyState !== 1) return
  ws.send(encodeFrame(type, streamId, payload ?? Buffer.alloc(0)), { binary: true })
}

export function sendJson(ws: { send(data: Buffer, opts: { binary: boolean }): void; readyState: number }, type: number, streamId: number, value: unknown): void {
  sendFrame(ws, type, streamId, Buffer.from(JSON.stringify(value), 'utf8'))
}

export function decodeFrame(data: Buffer): Frame {
  if (data.length < 5) throw new Error(`dsh-hub: short tunnel frame (${String(data.length)} bytes)`)
  return {
    type: data.readUInt8(0),
    streamId: data.readUInt32BE(1),
    payload: data.subarray(5),
  }
}

export function decodeJson<T>(payload: Buffer): T {
  return JSON.parse(payload.toString('utf8')) as T
}

export function encodeWsData(binary: boolean, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([binary ? 1 : 0]), data])
}

export function decodeWsData(payload: Buffer): { binary: boolean; data: Buffer } {
  if (payload.length < 1) return { binary: true, data: Buffer.alloc(0) }
  return { binary: payload[0] === 1, data: payload.subarray(1) }
}

export function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

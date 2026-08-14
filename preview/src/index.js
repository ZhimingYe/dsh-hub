import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { classify, contentDisposition, contentTypeFor, extensionOf, looksBinary, maxBytesFor } from './types.js'

export { classify, contentDisposition, contentTypeFor, looksBinary, maxBytesFor } from './types.js'

export const inject = ['webServer']
export const name = 'hub-preview'

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function isAbsolutePath(filePath) {
  return isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath)
}

export async function handlePreview(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed')
    return
  }
  const rawPath = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? ''
  if (rawPath.length === 0 || rawPath.includes('\0')) {
    send(res, 400, 'invalid path')
    return
  }
  const filePath = isAbsolutePath(rawPath) ? rawPath : resolve(process.cwd(), rawPath)
  const kind = classify(filePath)
  if (kind === 'blocked' || kind === 'unknown') {
    send(res, 415, 'preview not supported')
    return
  }
  let resolved
  let info
  try {
    resolved = await realpath(filePath)
    info = await stat(resolved)
  } catch {
    send(res, 404, 'not found')
    return
  }
  if (!info.isFile()) {
    send(res, 404, 'not found')
    return
  }
  const limit = maxBytesFor(kind)
  if (info.size > limit) {
    send(res, 413, 'file too large')
    return
  }
  const type = contentTypeFor(resolved, kind)
  const name = basename(resolved)
  const svg = extensionOf(resolved) === 'svg'
  const headers = {
    'content-type': type,
    'content-disposition': contentDisposition(name, svg),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  }
  if (svg) headers['content-security-policy'] = "default-src 'none'"
  if (kind === 'text') {
    let buf
    try {
      buf = await readFile(resolved)
    } catch {
      send(res, 404, 'not found')
      return
    }
    if (looksBinary(buf)) {
      send(res, 415, 'preview not supported')
      return
    }
    headers['content-length'] = String(buf.byteLength)
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(buf)
    return
  }
  headers['content-length'] = String(info.size)
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(resolved)
  stream.on('error', () => {
    if (!res.headersSent) send(res, 404, 'not found')
    else res.destroy()
  })
  stream.pipe(res)
}

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/hub/preview',
    handler: (req, res) => handlePreview(req, res),
  })
}

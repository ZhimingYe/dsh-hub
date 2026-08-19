/**
 * Gzip compressible HTTP responses when the client sends Accept-Encoding: gzip.
 * Applied on the Unix-socket webserver so the Hub agent forwards already-compressed
 * bodies. Upgrade sockets are not wrapped.
 */
import { createGzip } from 'node:zlib'

/** Skip gzip when Content-Length is present and below this many bytes. */
export const GZIP_MIN_BYTES = 256

/**
 * True when `Accept-Encoding` names gzip (or `*`) with a non-zero q-value.
 * @param {import('node:http').IncomingMessage} req
 */
export function acceptsGzip(req) {
  const header = req.headers['accept-encoding']
  const raw = Array.isArray(header) ? header.join(',') : header
  if (typeof raw !== 'string' || raw.length === 0) return false
  for (const part of raw.split(',')) {
    const [token, ...params] = part.trim().split(';')
    const name = token.trim().toLowerCase()
    if (name !== 'gzip' && name !== 'x-gzip' && name !== '*') continue
    const quality = params.find(param => param.trim().toLowerCase().startsWith('q='))
    if (quality !== undefined && Number(quality.trim().slice(2)) === 0) continue
    return true
  }
  return false
}

/**
 * True for JSON, HTML, JavaScript, and other text types the workstation serves.
 * SSE and already-framed event streams stay uncompressed.
 * @param {string} contentType
 */
export function isCompressibleType(contentType) {
  const media = mediaTypeOf(contentType)
  if (media === '' || media === 'text/event-stream') return false
  if (media.startsWith('text/')) return true
  if (media === 'application/json' || media === 'application/javascript' || media === 'application/xml') return true
  if (media === 'application/manifest+json' || media === 'image/svg+xml') return true
  return media.endsWith('+json') || media.endsWith('+xml')
}

/**
 * Wrap `res` so later `writeHead` / `write` / `end` gzip the body when allowed.
 * No-op when the request does not accept gzip. WebSocket upgrades must keep the raw `res`.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {import('node:http').ServerResponse}
 */
export function wrapGzipResponse(req, res) {
  if (!acceptsGzip(req)) return res

  let decided = false
  /** @type {import('node:zlib').Gzip | undefined} */
  let gzip
  const writeSocket = res.write.bind(res)
  const endSocket = res.end.bind(res)
  const writeHeadSocket = res.writeHead.bind(res)

  const decide = () => {
    if (decided) return
    decided = true
    const status = res.statusCode
    if (status === 204 || status === 304 || req.method === 'HEAD') return
    const encoding = headerString(res, 'content-encoding')
    if (alreadyEncoded(encoding)) return
    if (!isCompressibleType(headerString(res, 'content-type'))) return
    const length = headerString(res, 'content-length')
    if (length !== '' && Number(length) < GZIP_MIN_BYTES) return
    res.removeHeader('content-length')
    res.setHeader('content-encoding', 'gzip')
    res.setHeader('vary', mergeVary(headerString(res, 'vary'), 'accept-encoding'))
    gzip = createGzip()
    let finished = false
    gzip.on('data', (chunk) => {
      if (!writeSocket(chunk)) gzip?.pause()
    })
    gzip.on('end', () => {
      finished = true
      endSocket()
    })
    gzip.on('error', (error) => {
      if (!finished) res.destroy(error)
    })
    // The /api bridge keys backpressure on write()'s return and waits on res 'drain'.
    // A false gzip.write() can reflect zlib's own buffer while the socket still has
    // room, so gzip's drain must wake the bridge too.
    gzip.on('drain', () => { res.emit('drain') })
    res.on('drain', () => { gzip?.resume() })
    res.on('close', () => {
      if (!finished && gzip !== undefined && !gzip.destroyed) gzip.destroy()
    })
  }

  res.writeHead = function writeHead(status, messageOrHeaders, maybeHeaders) {
    res.statusCode = status
    const message = typeof messageOrHeaders === 'string' ? messageOrHeaders : undefined
    const headers = typeof messageOrHeaders === 'string' ? maybeHeaders : messageOrHeaders
    applyOutgoingHeaders(res, headers)
    decide()
    if (message === undefined) return writeHeadSocket(status)
    return writeHeadSocket(status, message)
  }

  res.write = function write(chunk, encoding, callback) {
    decide()
    if (gzip === undefined) return writeSocket(chunk, encoding, callback)
    if (gzip.destroyed) {
      if (typeof encoding === 'function') encoding()
      else if (typeof callback === 'function') callback()
      return false
    }
    return gzip.write(chunk, encoding, callback)
  }

  res.end = function end(chunk, encoding, callback) {
    decide()
    if (gzip === undefined) return endSocket(chunk, encoding, callback)
    const done = typeof chunk === 'function' ? chunk
      : typeof encoding === 'function' ? encoding
        : typeof callback === 'function' ? callback
          : undefined
    if (gzip.destroyed) {
      done?.()
      return res
    }
    if (typeof chunk === 'function' || chunk === undefined || chunk === null) gzip.end()
    else gzip.end(chunk, typeof encoding === 'function' ? undefined : encoding)
    if (done !== undefined) gzip.once('end', done)
    return res
  }

  if (typeof res.flushHeaders === 'function') {
    const flush = res.flushHeaders.bind(res)
    res.flushHeaders = function flushHeaders() {
      decide()
      return flush()
    }
  }

  return res
}

/**
 * @param {string} contentType
 */
function mediaTypeOf(contentType) {
  return contentType.split(';', 1)[0].trim().toLowerCase()
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} name
 */
function headerString(res, name) {
  const value = res.getHeader(name)
  if (value === undefined) return ''
  return Array.isArray(value) ? value.join(',') : String(value)
}

/**
 * @param {string} encoding
 */
function alreadyEncoded(encoding) {
  const trimmed = encoding.trim().toLowerCase()
  return trimmed.length > 0 && trimmed !== 'identity'
}

/**
 * @param {string} existing
 * @param {string} token
 */
function mergeVary(existing, token) {
  if (existing === '') return token
  const parts = existing.split(',').map(part => part.trim().toLowerCase())
  if (parts.includes(token.toLowerCase())) return existing
  return `${existing}, ${token}`
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').OutgoingHttpHeaders | readonly string[] | readonly (readonly string[])[] | undefined} headers
 */
function applyOutgoingHeaders(res, headers) {
  if (headers === undefined || headers === null) return
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length >= 2) res.setHeader(String(entry[0]), entry[1])
      }
      return
    }
    for (let index = 0; index + 1 < headers.length; index += 2) {
      res.setHeader(String(headers[index]), headers[index + 1])
    }
    return
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) res.setHeader(name, value)
  }
}

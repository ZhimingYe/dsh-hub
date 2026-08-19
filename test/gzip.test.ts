import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import { acceptsGzip, isCompressibleType, wrapGzipResponse } from '../webserver-unix/src/gzip.js'

const LARGE_JSON = JSON.stringify({ events: Array.from({ length: 40 }, (_, seq) => ({
  type: 'assistant/message',
  seq,
  text: 'history-line '.repeat(8),
})) })

test('acceptsGzip reads gzip and star, and honors q=0', () => {
  assert.equal(acceptsGzip({ headers: {} } as http.IncomingMessage), false)
  assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'identity' } } as http.IncomingMessage), false)
  assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'gzip;q=0' } } as http.IncomingMessage), false)
  assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'gzip, deflate' } } as http.IncomingMessage), true)
  assert.equal(acceptsGzip({ headers: { 'accept-encoding': '*' } } as http.IncomingMessage), true)
  assert.equal(acceptsGzip({ headers: { 'accept-encoding': 'GZIP' } } as http.IncomingMessage), true)
  assert.equal(acceptsGzip({ headers: { 'accept-encoding': ['br', 'gzip'] } } as http.IncomingMessage), true)
})

test('isCompressibleType covers workstation JSON and script, not zip or SSE', () => {
  assert.equal(isCompressibleType('application/json; charset=utf-8'), true)
  assert.equal(isCompressibleType('text/javascript; charset=utf-8'), true)
  assert.equal(isCompressibleType('text/html'), true)
  assert.equal(isCompressibleType('image/svg+xml'), true)
  assert.equal(isCompressibleType('text/event-stream'), false)
  assert.equal(isCompressibleType('application/zip'), false)
  assert.equal(isCompressibleType('application/octet-stream'), false)
  assert.equal(isCompressibleType(''), false)
})

test('wrapGzipResponse gzips JSON when Accept-Encoding includes gzip', async () => {
  const { origin, close } = await listen((req, res) => {
    const out = wrapGzipResponse(req, res)
    out.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(LARGE_JSON)),
    })
    out.end(LARGE_JSON)
  })
  try {
    const raw = await rawGet(origin, '/', { 'accept-encoding': 'gzip' })
    assert.equal(raw.status, 200)
    assert.equal(raw.headers['content-encoding'], 'gzip')
    assert.equal(raw.headers['content-length'], undefined)
    assert.match(String(raw.headers.vary), /accept-encoding/i)
    assert.equal(gunzipSync(raw.body).toString('utf8'), LARGE_JSON)
    assert.ok(raw.body.length < Buffer.byteLength(LARGE_JSON))
  } finally {
    await close()
  }
})

test('wrapGzipResponse leaves the body uncompressed without Accept-Encoding', async () => {
  const { origin, close } = await listen((req, res) => {
    const out = wrapGzipResponse(req, res)
    out.writeHead(200, { 'content-type': 'application/json' })
    out.end(LARGE_JSON)
  })
  try {
    const raw = await rawGet(origin, '/', {})
    assert.equal(raw.headers['content-encoding'], undefined)
    assert.equal(raw.body.toString('utf8'), LARGE_JSON)
  } finally {
    await close()
  }
})

test('wrapGzipResponse does not gzip zip, SSE, or already-encoded bodies', async () => {
  const payload = 'x'.repeat(512)
  const { origin, close } = await listen((req, res) => {
    const out = wrapGzipResponse(req, res)
    const url = req.url ?? '/'
    if (url === '/zip') {
      out.writeHead(200, { 'content-type': 'application/zip' })
      out.end(payload)
      return
    }
    if (url === '/sse') {
      out.writeHead(200, { 'content-type': 'text/event-stream' })
      out.end(payload)
      return
    }
    out.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' })
    out.end(payload)
  })
  try {
    for (const path of ['/zip', '/sse', '/br']) {
      const raw = await rawGet(origin, path, { 'accept-encoding': 'gzip' })
      assert.notEqual(raw.headers['content-encoding'], 'gzip', path)
      assert.equal(raw.body.toString('utf8'), payload)
    }
  } finally {
    await close()
  }
})

test('wrapGzipResponse skips bodies smaller than GZIP_MIN_BYTES when Content-Length is set', async () => {
  const tiny = JSON.stringify({ ok: true })
  const { origin, close } = await listen((req, res) => {
    const out = wrapGzipResponse(req, res)
    out.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(tiny)),
    })
    out.end(tiny)
  })
  try {
    const raw = await rawGet(origin, '/', { 'accept-encoding': 'gzip' })
    assert.equal(raw.headers['content-encoding'], undefined)
    assert.equal(raw.body.toString('utf8'), tiny)
  } finally {
    await close()
  }
})

test('wrapGzipResponse does not advertise gzip on HEAD', async () => {
  const { origin, close } = await listen((req, res) => {
    wrapGzipResponse(req, res).writeHead(200, { 'content-type': 'application/json' })
    wrapGzipResponse(req, res).end()
  })
  try {
    const raw = await rawHead(origin, '/', { 'accept-encoding': 'gzip' })
    assert.equal(raw.headers['content-encoding'], undefined)
  } finally {
    await close()
  }
})

test('wrapGzipResponse gzips streamed writes after setHeader', async () => {
  const { origin, close } = await listen((req, res) => {
    const out = wrapGzipResponse(req, res)
    out.setHeader('content-type', 'application/json; charset=utf-8')
    out.write(LARGE_JSON.slice(0, 80))
    out.write(LARGE_JSON.slice(80))
    out.end()
  })
  try {
    const raw = await rawGet(origin, '/', { 'accept-encoding': 'gzip' })
    assert.equal(raw.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(raw.body).toString('utf8'), LARGE_JSON)
  } finally {
    await close()
  }
})

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected tcp address')
      resolve({
        origin: `http://127.0.0.1:${String(address.port)}`,
        close: () => new Promise((done) => { server.close(() => { done() }) }),
      })
    })
  })
}

function rawGet(
  origin: string,
  path: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, origin), { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => { chunks.push(chunk as Buffer) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
    }).on('error', reject)
  })
}

function rawHead(
  origin: string,
  path: string,
  headers: http.OutgoingHttpHeaders,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, origin), { method: 'HEAD', headers }, (res) => {
      res.resume()
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

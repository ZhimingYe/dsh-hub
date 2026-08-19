/**
 * ctx.webServer over a 0600 Unix socket. HTTP responses are gzip-compressed
 * when the client sends Accept-Encoding: gzip; WebSocket upgrades are not.
 */
import { createServer } from 'node:http'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ensurePrivateDirectory } from './private-dir.js'
import { wrapGzipResponse } from './gzip.js'

/**
 * @typedef {'exact' | 'prefix'} WebRouteKind
 * @typedef {{ kind: WebRouteKind, path: string, handler: Function }} WebRoute
 * @typedef {{ path: string, handler: Function }} WebUpgradeRoute
 * @typedef {{ socketPath: string }} Config
 */

export class WebServer extends Service {
  static Config = z.object({
    socketPath: z.string().required(),
  })

  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {Config} config */
  constructor(ctx, config) {
    super(ctx, 'webServer')
    this.config = config
    this.exact = new Map()
    this.prefixes = new Map()
    this.upgrades = new Map()
    this.upgradedSockets = new Set()
    this.indexTaps = []
    this.fallback = undefined
    this.server = undefined
    this.boundPath = config.socketPath
  }

  get port() {
    return 0
  }

  get host() {
    return '127.0.0.1'
  }

  get socketPath() {
    return this.boundPath
  }

  /** @param {WebRoute} route */
  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /** @param {WebUpgradeRoute} route */
  registerUpgrade(route) {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /** @param {WebRoute['handler']} handler */
  registerFallback(handler) {
    if (this.fallback !== undefined) {
      throw new Error('webserver: fallback already registered')
    }
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /** @param {(html: string) => string} transform */
  tapIndex(transform) {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  async [Service.init]() {
    const socketPath = this.config.socketPath
    if (socketPath.length === 0) throw new Error('webserver-unix: socketPath is empty')
    ensurePrivateDirectory(dirname(socketPath))
    if (existsSync(socketPath)) unlinkSync(socketPath)

    const handle = async (req, res) => {
      const out = wrapGzipResponse(req, res)
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = this.match(rawPath)
      if (route !== undefined) {
        await route.handler(req, out)
        return
      }
      const fallback = this.fallback
      if (fallback === undefined) {
        out.writeHead(404)
        out.end()
        return
      }
      await fallback(req, out)
    }

    this.server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)))
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(400)
        res.end()
      })
    })

    this.server.on('upgrade', (req, socket, head) => {
      const onError = (error) => {
        this.ctx.logger.warn(error)
        socket.destroy()
      }
      socket.on('error', onError)
      socket.once('close', () => {
        socket.off('error', onError)
        this.upgradedSockets.delete(socket)
      })
      let route
      try {
        route = this.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
        return
      }
      if (route === undefined) {
        socket.destroy()
        return
      }
      this.upgradedSockets.add(socket)
      try {
        Promise.resolve(route.handler(req, socket, head)).catch((error) => {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          socket.destroy()
        })
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        socket.destroy()
      }
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen({ path: socketPath }, () => {
        this.server.off('error', reject)
        this.server.on('error', (err) => { this.ctx.logger.error(err) })
        try {
          chmodSync(socketPath, 0o600)
        } catch (error) {
          this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        }
        this.boundPath = socketPath
        this.ctx.logger.info(`webserver listening on unix:${socketPath}`)
        resolve()
      })
    })

    this.ctx.effect(() => async () => {
      const serverClosed = new Promise((resolve) => {
        this.server.close(() => { resolve() })
      })
      this.server.closeAllConnections()
      const upgradedClosed = [...this.upgradedSockets].map(socket => new Promise((resolve) => {
        socket.once('close', () => { resolve() })
        socket.destroy()
      }))
      await Promise.all([serverClosed, ...upgradedClosed])
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath)
      } catch {
        // socket already gone
      }
    }, 'webServer.listen')
  }

  /** @param {string} pathname */
  match(pathname) {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /** @param {string} html */
  applyIndexTaps(html) {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }
}

export default WebServer

import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { readDashboardAsset, renderDashboardPage } from './server.js'

const bridgeReads = new Set(['/dashboard/data', '/health', '/summary'])

export function createMonitorServer({ bridgeUrl = process.env.BRIDGE_URL || 'http://127.0.0.1:7799' } = {}) {
  const bridge = new URL(bridgeUrl)
  if (!['http:', 'https:'].includes(bridge.protocol) || bridge.username || bridge.password ||
      bridge.pathname !== '/' || bridge.search || bridge.hash) {
    throw new Error('BRIDGE_URL must be an HTTP(S) origin without credentials, path, query, or fragment')
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Method not allowed')
      return
    }

    let requestUrl
    try {
      requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Invalid request URL')
      return
    }
    const pathname = requestUrl.pathname
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderDashboardPage())
      return
    }
    const asset = readDashboardAsset(pathname)
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.contentType })
      res.end(asset.body)
      return
    }
    if (!bridgeReads.has(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }

    try {
      // Build from the configured origin, never from request-supplied hosts or headers.
      const upstream = await fetch(new URL(pathname + requestUrl.search, bridge), {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      })
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res)
      else res.end()
    } catch {
      if (res.headersSent) {
        res.destroy()
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'bridge_unavailable' }))
      }
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) {
      throw new Error('Usage: npm run dev -- --port N')
    }
    const port = args.length ? Number(args[1]) : 7800
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be between 0 and 65535')
    const server = createMonitorServer()
    server.on('error', (error) => {
      console.error(error.message)
      process.exitCode = 1
    })
    server.listen(port, '127.0.0.1', () => {
      console.log(`AgentSwarm Monitor: http://127.0.0.1:${server.address().port}/dashboard`)
    })
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => server.close())
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

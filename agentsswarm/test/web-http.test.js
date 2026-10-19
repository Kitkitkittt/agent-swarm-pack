import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBridgeServer } from '../src/index.js'
import { loadConfig } from '../src/config.js'

test('shared monitor serves executable same-origin assets and live data on public HTTP routes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-web-'))
  const config = loadConfig({ BRIDGE_SECRET: 'web-secret', AGENTSSWARM_DATA_DIR: dir, DEFAULT_PROJECT_PATH: dir })
  const bridge = createBridgeServer({ config, bridgeState: {} })
  await bridge.start({ port: 0 })
  t.after(async () => { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  for (const route of ['/dashboard', '/dashboard/', '/api/dashboard']) {
    const response = await fetch(`${bridge.getListenUrl()}${route}`)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /AgentSwarm Monitor/)
    assert.match(html, /\/dashboard\/assets\/monitor\.js/)
    assert.match(html, /\/dashboard\/assets\/monitor\.css/)
    assert.doesNotMatch(html, /web-secret/)
  }
  for (const [route, mime] of [['monitor.js', /javascript/], ['monitor.css', /text\/css/]]) {
    const response = await fetch(`${bridge.getListenUrl()}/dashboard/assets/${route}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), mime)
    assert.ok((await response.text()).length > 100)
  }
  assert.equal((await fetch(`${bridge.getListenUrl()}/dashboard/assets/nope`)).status, 404)
  const response = await fetch(`${bridge.getListenUrl()}/dashboard/data?limit=1000`)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.tasks))
  assert.ok(Array.isArray(body.approvals))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBridgeServer } from '../src/index.js'
import { loadConfig } from '../src/config.js'

test('HTTP state survives restart and inert skills and schedules remain genuine', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-recovery-'))
  const config = loadConfig({ BRIDGE_SECRET: 'secret', AGENTSSWARM_DATA_DIR: dir, DEFAULT_PROJECT_PATH: dir })
  let bridge = createBridgeServer({ config, bridgeState: {} })
  await bridge.start({ port: 0 })
  t.after(async () => { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  const request = async (route, body) => {
    const response = await fetch(`${bridge.getListenUrl()}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': 'secret' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const task = await request('/tasks', { text: 'durable pending', projectPath: dir, requiresApproval: true })
  assert.equal(task.status, 200)
  const skill = await request('/skills/import', { id: 'review', name: 'Review', description: 'Review code', triggers: ['review'], content: '# Review\nInspect the code; this is inert text.' })
  assert.equal(skill.status, 200)
  const unsafe = await request('/skills/import', { id: '../escape', content: 'no' })
  assert.ok(unsafe.status >= 400)
  const privateUrl = await request('/skills/import', { url: 'https://127.0.0.1/private' })
  assert.ok(privateUrl.status >= 400)
  const schedule = await request('/schedules', { commandText: '# later', projectPath: dir, runAt: new Date(Date.now() + 3600000).toISOString() })
  assert.equal(schedule.status, 200)
  await bridge.stop()
  bridge = createBridgeServer({ config, bridgeState: {} })
  await bridge.start({ port: 0 })
  assert.equal((await request(`/tasks/${task.body.task.id}`)).body.task.approvalStatus, 'pending')
  assert.equal((await request('/skills')).body.skills.length, 1)
  assert.equal((await request('/schedules')).body.schedules.length, 1)
  assert.equal((await request(`/tasks/${task.body.task.id}/run`, {})).status, 409)
})

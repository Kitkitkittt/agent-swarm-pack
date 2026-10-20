import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBridgeServer } from '../src/index.js'
import { loadConfig } from '../src/config.js'

async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-http-'))
  const config = loadConfig({ BRIDGE_SECRET: 'test-secret', TASK_EXECUTION_BACKEND: 'standalone', CONNECTOR_BACKEND: 'none', AGENTSSWARM_DATA_DIR: dir, DEFAULT_PROJECT_PATH: dir, STANDALONE_ALLOWED_PROJECT_ROOTS: dir, STANDALONE_TASK_RUNNER_COMMAND: process.execPath, STANDALONE_TASK_RUNNER_ARGS: JSON.stringify(['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("real-run-finished"))']), ...extra })
  const bridge = createBridgeServer({ config, bridgeState: {} })
  await bridge.start({ port: 0 })
  t.after(async () => { await bridge.stop(); await fs.rm(dir, { recursive: true, force: true }) })
  const request = async (route, body, secret = 'test-secret') => {
    const response = await fetch(`${bridge.getListenUrl()}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': secret }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  return { bridge, request, dir }
}

async function until(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('terminal state not observed')
}

test('standalone HTTP requires auth and approval before a real configured runner executes', async t => {
  const { request, dir } = await fixture(t)
  assert.equal((await request('/tasks', { text: 'run', projectPath: dir }, 'wrong')).status, 401)
  const created = await request('/tasks', { text: 'real task', projectPath: dir, requiresApproval: true })
  assert.equal(created.status, 200)
  assert.equal(created.body.runResult.started, false)
  const id = created.body.task.id
  assert.equal((await request(`/tasks/${id}/run`, {})).status, 409)
  const approved = await request(`/approvals/${created.body.approvalId}/approve`, {})
  assert.equal(approved.status, 200)
  assert.equal((await request(`/approvals/${created.body.approvalId}/approve`, {})).status, 409)
  const terminal = await until(() => request(`/tasks/${id}`), value => ['completed', 'failed'].includes(value.body.task?.status))
  assert.equal(terminal.body.task.status, 'completed')
  const runs = await request(`/tasks/${id}/runs`)
  assert.equal(runs.body.runs.length, 1)
  const detail = await request(`/runs/${runs.body.runs[0].id}`)
  assert.equal(detail.body.run.status, 'completed')
  assert.equal(detail.body.run.exitCode, 0)
  assert.doesNotMatch(JSON.stringify(detail.body), /real-run-finished|stdout|stderr|\/standalone-task-runs\//)
})

test('standalone HTTP rejects project escapes and keeps configured connector secrets private', async t => {
  const { request } = await fixture(t)
  const escaped = await request('/tasks', { text: 'escape', projectPath: os.tmpdir() })
  assert.ok(escaped.status >= 400)
  const connection = await request('/connections', { platform: 'telegram', channelId: 'channel', connectorId: 'connector', config: { botToken: 'private-token-value', chatId: 'chat' } })
  assert.equal(connection.status, 200)
  assert.doesNotMatch(JSON.stringify(connection.body), /private-token-value/)
  assert.doesNotMatch(JSON.stringify((await request('/connections')).body), /private-token-value/)
  assert.notEqual(connection.body.connection.status, 'connected')
})

test('standalone directive ingest stays local and monitor exposes real task state', async t => {
  const { request, dir } = await fixture(t)
  const ingested = await request('/ingest', { text: '$ local directive', projectPath: dir, platform: 'cli', accountId: 'local', channelId: 'terminal', connectorId: 'cli' })
  assert.equal(ingested.status, 200)
  const dashboard = await request('/dashboard/data')
  assert.equal(dashboard.body.ok, true)
  assert.equal(dashboard.body.tasks.length, 1)
  assert.equal(dashboard.body.tasks[0].commandType, 'directive')
})

test('dashboard shows the twelve newest tasks regardless of priority', async t => {
  const { request, dir } = await fixture(t, { TASK_COMMAND_MODE: 'board_only' })
  const created = []
  for (let i = 0; i < 12; i++) {
    const response = await request('/tasks', { text: `old high priority ${i}`, projectPath: dir, priority: 'high' })
    assert.equal(response.status, 200)
    created.push(response.body.task.id)
  }
  const newest = await request('/tasks', { text: 'new normal priority', projectPath: dir, priority: 'normal' })
  assert.equal(newest.status, 200)

  const dashboard = await request('/dashboard/data')
  assert.equal(dashboard.body.tasks.length, 12)
  assert.equal(dashboard.body.tasks[0].id, newest.body.task.id)
  assert.ok(!dashboard.body.tasks.some(task => task.id === created[0]))
  assert.equal((await request('/tasks?limit=100')).body.tasks[0].priority, 'high')
})

test('configured timeout is terminal and board-only ingest does not execute', async t => {
  const { request, dir } = await fixture(t, { TASK_COMMAND_MODE: 'board_only', STANDALONE_TASK_RUNNER_TIMEOUT_MS: '50', STANDALONE_TASK_RUNNER_ARGS: JSON.stringify(['-e', 'setInterval(()=>{},1000)']) })
  const ingested = await request('/ingest', { text: '# queued', projectPath: dir, platform: 'cli', channelId: 'terminal', connectorId: 'cli' })
  assert.equal(ingested.status, 200)
  assert.equal((await request(`/tasks/${ingested.body.taskId}/runs`)).body.runs.length, 0)
  assert.equal((await request(`/tasks/${ingested.body.taskId}/run`, {})).status, 200)
  const terminal = await until(() => request(`/tasks/${ingested.body.taskId}`), value => value.body.task?.status === 'timed_out')
  assert.equal(terminal.body.task.status, 'timed_out')
})

test('successful runner result stays completed during supervisor cleanup past its deadline', async t => {
  const { request, dir } = await fixture(t, { STANDALONE_TASK_RUNNER_TIMEOUT_MS: '500' })
  const created = await request('/tasks', { text: 'complete before deadline', projectPath: dir })
  assert.equal(created.status, 200)
  const terminal = await until(() => request(`/tasks/${created.body.task.id}`), value => ['completed', 'failed', 'timed_out'].includes(value.body.task?.status))
  assert.equal(terminal.body.task.status, 'completed')
  const runs = await request(`/tasks/${created.body.task.id}/runs`)
  assert.equal(runs.body.runs[0].exitCode, 0)
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const bridgeModule = new URL('../src/index.js', import.meta.url).href
const configModule = new URL('../src/config.js', import.meta.url).href
const bridgeSource = `
  const { createBridgeServer } = await import(${JSON.stringify(bridgeModule)})
  const { loadConfig } = await import(${JSON.stringify(configModule)})
  const bridge = createBridgeServer({ config: loadConfig(process.env, { strict: false }) })
  await bridge.start({ port: 0 })
  process.send({ url: bridge.getListenUrl() })
  process.on('message', async (message) => {
    if (message === 'stop') { await bridge.stop(); process.exit(0) }
  })
`

async function startBridge(environment) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', bridgeSource], {
    env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', (data) => { output = `${output}${data}`.slice(-8192) })
  child.stderr.on('data', (data) => { output = `${output}${data}`.slice(-8192) })
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Bridge startup timed out: ${output}`)), 10000)
    child.once('message', (message) => { clearTimeout(timeout); resolve(message.url) })
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Bridge exited ${code}: ${output}`)) })
  }).catch((error) => { child.kill('SIGKILL'); throw error })
  return { child, url }
}

async function stopBridge(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (child.connected) child.send('stop')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(timeout) }
}

async function getTask(url, id) {
  const response = await fetch(`${url}/tasks/${id}`)
  assert.equal(response.status, 200)
  return (await response.json()).task
}

test('killing the bridge kills its runner and restart interrupts without replay', { timeout: 25000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-crash-http-'))
  const marker = path.join(directory, 'runner-completed')
  const runner = path.join(directory, 'runner.cjs')
  await fs.writeFile(runner, `
    const fs = require('node:fs')
    let brief = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { brief += chunk })
    process.stdin.on('end', () => {
      JSON.parse(brief)
      setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'completed'); process.exit(0) }, 3000)
    })
  `)
  const environment = {
    EXECUTION_BACKEND: 'standalone', CONNECTOR_BACKEND: 'standalone', BRIDGE_SECRET: 'crash-http-secret',
    AGENTSSWARM_DATA_DIR: path.join(directory, 'data'), AGENTSSWARM_ENV_FILE: path.join(directory, 'absent.env'),
    DEFAULT_PROJECT_PATH: directory, STANDALONE_ALLOWED_PROJECT_ROOTS: directory,
    STANDALONE_TASK_RUNNER_COMMAND: process.execPath, STANDALONE_TASK_RUNNER_ARGS: JSON.stringify([runner]),
    STANDALONE_TASK_RUNNER_TIMEOUT_MS: '10000', STATUS_RELAY_ENABLED: 'false', TASK_COMMAND_MODE: 'hybrid',
  }
  const children = []
  t.after(async () => {
    await Promise.all(children.map(stopBridge))
    await fs.rm(directory, { recursive: true, force: true })
  })
  const first = await startBridge(environment)
  children.push(first.child)
  const response = await fetch(`${first.url}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': 'crash-http-secret' },
    body: JSON.stringify({ text: 'Verify supervisor lifetime', projectPath: directory, runNow: true }),
  })
  assert.equal(response.status, 200)
  const created = await response.json()
  assert.equal(created.runResult.started, true)
  const taskId = created.task.id
  assert.equal((await getTask(first.url, taskId)).status, 'running')
  const firstExited = once(first.child, 'exit')
  first.child.kill('SIGKILL')
  await firstExited
  await delay(3500)
  await assert.rejects(fs.access(marker), { code: 'ENOENT' })

  const second = await startBridge(environment)
  children.push(second.child)
  assert.equal((await getTask(second.url, taskId)).status, 'interrupted')
  const runsResponse = await fetch(`${second.url}/tasks/${taskId}/runs`)
  assert.equal(runsResponse.status, 200)
  const { runs } = await runsResponse.json()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'interrupted')
  for (const field of ['stdout', 'stderr', 'summary', 'error', 'artifacts']) assert.equal(Object.hasOwn(runs[0], field), false)
  await delay(3500)
  assert.equal((await getTask(second.url, taskId)).status, 'interrupted')
  const afterResponse = await fetch(`${second.url}/tasks/${taskId}/runs`)
  assert.equal((await afterResponse.json()).runs.length, 1)
  await assert.rejects(fs.access(marker), { code: 'ENOENT' })
})

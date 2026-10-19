import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const base = new URL(process.env.BRIDGE_URL || 'http://127.0.0.1:7801')
assert.ok(['http:', 'https:'].includes(base.protocol), 'BRIDGE_URL must be HTTP(S)')
const readyDeadline = performance.now() + 20_000
while (true) {
  try {
    const response = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
    break
  } catch (error) {
    if (performance.now() >= readyDeadline) throw error
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
const timings = []
const routes = ['/health', '/dashboard/data', '/summary']
for (let i = 0; i < 100; i++) {
  const started = performance.now()
  const response = await fetch(new URL(routes[i % routes.length], base), { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200, routes[i % routes.length])
  const body = await response.json()
  assert.equal(body.ok, true)
  if (routes[i % routes.length] === '/dashboard/data') {
    assert.ok(Array.isArray(body.tasks))
    assert.ok(Array.isArray(body.approvals))
  }
  timings.push(performance.now() - started)
}
timings.sort((a, b) => a - b)
const p95 = timings[94]
console.log(JSON.stringify({ requests: timings.length, errors: 0, p95_ms: p95, budget_ms: 1000, maximum_ms: timings.at(-1) }))
assert.ok(p95 < 1000, `local regression budget exceeded: p95=${p95.toFixed(2)}ms`)

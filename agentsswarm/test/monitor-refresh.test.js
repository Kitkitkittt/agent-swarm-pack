import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import vm from 'node:vm'

function setupMonitor() {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', className: '', disabled: false, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback },
      click() { this.listeners.click?.() },
      children: [], append(child) { this.children.push(child) },
      get firstElementChild() { return this.children[0] },
      replaceChildren(...children) { this.children = children },
    })
    return elements.get(id)
  }
  const requests = []
  const intervals = []
  const document = {
    getElementById: element,
    createElement: tag => ({ tag, textContent: '', className: '', children: [], append(child) { this.children.push(child) }, get firstElementChild() { return this.children[0] } }),
    createDocumentFragment: () => ({ append() {} }),
  }
  const context = {
    document,
    fetch: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
    setInterval: callback => intervals.push(callback),
    Date,
  }
  return { context, elements, requests, intervals }
}

function respond(request, total) {
  request.resolve({ ok: true, json: async () => ({
    summary: { standaloneTasks: { total }, approvals: {}, routes: {} },
    tasks: [], approvals: [],
  }) })
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('monitor skips overlapping refreshes and allows a new refresh after failure without clearing data', async () => {
  const source = await fs.readFile(new URL('../ui/public/monitor.js', import.meta.url), 'utf8')
  const { context, elements, requests, intervals } = setupMonitor()
  vm.runInNewContext(source, context)
  assert.equal(requests.length, 1)

  intervals[0]()
  elements.get('refresh-btn').click()
  assert.equal(requests.length, 1)

  respond(requests[0], 2)
  await flush()
  assert.equal(elements.get('status-text').textContent, 'Live')
  assert.equal(elements.get('refresh-btn').disabled, false)

  elements.get('refresh-btn').click()
  assert.equal(requests.length, 2)
  requests[1].reject(new Error('network down'))
  await flush()
  assert.equal(elements.get('tasks-total').textContent, '2')
  assert.equal(elements.get('status-text').textContent, 'Refresh failed')
  assert.equal(elements.get('refresh-btn').disabled, false)
  intervals[0]()
  assert.equal(requests.length, 3)
  respond(requests[2], 3)
  await flush()
  assert.equal(elements.get('tasks-total').textContent, '3')
})

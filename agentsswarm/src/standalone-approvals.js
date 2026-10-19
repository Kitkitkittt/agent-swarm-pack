import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveStandaloneApprovalFilePath } from './runtime-paths.js'
import { normalizeTaskPriority } from './task-fields.js'

const clone = (value) => structuredClone(value)
const statuses = new Set(['pending', 'approved', 'rejected'])

function load(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (state?.version !== 1 || !Array.isArray(state.approvals)
      || state.approvals.some((item) => !item?.id || !item.taskId || !statuses.has(item.status))
      || new Set(state.approvals.map((item) => item.id)).size !== state.approvals.length) {
      throw new Error('invalid approval state')
    }
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, approvals: [] }
    throw new Error(`Cannot load approval state ${file}: ${error.message}`, { cause: error })
  }
}

async function save(file, state) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`)
      await handle.sync()
    } finally { await handle.close() }
    await fs.promises.rename(temporary, file)
    const directory = await fs.promises.open(path.dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await fs.promises.rm(temporary, { force: true }) }
}

export function createStandaloneApprovalManager(config = {}) {
  const file = config.runtimePaths?.standaloneApprovalFile || resolveStandaloneApprovalFilePath()
  let state = load(file)
  let queue = Promise.resolve()
  let failure
  function mutate(change) {
    const operation = queue.then(async () => {
      if (failure) throw failure
      const next = clone(state)
      const result = change(next)
      try { await save(file, next) } catch (error) { failure = error; throw error }
      state = next
      return clone(result)
    })
    queue = operation.catch(() => {})
    return operation
  }
  function decide(id, status, options = {}) {
    return mutate((next) => {
      const approval = next.approvals.find((item) => item.id === id)
      if (!approval || approval.status !== 'pending') return { approval: approval || null, applied: false }
      Object.assign(approval, {
        status, updatedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
        decidedBy: String(options.decidedBy || options.approvedBy || '').trim(),
      })
      return { approval, applied: true }
    })
  }
  return {
    createApproval(input = {}) {
      if (!String(input.taskId || '').trim()) throw new Error('approval_task_id_required')
      return mutate((next) => {
        const now = new Date().toISOString()
        const approval = {
          id: randomUUID(), taskId: String(input.taskId), taskTitle: String(input.taskTitle || ''),
          taskDescription: String(input.taskDescription || ''), priority: normalizeTaskPriority(input.priority),
          rolePresetId: String(input.rolePresetId || ''), projectPath: String(input.projectPath || ''),
          taskCommandMode: String(input.taskCommandMode || ''), requestedBy: String(input.requestedBy || ''),
          status: 'pending', createdAt: now, updatedAt: now,
        }
        next.approvals.push(approval)
        return approval
      })
    },
    getApproval(id) { return clone(state.approvals.find((item) => item.id === id) || null) },
    listApprovals({ status, query, taskId, limit } = {}) {
      const search = String(query || '').toLowerCase()
      const approvals = state.approvals.filter((item) => (!status || item.status === status)
        && (!taskId || item.taskId === taskId)
        && (!search || `${item.id} ${item.taskTitle} ${item.taskDescription}`.toLowerCase().includes(search)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return clone(Number.isInteger(limit) && limit > 0 ? approvals.slice(0, limit) : approvals)
    },
    countApprovals() {
      const countsByStatus = { pending: 0, approved: 0, rejected: 0 }
      for (const item of state.approvals) countsByStatus[item.status]++
      return { total: state.approvals.length, countsByStatus, ...countsByStatus }
    },
    approveApproval: (id, options) => decide(id, 'approved', options),
    rejectApproval: (id, options) => decide(id, 'rejected', options),
  }
}

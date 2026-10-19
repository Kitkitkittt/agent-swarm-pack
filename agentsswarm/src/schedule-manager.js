import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveScheduleFilePath } from './runtime-paths.js'

const clone = (value) => structuredClone(value)
const now = () => new Date().toISOString()
const statuses = new Set(['scheduled', 'running', 'completed', 'failed', 'interrupted', 'missed', 'disabled'])
function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }) }

function cadence(input) {
  const hasRunAt = input.runAt !== undefined && input.runAt !== null && input.runAt !== ''
  const hasInterval = input.intervalMs !== undefined && input.intervalMs !== null
  if (hasRunAt === hasInterval) throw invalid('schedule_requires_runAt_or_intervalMs')
  if (hasRunAt) {
    if (typeof input.runAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.runAt) || !Number.isFinite(Date.parse(input.runAt))) throw invalid('schedule_runAt_invalid')
    return { runAt: new Date(input.runAt).toISOString(), intervalMs: null }
  }
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0) throw invalid('schedule_intervalMs_invalid')
  if (!Number.isFinite(new Date(Date.now() + input.intervalMs).getTime())) throw invalid('schedule_intervalMs_invalid')
  return { runAt: null, intervalMs: input.intervalMs }
}

function load(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (state?.version !== 1 || !Array.isArray(state.schedules)
      || state.schedules.some((item) => !item?.id || !item.commandText || !statuses.has(item.status)
        || typeof item.enabled !== 'boolean' || (item.nextRunAt !== null && !Number.isFinite(Date.parse(item.nextRunAt))))
      || new Set(state.schedules.map((item) => item.id)).size !== state.schedules.length) throw new Error('invalid schedule state')
    for (const item of state.schedules) cadence(item)
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, schedules: [] }
    throw new Error(`Cannot load schedule state ${file}: ${error.message}`, { cause: error })
  }
}

async function save(file, state) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    await fs.promises.rename(temporary, file)
    const directory = await fs.promises.open(path.dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await fs.promises.rm(temporary, { force: true }) }
}

export function createScheduleManager(config = {}, { stateFile, onTrigger } = {}) {
  const file = stateFile || config.runtimePaths?.scheduleFile || resolveScheduleFilePath()
  if (typeof onTrigger !== 'function') throw invalid('schedule_onTrigger_required')
  let state = load(file)
  let started = false
  let timer
  let failure
  let changed = false
  const active = new Map()
  for (const schedule of state.schedules) {
    if (schedule.status === 'running') {
      Object.assign(schedule, { status: 'interrupted', lastError: 'runtime_restarted', updatedAt: now() })
      changed = true
    }
    if (schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= Date.now()) {
      if (schedule.intervalMs) schedule.nextRunAt = new Date(Date.now() + schedule.intervalMs).toISOString()
      else Object.assign(schedule, { nextRunAt: null, status: 'missed', enabled: false })
      changed = true
    }
  }
  let queue = Promise.resolve().then(async () => { if (changed) await save(file, state) })
    .catch((error) => { failure = error })
  function serialize(operation) {
    const result = queue.then(() => {
      if (failure) throw failure
      return operation()
    })
    queue = result.catch(() => {})
    return result
  }
  async function commit(next) {
    try { await save(file, next) } catch (error) { failure = error; throw error }
    state = next
    arm()
  }
  function arm() {
    clearTimeout(timer)
    if (!started || failure) return
    const due = state.schedules.filter((item) => item.enabled && item.nextRunAt && !active.has(item.id))
      .map((item) => Date.parse(item.nextRunAt))
    if (!due.length) return
    timer = setTimeout(() => {
      serialize(async () => {
        if (!started) return
        for (const schedule of state.schedules) {
          if (schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= Date.now() && !active.has(schedule.id)) await dispatch(schedule.id)
        }
        arm()
      }).catch((error) => { failure = error; clearTimeout(timer) })
    }, Math.min(2147483647, Math.max(0, Math.min(...due) - Date.now())))
    timer.unref()
  }
  async function dispatch(id) {
    const schedule = state.schedules.find((item) => item.id === id)
    if (!schedule) return null
    if (active.has(id)) return { completion: active.get(id) }
    const next = clone(state)
    const updated = next.schedules.find((item) => item.id === id)
    const timestamp = now()
    Object.assign(updated, { status: 'running', lastRunAt: timestamp, updatedAt: timestamp,
      nextRunAt: updated.enabled && updated.intervalMs ? new Date(Date.now() + updated.intervalMs).toISOString() : null })
    await commit(next)
    // ponytail: in-process trigger ownership; use a leased coordinator if multiple bridge processes share this file.
    let release
    const completion = new Promise((resolve) => { release = resolve })
    active.set(id, completion)
    Promise.resolve().then(() => onTrigger(clone(updated))).then(
      (result) => ({ ok: result?.ok !== false, result: result ?? null, error: result?.ok === false ? String(result.error || 'schedule_trigger_failed') : '' }),
      (error) => ({ ok: false, result: null, error: String(error.message || error) }),
    ).then((outcome) => serialize(async () => {
      const finalState = clone(state)
      const current = finalState.schedules.find((item) => item.id === id)
      if (!current) return null
      Object.assign(current, { status: outcome.ok ? 'completed' : 'failed', lastResult: outcome.result,
        lastError: outcome.error, lastFinishedAt: now(), updatedAt: now() })
      if (current.intervalMs && current.enabled) current.nextRunAt = new Date(Date.now() + current.intervalMs).toISOString()
      else Object.assign(current, { enabled: false, nextRunAt: null })
      await commit(finalState)
      return clone(current)
    })).then(release, (error) => { failure = error; release(null) }).finally(() => {
      active.delete(id)
      arm()
    })
    // Do not await trigger completion while holding the persistence queue.
    return { completion }
  }
  function scheduleInput(body, previous) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('schedule_body_invalid')
    const merged = { ...previous, ...clone(body) }
    if (Object.hasOwn(body, 'runAt') && !Object.hasOwn(body, 'intervalMs')) merged.intervalMs = null
    if (Object.hasOwn(body, 'intervalMs') && !Object.hasOwn(body, 'runAt')) merged.runAt = null
    const timing = cadence(merged)
    const commandText = String(merged.commandText || '').trim()
    if (!commandText) throw invalid('schedule_command_text_required')
    if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') throw invalid('schedule_enabled_invalid')
    const enabled = merged.enabled ?? true
    const nextRunAt = enabled ? timing.runAt || new Date(Date.now() + timing.intervalMs).toISOString() : null
    if (enabled && timing.runAt && Date.parse(timing.runAt) <= Date.now()) throw invalid('schedule_runAt_must_be_future')
    const fields = {}
    for (const key of ['name', 'projectPath', 'providerProfileId', 'providerModel', 'fallbackProviderProfileId', 'rolePresetId', 'compactPackKey']) fields[key] = String(merged[key] || '').trim()
    if (merged.activePackRoles !== undefined && (!Array.isArray(merged.activePackRoles) || merged.activePackRoles.some((role) => typeof role !== 'string'))) throw invalid('schedule_activePackRoles_invalid')
    return { ...fields, commandText, ...timing, enabled, nextRunAt, activePackRoles: merged.activePackRoles || [] }
  }
  return {
    listSchedules() { return clone(state.schedules) },
    countSchedules() {
      const countsByStatus = {}
      for (const item of state.schedules) countsByStatus[item.status] = (countsByStatus[item.status] || 0) + 1
      return { total: state.schedules.length, enabled: state.schedules.filter((item) => item.enabled).length, active: active.size, countsByStatus }
    },
    createSchedule(body) {
      return serialize(async () => {
        const input = scheduleInput(body)
        const schedule = { ...input, id: randomUUID(), status: input.enabled ? 'scheduled' : 'disabled', createdAt: now(), updatedAt: now(), lastRunAt: null, lastResult: null, lastError: '' }
        const next = clone(state)
        next.schedules.push(schedule)
        await commit(next)
        return clone(schedule)
      })
    },
    updateSchedule(id, body) {
      return serialize(async () => {
        const next = clone(state)
        const schedule = next.schedules.find((item) => item.id === id)
        if (!schedule) return null
        if (active.has(id)) throw invalid('schedule_running')
        const input = scheduleInput(body, schedule)
        Object.assign(schedule, input, { status: input.enabled ? 'scheduled' : 'disabled', updatedAt: now() })
        await commit(next)
        return clone(schedule)
      })
    },
    deleteSchedule(id) {
      return serialize(async () => {
        if (active.has(id)) throw invalid('schedule_running')
        if (!state.schedules.some((item) => item.id === id)) return false
        const next = clone(state)
        next.schedules = next.schedules.filter((item) => item.id !== id)
        await commit(next)
        return true
      })
    },
    async runScheduleNow(id) {
      const result = await serialize(() => dispatch(id))
      return result?.completion ? result.completion : result
    },
    start() {
      if (started) return
      started = true
      serialize(async () => {
        const next = clone(state)
        for (const schedule of next.schedules) {
          if (!schedule.nextRunAt || Date.parse(schedule.nextRunAt) > Date.now()) continue
          if (schedule.intervalMs) schedule.nextRunAt = new Date(Date.now() + schedule.intervalMs).toISOString()
          else Object.assign(schedule, { nextRunAt: null, enabled: false, status: 'missed' })
        }
        await commit(next)
      }).catch((error) => { failure = error; clearTimeout(timer) })
    },
    async stop() {
      started = false
      clearTimeout(timer)
      await queue
      await Promise.all(active.values())
      await queue
      if (failure) throw failure
    },
  }
}

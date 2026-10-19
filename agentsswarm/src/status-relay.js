import { listAgentsswarmTasks, sendConnectorUpdate } from './forwarder.js'
import { logInfo, logWarn } from './logger.js'

const TERMINAL_STATUSES = new Set(['done', 'completed', 'cancelled', 'failed', 'error', 'timed_out', 'interrupted'])

function toStage(status) {
  if (status === 'review') return 'Reviewing'
  if (status === 'done') return 'Completed'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'failed' || status === 'error') return 'Failed'
  if (status === 'collaborating' || status === 'in_progress') return 'Building'
  if (status === 'planned' || status === 'pending' || status === 'inbox') return 'Planning'
  if (!status) return 'Planning'
  return status.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function taskRouteKey(task) {
  const projectPath = typeof task.project_path === 'string' ? task.project_path.trim() : ''
  return projectPath
}

export function createStatusRelay(params) {
  const {
    config,
    resolveRouteForTask,
    shouldRelayTask,
    getLastStatus,
    setLastStatus,
    listTasks = listAgentsswarmTasks,
    sendUpdate = sendConnectorUpdate,
    hasManagedTasks,
    onTerminalTask,
    getManagedTaskIds,
  } = params
  let timer = null
  let inFlightTick = null

  async function tick() {
    if (config.statusRelayManagedOnly && typeof hasManagedTasks === 'function' && !hasManagedTasks()) {
      return
    }

    const managedTaskIds = typeof getManagedTaskIds === 'function' ? getManagedTaskIds() : []
    const tasks = await listTasks(
      config,
      config.statusRelayManagedOnly && managedTaskIds.length > 0 ? { taskIds: managedTaskIds } : undefined,
    )
    for (const task of tasks) {
      if (!shouldRelayTask(task)) continue

      const id = typeof task.id === 'string' ? task.id : ''
      const status = typeof task.status === 'string' ? task.status : ''
      if (!id || !status) continue
      const prev = getLastStatus(id)
      if (prev === status) continue

      const route = resolveRouteForTask(taskRouteKey(task), id)
      if (!route?.connectorId || !route?.channelId) continue

      const title = typeof task.title === 'string' ? task.title : id
      const stage = toStage(status)
      const text = `[${stage}] ${title} (${id.slice(0, 8)})`
      try {
        await sendUpdate(config, route, text)
        setLastStatus(id, status)
        logInfo('status_relay_sent', {
          taskId: id,
          status,
          channelId: route.channelId,
          connectorId: route.connectorId,
        })
        if (TERMINAL_STATUSES.has(status) && typeof onTerminalTask === 'function') {
          await onTerminalTask(task, status)
        }
      } catch (err) {
        logWarn('status_relay_failed', {
          taskId: id,
          status,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  function runTick() {
    if (inFlightTick) return inFlightTick
    inFlightTick = tick().finally(() => {
      inFlightTick = null
    })
    return inFlightTick
  }

  function logTickError(err) {
    logWarn('status_relay_tick_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  function start() {
    if (!config.statusRelayEnabled || timer) return
    void runTick().catch(logTickError)
    timer = setInterval(() => {
      void runTick().catch(logTickError)
    }, config.statusRelayIntervalMs)
    timer.unref?.()
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return { start, stop, tick: runTick }
}

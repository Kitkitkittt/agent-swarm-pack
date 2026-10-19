import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getPackageRoot, resolveStandaloneTaskFilePath, resolveStandaloneTaskRunDir } from './runtime-paths.js'
import { normalizeTaskPriority, normalizeBooleanFlag } from './task-fields.js'

const MAX_OUTPUT = 1024 * 1024
const statuses = new Set(['queued', 'running', 'completed', 'failed', 'timed_out', 'interrupted'])
const priorities = { urgent: 3, high: 2, normal: 1, low: 0 }
const clone = (value) => structuredClone(value)
const now = () => new Date().toISOString()
function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }) }

function publicRun(run) {
  const result = {}
  for (const key of ['id', 'taskId', 'status', 'mode', 'createdAt', 'startedAt', 'finishedAt', 'exitCode', 'signal', 'outputTruncated']) {
    if (Object.hasOwn(run, key)) result[key] = run[key]
  }
  return result
}

function outputText(chunks) {
  const bytes = Buffer.concat(chunks)
  const validUtf8 = Buffer.from(bytes.toString('utf8'))
  return new TextDecoder().decode(validUtf8.subarray(0, bytes.length), { stream: true })
}

function load(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (state?.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.runs)
      || state.tasks.some((task) => !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(task?.id) || !statuses.has(task.status)
        || !Object.hasOwn(priorities, task.priority) || typeof task.projectPath !== 'string'
        || typeof task.approvalRequired !== 'boolean'
        || !['not_required', 'pending', 'approved', 'rejected'].includes(task.approvalStatus)
        || (task.approvalRequired && task.approvalStatus === 'not_required'))
      || state.runs.some((run) => !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(run?.id) || !statuses.has(run.status)
        || typeof run.stdout !== 'string' || typeof run.stderr !== 'string'
        || Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr) > MAX_OUTPUT
        || !state.tasks.some((task) => task.id === run.taskId))
      || new Set(state.tasks.map((task) => task.id)).size !== state.tasks.length
      || new Set(state.runs.map((run) => run.id)).size !== state.runs.length) throw new Error('invalid task state')
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, tasks: [], runs: [] }
    throw new Error(`Cannot load task state ${file}: ${error.message}`, { cause: error })
  }
}

async function writeAtomic(file, content) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await fs.promises.rename(temporary, file)
    const directory = await fs.promises.open(path.dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await fs.promises.rm(temporary, { force: true }) }
}
const writeJson = (file, value) => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`)

export function createStandaloneTaskManager(config = {}) {
  const stateFile = config.runtimePaths?.standaloneTaskFile || resolveStandaloneTaskFilePath()
  const runDir = config.runtimePaths?.standaloneTaskRunDir || resolveStandaloneTaskRunDir()
  const configuredRoots = config.standaloneAllowedProjectRoots || [config.defaultProjectPath || getPackageRoot()]
  if (!Array.isArray(configuredRoots)) throw invalid('allowed_project_roots_invalid')
  const roots = [...configuredRoots]
  const command = String(config.standaloneTaskRunnerCommand || '').trim()
  const args = config.standaloneTaskRunnerArgs || []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw invalid('runner_args_invalid')
  const runnerArgs = [...args]
  const timeoutMs = config.standaloneTaskRunnerTimeoutMs ?? 300000
  const concurrency = config.standaloneTaskRunnerConcurrency ?? 2
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw invalid('runner_timeout_invalid')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw invalid('runner_concurrency_invalid')
  if (!Array.isArray(roots) || !roots.length || roots.some((root) => typeof root !== 'string' || !root.trim())) throw invalid('allowed_project_roots_invalid')
  let state = load(stateFile)
  let failure
  let stopping = false
  const active = new Map()
  const recovered = []
  let recoveryChanged = false
  for (const task of state.tasks) {
    if (task.runRequested || task.status === 'running') recoveryChanged = true
    task.runRequested = false
    if (task.status === 'running') Object.assign(task, { status: 'interrupted', updatedAt: now() })
  }
  for (const run of state.runs) {
    if (run.status !== 'running') continue
    Object.assign(run, { status: 'interrupted', error: 'runtime_restarted', finishedAt: now() })
    recovered.push(run)
  }
  let queue = Promise.resolve().then(async () => {
    if (!recovered.length && !recoveryChanged) return
    for (const run of recovered) await terminalArtifacts(run)
    await writeJson(stateFile, state)
  }).catch((error) => { failure = error })
  function serialize(operation) {
    const result = queue.then(() => {
      if (failure) throw failure
      return operation()
    }).catch((error) => {
      if (error?.statusCode === 400) throw error
      throw new Error('task_runtime_unavailable')
    })
    queue = result.catch(() => {})
    return result
  }
  async function commit(next) {
    try { await writeJson(stateFile, next) } catch (error) { failure = error; throw error }
    state = next
  }
  async function cwdFor(projectPath) {
    let directory
    try { directory = await fs.promises.realpath(projectPath || config.defaultProjectPath || roots[0]) }
    catch { throw invalid('project_path_invalid') }
    if (!(await fs.promises.stat(directory)).isDirectory()) throw invalid('project_path_invalid')
    const allowed = await Promise.all(roots.map((root) => fs.promises.realpath(root)))
    if (!allowed.some((root) => {
      const relative = path.relative(root, directory)
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    })) throw invalid('project_path_outside_allowed_roots')
    return directory
  }
  function artifacts(id) {
    const directory = path.join(runDir, id)
    return { briefFile: path.join(directory, 'brief.json'), resultFile: path.join(directory, 'result.json'), logFile: path.join(directory, 'output.log') }
  }
  async function terminalArtifacts(run) {
    const files = artifacts(run.id)
    await writeAtomic(files.logFile, `${run.stdout || ''}${run.stderr ? `\n[stderr]\n${run.stderr}` : ''}`)
    await writeJson(files.resultFile, run)
  }
  function kill(entry, signal) {
    try {
      if (process.platform !== 'win32' && entry.child.pid) process.kill(-entry.child.pid, signal)
      else entry.child.kill(signal)
    } catch (error) { if (error.code !== 'ESRCH') entry.killError = error.message }
  }
  function terminate(entry, status, error) {
    if (!entry.terminalStatus) Object.assign(entry, { terminalStatus: status, terminalError: error })
    kill(entry, 'SIGTERM')
    if (!entry.killTimer) entry.killTimer = setTimeout(() => {
      kill(entry, 'SIGKILL')
      for (const stream of ['stdin', 'stdout', 'stderr']) entry.child?.[stream]?.destroy()
    }, 1000)
  }
  async function launch(taskId) {
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) return { started: false, reason: 'task_missing', task: null }
    const blocked = task.approvalRequired && task.approvalStatus !== 'approved'
    if (blocked) return { started: false, reason: task.approvalStatus === 'rejected' ? 'task_approval_rejected' : 'task_approval_pending', task: clone(task) }
    if (stopping) return { started: false, reason: 'runtime_stopped', task: clone(task) }
    if (task.status === 'running') return { started: false, reason: 'task_running', task: clone(task) }
    if (!command) return { started: false, reason: 'runner_not_configured', task: clone(task) }
    const cwd = await cwdFor(task.projectPath)
    const next = clone(state)
    const updatedTask = next.tasks.find((item) => item.id === taskId)
    if (active.size >= concurrency) {
      Object.assign(updatedTask, { status: 'queued', runRequested: true, updatedAt: now() })
      await commit(next)
      return { started: false, reason: 'concurrency_limit', task: clone(updatedTask) }
    }
    const run = {
      id: randomUUID(), taskId, status: 'running', mode: 'standalone', summary: '', error: '',
      createdAt: now(), startedAt: now(), finishedAt: null, stdout: '', stderr: '',
    }
    run.artifacts = artifacts(run.id)
    Object.assign(updatedTask, { status: 'running', runRequested: false, updatedAt: now(), lastRunId: run.id, projectPath: cwd })
    const brief = { ...clone(updatedTask), runId: run.id }
    await writeJson(run.artifacts.briefFile, brief)
    next.runs.push(run)
    await commit(next)
    let resolveDone
    const entry = { child: null, done: new Promise((resolve) => { resolveDone = resolve }), bytes: 0, stdout: [], stderr: [] }
    active.set(run.id, entry)
    let resolveStarted
    const started = new Promise((resolve) => { resolveStarted = resolve })
    let finished = false
    function finish(code, signal, spawnError) {
      if (finished) return
      finished = true
      clearTimeout(entry.timer)
      clearTimeout(entry.killTimer)
      if (entry.child) kill(entry, 'SIGKILL')
      resolveStarted({ started: false, reason: 'runner_spawn_failed', task: clone(updatedTask), run: publicRun(run) })
      const operation = serialize(async () => {
        const finalState = clone(state)
        const finalRun = finalState.runs.find((item) => item.id === run.id)
        const finalTask = finalState.tasks.find((item) => item.id === taskId)
        const stdout = outputText(entry.stdout)
        const stderr = outputText(entry.stderr)
        const status = entry.terminalStatus || (spawnError || code !== 0 ? 'failed' : 'completed')
        Object.assign(finalRun, {
          status, stdout, stderr, summary: stdout.trim() || stderr.trim(), exitCode: code, signal,
          error: entry.terminalError || (spawnError ? 'runner_spawn_failed' : code === 0 ? '' : `runner_exit_${code ?? signal}`),
          finishedAt: now(), outputTruncated: entry.bytes > MAX_OUTPUT,
        })
        Object.assign(finalTask, { status, updatedAt: now() })
        await terminalArtifacts(finalRun)
        await commit(finalState)
      })
      operation.catch((error) => { failure = error }).finally(() => {
        active.delete(run.id)
        resolveDone()
        if (!stopping && !failure) serialize(async () => {
          const waiting = state.tasks.filter((item) => item.runRequested && item.status === 'queued')
            .sort((a, b) => priorities[b.priority] - priorities[a.priority] || a.createdAt.localeCompare(b.createdAt))
          for (const item of waiting) {
            if (active.size >= concurrency) break
            await launch(item.id)
          }
        }).catch((error) => { failure = error })
      })
    }
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./runner-supervisor.js', import.meta.url))], {
        cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32', windowsHide: true,
      })
      entry.child = child
      child.on('message', (message) => {
        if (message?.type === 'started') resolveStarted({ started: true, task: clone(updatedTask), run: publicRun(run) })
        if (message?.type === 'spawn_error') entry.spawnError = new Error('runner_spawn_failed')
        if (message?.type === 'stdin_error') terminate(entry, 'failed', 'runner_stdin_error')
        if (message?.type === 'result') entry.result = { code: message.code, signal: message.signal }
      })
      child.once('error', () => { entry.spawnError = new Error('runner_spawn_failed') })
      child.once('close', (code, signal) => finish(entry.result ? entry.result.code : code, entry.result ? entry.result.signal : signal, entry.spawnError))
      child.send({ type: 'configure', command, args: runnerArgs, cwd }, (error) => {
        if (error) terminate(entry, 'failed', 'runner_supervisor_unavailable')
      })
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
        const available = Math.max(0, MAX_OUTPUT - entry.bytes)
        if (available) entry[stream].push(chunk.subarray(0, available))
        entry.bytes += chunk.length
        if (entry.bytes > MAX_OUTPUT) terminate(entry, 'failed', 'runner_output_limit_exceeded')
      })
      child.stdin.on('error', () => terminate(entry, 'failed', 'runner_stdin_error'))
      child.stdin.end(`${JSON.stringify(brief)}\n`)
      entry.timer = setTimeout(() => terminate(entry, 'timed_out', 'runner_timeout'), timeoutMs)
    } catch (error) { finish(null, null, error) }
    return started
  }
  return {
    createTask(input = {}) {
      return serialize(async () => {
        const text = String(input.text || '').trim()
        if (!text) throw invalid('task_text_required')
        const projectPath = await cwdFor(input.projectPath)
        const description = text.replace(/^[#$]\s*/, '')
        const approvalRequired = normalizeBooleanFlag(input.requiresApproval, false)
        const task = {
          ...clone(input), id: randomUUID(), text, title: description.split('\n')[0].slice(0, 160), description,
          commandType: input.commandType === 'directive' ? 'directive' : 'task',
          taskCommandMode: (input.taskCommandMode || config.taskCommandMode) === 'board_only' ? 'board_only' : 'hybrid', projectPath,
          status: 'queued', priority: normalizeTaskPriority(input.priority), approvalRequired,
          approvalStatus: approvalRequired ? 'pending' : 'not_required', approvalId: '',
          runRequested: false, createdAt: now(), updatedAt: now(),
        }
        const next = clone(state)
        next.tasks.push(task)
        await commit(next)
        return clone(task)
      })
    },
    setTaskApproval(id, patch = {}) {
      return serialize(async () => {
        const next = clone(state)
        const task = next.tasks.find((item) => item.id === id)
        if (!task) return null
        if (!['pending', 'approved', 'rejected'].includes(patch.approvalStatus)) throw invalid('task_approval_status_invalid')
        if (['approved', 'rejected'].includes(task.approvalStatus) && patch.approvalStatus !== task.approvalStatus) throw invalid('task_approval_terminal')
        if (task.approvalId && patch.approvalId !== task.approvalId) throw invalid('task_approval_id_mismatch')
        Object.assign(task, { approvalRequired: true, approvalStatus: patch.approvalStatus, approvalId: String(patch.approvalId || ''), updatedAt: now() })
        await commit(next)
        return clone(task)
      })
    },
    runTask(id) { return serialize(() => launch(id)) },
    getTask(id) { return clone(state.tasks.find((item) => item.id === id) || null) },
    listTasks({ status, commandType, priority, query, limit } = {}) {
      const search = String(query || '').toLowerCase()
      const tasks = state.tasks.filter((item) => (!status || item.status === status)
        && (!commandType || item.commandType === commandType) && (!priority || item.priority === priority)
        && (!search || `${item.id} ${item.title} ${item.description}`.toLowerCase().includes(search)))
        .sort((a, b) => priorities[b.priority] - priorities[a.priority] || b.createdAt.localeCompare(a.createdAt))
      return clone(Number.isInteger(limit) && limit > 0 ? tasks.slice(0, limit) : tasks)
    },
    countTasks() {
      const countsByStatus = {}, countsByType = {}, countsByPriority = {}
      for (const task of state.tasks) {
        countsByStatus[task.status] = (countsByStatus[task.status] || 0) + 1
        countsByType[task.commandType] = (countsByType[task.commandType] || 0) + 1
        countsByPriority[task.priority] = (countsByPriority[task.priority] || 0) + 1
      }
      return { total: state.tasks.length, countsByStatus, countsByType, countsByPriority,
        approvalsPending: state.tasks.filter((item) => item.approvalRequired && item.approvalStatus === 'pending').length,
        runnerConfigured: Boolean(command), activeRuns: active.size }
    },
    updateTaskPriority(id, priority) {
      return serialize(async () => {
        const next = clone(state)
        const task = next.tasks.find((item) => item.id === id)
        if (!task) return null
        Object.assign(task, { priority: normalizeTaskPriority(priority), updatedAt: now() })
        await commit(next)
        return clone(task)
      })
    },
    listRuns({ status, q, taskId, limit } = {}) {
      const search = String(q || '').toLowerCase()
      const runs = state.runs.filter((item) => (!status || item.status === status) && (!taskId || item.taskId === taskId)
        && (!search || `${item.id} ${item.taskId} ${item.status}`.toLowerCase().includes(search)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return clone((Number.isInteger(limit) && limit > 0 ? runs.slice(0, limit) : runs).map(publicRun))
    },
    getRun(id) {
      const run = state.runs.find((item) => item.id === id)
      return run ? clone({ run: publicRun(run), task: state.tasks.find((item) => item.id === run.taskId) }) : null
    },
    listTaskRuns(id) { return clone(state.runs.filter((item) => item.taskId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicRun)) },
    async stop() {
      stopping = true
      await queue
      const entries = [...active.values()]
      for (const entry of entries) terminate(entry, 'interrupted', 'runtime_stopped')
      await Promise.all(entries.map((entry) => entry.done))
      await queue
      if (failure) throw new Error('task_runtime_unavailable')
    },
  }
}

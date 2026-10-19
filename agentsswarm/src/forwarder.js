import { buildConnectorMessagePayload } from "./channels.js"
import { logInfo, logWarn } from "./logger.js"
import {
  buildDirectiveRequestBody,
  buildParallelTaskSet,
  buildTeamDelegationPlan,
  buildTaskCreateRequest,
  buildTaskRunRequest,
  createExecutionContext,
} from "./orchestrator.js"
import { resolveFailoverProfile } from "./providers.js"

const AUTH_CACHE_TTL_MS = 15 * 60 * 1000
const COMPACT_AGENT_CACHE_TTL_MS = 5 * 60 * 1000
const PROJECT_PAGE_SIZE = 50
const PROJECT_PAGE_LIMIT = 20
const TASK_ID_BATCH_SIZE = 100
const SESSION_COOKIE_NAME = "claw_session"
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])

const agentsswarmAuthCache = {
  token: "",
  fetchedAt: 0,
}

const compactAgentCache = {
  key: "",
  ids: [],
  fetchedAt: 0,
}

const projectLookupCache = new Map()

export function resetForwarderCaches() {
  agentsswarmAuthCache.token = ""
  agentsswarmAuthCache.fetchedAt = 0
  compactAgentCache.key = ""
  compactAgentCache.ids = []
  compactAgentCache.fetchedAt = 0
  projectLookupCache.clear()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shouldRetryRequest(method, attempt, maxAttempts, status) {
  if (attempt >= maxAttempts) return false
  if (String(method || "GET").toUpperCase() !== "GET") return false
  return RETRYABLE_STATUS_CODES.has(status)
}

function computeRetryDelay(config, attempt) {
  const baseDelayMs = Number(config?.httpRetryBaseDelayMs || 250)
  return baseDelayMs * Math.max(1, attempt)
}

function getCachedProjectEntry(config, requestedPath) {
  const key = `${config.agentsswarmApiUrl}|${requestedPath}`
  const cached = projectLookupCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.fetchedAt >= Number(config.projectPathCacheTtlMs || 0)) {
    projectLookupCache.delete(key)
    return null
  }
  return cached
}

function setCachedProjectEntry(config, requestedPath, project) {
  const key = `${config.agentsswarmApiUrl}|${requestedPath}`
  projectLookupCache.set(key, {
    project: project || null,
    fetchedAt: Date.now(),
  })
}

function toHeaderObject(headersInit) {
  const headers = new Headers(headersInit || undefined)
  return Object.fromEntries(headers.entries())
}

function buildAgentsswarmHeaders(config, options = {}) {
  const headers = { "Content-Type": "application/json" }
  if (options.includeInboxSecret) {
    headers["x-inbox-secret"] = config.inboxWebhookSecret
  }
  const authToken = String(options.authToken || "").trim() || config.agentsswarmAuthToken
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`
  }
  return headers
}

async function requestJson(url, init, options = {}) {
  const method = String(init?.method || "GET").toUpperCase()
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 1))
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20_000),
      })
      const contentType = resp.headers.get("content-type") || ""
      const body = contentType.includes("application/json")
        ? await resp.json().catch(() => null)
        : await resp.text().catch(() => "")
      const result = { ok: resp.ok, status: resp.status, body, headers: resp.headers }
      if (!shouldRetryRequest(method, attempt, maxAttempts, result.status)) {
        return result
      }
      logWarn("http_retry", {
        method,
        url,
        attempt,
        status: result.status,
      })
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts || method !== "GET") {
        throw err
      }
      logWarn("http_retry", {
        method,
        url,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    await sleep(computeRetryDelay(options.config, attempt))
  }

  if (lastError) throw lastError
  return { ok: false, status: 0, body: null, headers: new Headers() }
}

function parseSessionTokenFromSetCookie(rawHeader) {
  const header = String(rawHeader || "")
  if (!header) return ""
  const match = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))
  if (!match || !match[1]) return ""
  try {
    return decodeURIComponent(match[1]).trim()
  } catch {
    return String(match[1]).trim()
  }
}

function isCachedAuthValid() {
  if (!agentsswarmAuthCache.token) return false
  return Date.now() - agentsswarmAuthCache.fetchedAt < AUTH_CACHE_TTL_MS
}

async function bootstrapAgentsswarmSessionAuth(config, options = {}) {
  if (config.agentsswarmAuthToken) {
    return config.agentsswarmAuthToken
  }

  if (!options.forceRefresh && isCachedAuthValid()) {
    return agentsswarmAuthCache.token
  }

  const response = await requestJson(
    `${config.agentsswarmApiUrl}/api/auth/session`,
    {
      method: "GET",
    },
    {
      config,
      maxAttempts: config.httpRetryMaxAttempts,
    },
  )
  if (!response.ok) {
    throw new Error(`agentsswarm_auth_bootstrap_failed:http_${response.status}`)
  }

  const sessionToken = parseSessionTokenFromSetCookie(response.headers.get("set-cookie"))
  if (!sessionToken) {
    throw new Error("agentsswarm_auth_bootstrap_failed:missing_session_cookie")
  }

  agentsswarmAuthCache.token = sessionToken
  agentsswarmAuthCache.fetchedAt = Date.now()
  return sessionToken
}

async function requestAgentsswarmJson(config, path, init, options = {}) {
  const extraHeaders = toHeaderObject(init?.headers)

  const doRequest = async (forceAuthRefresh = false) => {
    let authToken = ""
    if (config.agentsswarmAuthToken) {
      authToken = config.agentsswarmAuthToken
    } else if (options.requireAuth) {
      authToken = await bootstrapAgentsswarmSessionAuth(config, { forceRefresh: forceAuthRefresh })
    } else if (isCachedAuthValid()) {
      authToken = agentsswarmAuthCache.token
    }

    return requestJson(
      `${config.agentsswarmApiUrl}${path}`,
      {
        ...init,
        headers: {
          ...buildAgentsswarmHeaders(config, {
            includeInboxSecret: options.includeInboxSecret,
            authToken,
          }),
          ...extraHeaders,
        },
      },
      {
        config,
        maxAttempts: options.maxAttempts || config.httpRetryMaxAttempts,
      },
    )
  }

  let response = await doRequest(false)

  if (
    response.status === 401 &&
    options.requireAuth &&
    !config.agentsswarmAuthToken
  ) {
    response = await doRequest(true)
  }

  return response
}

function buildCommandText(rawText) {
  return String(rawText || "").trim()
}

function stripCommandPrefix(text, prefix) {
  return String(text || "").trim().replace(new RegExp(`^\\${prefix}+\\s*`), "").trim()
}

function toProjectName(projectPath) {
  const normalized = String(projectPath || "").trim().replace(/[\\/]+$/, "")
  const base = normalized.split(/[\\/]/).pop() || "agentsswarm-project"
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "agentsswarm-project"
}

function extractTaskTitle(text) {
  const stripped = text.replace(/^#+\s*/, "").trim()
  if (!stripped) return "Manager task from chat"
  if (stripped.length <= 96) return stripped
  return `${stripped.slice(0, 93)}...`
}

function projectContextFromRecord(project, fallback) {
  if (typeof project?.core_goal === "string" && project.core_goal.trim()) {
    return project.core_goal.trim()
  }
  return fallback
}

function normalizeAgent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  if (!id) return null
  return {
    id,
    role: typeof raw.role === "string" ? raw.role.trim().toLowerCase() : "",
    departmentId: typeof raw.department_id === "string" ? raw.department_id.trim().toLowerCase() : "",
  }
}

function chooseCompactAgentIds(agents, limit) {
  if (!Array.isArray(agents) || agents.length <= 0 || limit <= 0) return []

  const normalized = agents
    .map(normalizeAgent)
    .filter(Boolean)

  const selected = []
  const seenIds = new Set()

  const addAgent = (agent) => {
    if (!agent || seenIds.has(agent.id)) return
    seenIds.add(agent.id)
    selected.push(agent.id)
  }

  addAgent(normalized.find((agent) => agent.departmentId === "planning" && agent.role === "team_leader"))

  const firstLeaderPerDept = new Set()
  for (const agent of normalized) {
    if (selected.length >= limit) break
    if (agent.role !== "team_leader") continue
    if (!agent.departmentId || firstLeaderPerDept.has(agent.departmentId)) continue
    firstLeaderPerDept.add(agent.departmentId)
    addAgent(agent)
  }

  const roleOrder = ["senior", "junior", "intern", "team_leader", ""]
  for (const role of roleOrder) {
    for (const agent of normalized) {
      if (selected.length >= limit) break
      if (role && agent.role !== role) continue
      addAgent(agent)
    }
    if (selected.length >= limit) break
  }

  return selected.slice(0, limit)
}

async function resolveCompactAgentIds(config) {
  const limit = Number(config.compactAgentLimit || 0)
  if (!Number.isFinite(limit) || limit <= 0) return []

  const key = `${config.agentsswarmApiUrl}|${limit}`
  if (
    compactAgentCache.key === key &&
    Date.now() - compactAgentCache.fetchedAt < COMPACT_AGENT_CACHE_TTL_MS
  ) {
    return compactAgentCache.ids
  }

  const response = await requestAgentsswarmJson(
    config,
    "/api/agents?include_seed=0",
    { method: "GET" },
    { requireAuth: true },
  )

  if (!response.ok || !Array.isArray(response.body?.agents)) {
    return []
  }

  const compactIds = chooseCompactAgentIds(response.body.agents, limit)
  compactAgentCache.key = key
  compactAgentCache.ids = compactIds
  compactAgentCache.fetchedAt = Date.now()
  return compactIds
}

async function maybeEnforceCompactProjectScope(config, project) {
  if (!config.enforceCompactProjectScope) return

  const projectId = typeof project?.id === "string" ? project.id.trim() : ""
  const limit = Number(config.compactAgentLimit || 0)
  if (!projectId || !Number.isFinite(limit) || limit <= 0) return

  const assignmentMode = typeof project?.assignment_mode === "string"
    ? project.assignment_mode.trim().toLowerCase()
    : ""

  const assignedAgentIds = Array.isArray(project?.assigned_agent_ids)
    ? project.assigned_agent_ids
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean)
    : []

  let targetAgentIds = []
  if (assignedAgentIds.length > limit) {
    targetAgentIds = assignedAgentIds.slice(0, limit)
  } else if (assignmentMode !== "manual") {
    targetAgentIds = assignedAgentIds.length > 0
      ? assignedAgentIds.slice(0, limit)
      : await resolveCompactAgentIds(config)
  }

  if (targetAgentIds.length <= 0) return

  const patch = await requestAgentsswarmJson(
    config,
    `/api/projects/${encodeURIComponent(projectId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        assignment_mode: "manual",
        agent_ids: targetAgentIds,
      }),
    },
    { requireAuth: true },
  )

  if (!patch.ok) {
    logWarn("compact_scope_update_skipped", {
      projectId,
      reason: extractErrorReason(patch),
    })
  }
}

function extractErrorReason(response) {
  if (typeof response.body === "object" && response.body && typeof response.body.error === "string") {
    return response.body.error
  }
  return `http_${response.status}`
}

function isRetryableResponse(response) {
  return !!response && RETRYABLE_STATUS_CODES.has(Number(response.status))
}

function recordProviderAttempt(config, profileId, startedAt, failed) {
  if (!config?.runtimeMetrics?.recordProviderRequest) return
  config.runtimeMetrics.recordProviderRequest({
    profileId,
    latencyMs: Date.now() - startedAt,
    failed,
  })
}

function recordProviderFailover(config) {
  config?.runtimeMetrics?.recordProviderFailover?.()
}

export async function forwardDirectiveToAgentsswarm(config, payload) {
  const text = buildCommandText(payload.text)
  const initialContext = createExecutionContext(config, {
    ...payload,
    text,
    commandType: "directive",
  })

  const projectBinding = await ensureProjectBinding(config, {
    projectPath: payload.projectPath,
    commandText: text,
  })

  let context = initialContext
  let response = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = Date.now()
    const body = buildDirectiveRequestBody(config, context, projectBinding, {
      ...payload,
      providerProfileId: context.providerProfile?.id,
      providerModel: context.providerModel,
      text,
    })

    response = await requestAgentsswarmJson(
      config,
      "/api/inbox",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      { includeInboxSecret: true },
    )

    recordProviderAttempt(config, context.providerProfile?.id, startedAt, !response.ok)
    if (response.ok) break

    const fallbackProfile = resolveFailoverProfile(context.failoverChain, context.providerProfile?.id, {
      status: response.status,
      retryableStatuses: [...RETRYABLE_STATUS_CODES],
    })
    if (!fallbackProfile || attempt >= 1 || !isRetryableResponse(response)) {
      const reason = extractErrorReason(response)
      throw new Error(`directive_forward_failed:${reason}`)
    }

    logWarn("provider_failover", {
      from: context.providerProfile?.id,
      to: fallbackProfile.id,
      reason: extractErrorReason(response),
      status: response.status,
    })
    recordProviderFailover(config)
    context = createExecutionContext(config, {
      ...payload,
      providerProfileId: fallbackProfile.id,
      providerModel: fallbackProfile.model,
      fallbackProviderProfileIds: (context.failoverChain || [])
        .map((profile) => profile.id)
        .filter((profileId) => profileId !== fallbackProfile.id),
      text,
      commandType: "directive",
    })
  }

  logInfo("directive_forwarded", {
    projectPath: projectBinding.projectPath,
    providerProfileId: context.providerProfile?.id,
    compactPackKey: context.compactPack?.key,
    channel: context.channel.key,
  })

  return {
    ackText: "Directive sent to manager swarm.",
    raw: response.body,
  }
}

export async function createAndRunTaskInAgentsswarm(config, payload) {
  const text = buildCommandText(payload.text)
  const mode = config.taskCommandMode || "hybrid"
  let context = createExecutionContext(config, {
    ...payload,
    text,
    commandType: "task",
  })

  const createRemoteTask = async (taskContext, taskText, options = {}) => {
    const createPayload = {
      ...buildTaskCreateRequest(taskContext, taskText, options),
      title: extractTaskTitle(taskText),
    }
    const created = await requestAgentsswarmJson(
      config,
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify(createPayload),
      },
      { requireAuth: true },
    )
    return {
      createPayload,
      created,
    }
  }

  const createRemoteTaskGraph = async (taskContext, cleanTaskText) => {
    if (taskContext.workMode === "team") {
      const plan = buildTeamDelegationPlan(taskContext, cleanTaskText)
      const tasks = []
      let parentTaskId = ""
      for (const step of plan) {
        const stepContext = createExecutionContext(config, {
          ...payload,
          text,
          commandType: "task",
          roleKey: step.roleKey,
          providerProfileId: step.providerProfileId,
        })
        const { createPayload, created } = await createRemoteTask(stepContext, step.taskText, {
          parentTaskId,
          delegationIndex: step.delegationIndex,
        })
        if (!created.ok || typeof created.body?.task?.id !== "string") {
          return { ok: false, created, createPayload }
        }
        const createdTaskId = created.body.task.id
        if (!parentTaskId) parentTaskId = createdTaskId
        tasks.push({
          id: createdTaskId,
          context: stepContext,
          createPayload,
        })
      }
      return { ok: true, tasks, parentTaskId }
    }

    if (taskContext.workMode === "parallel") {
      const taskSet = buildParallelTaskSet(taskContext, cleanTaskText)
      const tasks = []
      let parentTaskId = ""
      for (const step of taskSet) {
        const stepContext = createExecutionContext(config, {
          ...payload,
          text,
          commandType: "task",
          roleKey: step.roleKey,
          providerProfileId: step.providerProfileId,
        })
        const { createPayload, created } = await createRemoteTask(stepContext, step.taskText, {
          parentTaskId,
          delegationIndex: step.delegationIndex,
        })
        if (!created.ok || typeof created.body?.task?.id !== "string") {
          return { ok: false, created, createPayload }
        }
        const createdTaskId = created.body.task.id
        if (!parentTaskId) parentTaskId = createdTaskId
        tasks.push({
          id: createdTaskId,
          context: stepContext,
          createPayload,
        })
      }
      return { ok: true, tasks, parentTaskId }
    }

    const { createPayload, created } = await createRemoteTask(taskContext, cleanTaskText)
    if (!created.ok || typeof created.body?.task?.id !== "string") {
      return { ok: false, created, createPayload }
    }
    return {
      ok: true,
      tasks: [{
        id: created.body.task.id,
        context: taskContext,
        createPayload,
      }],
      parentTaskId: created.body.task.id,
    }
  }

  const cleanTaskText = stripCommandPrefix(text, "#")
  let graph = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = Date.now()
    graph = await createRemoteTaskGraph(context, cleanTaskText)
    const created = graph?.created || (graph?.ok ? { ok: true, status: 200 } : null)
    recordProviderAttempt(config, context.providerProfile?.id, startedAt, graph?.ok !== true)

    if (graph?.ok) break

    const fallbackProfile = resolveFailoverProfile(context.failoverChain, context.providerProfile?.id, {
      status: created?.status,
      retryableStatuses: [...RETRYABLE_STATUS_CODES],
    })
    if (!fallbackProfile || attempt >= 1 || !isRetryableResponse(created)) {
      const reason = extractErrorReason(created)
      throw new Error(`task_create_failed:${reason}`)
    }

    logWarn("provider_failover", {
      from: context.providerProfile?.id,
      to: fallbackProfile.id,
      reason: extractErrorReason(created),
      status: created.status,
    })
    recordProviderFailover(config)
    context = createExecutionContext(config, {
      ...payload,
      providerProfileId: fallbackProfile.id,
      providerModel: fallbackProfile.model,
      fallbackProviderProfileIds: (context.failoverChain || [])
        .map((profile) => profile.id)
        .filter((profileId) => profileId !== fallbackProfile.id),
      text,
      commandType: "task",
    })
  }
  const tasks = graph?.tasks || []
  const primaryTask = tasks[0]
  const taskId = primaryTask?.id

  if (mode === "board_only") {
    logInfo("task_registered", {
      taskId,
      projectPath: context.projectPath || null,
      providerProfileId: context.providerProfile?.id,
      compactPackKey: context.compactPack?.key,
      channel: context.channel.key,
      runStarted: false,
    })
    return {
      taskId,
      title: primaryTask?.createPayload?.title || extractTaskTitle(cleanTaskText),
      projectPath: context.projectPath || null,
      runStarted: false,
      ackText: tasks.length > 1
        ? `Task graph registered (${tasks.length} tasks, root ${taskId.slice(0, 8)}).`
        : `Task registered on board (${taskId.slice(0, 8)}) via ${context.compactPack?.key || "compact-pack"}.`,
    }
  }

  for (const taskEntry of tasks) {
    const runStartedAt = Date.now()
    const run = await requestAgentsswarmJson(
      config,
      `/api/tasks/${encodeURIComponent(taskEntry.id)}/run`,
      {
        method: "POST",
        body: JSON.stringify(buildTaskRunRequest(taskEntry.context)),
      },
      { requireAuth: true },
    )
    recordProviderAttempt(config, taskEntry.context.providerProfile?.id, runStartedAt, !run.ok)
    if (!run.ok) {
      const reason = extractErrorReason(run)
      throw new Error(`task_run_failed:${reason}`)
    }
  }

  logInfo("task_created_and_started", {
    taskId,
    projectPath: context.projectPath || null,
    providerProfileId: context.providerProfile?.id,
    compactPackKey: context.compactPack?.key,
    channel: context.channel.key,
  })

  return {
    taskId,
    title: primaryTask?.createPayload?.title || extractTaskTitle(cleanTaskText),
    projectPath: context.projectPath || null,
    runStarted: true,
    ackText: tasks.length > 1
      ? `Task graph registered and started (${tasks.length} tasks, root ${taskId.slice(0, 8)}).`
      : `Task registered and started (${taskId.slice(0, 8)}) via ${context.compactPack?.key || "compact-pack"}.`,
  }
}

export async function sendConnectorUpdate(config, route, text) {
  if (config.connectorBackend === 'none') return
  if (!route?.connectorId || !route?.channelId) return
  const response = await requestJson(
    `${config.swarmclawUrl}/api/connectors/${encodeURIComponent(route.connectorId)}/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Key": config.connectorApiKey || config.swarmclawAccessKey,
      },
      body: JSON.stringify(buildConnectorMessagePayload(route, text)),
    },
    {
      config,
      maxAttempts: config.httpRetryMaxAttempts,
    },
  )
  if (!response.ok) {
    const reason = typeof response.body === "object" && response.body && typeof response.body.error === "string"
      ? response.body.error
      : `http_${response.status}`
    throw new Error(`connector_send_failed:${reason}`)
  }
}

function normalizeTaskIds(taskIds) {
  if (!Array.isArray(taskIds)) return []
  return Array.from(
    new Set(
      taskIds
        .map((taskId) => (typeof taskId === "string" ? taskId.trim() : ""))
        .filter(Boolean),
    ),
  )
}

function chunkValues(values, size) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

export async function listAgentsswarmTasks(config, options = {}) {
  const taskIds = normalizeTaskIds(options.taskIds)
  if (options.taskIds && taskIds.length <= 0) {
    return []
  }

  if (taskIds.length > 0) {
    const collected = []
    for (const batch of chunkValues(taskIds, TASK_ID_BATCH_SIZE)) {
      const result = await requestAgentsswarmJson(
        config,
        `/api/tasks?ids=${encodeURIComponent(batch.join(","))}`,
        {
          method: "GET",
        },
        { requireAuth: true },
      )
      if (!result.ok || !Array.isArray(result.body?.tasks)) {
        return []
      }
      collected.push(...result.body.tasks)
    }
    return collected
  }

  const result = await requestAgentsswarmJson(
    config,
    "/api/tasks",
    {
      method: "GET",
    },
    { requireAuth: true },
  )
  if (!result.ok || !Array.isArray(result.body?.tasks)) {
    return []
  }
  return result.body.tasks
}

async function getProjectById(config, projectId) {
  const response = await requestAgentsswarmJson(
    config,
    `/api/projects/${encodeURIComponent(projectId)}`,
    {
      method: "GET",
    },
    { requireAuth: true, maxAttempts: config.httpRetryMaxAttempts },
  )

  if (!response.ok || !response.body?.project || typeof response.body.project !== "object") {
    return null
  }

  return response.body.project
}

async function findProjectByPath(config, requestedPath) {
  const cached = getCachedProjectEntry(config, requestedPath)
  if (cached) {
    return cached.project
  }

  let page = 1

  while (page <= PROJECT_PAGE_LIMIT) {
    const search = await requestAgentsswarmJson(
      config,
      `/api/projects?search=${encodeURIComponent(requestedPath)}&page=${page}&page_size=${PROJECT_PAGE_SIZE}`,
        {
          method: "GET",
        },
      { requireAuth: true, maxAttempts: config.httpRetryMaxAttempts },
    )

    if (!search.ok || !Array.isArray(search.body?.projects)) {
      return null
    }

    const exact = search.body.projects.find((project) => {
      const candidate = typeof project.project_path === "string" ? project.project_path.trim() : ""
      return candidate === requestedPath
    })
    if (exact && typeof exact.id === "string") {
      setCachedProjectEntry(config, requestedPath, exact)
      return exact
    }

    const totalPages = Number(search.body?.total_pages || 1)
    if (page >= totalPages) {
      break
    }

    page += 1
  }

  setCachedProjectEntry(config, requestedPath, null)
  return null
}

export async function ensureProjectBinding(config, params) {
  const requestedPath = String(params.projectPath || "").trim() || config.defaultProjectPath
  if (!requestedPath) {
    throw new Error("project_path_required_for_directive")
  }

  const fallbackContext = stripCommandPrefix(params.commandText || "", "$") || "Bridge directive context"
  const existingProject = await findProjectByPath(config, requestedPath)
  if (existingProject && typeof existingProject.id === "string") {
    await maybeEnforceCompactProjectScope(config, existingProject)
    setCachedProjectEntry(config, requestedPath, existingProject)
    return {
      projectId: existingProject.id,
      projectPath: requestedPath,
      projectContext: projectContextFromRecord(existingProject, fallbackContext),
    }
  }

  const compactAgentIds = await resolveCompactAgentIds(config)
  const createBody = {
    name: toProjectName(requestedPath),
    project_path: requestedPath,
    core_goal: fallbackContext,
    create_path_if_missing: true,
    ...(compactAgentIds.length > 0
      ? {
          assignment_mode: "manual",
          agent_ids: compactAgentIds,
        }
      : {}),
  }

  const create = await requestAgentsswarmJson(
    config,
    "/api/projects",
    {
      method: "POST",
      body: JSON.stringify(createBody),
    },
    { requireAuth: true },
  )

  if (
    create.status === 409 &&
    create.body?.error === "project_path_conflict" &&
    typeof create.body?.existing_project_id === "string"
  ) {
    const conflictedProject = await getProjectById(config, create.body.existing_project_id)
    if (conflictedProject && typeof conflictedProject.id === "string") {
      await maybeEnforceCompactProjectScope(config, conflictedProject)
      const resolvedProjectPath = typeof conflictedProject.project_path === "string" && conflictedProject.project_path.trim()
        ? conflictedProject.project_path.trim()
        : requestedPath
      setCachedProjectEntry(config, requestedPath, conflictedProject)
      setCachedProjectEntry(config, resolvedProjectPath, conflictedProject)
      return {
        projectId: conflictedProject.id,
        projectPath: resolvedProjectPath,
        projectContext: projectContextFromRecord(conflictedProject, fallbackContext),
      }
    }
  }

  if (!create.ok || typeof create.body?.project?.id !== "string") {
    const reason = extractErrorReason(create)
    throw new Error(`project_binding_failed:${reason}`)
  }

  setCachedProjectEntry(config, requestedPath, create.body.project)
  return {
    projectId: create.body.project.id,
    projectPath: requestedPath,
    projectContext: projectContextFromRecord(create.body.project, fallbackContext),
  }
}

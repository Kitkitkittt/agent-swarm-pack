import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAgentsTemplate, loadIdentityTemplate, loadSoulTemplate } from './agent-soul.js'
import { listChannelTemplates } from './channel-templates.js'
import { listSupportedPlatforms, normalizeChannelEnvelope, sanitizeRoute, toChannelRouteKey } from './channels.js'
import { listCompactPacks } from './compact-packs.js'
import { loadConfig } from './config.js'
import { createConnectorManager } from './connector-manager.js'
import { createAndRunTaskInAgentsswarm, forwardDirectiveToAgentsswarm } from './forwarder.js'
import { createRequestId, createTextPreview, logError, logInfo, logWarn } from './logger.js'
import { createRuntimeMetrics } from './metrics.js'
import { buildProviderSummary, discoverProviderModels, getOpenCodeStatus, listProviderModels } from './providers.js'
import { listRolePresets } from './role-presets.js'
import { listConnections, loadRuntimeSettings, saveRuntimeSettings, updateDefaults } from './runtime-settings.js'
import { createScheduleManager } from './schedule-manager.js'
import { loadSkillFromPath, loadSkillFromUrl, listLoadedSkills, matchSkillsToTask, saveLoadedSkill } from './skill-loader.js'
import { createStandaloneApprovalManager } from './standalone-approvals.js'
import { createStandaloneTaskManager } from './standalone-tasks.js'
import { createStatusRelay } from './status-relay.js'
import { loadBridgeState, saveBridgeState } from './state-store.js'
import { normalizeBooleanFlag, normalizeTaskPriority } from './task-fields.js'
import { renderDashboardPage, readDashboardAsset } from '../ui/server.js'

const MAX_TEXT_LENGTH = 4_000
const MAX_ROUTE_VALUE_LENGTH = 256
const MAX_ID_LENGTH = 160
const MAX_PROJECT_PATH_LENGTH = 1_024

const OFFICIAL_PROVIDER_PRESETS = [
  {
    id: 'opencode-go-direct',
    label: 'OpenCode Go Direct',
    description: 'Primary OpenCode with Codex and OpenRouter fallback chain.',
    baseUrl: 'https://api.opencode.ai/v1',
    defaults: {
      providerProfileId: 'opencode-cli',
      fallbackProviderProfileIds: ['codex-main', 'openrouter-fallback'],
    },
  },
  {
    id: 'bailian-coding-plan',
    label: 'Bailian Coding Plan',
    description: 'Bailian-oriented chain favoring Claude fallback for reviews.',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaults: {
      providerProfileId: 'claude-cli',
      fallbackProviderProfileIds: ['gemini-cli', 'openrouter-fallback'],
    },
  },
  {
    id: 'gemini-local-adapter',
    label: 'Gemini CLI Local Adapter',
    description: 'Gemini first with local fallback path for direct local runs.',
    baseUrl: 'local-cli',
    defaults: {
      providerProfileId: 'gemini-cli',
      fallbackProviderProfileIds: ['codex-main', 'openrouter-fallback'],
    },
  },
]

function json(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

function html(res, statusCode, content, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    ...headers,
  })
  res.end(content)
}

function requestWantsHtml(req) {
  const accept = String(req?.headers?.accept || '').toLowerCase()
  return accept.includes('text/html')
}


function createHttpError(statusCode, code) {
  const error = new Error(code)
  error.statusCode = statusCode
  error.code = code
  return error
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalize(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validateMaxLength(value, maxLength, code) {
  if (value && value.length > maxLength) {
    throw createHttpError(400, code)
  }
}

function validateAbsolutePath(projectPath) {
  if (!projectPath) return
  if (!path.isAbsolute(projectPath) && !path.win32.isAbsolute(projectPath)) {
    throw createHttpError(400, 'project_path_must_be_absolute')
  }
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ''))
  } catch {
    return ''
  }
}

function stripApiPrefix(pathname) {
  const normalized = String(pathname || '')
  if (normalized === '/api') return '/'
  if (normalized.startsWith('/api/')) {
    const withoutPrefix = normalized.slice(4)
    return withoutPrefix || '/'
  }
  return normalized || '/'
}

function parseConnectionKey(rawKey, defaults = {}) {
  const parts = String(rawKey || '').split('|')
  return {
    platform: parts[0] || defaults.defaultPlatform || 'telegram',
    accountId: parts[1] || defaults.defaultAccountId || 'primary',
    channelId: parts[2] && parts[2] !== '-' ? parts[2] : '',
    threadId: parts[3] && parts[3] !== '-' ? parts[3] : '',
  }
}

function normalizeFallbackChain(rawValue) {
  const values = Array.isArray(rawValue)
    ? rawValue
    : typeof rawValue === 'string'
      ? [rawValue]
      : []
  return Array.from(new Set(values.map((entry) => normalize(entry)).filter(Boolean)))
}

function normalizeStringArray(rawValue) {
  if (Array.isArray(rawValue)) {
    return Array.from(new Set(rawValue.map((entry) => normalize(entry)).filter(Boolean)))
  }
  return []
}

function normalizeEvaluateLoopInput(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return {
      enabled: false,
      maxTurns: 10,
      timeoutMs: 300000,
      approvalGate: false,
    }
  }
  return {
    enabled: rawValue.enabled === true,
    maxTurns: Math.min(Math.max(Number(rawValue.maxTurns || 10), 1), 20),
    timeoutMs: Math.min(Math.max(Number(rawValue.timeoutMs || 300000), 1000), 900000),
    approvalGate: rawValue.approvalGate === true,
  }
}

function normalizeModelOverrides(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return {}
  const normalized = {}
  for (const [profileId, model] of Object.entries(rawValue)) {
    const key = normalize(profileId)
    const value = normalize(model)
    if (!key || !value) continue
    normalized[key] = value
  }
  return normalized
}

function normalizeRoleRoutes(rawValue) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return {}
  const normalized = {}
  for (const [roleKey, route] of Object.entries(rawValue)) {
    const key = normalize(roleKey)
    if (!key || !route || typeof route !== 'object' || Array.isArray(route)) continue
    const fallbackProviderProfileIds = normalizeFallbackChain(
      route.fallbackProviderProfileIds?.length > 0
        ? route.fallbackProviderProfileIds
        : route.fallbackProviderProfileId,
    )
    normalized[key] = {
      providerProfileId: normalize(route.providerProfileId),
      providerModel: normalize(route.providerModel),
      fallbackProviderProfileId: normalize(route.fallbackProviderProfileId) || fallbackProviderProfileIds[0] || '',
      fallbackProviderProfileIds,
      soul: normalize(route.soul),
      identity: normalize(route.identity),
    }
  }
  return normalized
}

function normalizeCustomPreset(rawValue = {}) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null
  const id = normalize(rawValue.id)
  if (!id) return null
  const defaults = rawValue.defaults && typeof rawValue.defaults === 'object' && !Array.isArray(rawValue.defaults)
    ? rawValue.defaults
    : {}
  const fallbackProviderProfileIds = normalizeFallbackChain(
    defaults.fallbackProviderProfileIds?.length > 0
      ? defaults.fallbackProviderProfileIds
      : defaults.fallbackProviderProfileId,
  )
  return {
    id,
    label: normalize(rawValue.label) || id,
    description: normalize(rawValue.description),
    defaults: {
      providerProfileId: normalize(defaults.providerProfileId),
      providerModel: normalize(defaults.providerModel),
      fallbackProviderProfileId: normalize(defaults.fallbackProviderProfileId) || fallbackProviderProfileIds[0] || '',
      fallbackProviderProfileIds,
      compactPackKey: normalize(defaults.compactPackKey),
      rolePresetId: normalize(defaults.rolePresetId),
      taskCommandMode: normalize(defaults.taskCommandMode),
    },
    updatedAt: normalize(rawValue.updatedAt) || new Date().toISOString(),
  }
}

function normalizeCustomPresets(rawValue) {
  if (!Array.isArray(rawValue)) return []
  return rawValue
    .map((entry) => normalizeCustomPreset(entry))
    .filter(Boolean)
    .slice(0, 100)
}

function resolveDedupeKey(parsed) {
  if (!parsed.messageId) return ''
  return [parsed.commandType, parsed.route.key, parsed.messageId].join('|')
}

function hasExpired(timestamp, ttlMs, now) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false
  return now - timestamp >= ttlMs
}

export async function readBody(req, options = {}) {
  const chunks = []
  const maxBytes = Number(options.maxBytes || 64 * 1024)
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > maxBytes) {
      throw createHttpError(413, 'request_body_too_large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw createHttpError(400, 'invalid_json')
  }
}

export function detectCommandType(text, explicitType) {
  if (explicitType === 'directive' || explicitType === 'task') return explicitType
  const raw = String(text || '').trimStart()
  if (raw.startsWith('$')) return 'directive'
  if (raw.startsWith('#')) return 'task'
  return null
}

export function validateIngestBody(body, config) {
  if (!isPlainObject(body)) {
    throw createHttpError(400, 'invalid_body')
  }

  const text = normalize(body.text)
  if (!text) {
    throw createHttpError(400, 'command_text_required')
  }
  validateMaxLength(text, MAX_TEXT_LENGTH, 'command_text_too_long')

  const explicitCommandType = normalize(body.commandType)
  if (explicitCommandType && !['directive', 'task'].includes(explicitCommandType)) {
    throw createHttpError(400, 'invalid_command_type')
  }

  const commandType = detectCommandType(text, explicitCommandType)
  if (!commandType) {
    throw createHttpError(400, 'command_type_required')
  }

  const messageId = normalize(body.messageId)
  validateMaxLength(messageId, MAX_ID_LENGTH, 'message_id_too_long')

  const route = normalizeChannelEnvelope(body, {
    defaultPlatform: config.defaultPlatform,
    defaultAccountId: config.defaultAccountId,
  })

  if (!config.supportedPlatforms.includes(route.platform)) {
    throw createHttpError(400, 'unsupported_platform')
  }
  if (!route.connectorId) {
    throw createHttpError(400, 'connector_id_required')
  }
  if (!route.channelId) {
    throw createHttpError(400, 'channel_id_required')
  }

  validateMaxLength(route.connectorId, MAX_ROUTE_VALUE_LENGTH, 'connector_id_too_long')
  validateMaxLength(route.channelId, MAX_ROUTE_VALUE_LENGTH, 'channel_id_too_long')
  validateMaxLength(route.threadId, MAX_ROUTE_VALUE_LENGTH, 'thread_id_too_long')
  validateMaxLength(route.accountId, MAX_ROUTE_VALUE_LENGTH, 'account_id_too_long')
  validateMaxLength(route.senderId, MAX_ID_LENGTH, 'sender_id_too_long')
  validateMaxLength(route.senderName, MAX_ID_LENGTH, 'sender_name_too_long')

  const projectPath = normalize(body.projectPath) || config.defaultProjectPath
  validateMaxLength(projectPath, MAX_PROJECT_PATH_LENGTH, 'project_path_too_long')
  validateAbsolutePath(projectPath)
  if (commandType === 'directive' && !projectPath) {
    throw createHttpError(400, 'project_path_required')
  }

  const providerProfileId = normalize(body.providerProfileId)
  const providerModel = normalize(body.providerModel)
  const fallbackProviderProfileId = normalize(body.fallbackProviderProfileId)
  const fallbackProviderProfileIds = normalizeFallbackChain(body.fallbackProviderProfileIds || body.fallbackProviderProfileId)
  const rolePresetId = normalize(body.rolePresetId)
  const roleKey = normalize(body.roleKey)
  const compactPackKey = normalize(body.compactPackKey)
  const workMode = normalize(body.workMode)
  const skillIds = normalizeStringArray(body.skillIds)
  const evaluateLoop = normalizeEvaluateLoopInput(body.evaluateLoop)
  validateMaxLength(providerProfileId, MAX_ID_LENGTH, 'provider_profile_id_too_long')
  validateMaxLength(providerModel, MAX_ROUTE_VALUE_LENGTH, 'provider_model_too_long')
  validateMaxLength(fallbackProviderProfileId, MAX_ID_LENGTH, 'fallback_provider_profile_id_too_long')
  validateMaxLength(rolePresetId, MAX_ID_LENGTH, 'role_preset_id_too_long')
  validateMaxLength(roleKey, MAX_ID_LENGTH, 'role_key_too_long')
  validateMaxLength(compactPackKey, MAX_ID_LENGTH, 'compact_pack_key_too_long')
  const priority = normalizeTaskPriority(body.priority)
  const requiresApproval = normalizeBooleanFlag(body.requiresApproval, false)

  return {
    text,
    commandType,
    route,
    projectPath,
    senderId: normalize(body.senderId),
    senderName: normalize(body.senderName),
    providerProfileId,
    providerModel,
    fallbackProviderProfileId,
    fallbackProviderProfileIds,
    rolePresetId,
    roleKey,
    compactPackKey,
    workMode,
    skillIds,
    evaluateLoop,
    activePackRoles: normalizeStringArray(body.activePackRoles),
    priority,
    requiresApproval,
    messageId,
  }
}

export function createBridgeServer(options = {}) {
  const config = options.config || loadConfig()
  const runtimeMetrics = options.runtimeMetrics || createRuntimeMetrics()
  config.runtimeMetrics = runtimeMetrics
  const stateOptions = { stateFile: config.runtimePaths?.stateFile }
  const bridgeState = options.bridgeState || loadBridgeState(stateOptions)
  const saveState = options.saveState || (state => saveBridgeState(state, stateOptions))
  const forwardDirective = options.forwardDirective || forwardDirectiveToAgentsswarm
  const createTaskAndRun = options.createTaskAndRun || createAndRunTaskInAgentsswarm
  const relayFactory = options.relayFactory || createStatusRelay
  const useStandaloneExecution = config.executionBackend === 'standalone'
  const standaloneTaskManager = useStandaloneExecution ? createStandaloneTaskManager(config) : null
  const standaloneApprovalManager = useStandaloneExecution ? createStandaloneApprovalManager(config) : null
  const runtimeSettings = options.runtimeSettings
    ? options.runtimeSettings
    : options.bridgeState && !options.settingsFile
      ? {
          defaults: {
            projectPath: '',
            providerProfileId: '',
            providerModel: '',
            fallbackProviderProfileId: '',
            fallbackProviderProfileIds: [],
            modelOverridesByProvider: {},
            customProviderPresets: [],
            roleRoutes: {},
            agentIdentity: {
              name: '',
              persona: '',
              objective: '',
              voice: '',
              guardrails: '',
              soulText: '',
              identityText: '',
              systemPrompt: '',
              tags: [],
            },
            roleIdentityMap: {},
            rolePresetId: '',
            compactPackKey: '',
            workMode: '',
            skillIds: [],
            evaluateLoop: {
              enabled: false,
              maxTurns: 10,
              timeoutMs: 300000,
              approvalGate: false,
            },
            taskCommandMode: '',
            activePackRoles: [],
            updatedAt: '',
          },
          connections: {},
        }
      : loadRuntimeSettings(config, {
          settingsFile: options.settingsFile,
        })

  const runtimeChannelRouteMap = new Map(
    Object.entries(bridgeState.channelRoutes || {}).map(([key, route]) => [key, normalizeStoredRoute(route)]),
  )
  const runtimeProjectRouteMap = new Map(
    Object.entries(bridgeState.projectRoutes || {}).map(([key, route]) => [key, normalizeStoredRoute(route)]),
  )
  const runtimeTaskRouteMap = new Map(
    Object.entries(bridgeState.taskRoutes || {}).map(([key, route]) => [key, normalizeStoredRoute(route)]),
  )
  const managedTaskSet = new Set(Object.keys(bridgeState.managedTasks || {}))
  const lastStatusByTask = new Map(Object.entries(bridgeState.lastStatusByTask || {}))
  const recentMessageMap = new Map()

  const scheduleManager = createScheduleManager(config, {
    stateFile: options.scheduleFile,
    onTrigger: async (schedule) => {
      if (!standaloneTaskManager) {
        return {
          ok: false,
          error: 'standalone_runner_unavailable',
        }
      }
      const previousTask = schedule.lastResult?.taskId && standaloneTaskManager.getTask(schedule.lastResult.taskId)
      if (previousTask && ['queued', 'running'].includes(previousTask.status)) {
        return { ok: false, error: 'schedule_task_active', taskId: previousTask.id }
      }

      const commandText = normalize(schedule.commandText)
      if (!commandText) {
        return {
          ok: false,
          error: 'schedule_command_text_required',
        }
      }

      const task = await standaloneTaskManager.createTask({
        text: commandText.startsWith('#') || commandText.startsWith('$') ? commandText : `# ${commandText}`,
        commandType: commandText.startsWith('$') ? 'directive' : 'task',
        platform: 'cli',
        accountId: 'scheduler',
        channelId: schedule.id,
        connectorId: 'scheduler',
        senderName: 'scheduler',
        projectPath: normalize(schedule.projectPath),
        providerProfileId: normalize(schedule.providerProfileId),
        providerModel: normalize(schedule.providerModel),
        fallbackProviderProfileId: normalize(schedule.fallbackProviderProfileId),
        rolePresetId: normalize(schedule.rolePresetId),
        compactPackKey: normalize(schedule.compactPackKey),
        activePackRoles: Array.isArray(schedule.activePackRoles) ? schedule.activePackRoles : [],
      })

      const runResult = await standaloneTaskManager.runTask(task.id)
      registerTaskRoute(
        task.id,
        {
          platform: 'cli',
          accountId: 'scheduler',
          channelId: schedule.id,
          threadId: '',
          connectorId: 'scheduler',
        },
        task.projectPath,
        task.title,
      )

      if (runResult?.reason && runResult.reason !== 'runner_not_configured') {
        return {
          ok: false,
          error: runResult.reason,
          taskId: task.id,
        }
      }

      return {
        ok: true,
        taskId: task.id,
      }
    },
  })

  let persistInFlight = null
  let queuedSnapshot = null

  function normalizeStoredRoute(route) {
    return sanitizeRoute(route, {
      defaultPlatform: config.defaultPlatform,
      defaultAccountId: config.defaultAccountId,
    })
  }

  function snapshotState() {
    const channelRoutes = Object.fromEntries(runtimeChannelRouteMap.entries())
    const projectRoutes = Object.fromEntries(runtimeProjectRouteMap.entries())
    const taskRoutes = Object.fromEntries(runtimeTaskRouteMap.entries())
    const managedTasks = {}
    for (const taskId of managedTaskSet.values()) {
      const taskRoute = runtimeTaskRouteMap.get(taskId)
      managedTasks[taskId] = {
        createdAt: taskRoute?.createdAt || Date.now(),
        title: taskRoute?.title || taskId,
        projectPath: taskRoute?.projectPath || '',
      }
    }
    const statusSnapshot = Object.fromEntries(lastStatusByTask.entries())
    return { channelRoutes, projectRoutes, taskRoutes, managedTasks, lastStatusByTask: statusSnapshot }
  }

  function startPersistLoop() {
    if (persistInFlight) return persistInFlight
    persistInFlight = (async () => {
      while (queuedSnapshot) {
        const nextSnapshot = queuedSnapshot
        queuedSnapshot = null
        await Promise.resolve(saveState(nextSnapshot))
      }
    })().catch((err) => {
      logWarn('state_persist_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }).finally(() => {
      persistInFlight = null
      if (queuedSnapshot) {
        void startPersistLoop()
      }
    })
    return persistInFlight
  }

  function persistBridgeState() {
    queuedSnapshot = snapshotState()
    return startPersistLoop()
  }

  async function flushBridgeState() {
    const pending = persistBridgeState()
    await pending
    if (persistInFlight) {
      await persistInFlight
    }
  }

  function requireSecret(req) {
    if (!config.bridgeSecret) return true
    const provided = String(req.headers['x-bridge-secret'] || '').trim()
    return provided && provided === config.bridgeSecret
  }

  async function persistRuntimeSettings() {
    await saveRuntimeSettings(runtimeSettings, config, {
      settingsFile: options.settingsFile,
    })
  }

  function getRuntimeDefaults() {
    const defaults = runtimeSettings.defaults || {}
    const fallbackProviderProfileIds = normalizeFallbackChain(
      defaults.fallbackProviderProfileIds?.length > 0
        ? defaults.fallbackProviderProfileIds
        : defaults.fallbackProviderProfileId,
    )
    const modelOverridesByProvider = normalizeModelOverrides(defaults.modelOverridesByProvider)
    const customProviderPresets = normalizeCustomPresets(defaults.customProviderPresets)
    const roleRoutes = normalizeRoleRoutes(defaults.roleRoutes)
    const templates = {
      soulText: loadSoulTemplate(config),
      identityText: loadIdentityTemplate(config),
      agentsText: loadAgentsTemplate(config),
    }
    return {
      projectPath: defaults.projectPath || '',
      providerProfileId: defaults.providerProfileId || '',
      providerModel: defaults.providerModel || '',
      fallbackProviderProfileId: defaults.fallbackProviderProfileId || fallbackProviderProfileIds[0] || '',
      fallbackProviderProfileIds,
      modelOverridesByProvider,
      customProviderPresets,
      roleRoutes,
      agentIdentity: isPlainObject(defaults.agentIdentity) ? {
        name: normalize(defaults.agentIdentity.name),
        persona: normalize(defaults.agentIdentity.persona),
        objective: normalize(defaults.agentIdentity.objective),
        voice: normalize(defaults.agentIdentity.voice),
        guardrails: normalize(defaults.agentIdentity.guardrails),
        soulText: normalize(defaults.agentIdentity.soulText) || templates.soulText,
        identityText: normalize(defaults.agentIdentity.identityText) || templates.identityText,
        systemPrompt: normalize(defaults.agentIdentity.systemPrompt),
        tags: Array.isArray(defaults.agentIdentity.tags) ? defaults.agentIdentity.tags.map((entry) => normalize(entry)).filter(Boolean) : [],
      } : {
        name: '',
        persona: '',
        objective: '',
        voice: '',
        guardrails: '',
        soulText: templates.soulText,
        identityText: templates.identityText,
        systemPrompt: '',
        tags: [],
      },
      roleIdentityMap: isPlainObject(defaults.roleIdentityMap) ? defaults.roleIdentityMap : {},
      rolePresetId: defaults.rolePresetId || '',
      compactPackKey: defaults.compactPackKey || '',
      workMode: defaults.workMode || '',
      skillIds: Array.isArray(defaults.skillIds) ? defaults.skillIds.map((entry) => normalize(entry)).filter(Boolean) : [],
      evaluateLoop: normalizeEvaluateLoopInput(defaults.evaluateLoop),
      taskCommandMode: defaults.taskCommandMode || '',
      activePackRoles: Array.isArray(defaults.activePackRoles) ? defaults.activePackRoles : [],
      templates,
      updatedAt: defaults.updatedAt || '',
    }
  }

  function buildGeminiDiagnostics(providerSummary) {
    const geminiTool = (providerSummary.cliTools || []).find((tool) => tool.id === 'gemini')
    const profileIds = (providerSummary.profiles || [])
      .filter((profile) => String(profile.provider || '').toLowerCase().includes('gemini') || profile.id.includes('gemini'))
      .map((profile) => profile.id)

    const keyConfigured = Boolean(String(process.env.GEMINI_API_KEY || '').trim())
    const keySource = keyConfigured ? 'GEMINI_API_KEY' : ''
    const cliAvailable = geminiTool ? geminiTool.installed : profileIds.length === 0
    const sandboxMode = normalize(process.env.GEMINI_SANDBOX_MODE) || 'workspace-write'

    return {
      profileIds,
      cliAvailable,
      keyConfigured,
      keySource,
      sandboxMode,
      adapterReady: cliAvailable && keyConfigured,
    }
  }

  function buildRoleDefaults() {
    const runtimeDefaults = getRuntimeDefaults()
    return {
      rolePresetId: runtimeDefaults.rolePresetId || listRolePresets()[0]?.id || '',
      compactPackKey: runtimeDefaults.compactPackKey || config.defaultCompactPackKey,
      providerProfileId: runtimeDefaults.providerProfileId || config.defaultProviderProfileId,
      providerModel: runtimeDefaults.providerModel || '',
      fallbackProviderProfileId: runtimeDefaults.fallbackProviderProfileId || '',
      fallbackProviderProfileIds: runtimeDefaults.fallbackProviderProfileIds || [],
      modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider || {},
      roleRoutes: runtimeDefaults.roleRoutes || {},
      agentIdentity: runtimeDefaults.agentIdentity || {},
      roleIdentityMap: runtimeDefaults.roleIdentityMap || {},
      workMode: runtimeDefaults.workMode || 'solo',
      skillIds: runtimeDefaults.skillIds || [],
      evaluateLoop: runtimeDefaults.evaluateLoop || normalizeEvaluateLoopInput({}),
      taskCommandMode: runtimeDefaults.taskCommandMode || config.taskCommandMode,
      activePackRoles: runtimeDefaults.activePackRoles || [],
      projectPath: runtimeDefaults.projectPath || config.defaultProjectPath || '',
      templates: runtimeDefaults.templates || {
        soulText: loadSoulTemplate(config),
        identityText: loadIdentityTemplate(config),
        agentsText: loadAgentsTemplate(config),
      },
      updatedAt: runtimeDefaults.updatedAt || '',
    }
  }

  function listProviderPresets() {
    const runtimeDefaults = getRuntimeDefaults()
    const officialPresets = OFFICIAL_PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      baseUrl: preset.baseUrl,
      source: 'official',
      defaults: {
        ...preset.defaults,
        fallbackProviderProfileIds: normalizeFallbackChain(preset.defaults?.fallbackProviderProfileIds),
      },
    }))
    const customPresets = (runtimeDefaults.customProviderPresets || []).map((preset) => ({
      ...preset,
      source: 'custom',
    }))
    return {
      officialPresets,
      customPresets,
      presets: [...officialPresets, ...customPresets],
    }
  }

  function discoverModelsForProfiles(profileIds = [], options = {}) {
    const runtimeDefaults = getRuntimeDefaults()
    const discoveredByProfile = {}
    const detailsByProfile = {}
    for (const profileId of profileIds) {
      if (!profileId) continue
      const discovery = discoverProviderModels(config, profileId, {
        modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
        force: options.force === true,
      })
      if (!discovery) continue
      detailsByProfile[profileId] = discovery
      discoveredByProfile[profileId] = (discovery.models || []).map((entry) => entry.id)
    }
    return {
      discoveredByProfile,
      detailsByProfile,
    }
  }

  function resolveRoleRouteForTask(runtimeDefaults, roleKeys = []) {
    const routes = runtimeDefaults.roleRoutes || {}
    for (const roleKey of roleKeys) {
      if (!roleKey) continue
      if (routes[roleKey]) return routes[roleKey]
    }
    return null
  }

  function registerChannelRoute(route, projectPath) {
    if (!route?.connectorId || !route?.channelId) return
    const key = toChannelRouteKey(route, {
      defaultPlatform: config.defaultPlatform,
      defaultAccountId: config.defaultAccountId,
    })
    runtimeChannelRouteMap.set(key, {
      ...normalizeStoredRoute(route),
      projectPath: normalize(projectPath),
      updatedAt: Date.now(),
    })
    void persistBridgeState()
  }

  function registerProjectRoute(projectPath, route) {
    const key = normalize(projectPath)
    if (!key) return
    runtimeProjectRouteMap.set(key, {
      ...normalizeStoredRoute(route),
      updatedAt: Date.now(),
    })
    void persistBridgeState()
  }

  function resolveRoute(projectPath, channel) {
    const channelKey = channel
      ? toChannelRouteKey(channel, {
          defaultPlatform: config.defaultPlatform,
          defaultAccountId: config.defaultAccountId,
        })
      : ''
    if (channelKey && runtimeChannelRouteMap.has(channelKey)) {
      return runtimeChannelRouteMap.get(channelKey)
    }
    if (channelKey && config.channelRouteMap[channelKey]) {
      return normalizeStoredRoute(config.channelRouteMap[channelKey])
    }

    const key = normalize(projectPath)
    if (key && runtimeProjectRouteMap.has(key)) {
      return runtimeProjectRouteMap.get(key)
    }
    if (key && config.routeMap[key]) {
      const mapRow = normalizeStoredRoute(config.routeMap[key])
      if (mapRow?.connectorId && mapRow?.channelId) return mapRow
    }
    if (config.defaultRoute.connectorId && config.defaultRoute.channelId) {
      return normalizeStoredRoute(config.defaultRoute)
    }
    return null
  }

  function registerTaskRoute(taskId, route, projectPath, title) {
    if (!taskId) return
    const now = Date.now()
    runtimeTaskRouteMap.set(taskId, {
      ...normalizeStoredRoute(route),
      projectPath: normalize(projectPath),
      title: normalize(title),
      createdAt: now,
      updatedAt: now,
    })
    managedTaskSet.add(taskId)
    void persistBridgeState()
  }

  function resolveRouteForTask(projectPath, taskId) {
    if (taskId && runtimeTaskRouteMap.has(taskId)) {
      return runtimeTaskRouteMap.get(taskId)
    }
    return resolveRoute(projectPath)
  }

  function shouldRelayTask(task) {
    if (!config.statusRelayManagedOnly) return true
    const taskId = typeof task?.id === 'string' ? task.id : ''
    return !!taskId && managedTaskSet.has(taskId)
  }

  function getLastStatus(taskId) {
    return lastStatusByTask.get(taskId)
  }

  function setLastStatus(taskId, status) {
    lastStatusByTask.set(taskId, status)
    void persistBridgeState()
  }

  function hasManagedTasks() {
    return managedTaskSet.size > 0
  }

  function getManagedTaskIds() {
    return Array.from(managedTaskSet.values())
  }

  function pruneTaskState(taskId) {
    if (!taskId) return
    runtimeTaskRouteMap.delete(taskId)
    managedTaskSet.delete(taskId)
    lastStatusByTask.delete(taskId)
    void persistBridgeState()
  }

  function pruneRecentMessages(now = Date.now()) {
    for (const [key, entry] of recentMessageMap.entries()) {
      const completedAt = Number(entry?.completedAt || 0)
      const startedAt = Number(entry?.startedAt || 0)
      const timestamp = completedAt || startedAt
      if (hasExpired(timestamp, config.ingestMessageIdTtlMs, now)) {
        recentMessageMap.delete(key)
      }
    }
  }

  function pruneExpiredState(options = {}) {
    const now = Number(options.now || Date.now())
    const dryRun = options.dryRun === true
    const result = {
      dryRun,
      channelRoutesPruned: 0,
      projectRoutesPruned: 0,
      taskRoutesPruned: 0,
      managedTasksPruned: 0,
      statusEntriesPruned: 0,
    }

    const expiredTaskIds = new Set()

    for (const [key, route] of runtimeChannelRouteMap.entries()) {
      if (!hasExpired(Number(route?.updatedAt), config.channelRouteTtlMs, now)) continue
      result.channelRoutesPruned += 1
      if (!dryRun) runtimeChannelRouteMap.delete(key)
    }

    for (const [key, route] of runtimeProjectRouteMap.entries()) {
      if (!hasExpired(Number(route?.updatedAt), config.projectRouteTtlMs, now)) continue
      result.projectRoutesPruned += 1
      if (!dryRun) runtimeProjectRouteMap.delete(key)
    }

    for (const [taskId, route] of runtimeTaskRouteMap.entries()) {
      const taskTimestamp = Number(route?.updatedAt || route?.createdAt)
      if (!hasExpired(taskTimestamp, config.taskRouteTtlMs, now)) continue
      result.taskRoutesPruned += 1
      expiredTaskIds.add(taskId)
      if (!dryRun) runtimeTaskRouteMap.delete(taskId)
    }

    for (const taskId of managedTaskSet.values()) {
      if (!expiredTaskIds.has(taskId)) continue
      result.managedTasksPruned += 1
      if (!dryRun) managedTaskSet.delete(taskId)
    }

    for (const taskId of lastStatusByTask.keys()) {
      if (!expiredTaskIds.has(taskId)) continue
      result.statusEntriesPruned += 1
      if (!dryRun) lastStatusByTask.delete(taskId)
    }

    if (!dryRun && Object.values(result).some((value) => typeof value === 'number' && value > 0)) {
      void persistBridgeState()
      logInfo('state_pruned', result)
    }

    return result
  }

  const statusRelay = relayFactory({
    config,
    ...(standaloneTaskManager ? { listTasks: async (_config, options) => standaloneTaskManager.listTasks({}).filter(task => !options?.taskIds || options.taskIds.includes(task.id)).map(task => ({ ...task, project_path: task.projectPath })) } : {}),
    resolveRouteForTask,
    shouldRelayTask,
    getLastStatus,
    setLastStatus,
    hasManagedTasks,
    getManagedTaskIds,
    onTerminalTask: async (task) => {
      const taskId = typeof task?.id === 'string' ? task.id : ''
      pruneTaskState(taskId)
    },
  })

  pruneExpiredState({ now: Date.now() })

  const connectorManager = createConnectorManager({
    settings: runtimeSettings,
    config,
    persist: persistRuntimeSettings,
    tester: options.testConnector,
    onRegistered: (connection) => {
      registerChannelRoute(connection, connection.projectPath)
      if (connection.projectPath) {
        registerProjectRoute(connection.projectPath, connection)
      }
    },
    onRemoved: (_key, connection) => {
      if (connection?.key) {
        runtimeChannelRouteMap.delete(connection.key)
      }
      if (connection?.projectPath && runtimeProjectRouteMap.get(connection.projectPath)?.connectorId === connection.connectorId) {
        runtimeProjectRouteMap.delete(connection.projectPath)
      }
      void persistBridgeState()
    },
  })

  async function executeIngest(parsed, requestId) {
    const runtimeDefaults = getRuntimeDefaults()
    const runtimeRoleRoute = resolveRoleRouteForTask(runtimeDefaults, runtimeDefaults.activePackRoles)
    const modelOverridesByProvider = runtimeDefaults.modelOverridesByProvider || {}
    const effectiveProjectPath = parsed.projectPath || runtimeDefaults.projectPath || config.defaultProjectPath
    const effectiveProviderProfileId =
      parsed.providerProfileId
      || runtimeRoleRoute?.providerProfileId
      || runtimeDefaults.providerProfileId
    const effectiveFallbackProviderProfileId =
      parsed.fallbackProviderProfileId
      || parsed.fallbackProviderProfileIds?.[0]
      || runtimeRoleRoute?.fallbackProviderProfileId
      || runtimeRoleRoute?.fallbackProviderProfileIds?.[0]
      || runtimeDefaults.fallbackProviderProfileId
      || runtimeDefaults.fallbackProviderProfileIds[0]
      || ''
    const effectiveFallbackProviderProfileIds =
      parsed.fallbackProviderProfileIds?.length > 0
        ? parsed.fallbackProviderProfileIds
        : runtimeRoleRoute?.fallbackProviderProfileIds?.length > 0
          ? runtimeRoleRoute.fallbackProviderProfileIds
          : runtimeDefaults.fallbackProviderProfileIds
    const effectiveCompactPackKey = parsed.compactPackKey || runtimeDefaults.compactPackKey
    const effectiveRolePresetId = parsed.rolePresetId || runtimeDefaults.rolePresetId || ''
    const effectiveRoleKey = parsed.roleKey || runtimeDefaults.activePackRoles?.[0] || ''
    const effectiveActivePackRoles = parsed.activePackRoles?.length > 0 ? parsed.activePackRoles : runtimeDefaults.activePackRoles || []
    const effectiveWorkMode = parsed.workMode || runtimeDefaults.workMode || ''
    const effectiveSkillIds = parsed.skillIds?.length > 0 ? parsed.skillIds : runtimeDefaults.skillIds || []
    const effectiveEvaluateLoop =
      parsed.evaluateLoop && typeof parsed.evaluateLoop === 'object' && !Array.isArray(parsed.evaluateLoop)
        ? normalizeEvaluateLoopInput(parsed.evaluateLoop)
        : normalizeEvaluateLoopInput(runtimeDefaults.evaluateLoop)
    const effectiveProviderModel =
      parsed.providerModel
      || runtimeRoleRoute?.providerModel
      || modelOverridesByProvider[effectiveProviderProfileId]
      || runtimeDefaults.providerModel
      || ''

    registerChannelRoute(parsed.route, effectiveProjectPath)
    registerProjectRoute(effectiveProjectPath, parsed.route)

    logInfo('ingest_received', {
      requestId,
      commandType: parsed.commandType,
      messageId: parsed.messageId,
      routeKey: parsed.route.key,
      projectPath: effectiveProjectPath || null,
      textPreview: createTextPreview(parsed.text),
    })
    runtimeMetrics.recordChannelActivity({
      platform: parsed.route.platform,
    })
    runtimeMetrics.recordPackUsage({
      packKey: effectiveCompactPackKey || 'default',
    })
    if (effectiveProviderProfileId) {
      runtimeMetrics.recordProviderRequest({
        profileId: effectiveProviderProfileId,
        failed: false,
      })
    }

    if (parsed.commandType === 'directive' && !standaloneTaskManager) {
      const result = await forwardDirective(config, {
        text: parsed.text,
        platform: parsed.route.platform,
        accountId: parsed.route.accountId,
        channelId: parsed.route.channelId,
        threadId: parsed.route.threadId,
        connectorId: parsed.route.connectorId,
        senderId: parsed.senderId,
        senderName: parsed.senderName,
        projectPath: effectiveProjectPath,
        providerProfileId: effectiveProviderProfileId,
        providerModel: effectiveProviderModel,
        fallbackProviderProfileId: effectiveFallbackProviderProfileId,
        fallbackProviderProfileIds: effectiveFallbackProviderProfileIds,
        rolePresetId: effectiveRolePresetId,
        roleKey: effectiveRoleKey,
        compactPackKey: effectiveCompactPackKey,
        activePackRoles: effectiveActivePackRoles,
        workMode: effectiveWorkMode,
        skillIds: effectiveSkillIds,
        evaluateLoop: effectiveEvaluateLoop,
        agentIdentity: runtimeDefaults.agentIdentity,
        roleIdentityMap: runtimeDefaults.roleIdentityMap,
      })
      return {
        ok: true,
        commandType: parsed.commandType,
        compactPackKey: effectiveCompactPackKey,
        providerProfileId: effectiveProviderProfileId,
        providerModel: effectiveProviderModel,
        ackText: result.ackText,
      }
    }

    if (standaloneTaskManager) {
        const task = await standaloneTaskManager.createTask({
          text: parsed.text,
          commandType: parsed.commandType,
          projectPath: effectiveProjectPath,
          platform: parsed.route.platform,
          accountId: parsed.route.accountId,
          channelId: parsed.route.channelId,
          threadId: parsed.route.threadId,
          connectorId: parsed.route.connectorId,
          senderId: parsed.senderId,
          senderName: parsed.senderName,
          providerProfileId: effectiveProviderProfileId,
          providerModel: effectiveProviderModel,
          compactPackKey: effectiveCompactPackKey,
          fallbackProviderProfileId: effectiveFallbackProviderProfileId,
          fallbackProviderProfileIds: effectiveFallbackProviderProfileIds,
          rolePresetId: effectiveRolePresetId,
          roleKey: effectiveRoleKey,
          activePackRoles: effectiveActivePackRoles,
          workMode: effectiveWorkMode,
          skillIds: effectiveSkillIds,
          evaluateLoop: effectiveEvaluateLoop,
          agentIdentity: runtimeDefaults.agentIdentity,
          roleIdentityMap: runtimeDefaults.roleIdentityMap,
          priority: parsed.priority,
          requiresApproval: parsed.requiresApproval,
        })

        let approval = null
        let persistedTask = task
        if (task.approvalRequired && standaloneApprovalManager) {
          approval = await standaloneApprovalManager.createApproval({
            taskId: task.id,
            taskTitle: task.title,
            taskDescription: task.description,
            priority: task.priority,
            rolePresetId: task.rolePresetId,
            projectPath: task.projectPath,
            taskCommandMode: task.taskCommandMode,
            requestedBy: parsed.senderName || parsed.senderId || 'bridge',
          })
          persistedTask = await standaloneTaskManager.setTaskApproval(task.id, {
            approvalRequired: true,
            approvalStatus: 'pending',
            approvalId: approval.id,
          })
        }

        const boardOnly = (runtimeDefaults.taskCommandMode || config.taskCommandMode) === 'board_only'
        const runResult = approval || boardOnly
          ? { started: false, reason: approval ? 'task_approval_pending' : 'queued', task: persistedTask }
          : await standaloneTaskManager.runTask(task.id)

        registerTaskRoute(
          task.id,
          parsed.route,
          persistedTask?.projectPath || effectiveProjectPath,
          persistedTask?.title || task.title,
        )
        return {
          ok: true,
          commandType: parsed.commandType,
          taskId: task.id,
          approvalId: approval?.id || '',
          compactPackKey: effectiveCompactPackKey,
          providerProfileId: effectiveProviderProfileId,
          providerModel: effectiveProviderModel,
          ackText: runResult.reason === 'runner_not_configured'
            ? `Task queued on board (${task.id.slice(0, 8)}).`
            : `Task registered (${task.id.slice(0, 8)}).`,
        }
      }

    const taskResult = await createTaskAndRun(config, {
      text: parsed.text,
      projectPath: effectiveProjectPath,
      platform: parsed.route.platform,
      accountId: parsed.route.accountId,
      channelId: parsed.route.channelId,
      threadId: parsed.route.threadId,
      connectorId: parsed.route.connectorId,
      senderId: parsed.senderId,
      senderName: parsed.senderName,
      providerProfileId: effectiveProviderProfileId,
      providerModel: effectiveProviderModel,
      fallbackProviderProfileId: effectiveFallbackProviderProfileId,
      fallbackProviderProfileIds: effectiveFallbackProviderProfileIds,
      rolePresetId: effectiveRolePresetId,
      roleKey: effectiveRoleKey,
      compactPackKey: effectiveCompactPackKey,
      activePackRoles: effectiveActivePackRoles,
      workMode: effectiveWorkMode,
      skillIds: effectiveSkillIds,
      evaluateLoop: effectiveEvaluateLoop,
    })

    registerTaskRoute(
      taskResult.taskId,
      parsed.route,
      taskResult.projectPath || effectiveProjectPath,
      taskResult.title,
    )
    return {
      ok: true,
      commandType: parsed.commandType,
      taskId: taskResult.taskId,
      compactPackKey: effectiveCompactPackKey,
      providerProfileId: effectiveProviderProfileId,
      providerModel: effectiveProviderModel,
      ackText: taskResult.ackText,
    }
  }

  async function executeIngestWithDedupe(parsed, requestId) {
    pruneRecentMessages()
    const dedupeKey = resolveDedupeKey(parsed)
    if (!dedupeKey) {
      return {
        ...(await executeIngest(parsed, requestId)),
        deduplicated: false,
      }
    }

    const cached = recentMessageMap.get(dedupeKey)
    if (cached?.response) {
      logInfo('ingest_deduplicated', {
        requestId,
        dedupeKey,
      })
      return {
        ...cached.response,
        deduplicated: true,
      }
    }
    if (cached?.promise) {
      const response = await cached.promise
      logInfo('ingest_deduplicated', {
        requestId,
        dedupeKey,
        source: 'in_flight',
      })
      return {
        ...response,
        deduplicated: true,
      }
    }

    const promise = executeIngest(parsed, requestId)
    recentMessageMap.set(dedupeKey, {
      startedAt: Date.now(),
      promise,
    })

    try {
      const response = await promise
      recentMessageMap.set(dedupeKey, {
        completedAt: Date.now(),
        response,
      })
      return {
        ...response,
        deduplicated: false,
      }
    } catch (err) {
      recentMessageMap.delete(dedupeKey)
      throw err
    }
  }

  function parseLimit(value, fallback = 0, max = 200) {
    const parsed = Number.parseInt(String(value || ''), 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return Math.min(parsed, max)
  }

  function buildSummaryPayload() {
    const compactPacks = listCompactPacks(config)
    const runtimeDefaults = getRuntimeDefaults()
    const providerSummary = buildProviderSummary(config, {
      requestedProfileId: runtimeDefaults.providerProfileId,
      fallbackProviderProfileIds: runtimeDefaults.fallbackProviderProfileIds,
      modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
    })
    const connections = listConnections(runtimeSettings)
    const metricsSnapshot = runtimeMetrics.snapshot({ endpointLimit: 20 })
    const schedules = scheduleManager.countSchedules()
    const standaloneTasks = standaloneTaskManager
      ? standaloneTaskManager.countTasks()
      : {
          total: 0,
          countsByStatus: {},
          countsByType: {},
          countsByPriority: {},
          approvalsPending: 0,
          runnerConfigured: false,
          activeRuns: 0,
        }
    const approvals = standaloneApprovalManager
      ? standaloneApprovalManager.countApprovals()
      : {
          total: 0,
          countsByStatus: {},
          pending: 0,
          approved: 0,
          rejected: 0,
        }

    return {
      ok: true,
      routes: {
        channels: runtimeChannelRouteMap.size,
        projects: runtimeProjectRouteMap.size,
        tasks: runtimeTaskRouteMap.size,
      },
      managedTasks: managedTaskSet.size,
      providers: {
        defaultProviderProfileId: providerSummary.defaultProviderProfileId,
        runtimeProviderProfileId: runtimeDefaults.providerProfileId,
        profiles: providerSummary.profiles.length,
        missingRequiredCliTools: providerSummary.missingRequiredCliTools,
        unavailableProfileIds: providerSummary.unavailableProfileIds,
      },
      connections: {
        count: connections.length,
      },
      schedules,
      compactPacks: {
        defaultCompactPackKey: config.defaultCompactPackKey,
        count: compactPacks.length,
      },
      channels: {
        defaultPlatform: config.defaultPlatform,
        defaultAccountId: config.defaultAccountId,
        supportedPlatforms: config.supportedPlatforms,
      },
      runtimeDefaults: {
        workMode: runtimeDefaults.workMode || 'solo',
        skillIds: runtimeDefaults.skillIds || [],
        evaluateLoop: runtimeDefaults.evaluateLoop || normalizeEvaluateLoopInput({}),
      },
      standaloneTasks,
      approvals: {
        ...approvals,
        summary: {
          pending: approvals.pending || 0,
          approved: approvals.approved || 0,
          rejected: approvals.rejected || 0,
        },
      },
      metrics: metricsSnapshot.domain,
      configIssues: config.configIssues,
      generatedAt: new Date().toISOString(),
    }
  }

  function buildDashboardPayload(options = {}) {
    const limit = parseLimit(options.limit, 12, 100)
    const tasks = standaloneTaskManager
      ? standaloneTaskManager.listTasks({ limit })
      : []
    const approvals = standaloneApprovalManager
      ? standaloneApprovalManager.listApprovals({ limit })
      : []

    return {
      ok: true,
      health: {
        app: 'agentsswarm',
        mode: config.taskCommandMode,
        bridgeSecretConfigured: Boolean(config.bridgeSecret),
        allowUnsecuredBridge: config.allowUnsecuredBridge,
      },
      summary: buildSummaryPayload(),
      metrics: runtimeMetrics.snapshot({ endpointLimit: 20 }),
      tasks,
      approvals,
      generatedAt: new Date().toISOString(),
    }
  }

  const server = http.createServer(async (req, res) => {
    const requestId = createRequestId(req.headers['x-request-id'])
    const responseHeaders = { 'x-request-id': requestId }
    try {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/api/health')) {
        const providerSummary = buildProviderSummary(config, {
          requestedProfileId: getRuntimeDefaults().providerProfileId,
          fallbackProviderProfileIds: getRuntimeDefaults().fallbackProviderProfileIds,
          modelOverridesByProvider: getRuntimeDefaults().modelOverridesByProvider,
        })
        const compactPacks = listCompactPacks(config)
        return json(res, 200, {
          ok: true,
          app: 'agentsswarm',
          mode: config.taskCommandMode,
          bridge_secret_configured: Boolean(config.bridgeSecret),
          allow_unsecured_bridge: config.allowUnsecuredBridge,
          compact_agent_limit: config.compactAgentLimit,
          enforce_compact_project_scope: config.enforceCompactProjectScope,
          status_relay_enabled: config.statusRelayEnabled,
          status_relay_managed_only: config.statusRelayManagedOnly,
          default_platform: config.defaultPlatform,
          default_account_id: config.defaultAccountId,
          default_compact_pack: config.defaultCompactPackKey,
          default_provider_profile: providerSummary.defaultProviderProfileId,
          provider_profiles: providerSummary.profiles.length,
          compact_packs: compactPacks.length,
          supported_platforms: config.supportedPlatforms,
          config_issues: config.configIssues,
        }, responseHeaders)
      }

      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
      const rawPathname = requestUrl.pathname
      const pathname = stripApiPrefix(rawPathname)
      if (req.method === 'GET' && pathname.startsWith('/dashboard/assets/')) {
        const asset = readDashboardAsset(pathname)
        if (!asset) return json(res, 404, { error: 'not_found' }, responseHeaders)
        res.writeHead(200, { ...responseHeaders, 'content-type': asset.contentType })
        return res.end(asset.body)
      }

      if (req.method === 'GET' && pathname === '/') {
        if (requestWantsHtml(req)) {
          return html(res, 200, renderDashboardPage(), responseHeaders)
        }
        return json(res, 200, {
          ok: true,
          service: 'secure local control plane api',
        }, responseHeaders)
      }

      if (req.method === 'GET' && (pathname === '/dashboard' || pathname === '/dashboard/')) {
        return html(res, 200, renderDashboardPage(), responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/dashboard/data') {
        return json(
          res,
          200,
          buildDashboardPayload({ limit: requestUrl.searchParams.get('limit') }),
          responseHeaders,
        )
      }

      if (req.method === 'GET' && pathname === '/channel-templates') {
        return json(res, 200, {
          ok: true,
          templates: listChannelTemplates(),
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/routes') {
        return json(res, 200, {
          ok: true,
          channelRoutes: Object.fromEntries(runtimeChannelRouteMap.entries()),
          projectRoutes: Object.fromEntries(runtimeProjectRouteMap.entries()),
          taskRoutes: Object.fromEntries(runtimeTaskRouteMap.entries()),
          managedTaskIds: Array.from(managedTaskSet.values()),
          lastStatusByTask: Object.fromEntries(lastStatusByTask.entries()),
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/channels') {
        return json(res, 200, {
          ok: true,
          supportedPlatforms: listSupportedPlatforms(),
          configuredPlatforms: config.supportedPlatforms,
          defaultPlatform: config.defaultPlatform,
          defaultAccountId: config.defaultAccountId,
          channelRoutes: Object.fromEntries(runtimeChannelRouteMap.entries()),
          staticChannelRoutes: config.channelRouteMap,
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/providers') {
        const runtimeDefaults = getRuntimeDefaults()
        const providerSummary = buildProviderSummary(config, {
          requestedProfileId: runtimeDefaults.providerProfileId,
          fallbackProviderProfileIds: runtimeDefaults.fallbackProviderProfileIds,
          modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
        })
        const modelDiscovery = discoverModelsForProfiles(providerSummary.profiles.map((profile) => profile.id))
        const presetPayload = listProviderPresets()
        return json(res, 200, {
          ok: true,
          defaultProviderProfileId: providerSummary.defaultProviderProfileId,
          runtimeDefaults,
          profiles: providerSummary.profiles,
          profileModels: Object.fromEntries(
            providerSummary.profiles.map((profile) => [
              profile.id,
              listProviderModels(config, profile.id, {
                modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
                discoveredModelsByProfile: modelDiscovery.discoveredByProfile,
              }),
            ]),
          ),
          modelDiscovery: modelDiscovery.detailsByProfile,
          cliTools: providerSummary.cliTools,
          countsByTransport: providerSummary.countsByTransport,
          failoverChain: providerSummary.failoverChain,
          presets: presetPayload.presets,
          officialPresets: presetPayload.officialPresets,
          customPresets: presetPayload.customPresets,
          gemini: buildGeminiDiagnostics(providerSummary),
          missingRequiredCliTools: providerSummary.missingRequiredCliTools,
          unavailableProfileIds: providerSummary.unavailableProfileIds,
          configIssues: config.configIssues,
        }, responseHeaders)
      }

      const providerModelsMatch = pathname.match(/^\/providers\/([^/]+)\/models$/)
      if (req.method === 'GET' && providerModelsMatch) {
        const profileId = decodePathSegment(providerModelsMatch[1])
        const runtimeDefaults = getRuntimeDefaults()
        const modelDiscovery = discoverModelsForProfiles([profileId])
        const models = listProviderModels(config, profileId, {
          modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
          discoveredModelsByProfile: modelDiscovery.discoveredByProfile,
        })
        if (models.length <= 0) {
          return json(res, 404, { error: 'provider_profile_not_found' }, responseHeaders)
        }
        return json(res, 200, {
          ok: true,
          profileId,
          models,
          modelDetails: modelDiscovery.detailsByProfile[profileId]?.models || models.map((id) => ({ id, label: id, source: 'static_catalog' })),
          discovery: modelDiscovery.detailsByProfile[profileId] || null,
          selectedModel: runtimeDefaults.modelOverridesByProvider[profileId] || models[0] || '',
        }, responseHeaders)
      }

      const providerDiscoverMatch = pathname.match(/^\/providers\/([^/]+)\/discover-models$/)
      if (req.method === 'GET' && providerDiscoverMatch) {
        const profileId = decodePathSegment(providerDiscoverMatch[1])
        const force = requestUrl.searchParams.get('force') === '1' || requestUrl.searchParams.get('force') === 'true'
        const runtimeDefaults = getRuntimeDefaults()
        const discovery = discoverProviderModels(config, profileId, {
          modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
          force,
        })
        if (!discovery) {
          return json(res, 404, { error: 'provider_profile_not_found' }, responseHeaders)
        }
        return json(res, 200, {
          ok: true,
          profileId,
          discovery,
        }, responseHeaders)
      }

      const providerStatusMatch = pathname.match(/^\/providers\/([^/]+)\/status$/)
      if (req.method === 'GET' && providerStatusMatch) {
        const profileId = decodePathSegment(providerStatusMatch[1])
        if (profileId !== 'opencode-cli') {
          return json(res, 200, {
            ok: true,
            profileId,
            status: {
              profileId,
              available: true,
              availabilityReason: 'generic_profile',
              version: '',
              session: null,
              config: null,
              models: [],
            },
          }, responseHeaders)
        }
        return json(res, 200, {
          ok: true,
          profileId,
          status: getOpenCodeStatus(config),
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/providers/test') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const profileId = normalize(body?.profileId)
        const apiKey = normalize(body?.apiKey)
        if (!profileId) {
          return json(res, 400, { error: 'provider_profile_id_required' }, responseHeaders)
        }
        if (!apiKey) {
          return json(res, 400, { error: 'provider_api_key_required' }, responseHeaders)
        }

        const providerSummary = buildProviderSummary(config)
        const profile = providerSummary.profiles.find((entry) => entry.id === profileId)
        if (!profile) {
          return json(res, 404, { error: 'provider_profile_not_found' }, responseHeaders)
        }

        const message = `${profileId} configuration accepted; connectivity not verified`
        return json(res, 200, {
          ok: true,
          result: {
            profileId,
            transport: profile.transport,
            status: 'unverified',
            message,
          },
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/providers/preset') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const presetId = normalize(body?.presetId)
        const preset = listProviderPresets().presets.find((entry) => entry.id === presetId)
        if (!preset) {
          return json(res, 404, { error: 'provider_preset_not_found' }, responseHeaders)
        }

        const fallbackProviderProfileIds = normalizeFallbackChain(preset.defaults?.fallbackProviderProfileIds)
        const modelOverridesByProvider = normalizeModelOverrides(getRuntimeDefaults().modelOverridesByProvider)
        if (preset.defaults?.providerProfileId && preset.defaults?.providerModel) {
          modelOverridesByProvider[preset.defaults.providerProfileId] = preset.defaults.providerModel
        }
        const defaults = updateDefaults(runtimeSettings, {
          providerProfileId: preset.defaults?.providerProfileId || '',
          providerModel: preset.defaults?.providerModel || '',
          fallbackProviderProfileId: fallbackProviderProfileIds[0] || '',
          fallbackProviderProfileIds,
          modelOverridesByProvider,
          compactPackKey: preset.defaults?.compactPackKey || '',
          rolePresetId: preset.defaults?.rolePresetId || '',
          taskCommandMode: preset.defaults?.taskCommandMode || '',
        })
        await persistRuntimeSettings()

        return json(res, 200, {
          ok: true,
          message: `Preset applied: ${preset.label}`,
          defaults,
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/providers/presets') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const preset = normalizeCustomPreset(body)
        if (!preset) {
          return json(res, 400, { error: 'provider_preset_invalid' }, responseHeaders)
        }

        const runtimeDefaults = getRuntimeDefaults()
        const current = normalizeCustomPresets(runtimeDefaults.customProviderPresets)
        const next = [
          preset,
          ...current.filter((entry) => entry.id !== preset.id),
        ].slice(0, 100)

        updateDefaults(runtimeSettings, {
          customProviderPresets: next,
        })
        await persistRuntimeSettings()

        return json(res, 200, {
          ok: true,
          customPresets: normalizeCustomPresets(getRuntimeDefaults().customProviderPresets),
        }, responseHeaders)
      }

      const providerPresetDeleteMatch = pathname.match(/^\/providers\/presets\/([^/]+)$/)
      if (req.method === 'DELETE' && providerPresetDeleteMatch) {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const presetId = decodePathSegment(providerPresetDeleteMatch[1])
        const runtimeDefaults = getRuntimeDefaults()
        const next = normalizeCustomPresets(runtimeDefaults.customProviderPresets).filter((entry) => entry.id !== presetId)
        updateDefaults(runtimeSettings, {
          customProviderPresets: next,
        })
        await persistRuntimeSettings()

        return json(res, 200, {
          ok: true,
          customPresets: normalizeCustomPresets(getRuntimeDefaults().customProviderPresets),
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/roles') {
        const runtimeDefaults = getRuntimeDefaults()
        const providerSummary = buildProviderSummary(config, {
          requestedProfileId: runtimeDefaults.providerProfileId,
          fallbackProviderProfileIds: runtimeDefaults.fallbackProviderProfileIds,
          modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
        })
        const modelDiscovery = discoverModelsForProfiles(providerSummary.profiles.map((profile) => profile.id))
        return json(res, 200, {
          ok: true,
          roles: listRolePresets(),
          defaults: buildRoleDefaults(),
          providers: providerSummary.profiles,
          profileModels: Object.fromEntries(
            providerSummary.profiles.map((profile) => [
              profile.id,
              listProviderModels(config, profile.id, {
                modelOverridesByProvider: runtimeDefaults.modelOverridesByProvider,
                discoveredModelsByProfile: modelDiscovery.discoveredByProfile,
              }),
            ]),
          ),
          modelDiscovery: modelDiscovery.detailsByProfile,
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/defaults') {
        return json(res, 200, {
          ok: true,
          defaults: getRuntimeDefaults(),
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/defaults') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const fallbackProviderProfileIds = normalizeFallbackChain(
          body?.fallbackProviderProfileIds?.length > 0
            ? body.fallbackProviderProfileIds
            : body?.fallbackProviderProfileId,
        )

        const defaults = updateDefaults(runtimeSettings, {
          projectPath: normalize(body?.projectPath),
          providerProfileId: normalize(body?.providerProfileId),
          providerModel: normalize(body?.providerModel),
          fallbackProviderProfileId: normalize(body?.fallbackProviderProfileId) || fallbackProviderProfileIds[0] || '',
          fallbackProviderProfileIds,
          modelOverridesByProvider: normalizeModelOverrides(body?.modelOverridesByProvider),
          customProviderPresets: normalizeCustomPresets(body?.customProviderPresets),
          roleRoutes: normalizeRoleRoutes(body?.roleRoutes),
          agentIdentity: isPlainObject(body?.agentIdentity) ? body.agentIdentity : {},
          roleIdentityMap: isPlainObject(body?.roleIdentityMap) ? body.roleIdentityMap : {},
          rolePresetId: normalize(body?.rolePresetId),
          compactPackKey: normalize(body?.compactPackKey),
          workMode: normalize(body?.workMode),
          skillIds: normalizeStringArray(body?.skillIds),
          evaluateLoop: normalizeEvaluateLoopInput(body?.evaluateLoop),
          taskCommandMode: normalize(body?.taskCommandMode),
          activePackRoles: Array.isArray(body?.activePackRoles) ? body.activePackRoles : [],
        })
        await persistRuntimeSettings()

        return json(res, 200, {
          ok: true,
          defaults,
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/connections') {
        return json(res, 200, {
          ok: true,
          connections: connectorManager.listConnectors(),
          supportedPlatforms: listSupportedPlatforms(),
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/connections/test') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        try {
          const connection = await connectorManager.testConnector(normalize(body?.key || body?.connectorId))
          return json(res, 200, {
            ok: true,
            connection,
          }, responseHeaders)
        } catch (err) {
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) }, responseHeaders)
        }
      }

      if (req.method === 'POST' && pathname === '/connections') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        try {
          const connection = await connectorManager.registerConnector({
            platform: body?.platform,
            accountId: body?.accountId,
            channelId: body?.channelId || body?.agentId,
            threadId: body?.threadId,
            connectorId: body?.connectorId,
            projectPath: body?.projectPath,
            providerProfileId: body?.providerProfileId,
            providerModel: body?.providerModel,
            fallbackProviderProfileId: body?.fallbackProviderProfileId,
            fallbackProviderProfileIds: body?.fallbackProviderProfileIds,
            rolePresetId: body?.rolePresetId,
            compactPackKey: body?.compactPackKey,
            agentPackKey: body?.agentPackKey || body?.compactPackKey,
            roleKey: body?.roleKey || body?.agentId,
            activePackRoles: body?.activePackRoles,
            agentId: body?.agentId,
            enabled: body?.enabled,
            config: isPlainObject(body?.config) ? body.config : {
              token: body?.token,
              botToken: body?.botToken || body?.token,
              guildId: body?.guildId,
              channelId: body?.channelId || body?.agentId,
              chatId: body?.chatId || body?.channelId || body?.agentId,
              phoneNumberId: body?.phoneNumberId,
              accessToken: body?.accessToken || body?.token,
              webhookVerifyToken: body?.webhookVerifyToken,
              projectPath: body?.projectPath,
            },
          })
          return json(res, 200, {
            ok: true,
            connection,
            connections: connectorManager.listConnectors(),
          }, responseHeaders)
        } catch (err) {
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) }, responseHeaders)
        }
      }

      if (req.method === 'DELETE' && pathname === '/connections') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const route = body?.key
          ? parseConnectionKey(body.key, config)
          : {
              platform: body?.platform,
              accountId: body?.accountId,
              channelId: body?.channelId,
              threadId: body?.threadId,
            }
        const connectorLookupKey = body?.key || toChannelRouteKey(route, {
          defaultPlatform: config.defaultPlatform,
          defaultAccountId: config.defaultAccountId,
        })
        const { key, removed } = await connectorManager.removeConnector(connectorLookupKey)

        return json(res, 200, {
          ok: true,
          key,
          removed,
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/skills') {
        return json(res, 200, {
          ok: true,
          skills: await listLoadedSkills({
            skillDir: config.runtimePaths.skillDir,
          }),
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/skills/import') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        let skill
        if (normalize(body?.url)) {
          skill = await loadSkillFromUrl(normalize(body.url))
        } else if (normalize(body?.path)) {
          skill = await loadSkillFromPath(normalize(body.path))
        } else if (normalize(body?.content)) {
          skill = {
            id: normalize(body?.id),
            name: normalize(body?.name) || 'Imported Skill',
            description: normalize(body?.description),
            tags: normalizeStringArray(body?.tags),
            triggers: normalizeStringArray(body?.triggers),
            source: normalize(body?.source) || 'inline',
            body: normalize(body?.content),
          }
        } else {
          return json(res, 400, { error: 'skill_source_required' }, responseHeaders)
        }
        const savedSkill = await saveLoadedSkill(skill, {
          skillDir: config.runtimePaths.skillDir,
        })
        return json(res, 200, {
          ok: true,
          skill: savedSkill,
          skills: await listLoadedSkills({
            skillDir: config.runtimePaths.skillDir,
          }),
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/skills/match') {
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const skills = await listLoadedSkills({
          skillDir: config.runtimePaths.skillDir,
        })
        return json(res, 200, {
          ok: true,
          matches: matchSkillsToTask(normalize(body?.text), skills),
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/packs') {
        return json(res, 200, {
          ok: true,
          defaultCompactPackKey: config.defaultCompactPackKey,
          packs: listCompactPacks(config),
          configIssues: config.configIssues,
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/summary') {
        return json(res, 200, buildSummaryPayload(), responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/maintenance/prune') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const result = pruneExpiredState({
          dryRun: body?.dryRun === true,
          now: Date.now(),
        })
        return json(res, 200, {
          ok: true,
          ...result,
          remaining: {
            channelRoutes: runtimeChannelRouteMap.size,
            projectRoutes: runtimeProjectRouteMap.size,
            taskRoutes: runtimeTaskRouteMap.size,
            managedTasks: managedTaskSet.size,
          },
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/ingest') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }

        const parsed = validateIngestBody(await readBody(req, { maxBytes: config.maxIngestBodyBytes }), config)
        const result = await executeIngestWithDedupe(parsed, requestId)
        return json(res, 200, {
          ...result,
          requestId,
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/schedules') {
        return json(res, 200, {
          ok: true,
          schedules: scheduleManager.listSchedules(),
          summary: scheduleManager.countSchedules(),
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/schedules') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const schedule = await scheduleManager.createSchedule(body)
        return json(res, 200, {
          ok: true,
          schedule,
        }, responseHeaders)
      }

      const schedulePatchMatch = pathname.match(/^\/schedules\/([^/]+)$/)
      if (req.method === 'PATCH' && schedulePatchMatch) {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const scheduleId = decodePathSegment(schedulePatchMatch[1])
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const schedule = await scheduleManager.updateSchedule(scheduleId, body)
        if (!schedule) {
          return json(res, 404, { error: 'schedule_not_found' }, responseHeaders)
        }
        return json(res, 200, {
          ok: true,
          schedule,
        }, responseHeaders)
      }

      if (req.method === 'DELETE' && schedulePatchMatch) {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const scheduleId = decodePathSegment(schedulePatchMatch[1])
        const removed = await scheduleManager.deleteSchedule(scheduleId)
        return json(res, 200, {
          ok: true,
          removed,
        }, responseHeaders)
      }

      const scheduleRunMatch = pathname.match(/^\/schedules\/([^/]+)\/run$/)
      if (req.method === 'POST' && scheduleRunMatch) {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const scheduleId = decodePathSegment(scheduleRunMatch[1])
        const schedule = await scheduleManager.runScheduleNow(scheduleId)
        if (!schedule) {
          return json(res, 404, { error: 'schedule_not_found' }, responseHeaders)
        }
        return json(res, 200, {
          ok: true,
          schedule,
        }, responseHeaders)
      }

      if (req.method === 'POST' && pathname === '/tasks') {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        if (!standaloneTaskManager) {
          return json(res, 400, { error: 'standalone_runner_unavailable' }, responseHeaders)
        }

        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const text = normalize(body?.text)
        if (!text) {
          return json(res, 400, { error: 'command_text_required' }, responseHeaders)
        }

        const runtimeDefaults = getRuntimeDefaults()
        const fallbackProviderProfileIds = normalizeFallbackChain(
          body?.fallbackProviderProfileIds?.length > 0
            ? body.fallbackProviderProfileIds
            : body?.fallbackProviderProfileId || runtimeDefaults.fallbackProviderProfileIds,
        )
        const route = normalizeChannelEnvelope({
          platform: body?.platform || 'cli',
          accountId: body?.accountId || 'local',
          channelId: body?.channelId || 'dashboard',
          threadId: body?.threadId,
          connectorId: body?.connectorId || 'dashboard',
          senderId: body?.senderId,
          senderName: body?.senderName || 'dashboard',
        }, {
          defaultPlatform: config.defaultPlatform,
          defaultAccountId: config.defaultAccountId,
        })

        const task = await standaloneTaskManager.createTask({
          text: text.startsWith('#') || text.startsWith('$') ? text : `# ${text}`,
          commandType: detectCommandType(text, normalize(body?.commandType)) || 'task',
          projectPath: normalize(body?.projectPath) || runtimeDefaults.projectPath || config.defaultProjectPath,
          platform: route.platform,
          accountId: route.accountId,
          channelId: route.channelId,
          threadId: route.threadId,
          connectorId: route.connectorId,
          senderId: route.senderId,
          senderName: route.senderName,
          providerProfileId: normalize(body?.providerProfileId) || runtimeDefaults.providerProfileId,
          providerModel: normalize(body?.providerModel) || runtimeDefaults.providerModel,
          compactPackKey: normalize(body?.compactPackKey) || runtimeDefaults.compactPackKey,
          fallbackProviderProfileId: normalize(body?.fallbackProviderProfileId) || fallbackProviderProfileIds[0] || '',
          fallbackProviderProfileIds,
          rolePresetId: normalize(body?.rolePresetId) || runtimeDefaults.rolePresetId,
          roleKey: normalize(body?.roleKey),
          activePackRoles: normalizeStringArray(body?.activePackRoles).length > 0
            ? normalizeStringArray(body?.activePackRoles)
            : runtimeDefaults.activePackRoles,
          workMode: normalize(body?.workMode) || runtimeDefaults.workMode,
          skillIds: normalizeStringArray(body?.skillIds).length > 0
            ? normalizeStringArray(body?.skillIds)
            : runtimeDefaults.skillIds,
          evaluateLoop: body?.evaluateLoop && typeof body.evaluateLoop === 'object' && !Array.isArray(body.evaluateLoop)
            ? normalizeEvaluateLoopInput(body.evaluateLoop)
            : normalizeEvaluateLoopInput(runtimeDefaults.evaluateLoop),
          agentIdentity: runtimeDefaults.agentIdentity,
          roleIdentityMap: runtimeDefaults.roleIdentityMap,
          priority: normalizeTaskPriority(body?.priority),
          requiresApproval: normalizeBooleanFlag(body?.requiresApproval, false),
        })

        let approval = null
        let persistedTask = task
        if (task.approvalRequired && standaloneApprovalManager) {
          approval = await standaloneApprovalManager.createApproval({
            taskId: task.id,
            taskTitle: task.title,
            taskDescription: task.description,
            priority: task.priority,
            rolePresetId: task.rolePresetId,
            projectPath: task.projectPath,
            taskCommandMode: task.taskCommandMode,
            requestedBy: route.senderName || route.senderId || 'dashboard',
          })
          persistedTask = await standaloneTaskManager.setTaskApproval(task.id, {
            approvalRequired: true,
            approvalStatus: 'pending',
            approvalId: approval.id,
          })
        }

        const runResult = body?.runNow === false || approval
          ? { started: false, reason: approval ? 'task_approval_pending' : 'queued', task: persistedTask }
          : await standaloneTaskManager.runTask(task.id)

        registerTaskRoute(
          task.id,
          route,
          persistedTask?.projectPath || task.projectPath,
          persistedTask?.title || task.title,
        )

        return json(res, 200, {
          ok: true,
          task: standaloneTaskManager.getTask(task.id),
          runResult,
          approvalId: approval?.id || '',
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/runs') {
        if (!standaloneTaskManager) {
          return json(res, 200, {
            ok: true,
            runs: [],
            summary: {
              countsByStatus: {},
            },
          }, responseHeaders)
        }

        const runs = standaloneTaskManager.listRuns({
          status: requestUrl.searchParams.get('status') || '',
          q: requestUrl.searchParams.get('q') || '',
          taskId: requestUrl.searchParams.get('taskId') || requestUrl.searchParams.get('task_id') || '',
          limit: parseLimit(requestUrl.searchParams.get('limit')),
        })

        const countsByStatus = {}
        for (const run of runs) {
          const status = normalize(run?.status) || 'unknown'
          countsByStatus[status] = (countsByStatus[status] || 0) + 1
        }

        return json(res, 200, {
          ok: true,
          runs,
          summary: {
            countsByStatus,
          },
        }, responseHeaders)
      }

      const runDetailMatch = pathname.match(/^\/runs\/([^/]+)$/)
      if (req.method === 'GET' && runDetailMatch && standaloneTaskManager) {
        const runId = decodePathSegment(runDetailMatch[1])
        const runBundle = standaloneTaskManager.getRun(runId)
        if (!runBundle) {
          return json(res, 404, { error: 'run_not_found' }, responseHeaders)
        }

        const run = runBundle.run
        const task = runBundle.task
        return json(res, 200, {
          ok: true,
          task,
          run,
          artifacts: {
            briefFile: {
              preview: run?.summary ? `# Brief\n\n${run.summary}` : 'No brief preview available.',
            },
            resultFile: {
              preview: JSON.stringify({
                status: run?.status || 'unknown',
                mode: run?.mode || '',
                error: run?.error || '',
              }, null, 2),
            },
            logFile: {
              preview: run?.error || run?.summary || 'No log preview available.',
            },
          },
        }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/tasks') {
        if (!standaloneTaskManager) {
          return json(res, 200, {
            ok: true,
            tasks: [],
            summary: {
              total: 0,
              countsByStatus: {},
              countsByType: {},
              countsByPriority: {},
              approvalsPending: 0,
              runnerConfigured: false,
              activeRuns: 0,
            },
          }, responseHeaders)
        }

        const tasks = standaloneTaskManager.listTasks({
          status: requestUrl.searchParams.get('status') || '',
          commandType: requestUrl.searchParams.get('commandType') || requestUrl.searchParams.get('command_type') || '',
          priority: requestUrl.searchParams.get('priority') || '',
          query: requestUrl.searchParams.get('q') || '',
          limit: parseLimit(requestUrl.searchParams.get('limit')),
        })

        return json(res, 200, {
          ok: true,
          tasks,
          summary: standaloneTaskManager.countTasks(),
        }, responseHeaders)
      }

      const taskRunsMatch = pathname.match(/^\/tasks\/([^/]+)\/runs$/)
      if (req.method === 'GET' && taskRunsMatch && standaloneTaskManager) {
        const taskId = decodePathSegment(taskRunsMatch[1])
        const runs = standaloneTaskManager.listTaskRuns(taskId)
        return json(res, 200, {
          ok: true,
          taskId,
          runs,
        }, responseHeaders)
      }

      const taskDetailMatch = pathname.match(/^\/tasks\/([^/]+)$/)
      if (req.method === 'GET' && taskDetailMatch && standaloneTaskManager) {
        const taskId = decodePathSegment(taskDetailMatch[1])
        const task = standaloneTaskManager.getTask(taskId)
        if (!task) {
          return json(res, 404, { error: 'task_not_found' }, responseHeaders)
        }
        return json(res, 200, { ok: true, task }, responseHeaders)
      }

      const taskPriorityMatch = pathname.match(/^\/tasks\/([^/]+)\/priority$/)
      if (req.method === 'POST' && taskPriorityMatch && standaloneTaskManager) {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const taskId = decodePathSegment(taskPriorityMatch[1])
        const body = await readBody(req, { maxBytes: config.maxIngestBodyBytes })
        const updatedTask = await standaloneTaskManager.updateTaskPriority(taskId, body?.priority)
        if (!updatedTask) {
          return json(res, 404, { error: 'task_not_found' }, responseHeaders)
        }
        return json(res, 200, { ok: true, task: updatedTask }, responseHeaders)
      }

      const taskRunMatch = pathname.match(/^\/tasks\/([^/]+)\/run$/)
      if (req.method === 'POST' && taskRunMatch && standaloneTaskManager) {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const taskId = decodePathSegment(taskRunMatch[1])
        const runResult = await standaloneTaskManager.runTask(taskId)
        if (runResult.reason === 'task_missing') {
          return json(res, 404, { error: 'task_not_found' }, responseHeaders)
        }
        if (runResult.reason === 'task_approval_pending') {
          return json(res, 409, { error: 'task_approval_pending', task: runResult.task }, responseHeaders)
        }
        return json(res, 200, { ok: true, runResult, task: runResult.task || standaloneTaskManager.getTask(taskId) }, responseHeaders)
      }

      if (req.method === 'GET' && pathname === '/approvals' && standaloneApprovalManager) {
        const approvals = standaloneApprovalManager.listApprovals({
          status: requestUrl.searchParams.get('status') || '',
          query: requestUrl.searchParams.get('q') || '',
          taskId: requestUrl.searchParams.get('taskId') || requestUrl.searchParams.get('task_id') || '',
          limit: Number.parseInt(String(requestUrl.searchParams.get('limit') || ''), 10) || 0,
        })
        return json(res, 200, {
          ok: true,
          approvals,
          summary: standaloneApprovalManager.countApprovals(),
        }, responseHeaders)
      }

      const approvalDetailMatch = pathname.match(/^\/approvals\/([^/]+)$/)
      if (req.method === 'GET' && approvalDetailMatch && standaloneApprovalManager) {
        const approvalId = decodePathSegment(approvalDetailMatch[1])
        const approval = standaloneApprovalManager.getApproval(approvalId)
        if (!approval) {
          return json(res, 404, { error: 'approval_not_found' }, responseHeaders)
        }
        return json(res, 200, { ok: true, approval }, responseHeaders)
      }

      const approvalApproveMatch = pathname.match(/^\/approvals\/([^/]+)\/approve$/)
      if (req.method === 'POST' && approvalApproveMatch && standaloneApprovalManager && standaloneTaskManager) {
        if (!requireSecret(req)) {
          return json(res, 401, { error: 'unauthorized' }, responseHeaders)
        }
        const approvalId = decodePathSegment(approvalApproveMatch[1])
        const decision = await standaloneApprovalManager.approveApproval(approvalId, {})
        if (!decision.approval) {
          return json(res, 404, { error: 'approval_not_found' }, responseHeaders)
        }
        if (!decision.applied) {
          return json(res, 409, { error: 'approval_not_pending', approval: decision.approval }, responseHeaders)
        }

        const task = await standaloneTaskManager.setTaskApproval(decision.approval.taskId, {
          approvalRequired: true,
          approvalStatus: 'approved',
          approvalId: decision.approval.id,
        })
        const runResult = await standaloneTaskManager.runTask(decision.approval.taskId)

        return json(res, 200, {
          ok: true,
          approval: decision.approval,
          task,
          runResult,
        }, responseHeaders)
      }

      return json(res, 404, { error: 'not_found' }, responseHeaders)
    } catch (err) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500
      const message = err?.code || (err instanceof Error ? err.message : String(err))
      if (statusCode >= 500) {
        logError('request_failed', {
          requestId,
          method: req.method,
          url: req.url,
          error: message,
        })
      } else {
        logWarn('request_rejected', {
          requestId,
          method: req.method,
          url: req.url,
          error: message,
        })
      }
      return json(res, statusCode, { error: message, requestId }, responseHeaders)
    }
  })

  let listenHost = '127.0.0.1'

  async function start(options = {}) {
    if (server.listening) return server.address()
    listenHost = options.host || '127.0.0.1'
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.port ?? config.port, listenHost)
    })
    if (config.connectorBackend !== 'none') statusRelay.start()
    scheduleManager.start()
    logInfo('bridge_started', {
      url: getListenUrl(),
      mode: config.taskCommandMode,
      configIssues: config.configIssues,
    })
    return server.address()
  }

  async function stop() {
    statusRelay.stop()
    await scheduleManager.stop()
    await standaloneTaskManager?.stop()
    await flushBridgeState()
    if (!server.listening) return
    await new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  function getListenUrl() {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : config.port
    return `http://${listenHost}:${port}`
  }

  return {
    config,
    server,
    statusRelay,
    scheduleManager,
    start,
    stop,
    getListenUrl,
    getStateSnapshot: snapshotState,
    pruneExpiredState,
  }
}

function isDirectExecution() {
  const entry = process.argv[1]
  return !!entry && import.meta.url === pathToFileURL(entry).href
}

async function main() {
  const bridge = createBridgeServer()
  await bridge.start()
  console.log(`[agentsswarm] bridge listening on ${bridge.getListenUrl()}`)

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void bridge.stop().finally(() => process.exit(0))
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (isDirectExecution()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[agentsswarm] bridge failed: ${message}\n`)
    process.exit(1)
  })
}

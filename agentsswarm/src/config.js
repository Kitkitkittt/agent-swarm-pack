import fs from 'node:fs'
import path from 'node:path'
import { normalizeChannelRouteMap, normalizePlatform } from './channels.js'
import {
  getPackageRoot,
  resolveDataDir,
  resolveEnvFilePath,
  resolveScheduleFilePath,
  resolveSettingsFilePath,
  resolveSkillDir,
  resolveStandaloneApprovalFilePath,
  resolveStandaloneTaskFilePath,
  resolveStandaloneTaskRunDir,
  resolveStateFilePath,
  resolveTemplateDir,
} from './runtime-paths.js'

function loadEnvFile(filePath, target = process.env) {
  if (!fs.existsSync(filePath)) return
  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    if (!key) continue
    if (target[key] != null && String(target[key]).trim() !== '') continue
    const rawValue = trimmed.slice(idx + 1).trim()
    target[key] = rawValue.replace(/^['\"]|['\"]$/g, '')
  }
}

export function ensureEnvLoaded(env = process.env) {
  loadEnvFile(resolveEnvFilePath(env), env)
}

function asBool(value, fallback) {
  if (value == null) return fallback
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function asInt(value, fallback, options = {}) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  const min = Number.isFinite(options.min) ? options.min : 1
  const max = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY
  if (parsed < min) return fallback
  if (parsed > max) return max
  return parsed
}

function asList(value, fallback = []) {
  const source = String(value || '').trim()
  const items = source
    ? source.split(',').map((item) => item.trim()).filter(Boolean)
    : fallback
  return Array.from(new Set(items))
}

function runnerArguments(value) {
  if (!String(value || '').trim()) return []
  let parsed
  try { parsed = JSON.parse(value) } catch { throw new Error('STANDALONE_TASK_RUNNER_ARGS must be a JSON string array.') }
  if (!Array.isArray(parsed) || parsed.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new Error('STANDALONE_TASK_RUNNER_ARGS must be a JSON string array.')
  }
  return parsed
}

function normalizeUrl(value, fallback) {
  const raw = String(value || '').trim()
  const selected = raw || fallback
  if (/^https?:\/\//i.test(selected)) return selected.replace(/\/+$/, '')
  return `http://${selected}`.replace(/\/+$/, '')
}

function addIssue(issues, message) {
  issues.push(message)
}

function parseJsonOverride(raw, issues, label, options = {}) {
  const source = String(raw || '').trim()
  if (!source) return null
  try {
    const parsed = JSON.parse(source)
    if (Array.isArray(parsed)) {
      if (options.allowArray) return parsed
      addIssue(issues, `${label} must be a JSON object.`)
      return null
    }
    if (parsed && typeof parsed === 'object') {
      if (options.allowObject !== false) return parsed
      addIssue(issues, `${label} must be a JSON array.`)
      return null
    }
    addIssue(issues, `${label} must be valid JSON ${options.allowArray ? 'array or object' : 'object'}.`)
    return null
  } catch {
    addIssue(issues, `${label} contains invalid JSON.`)
    return null
  }
}

function resolveTaskCommandMode(value, issues) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'hybrid'
  if (normalized === 'board_only' || normalized === 'hybrid') return normalized
  if (normalized === 'direct_run') {
    addIssue(issues, 'TASK_COMMAND_MODE=direct_run is deprecated and now behaves as hybrid.')
    return 'hybrid'
  }
  addIssue(issues, `TASK_COMMAND_MODE=${normalized} is invalid; falling back to hybrid.`)
  return 'hybrid'
}

function resolveExecutionBackend(value, issues) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'standalone'
  if (['standalone', 'remote_api'].includes(normalized)) return normalized
  addIssue(issues, `TASK_EXECUTION_BACKEND=${normalized} is invalid; falling back to standalone.`)
  return 'standalone'
}

function resolveConnectorBackend(value, issues) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'none'
  if (['none', 'external_connector'].includes(normalized)) return normalized
  addIssue(issues, `CONNECTOR_BACKEND=${normalized} is invalid; falling back to none.`)
  return 'none'
}

function validateAbsolutePath(issues, label, value) {
  const text = String(value || '').trim()
  if (!text) return
  if (!path.isAbsolute(text)) {
    addIssue(issues, `${label} should be an absolute path.`)
  }
}

export function loadConfig(env = process.env, options = {}) {
  if (env === process.env) {
    ensureEnvLoaded(env)
  }

  const issues = []
  const defaultPlatform = normalizePlatform(env.DEFAULT_PLATFORM, 'telegram')
  const defaultAccountId = String(env.DEFAULT_ACCOUNT_ID || '').trim() || 'primary'
  const allowUnsecuredBridge = asBool(env.ALLOW_UNSECURED_BRIDGE, String(env.NODE_ENV || '').trim() === 'development')
  const routeMapRaw = parseJsonOverride(env.PROJECT_ROUTE_MAP_JSON, issues, 'PROJECT_ROUTE_MAP_JSON') || {}
  const channelRouteMapRaw = parseJsonOverride(env.CHANNEL_ROUTE_MAP_JSON, issues, 'CHANNEL_ROUTE_MAP_JSON') || {}
  parseJsonOverride(env.AGENTSSWARM_PROVIDER_PROFILES_JSON, issues, 'AGENTSSWARM_PROVIDER_PROFILES_JSON', {
    allowArray: true,
  })
  parseJsonOverride(env.AGENTSSWARM_PACKS_JSON, issues, 'AGENTSSWARM_PACKS_JSON', {
    allowArray: true,
  })
  const packageRoot = getPackageRoot()
  const defaultProjectPath = String(env.DEFAULT_PROJECT_PATH || '').trim()
  const executionBackend = resolveExecutionBackend(env.TASK_EXECUTION_BACKEND, issues)
  const connectorBackend = resolveConnectorBackend(env.CONNECTOR_BACKEND, issues)
  const standaloneAllowedProjectRoots = asList(
    env.STANDALONE_ALLOWED_PROJECT_ROOTS,
    defaultProjectPath ? [defaultProjectPath] : [packageRoot],
  ).map((entry) => path.resolve(entry))

  const config = {
    port: asInt(env.BRIDGE_PORT, 7799),
    bridgeSecret: String(env.BRIDGE_SECRET || '').trim(),
    allowUnsecuredBridge,
    executionBackend,
    connectorBackend,
    swarmclawUrl: normalizeUrl(env.SWARMCLAW_URL, 'http://127.0.0.1:3456'),
    swarmclawAccessKey: String(env.SWARMCLAW_ACCESS_KEY || '').trim(),
    connectorApiKey: String(env.CONNECTOR_API_KEY || env.SWARMCLAW_ACCESS_KEY || '').trim(),
    agentsswarmApiUrl: normalizeUrl(env.AGENTSSWARM_API_URL || env.CLAW_EMPIRE_URL, 'http://127.0.0.1:8790'),
    remoteApiUrl: normalizeUrl(env.REMOTE_API_URL || env.AGENTSSWARM_API_URL || env.CLAW_EMPIRE_URL, 'http://127.0.0.1:8790'),
    agentsswarmAuthToken: String(env.AGENTSSWARM_AUTH_TOKEN || env.CLAW_EMPIRE_AUTH_TOKEN || '').trim(),
    inboxWebhookSecret: String(env.INBOX_WEBHOOK_SECRET || '').trim(),
    remoteInboxSecret: String(env.REMOTE_INBOX_SECRET || env.INBOX_WEBHOOK_SECRET || '').trim(),
    defaultProjectPath,
    defaultPlatform,
    defaultAccountId,
    defaultRoute: {
      connectorId: String(env.DEFAULT_MANAGER_CONNECTOR_ID || '').trim(),
      channelId: String(env.DEFAULT_MANAGER_CHANNEL_ID || '').trim(),
      platform: normalizePlatform(env.DEFAULT_MANAGER_PLATFORM, defaultPlatform),
      accountId: String(env.DEFAULT_MANAGER_ACCOUNT_ID || '').trim() || defaultAccountId,
      threadId: String(env.DEFAULT_MANAGER_THREAD_ID || '').trim(),
    },
    routeMap: routeMapRaw,
    channelRouteMap: normalizeChannelRouteMap(channelRouteMapRaw, {
      defaultPlatform,
      defaultAccountId,
    }),
    statusRelayEnabled: asBool(env.STATUS_RELAY_ENABLED, true),
    statusRelayManagedOnly: asBool(env.STATUS_RELAY_MANAGED_ONLY, true),
    statusRelayIntervalMs: asInt(env.STATUS_RELAY_INTERVAL_MS, 6000),
    directiveSkipPlannedMeeting: asBool(env.DIRECTIVE_SKIP_PLANNED_MEETING, true),
    taskCommandMode: resolveTaskCommandMode(env.TASK_COMMAND_MODE, issues),
    compactAgentLimit: Math.min(asInt(env.COMPACT_AGENT_LIMIT, 8), 8),
    enforceCompactProjectScope: asBool(env.ENFORCE_COMPACT_PROJECT_SCOPE, true),
    defaultCompactPackKey: String(env.DEFAULT_COMPACT_PACK || 'software-6').trim() || 'software-6',
    defaultProviderProfileId: String(env.DEFAULT_PROVIDER_PROFILE || 'codex-main').trim() || 'codex-main',
    providerProfilesRaw: String(env.AGENTSSWARM_PROVIDER_PROFILES_JSON || '').trim(),
    compactPacksRaw: String(env.AGENTSSWARM_PACKS_JSON || '').trim(),
    requiredCliToolIds: asList(env.AGENTSSWARM_REQUIRED_CLI_TOOLS, ['openclaw', 'codex']),
    supportedPlatforms: asList(env.AGENTSSWARM_SUPPORTED_PLATFORMS, ['telegram', 'discord', 'whatsapp', 'slack', 'cli']),
    maxIngestBodyBytes: asInt(env.MAX_INGEST_BODY_BYTES, 64 * 1024),
    ingestMessageIdTtlMs: asInt(env.INGEST_MESSAGE_ID_TTL_MS, 5 * 60 * 1000),
    channelRouteTtlMs: asInt(env.CHANNEL_ROUTE_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    projectRouteTtlMs: asInt(env.PROJECT_ROUTE_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    taskRouteTtlMs: asInt(env.TASK_ROUTE_TTL_MS, 3 * 24 * 60 * 60 * 1000),
    projectPathCacheTtlMs: asInt(env.PROJECT_PATH_CACHE_TTL_MS, 5 * 60 * 1000),
    httpRetryMaxAttempts: asInt(env.HTTP_RETRY_MAX_ATTEMPTS, 2, { min: 1, max: 5 }),
    httpRetryBaseDelayMs: asInt(env.HTTP_RETRY_BASE_DELAY_MS, 250),
    standaloneTaskRunnerCommand: String(env.STANDALONE_TASK_RUNNER_COMMAND || '').trim(),
    standaloneTaskRunnerArgs: runnerArguments(env.STANDALONE_TASK_RUNNER_ARGS),
    standaloneTaskRunnerTimeoutMs: asInt(env.STANDALONE_TASK_RUNNER_TIMEOUT_MS, 5 * 60 * 1000),
    standaloneTaskRunnerConcurrency: asInt(env.STANDALONE_TASK_RUNNER_CONCURRENCY, 2, { min: 1, max: 20 }),
    standaloneAllowedProjectRoots,
    configIssues: issues,
    runtimePaths: {
      packageRoot,
      envFile: resolveEnvFilePath(env),
      dataDir: resolveDataDir(env),
      stateFile: resolveStateFilePath(env),
      settingsFile: resolveSettingsFilePath(env),
      templateDir: resolveTemplateDir(env),
      skillDir: resolveSkillDir(env),
      standaloneApprovalFile: resolveStandaloneApprovalFilePath(env),
      standaloneTaskFile: resolveStandaloneTaskFilePath(env),
      standaloneTaskRunDir: resolveStandaloneTaskRunDir(env),
      scheduleFile: resolveScheduleFilePath(env),
    },
  }

  validateAbsolutePath(issues, 'DEFAULT_PROJECT_PATH', config.defaultProjectPath)
  for (const root of config.standaloneAllowedProjectRoots) {
    validateAbsolutePath(issues, 'STANDALONE_ALLOWED_PROJECT_ROOTS', root)
  }

  if (!config.bridgeSecret && config.allowUnsecuredBridge) {
    addIssue(issues, 'ALLOW_UNSECURED_BRIDGE is enabled; /ingest accepts unauthenticated requests.')
  }

  if (options.validateRequired === false) {
    return config
  }

  const requiredIssues = []
  if (!config.bridgeSecret && !config.allowUnsecuredBridge) {
    requiredIssues.push('BRIDGE_SECRET is required unless ALLOW_UNSECURED_BRIDGE=true.')
  }
  if (config.connectorBackend === 'external_connector' && !config.connectorApiKey) {
    requiredIssues.push('CONNECTOR_API_KEY is required for external_connector.')
  }
  if (config.executionBackend === 'remote_api' && !config.remoteInboxSecret) {
    requiredIssues.push('REMOTE_INBOX_SECRET is required for remote_api.')
  }

  if (requiredIssues.length > 0) {
    throw new Error(requiredIssues.join(' '))
  }

  return config
}

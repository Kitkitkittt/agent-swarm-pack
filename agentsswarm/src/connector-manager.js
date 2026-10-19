import { listSupportedPlatforms, normalizeAccountId, toChannelRouteKey, validatePlatformConfig } from './channels.js'
import { listConnections } from './runtime-settings.js'
import { normalizeBooleanFlag } from './task-fields.js'

const text = (value) => typeof value === 'string' ? value.trim() : ''
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode })
const stringFields = ['projectPath', 'providerProfileId', 'providerModel', 'fallbackProviderProfileId', 'rolePresetId', 'compactPackKey', 'agentPackKey', 'roleKey', 'agentId']

export function createConnectorManager({ settings, config = {}, persist = async () => {}, tester, onRegistered, onRemoved }) {
  if (!object(settings.connections)) settings.connections = {}
  let queue = Promise.resolve()
  function serial(action) {
    const next = queue.catch(() => {}).then(action)
    queue = next
    return next
  }
  const listConnectors = () => listConnections(settings)
  const publicConnection = (key) => listConnectors().find((entry) => entry.key === key)
  const lookup = (value) => Object.hasOwn(settings.connections, value) ? value : Object.keys(settings.connections).find((key) => settings.connections[key].connectorId === value)

  async function saveChange(key, connection) {
    const previous = settings.connections[key]
    if (connection) Object.defineProperty(settings.connections, key, { value: connection, writable: true, enumerable: true, configurable: true })
    else delete settings.connections[key]
    try { await persist() } catch {
      if (previous) Object.defineProperty(settings.connections, key, { value: previous, writable: true, enumerable: true, configurable: true })
      else delete settings.connections[key]
      throw failure('connector_persist_failed', 500)
    }
  }

  return {
    listConnectors,
    registerConnector(input = {}) {
      return serial(async () => {
        const platform = text(input.platform || config.defaultPlatform).toLowerCase()
        if (!listSupportedPlatforms().includes(platform)) throw failure('connector_platform_invalid')
        const privateConfig = object(input.config) ? structuredClone(input.config) : {}
        if (platform === 'cli' && !privateConfig.projectPath) privateConfig.projectPath = text(input.projectPath)
        const validation = validatePlatformConfig(platform, privateConfig)
        if (!validation.valid) throw failure(`connector_config_required:${validation.missingFields.join(',')}`)
        const connection = {
          platform,
          accountId: normalizeAccountId(input.accountId, config.defaultAccountId),
          channelId: text(input.channelId) || text(privateConfig.channelId) || text(privateConfig.chatId),
          threadId: text(input.threadId),
          enabled: normalizeBooleanFlag(input.enabled, true),
          config: privateConfig,
          status: 'unverified',
          updatedAt: new Date().toISOString(),
        }
        if ([connection.accountId, connection.channelId, connection.threadId].some((value) => value.includes('|') || value.length > 256)) throw failure('connector_route_invalid')
        for (const field of stringFields) connection[field] = text(input[field])
        connection.projectPath ||= text(privateConfig.projectPath)
        connection.key = toChannelRouteKey(connection)
        connection.connectorId = text(input.connectorId) || connection.key
        connection.fallbackProviderProfileIds = Array.isArray(input.fallbackProviderProfileIds) ? input.fallbackProviderProfileIds.map(text).filter(Boolean).slice(0, 32) : []
        connection.activePackRoles = Array.isArray(input.activePackRoles) ? input.activePackRoles.map(text).filter(Boolean).slice(0, 32) : []
        connection.createdAt = settings.connections[connection.key]?.createdAt || connection.updatedAt
        await saveChange(connection.key, connection)
        if (onRegistered) {
          try { await onRegistered(publicConnection(connection.key)) } catch { throw failure('connector_registration_callback_failed', 500) }
        }
        return publicConnection(connection.key)
      })
    },
    testConnector(keyOrConnectorId) {
      return serial(async () => {
        const key = lookup(text(keyOrConnectorId))
        if (!key) throw failure('connector_not_found', 404)
        const connection = structuredClone(settings.connections[key])
        let result
        try {
          result = tester ? await tester(structuredClone(connection)) : { ok: false, status: 'unverified' }
        } catch { result = { ok: false, status: 'error' } }
        connection.status = result?.ok === true ? 'connected' : (result?.status === 'unverified' ? 'unverified' : 'error')
        connection.lastTestOk = result?.ok === true
        // Do not echo tester messages: third-party errors can contain credentials.
        connection.lastTestMessage = result?.ok === true ? 'connector_test_succeeded' : tester ? 'connector_test_failed' : 'connector_test_not_configured'
        connection.lastTestedAt = new Date().toISOString()
        connection.updatedAt = connection.lastTestedAt
        await saveChange(key, connection)
        return publicConnection(key)
      })
    },
    removeConnector(value) {
      return serial(async () => {
        const key = lookup(text(value))
        if (!key) return { key: text(value), removed: false }
        const connection = publicConnection(key)
        await saveChange(key, null)
        if (onRemoved) {
          try { await onRemoved(key, connection) } catch { throw failure('connector_removal_callback_failed', 500) }
        }
        return { key, removed: true }
      })
    },
  }
}

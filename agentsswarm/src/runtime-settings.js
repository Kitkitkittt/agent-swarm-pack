import { readFileSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveSettingsFilePath } from './runtime-paths.js'

const saves = new Map()
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = (code) => Object.assign(new Error(code), { code, statusCode: 500 })

function emptyDefaults() {
  return {
    projectPath: '', providerProfileId: '', providerModel: '', fallbackProviderProfileId: '',
    fallbackProviderProfileIds: [], modelOverridesByProvider: {}, customProviderPresets: [], roleRoutes: {},
    agentIdentity: { name: '', persona: '', objective: '', voice: '', guardrails: '', soulText: '', identityText: '', systemPrompt: '', tags: [] },
    roleIdentityMap: {}, rolePresetId: '', compactPackKey: '', workMode: '', skillIds: [],
    evaluateLoop: { enabled: false, maxTurns: 10, timeoutMs: 300000, approvalGate: false },
    taskCommandMode: '', activePackRoles: [], updatedAt: '',
  }
}

function settingsPath(config, options) {
  return path.resolve(options.settingsFile || config.runtimePaths?.settingsFile || resolveSettingsFilePath())
}

export function loadRuntimeSettings(config = {}, options = {}) {
  let stored
  try {
    stored = JSON.parse(readFileSync(settingsPath(config, options), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { defaults: emptyDefaults(), connections: {} }
    throw failure('runtime_settings_read_failed')
  }
  if (!isObject(stored) || !isObject(stored.defaults) || !isObject(stored.connections)) {
    throw failure('runtime_settings_invalid')
  }
  return { defaults: { ...emptyDefaults(), ...stored.defaults }, connections: stored.connections }
}

export function saveRuntimeSettings(settings, config = {}, options = {}) {
  const file = settingsPath(config, options)
  let data
  try { data = JSON.stringify(settings, null, 2) + '\n' } catch { return Promise.reject(failure('runtime_settings_invalid')) }
  const previous = saves.get(file) || Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`
    let handle
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(data, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, file)
    } catch {
      throw failure('runtime_settings_write_failed')
    } finally {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
    }
  })
  saves.set(file, pending)
  const cleanup = () => { if (saves.get(file) === pending) saves.delete(file) }
  pending.then(cleanup, cleanup)
  return pending
}

export function listConnections(settings = {}) {
  return Object.entries(isObject(settings.connections) ? settings.connections : {}).map(([key, connection]) => {
    const result = structuredClone(connection)
    result.key = key
    // Config belongs to the private credential store, never to public API responses.
    result.config = Object.fromEntries(Object.keys(isObject(result.config) ? result.config : {}).map((field) => [field, '[redacted]']))
    return result
  })
}

export function updateDefaults(settings, patch = {}) {
  if (!isObject(settings.defaults)) settings.defaults = emptyDefaults()
  const allowed = emptyDefaults()
  for (const key of Object.keys(allowed)) {
    if (key !== 'updatedAt' && Object.hasOwn(patch, key)) settings.defaults[key] = structuredClone(patch[key])
  }
  settings.defaults.updatedAt = new Date().toISOString()
  return settings.defaults
}

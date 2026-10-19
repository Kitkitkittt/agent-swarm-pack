const MAX_KEYS = 256
const increment = (value, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount)
const keyFor = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : 'unknown'

export function createRuntimeMetrics() {
  const startedAt = new Date().toISOString()
  const channels = new Map()
  const packs = new Map()
  const providers = new Map()
  let channelActivity = 0
  let packUsage = 0
  let providerRequests = 0
  let providerFailures = 0
  let providerFailovers = 0

  function boundedKey(map, value) {
    const key = keyFor(value)
    return map.has(key) || map.size < MAX_KEYS - 1 ? key : 'other'
  }

  return {
    recordChannelActivity({ platform } = {}) {
      const key = boundedKey(channels, platform)
      channels.set(key, increment(channels.get(key) || 0))
      channelActivity = increment(channelActivity)
    },
    recordPackUsage({ packKey } = {}) {
      const key = boundedKey(packs, packKey)
      packs.set(key, increment(packs.get(key) || 0))
      packUsage = increment(packUsage)
    },
    recordProviderRequest({ profileId, failed = false, latencyMs } = {}) {
      const key = boundedKey(providers, profileId)
      const row = providers.get(key) || { requests: 0, failures: 0, latencyTotalMs: 0, latencySamples: 0 }
      row.requests = increment(row.requests)
      if (failed) row.failures = increment(row.failures)
      if (Number.isFinite(latencyMs) && latencyMs >= 0) {
        row.latencyTotalMs = increment(row.latencyTotalMs, latencyMs)
        row.latencySamples = increment(row.latencySamples)
      }
      providers.set(key, row)
      providerRequests = increment(providerRequests)
      if (failed) providerFailures = increment(providerFailures)
    },
    recordProviderFailover() { providerFailovers = increment(providerFailovers) },
    snapshot() {
      const byProvider = Object.fromEntries([...providers].map(([key, row]) => [key, {
        ...row,
        averageLatencyMs: row.latencySamples ? row.latencyTotalMs / row.latencySamples : null,
      }]))
      return {
        startedAt,
        generatedAt: new Date().toISOString(),
        domain: {
          channelActivity, packUsage, providerRequests, providerFailures, providerFailovers,
          byPlatform: Object.fromEntries(channels),
          byPack: Object.fromEntries(packs),
          byProvider,
        },
      }
    },
  }
}

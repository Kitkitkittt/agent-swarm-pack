import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFailoverChain,
  buildProviderSummary,
  discoverProviderModels,
  getOpenCodeStatus,
  listProviderModels,
  loadProviderProfiles,
  resolveProviderProfile,
} from '../src/providers.js'

test('provider profiles expose multi-provider defaults including multi-copilot support', () => {
  const profiles = loadProviderProfiles({})
  const ids = profiles.map((profile) => profile.id)
  assert.ok(ids.includes('codex-main'))
  assert.ok(ids.includes('copilot-review'))
  assert.ok(ids.includes('claude-cli'))
})

test('provider summary marks required cli tools and missing installs', () => {
  const summary = buildProviderSummary(
    {
      requiredCliToolIds: ['openclaw', 'codex'],
    },
    {
      runner: (_command, args) => ({ status: args[0] === 'codex' ? 0 : 1 }),
    },
  )

  const required = summary.cliTools.filter((tool) => tool.required)
  assert.deepEqual(required.map((tool) => tool.id), ['openclaw', 'codex'])
  assert.deepEqual(summary.missingRequiredCliTools, ['openclaw'])
})

test('provider resolution honors explicit profile ids', () => {
  const profile = resolveProviderProfile({}, 'copilot-review')
  assert.equal(profile.id, 'copilot-review')
  assert.equal(profile.transport, 'oauth')
})

test('provider resolution falls back to an available profile when preferred cli is missing', () => {
  const profile = resolveProviderProfile(
    {},
    'claude-cli',
    undefined,
    {
      preferAvailable: true,
      runner: (_command, args) => ({ status: args[0] === 'codex' ? 0 : 1 }),
      capabilityHints: ['orchestration'],
    },
  )

  assert.equal(profile.id, 'codex-main')
  assert.equal(profile.available, true)
})

test('provider model discovery uses opencode cli output when available', () => {
  const discovery = discoverProviderModels({}, 'opencode-cli', {
    force: true,
    cache: false,
    runner: (_command, _args) => ({
      status: 0,
      stdout: JSON.stringify({
        models: [
          { id: 'github-copilot/claude-sonnet-4.6', reasoning: true },
          { id: 'openai/gpt-4.1' },
        ],
      }),
      stderr: '',
    }),
  })

  assert.equal(discovery.profileId, 'opencode-cli')
  assert.equal(discovery.source, 'cli_discovery')
  assert.ok(discovery.models.some((entry) => entry.id === 'openai/gpt-4.1'))
})

test('provider model listing merges discovery catalog with defaults', () => {
  const models = listProviderModels({}, 'opencode-cli', {
    discoveredModelsByProfile: {
      'opencode-cli': ['custom/model-a'],
    },
  })

  assert.equal(models[0], 'custom/model-a')
  assert.ok(models.includes('github-copilot/claude-sonnet-4.6'))
})

test('failover chain preserves requested ordering before ranked fallbacks', () => {
  const chain = buildFailoverChain({}, 'gemini-cli', {
    fallbackProviderProfileIds: ['codex-main', 'openrouter-fallback'],
    runner: () => ({ status: 0 }),
  })

  assert.deepEqual(
    chain.slice(0, 3).map((profile) => profile.id),
    ['gemini-cli', 'codex-main', 'openrouter-fallback'],
  )
})

test('opencode status surfaces availability, config, and discovered models', () => {
  const status = getOpenCodeStatus({}, {
    cache: false,
    runner: (_command, args) => {
      if (args[0] === '--version') {
        return { status: 0, stdout: 'opencode 1.2.3', stderr: '' }
      }
      if (args[0] === 'status') {
        return { status: 0, stdout: JSON.stringify({ active: true }), stderr: '' }
      }
      if (args[0] === 'config') {
        return { status: 0, stdout: JSON.stringify({ profile: 'default' }), stderr: '' }
      }
      return {
        status: 0,
        stdout: JSON.stringify({ models: [{ id: 'github-copilot/claude-sonnet-4.6' }] }),
        stderr: '',
      }
    },
  })

  assert.equal(status.profileId, 'opencode-cli')
  assert.equal(status.version, 'opencode 1.2.3')
  assert.equal(status.session.active, true)
  assert.equal(status.config.profile, 'default')
  assert.ok(status.models.length > 0)
})

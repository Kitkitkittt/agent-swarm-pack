import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDirectiveRequestBody, buildTaskCreateRequest, createExecutionContext } from '../src/orchestrator.js'
import { loadProviderProfiles } from '../src/providers.js'

function createConfig(overrides = {}) {
  return {
    defaultPlatform: 'telegram',
    defaultAccountId: 'primary',
    defaultProjectPath: 'C:/workspace/project',
    defaultCompactPackKey: 'software-6',
    defaultProviderProfileId: 'codex-main',
    providerProfilesRaw: JSON.stringify(loadProviderProfiles().map(profile => ({ ...profile, commandId: profile.commandId === 'codex' ? process.execPath : profile.commandId }))),
    taskCommandMode: 'hybrid',
    directiveSkipPlannedMeeting: true,
    ...overrides,
  }
}

test('execution context resolves compact pack, provider, and channel defaults', () => {
  const context = createExecutionContext(createConfig(), {
    commandType: 'task',
    platform: 'whatsapp',
    channelId: 'biz-room',
  })

  assert.equal(context.compactPack.key, 'software-6')
  assert.equal(context.providerProfile.id, 'codex-main')
  assert.equal(context.channel.platform, 'whatsapp')
  assert.equal(context.channel.accountId, 'primary')
})

test('directive payload includes workflow metadata for compact orchestration', () => {
  const context = createExecutionContext(createConfig(), {
    commandType: 'directive',
    platform: 'discord',
    accountId: 'engineering',
    channelId: 'release-room',
    threadId: 'thread-9',
    senderName: 'CEO',
  })

  const body = buildDirectiveRequestBody(
    createConfig(),
    context,
    {
      projectId: 'project-1',
      projectPath: 'C:/workspace/project',
      projectContext: 'Ship release',
    },
    {
      text: '$ship release',
    },
  )

  assert.equal(body.provider_profile_id, 'codex-main')
  assert.equal(body.compact_pack_key, 'software-6')
  assert.equal(body.account_id, 'engineering')
  assert.equal(body.thread_id, 'thread-9')
  assert.equal(body.workflow_meta_json.channel.platform, 'discord')
})

test('task payload includes hybrid metadata for downstream execution', () => {
  const context = createExecutionContext(createConfig(), {
    commandType: 'task',
    connectorId: 'connector-1',
    channelId: 'ops-room',
  })
  const body = buildTaskCreateRequest(context, 'Finish release train')

  assert.equal(body.status, 'inbox')
  assert.equal(body.workflow_meta_json.hybrid_mode, 'hybrid')
  assert.equal(body.workflow_meta_json.channel.connector_id, 'connector-1')
})

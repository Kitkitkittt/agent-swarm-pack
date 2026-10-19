import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getPackageRoot, resolveTemplateDir } from './runtime-paths.js'

const text = (value) => typeof value === 'string' ? value.trim() : ''
function template(name, config = {}) {
  const directory = config.runtimePaths?.templateDir || resolveTemplateDir()
  try { return readFileSync(path.join(directory, name), 'utf8').trim() } catch (error) {
    if (error.code !== 'ENOENT') throw Object.assign(new Error('agent_template_read_failed'), { code: 'agent_template_read_failed', statusCode: 500 })
  }
  try { return readFileSync(path.resolve(getPackageRoot(), '..', 'templates', name), 'utf8').trim() } catch {
    throw Object.assign(new Error('agent_template_read_failed'), { code: 'agent_template_read_failed', statusCode: 500 })
  }
}

export const loadSoulTemplate = (config) => template('SOUL.md', config)
export const loadIdentityTemplate = (config) => template('IDENTITY.md', config)
export const loadAgentsTemplate = (config) => template('AGENTS.md', config)

export function normalizeAgentSoul(identity = {}) {
  return {
    name: text(identity.name), persona: text(identity.persona), objective: text(identity.objective),
    voice: text(identity.voice), guardrails: text(identity.guardrails), soulText: text(identity.soulText),
    identityText: text(identity.identityText), systemPrompt: text(identity.systemPrompt),
    tags: Array.isArray(identity.tags) ? [...new Set(identity.tags.map(text).filter(Boolean))].slice(0, 64) : [],
  }
}

export function mergeIdentityIntoPrompt(soul, identity = {}) {
  const normalized = normalizeAgentSoul(soul)
  const sections = []
  for (const field of ['name', 'persona', 'objective', 'voice', 'guardrails']) {
    const value = text(identity[field]) || normalized[field]
    if (value) sections.push(`${field[0].toUpperCase()}${field.slice(1)}: ${value}`)
  }
  for (const field of ['soulText', 'identityText', 'systemPrompt']) {
    const value = normalized[field] || text(identity[field])
    if (value && !sections.includes(value)) sections.push(value)
  }
  return sections.join('\n\n')
}

export function buildAgentContextFiles(soul) {
  const normalized = normalizeAgentSoul(soul)
  return [
    { name: 'SOUL.md', content: normalized.soulText },
    { name: 'IDENTITY.md', content: normalized.identityText },
  ].filter((file) => file.content)
}

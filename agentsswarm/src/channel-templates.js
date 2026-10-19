import { listSupportedPlatforms, platformConfigSchema } from './channels.js'

export function listChannelTemplates() {
  return listSupportedPlatforms().map((platform) => ({
    id: platform,
    platform,
    name: platform === 'cli' ? 'CLI' : platform[0].toUpperCase() + platform.slice(1),
    requiredFields: [...platformConfigSchema[platform].required],
    config: Object.fromEntries(platformConfigSchema[platform].required.map((field) => [field, ''])),
  }))
}

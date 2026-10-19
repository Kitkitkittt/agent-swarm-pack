import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const directory of ['src', 'scripts', 'ui']) {
  for (const entry of fs.readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|mjs)$/.test(entry.name)) continue
    const parent = entry.parentPath || entry.path
    if (parent.split(path.sep).some(part => ['node_modules', 'dist'].includes(part))) continue
    const result = spawnSync(process.execPath, ['--check', path.join(parent, entry.name)], { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status || 1)
  }
}

import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import https from 'node:https'
import { resolveSkillDir } from './runtime-paths.js'

const MAX_BYTES = 256 * 1024
const MAX_RECORD_BYTES = MAX_BYTES * 8
const MAX_SKILLS = 1000
const TIMEOUT_MS = 10000
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const text = (value) => typeof value === 'string' ? value.trim() : ''
const failure = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode })

function provenance(value) {
  const source = text(value)
  try {
    const url = new URL(source)
    if (['http:', 'https:'].includes(url.protocol)) return `${url.origin}${url.pathname}`
  } catch {}
  return source.slice(0, 2048)
}

async function noSymlinks(filename) {
  const absolute = path.resolve(filename)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw failure('skill_symlink_forbidden')
  }
  return absolute
}

async function readRegular(filename, maximum = MAX_BYTES) {
  let handle
  try {
    const absolute = await noSymlinks(filename)
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile()) throw failure('skill_regular_file_required')
    if (stat.size > maximum) throw failure('skill_too_large', 413)
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > maximum || offset > stat.size) throw failure('skill_too_large', 413)
    return buffer.subarray(0, offset)
  } catch (error) {
    if (error.statusCode) throw error
    throw failure('skill_file_read_failed')
  } finally { await handle?.close().catch(() => {}) }
}

function decodeText(buffer) {
  let body
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { throw failure('skill_utf8_required') }
  if (body.includes('\0')) throw failure('skill_text_required')
  return body
}

function normalizeSkill(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) throw failure('skill_invalid')
  const body = typeof skill.body === 'string' ? skill.body : ''
  if (!body.trim()) throw failure('skill_body_required')
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw failure('skill_too_large', 413)
  if (body.includes('\0')) throw failure('skill_text_required')
  const id = text(skill.id) || randomUUID()
  if (!ID_PATTERN.test(id)) throw failure('skill_id_invalid')
  const strings = (value) => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))].slice(0, 64).map((entry) => entry.slice(0, 256)) : []
  return {
    id,
    name: (text(skill.name) || 'Imported Skill').slice(0, 256),
    description: text(skill.description).slice(0, 4096),
    tags: strings(skill.tags), triggers: strings(skill.triggers),
    source: provenance(skill.source) || 'inline',
    body,
  }
}

function fromText(body, source, name) {
  const title = body.match(/^#\s+(.+)$/m)?.[1]
  return normalizeSkill({ name: title || name || 'Imported Skill', body, source })
}

export async function loadSkillFromPath(filename) {
  if (!text(filename)) throw failure('skill_path_required')
  const body = decodeText(await readRegular(filename))
  return fromText(body, 'local', path.basename(filename))
}

function publicAddress(address) {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false
  // Accept native global-unicast only, excluding special-use, documentation and transition ranges.
  const parts = address.toLowerCase().split(':')
  const first = parseInt(parts[0], 16)
  const second = parseInt(parts[1] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff
    && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
}

export async function loadSkillFromUrl(value) {
  let url
  try { url = new URL(value) } catch { throw failure('skill_url_invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.href.length > 2048) throw failure('skill_https_url_required')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  let request
  let timer
  let expired = false
  const operation = (async () => {
    let addresses
    try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true }) } catch { throw failure('skill_dns_failed') }
    if (expired) throw failure('skill_fetch_timeout', 504)
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw failure('skill_public_destination_required')
    const pinned = addresses[0]
    return new Promise((resolve, reject) => {
      request = https.get(url, {
        agent: false,
        autoSelectFamily: false,
        family: pinned.family,
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [pinned])
          else callback(null, pinned.address, pinned.family)
        },
        headers: { accept: 'text/plain, text/markdown', 'accept-encoding': 'identity' },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.destroy()
          reject(failure(response.statusCode >= 300 && response.statusCode < 400 ? 'skill_redirect_forbidden' : 'skill_http_failed', 502))
          return
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy()
          reject(failure('skill_encoding_unsupported'))
          return
        }
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BYTES) {
            response.destroy()
            reject(failure('skill_too_large', 413))
          } else chunks.push(chunk)
        })
        response.on('error', () => reject(failure('skill_fetch_failed', 502)))
        response.on('end', () => {
          try { resolve(fromText(decodeText(Buffer.concat(chunks, size)), url.href, path.basename(url.pathname))) } catch (error) { reject(error) }
        })
      })
      request.on('error', () => reject(failure('skill_fetch_failed', 502)))
    })
  })()
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; request?.destroy(); reject(failure('skill_fetch_timeout', 504)) }, TIMEOUT_MS)
    })])
  } catch (error) {
    if (error.statusCode) throw error
    throw failure('skill_fetch_failed', 502)
  } finally { clearTimeout(timer) }
}

async function storageDirectory(skillDir, create = false) {
  const directory = path.resolve(skillDir || resolveSkillDir())
  try {
    if (create) {
      // Check existing ancestors before mkdir so a symlink is never used as a storage root.
      let ancestor = directory
      while (true) {
        try { await noSymlinks(ancestor); break } catch (error) {
          if (error.code !== 'ENOENT') throw error
          const parent = path.dirname(ancestor)
          if (parent === ancestor) throw error
          ancestor = parent
        }
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
    }
    await noSymlinks(directory)
    if (!(await lstat(directory)).isDirectory()) throw failure('skill_directory_required')
    return await realpath(directory)
  } catch (error) {
    if (error.statusCode || error.code === 'ENOENT') throw error
    throw failure('skill_storage_unavailable', 500)
  }
}

export async function saveLoadedSkill(skill, { skillDir } = {}) {
  const normalized = normalizeSkill(skill)
  let directory
  try { directory = await storageDirectory(skillDir, true) } catch (error) {
    if (error.statusCode) throw error
    throw failure('skill_storage_unavailable', 500)
  }
  const filename = path.join(directory, `${normalized.id}.json`)
  const temporary = path.join(directory, `.${randomUUID()}.tmp`)
  let handle
  try {
    try {
      const target = await lstat(filename)
      if (target.isSymbolicLink() || !target.isFile()) throw failure('skill_regular_file_required')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const files = await readdir(directory)
    if (!files.includes(`${normalized.id}.json`) && files.filter((file) => file.endsWith('.json')).length >= MAX_SKILLS) throw failure('skill_catalog_full', 409)
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(JSON.stringify(normalized) + '\n', 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filename)
    return normalized
  } catch (error) {
    if (error.statusCode) throw error
    throw failure('skill_save_failed', 500)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

export async function listLoadedSkills({ skillDir } = {}) {
  let directory
  try { directory = await storageDirectory(skillDir) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { throw failure('skill_list_failed', 500) }
  const result = []
  for (const entry of entries.filter((entry) => entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS)) {
    const id = entry.name.slice(0, -5)
    if (!ID_PATTERN.test(id) || !entry.isFile() || entry.isSymbolicLink()) continue
    try {
      const skill = normalizeSkill(JSON.parse(decodeText(await readRegular(path.join(directory, entry.name), MAX_RECORD_BYTES))))
      if (skill.id === id) result.push(skill)
    } catch (error) {
      if (!error.statusCode && !(error instanceof SyntaxError)) throw failure('skill_list_failed', 500)
      // Invalid catalog entries are inert and excluded; valid entries remain available.
    }
  }
  return result
}

export function matchSkillsToTask(value, skills = []) {
  const task = text(value).toLowerCase().slice(0, MAX_BYTES)
  if (!task) return []
  return skills.slice(0, MAX_SKILLS).map((skill) => {
    const terms = [skill.name, ...(Array.isArray(skill.tags) ? skill.tags : []), ...(Array.isArray(skill.triggers) ? skill.triggers : [])].map(text).filter(Boolean)
    const matchedTerms = [...new Set(terms.filter((term) => task.includes(term.toLowerCase())))]
    return { id: skill.id, name: skill.name, description: skill.description, score: matchedTerms.length, matchedTerms }
  }).filter((match) => match.score > 0).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
}

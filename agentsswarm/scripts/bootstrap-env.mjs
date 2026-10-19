import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const defaultBridgeDir = path.resolve(scriptDir, "..")
const defaultRepoRoot = path.resolve(defaultBridgeDir, "..")

function log(message, quiet) {
  if (!quiet) process.stdout.write(`${message}\n`)
}

function warn(message, quiet) {
  if (!quiet) process.stderr.write(`${message}\n`)
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase())
}

function isMissingValue(value) {
  const normalized = String(value || "").trim()
  return !normalized || normalized === "__CHANGE_ME__"
}

export function parseEnvText(text) {
  const result = {}
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const rawValue = trimmed.slice(idx + 1).trim()
    const value = rawValue.replace(/^['"]|['"]$/g, "")
    if (!key) continue
    result[key] = value
  }
  return result
}

export function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  return parseEnvText(fs.readFileSync(filePath, "utf8"))
}

function ensureEnvFile(envPath, envExamplePath) {
  if (fs.existsSync(envPath)) return false
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath)
  } else {
    fs.writeFileSync(envPath, "", "utf8")
  }
  return true
}

function setEnvLine(lines, key, nextValue, options = {}) {
  if (isMissingValue(nextValue)) return false
  const matcher = new RegExp(`^\\s*${key}\\s*=`)
  const index = lines.findIndex((line) => matcher.test(line))
  const force = options.force === true

  if (index >= 0) {
    const currentLine = lines[index]
    const currentRaw = currentLine.slice(currentLine.indexOf("=") + 1).trim()
    const current = currentRaw.replace(/^['"]|['"]$/g, "")
    if (!force && !isMissingValue(current)) return false
    if (current === nextValue) return false
    lines[index] = `${key}=${nextValue}`
    return true
  }

  lines.push(`${key}=${nextValue}`)
  return true
}

function resolveApiEnvPath(apiEnvCandidates) {
  return apiEnvCandidates.find((candidate) => fs.existsSync(candidate)) || apiEnvCandidates[apiEnvCandidates.length - 1]
}

function createBridgeSecret() {
  return crypto.randomBytes(32).toString("hex")
}

function normalizePathList(values) {
  return Array.isArray(values) ? values.map((entry) => path.resolve(entry)) : []
}

export function syncBootstrapEnv(options = {}) {
  const bridgeDir = path.resolve(options.bridgeDir || defaultBridgeDir)
  const repoRoot = path.resolve(options.repoRoot || path.resolve(bridgeDir, ".."))
  const envPath = path.join(bridgeDir, ".env")
  const envExamplePath = path.join(bridgeDir, ".env.example")
  const swarmclawEnvPath = path.join(repoRoot, "swarmclaw", ".env.local")
  const apiEnvCandidates = normalizePathList(
    options.apiEnvCandidates || [
      path.join(repoRoot, "agentsswarm-api", ".env"),
      path.join(repoRoot, "claw-empire", ".env"),
    ],
  )
  const apiEnvPath = resolveApiEnvPath(apiEnvCandidates)
  const quiet = options.quiet === true
  const resyncEnv = options.resyncEnv === true
  const startupOnly = options.startupOnly === true
  const importSiblingSecrets = options.importSiblingSecrets === true

  const created = ensureEnvFile(envPath, envExamplePath)
  if (created) {
    log("[agentsswarm] created .env from template", quiet)
  }

  const bridgeEnv = readEnvFile(envPath)
  const swarmEnv = importSiblingSecrets ? readEnvFile(swarmclawEnvPath) : {}
  const apiEnv = importSiblingSecrets ? readEnvFile(apiEnvPath) : {}
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split(/\r?\n/) : []

  const desired = {
    BRIDGE_PORT: bridgeEnv.BRIDGE_PORT || "7799",
    BRIDGE_SECRET: bridgeEnv.BRIDGE_SECRET || "",
    ALLOW_UNSECURED_BRIDGE: bridgeEnv.ALLOW_UNSECURED_BRIDGE || "false",
    TASK_EXECUTION_BACKEND: bridgeEnv.TASK_EXECUTION_BACKEND || "standalone",
    CONNECTOR_BACKEND: bridgeEnv.CONNECTOR_BACKEND || "none",
    SWARMCLAW_URL: bridgeEnv.SWARMCLAW_URL || "http://127.0.0.1:3456",
    SWARMCLAW_ACCESS_KEY: bridgeEnv.SWARMCLAW_ACCESS_KEY || swarmEnv.ACCESS_KEY || "",
    CONNECTOR_API_KEY: bridgeEnv.CONNECTOR_API_KEY || "",
    AGENTSSWARM_API_URL: bridgeEnv.AGENTSSWARM_API_URL || bridgeEnv.CLAW_EMPIRE_URL || "http://127.0.0.1:8790",
    REMOTE_API_URL: bridgeEnv.REMOTE_API_URL || bridgeEnv.AGENTSSWARM_API_URL || bridgeEnv.CLAW_EMPIRE_URL || "http://127.0.0.1:8790",
    AGENTSSWARM_AUTH_TOKEN:
      bridgeEnv.AGENTSSWARM_AUTH_TOKEN || bridgeEnv.CLAW_EMPIRE_AUTH_TOKEN || apiEnv.API_AUTH_TOKEN || "",
    INBOX_WEBHOOK_SECRET: bridgeEnv.INBOX_WEBHOOK_SECRET || apiEnv.INBOX_WEBHOOK_SECRET || "",
    REMOTE_INBOX_SECRET: bridgeEnv.REMOTE_INBOX_SECRET || "",
    DEFAULT_PROJECT_PATH: bridgeEnv.DEFAULT_PROJECT_PATH || repoRoot,
    DEFAULT_PLATFORM: bridgeEnv.DEFAULT_PLATFORM || "telegram",
    DEFAULT_ACCOUNT_ID: bridgeEnv.DEFAULT_ACCOUNT_ID || "primary",
    STATUS_RELAY_ENABLED: bridgeEnv.STATUS_RELAY_ENABLED || "true",
    STATUS_RELAY_MANAGED_ONLY: bridgeEnv.STATUS_RELAY_MANAGED_ONLY || "true",
    STATUS_RELAY_INTERVAL_MS: bridgeEnv.STATUS_RELAY_INTERVAL_MS || "6000",
    DIRECTIVE_SKIP_PLANNED_MEETING: bridgeEnv.DIRECTIVE_SKIP_PLANNED_MEETING || "true",
    TASK_COMMAND_MODE: bridgeEnv.TASK_COMMAND_MODE || "hybrid",
    COMPACT_AGENT_LIMIT: bridgeEnv.COMPACT_AGENT_LIMIT || "8",
    ENFORCE_COMPACT_PROJECT_SCOPE: bridgeEnv.ENFORCE_COMPACT_PROJECT_SCOPE || "true",
    DEFAULT_COMPACT_PACK: bridgeEnv.DEFAULT_COMPACT_PACK || "software-6",
    DEFAULT_PROVIDER_PROFILE: bridgeEnv.DEFAULT_PROVIDER_PROFILE || "codex-main",
    AGENTSSWARM_SUPPORTED_PLATFORMS:
      bridgeEnv.AGENTSSWARM_SUPPORTED_PLATFORMS || "telegram,discord,whatsapp,slack,cli",
    AGENTSSWARM_REQUIRED_CLI_TOOLS: bridgeEnv.AGENTSSWARM_REQUIRED_CLI_TOOLS || "openclaw,codex",
  }

  const updatedKeys = []
  const generatedKeys = []

  for (const [key, value] of Object.entries(desired)) {
    if (setEnvLine(lines, key, value, { force: resyncEnv })) {
      updatedKeys.push(key)
    }
  }

  const optionalKeys = [
    "AGENTSSWARM_PROVIDER_PROFILES_JSON",
    "AGENTSSWARM_PACKS_JSON",
    "CHANNEL_ROUTE_MAP_JSON",
    "PROJECT_ROUTE_MAP_JSON",
  ]
  for (const key of optionalKeys) {
    if (setEnvLine(lines, key, bridgeEnv[key] || "", { force: false })) {
      updatedKeys.push(key)
    }
  }

  const allowUnsecuredBridge = isTruthy(bridgeEnv.ALLOW_UNSECURED_BRIDGE || desired.ALLOW_UNSECURED_BRIDGE)
  if (isMissingValue(bridgeEnv.BRIDGE_SECRET) && !allowUnsecuredBridge) {
    const bridgeSecret = createBridgeSecret()
    if (setEnvLine(lines, "BRIDGE_SECRET", bridgeSecret, { force: true })) {
      updatedKeys.push("BRIDGE_SECRET")
      generatedKeys.push("BRIDGE_SECRET")
    }
  }

  if (updatedKeys.length > 0) {
    const normalized = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
    fs.writeFileSync(envPath, normalized, "utf8")
    log(`[agentsswarm] synced .env keys: ${updatedKeys.join(", ")}`, quiet)
  } else {
    log(`[agentsswarm] .env already synchronized${resyncEnv ? " (resync mode)" : ""}`, quiet)
  }

  const finalEnv = readEnvFile(envPath)
  const executionBackend = String(finalEnv.TASK_EXECUTION_BACKEND || "standalone").trim().toLowerCase() || "standalone"
  const connectorBackend = String(finalEnv.CONNECTOR_BACKEND || "none").trim().toLowerCase() || "none"

  const missingRequired = []
  if (isMissingValue(finalEnv.BRIDGE_SECRET) && !isTruthy(finalEnv.ALLOW_UNSECURED_BRIDGE)) {
    missingRequired.push("BRIDGE_SECRET")
  }
  if (!startupOnly && connectorBackend !== "none" && isMissingValue(finalEnv.CONNECTOR_API_KEY || finalEnv.SWARMCLAW_ACCESS_KEY)) {
    missingRequired.push("CONNECTOR_API_KEY")
  }
  if (
    !startupOnly &&
    executionBackend !== "standalone" &&
    isMissingValue(finalEnv.REMOTE_INBOX_SECRET || finalEnv.INBOX_WEBHOOK_SECRET)
  ) {
    missingRequired.push("REMOTE_INBOX_SECRET")
  }

  if (missingRequired.length > 0) {
    warn(`[agentsswarm] missing required env keys: ${missingRequired.join(", ")}`, quiet)
  }

  log(`[agentsswarm] api env source: ${path.relative(repoRoot, apiEnvPath)}`, quiet)

  return {
    ok: missingRequired.length === 0,
    bridgeDir,
    repoRoot,
    envPath,
    apiEnvPath,
    created,
    updatedKeys,
    generatedKeys,
    missingRequired,
    executionBackend,
    connectorBackend,
  }
}

const strict = process.argv.includes("--strict")
const quiet = process.argv.includes("--quiet")
const resyncEnv = process.argv.includes("--resync-env")
const startupOnly = process.argv.includes("--startup-only")

const isDirectInvocation = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false

if (isDirectInvocation) {
  const result = syncBootstrapEnv({
    strict,
    quiet,
    resyncEnv,
    startupOnly,
    importSiblingSecrets: true,
  })

  if (strict && !result.ok) {
    process.exit(1)
  }
}

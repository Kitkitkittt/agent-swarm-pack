import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { summarizeConnectorInventory } from "./channels.js"
import { listCompactPacks } from "./compact-packs.js"
import { loadConfig } from "./config.js"
import { buildProviderSummary } from "./providers.js"
import { resolveEnvFilePath } from "./runtime-paths.js"

function normalizeUrl(raw, fallback) {
  const value = String(raw || "").trim() || fallback
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "")
  return `http://${value}`.replace(/\/+$/, "")
}

function parseFlags(args) {
  const out = {}
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith("--")) {
      out[key] = "true"
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

function printUsage() {
  process.stdout.write(
    [
      "AgentSwarm CLI",
      "",
      "Usage:",
      "  npm run cli -- health",
      "  npm run cli -- routes",
      "  npm run cli -- channels",
      "  npm run cli -- summary",
      "  npm run cli -- providers",
       "  npm run cli -- packs",
       "  npm run cli -- preflight",
       "  npm run cli -- doctor",
       "  npm run cli -- prune [--dry-run]",
        "  npm run cli -- ingest --text \"$plan sprint\" --connector <id> --channel <id>",
      "",
      "Flags for ingest:",
      "  --text <command text>",
      "  --connector <connector id>",
      "  --channel <channel id>",
      "  --platform <telegram|discord|whatsapp|cli>",
      "  --account <account id> (optional, default primary)",
      "  --thread <thread id> (optional)",
      "  --projectPath <absolute path> (optional)",
      "  --commandType <directive|task> (optional auto-detect)",
      "  --providerProfile <provider profile id> (optional)",
      "  --pack <compact pack key> (optional)",
      "  --senderId <sender id> (optional)",
      "  --senderName <sender name> (optional)",
    ].join("\n") + "\n",
  )
}

export function readLocalEnv(env = process.env) {
  const envPath = resolveEnvFilePath(env)
  if (!fs.existsSync(envPath)) return {}
  const result = {}
  const text = fs.readFileSync(envPath, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const idx = trimmed.indexOf("=")
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")
    if (!key) continue
    result[key] = value
  }
  return result
}

function mergedEnv() {
  return {
    ...readLocalEnv(),
    ...process.env,
  }
}

function loadLocalConfig() {
  return loadConfig(mergedEnv(), { validateRequired: false })
}

function statusText(ok) {
  return ok ? "ok" : "missing"
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase())
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  })
  const contentType = response.headers.get("content-type") || ""
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "")
  return { ok: response.ok, status: response.status, body }
}

async function safeRequest(url, init) {
  return requestJson(url, init).catch((err) => ({
    ok: false,
    status: 0,
    body: String(err?.message || err),
  }))
}

async function fetchConnectors(config) {
  if (!config.swarmclawAccessKey) {
    return {
      ok: false,
      skipped: true,
      inventory: { total: 0, bridgeWired: 0, byPlatform: {} },
    }
  }

  const response = await safeRequest(`${config.swarmclawUrl}/api/connectors`, {
    method: "GET",
    headers: { "x-access-key": config.swarmclawAccessKey },
  })

  return {
    ...response,
    skipped: false,
    inventory: summarizeConnectorInventory(response.ok ? response.body : {}),
  }
}

async function buildDoctorData({ bridgeUrl }) {
  const config = loadLocalConfig()
  const providerSummary = buildProviderSummary(config)
  const packs = listCompactPacks(config)

  const bridgeHealth = await safeRequest(`${bridgeUrl}/health`, { method: "GET" })
  const apiHealth = config.executionBackend === 'remote_api'
    ? await safeRequest(`${config.agentsswarmApiUrl}/api/health`, { method: 'GET' })
    : { ok: true, skipped: true }
  const connectors = config.connectorBackend === 'external_connector'
    ? await fetchConnectors(config)
    : { ok: true, skipped: true }

  return {
    config,
    providerSummary,
    packs,
    bridgeHealth,
    apiHealth,
    connectors,
  }
}

function printCliToolActions(cliTools) {
  for (const tool of cliTools) {
    process.stdout.write(`- Install ${tool.label}: ${tool.installCommand}\n`)
  }
}

function hasConfiguredValue(...values) {
  return values.some((value) => String(value || "").trim())
}

function normalizeBackend(value, fallback) {
  return String(value || "").trim().toLowerCase() || fallback
}

export function buildPreflightReport(config, providerSummary, options = {}) {
  const startupOnly = options.startupOnly === true
  const executionBackend = normalizeBackend(config.executionBackend, "standalone")
  const connectorBackend = normalizeBackend(config.connectorBackend, "none")
  const connectorApiConfigured = hasConfiguredValue(config.connectorApiKey, config.swarmclawAccessKey)
  const remoteInboxConfigured = hasConfiguredValue(config.remoteInboxSecret, config.inboxWebhookSecret)

  const rows = []
  rows.push(["env.BRIDGE_SECRET", statusText(Boolean(config.bridgeSecret))])
  rows.push(["bridge.security", config.allowUnsecuredBridge ? "unsecured(opt-in)" : "secret-required"])
  rows.push(["execution.backend", executionBackend])
  rows.push(["connector.backend", connectorBackend])
  rows.push(["platform.default", config.defaultPlatform])
  rows.push(["provider.default", providerSummary.defaultProviderProfileId || "none"])
  rows.push(["provider.profiles", `${providerSummary.profiles.length}`])
  rows.push(["provider.unavailable", `${providerSummary.unavailableProfileIds.length}`])
  rows.push(["compact.default", config.defaultCompactPackKey])
  rows.push(["compact.packs", `${listCompactPacks(config).length}`])
  rows.push([
    "cli.required",
    providerSummary.cliTools.filter((tool) => tool.required).map((tool) => tool.id).join(", ") || "none",
  ])

  if (connectorBackend !== "none") {
    rows.push(["env.CONNECTOR_API_KEY", statusText(connectorApiConfigured)])
  }
  if (executionBackend !== "standalone") {
    rows.push(["env.REMOTE_INBOX_SECRET", statusText(remoteInboxConfigured)])
  }

  const issues = []
  const warnings = []

  if (!config.bridgeSecret && !config.allowUnsecuredBridge) {
    issues.push("BRIDGE_SECRET missing")
  }
  if (!startupOnly && connectorBackend !== "none" && !connectorApiConfigured) {
    issues.push("CONNECTOR_API_KEY missing")
  }
  if (!startupOnly && executionBackend !== "standalone" && !remoteInboxConfigured) {
    issues.push("REMOTE_INBOX_SECRET missing")
  }
  for (const issue of config.configIssues || []) {
    warnings.push(`config issue: ${issue}`)
  }
  for (const toolId of providerSummary.missingRequiredCliTools || []) {
    warnings.push(`required cli missing: ${toolId}`)
  }

  return {
    rows,
    issues,
    warnings,
    executionBackend,
    connectorBackend,
  }
}

async function runPreflight() {
  const config = loadLocalConfig()
  const providerSummary = buildProviderSummary(config)
  const report = buildPreflightReport(config, providerSummary)

  process.stdout.write("Preflight Report\n")
  for (const [name, value] of report.rows) {
    process.stdout.write(`- ${name}: ${value}\n`)
  }

  if (report.warnings.length > 0) {
    process.stdout.write("\nWarnings\n")
    for (const warning of report.warnings) {
      process.stdout.write(`- ${warning}\n`)
    }
  }

  if (report.issues.length > 0) {
    process.stdout.write("\nMissing / Broken\n")
    for (const issue of report.issues) {
      process.stdout.write(`- ${issue}\n`)
    }

    const missingTools = providerSummary.cliTools.filter((tool) => tool.required && !tool.installed)
    if (missingTools.length > 0) {
      process.stdout.write("\nNext Actions\n")
      printCliToolActions(missingTools)
    }
    process.exit(2)
  }

  process.stdout.write(`\nPreflight checks passed${report.warnings.length > 0 ? " with warnings" : ""}.\n`)
}

async function runDoctor({ bridgeUrl }) {
  const { config, providerSummary, packs, bridgeHealth, apiHealth, connectors } = await buildDoctorData({ bridgeUrl })

  const rows = []
  rows.push(["env.SWARMCLAW_ACCESS_KEY", statusText(Boolean(config.swarmclawAccessKey))])
  rows.push(["env.BRIDGE_SECRET", statusText(Boolean(config.bridgeSecret))])
  rows.push(["env.INBOX_WEBHOOK_SECRET", statusText(Boolean(config.inboxWebhookSecret))])
  rows.push(["bridge.security", config.allowUnsecuredBridge ? 'unsecured(opt-in)' : 'secret-required'])
  rows.push(["bridge.health", bridgeHealth.ok ? "ok" : `fail(${bridgeHealth.status || "err"})`])
  rows.push(["agentsswarm.api", apiHealth.ok ? "ok" : `fail(${apiHealth.status || "err"})`])
  rows.push(["providers.default", providerSummary.defaultProviderProfileId || "none"])
  rows.push(["providers.count", `${providerSummary.profiles.length}`])
  rows.push(["providers.unavailable", `${providerSummary.unavailableProfileIds.length}`])
  rows.push(["packs.default", config.defaultCompactPackKey])
  rows.push(["packs.count", `${packs.length}`])
  rows.push(["channels.platforms", config.supportedPlatforms.join(", ")])

  for (const tool of providerSummary.cliTools) {
    rows.push([`cli.${tool.id}`, tool.installed ? "ok" : `missing${tool.required ? "(required)" : ""}`])
  }

  if (connectors.skipped) {
    rows.push(["swarmclaw.connectors", "skipped(no access key)"])
  } else if (connectors.ok) {
    rows.push(["swarmclaw.connectors", `${connectors.inventory.total}`])
    rows.push(["swarmclaw.bridge_wired", `${connectors.inventory.bridgeWired}`])
    rows.push([
      "swarmclaw.platforms",
      Object.entries(connectors.inventory.byPlatform).map(([name, count]) => `${name}:${count}`).join(", ") || "none",
    ])
  } else {
    rows.push(["swarmclaw.connectors", `fail(${connectors.status || "err"})`])
  }

  process.stdout.write("Doctor Report\n")
  for (const [name, value] of rows) {
    process.stdout.write(`- ${name}: ${value}\n`)
  }

  const issues = []
  if (!config.bridgeSecret && !config.allowUnsecuredBridge) issues.push("BRIDGE_SECRET missing")
  if (config.connectorBackend === 'external_connector' && !config.connectorApiKey) issues.push('CONNECTOR_API_KEY missing')
  if (config.executionBackend === 'remote_api' && !config.remoteInboxSecret) issues.push('REMOTE_INBOX_SECRET missing')
  for (const issue of config.configIssues) {
    issues.push(`config issue: ${issue}`)
  }
  if (!bridgeHealth.ok) issues.push("bridge not running")
  if (!apiHealth.ok) issues.push("agentsswarm api not reachable")
  if (!connectors.skipped && connectors.ok && connectors.inventory.total === 0) {
    issues.push("no connectors configured in SwarmClaw")
  }
  if (!connectors.skipped && connectors.ok && connectors.inventory.total > 0 && connectors.inventory.bridgeWired === 0) {
    issues.push("no connector has config.bridgeEndpoint")
  }
  for (const toolId of providerSummary.missingRequiredCliTools) {
    issues.push(`required cli missing: ${toolId}`)
  }

  if (issues.length > 0) {
    process.stdout.write("\nMissing / Broken\n")
    for (const issue of issues) {
      process.stdout.write(`- ${issue}\n`)
    }

    process.stdout.write("\nNext Actions\n")
    if (!config.bridgeSecret && !config.allowUnsecuredBridge) {
      process.stdout.write("- Fill BRIDGE_SECRET in agentsswarm/.env, or set ALLOW_UNSECURED_BRIDGE=true only for local development.\n")
    }
    if (config.connectorBackend === 'external_connector' && !config.connectorApiKey) {
      process.stdout.write('- Fill CONNECTOR_API_KEY in agentsswarm/.env then re-run doctor.\n')
    }
    if (config.executionBackend === 'remote_api' && !config.remoteInboxSecret) {
      process.stdout.write('- Fill REMOTE_INBOX_SECRET in agentsswarm/.env then re-run doctor.\n')
    }
    if (!bridgeHealth.ok) {
      process.stdout.write("- Start AgentSwarm: start_agentsswarm.bat (Windows) or ./start_agentsswarm.sh (macOS/Linux).\n")
    }
    if (!apiHealth.ok) {
      process.stdout.write("- Ensure the local AgentSwarm API is reachable at AGENTSSWARM_API_URL, then re-run doctor.\n")
    }
    if (!connectors.skipped && connectors.ok && connectors.inventory.total === 0) {
      process.stdout.write("- In SwarmClaw UI, create at least one manager connector (Telegram/Discord/WhatsApp).\n")
    }
    if (!connectors.skipped && connectors.ok && connectors.inventory.total > 0 && connectors.inventory.bridgeWired === 0) {
      process.stdout.write("- Set connector config.bridgeEndpoint to http://127.0.0.1:7799 and add bridgeSecret if used.\n")
    }

    const missingTools = providerSummary.cliTools.filter((tool) => tool.required && !tool.installed)
    if (missingTools.length > 0) {
      printCliToolActions(missingTools)
    }
    process.exit(2)
  }

  process.stdout.write("\nAll required AgentSwarm dependencies look healthy.\n")
}

function printProviders() {
  const config = loadLocalConfig()
  const providerSummary = buildProviderSummary(config)
  printJson({
    ok: true,
    defaultProviderProfileId: providerSummary.defaultProviderProfileId,
    profiles: providerSummary.profiles,
    cliTools: providerSummary.cliTools,
    countsByTransport: providerSummary.countsByTransport,
    unavailableProfileIds: providerSummary.unavailableProfileIds,
    configIssues: config.configIssues,
  })
}

function printPacks() {
  const config = loadLocalConfig()
  printJson({
    ok: true,
    defaultCompactPackKey: config.defaultCompactPackKey,
    packs: listCompactPacks(config),
    configIssues: config.configIssues,
  })
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === "help" || command === "--help") {
    printUsage()
    return
  }

  const env = mergedEnv()
  const bridgeUrl = normalizeUrl(env.BRIDGE_URL, "http://127.0.0.1:7799")
  const bridgeSecret = String(env.BRIDGE_SECRET || "").trim()

  if (["health", "routes", "channels", "summary"].includes(command)) {
    const response = await requestJson(`${bridgeUrl}/${command}`, {
      method: "GET",
    })
    printJson(response.body)
    if (!response.ok) process.exit(1)
    return
  }

  if (command === "providers") {
    printProviders()
    return
  }

  if (command === "packs") {
    printPacks()
    return
  }

  if (command === "preflight") {
    await runPreflight()
    return
  }

  if (command === "doctor") {
    await runDoctor({ bridgeUrl })
    return
  }

  if (command === 'prune') {
    const flags = parseFlags(rest)
    const headers = { 'Content-Type': 'application/json' }
    if (bridgeSecret) {
      headers['x-bridge-secret'] = bridgeSecret
    }
    const response = await requestJson(`${bridgeUrl}/maintenance/prune`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        dryRun: isTruthyFlag(flags['dry-run']) || isTruthyFlag(flags.dryRun),
      }),
    })
    printJson(response.body)
    if (!response.ok) process.exit(1)
    return
  }

  if (command === "ingest") {
    const flags = parseFlags(rest)
    const text = String(flags.text || "").trim()
    const connectorId = String(flags.connector || "").trim()
    const channelId = String(flags.channel || "").trim()

    if (!text || !connectorId || !channelId) {
      process.stderr.write("ingest requires --text, --connector, and --channel\n")
      process.exit(1)
    }

    const body = {
      text,
      connectorId,
      channelId,
      platform: String(flags.platform || "telegram").trim() || "telegram",
      accountId: String(flags.account || "primary").trim() || "primary",
      threadId: String(flags.thread || "").trim() || undefined,
      commandType: String(flags.commandType || "").trim() || undefined,
      projectPath: String(flags.projectPath || "").trim() || undefined,
      senderId: String(flags.senderId || "cli-user").trim() || "cli-user",
      senderName: String(flags.senderName || "CLI").trim() || "CLI",
      providerProfileId: String(flags.providerProfile || "").trim() || undefined,
      compactPackKey: String(flags.pack || "").trim() || undefined,
    }

    const headers = { "Content-Type": "application/json" }
    if (bridgeSecret) {
      headers["x-bridge-secret"] = bridgeSecret
    }

    const response = await requestJson(`${bridgeUrl}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    printJson(response.body)
    if (!response.ok) process.exit(1)
    return
  }

  process.stderr.write(`Unknown command: ${command}\n`)
  printUsage()
  process.exit(1)
}

const isDirectInvocation = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false

if (isDirectInvocation) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`agentsswarm cli error: ${message}\n`)
    process.exit(1)
  })
}

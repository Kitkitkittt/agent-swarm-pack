# AgentSwarm

Compact OpenClaw AgentSwarm runtime for chat-first orchestration.

It focuses on seamless chat channel connectivity, compact hybrid execution, and operator-first setup instead of a heavy visual layer.

See [`CONTEXT_AND_PROGRESS.md`](CONTEXT_AND_PROGRESS.md) for the current architecture, risks, completed hardening work, and next-phase roadmap.

## What AgentSwarm does

- Accepts inbound `$` directives and `#` tasks from chat connectors.
- Normalizes Telegram, Discord, WhatsApp, and CLI traffic into one routing contract.
- Uses hybrid execution by default: lightweight board semantics plus immediate direct run.
- Keeps each use case compact with packs capped at 8 agents.
- Tracks channel, project, and managed task routes in `agentsswarm/data/bridge-state.json`.
- Relays managed task status updates back to the originating chat channel.
- Exposes local operator endpoints and CLI commands for health, routes, packs, providers, channels, and preflight checks.
- Adds request correlation IDs, message-id dedupe, TTL-based state pruning, and safer config surfacing for long-running operators.

## Compact runtime model

- `TASK_COMMAND_MODE=hybrid` is the default.
- `$directive` routes to the compact orchestrator leader.
- `#task` creates a minimal board task, then starts execution immediately.
- `STATUS_RELAY_MANAGED_ONLY=true` keeps relay polling focused on bridge-created work.
- `COMPACT_AGENT_LIMIT=8` enforces the hard cap.
- `messageId` can be supplied on inbound events to deduplicate connector retries.

## Built-in compact packs

- `software-6`: default software delivery crew
- `ops-5`: incidents, infra, automations
- `research-5`: synthesis and reports
- `support-5`: channel and customer support

## Built-in provider profile defaults

- `codex-main`: primary GitHub-backed coding profile
- `copilot-review`: secondary GitHub-backed review profile
- `claude-cli`: orchestration and review via CLI
- `gemini-cli`: research and ops via CLI
- `opencode-cli`: coding/support via CLI
- `openrouter-fallback`: API fallback profile

Use `AGENTSSWARM_PROVIDER_PROFILES_JSON` to override or extend them.

## Setup

From repository root:

Windows:

```powershell
.\setup_agentsswarm.bat
```

macOS/Linux:

```bash
./setup_agentsswarm.sh
```

Useful setup flags:

- `--update`: refresh local npm dependencies
- `--resync-env`: overwrite local env values from source-of-truth inputs when available
- `--install-openclaw`: install the OpenClaw CLI globally
- `--install-provider-clis`: install provider CLIs globally
- `--with-swarmclaw`: prepare SwarmClaw too
- `--skip-tests`: skip `npm test`

Examples:

```powershell
.\setup_agentsswarm.bat --update --install-openclaw --install-provider-clis --with-swarmclaw
```

```bash
./setup_agentsswarm.sh --resync-env --install-openclaw
```

## Start

Windows:

```powershell
.\start_agentsswarm.bat
```

macOS/Linux:

```bash
./start_agentsswarm.sh
```

Useful start flags:

- `--dev`: watch mode
- `--update`: run `npm update` before launch
- `--resync-env`: force env re-sync before launch
- `--doctor`: run doctor after startup

One-click runtime behavior:

- `start_agentsswarm.bat` and `start_agentsswarm.sh` always stop any process already bound to `BRIDGE_PORT` before launch.
- Launch runs in the current terminal so runtime logs stay visible.
- Monitor UI is available at `http://127.0.0.1:7799/dashboard` once startup completes.

Examples:

```powershell
.\start_agentsswarm.bat --doctor
```

```bash
./start_agentsswarm.sh --dev --resync-env
```

## Required env

- `BRIDGE_SECRET` unless you intentionally run `ALLOW_UNSECURED_BRIDGE=true` for local development
- `CONNECTOR_API_KEY` (or `SWARMCLAW_ACCESS_KEY`) only with `CONNECTOR_BACKEND=external_connector`
- `REMOTE_INBOX_SECRET` (or `INBOX_WEBHOOK_SECRET`) only with `TASK_EXECUTION_BACKEND=remote_api`

Common optional env:

- `AGENTSSWARM_API_URL`
- `AGENTSSWARM_AUTH_TOKEN`
- `DEFAULT_PROJECT_PATH`
- `DEFAULT_PLATFORM`
- `DEFAULT_ACCOUNT_ID`
- `DEFAULT_COMPACT_PACK`
- `DEFAULT_PROVIDER_PROFILE`
- `AGENTSSWARM_REQUIRED_CLI_TOOLS`
- `AGENTSSWARM_PROVIDER_PROFILES_JSON`
- `AGENTSSWARM_PACKS_JSON`
- `MAX_INGEST_BODY_BYTES`
- `INGEST_MESSAGE_ID_TTL_MS`
- `CHANNEL_ROUTE_TTL_MS`
- `PROJECT_ROUTE_TTL_MS`
- `TASK_ROUTE_TTL_MS`
- `PROJECT_PATH_CACHE_TTL_MS`
- `HTTP_RETRY_MAX_ATTEMPTS`
- `HTTP_RETRY_BASE_DELAY_MS`

See `agentsswarm/.env.example` for the full template.

### Standalone execution and approvals

`TASK_EXECUTION_BACKEND=standalone` and `CONNECTOR_BACKEND=none` are the defaults. Both `$` directives and `#` tasks stay local. Without a runner, tasks remain on the board; registration is not execution success.

Set `STANDALONE_TASK_RUNNER_COMMAND` to an operator-controlled executable and `STANDALONE_TASK_RUNNER_ARGS` to a JSON string array (for example `["--json"]`). The bridge starts that fixed command without a shell and writes one JSON task brief followed by a newline to stdin. Task text never becomes executable arguments. The runner must read stdin to EOF and use its exit status to signal success. Output is bounded to 1 MiB; timeout defaults to 300000 ms and concurrency to 2, configurable through `STANDALONE_TASK_RUNNER_TIMEOUT_MS` and `STANDALONE_TASK_RUNNER_CONCURRENCY`.

`STANDALONE_ALLOWED_PROJECT_ROOTS` is a comma-separated absolute-root allowlist. Task working directories must resolve inside it, including symlink resolution. Its default is `DEFAULT_PROJECT_PATH`, otherwise the package root. Runtime JSON and run artifacts live under `AGENTSSWARM_DATA_DIR`; keep that directory private. Interrupted runs are retained as interrupted after restart and are never silently replayed.

Configured standalone execution requires Linux: the bridge passes an open validated directory descriptor to its supervisor and owns the runner process group. Bridge death terminates that group; other platforms fail closed instead of pretending to provide equivalent containment. Windows/macOS can still use the read-only monitor and remote API mode. The fixed runner is trusted code, not a sandbox against deliberate process escape. Public run reads contain lifecycle metadata only; stdout/stderr and artifact paths remain in the private data directory. HTTPS skill provenance omits query strings and fragments.

Authenticated `POST /tasks` accepts `requiresApproval:true` and `runNow:false`. Approval-required tasks cannot run until the corresponding authenticated `POST /approvals/:id/approve`; decisions are terminal and cannot be replayed. The existing default remains `requiresApproval:false`. The monitor is read-only; approvals are not a promise of sandboxing the configured runner.

Startup reconciles durable approval decisions and task links before accepting requests. It repairs interrupted writes without launching tasks; after recovery an approved task still needs an explicit run request.

Schedules accept exactly one of an ISO `runAt` or positive `intervalMs`, plus `commandText` and task routing metadata. Missed occurrences are not replayed and one schedule cannot overlap itself. Imported skills are bounded inert text, never executable code; HTTPS imports reject redirects and non-public destinations. Connector responses redact credentials; an unverified/configured state is not evidence of external connectivity.

### Monitor and canonical verification

The shared dependency-free monitor is served at `/dashboard`; `npm --prefix ui run dev -- --port 7800` serves the same assets with a narrow read-only bridge proxy. `npm run build:web` emits the deployable static assets under `ui/dist`. No credentials are embedded in the monitor.

Canonical gates remain `npm ci`, `npm --prefix ui ci`, `npm run check`, `npm test`, `npm run test:web`, `npm run build:web`, bridge startup and `BRIDGE_URL=http://127.0.0.1:7801 npm run test:perf` on Node22. The performance gate makes 100 real health/dashboard/summary requests, requires zero errors and p95 below 1000 ms, and bounds readiness to 20 seconds. This is a local regression budget, not a production SLA.


## Chat routing contract

The bridge accepts one normalized envelope for all inbound sources:

```json
{
  "text": "#ship release",
  "messageId": "discord-987654321",
  "connectorId": "connector-1",
  "channelId": "engineering-room",
  "platform": "discord",
  "accountId": "primary",
  "threadId": "release-thread",
  "projectPath": "C:/workspace/app",
  "providerProfileId": "codex-main",
  "compactPackKey": "software-6",
  "senderId": "user-1",
  "senderName": "Founder"
}
```

Route priority:

1. task route
2. channel route
3. project route
4. default route

## CLI commands

```bash
npm run cli -- health
npm run cli -- routes
npm run cli -- channels
npm run cli -- summary
npm run cli -- providers
npm run cli -- packs
npm run cli -- preflight
npm run cli -- doctor
npm run cli -- prune --dry-run
```

Channel simulation examples:

```bash
npm run cli -- ingest --text "$sync roadmap" --connector founder --channel founders --platform telegram --account primary --pack software-6 --providerProfile codex-main
npm run cli -- ingest --text "#ship release" --connector eng --channel engineering --platform discord --thread release-room --pack software-6 --providerProfile copilot-review
npm run cli -- ingest --text "$triage customer issue" --connector support --channel biz --platform whatsapp --account biz --pack support-5 --providerProfile opencode-cli
```

## HTTP endpoints

- `GET /health`
- `GET /routes`
- `GET /channels`
- `GET /providers`
- `GET /packs`
- `GET /summary`
- `POST /ingest`
- `POST /maintenance/prune`

## SwarmClaw connector config

For each manager connector in SwarmClaw, set connector `config` keys:

- `bridgeEndpoint=http://127.0.0.1:7799`
- `bridgeSecret=<BRIDGE_SECRET>` when `BRIDGE_SECRET` is set
- `bridgeProjectPath=<absolute path>` when a connector should default to one project

## Operator workflow

1. Run setup.
2. Run OpenClaw auth flow for the provider profiles you want.
3. Wire SwarmClaw connectors for Telegram, Discord, and/or WhatsApp.
4. Start AgentSwarm.
5. Run `npm run cli -- doctor`.
6. Send `$` or `#` commands from chat.

## Verification

Inside `agentsswarm/`:

```bash
npm run check
npm test
npm run cli -- preflight
```

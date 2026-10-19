# AgentSwarm Context and Progress

This document captures the current context, architecture, operational expectations, recent hardening work, and remaining roadmap for `agentsswarm/`.

## Purpose

`agentsswarm/` is a compact bridge runtime for chat-first orchestration.

It sits between inbound chat connectors and the downstream AgentSwarm / Claw-Empire API and is optimized for:

- routing `$` directives and `#` tasks from Telegram, Discord, WhatsApp, and CLI
- applying compact-pack and provider-profile defaults at the bridge layer
- registering channel/project/task routes for reply and relay behavior
- relaying managed task status updates back to the originating connector
- giving operators a small CLI and HTTP surface for health, packs, providers, channels, summary, ingest, and maintenance

## Current Architecture

### Runtime modules

- `src/index.js`: HTTP bridge, ingress validation, route registration, dedupe, maintenance prune endpoint, request IDs, and persistence scheduling
- `src/config.js`: env loading, runtime defaults, safety settings, TTL settings, retry settings, and config issue surfacing
- `src/orchestrator.js`: execution context assembly, pack/profile resolution, and downstream metadata shaping
- `src/forwarder.js`: downstream API integration, auth bootstrap, project binding, compact-agent scoping, task create/run, task list, connector send, and retry-aware GET handling
- `src/providers.js`: provider profile catalog, CLI tool inventory, availability-aware profile selection, and provider summary
- `src/compact-packs.js`: compact pack definitions and override parsing
- `src/channels.js`: normalized route and connector payload contract
- `src/status-relay.js`: managed-task polling and relay updates
- `src/state-store.js`: persistent bridge state storage
- `src/cli.js`: operator commands (`health`, `routes`, `channels`, `summary`, `providers`, `packs`, `preflight`, `doctor`, `ingest`, `prune`)
- `src/logger.js`: structured runtime logging and request ID helpers
- `src/standalone-tasks.js` and `src/standalone-approvals.js`: durable local runner lifecycle and explicit approval decisions
- `src/schedule-manager.js`: one-shot/interval scheduling without missed-run replay
- `src/runtime-settings.js` and `src/connector-manager.js`: persisted operator defaults and credential-redacted connector inventory
- `src/skill-loader.js`: bounded inert skill imports and matching
- `src/agent-soul.js`, `src/role-presets.js`, `src/channel-templates.js`, `src/task-fields.js`, and `src/metrics.js`: template/catalog normalization and bounded runtime counters
- `ui/`: shared read-only vanilla monitor, static build and loopback development server

### Stored state

The bridge persists:

- channel routes
- project routes
- task routes
- managed task IDs
- last-known task statuses

Default state file: `agentsswarm/data/bridge-state.json`

## Execution Model

### `$` directives

- require a project path or default project path
- resolve an existing project by path or create one if missing
- forward to `/api/inbox` with compact-pack, provider profile, and workflow metadata

### `#` tasks

- create a task through `/api/tasks`
- optionally run immediately when `TASK_COMMAND_MODE=hybrid`
- only register on the board when `TASK_COMMAND_MODE=board_only`
- map the created task back to the source connector for relay updates

### Route precedence

1. task route
2. channel route
3. project route
4. configured default route

## Baseline Before This Pass

Before the current hardening pass, the runtime already had:

- a clear modular split
- compact pack and provider profile abstractions
- a small operator CLI and health surface
- unit coverage around routing, provider defaults, forwarder behavior, relay logic, and state storage

The main gaps were:

- weak `/ingest` validation and no request size cap
- unauthenticated bridge operation when `BRIDGE_SECRET` was empty
- synchronous non-atomic state writes
- no request correlation IDs or structured logs
- silent config fallback on invalid JSON overrides
- no route TTL pruning or maintenance endpoint
- no message-id dedupe for connector retries
- limited resilience around transient upstream GET failures
- no project-path lookup cache
- confusing `direct_run` mode semantics
- provider selection that did not prefer available tools automatically

## Progress Completed In This Pass

### 1. Security and ingress hardening

Completed:

- made `BRIDGE_SECRET` required by default unless `ALLOW_UNSECURED_BRIDGE=true`
- added bounded request-body reads with `MAX_INGEST_BODY_BYTES`
- added stronger ingest validation for command text, IDs, route fields, platform support, and absolute project paths
- added request IDs on responses and structured runtime logs for successful and rejected requests
- added `messageId` support for deduplicating repeated connector deliveries inside a TTL window

### 2. Reliability and state safety

Completed:

- replaced synchronous state writes with async best-effort atomic writes via temp-file + rename
- queued bridge-state persistence to avoid repeated blocking writes during rapid updates
- added TTL-based pruning for stale channel, project, and task routes
- added `POST /maintenance/prune` and `npm run cli -- prune` for operator cleanup
- added project-path lookup caching to avoid repeated paginated project searches
- added retry-aware GET requests for transient upstream failures

### 3. Provider and pack execution quality

Completed:

- added availability-aware provider selection so execution prefers runnable profiles when possible
- surfaced unavailable profile IDs in provider summaries and health tooling
- normalized deprecated `TASK_COMMAND_MODE=direct_run` to `hybrid` and exposed it as a config issue instead of pretending it is a distinct mode

### 4. Operator visibility

Completed:

- surfaced config issues in health, summary, providers, packs, preflight, and doctor output
- added structured logs for bridge start, ingest handling, task/directive forwarding, relay sends, retry events, and prune operations

### 5. Test coverage

Completed:

- added config tests for bridge-secret enforcement and config issue surfacing
- added provider fallback tests for unavailable tools
- added forwarder tests for project lookup cache reuse and transient GET retries
- added bridge tests for oversized requests, message-id dedupe, and prune maintenance behavior
- updated state-store tests for async writes

## Current Verification Status

Last verified in `agentsswarm/` with:

```bash
npm run check
npm test
```

Both passed after the changes in this pass.

## Runtime Safety Notes

### Authentication

- `BRIDGE_SECRET` should be set for every non-local deployment
- `ALLOW_UNSECURED_BRIDGE=true` is only intended for explicit local development
- `INBOX_WEBHOOK_SECRET` remains required for downstream inbox forwarding
- `SWARMCLAW_ACCESS_KEY` remains required for connector sends and doctor/preflight health

### Dedupe behavior

- inbound events may include `messageId`
- dedupe key is `commandType + normalized route key + messageId`
- dedupe is TTL-based and intended to absorb connector retries, not replace upstream idempotency guarantees

### State cleanup behavior

Default TTLs:

- channel routes: 7 days
- project routes: 7 days
- task routes: 3 days
- project-path lookup cache: 5 minutes
- message-id dedupe cache: 5 minutes

Operators can prune immediately with:

```bash
npm run cli -- prune
npm run cli -- prune --dry-run
```

## Remaining Roadmap

These are still worthwhile after the current pass:

### Near-term

- add optional pack-role validation so each compact pack can report missing or unavailable provider profiles directly
- add richer operator trace tooling such as `task trace <id>` or `routes explain`
- add integration coverage for CLI command flows, not just module-level behavior
- add better connector-send error classification and relay metrics

### Later-stage

- move persistent state from JSON file to SQLite or another small embedded store
- add richer audit history and delivery history instead of current latest-state persistence only
- add upstream idempotency support if the downstream AgentSwarm API exposes a stable mechanism

## Suggested Operating Routine

Use this sequence when working on AgentSwarm:

1. update `agentsswarm/.env`
2. run `npm run cli -- preflight`
3. start the bridge
4. run `npm run cli -- doctor`
5. test ingest with `npm run cli -- ingest ...`
6. prune stale state if needed with `npm run cli -- prune --dry-run`

## Changelog Summary for This Pass

- documented the full current runtime context in this file
- hardened ingress and bridge authentication defaults
- improved persistence safety and stale-state cleanup
- improved provider selection behavior when tools are unavailable
- improved observability and operator diagnostics
- expanded test coverage to lock in the new behavior
- Replacement development restores the eleven missing runtime modules and separate UI package while retaining every canonical CI gate. The fixed runner protocol, approval semantics and local performance regression budget are documented in `README.md`.

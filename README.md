# GoClaw Agent Swarms — OpenClaw Multi-Agent Orchestration

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-yellow.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![GoClaw](https://img.shields.io/badge/Powered%20By-GoClaw-blue.svg)](https://github.com/nextlevelbuilder/goclaw)

**The practical playbook for building GoClaw agent swarms. GoClaw is a multi-tenant AI gateway written in Go — deploy teams of agents wired for Telegram, Discord, Slack, Feishu, Zalo, and WhatsApp, with built-in task boards, inter-agent delegation, skills, heartbeat, cron, and 20+ LLM providers.**

</div>

---

## Table of Contents

- [What is GoClaw?](#what-is-goclaw)
- [Why GoClaw?](#why-goclaw)
- [Quick Start](#quick-start)
- [GoClaw Agent Teams](#goclaw-agent-teams)
- [Agent Pack Templates](#agent-pack-templates)
- [Pack Library](#pack-library)
- [Porting Packs to GoClaw](#porting-packs-to-goclaw)
- [Documentation Map](#documentation-map)
- [Sources](#sources)

---

## What is GoClaw?

[GoClaw](https://github.com/nextlevelbuilder/goclaw) is OpenClaw rebuilt in Go — a production-grade multi-agent AI gateway with:

- **Single binary** (~25 MB, no Node.js runtime, <1s startup, runs on a $5 VPS)
- **Multi-tenant PostgreSQL** — per-user workspaces, encrypted API keys (AES-256-GCM), isolated sessions
- **Agent Teams** — lead + member orchestration with shared task boards, sync/async delegation, and mailbox messaging
- **20+ LLM providers** — Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, Gemini, Mistral, xAI, Ollama, Claude CLI, Codex, and more
- **7 messaging channels** — Telegram, Discord, Slack, Feishu/Lark, Zalo OA, Zalo Personal, WhatsApp
- **5-layer security** — gateway auth → global tool policy → per-agent → per-channel → owner-only, plus rate limiting and prompt injection detection
- **Skills system** — `SKILL.md` packages with BM25 + pgvector hybrid search
- **Built-in observability** — LLM call tracing with spans, prompt cache metrics, optional OpenTelemetry export
- **Heartbeat + Cron** — proactive periodic check-ins and scheduled agent tasks
- **Knowledge graph** — LLM-powered entity extraction and relationship traversal

Full docs at [docs.goclaw.sh](https://docs.goclaw.sh).

---

## Why GoClaw?

| | GoClaw | OpenClaw (TypeScript) |
|-|--------|----------------------|
| Binary size | ~25 MB static | 28 MB + Node.js |
| RAM idle | ~35 MB | >1 GB |
| Startup | <1s | >5s |
| Target hardware | $5 VPS+ | $599+ Mac Mini |
| Multi-tenant | ✅ PostgreSQL | ✅ File-based |
| Agent teams | ✅ Task board + mailbox | ⚠️ Partial |
| Security | 5-layer defense | Basic |
| 20+ LLM providers | ✅ Native | 10+ |
| Channels | 7 | 37+ |
| Skills system | ✅ BM25 + pgvector | ✅ Embeddings |
| Observability | ✅ OTLP opt-in | ⚠️ Basic |

GoClaw gives you production-grade architecture in a tiny footprint.

---

## Quick Start

### 1. Install GoClaw

**macOS/Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/nextlevelbuilder/goclaw/main/scripts/install-lite.sh | bash
```

**Windows PowerShell:**
```powershell
irm https://raw.githubusercontent.com/nextlevelbuilder/goclaw/main/scripts/install-lite.ps1 | iex
```

**Or from source (Go 1.26+):**
```bash
git clone -b main https://github.com/nextlevelbuilder/goclaw.git && cd goclaw
make build
./goclaw onboard
source .env.local && ./goclaw
```

### 2. Configure at least one LLM provider

Edit `.env.local` in the goclaw directory:
```env
GOCLAW_ANTHROPIC_API_KEY=sk-ant-...
GOCLAW_OPENAI_API_KEY=sk-...
```

Or use OpenRouter for access to 100+ models:
```env
GOCLAW_OPENROUTER_API_KEY=sk-or-...
```

### 3. Connect a channel

**Telegram:**
```bash
./goclaw channels add telegram
# Follow interactive prompts for bot token
```

**Discord:**
```bash
./goclaw channels add discord
# Follow interactive prompts for bot token and gateway intents
```

### 4. Create your first agent

```bash
./goclaw agents add --name "assistant" --provider anthropic
```

### 5. Start the gateway

```bash
./goclaw
# Web dashboard: http://localhost:18790
```

---

## GoClaw Agent Teams

GoClaw's team system maps directly to the agent pack concept:

```
Lead Agent (orchestrator)
  ├── Member 1 (specialist)
  ├── Member 2 (specialist)
  ├── Member 3 (specialist)
  ├── Member 4 (specialist)
  └── Member 5 (specialist)
```

Each agent runs with its own identity, tools, LLM provider, and context files. The lead orchestrates via:

- **Task Board** (`team_tasks`) — create, claim, complete tasks with `blocked_by` dependencies
- **Delegation** — sync (wait for result) or async (wait for announcement) task assignment
- **Mailbox** — team members communicate via direct messages

### Creating a Team

```bash
./goclaw teams create --name "research-desk" --lead research_lead
./goclaw teams add research-desk --agents crawler fact_check data_analyst writer editor
```

Or via the dashboard at `http://localhost:18790`.

### Delegation Pattern

```
User → Lead Agent (research_lead)
         ├── Sync delegate → fact_check_lead (quick verification)
         └── Async delegate → crawler_specialist (deep research)
                   ↓ (later)
              crawler_specialist announces result to lead
         ↓
    Lead synthesizes and delivers to user
```

---

## Agent Pack Templates

Pre-built, deployment-ready agent swarms for GoClaw. Each pack is a complete team with role-specific context files, coordination patterns, and Discord/Telegram channel wiring.

### Available Packs

| Pack | Team | Best For |
|------|------|----------|
| `dev-ops-corp` | 9 agents | Coding & release workflows |
| `research_report` | 6 agents | Research → fact-check → polished report |
| `review_desk` | 6 agents | Multi-specialist review with PASS/FAIL verdicts |
| `financial_analyst` | 6 agents | Market analysis → risk assessment → briefing |
| `second_brain` | 7 agents | Personal knowledge capture & retrieval |

See [templates/samples/](templates/samples/) for full pack library, agent rosters, and GoClaw deployment commands.

---

## Pack Library

### DevOpsCorp — Coding & Release Workflow

`templates/samples/dev-ops-corp/`

| Agent | Role |
|-------|------|
| `orchestrator` | Planning, intake, task routing |
| `sub1` | Execution track A (backend/API) |
| `sub2` | Execution track B (automation/scripts) |
| `sub3` | Execution track C (docs/ops) |
| `reviewer` | QA gate, release readiness |
| `compliance_auditor` | DevSecOps & compliance |
| `data_engineer` | Data pipeline & ETL |
| `security_architect` | Threat modeling, vulnerability review |
| `test_automation` | Test strategy & automation |

### Research Report Pack — 1 Lead + 5

`templates/samples/research_report/`

| Agent | Role |
|-------|------|
| `research_lead` | Coordinates research, synthesizes findings |
| `crawler_specialist` | Web/data harvesting, source identification |
| `fact_check_lead` | Claim verification, confidence levels |
| `data_analyst` | Statistical processing, pattern detection |
| `technical_writer` | Drafts sections, translates for audience |
| `summary_editor` | Final polish, formatting, release gate |

### Review Desk Pack — 1 Lead + 5

`templates/samples/review_desk/`

| Agent | Role |
|-------|------|
| `review_lead` | Queue management, final verdicts (PASS/FAIL) |
| `technical_reviewer` | Code correctness, architecture, edge cases |
| `compliance_reviewer` | Regulatory/policy alignment |
| `style_guide_enforcer` | Brand voice, formatting, accessibility |
| `quality_assurance` | Testing, release readiness sign-off |
| `feedback_curator` | Synthesizes and delivers reviewer feedback |

### Financial Analyst Pack — 1 Lead + 5

`templates/samples/financial_analyst/`

| Agent | Role |
|-------|------|
| `finance_lead` | Strategic direction, recommendation synthesis |
| `market_researcher` | Market conditions, competitive landscape |
| `quantitative_analyst` | Statistical modeling, pattern analysis |
| `risk_assessor` | Scenario analysis, stress tests, risk matrices |
| `finance_report_writer` | Narrative drafting, executive summaries |
| `data_visualizer` | Charts, dashboards, presentation visuals |

### Second Brain Pack — 1 Lead + 6

`templates/samples/second_brain/`

| Agent | Brain Region | Role |
|-------|-------------|------|
| `orchestrator_agent` | Thalamus | Central coordinator, routing |
| `capture_agent` | Sensory Cortex | Intake & collection |
| `tagger_agent` | Hippocampus | Semantic tagging & categorization |
| `memory_writer_agent` | Cortex | Memory consolidation & storage |
| `search_agent` | Frontal Lobe | Query processing & recall |
| `recall_agent` | Temporal Lobe | Long-term memory retrieval |
| `synthesis_agent` | Prefrontal Cortex | Cross-domain synthesis |

---

## Porting Packs to GoClaw

The 4-file per-agent structure maps directly to GoClaw's context file system:

| Original Pack File | GoClaw Context File | Purpose |
|-------------------|---------------------|---------|
| `SOUL.md` | `SOUL.md` | Persona, core truths, tone, boundaries |
| `IDENTITY.md` | `IDENTITY.md` | Name, emoji, avatar, communication style |
| `AGENTS.md` | *(integrated into SOUL.md + system prompt)* | Workspace conventions, memory, group chat rules, heartbeat |
| `TOOLS.md` | `TOOLS.md` | Role-specific tool notes, environment details |
| `USER.md` | `USER.md` | Human profile, project context, preferences |

### Key Differences

1. **No file-based workspaces** — GoClaw stores agents, context files, and memory in PostgreSQL. Files are loaded into context at runtime.

2. **Teams replace orchestration scripts** — Instead of Discord channel routing and manual agent coordination, use GoClaw's native team system with `team_tasks` and delegation.

3. **Skills are first-class** — Pack-specific skills (e.g., `SKILL.md` for research methodology, financial analysis, code review) go in `goclaw/skills/` and are injectable per-agent.

4. **TEAM.md is auto-generated** — GoClaw injects `TEAM.md` at runtime for team members. Don't create it manually.

5. **Context file injection** — Use `./goclaw agents update <name> --context-files` or the dashboard to inject pack context files into agents.

### Porting Steps

```
1. Map agents to GoClaw team members
   agents add --name research_lead --provider anthropic
   agents add --name crawler_specialist --provider openai
   ...

2. Create a team and link agents
   teams create --name research-report --lead research_lead
   teams add research-report --agents crawler_specialist fact_check_lead data_analyst technical_writer summary_editor

3. Inject context files per agent
   agents update research_lead --context-files templates/samples/research_report/research_lead/

4. Add pack-specific skills
   cp -r templates/samples/research_report/skills/ goclaw/skills/

5. Configure channel bindings
   agents bind --agent research_lead --channel telegram --chat-id YOUR_CHAT_ID
```

See [GOCLAW_PACKS.md](GOCLAW_PACKS.md) for the full porting guide.

---

## Documentation Map

### Start Here
- **[GOCLAW_SETUP.md](GOCLAW_SETUP.md)** — Complete installation and configuration guide
- **[GOCLAW_PACKS.md](GOCLAW_PACKS.md)** — Porting agent packs to GoClaw teams
- **Full docs:** [docs.goclaw.sh](https://docs.goclaw.sh)

### Core Reference
- **Teams:** [docs.goclaw.sh/#teams-what-are-teams](https://docs.goclaw.sh/#teams-what-are-teams)
- **Agents:** [docs.goclaw.sh/#agents-explained](https://docs.goclaw.sh/#agents-explained)
- **Skills:** [docs.goclaw.sh/#skills](https://docs.goclaw.sh/#skills)
- **Channels:** [docs.goclaw.sh/#channels-overview](https://docs.goclaw.sh/#channels-overview)
- **Providers:** [docs.goclaw.sh/#providers-overview](https://docs.goclaw.sh/#providers-overview)

### Templates (GoClaw-Native)
- **[templates/samples/](templates/samples/)** — Agent pack templates with GoClaw-compatible context files
- **[templates/AGENTS.md](templates/AGENTS.md)** — Default AGENTS.md (GoClaw-compatible)
- **[templates/SOUL.md](templates/SOUL.md)** — SOUL.md template
- **[templates/IDENTITY.md](templates/IDENTITY.md)** — IDENTITY.md template
- **[templates/USER.md](templates/USER.md)** — USER.md template

### Legacy (OpenClaw/AgentSwarm)
- [`agentsswarm/`](agentsswarm/README.md) — Node22 chat bridge, configured standalone runner and shared read-only vanilla monitor; independent of GoClaw
- `CLAW_EMPIRE_SETUP.md` — Legacy visual office reference

---

## Sources

- GoClaw GitHub: [github.com/nextlevelbuilder/goclaw](https://github.com/nextlevelbuilder/goclaw)
- GoClaw Docs: [docs.goclaw.sh](https://docs.goclaw.sh)
- GoClaw Lite (Desktop): [docs.goclaw.sh/#desktop-edition-goclaw-lite](https://docs.goclaw.sh/#desktop-edition-goclaw-lite)
- Agent Teams: [docs.goclaw.sh/#teams-what-are-teams](https://docs.goclaw.sh/#teams-what-are-teams)
- Skills: [docs.goclaw.sh/#skills](https://docs.goclaw.sh/#skills)

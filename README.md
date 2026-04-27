<p align="center">
  <img src="frontend/public/logo.svg" alt="/ S /" width="96" />
</p>

<h1 align="center">Servus</h1>

<p align="center">
  <strong>Local-first AI operator for coding, browser workflows, desktop files, data/docs, media, security analysis, and custom skills/plugins.</strong>
</p>

<p align="center">
  <a href="https://github.com/TangoBeee/servus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" /></a>
  <a href="https://www.npmjs.com/package/servusai"><img src="https://img.shields.io/npm/v/servusai.svg?color=blue" alt="npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node >= 20" /></a>
</p>

---

Servus is a CLI-first AI agent platform. It started as a coding agent, but now routes work through domain-specific engines for code, browser automation, desktop file operations, media processing, data/document work, security analysis, extension creation, and general tasks.

The core design goal is reliability: Servus should not mark work complete just because an agent says it is done. Runs are expected to collect evidence, satisfy a runtime contract, preserve session state, and produce proof artifacts.

## Current Capabilities

| Domain | What it does |
|---|---|
| **Coding** | Reads and edits repositories, discovers verification commands, runs checks, and repairs failures with proof-backed completion. |
| **Browser** | Uses native Playwright with persistent browser sessions, hybrid snapshots, stable refs, screenshots, extraction, browser memory, and consent gates for irreversible actions. |
| **Desktop** | Performs safe local file/OS work: ranked search, path inspection, candidate selection, open/copy/move/trash, clipboard operations, and post-action verification. |
| **Media** | Checks `yt-dlp`, `ffmpeg`, and `ffprobe`; inspects media, downloads, converts, trims, compresses, extracts audio, and generates thumbnails. |
| **Data & Docs** | Reads PDF, DOCX, TXT, Markdown, CSV, TSV, JSON, XLS, and XLSX files; extracts text/tables; converts tables; writes report artifacts. |
| **Security** | Runs safe Offensive, Defensive, or Hybrid analysis for authorized targets using recon, static scans, dependency/config/log checks, TLS/header inspection, playbooks, and structured reports. |
| **Extension Builder** | Creates project/user `SKILL.md` files and `servus.plugin.json` manifests from prompts. |
| **General** | Handles simple non-mutating questions without accidentally routing into coding/project-file behavior. |

## Runtime Model

Servus uses a runtime-first loop:

```text
understand -> discover -> plan -> act -> verify -> finalize
```

Key pieces:

- **Run contracts** define intent, acceptance criteria, required evidence, risk, and repair limits.
- **Structured finish tools** (`servus_done`, `servus_need_input`) replace tag-only completion.
- **Completion validation** rejects missing, ambiguous, stale, or contradicted evidence.
- **Session continuity** keeps the same `sessionId` across follow-ups, clarification answers, approvals, browser state, artifacts, evidence, and proof bundles.
- **Tool metadata** tracks domain, risk, read-only/mutating behavior, consent requirements, timeouts, and artifact outputs.

## Quickstart

```bash
# Install globally
npm install -g servusai

# Launch the interactive TUI
servus

# Or run a task directly
servus "Add rate limiting middleware" --domain coding
```

From source:

```bash
git clone https://github.com/TangoBeee/servus.git
cd servus
npm install
npm run build
npm start -- --help
```

## CLI Usage

```text
servus                     Launch interactive TUI
servus config              Open settings
servus sessions            Browse past runs
servus jobs                Manage background jobs
servus dashboard           Open live dashboard

servus <task> [options]    Run a task directly
```

Useful options:

```text
--domain <domain>          auto | coding | browser | desktop | media | data | extension | security | general
--mode <mode>              claude-code | custom
--model <model>            Model name or provider:model
--cwd <path>               Working directory
--verify <command>         Custom verification command
--budget <usd>             Max spend in USD
--provider-url <url>       Base URL for openai-compatible providers
```

Examples:

```bash
servus "Fix the failing tests in this repo" --domain coding --cwd ./backend
servus "Find the latest invoice PDF in my home folder" --domain desktop
servus "Extract tables from ./reports/q1.xlsx and create a markdown report" --domain data
servus "Inspect this mp4 and extract audio to mp3" --domain media
servus "Review this API for authorization issues and suggest fixes" --domain security
servus "Create a project skill for our release checklist" --domain extension
```

## Configuration

Set at least one provider key:

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export GOOGLE_GENERATIVE_AI_API_KEY="..."
```

Servus chooses a default model from available provider keys when possible. You can still override the model from the TUI or direct CLI.

## Local State

Servus stores local run data under `~/.servus`, including session records, browser session state, proof bundles, skills, plugins, and configuration. Browser automation uses persistent Playwright profiles per session so follow-up answers can continue in the same browser context when appropriate.

## Safety

Servus is designed to be useful, not reckless:

- Destructive local actions require consent and post-action verification.
- Browser purchases, bookings, posting, sending messages, credential entry, deletion, payments, and other irreversible actions are consent-gated.
- Captchas, Cloudflare blocks, login requirements, missing user data, and payment steps are treated as blockers or handoff points, not bypass targets.
- Security mode is for authorized systems only and uses safe, non-destructive validation.

## Extensibility

Servus supports local skills and plugin manifests:

- Project skills: `.servus/skills/<name>/SKILL.md`
- User skills: `~/.servus/skills/<name>/SKILL.md`
- Project plugins: `.servus/plugins/<id>/servus.plugin.json`
- User plugins: `~/.servus/plugins/<id>/servus.plugin.json`

The Extension Builder can scaffold these from a prompt, then validate the generated files.

## Status

The current stable direction is:

- CLI and TUI first.
- Runtime contracts and proof-backed completion as the source of truth.
- Native Playwright for browser automation.
- Local desktop/media/data/security capabilities.
- Skills and plugin scaffolding now, deeper plugin/MCP activation over time.

## Disclaimer

Servus is an AI agent and can make mistakes. It may write incorrect code, run unexpected commands/actions, or modify files in unintended ways. Always review changes, keep important projects under version control, and use appropriate backups.

## License

MIT — see [LICENSE](LICENSE) for details.


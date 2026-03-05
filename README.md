# Servus

Servus is an autonomous CLI-based AI coding agent built for deep, long-term task execution and continuous engineering context.

## Features
- **Multi-Provider LLM**: Supports OpenAI (`gpt-*`), Anthropic Claude (`claude-*`), and Google Gemini (`gemini-*`) models out of the box.
- **ReAct Loop Agent**: Powered by Vercel AI SDK to Observe, Think, and Act.
- **Persistent Memory**: Retains conversation sequences and continuous context across reboots (`.servus/`).
- **Sub-Agent Delegation**: Smartly delegates independent complexity off to nested sub-agents when required.
- **Infinite Watcher Loop**: Runs via `--watch` to constantly monitor your workspace and autonomously resolve user intent upon file saves.
- **Asynchronous Injection**: Type `i` (Interrupt) at any time to stream real-time directional intent into the LLM context flow.
- **E2E Task Validation**: Written to strictly verify the output of its own generated scripts using the terminal, effectively writing and self-healing its code.

## Quickstart

### Install globally from npm
```bash
npm install -g servusai
servusai "Build me a simple express server"
```

### Or run from source
```bash
git clone https://github.com/TangoBeee/servus.git
cd servus
npm install
npm run build
node dist/index.js "Build me a simple express server"
```

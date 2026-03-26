<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/canvasxai/sketch/main/assets/sketch.svg" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/canvasxai/sketch/main/assets/sketch-dark.svg" />
    <img alt="Sketch" src="https://raw.githubusercontent.com/canvasxai/sketch/main/assets/sketch-dark.svg" width="200" />
  </picture>
</p>

<h3 align="center">One AI assistant for your entire team.<br/>Deploy once. Show up everywhere.</h3>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License" /></a>
  <img src="https://img.shields.io/github/v/tag/canvasxai/sketch?style=for-the-badge&label=version&color=green" alt="version" />
  <img src="https://img.shields.io/badge/node-24%2B-brightgreen?style=for-the-badge" alt="Node 24+" />
  <a href="https://github.com/canvasxai/sketch/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/canvasxai/sketch/ci.yml?style=for-the-badge&label=CI" alt="CI" /></a>
  <a href="https://github.com/canvasxai/sketch/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=for-the-badge" alt="PRs Welcome" /></a>
  <a href="https://getsketch.ai/discord"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://platform.claude.com/docs/en/agent-sdk/overview"><img src="https://img.shields.io/badge/built%20with-Claude%20Agent%20SDK-D97757?style=for-the-badge" alt="Built with Claude Agent SDK" /></a>
</p>

---

## The problem nobody talks about

AI assistants are incredible — until you try to share one with your team.

Right now, every person on your team sets up their own AI. Their own API keys. Their own context. Their own memory. Nobody's assistant knows what the company actually does. Nobody's assistant remembers the onboarding doc you uploaded last week. And when someone leaves, their carefully-built context walks out the door with them.

We kept watching teams duct-tape personal AI tools into workflows that clearly needed a shared brain. Founders answering the same customer question their assistant already answered for a teammate. Engineers re-explaining the codebase to a fresh Claude window every morning. Ops people copy-pasting the same SOPs into chat because the bot doesn't "know" yet.

It felt broken.

## What Sketch actually is

Sketch is an open-source, self-hostable AI assistant built for teams. One deployment, every team member, any channel they already use.

Think of it as giving your entire org a shared AI teammate — one that remembers, learns, and works across Slack and WhatsApp — while still keeping everyone's private stuff private.

**Here's what makes it different from "just another chatbot":**

- **Isolated workspaces** — each person gets their own files, memory, and sessions. Your stuff doesn't leak into mine.
- **Shared org knowledge** — upload a doc once and everyone's assistant knows it. No more "hey can you send me that PDF again?"
- **Multi-channel, same brain** — message it on Slack, pick up the thread on WhatsApp. It's the same assistant, same memory, wherever you are.
- **Per-user tool auth** — each person connects their own integrations (Gmail, GitHub, etc.). The assistant acts on *your* behalf, not the org's.
- **Real memory** — personal, channel, and org-level memory layers. It actually remembers things between conversations.
- **Skills system** — deploy org-wide skills (like ICP discovery or CRM tools) that every team member gets automatically.
- **Genuinely self-hostable** — a single Node.js process and SQLite. No Kubernetes thesis required.

> Inspired by [OpenClaw](https://github.com/openclaw/openclaw) — a brilliant personal AI assistant. Sketch takes its multi-channel, local-first approach and adds the missing piece: a multi-user org layer.

## Quick Start

Requires **Node.js 24+** and **pnpm**. That's it.

```bash
git clone https://github.com/canvasxai/sketch.git
cd sketch
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000` — the onboarding wizard walks you through Slack/WhatsApp setup, API keys, and your first conversation.

## How it works

```
  Slack / WhatsApp
        |
    Gateway (Bolt / Baileys)
        |
    Message Queue (per-channel, sequential)
        |
    Agent Runner
        |
    Claude Agent SDK
        |
    Workspace (scoped files, tools, memory)
```

Every user gets a sandboxed workspace at `data/workspaces/{user_id}/`. Every tool call passes through `canUseTool` — a runtime validator that checks file paths and permissions before anything executes. The agent literally cannot escape its sandbox.

Channels share workspaces too — @mention Sketch in a Slack channel and the whole channel gets a shared context with per-thread sessions. No conversation soup.

## Channels

| Channel    | Status |
|------------|--------|
| Slack      | Stable — DMs, @mentions in channels, threaded conversations |
| WhatsApp   | Stable — DMs and group chats, media support |

Both channels support file attachments, images (with vision), and file sharing back to chat.

## Self-Hosting

Sketch runs as a single Node.js process — API server, web UI, and agent runner all in one. No separate web server, no external database, no Docker Compose manifesto.

SQLite by default (Postgres when you outgrow it). Throw it on a $5 VPS and you're done.

See the full [Self-Hosting Guide](SELF_HOSTING.md) for production deployment with systemd and Caddy.

## Tech Stack

| What           | How                            |
|----------------|--------------------------------|
| Runtime        | Node.js 24, TypeScript         |
| Agent brain    | Claude Agent SDK               |
| Database       | SQLite (Kysely query builder)  |
| HTTP           | Hono                           |
| Frontend       | React, Vite                    |
| Build          | tsdown, pnpm monorepo          |
| Lint + Format  | Biome                          |
| Tests          | Vitest (800+ tests)            |

## Project Structure

```
sketch/
  packages/
    server/src/
      slack/          -> Bolt adapter (Socket Mode, DMs, channels, threads)
      whatsapp/       -> Baileys adapter (QR pairing, media, groups)
      agent/          -> Claude Agent SDK runner, workspace isolation, prompts
      db/             -> Kysely + SQLite, migrations, repositories
      http.ts         -> Hono app with API routes
      queue.ts        -> Per-channel sequential message queue
    web/src/          -> React admin UI (onboarding, channels, settings)
    shared/src/       -> Shared types
  data/               -> Runtime data (workspaces, SQLite DB) — gitignored
```

## Contributing

We'd genuinely love your help. Whether it's a new channel adapter, a skill, a bug fix, or telling us our error messages are confusing — all of it matters.

Join us on [Discord](https://getsketch.ai/discord) to chat with the team, ask questions, or just hang out.

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, code style, and PR guidelines.

## License

MIT — see [LICENSE](LICENSE).

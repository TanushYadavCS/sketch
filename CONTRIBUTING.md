# Contributing to Sketch

Thanks for your interest in contributing to Sketch! This guide will help you get set up and familiar with the project.

## Prerequisites

- **Node.js 24+** (LTS)
- **pnpm** (`npm install -g pnpm`)

## Dev Setup

```bash
git clone https://github.com/canvasxai/sketch.git
cd sketch
pnpm install
cp .env.example .env
pnpm dev
```

Open `http://localhost:3000` — the onboarding wizard will walk you through initial setup.

## Project Structure

```
sketch/
  .env.example          → documented env vars
  packages/
    server/src/         → API server, Slack/WhatsApp adapters, agent runner
    web/src/            → admin UI (React)
    shared/src/         → shared types
```

## Code Style

- **Biome** for linting and formatting (2-space indent, 120 line width)
- **Strict TypeScript** (`strict: true`)
- Prefer docstrings explaining decisions over inline comments

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — maintenance, dependencies, tooling
- `refactor:` — code restructuring without behavior change
- `docs:` — documentation only
- `test:` — adding or updating tests

## Testing

We use [Vitest](https://vitest.dev/). Run the full suite with:

```bash
pnpm test
```

## Quality Checks

Before submitting a PR, make sure everything passes:

```bash
pnpm lint          # Biome check
pnpm typecheck     # TypeScript strict mode
pnpm test          # Vitest
pnpm build         # Production build
```

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run all quality checks (see above)
4. Open a PR against `main`
5. Describe what changed, why, and how to test it

## Community

Join our [Discord](https://getsketch.ai/discord) — ask questions, share ideas, or just say hi.

## Reporting Issues

Use [GitHub Issues](https://github.com/canvasxai/sketch/issues) for bug reports and feature requests.

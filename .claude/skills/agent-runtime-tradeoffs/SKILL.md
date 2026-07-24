---
name: agent-runtime-tradeoffs
description: Why the agent runtime is built the way it is — the Claude Agent SDK to Vercel AI SDK migration reasoning, and the deliberate constraints (canUseTool, queues, prompt-only formatting) that must not be "optimized away". Use before changing the agent loop, tool permissions, session handling, provider routing, or workspace containment.
---

# Agent Runtime Tradeoffs

Several things in the agent runtime look inefficient or overly strict until you know why they are there. This skill records the reasoning so future changes argue against the actual rationale, not against a guess.

## Why we moved off the Claude Agent SDK (v1)

The v0 runtime ran on `@anthropic-ai/claude-agent-sdk`. It was the fastest way to ship, and it was the right v0 choice. It could not be the long-term runtime for a multi-user server, because the SDK spawns a full Claude Code **subprocess per query**: roughly 1GB of memory each, ~12s spawn overhead, plus zombie-process risk on crashes. Our mitigations (per-channel queue, a global run limiter of 4) were a ceiling, not a fix; an org's worth of concurrent users cannot share 4 slots on a box sized for subprocesses.

The v1 runtime is an in-process tool loop on the Vercel AI SDK. Measured difference: 100 concurrent runs in ~277MB total, ~0.3MB marginal per run, versus ~1GB per run before. That is the whole argument in two numbers.

Alternatives considered, and why they lost:

- **Anthropic Managed Agents** (hosted): rejected because it breaks our cost model (per-session-hour pricing, no OpenRouter routing), our in-process MCP tools, `canUseTool` enforcement, and self-hosted deployments.
- **Pi**: passed the same POCs. Tiebreakers for AI SDK: first-party provider ecosystem, MCP client, and cache-control support; Pi's built-ins needed replacing anyway (no workspace containment, sessions/compaction superseded by our DB); and Pi showed churn risk as a small dependency.

## Migration principles (reusable for any runtime-scale rewrite)

- **1:1 parity is the spec.** Reimplemented tools match the old ones' names, schemas, and behavior exactly, and parity is a verification dimension, not an aspiration. Characterization tests and golden fixtures of the old behavior come FIRST, then the rewrite is judged against them.
- **Ship both runtimes behind a flag.** Rollback must be a flag flip, not a redeploy of old code, because by cutover time the old image may be unsafe to roll back to (schema has moved). Remove the old path only after the new one has baked in production.
- **A/B the seams, not the internals.** The final gate was running identical scenarios through both runtimes via the real entry point and diffing outcomes (final text, stop reason, tool calls, side effects). Accounting semantics may legitimately differ; behavior may not.
- **Accepted costs are written down.** Sessions reset at cutover (no transcript importer) was an explicit decision, not an oversight; recall survives through chat-history tools. When you accept a cost, record it so it reads as a decision later.

## Deliberate constraints. Do not "fix" these.

1. **`canUseTool` is the only permission mechanism, and `allowedTools` must stay empty.** `allowedTools` BYPASSES `canUseTool` in the SDK-style flow. Adding a tool to an allowlist "for performance" silently removes workspace isolation for that tool. `permissionMode: "default"` exists to force every call through the validator.

2. **Workspace containment is a security boundary, and lexical path checks are not containment.** We were burned twice: naive string-prefix checks, then a subtler one, `fs.realpathSync("link/..")` collapses `..` lexically BEFORE resolving the symlink, so realpathing a string containing `..` re-opens the escape. The guard canonicalizes segment by segment, applying `..` only to the already-resolved real path. If you touch path validation: keep the exploit regression tests green, add new exploits as tests, and assume any "simpler" version has an escape until proven otherwise.

3. **Per-channel queues are sequential on purpose.** One agent run per channel at a time preserves conversation ordering and prevents two runs from interleaving writes to the same session. Concurrency belongs across channels and in the interactive/scheduled lane split, not within a conversation.

4. **Platform formatting is prompt-only.** No post-processing of model output per channel. The alternative (regex rewriting of markdown per platform) decays into an unmaintainable pile of special cases. If formatting is wrong, fix the system prompt.

5. **The system prompt is fully custom and its stable prefix is a caching asset.** See `prompt-caching-discipline` before reordering or injecting anything into it.

## Provider behavior: verify empirically, always

Provider and SDK behavior around usage, caching, and message shapes is inconsistent and under-documented. Two proven examples: ai-sdk's `inputTokens` is cache-INCLUSIVE (assuming otherwise inflated our reported costs ~9x, caught only by a live probe against real usage numbers), and Bedrock cache breakpoints must ride the system-message provider options. The rule: when wiring a new provider, SDK version, or usage field, send a live probe with known expected numbers and check the arithmetic. Type definitions and field names are not evidence.

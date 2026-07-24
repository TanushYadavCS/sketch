---
name: prompt-caching-discipline
description: Principles for keeping LLM prompt caching effective in Sketch. Use when changing the system prompt, tool schemas, provider routing, message history handling, or when investigating unexpectedly high input-token costs or cacheRead=0.
---

# Prompt Caching Discipline

Prompt caching is not an optimization we bolt on later. It is a design constraint on every prompt-touching change. Cached input tokens cost roughly 100x less than fresh ones (on OpenRouter mimo: $0.0036/M cached vs $0.435/M fresh). At our prefix size (system prompt + tool schemas, ~136KB), a broken cache multiplies a tenant's input bill by an order of magnitude. We have lived this: one invisible varying block took a tenant from a potential ~$2/period input cost to ~$15.

## The one mental model

Providers cache on the **literal byte prefix** of the request. The cache key is "everything from byte 0 up to the cache breakpoint". If ANY byte before the static block changes between requests, the entire prefix is cold every time.

So the question to ask on every change is not "did I change the system prompt?" It is: **"did I change any byte that appears before or inside the stable prefix, on any request?"**

## Rules

1. **The prefix must be byte-identical across turns and across sessions.** No timestamps, no request IDs, no per-request metadata, no conditional sections that flip between requests, no reordering of tools. If two consecutive requests differ anywhere before the end of the tool schemas, caching is dead.

2. **Dynamic content goes at the end, never the front.** Current time, user context, buffered thread messages, retrieved facts: all of it belongs in the message list (ideally the latest user turn), after the stable system + tools prefix. Putting one dynamic line at the top of the system prompt poisons everything after it.

3. **Message history must be append-only within a session.** Resuming a session with the identical prior history is what makes turn N cheap. Never rewrite, reorder, or re-serialize earlier messages differently on later turns. Compaction is the sanctioned exception: it resets the cache once, deliberately, and that is fine. Silent per-turn history rewriting is not.

4. **Do not trust that what you send is what the provider receives.** Middleware injects things. The Claude Code SDK used to inject an attribution block as the FIRST system content, with two per-request varying hashes in it. Anthropic's own API stripped it server-side, so first-party caching looked fine; through OpenRouter it silently forced 0% cache for months. If you route through any gateway, capture the actual outbound request body (logging proxy) and diff two consecutive requests byte-wise. Anything that differs before the static block is your poison.

5. **Caches are provider-local; sticky routing matters.** A gateway that load-balances one model across multiple upstream providers scatters your requests across cold caches. When routing through OpenRouter, prefer or pin a single provider for cache-sensitive traffic. Stickiness that "happens naturally" under a burst is luck, not a guarantee.

6. **Never assert caching works; measure it.** The proof protocol we use:
   - Run 1 (cold): expect cacheRead = 0.
   - Run 2 (identical input): expect cacheRead ≈ full prefix size.
   - Runs 3 and 4 (different user messages): cacheRead must STAY at prefix size. This is the step people skip, and it is the one that catches prefix poisoning, because varying the message is what exercises the "is my prefix actually stable" question.
   Read cacheRead from real usage output on live requests. A change that "should be cache-neutral" gets this protocol before merge.

7. **Verify usage accounting empirically, not from types.** Whether `inputTokens` includes or excludes cached tokens differs by SDK and provider, and getting it wrong once inflated our reported costs ~9x (ai@7 reports cache-INCLUSIVE input; we had to subtract cacheRead + cacheWrite). When wiring cost tracking for a new provider or SDK version, send a live probe with a known-cached prefix and check that the numbers add up. Do not trust the field name or the type definition.

## Failure smells

- Input cost per turn is roughly constant as a session grows. Healthy agentic sessions get CHEAPER per token as the prefix caches; flat cost means cold cache every turn.
- cacheRead is high on identical replays but 0 on real traffic. Classic prefix poisoning: something per-request varies (see rule 4).
- Caching works on one provider path but not another. Suspect gateway injection or provider non-stickiness before suspecting your own prompt.

## History (why these rules exist)

- **OpenRouter 0% cache incident**: two stacked causes, the SDK attribution block (rule 4) and provider non-stickiness (rule 5). An early "field order" hypothesis was wrong; it survived until the different-message replay test killed it. The fix was config-only. Lesson: resist shipping a proxy or a rewrite before you have byte-level evidence.
- **The 9x cost inflation bug**: found by a review pass, confirmed only by a live probe (rule 7). The claim "inputTokens is cache-inclusive" was verified against real Bedrock usage numbers before the fix merged, because the fix would have been wrong in the opposite direction if the claim was false.

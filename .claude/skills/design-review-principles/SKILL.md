---
name: design-review-principles
description: How to pressure-test a design before writing code — the adversarial self-review method and the recurring pitfall checklist (cursors, ordering, identity, concurrency, dual-dialect, rollback). Use when writing or reviewing a plan, designing a schema or protocol, or before starting any multi-phase feature.
---

# Design Review Principles

Most of our production bugs were design bugs that survived review because nobody attacked the design. Reviews that ask "does this look reasonable?" pass everything. Reviews that ask "how does this break?" catch the real ones. Get the design right the first time; it is much cheaper than the incident.

## The method

1. **Attack your own design before anyone else sees it.** For each component, actively try to construct the failure: what arrives twice, what arrives out of order, what crashes halfway, what runs concurrently with itself. Write the plan as if a hostile reviewer will get to it next, because one should.

2. **Discuss all phases upfront.** Do not defer known concerns to "a later phase" to keep phase 1 simple. Deferred concerns have a way of invalidating phase 1's schema or contracts. Decide the whole shape holistically, THEN slice into phases; each phase is an increment of a settled design, not a fresh negotiation.

3. **Contracts first.** Nail down types, table schemas, and protocol semantics before implementation. When a plan has multiple phases or multiple implementers, the contracts are what keep them convergent.

4. **Send plans out for independent review, and re-review the whole at the end.** Per-stage reviews pass while cross-stage bugs survive: our gateway work had every stage individually approved, and a whole-branch review then found three real blockers living in the seams between stages (lifecycle, restart, and supervision interactions). Always do a final whole-branch pass, in addition to per-stage checks.

5. **Write down accepted residuals.** Every design accepts some risks. Unwritten, they resurface as "bugs" and get "fixed" in ways that break the actual intent. Written, they are decisions.

## The recurring pitfall checklist

These are the failure classes that keep appearing in our reviews and incidents. Walk every design past each one.

- **Cursors and watermarks.** Anything that resumes (sync, backfill, reconnect) needs a durable watermark with defined semantics: what advances it, what resets it, and what happens when the source replays. "We start from where we left off" is not a design until those three are answered.
- **Ordering.** What guarantees order, and who silently depends on it? Pagination order, queue order, event order across a reconnect. Downstream dedup and supersession logic often depends on chronological arrival without saying so.
- **Identity and dedup.** What is the durable key for "we have seen this before"? It must survive restarts and replays, so it lives in the database. Derived keys (hashes of stable fields) beat provider-supplied ids that can be reused or missing.
- **Concurrency.** What happens when two of these run at once, on one box or two? Leases need generation fencing and an authoritative clock. Delivery needs an at-most-once claim step. "It won't happen" needs a guard that makes it true (single-flight, unique constraint, running-op guard).
- **Crash windows.** Between every two side effects, ask: what state are we in if we die here? Consume-before-enqueue vs enqueue-before-consume type decisions decide whether a crash loses a message or duplicates it; pick deliberately and per case.
- **Fail-open or fail-closed.** For each failure, decide which is safer and make it explicit. Compaction failing should not kill a run (fail-open); a permission check failing must (fail-closed).
- **Dual-dialect.** Everything DB-level must work on SQLite AND Postgres. Constraints, upsert semantics, partial indexes, and migration mechanics differ. If dialect-specific behavior is unavoidable, handle both and test the difference.
- **Backward compatibility and rollback.** The default questions: what happens to existing rows, old sessions, in-flight work? And is rolling back the previous image SAFE after this migration runs? If old code cannot run against the new schema, the rollback path must be a flag, and that must be decided before merge, not during the incident.
- **Bounded resources.** Every queue, cache, buffer, and fan-out gets a cap and a defined shed behavior. Unbounded plus "should be fine" is how OOMs are written. See `kg-sync-judgment` for the memory-specific versions.

## Schema and migration discipline

- Prefer additive migrations. Destructive down-migrations (dropping rows a feature created) need an explicit decision that data loss on rollback is acceptable.
- Never assume your migration numbers are still free; check what main has merged since you branched, and renumber rather than guess about semantics.
- Timestamps in migrations use `CURRENT_TIMESTAMP` (portable). State transitions prefer nullable timestamps over booleans (`archived_at`, not `is_archived`): they carry when for free and support partial unique indexes.
- Vocabulary matters in schemas: "archive" and "delete" are different promises. Pick the word that matches the retention behavior and use it consistently through code.

---
name: kg-sync-judgment
description: Principles for working on knowledge-graph sync, indexing, enrichment, and materialization without reintroducing OOM and backlog-churn failures. Use before changing any sync pipeline, sweep, chunker, salience gate, or materializer, and when diagnosing memory growth or a backlog that never drains.
---

# Knowledge-Graph Sync Judgment

The KG pipeline has taken this process down before. Every OOM and death-spiral we have had traces back to one of a small number of design mistakes, and all of them looked reasonable in review. These are the questions to ask before touching sync code. The specific fixes are in git history; the point here is the reasoning that prevents the next instance.

## The central question

**Does each cycle's cost scale with NEW work, or with TOTAL history?**

This is the first thing to check on any sweep, sync, or materialization change. A tenant's history only grows. A cycle that re-reads the whole backlog is fine at 1k facts and fatal at 77k. Our worst incident was exactly this: every sweep re-read the entire open-verdict fact backlog, ~1.5GB of heap churn per cycle, until the process died. The fixed pipeline does the same job at ~73MB per cycle because each cycle touches only what changed.

If you cannot answer "O(new)" for a cycle, either fix the design or write down explicitly why the full scan is bounded and acceptable.

## Rules

1. **Bound every read.** Never load a whole table, corpus, or adjacency set into memory. Page with a keyset, cap fan-out degree, cap payload sizes. And scan candidates payload-free: select ids and small columns to decide what to process, fetch heavy payloads only per processing batch.

2. **Keyset pagination must use a stable, meaningful order.** Page on `(created_at, id)`, not on random UUIDs. This is not just about index efficiency: downstream logic (dedup, supersession) can silently depend on seeing rows in chronological order, and random-order paging breaks it in ways tests on small data won't catch.

3. **Finished work must stay finished.** The nastiest churn bug we had: an unchanged re-sync nulled `materialized_at` on rows whose content had not changed, reopening completed work every cycle. The pipeline was "correct" (it converged) but did the same work forever. Rule: state transitions to "done" may only be reversed by a real content change, which means comparing an input hash, not "the row was touched". After a churn fix, watch the processed-count across cycles: a healthy pipeline converges toward zero (ours went 1275 → 15 → 2). A flat count means something is being reopened.

4. **LLM verdicts are judged once and persisted.** A salience gate or extraction pass runs once per finalized slice, and the verdict is stored. Re-judging on every pass breaks idempotency (the model won't answer identically twice) and turns a bounded cost into a per-cycle cost. If you find yourself calling a model inside a sweep on rows it has already seen, stop.

5. **Ingestion must be idempotent by key, not by memory.** Dedup keys and watermarks live in the database (event keys, conversation cursors, checkpointed backfills), never in process state. Assume the process restarts mid-batch and the same messages arrive again.

6. **Bulk work must not starve interactive traffic.** Sync, backfills, and scheduled fan-outs share the agent-run concurrency budget with real users. A 32-minute user-facing reply delay was caused by a morning scheduled fan-out filling a strict FIFO limiter, not by any bug in the run itself. The queues are split now (interactive vs scheduled); keep it that way. Any new bulk producer must answer: which lane does this run in, and what happens to a user message that arrives mid-burst?

7. **Node's heap limit does not know about your container.** Default max-old-space is unrelated to the cgroup memory limit, so a process can OOM at ~2GB inside a 4GB container. The entrypoint derives the heap cap from the container limit; if you change memory sizing anywhere, verify the derived cap, not just the container size.

## Reading heap evidence

- The real signal is the **post-GC floor** between cycles, not the per-cycle delta. Under a large heap cap, V8 happily defers collection, so a cycle can report +1.5GB delta that is fully reclaimable churn. A stable floor (~100MB) with big deltas is healthy; a climbing floor is a leak.
- Judge fixes with before/after numbers on production-scale data. Small fixtures hide every problem in this file. A backfill or sweep change is not "verified" until it has run against a realistic corpus with heap instrumentation on.

## Identity principles (graph correctness, not memory)

- **A name alone never mints a person entity.** Names are unverified labels. Create candidates and promote on corroboration (contact point, CRM match). Getting this wrong pollutes the graph in a way that is very hard to clean later.
- **Rosters and identity are numbers/ids first**; display names are decoration attached to an already-resolved identity.

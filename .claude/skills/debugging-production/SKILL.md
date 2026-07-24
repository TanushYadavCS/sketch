---
name: debugging-production
description: The diagnostic method for production incidents — evidence before hypotheses, discriminating tests, safe load reproduction, and honest fix verification. Use when investigating an incident, a latency spike, memory growth, a stuck queue, or any "it worked yesterday" report.
---

# Debugging Production

The expensive failure mode in debugging is not slowness, it is confidently fixing the wrong thing. Every rule here exists because pattern-matching a symptom to a known failure once sent us down the wrong path.

## Method

1. **Evidence before hypotheses.** Read the logs, the journal, and the actual database rows on the affected box BEFORE proposing causes. Our best RCA started with pulling one run's record and finding `waitMs: 1,863,870` on it; that single number identified queue starvation and ruled out everything else in one step. The habit: find the artifact that records what actually happened to the specific affected request, and read it.

2. **A symptom that matches a known failure may have a different cause.** A 32-minute reply delay arrived days after we fixed an OOM class, and looked exactly like a recurrence. It was not: process restarts were zero, heap was flat, and the real cause was scheduled fan-out saturating a FIFO limiter. Before re-applying a known fix, verify the specific mechanism of the old failure is present (the counters, the restarts, the heap floor), not just the user-visible symptom.

3. **Kill hypotheses with discriminating tests.** A discriminating test is one whose outcome differs depending on which hypothesis is true. We once shipped a wrong root-cause ("field ordering breaks caching") that survived several experiments because none of them could distinguish it from the real cause; the varying-message replay test killed it in one run. If an experiment would look the same under both hypotheses, it is not evidence, it is activity.

4. **Distrust what you send; verify what arrives.** Middleware injects, providers rewrite, circuit breakers roll back silently while dashboards stay green. When behavior at a boundary makes no sense, capture the actual traffic (logging proxy) or the actual running artifact (image digest, reported version) instead of reasoning from the code you wrote.

5. **Absence of error logs is not health.** We have had real failures that log nothing at error level. If a component matters, verify it positively: health endpoint, expected row appearing, expected counter moving.

## Load reproduction, safely

Reproducing a production load problem is often the fastest diagnosis, and also how you cause the next incident. Hard-learned rules:

- **Check provider credit/quota balance BEFORE any load test on real keys.** A diagnostic load test once drained the remaining LLM credit balance and took production down with a 402. Estimate the spend, confirm headroom, prefer scratch keys.
- **Harnesses hit limits production does not.** A load harness at Node's default ~2GB heap OOMs where production with a proper cap is fine. Size the harness like production or you will debug the harness.
- **Run against snapshots, not live state.** Copy the DB; never point an experiment at live data. And remember copied snapshots can be schema-stale relative to current migrations.

## Fixing

- **Fix pre-existing issues you trip over.** "That failure was already there" is an investigation trigger, not a dismissal. Either fix it or file it with what you learned; do not step around it.
- **Verify the fix with before/after numbers in production.** A fix is verified when the specific metric that defined the incident has moved: heap per cycle, wait time, converging churn counts. "Deployed and no complaints" is not verification.
- **Soak lifecycle fixes.** Bugs in reconnects, leases, respawns, and schedulers live in transitions, so a green hour proves little. Give such fixes a defined soak window with periodic checks (process identity stable, no lease churn, queues draining) and let it pass through the load pattern that caused the incident.
- **After every deploy, read the logs.** Clean boot, migrations applied, version reported by the health endpoint matches what you shipped. Every time, including the boring deploys. Silent rollbacks and half-applied deploys are only visible if you look.

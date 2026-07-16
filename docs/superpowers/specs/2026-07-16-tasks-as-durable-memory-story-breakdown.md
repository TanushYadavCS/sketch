# Tasks as Durable Memory — Implementation Story Breakdown

**Date:** 2026-07-16  
**Status:** Proposed developer backlog  
**Audience:** Sketch product and engineering  
**Source material:** `TASKS_AS_DURABLE_MEMORY.md` and `SKETCH_MARKET_RESEARCH_BRIEF.md`

## Summary

Sketch should treat its task list as the durable model of ongoing work rather than generating a fresh task list on every agent run.

Each run should load the relevant open tasks, compare fresh signals against them, and produce an incremental diff. Sketch should collate new evidence into existing tasks, create only genuinely new work, identify likely completion or staleness, and preserve human corrections.

The first release should prove one focused promise:

> A task list users can trust to stay useful, deduplicated, current, and explainable without maintaining it themselves.

This is not a general project-management expansion. The implementation should focus on task integrity, user trust, and a credible first-day experience.

## Existing Foundation

Sketch already has several parts of the proposed loop:

- Daily Brief and Summarizer can promote structured output into durable tasks.
- Sketch-native and externally managed tasks have separate status authority.
- Daily Brief can load existing durable tasks and recent Summarizer output.
- Existing prompts instruct Daily Brief to avoid duplicating known tasks.
- Sketch-native task statuses can be updated locally.
- Project drawers can display project-anchored tasks.
- Task evidence can reference files, entities, facts, and conversation messages.

The principal gaps are:

- No task-change audit trail or reliable human-touch marker.
- No global task surface for unanchored tasks.
- Parent and source anchoring are incomplete.
- Agent runs do not produce an explicit task diff.
- Completion and staleness are not managed as reviewable proposals.
- There is no dedicated cold-start seeding workflow.
- There is no fallback text search across open and closed tasks.

## Product Defaults for the Initial Release

These defaults should be treated as initial implementation decisions and made configurable where noted:

- Target user: an individual operator managing several concurrent projects.
- Product role: Sketch sits above existing task systems rather than replacing them.
- External status: mirrored into Sketch and never written back in this release.
- Seed lookback: 30 days, configurable per source.
- Stale threshold: 14 days, configurable.
- Runtime task-context cap: 50 tasks.
- Review experience: completion and staleness proposals live in Task Home; Daily Brief shows a compact review summary.
- Task search: deferred until pilot data shows that anchored context is insufficient.

## Delivery Approach

The recommended delivery approach is an MVP-first vertical slice:

1. Establish task trust and global reachability.
2. Implement the incremental maintenance loop.
3. Add cold-start seeding and review.
4. Measure integrity in a pilot.
5. Add older-task search only if metrics justify it.

This sequence prevents the agent-maintenance loop from producing tasks that users cannot find, correct, or understand.

## Foundation: Trust and Reachability

### Story 1: Record task change history

**User story**

As a user, I want consequential task changes to be attributed so I can understand and trust Sketch's actions.

**Scope**

- Add an append-only task-event model.
- Record status changes made by users, agents, external synchronisation, and system jobs.
- Use task events to determine whether a task has been modified by a human.

**Acceptance criteria**

- Every status transition records the previous status, new status, actor type, actor identifier, surface, and timestamp.
- Actor types distinguish users, scheduled agents, external synchronisation, and system jobs.
- User-originated changes identify the authenticated user.
- Agent-originated changes identify the agent definition and run or output where available.
- Existing tasks remain valid after migration.
- Existing status behaviour remains unchanged until later stories consume the audit data.
- Tests cover user, agent, external, and idempotent same-status writes.

**Dependencies:** None.

### Story 2: Protect human task updates

**User story**

As a user, I want my corrections to remain authoritative when Sketch processes new information.

**Scope**

- Introduce a task-change proposal model for changes requiring confirmation.
- Define direct-write and proposal-only rules.
- Use task history to identify tasks that humans have touched.

**Acceptance criteria**

- Agents may directly update agent-created, locally authoritative tasks that have never been modified by a human.
- Agents cannot silently change the status of a human-modified task.
- A blocked agent write creates a proposal containing the suggested value, evidence, rationale, and originating run.
- External-authority task statuses remain read-only to local users and agents.
- Accepting or rejecting a proposal creates an audit event.
- Rejected proposals do not reappear unless new evidence materially changes the recommendation.
- Reprocessing the same agent verdict does not create duplicate proposals.

**Dependencies:** Story 1.

### Story 3: Make all tasks reachable

**User story**

As a user, I want to find and update tasks even when Sketch cannot resolve their project or assignee.

**Scope**

- Add a global task-listing API independent of parent entity routes.
- Add a task update route addressed directly by task ID.
- Support unanchored and review-focused queries.

**Acceptance criteria**

- The API can list visible tasks filtered by status, assignee, parent, source, provenance, review state, and whether they are unanchored.
- The API supports cursor-based or otherwise stable pagination.
- Authorized users can update a local task by task ID without supplying a parent entity.
- Visibility and edit authorization match existing task authority rules.
- Null-parent tasks appear in the unanchored filter.
- Tasks assigned to external parties are excluded from the current user's personal todo view.
- Externally owned tasks remain available in project and source context.
- Existing entity-scoped task routes continue to work.

**Dependencies:** Story 1.

### Story 4: Create Task Home

**User story**

As a user, I want one place to review and maintain the work Sketch remembers.

**Scope**

- Add a first-class Task Home navigation surface.
- Provide views for personal work, proposals, and unanchored tasks.
- Reuse existing task status and permission language where appropriate.

**Acceptance criteria**

- Task Home includes at least `My work`, `Needs review`, and `Unanchored` views.
- Users can update the status of editable local tasks.
- Authorized users can correct a task's title, parent, assignee, and status.
- External tasks identify their managing provider and explain why they are read-only.
- External-party tasks do not appear as personal assignments.
- Loading, empty, error, and pagination states are implemented.
- The layout works at supported desktop and narrow viewport sizes.

**Dependencies:** Stories 2 and 3.

## Core Incremental Task Loop

### Story 5: Capture reliable task source evidence

**User story**

As Sketch, I need reliable source evidence so I can identify which conversations and meetings created or changed a task.

**Scope**

- Ensure task promotion writes evidence for supported conversation and meeting sources.
- Resolve evidence back to a stable source anchor.
- Preserve authorization boundaries when loading evidence.

**Acceptance criteria**

- Summarizer-derived tasks retain Slack and WhatsApp conversation-message evidence when message identifiers are available.
- Meeting-derived tasks retain file and meeting-series evidence.
- Conversation-message evidence can resolve to the containing conversation, channel, or group.
- Evidence references are deduplicated.
- Deleted or inaccessible evidence does not expose unauthorized metadata.
- Tests cover Slack, WhatsApp, meetings, missing evidence, and inaccessible evidence.

**Dependencies:** None. This can run in parallel with Stories 1–4.

### Story 6: Resolve relevant task context

**User story**

As Sketch, I want relevant open tasks loaded before processing new signals so I can update existing work instead of recreating it.

**Scope**

- Build one reusable anchored-task resolver.
- Use the resolver for both runtime context and write-side collation.
- Return metadata describing context coverage.

**Acceptance criteria**

- The anchored task set is the union of:
  - Tasks whose parent is the scoped project or customer.
  - Tasks connected through one accepted graph hop, initially `contributes_to`.
  - Open tasks assigned to the user for whom the run is executing.
  - Tasks whose evidence belongs to one of the run's configured sources.
- The result includes open and in-progress tasks but excludes done, dropped, expired, and unreviewed seed candidates.
- Duplicate tasks found through multiple anchors appear only once.
- External-party tasks remain available in project context.
- The default cap is 50 tasks and is configurable.
- Results are ranked by priority, due date, latest dated evidence, status-change recency, and deterministic tie-breakers.
- The result reports whether it was capped and which anchor categories contributed tasks.
- The same resolver supplies the candidate pool for collate-before-create.

**Dependencies:** Story 5.

### Story 7: Produce an incremental task diff

**User story**

As Sketch, I want each agent run to describe how fresh signals affect existing work.

**Scope**

- Define a structured task-diff contract for Daily Brief and Summarizer.
- Supply anchored tasks and coverage metadata to the model.
- Keep narrative output independent of task persistence.

**Acceptance criteria**

- Each eligible candidate receives one verdict: `new`, `changed`, `resolved`, `stale`, or `unchanged`.
- Verdicts other than `new` include the matched task ID.
- Consequential verdicts include supporting evidence references, confidence, and a concise rationale.
- `changed` identifies the specific fields or evidence that changed.
- The prompt identifies when the anchored context is partial.
- The agent does not assume a task is new merely because it is absent from partial context.
- Narrative Daily Brief sections continue to be saved without requiring task-diff writes.
- Contract validation rejects malformed or unauthorized task references.

**Dependencies:** Story 6.

### Story 8: Apply task changes safely

**User story**

As a user, I want new information merged into existing work instead of creating duplicate tasks.

**Scope**

- Add a central task-diff application service.
- Apply new and changed verdicts idempotently.
- Route consequential status changes through the human-authority policy.

**Acceptance criteria**

- `new` creates a task only after the anchored candidate pool fails to produce a valid match.
- `changed` attaches new evidence and updates only fields the agent is authorized to maintain.
- `resolved` either updates an untouched agent task or creates a proposal for a human-modified task.
- Reprocessing the same diff creates no duplicate tasks, evidence, events, or proposals.
- Human-set status and assignee values remain sticky.
- External-authority status is never overwritten.
- Existing structural tasks can receive additional evidence without changing external status.
- Failures applying one task diff do not prevent unrelated valid diffs from being processed.

**Dependencies:** Stories 2 and 7.

### Story 9: Detect stale and quietly resolved work

**User story**

As a user, I want Sketch to identify zombie and quietly completed tasks without silently removing work.

**Scope**

- Add stale-task eligibility rules.
- Support completion and staleness proposals.
- Surface review counts in Daily Brief.

**Acceptance criteria**

- Staleness is calculated from `status_changed_at` and the latest dated evidence, not generic `updated_at`.
- The initial stale threshold is 14 days and can be configured.
- Idempotent task re-emission does not reset the stale clock.
- Fresh signals indicating completion can produce a resolved verdict.
- Human-modified tasks receive proposals rather than silent status changes.
- Daily Brief can show a compact count of tasks requiring review with a link to Task Home.
- Rejected proposals are suppressed until new relevant evidence arrives.

**Dependencies:** Stories 4 and 8.

### Story 10: Explain task maintenance

**User story**

As a user, I want to know why Sketch created, merged, or changed a task.

**Scope**

- Add evidence and history views to task details.
- Explain agent proposals and collation.
- Provide graceful handling for unavailable evidence.

**Acceptance criteria**

- Task details show supporting messages, meetings, documents, and human actions when available.
- Task history identifies the actor, surface, timestamp, and changed values.
- A task shows when fresh evidence was merged instead of creating a duplicate.
- Proposals include a concise explanation and links to supporting evidence.
- Users can distinguish observed facts from agent inferences.
- Missing, deleted, or inaccessible evidence is represented without breaking the task view.

**Dependencies:** Stories 1, 4, 5, and 8.

## Cold-Start Seeding

### Story 11: Seed tasks from source history

**User story**

As a new user, I want Sketch to construct an initial work memory from recent source history.

**Scope**

- Add a dedicated source-seeding job independent of regular Summarizer scheduling.
- Process large source windows incrementally.
- Store generated tasks as reviewable candidates.

**Acceptance criteria**

- Seeding can be started for an individual configured source.
- The default lookback is 30 days with a per-source override.
- The lookback is not limited by the normal route schedule.
- Busy sources are paginated and chunked beyond the existing per-run message limit.
- Seed jobs are resumable, retryable, observable, and idempotent.
- Seed candidates retain source evidence and a backfill marker.
- Seed review state is separate from operational task status.
- Unaccepted seed candidates are excluded from live agent context.
- Adding a source later can run the same scoped cold-start flow.

**Dependencies:** Stories 5, 7, and 8.

### Story 12: Review and activate seeded tasks

**User story**

As a new user, I want to correct Sketch's initial suggestions quickly before they become my live work memory.

**Scope**

- Add a dedicated seed-review experience to Task Home.
- Support efficient individual and bulk decisions.
- Activate accepted tasks for future agent runs.

**Acceptance criteria**

- Seed candidates appear in a dedicated review queue.
- Users can accept, dismiss, edit, assign, and anchor individual candidates.
- Users can bulk accept or dismiss selected candidates.
- Accepted candidates become live tasks and enter anchored runtime context.
- Dismissed candidates remain excluded from runtime context and are not repeatedly recreated from the same seed evidence.
- Review actions are recorded in task history.
- The completed flow reports accepted, edited, and dismissed totals.

**Dependencies:** Stories 4 and 11.

## Measurement and Conditional Expansion

### Story 13: Measure task integrity

**User story**

As the product team, we want to know whether the durable-task model remains trustworthy during real use.

**Scope**

- Define task-integrity events and metrics.
- Capture baseline values before enabling the incremental loop.
- Provide pilot reporting segmented by source and agent.

**Acceptance criteria**

- The system measures:
  - Recommended-task acceptance or action rate.
  - Duplicate-task creation rate.
  - Agent-update acceptance and correction rates.
  - Time from real-world signal to corresponding task update.
  - Proposed-completion confirmation rate.
  - Zombie and stale-open-task rates.
  - Manual task creation and maintenance activity.
  - Runs where anchored task context was capped.
- Metrics distinguish seeded tasks, ongoing task creation, and task updates.
- Pilot reporting can be segmented by source type and agent.
- Product and engineering agree on launch and fallback-search decision thresholds before the pilot ends.

**Dependencies:** Instrumentation should be added alongside Stories 8–12 and completed before pilot rollout.

### Story 14: Search older tasks when needed

**User story**

As Sketch, I want to search older and closed tasks when anchored context cannot resolve a possible duplicate.

**Scope**

- Add a bounded `SearchTasks` agent tool.
- Search open and closed tasks with authorization.
- Keep the first implementation deliberately simple.

**Acceptance criteria**

- Search accepts text, status, anchor, and result-limit filters.
- Closed tasks remain searchable.
- Results respect normal task visibility.
- The initial implementation uses normalized-title matching or a database `LIKE` scan.
- Full-text search is deferred until retrieval quality requires it.
- Agent instructions limit use to suspected duplicates, partial anchored context, or explicit user requests.
- Search calls and resulting create, collate, or no-op decisions are instrumented.
- The story is scheduled only if pilot metrics show anchored context is insufficient.

**Dependencies:** Stories 6, 8, and 13.

## Recommended Delivery Sequence

| Phase | Stories | Outcome |
|---|---|---|
| Trust and reachability | Stories 1–4 | Users can find, correct, and audit durable tasks. |
| Core maintenance loop | Stories 5–10 | Agents maintain existing tasks instead of regenerating lists. |
| Cold start | Stories 11–12 | New sources produce a reviewed initial work memory. |
| Pilot | Story 13 | The team can measure trust, duplication, latency, and cleanup. |
| Conditional expansion | Story 14 | Older-task search is added only if evidence supports it. |

Stories 1 and 5 can start in parallel. Story 3 can also proceed while the audit work is underway, provided its update endpoint is integrated with Story 1 before release.

## Explicit Non-Goals

- Re-reading 30 days of raw messages on every scheduled run.
- Historical corroboration receipts or writer-side receipt validation.
- Coverage gates or degraded-mode output.
- External status write-back to ClickUp, Linear, or other providers.
- Replacing external task-management systems.
- Broad project planning, resource management, or workflow automation.
- A destructive reclassification or backfill of all existing task rows.
- Full-text task search before simple matching has been measured.

## Open Product Decisions

The following should be confirmed before implementation reaches the affected story:

1. Whether administrators may edit all locally authoritative tasks or only monitor tasks owned by other users.
2. Which task fields an agent may update directly on untouched tasks beyond status and evidence.
3. Whether a task dismissed during seeding may be recreated later when genuinely new evidence appears.
4. Whether stale proposals should include a suggested `dropped` status or only ask whether the task is still relevant.
5. The pilot thresholds that will trigger or reject Story 14.

## Definition of MVP

The MVP includes Stories 1–13.

It is complete when a pilot user can:

1. Connect a real source.
2. Seed and review an initial task list.
3. Find both anchored and unanchored tasks in Task Home.
4. Correct tasks while retaining authority over those corrections.
5. Observe new signals update existing tasks without duplication.
6. Review likely completion and staleness with supporting evidence.
7. Use Daily Brief as a current view of work rather than a newly generated task list.
8. Produce measurable integrity, duplication, and latency results.

Story 14 is deliberately outside the MVP and should be pulled in only when pilot evidence justifies it.

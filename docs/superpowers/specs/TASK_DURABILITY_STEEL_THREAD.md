# Conversation-Derived Durable Follow-Up Steel Thread

**Date:** 2026-07-16
**Status:** Proposed steel-thread story
**Audience:** Sketch product and engineering
**Initial channels:** Slack and WhatsApp
**Reference case:** Ashish J. Banka, Goosebumps

## Story

### Prevent a resolved conversation-derived follow-up from resurfacing

**User story**

As a user receiving Slack or WhatsApp summaries and follow-up reminders, I want Sketch to maintain each follow-up across runs so that it is created once, updated from later messages, and stops appearing as pending after it is resolved.

## Product Scope

This is a general Sketch capability for conversation-derived work. The first supported sources are:

- Slack channels.
- Slack direct messages.
- Slack threads.
- WhatsApp groups.
- WhatsApp direct messages.

Ashish's Goosebumps WhatsApp experience is:

- The motivating customer example.
- The first manual pilot.
- A concrete acceptance fixture.

It is not an implementation boundary. Production code must not contain customer-specific identifiers, prompt branches, matching rules, or status behaviour.

## Problem

Summarizers and scheduled reminders currently reconstruct follow-ups from the context available to each run. They do not share a reliable model of previously extracted work.

This can cause:

- Completed work to return as pending.
- Repeated or paraphrased discussion to create redundant tasks.
- Different reminder runs to report inconsistent task states.
- A fresh run to report no tracked work when chat history is unavailable.
- Users to repeatedly correct or ignore unreliable reminders.

The first slice must prove one outcome:

> Once a Slack or WhatsApp follow-up is explicitly resolved, the same work does not return as pending in a later reminder.

## Goosebumps Reference Case

The July 16, 2026 production inspection found:

- 94 completed Summarizer outputs containing 114 visible action items.
- Summarizer task creation was disabled.
- No Summarizer-created durable tasks existed.
- Current tasks had no WhatsApp message evidence or completed-task memory.
- Follow-up automations ran in fresh sessions.
- The Goosebumps 2 PM Consolidated Daily Brief attempted to search chat history but did not receive the conversation context required by those tools.

The service was healthy. The failure was architectural: scheduled runs did not have a shared, durable representation of follow-up state.

Ashish's 2 PM brief is the first production validation consumer. The same implementation must support Slack fixtures and any eligible reminder consumer through shared interfaces.

## End-to-End Slice

1. Summarizer sees a concrete follow-up in a configured Slack or WhatsApp source.
2. Sketch creates one durable task with ownership and source-message evidence.
3. A later Summarizer run loads relevant open tasks before evaluating new messages.
4. Repeated discussion updates the existing task.
5. An explicit completion message creates a resolution recommendation.
6. A reminder reads durable task state instead of reconstructing pending work from chat history.
7. The task appears under `Looks resolved`, not under `Pending follow-ups`.
8. The user confirms completion or keeps the task open.
9. Confirmed work remains absent from future pending reminders.

## Transition from Reconstructed to Durable Follow-Ups

Durable state starts empty for existing users. Switching a reminder directly to durable-only reads would create a day-one blank-reminder cliff.

The steel thread therefore includes a bounded transition:

1. When durable follow-ups are enabled for an existing Summarizer route, run a one-shot mini-seed from its last seven calendar days of completed outputs, capped at ten outputs per route. Both visible `action_items` and internal `task_candidates` are eligible inputs.
2. Seeded candidates remain proposed until reviewed; accepted candidates become live tasks, while dismissed candidates remain excluded. They do not silently become authoritative tasks.
3. While seed review is incomplete, the reminder runs in hybrid mode:
   - Durable tasks and recommendations are loaded first.
   - The previous reconstruction path runs as a fallback.
   - Durable state wins whenever the same work appears in both paths.
   - Unmatched fallback items remain visible but are labelled as untracked follow-ups.
4. After seed review is complete and at least one successful incremental Summarizer run has occurred, the reminder switches to durable-only follow-up reads.

Seed candidates are reviewed from the same Slack or WhatsApp reminder channel using accept and dismiss actions or stable reply commands. Task Home is not required for this transition. A route with no seed candidates counts as reviewed automatically.

The mini-seed is narrower than the full cold-start seeding workstream:

- It reads recent stored Summarizer outputs rather than reprocessing a large raw-message window.
- It applies only when converting an existing configured route.
- It uses the same review and deduplication contracts as ongoing task maintenance.

If the mini-seed or durable query fails, the consumer remains in hybrid mode. It must not interpret a failed durable read as an empty task list.

## Why This Slice

### Alternative: repair history access for each scheduled run

This would remove one failure mode but leave each run responsible for reconstructing task state from conversation history.

### Alternative: search a large historical window every time

This may suppress some stale follow-ups but is expensive and remains retrieval-dependent.

### Recommended: maintain shared durable state

Summarizer incrementally maintains tasks, and reminder consumers read that state. Slack and WhatsApp become evidence adapters around one task lifecycle rather than separate task products.

## Source Anchor

Every conversation-derived task and evidence item uses a normalized source anchor:

- `platform`: `slack` or `whatsapp`.
- `conversationId`: Sketch's persisted conversation identifier.
- `providerThreadId`: optional thread identifier.

For WhatsApp, `providerThreadId` is normally absent.

For Slack:

- A top-level channel or DM message is anchored to the conversation.
- A thread reply is anchored to both the conversation and its provider thread.
- Evidence lookup may widen from a thread to its containing conversation only when the configured Summarizer source permits it.

Provider message IDs remain evidence references but are not shown to users.

## Functional Design

### 1. Persist follow-ups as durable tasks

When task creation is enabled for Summarizer, concrete follow-ups from configured Slack and WhatsApp sources may be promoted into Sketch-native tasks.

Every promoted task includes:

- Owner or assignee when resolved.
- `proposed_assignee_name` when the owner is external or cannot be resolved to an internal entity.
- Parent project or customer when resolved.
- Normalized source anchor.
- Source message ID.
- Normalized title.
- Local status authority.

Candidates without supported source evidence are skipped with an observable reason.

An unresolved or external owner is not a reason to discard a task. Such tasks remain available in source and project context but are excluded from a user's personal pending-follow-up reminder until assigned internally.

The automated personal-reminder fixture uses an internally resolved owner to keep the first end-to-end path narrow. This is a slice constraint, not the general ownership rule.

### 2. Load source-relevant task memory

Before extracting task changes, Summarizer loads open and in-progress tasks relevant to the run:

- Tasks owned by the run's user.
- Tasks linked to a configured source conversation.
- For Slack thread-scoped sources, tasks linked to that thread.
- Tasks linked to the resolved parent, when available.

The model receives:

- Task ID.
- Title.
- Status.
- Parent.
- Assignee.
- Source platform and display label.
- Existing source evidence.
- Latest real status-change timestamp.

The same set is used for collate-before-create matching.

### 3. Produce a minimal task diff

The steel thread supports:

- `new` — no existing task represents the commitment.
- `changed` — an active task matches and has new evidence or safe metadata.
- `resolved` — explicit source evidence indicates that an active task is complete.

`changed` and `resolved` include the matched task ID and new message evidence.

Reactions, acknowledgements, and ambiguous progress updates do not resolve tasks.

### 4. Constrain and validate matching

Paraphrase matching is model-assisted but server-bounded:

- The model may collate only into task IDs included in the loaded memory set.
- The server validates that every returned task ID belongs to that set and is visible to the run's user.
- By default, the candidate and matched task must share the same normalized source anchor.
- The source-anchor restriction may widen when both candidate and task have the same non-null parent and compatible ownership.
- Cross-platform matching between Slack and WhatsApp remains excluded from this slice, even when the parent matches.
- Similar titles alone are insufficient when source, parent, and ownership boundaries disagree.
- An invalid matched task ID rejects that verdict without creating or updating a task.

The matching mechanism for this slice is the model choosing from the bounded candidate set. Embedding search and global task search are not required.

### 5. Apply changes idempotently

- `new` creates one task.
- `changed` updates the matched task and adds evidence.
- `resolved` adds evidence and creates one completion recommendation.
- Reprocessing the same source window creates no duplicate task, evidence, or recommendation.
- One failed candidate does not block unrelated valid candidates.

### 6. Store a completion recommendation

The steel thread stores:

- Task ID.
- Proposed status: `done`.
- Originating Summarizer output.
- Supporting conversation-message evidence.
- Concise rationale.
- Review state: pending, accepted, or rejected.
- Creation and review timestamps.
- Reviewing user.
- Evidence fingerprint.

The evidence fingerprint is a stable hash of the task ID, proposed status, and sorted supporting evidence references. It provides idempotency and ensures a rejected recommendation is not regenerated from the same evidence.

While review is pending:

- The task remains open in durable storage.
- It is excluded from `Pending follow-ups`.
- It appears once per relevant reminder under `Looks resolved`.
- The same recommendation is not duplicated within or across runs.

A pending recommendation expires after 48 hours or three reminder deliveries, whichever happens first. On expiry:

- The recommendation becomes expired.
- The still-open task automatically returns to `Pending follow-ups`.
- No status change is applied.

New completion evidence may create a new recommendation with a different evidence fingerprint.

### 7. Expose a generic task-led reminder query

Reminder consumers use one shared query that returns:

- Open and in-progress tasks as pending follow-ups.
- Pending completion recommendations as looks-resolved items.
- No done or dropped tasks.
- A query-error result distinct from an empty result.

The query may filter by user, source anchor, parent, or a union of those anchors.

It does not require chat-history tools to determine current task status.

During transition mode, the query also accepts legacy fallback candidates and returns:

- Durable items as authoritative.
- Legacy items matching a durable open task as suppressed duplicates.
- Legacy items matching a done task or active completion recommendation as suppressed resolved work.
- Unmatched legacy items as explicitly untracked follow-ups.

Legacy-to-durable reconciliation uses the same bounded candidate set and server validation rules as ongoing Summarizer matching.

### 8. Integrate one reminder consumer

The steel thread integrates the shared query with one reminder consumer end to end.

The first production validation is Goosebumps' 2 PM Consolidated Daily Brief because it exposed the problem. This consumer uses the same contract available to all tenants and both platforms.

Other reminder sections retain their existing data paths.

### 9. Review from the delivery channel

The reminder delivery supports:

- `Confirm done`
- `Keep open`

The action updates the recommendation and task atomically.

For Slack, this may use buttons, thread replies, or stable reply commands.

For WhatsApp, this may use supported interactive actions or stable reply commands.

The review action is independent of where the original evidence was found. For example, a Slack-derived task may be reviewed from a WhatsApp reminder if the user receives reminders there.

## Examples

### WhatsApp: Ashish at Goosebumps

1. A configured Goosebumps WhatsApp source contains a concrete Ashish-owned follow-up.
2. Sketch creates one open task with message evidence.
3. A later paraphrased update collates into the same task.
4. An explicit completion message creates a `done` recommendation.
5. The 2 PM brief shows it only under `Looks resolved`.
6. Ashish confirms it from WhatsApp.
7. It remains absent from later pending reminders.

### Slack fixture

1. A project channel message assigns a concrete follow-up to the user.
2. A thread reply clarifies the same commitment.
3. Sketch attaches both messages to one task.
4. A later thread reply explicitly confirms completion.
5. The task appears only in the review section and remains absent after confirmation.

## Acceptance Criteria

### Shared behaviour

- A concrete follow-up from an eligible Slack or WhatsApp source creates one durable task.
- The task retains the source anchor and message evidence.
- Repeated or paraphrased discussion matches the existing task.
- An explicit completion message creates one recommendation.
- A pending recommendation removes the task from pending reminders.
- A pending recommendation remains visible under `Looks resolved` until reviewed or expired.
- An expired recommendation returns the still-open task to pending reminders.
- A confirmed task does not return in later reminders.
- A rejected recommendation returns the task to pending.
- A task never appears simultaneously as pending and looks resolved.
- Reprocessing the same source window is idempotent.
- A task-query failure is never presented as an empty task list.
- Existing users receive hybrid reminders until mini-seed review and one successful incremental run are complete.
- Durable status wins when durable and fallback paths disagree.

### Slack

- Channel, DM, and thread evidence resolve to the correct persisted conversation.
- Thread-scoped evidence retains its thread identifier.
- Similar work in unrelated threads does not collate solely because its title is similar.
- A Slack completion reply can resolve the existing task.

### WhatsApp

- Group and DM evidence resolve to the correct persisted conversation.
- Similar work in unrelated groups or DMs does not collate solely because its title is similar.
- A WhatsApp completion message can resolve the existing task.

### Human authority

- The task remains open until the user confirms completion.
- Confirm and reject decisions record actor, surface, and timestamp.
- A rejected recommendation is not regenerated from the same evidence fingerprint.

### Permissions

- Users can inspect only evidence they are authorized to access.
- Phone numbers, provider channel IDs, and provider message IDs are not shown.
- Missing or deleted evidence does not break the reminder.

### Goosebumps validation

- One Ashish-owned WhatsApp follow-up creates exactly one task.
- A paraphrased update produces no duplicate.
- Explicit completion moves it from pending to looks resolved.
- Ashish can confirm or reject it.
- After confirmation, it remains absent for five consecutive 2 PM runs.

## Instrumentation

Record:

- Transition mini-seed started and completed.
- Reminder ran in hybrid or durable-only mode.
- Legacy candidate suppressed by durable state.
- Unmatched legacy candidate shown as untracked.
- Task created from a conversation source.
- Signal collated into an existing task.
- Duplicate creation prevented.
- Completion recommendation created.
- Recommendation delivered.
- Recommendation accepted or rejected.
- Durable task query failed.
- Candidate skipped because required source evidence or scope was missing.
- Invalid model-selected task ID rejected.
- Completion recommendation expired.

Segment metrics by:

- Platform.
- Conversation kind.
- Threaded versus unthreaded Slack evidence.
- Summarizer route.
- Reminder consumer.

Initial targets:

- Duplicate tasks for each platform fixture: `0`.
- Confirmed resolved tasks resurfacing: `0`.
- Tasks shown simultaneously as pending and resolved: `0`.

## Test Plan

### Shared automated contract

Run the same lifecycle against WhatsApp and Slack adapters:

1. Concrete user-owned follow-up.
2. Repeated or paraphrased update.
3. Explicit completion message.

Verify one task exists, evidence accumulates, completion is reviewable, and confirmed work remains absent.

### Transition fixture

- Start with no durable tasks and existing legacy follow-ups.
- Run the mini-seed and leave review incomplete.
- Verify the reminder remains populated through hybrid fallback.
- Accept or dismiss the seed candidates.
- Complete one incremental Summarizer run.
- Verify the consumer switches to durable-only reads.
- Verify durable done state suppresses a matching legacy fallback item.

### Slack fixtures

- Top-level channel message followed by a completion thread reply.
- Commitment and update within one thread.
- Similar commitments in two separate threads.
- Direct-message commitment and completion.

### WhatsApp fixtures

- Group commitment, paraphrased update, and completion.
- Direct-message commitment and completion.
- Similar commitments in separate groups.

### Negative cases

- A reaction or acknowledgement does not resolve a task.
- Similar work under a different parent does not collate.
- A model-selected task ID outside the loaded memory set is rejected.
- A same-title candidate in an unrelated source and parent does not collate.
- Another user's task is not shown as personal pending work.
- An ownerless or external-party task is retained with `proposed_assignee_name` but excluded from personal reminders.
- A task-query error does not render as “no tracked tasks.”
- Rejected completion does not recreate without new evidence.
- An ignored completion recommendation reappears under `Looks resolved` until expiry, then returns the task to pending.

### Goosebumps manual pilot

- Select one non-sensitive Ashish-owned WhatsApp follow-up.
- Observe task creation and collation.
- Add an explicit completion signal.
- Verify the 2 PM brief shows it only as looks resolved.
- Confirm it and verify absence for five later runs.

## Rollout

1. Implement shared tenant-agnostic task lifecycle and source-anchor contracts.
2. Implement the bounded mini-seed and hybrid transition contract.
3. Implement Slack and WhatsApp source-evidence adapters.
4. Run shared, transition, and platform-specific fixtures.
5. Integrate one generic reminder consumer.
6. Validate the Goosebumps WhatsApp case.
7. Validate one internal Slack source.
8. Expand to other eligible Summarizer routes and reminder consumers.

## Explicit Non-Goals

- Customer-specific behaviour.
- Microsoft Teams, email, meetings, or other source platforms.
- Changing every reminder consumer in the first release.
- Cross-platform collation between Slack and WhatsApp.
- Task Home.
- Full raw-history cold-start seeding beyond the bounded transition mini-seed.
- Searching a large raw-message window on every run.
- Staleness, cancellation, or supersession verdicts.
- External task-system write-back.
- Retrofitting all existing task rows.

## Definition of Done

The steel thread is complete when:

1. Shared task lifecycle code is independent of Slack and WhatsApp details.
2. Existing users do not experience an empty reminder during transition.
3. Slack and WhatsApp both satisfy the same creation, bounded matching, resolution, and review contract.
4. One follow-up is created once and maintained across runs.
5. Ignored completion recommendations safely return open work to pending.
6. Confirmed work does not return in later reminders.
7. Generic and transition fixtures pass for both platforms.
8. The Goosebumps WhatsApp reference case and one Slack case validate the behaviour end to end.

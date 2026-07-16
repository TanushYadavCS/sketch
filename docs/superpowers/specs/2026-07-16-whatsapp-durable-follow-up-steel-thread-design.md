# WhatsApp Durable Follow-Up Steel Thread

**Date:** 2026-07-16  
**Status:** Proposed steel-thread story  
**Audience:** Sketch product and engineering  
**Reference case:** Ashish J. Banka, Goosebumps

## Story

### Prevent a resolved WhatsApp follow-up from resurfacing

**User story**

As a user receiving WhatsApp summaries and follow-up reminders, I want Sketch to maintain each follow-up across runs so that it is created once, updated from later messages, and stops appearing as pending after it is resolved.

## Product Scope

This is a general Sketch capability. It applies to every eligible user and WhatsApp Summarizer source when durable task creation is enabled.

Ashish's Goosebumps experience is:

- The motivating customer example.
- The first manual pilot.
- A concrete acceptance fixture.

It is not an implementation boundary. Production code must not contain Goosebumps-specific:

- Tenant, user, automation, or source identifiers.
- Prompt branches.
- Allowlisting logic.
- Task matching rules.
- Status behaviour.

## Problem

Summarizers and scheduled reminders currently reconstruct follow-ups from the context available to each run. They do not share a reliable model of previously extracted work.

This can cause:

- A completed follow-up to return as pending.
- Repeated discussion to create redundant tasks.
- Different reminders to report inconsistent states.
- A fresh scheduled run to report no tracked work when chat history is unavailable.
- Users to repeatedly correct or ignore unreliable reminders.

The first slice must prove one outcome:

> Once a WhatsApp follow-up is explicitly resolved, the same work does not return as pending in a later reminder.

## Goosebumps Reference Case

The July 16, 2026 production inspection found:

- 94 completed Summarizer outputs containing 114 visible action items.
- Summarizer task creation was disabled.
- No Summarizer-created durable tasks existed.
- Current tasks had no WhatsApp message evidence or completed-task memory.
- Follow-up automations ran in fresh sessions.
- The Goosebumps 2 PM Consolidated Daily Brief attempted to search chat history but did not receive the conversation context required by those tools.

The service itself was healthy. The failure was architectural: scheduled runs did not have a shared, durable representation of follow-up state.

Ashish's 2 PM brief is therefore the first validation consumer, but the underlying write, query, review, and deduplication paths remain generic.

## End-to-End Slice

1. Summarizer sees a concrete follow-up in a configured WhatsApp source.
2. Sketch creates one durable task with owner and message evidence.
3. A later Summarizer run loads relevant open tasks before evaluating new messages.
4. Repeated discussion updates the existing task.
5. An explicit completion message creates a resolution recommendation.
6. A reminder reads durable task state rather than reconstructing pending work from chat history.
7. The task appears once under `Looks resolved`, not under `Pending follow-ups`.
8. The user confirms completion or keeps the task open from WhatsApp.
9. Confirmed work remains absent from future pending reminders.

## Why This Slice

### Alternative: fix scheduled chat-history access

This would remove one failure message but leave every scheduled run responsible for reconstructing task state from conversation history.

### Alternative: search 30 days of messages on every run

This may suppress some stale follow-ups, but it is expensive and remains dependent on retrieval quality.

### Recommended: maintain durable follow-up state

Summarizer incrementally maintains tasks, and reminder consumers read that state. This directly tests the durable-memory product thesis and creates a reusable foundation for all users and reminder surfaces.

## Functional Design

### 1. Persist WhatsApp follow-ups as durable tasks

When task creation is enabled for Summarizer, concrete follow-ups from configured WhatsApp sources may be promoted into Sketch-native tasks.

Every promoted task includes:

- Owner or assignee.
- Parent project or customer when resolved.
- Source conversation ID.
- Source message ID.
- Normalized title.
- Local status authority.

Candidates without a supported source message or resolvable internal owner are skipped with an observable reason.

The initial implementation uses the existing Summarizer task-creation setting. It does not add tenant-specific source allowlists.

### 2. Load source-relevant task memory

Before extracting task changes, Summarizer loads open and in-progress tasks relevant to the run:

- Tasks owned by the run's user.
- Tasks linked to the configured source conversation.
- Tasks linked to the resolved parent, when available.

The model receives:

- Task ID.
- Title.
- Status.
- Parent.
- Assignee.
- Existing source evidence.
- Latest real status-change timestamp.

The same task set is used as the candidate pool for matching before creation.

### 3. Produce a minimal task diff

The steel thread supports three verdicts:

- `new` — no existing task represents the commitment.
- `changed` — an active task matches and has new evidence or safe metadata.
- `resolved` — explicit source evidence indicates that an active task is complete.

`changed` and `resolved` include the matched task ID and new WhatsApp message evidence.

Vague acknowledgements, reactions, and ambiguous progress updates do not resolve tasks.

### 4. Apply changes idempotently

- `new` creates one task.
- `changed` updates the matched task and adds evidence.
- `resolved` adds evidence and creates one completion recommendation.
- Reprocessing the same message window creates no duplicate task, evidence, or recommendation.
- One failed candidate does not prevent unrelated valid candidates from being processed.

### 5. Store a completion recommendation

The steel thread needs one narrow review object rather than the complete future proposal system.

It stores:

- Task ID.
- Proposed status: `done`.
- Originating Summarizer output.
- Supporting WhatsApp message evidence.
- Concise rationale.
- Review state: pending, accepted, or rejected.
- Creation and review timestamps.
- Reviewing user.

While completion review is pending, the task is excluded from pending reminders and appears once as `Looks resolved`.

### 6. Expose a generic task-led reminder query

Reminder consumers use a shared task query that returns:

- Open and in-progress tasks as pending follow-ups.
- Pending completion recommendations as looks-resolved items.
- No done or dropped tasks.
- An explicit query-error result distinct from an empty result.

The query is generic and reusable by Daily Brief and scheduled reminders.

It does not require `SearchChatHistory` or `ReadChatHistory` to determine current task status.

### 7. Integrate one reminder consumer

The steel thread integrates the generic query with one scheduled reminder end to end.

The first production validation is Goosebumps' `Consolidated Daily Brief — 2 PM (Mon–Sat)`, because it exposed the customer problem. This integration demonstrates the shared contract; it does not embed customer-specific behaviour in the contract.

Other brief sections continue using their current data paths.

### 8. Review from WhatsApp

The reminder delivery supports:

- `Confirm done`
- `Keep open`

The action updates the recommendation and task atomically.

If native WhatsApp actions are unavailable, the first release may use explicit reply commands tied to a stable task reference.

## Example: Ashish at Goosebumps

### Follow-up appears

A configured Goosebumps WhatsApp source contains a concrete commitment owned by Ashish.

Sketch creates one open task with the source message as evidence. The task appears under `Pending follow-ups` in the next 2 PM brief.

### The same work is discussed again

A later message repeats or clarifies the commitment.

Sketch matches it to the existing task, attaches the new evidence, and creates no duplicate.

### The work is fixed

A later message explicitly says that the work has been completed, fixed, sent, or closed.

Sketch attaches the completion evidence and creates a `done` recommendation.

The next 2 PM brief shows the task once under `Looks resolved`, with `Confirm done` and `Keep open`. It does not also show the task as pending.

### Ashish decides

- `Confirm done` closes the task and keeps it out of future pending reminders.
- `Keep open` returns the task to the pending set and suppresses the same recommendation until new completion evidence arrives.

## Acceptance Criteria

### General behaviour

- A concrete follow-up from an eligible WhatsApp Summarizer source creates one durable task.
- The task retains source conversation and message evidence.
- Repeated or paraphrased discussion matches the existing task.
- An explicit completion message creates one reviewable recommendation.
- A pending recommendation removes the task from pending reminders.
- A confirmed task does not return in later reminders.
- A rejected recommendation returns the task to pending.
- A task never appears simultaneously as pending and looks resolved.
- Reprocessing the same messages is idempotent.
- A task-query failure is never presented as an empty task list.

### Human authority

- The task remains open until the user confirms completion.
- Confirm and reject decisions record actor, surface, and timestamp.
- A rejected recommendation is not regenerated without new completion evidence.

### Permissions

- Users can only inspect WhatsApp evidence they are authorized to access.
- Phone numbers and raw provider identifiers are not shown.
- Missing or deleted evidence does not break the reminder.

### Goosebumps validation

- One Ashish-owned follow-up creates exactly one task.
- A paraphrased update produces no duplicate.
- An explicit completion message moves it from pending to looks resolved.
- Ashish can confirm or reject it from WhatsApp.
- After confirmation, it remains absent for at least five consecutive 2 PM scheduled runs.

## Instrumentation

Record:

- Task created from WhatsApp.
- Signal collated into an existing task.
- Duplicate creation prevented.
- Completion recommendation created.
- Recommendation delivered by a reminder.
- Recommendation accepted or rejected.
- Durable task query failed.
- Candidate skipped because ownership, parent, or evidence was missing.

Initial targets:

- Duplicate tasks for the acceptance fixture: `0`.
- Confirmed resolved tasks resurfacing: `0`.
- Tasks shown simultaneously as pending and resolved: `0`.

Also measure:

- Time from completion-message ingestion to recommendation.
- Recommendation acceptance and rejection rates.
- Reminder runs with task-query failures.

## Test Plan

### Generic automated fixture

Process three ordered WhatsApp windows:

1. A concrete user-owned follow-up.
2. A repeated or paraphrased update.
3. An explicit completion message.

Verify:

- Exactly one task exists.
- All applicable source messages are attached as evidence.
- The second signal produces `changed`.
- The third signal produces `resolved`.
- The reminder excludes it from pending and includes it once as resolved.
- Confirmation marks it done.
- A later reminder does not surface it.

### Negative cases

- A reaction or ambiguous update does not resolve a task.
- Similar work for a different parent does not collate.
- A task owned by someone else is not shown in the user's personal pending list.
- A task-state query error does not render as “no tracked tasks.”
- Rejecting completion does not immediately recreate the same recommendation.

### Goosebumps manual pilot

- Select one non-sensitive Ashish-owned follow-up.
- Observe its creation from Summarizer.
- Add a paraphrased update and verify no duplicate.
- Add an explicit completion signal.
- Verify the 2 PM brief shows it only as looks resolved.
- Confirm completion from WhatsApp.
- Verify it remains absent for the next five 2 PM runs.

## Rollout

1. Implement the capability using tenant-agnostic repositories, services, prompts, and APIs.
2. Add generic configuration or feature rollout controls where required.
3. Run the automated fixture.
4. Enable the capability for the Goosebumps pilot without hardcoded tenant logic.
5. Validate five scheduled 2 PM runs.
6. Expand to other eligible users and reminder consumers.

## Explicit Non-Goals

- Hardcoded Goosebumps or Ashish behaviour.
- Changing every reminder consumer in the first release.
- Task Home.
- Cold-start seeding.
- Searching 30 days of raw messages on every run.
- Cross-source task matching.
- Staleness, cancellation, or supersession verdicts.
- External task-system write-back.
- Gmail or Calendar remediation.
- Retrofitting all existing task rows.

## Definition of Done

The steel thread is complete when:

1. The capability works through generic, tenant-agnostic interfaces.
2. One WhatsApp follow-up is created once and maintained across runs.
3. Repeated discussion updates rather than duplicates it.
4. Explicit completion creates one reviewable recommendation.
5. The user can confirm or reject completion from WhatsApp.
6. Confirmed work does not return in later reminders.
7. The generic fixture passes and the Goosebumps example validates the same behaviour in production.

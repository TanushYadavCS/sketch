# Goosebumps WhatsApp Follow-Up Steel Thread

**Date:** 2026-07-16  
**Status:** Proposed steel-thread story  
**Pilot user:** Ashish J. Banka, Goosebumps  
**Audience:** Sketch product and engineering

## Story

### Stop one resolved WhatsApp follow-up from returning in Ashish's daily reminders

**User story**

As Ashish, I want Sketch to remember a follow-up across WhatsApp Summarizer and reminder runs so that it is created once, updated from later messages, and stops appearing as pending when the conversation shows it has been resolved.

## Customer Problem

Ashish receives several pending-task reminders and consolidated briefs every working day. The current runs repeatedly reconstruct follow-ups instead of reading a durable task state. As a result:

- Previously resolved work can return as a pending follow-up.
- Different scheduled runs can produce inconsistent views of the same work.
- A run may report that no tracked tasks exist because it cannot access the chat history it expected.
- Ashish has to repeatedly validate or forward incorrect reminders.

The first slice should solve one observable customer outcome:

> Once a Goosebumps follow-up is clearly resolved in WhatsApp, the same follow-up must not appear again as pending in the 2 PM Consolidated Daily Brief.

## Production Findings

The Goosebumps tenant inspection on July 16, 2026 found:

- The actual compute stack is `sketch-tenant-tenant-129d5`.
- The actual CloudWatch log group is `/sketch/tenant-129d5`.
- The ECS service was healthy and at steady state.
- Goosebumps had 94 completed Summarizer outputs containing 114 visible action items.
- Summarizer task creation was disabled for both configured Summarizer users.
- No `summary`-provenance durable tasks existed.
- Existing current tasks had no WhatsApp conversation-message evidence.
- Existing current tasks had no completed tasks available as durable resolution memory.
- Five active scheduled automations were follow-up-oriented.
- All active scheduled automations used fresh sessions.
- The observed “chat history unavailable” message came from the active `Consolidated Daily Brief — 2 PM (Mon–Sat)` automation.
- That run called both `SearchChatHistory` and `ReadChatHistory`, but the scheduled agent step did not receive the originating WhatsApp conversation context.

This means the reported behaviour was not caused by an infrastructure outage. The automations lacked a reliable shared work state and attempted to reconstruct follow-ups from context that was unavailable or incomplete.

## Recommended Steel Thread

Use one selected Goosebumps WhatsApp Summarizer source and the existing 2 PM Consolidated Daily Brief.

The source may be a group or direct conversation, but it must be explicitly configured and stable for the pilot. The result is delivered to Ashish's existing WhatsApp DM.

The complete path is:

1. Summarizer sees a concrete Goosebumps follow-up in the selected WhatsApp source.
2. Summarizer creates one durable task owned by Ashish with source-message evidence.
3. A later Summarizer run loads that task before evaluating new messages.
4. Repeated discussion collates into the same task.
5. An explicit completion message creates a resolution recommendation.
6. The 2 PM brief excludes that task from `Pending follow-ups` while resolution is pending.
7. The brief shows the task once under `Looks resolved`.
8. Ashish confirms completion or keeps it open from WhatsApp.
9. Confirmed work remains absent from future pending-follow-up reminders.

## Why This Approach

Three possible cuts were considered.

### Fix scheduled chat-history access only

This would stop the immediate “history unavailable” message, but every run would still re-read and reinterpret conversation history. It would not establish durable completion state or prevent future duplication reliably.

### Add a 30-day corroboration scan to every reminder

This could suppress some stale work but would make each scheduled run expensive, noisy, and retrieval-dependent.

### Maintain one durable follow-up across runs

This directly tests the product thesis and creates reusable state for Summarizer, the 2 PM brief, and later reminder automations. This is the recommended approach.

## Example Journey

### First signal: follow-up created

A participant in the selected WhatsApp source makes a concrete commitment assigned to Ashish.

Summarizer creates:

- One open Sketch-native task.
- Ashish as owner or assignee.
- The selected Goosebumps project or customer as parent.
- The originating WhatsApp conversation and message as evidence.

The task may appear under `Pending follow-ups` in the next 2 PM brief.

### Second signal: repeated discussion

A later message repeats or clarifies the same commitment.

Summarizer:

- Loads the existing open task.
- Matches the new signal to it.
- Adds the new message as evidence.
- Updates safe metadata when needed.
- Creates no additional task.

### Third signal: work is fixed

A later message explicitly states that the work has been completed, fixed, sent, closed, or otherwise resolved.

Summarizer:

- Matches the message to the existing task.
- Attaches the completion evidence.
- Creates one `done` recommendation.
- Moves the task out of the pending-reminder set while review is outstanding.

The 2 PM brief shows:

**Looks resolved**

- The task title.
- A concise reason.
- The WhatsApp source.
- `Confirm done` and `Keep open` actions.

It does not show the same task under `Pending follow-ups`.

### Ashish confirms or rejects

If Ashish selects `Confirm done`:

- The task becomes done.
- The decision is audited.
- The task stays absent from later pending reminders.

If Ashish selects `Keep open`:

- The task returns to the pending set.
- The rejection is audited.
- The same completion evidence cannot immediately create another recommendation.

## Functional Design

### 1. Enable durable task creation for one Summarizer route

The existing `createTasks` preference is agent-level, not route-level. For the pilot, enable task creation for Ashish's Summarizer while adding an explicit promotion allowlist for the selected Goosebumps WhatsApp route. Other configured routes may still produce summaries, but their candidates are not persisted as tasks during this slice.

Each created task must include:

- User or assignee identity.
- Parent project/customer when configured.
- Source conversation ID.
- Source message ID.
- Normalized title.
- Local status authority.

Candidates without a supported message reference or Ashish ownership are skipped with an observable reason.

### 2. Load source-relevant open tasks before extraction

Before evaluating new messages, Summarizer loads open and in-progress tasks that:

- Belong to Ashish.
- Belong to the selected parent when one is configured.
- Have evidence from the selected WhatsApp conversation.

The prompt receives:

- Task ID.
- Title.
- Status.
- Parent.
- Assignee.
- Existing source evidence.
- Latest real status-change timestamp.

This source-and-owner set is also the candidate pool for matching before creation.

### 3. Produce a minimal task diff

The steel thread supports three verdicts:

- `new` — the commitment is not represented by an existing task.
- `changed` — the commitment matches an existing active task and supplies new evidence.
- `resolved` — an explicit source message indicates that an existing task is complete.

`changed` and `resolved` must include an existing task ID and new WhatsApp message evidence.

Vague acknowledgements, reactions, and ambiguous progress statements must not produce `resolved`.

### 4. Apply the diff idempotently

- `new` creates one task.
- `changed` adds evidence to the existing task.
- `resolved` adds evidence and creates one completion recommendation.
- Reprocessing the same messages creates no duplicate tasks, evidence, or recommendations.
- A failed candidate does not block unrelated valid candidates.

### 5. Introduce a narrow resolution-review state

The steel thread does not require the full generic proposal system.

It requires one persisted completion recommendation containing:

- Task ID.
- Proposed status: `done`.
- Source Summarizer output.
- Supporting WhatsApp message evidence.
- Concise rationale.
- Review state: pending, accepted, or rejected.
- Created and reviewed timestamps.
- Reviewing user when decided.

While a completion recommendation is pending, the task is excluded from `Pending follow-ups` and included once under `Looks resolved`.

### 6. Make the 2 PM brief task-led

The `Consolidated Daily Brief — 2 PM (Mon–Sat)` automation must read durable task state for the selected pilot source.

For this slice:

- It does not reconstruct pending follow-ups from raw chat history.
- It does not depend on `SearchChatHistory` or `ReadChatHistory` for task status.
- Open and in-progress tasks populate `Pending follow-ups`.
- Pending completion recommendations populate `Looks resolved`.
- Done tasks are excluded.
- If the durable task query fails, the brief reports a task-state error rather than claiming that no pending work exists.

Other brief sections may continue using their current data paths.

### 7. Review from WhatsApp

The 2 PM WhatsApp delivery provides action identifiers or reply handling for:

- `Confirm done`
- `Keep open`

The action must update the recommendation and task atomically.

If interactive WhatsApp actions are not available in the current delivery path, the pilot may use explicit reply commands tied to the delivered task reference.

## Acceptance Criteria

### Creation

- A concrete follow-up from the selected WhatsApp source creates one task owned by Ashish.
- The task stores the source conversation and message evidence.
- The task is available to the 2 PM brief.

### Deduplication

- Repeated or paraphrased discussion of the same commitment matches the existing task.
- New source evidence is attached.
- No additional task is created.
- Re-running the same Summarizer window is idempotent.

### Resolution

- An explicit completion message matches the existing task.
- One completion recommendation is created.
- The task is removed from `Pending follow-ups` while the recommendation is pending.
- The task appears once under `Looks resolved`.
- Reprocessing the completion message creates no second recommendation.

### Human authority

- Ashish can confirm completion.
- Ashish can keep the task open.
- Confirmation marks the task done.
- Rejection returns the task to the pending set.
- Both decisions record actor, surface, and timestamp.
- A rejected recommendation is suppressed until new completion evidence arrives.

### Scheduled reminder continuity

- The 2 PM brief reads durable task state successfully.
- It does not use chat-history availability as the source of truth for pending work.
- A confirmed done task does not return in later 2 PM briefs.
- A task cannot appear simultaneously under `Pending follow-ups` and `Looks resolved`.
- A task-state query failure is distinguishable from an empty task list.

### Permissions and safety

- Only authorized Goosebumps users can inspect the supporting WhatsApp evidence.
- No raw phone numbers or provider identifiers appear in the task or brief.
- Missing or deleted evidence does not break the brief.

## Instrumentation

Record:

- Task created from the selected source.
- Signal collated into an existing task.
- Duplicate creation prevented.
- Resolution recommendation created.
- Recommendation delivered in the 2 PM brief.
- Recommendation confirmed or rejected.
- Durable task query failed.
- Candidate skipped because ownership, parent, or evidence was missing.

Pilot metrics:

- Duplicate tasks created for the fixture commitment: target `0`.
- Confirmed resolved tasks resurfacing later: target `0`.
- Task appearing in both pending and resolved sections: target `0`.
- Time from completion-message ingestion to resolution recommendation.
- Recommendation confirmation and rejection rate.

## Test Plan

### Automated fixture

Process three ordered WhatsApp windows:

1. A concrete Ashish-owned follow-up.
2. A repeated or paraphrased reminder.
3. An explicit completion message.

Verify:

- Exactly one task exists.
- All applicable messages are attached as evidence.
- The second signal produces `changed`.
- The third signal produces `resolved`.
- The pending 2 PM brief excludes the task.
- The resolved section includes it once.
- Confirmation marks it done.
- A later 2 PM brief does not surface it.

### Negative cases

- “Okay,” a reaction, or an ambiguous progress update does not resolve the task.
- A similar commitment for another customer does not collate.
- A task without Ashish ownership is not included in his personal pending list.
- A task-state database error does not render as “no tracked tasks.”
- Rejected completion remains open without immediately regenerating the same recommendation.

### Manual Goosebumps pilot

- Select one non-sensitive follow-up in a configured Goosebumps WhatsApp source.
- Observe creation in Summarizer.
- Send a paraphrased update and confirm no duplicate is created.
- Send an explicit completion signal.
- Run or wait for the 2 PM brief.
- Confirm completion from WhatsApp.
- Run the next 2 PM brief and verify the task remains absent.

## Explicit Non-Goals

- Changing all Goosebumps automations at once.
- The 9 AM, 12 PM, 3 PM, or 6 PM reminder flows.
- Task Home.
- Cold-start seeding.
- Searching 30 days of raw messages on each run.
- Cross-source task matching.
- Multiple WhatsApp sources in the same pilot run.
- Staleness detection.
- Cancellation or supersession verdicts.
- External task-system write-back.
- Broad Gmail or Calendar remediation.
- Retrofitting all existing Goosebumps task rows.

## Rollout

1. Enable the steel thread for one selected Goosebumps Summarizer source.
2. Route only the 2 PM brief's follow-up section through durable tasks.
3. Run the automated fixture.
4. Complete the manual Ashish pilot.
5. Observe at least five scheduled 2 PM runs.
6. If no confirmed task resurfaces and no duplicate is created, extend the same read model to the other follow-up reminders.

## Definition of Done

The steel thread is complete when:

1. One Ashish-owned WhatsApp follow-up creates exactly one durable task.
2. Repeated discussion updates that task instead of duplicating it.
3. An explicit completion message removes it from pending reminders and creates one reviewable recommendation.
4. Ashish can confirm or reject the recommendation from WhatsApp.
5. A confirmed task does not return in later 2 PM briefs.
6. The flow is audited, instrumented, covered by an automated fixture, and validated in the Goosebumps tenant.

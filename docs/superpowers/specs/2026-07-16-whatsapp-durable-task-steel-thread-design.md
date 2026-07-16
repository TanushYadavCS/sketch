# WhatsApp Durable Task Steel Thread

**Date:** 2026-07-16  
**Status:** Proposed steel-thread story  
**Audience:** Sketch product and engineering

## Story

### Keep one WhatsApp-derived task current from creation through completion

**User story**

As a user following a project through a WhatsApp group, I want Sketch to maintain one durable task as the conversation changes so that the task is created once, updated with new evidence, and closed only with my authority.

## Why This Is the First Slice

This story proves the central Tasks as Durable Memory claim:

> Sketch maintains an existing model of work instead of generating a new task list on every run.

It exercises the complete product path using capabilities Sketch already partially has:

1. A configured WhatsApp group supplies messages to Summarizer.
2. Summarizer creates a structured task.
3. A later run loads that existing task before processing new messages.
4. New WhatsApp evidence is collated into the task.
5. A completion signal produces a reviewable status recommendation.
6. The user confirms or rejects the recommendation.
7. Daily Brief reflects the resulting task state without recreating the work.

The slice deliberately uses one group, one project, and one task lifecycle.

## Preconditions

- The user has a configured WhatsApp Summarizer source.
- The source is a group associated with one known Sketch project.
- Task creation is enabled for Summarizer.
- The task is Sketch-native with local status authority.
- The user can open the project's existing task panel.

For this slice, the WhatsApp group must resolve to a single project. Ambiguous or unanchored groups are outside scope.

## Example Journey

### First WhatsApp signal

A group participant writes:

> Tanush will send the revised pricing proposal to Acme by Friday.

After the next Summarizer run, Sketch creates one project task:

- **Title:** Send the revised pricing proposal to Acme
- **Status:** Open
- **Source:** WhatsApp
- **Parent:** Acme project
- **Evidence:** The originating WhatsApp message

The task appears in the Acme project drawer and may appear in Daily Brief.

### Repeated or supporting signal

A later message says:

> Reminder that the Acme pricing proposal still needs to go out tomorrow.

After the next run, Sketch:

- Loads the existing open Acme task.
- Matches the new signal to that task.
- Adds the new WhatsApp message as evidence.
- Keeps the task open.
- Does not create another task.

### Completion signal

A later message says:

> The revised proposal has been sent to Acme.

After the next run, Sketch:

- Matches the message to the existing task.
- Adds the completion message as evidence.
- Records a recommendation that the task is done.
- Does not create another task.

### User confirmation

The Acme project task panel shows:

> Looks resolved from a new WhatsApp message.

The user can choose:

- **Confirm done**
- **Keep open**

If confirmed, the task becomes done and the next Daily Brief does not recreate or present it as outstanding.

If kept open, the task remains open and the rejected recommendation is not shown again unless new completion evidence arrives.

## Functional Scope

### Load existing WhatsApp tasks

Before generating task candidates, Summarizer loads open Sketch-native tasks that:

- Belong to the resolved project.
- Were created for the current user.
- Have evidence from the configured WhatsApp group.

The task context supplied to the model includes:

- Task ID.
- Title.
- Current status.
- Parent project.
- Assignee when present.
- Existing WhatsApp evidence identifiers.
- Whether the user has manually changed its status.

### Produce a minimal task diff

For this steel thread, Summarizer supports three task verdicts:

- `new` — no existing task represents the commitment.
- `changed` — an existing task remains active and has new supporting information.
- `resolved` — a new WhatsApp message indicates that an existing task was completed.

Each `changed` or `resolved` verdict must identify the existing task ID and the new message evidence.

Staleness, cancellation, supersession, and older-task search are not part of this slice.

### Apply the diff

- `new` creates a Sketch-native task with WhatsApp message evidence.
- `changed` adds evidence to the matched task and does not create another task.
- `resolved` adds evidence and creates a reviewable completion recommendation.
- Reprocessing the same Summarizer output is idempotent.
- A failure applying one verdict does not prevent other valid verdicts from being applied.

### Preserve human authority

- User status changes are recorded with the user as actor.
- Summarizer never silently overwrites a user status change.
- Completion always requires confirmation in this steel thread, even when the task has not been manually edited.
- External-authority tasks are excluded from this flow.

Requiring confirmation for all completion recommendations keeps the first implementation predictable and avoids needing separate touched-versus-untouched completion behaviour.

### Review from the existing project task panel

The project task panel shows an inline completion recommendation containing:

- The suggested status.
- A concise explanation.
- The WhatsApp source label.
- A preview or link to the supporting message when authorized.
- Confirm and reject actions.

This story does not introduce Task Home.

### Reflect the result in Daily Brief

- Open tasks may appear in Daily Brief as existing work.
- A task with a pending completion recommendation is not recreated.
- A confirmed done task is excluded from outstanding todos.
- A rejected recommendation leaves the task open.

## Acceptance Criteria

### Creation

- A concrete commitment from the configured WhatsApp group creates one Sketch-native project task.
- The task stores the originating conversation-message evidence.
- The task is visible in the project's existing task panel.

### Collation

- A later message describing the same active commitment matches the existing task.
- The new message is added as evidence.
- No second task is created.
- Re-running the same message window remains idempotent.

### Resolution

- A later message clearly indicating completion matches the existing task.
- Sketch creates one completion recommendation with the supporting message.
- The task remains open until the user confirms the recommendation.
- Reprocessing the same completion message does not create another recommendation.

### Human review

- The user can confirm the recommendation and move the task to done.
- The user can reject the recommendation and keep the task open.
- Both decisions record actor, surface, and timestamp.
- A rejected recommendation stays suppressed until new completion evidence appears.

### Daily Brief continuity

- Daily Brief treats the matched task as existing work.
- Daily Brief does not create a duplicate while completion is pending.
- After confirmation, Daily Brief does not present the task as outstanding.

### Permissions and failures

- Users cannot view WhatsApp evidence they are not authorized to access.
- Missing evidence produces a safe fallback rather than breaking the task panel.
- Ambiguous project resolution prevents task creation and records an observable skip reason.
- Partial processing failures are logged with the task, message, and Summarizer output identifiers.

## Minimal Data Changes

The implementation needs enough persisted state to support the full lifecycle:

- Task events for user status decisions.
- A task completion recommendation containing:
  - Task ID.
  - Proposed status.
  - Source agent/output.
  - Supporting evidence.
  - Rationale.
  - Review state.
  - Created and reviewed timestamps.
- A stable link from conversation-message evidence to its WhatsApp conversation.

The broader generic proposal system may reuse this shape later, but this story only requires completion recommendations.

## Observability

Record the following events:

- Task created from WhatsApp.
- WhatsApp evidence collated into an existing task.
- Completion recommendation created.
- Completion recommendation confirmed.
- Completion recommendation rejected.
- Candidate skipped because project resolution was ambiguous.
- Candidate produced a duplicate-prevention match.

The steel thread should report:

- Number of tasks created.
- Number of signals collated.
- Number of duplicate creations.
- Number of completion recommendations confirmed or rejected.
- Time from completion message ingestion to recommendation availability.

## Test Plan

### Repository and service tests

- Resolve tasks by WhatsApp conversation and project.
- Create a task with conversation-message evidence.
- Collate repeated signals into the same task.
- Create one idempotent completion recommendation.
- Confirm and reject a recommendation.
- Prevent unauthorized evidence access.
- Skip ambiguous project matches.

### Agent tests

- Existing task context is present in the Summarizer runtime.
- Repeated commitment produces `changed`, not `new`.
- Explicit completion produces `resolved`.
- Vague acknowledgement does not produce `resolved`.
- Daily Brief consumes the resulting task state without duplication.

### UI tests

- Project task panel displays the completion recommendation.
- Confirming updates task status and removes the pending recommendation.
- Rejecting keeps the task open.
- Missing evidence shows fallback copy.

### End-to-end fixture

Run three ordered WhatsApp message windows:

1. Commitment message.
2. Repeated or supporting message.
3. Completion message.

Verify one task exists throughout the flow, accumulates all three evidence references, requires confirmation for completion, and remains absent from outstanding Daily Brief todos after confirmation.

## Explicit Non-Goals

- Task Home.
- Cold-start history seeding.
- Multiple WhatsApp groups in one run.
- Cross-source collation.
- Unanchored task management.
- Staleness detection.
- Cancellation or supersession verdicts.
- One-hop graph expansion.
- Older-task search.
- Bulk proposal review.
- External task status updates.
- General task editing beyond the existing status surface.

## Definition of Done

The steel thread is complete when a real configured WhatsApp group demonstrates:

1. One commitment creates one project task.
2. Repeated discussion updates that task instead of duplicating it.
3. A completion message creates a reviewable recommendation.
4. The user can confirm or reject completion from the project task panel.
5. The decision is audited.
6. Daily Brief reflects the resulting state correctly.
7. The complete flow is covered by an automated fixture and manual QA.

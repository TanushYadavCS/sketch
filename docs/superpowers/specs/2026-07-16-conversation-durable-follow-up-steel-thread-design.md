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
7. The task appears once under `Looks resolved`, not under `Pending follow-ups`.
8. The user confirms completion or keeps the task open.
9. Confirmed work remains absent from future pending reminders.

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

- Owner or assignee.
- Parent project or customer when resolved.
- Normalized source anchor.
- Source message ID.
- Normalized title.
- Local status authority.

Candidates without a supported source message or resolvable internal owner are skipped with an observable reason.

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

### 4. Apply changes idempotently

- `new` creates one task.
- `changed` updates the matched task and adds evidence.
- `resolved` adds evidence and creates one completion recommendation.
- Reprocessing the same source window creates no duplicate task, evidence, or recommendation.
- One failed candidate does not block unrelated valid candidates.

### 5. Store a completion recommendation

The steel thread stores:

- Task ID.
- Proposed status: `done`.
- Originating Summarizer output.
- Supporting conversation-message evidence.
- Concise rationale.
- Review state: pending, accepted, or rejected.
- Creation and review timestamps.
- Reviewing user.

While review is pending, the task is excluded from pending reminders and appears once as `Looks resolved`.

### 6. Expose a generic task-led reminder query

Reminder consumers use one shared query that returns:

- Open and in-progress tasks as pending follow-ups.
- Pending completion recommendations as looks-resolved items.
- No done or dropped tasks.
- A query-error result distinct from an empty result.

The query may filter by user, source anchor, parent, or a union of those anchors.

It does not require chat-history tools to determine current task status.

### 7. Integrate one reminder consumer

The steel thread integrates the shared query with one reminder consumer end to end.

The first production validation is Goosebumps' 2 PM Consolidated Daily Brief because it exposed the problem. This consumer uses the same contract available to all tenants and both platforms.

Other reminder sections retain their existing data paths.

### 8. Review from the delivery channel

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
5. The task appears once for review and remains absent after confirmation.

## Acceptance Criteria

### Shared behaviour

- A concrete follow-up from an eligible Slack or WhatsApp source creates one durable task.
- The task retains the source anchor and message evidence.
- Repeated or paraphrased discussion matches the existing task.
- An explicit completion message creates one recommendation.
- A pending recommendation removes the task from pending reminders.
- A confirmed task does not return in later reminders.
- A rejected recommendation returns the task to pending.
- A task never appears simultaneously as pending and looks resolved.
- Reprocessing the same source window is idempotent.
- A task-query failure is never presented as an empty task list.

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
- A rejected recommendation is not regenerated without new completion evidence.

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

- Task created from a conversation source.
- Signal collated into an existing task.
- Duplicate creation prevented.
- Completion recommendation created.
- Recommendation delivered.
- Recommendation accepted or rejected.
- Durable task query failed.
- Candidate skipped because ownership, parent, or evidence was missing.

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
- Another user's task is not shown as personal pending work.
- A task-query error does not render as “no tracked tasks.”
- Rejected completion does not recreate without new evidence.

### Goosebumps manual pilot

- Select one non-sensitive Ashish-owned WhatsApp follow-up.
- Observe task creation and collation.
- Add an explicit completion signal.
- Verify the 2 PM brief shows it only as looks resolved.
- Confirm it and verify absence for five later runs.

## Rollout

1. Implement shared tenant-agnostic task lifecycle and source-anchor contracts.
2. Implement Slack and WhatsApp source-evidence adapters.
3. Run shared and platform-specific fixtures.
4. Integrate one generic reminder consumer.
5. Validate the Goosebumps WhatsApp case.
6. Validate one internal Slack source.
7. Expand to other eligible Summarizer routes and reminder consumers.

## Explicit Non-Goals

- Customer-specific behaviour.
- Microsoft Teams, email, meetings, or other source platforms.
- Changing every reminder consumer in the first release.
- Cross-platform collation between Slack and WhatsApp.
- Task Home.
- Cold-start seeding.
- Searching a large raw-message window on every run.
- Staleness, cancellation, or supersession verdicts.
- External task-system write-back.
- Retrofitting all existing task rows.

## Definition of Done

The steel thread is complete when:

1. Shared task lifecycle code is independent of Slack and WhatsApp details.
2. Slack and WhatsApp both satisfy the same creation, collation, resolution, and review contract.
3. One follow-up is created once and maintained across runs.
4. Confirmed work does not return in later reminders.
5. Generic fixtures pass for both platforms.
6. The Goosebumps WhatsApp reference case and one Slack case validate the behaviour end to end.

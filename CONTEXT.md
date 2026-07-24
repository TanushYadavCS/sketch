# Task Memory

Task Memory captures accepted follow-up work and the human decisions that govern how agent-generated proposals affect it.

## Language

**Completion Review**:
A durable, per-task decision point containing evidence-versioned recommendations that the task may be complete. Rejecting its current recommendation keeps the task open until a material change creates a new version and reopens the review; cosmetic edits and elapsed time do not reopen it.
_Avoid_: Completion ask, completion claim

**Completion Recommendation**:
An immutable evidence version within a Completion Review. Briefs resolve to the review’s latest recommendation rather than retaining the version current when the Brief was generated.
_Avoid_: Completion claim, automatic completion

**Review Decision**:
A human judgment made against the exact evidence version presented for review. A decision cannot be applied after that version has been superseded.
_Avoid_: Unversioned action, latest-wins action

**Seed Candidate**:
A reconstructed historical follow-up proposed for acceptance as a task. Dismissing it suppresses the proposal until its underlying source evidence materially changes; generated wording does not create a new candidate.
_Avoid_: Seed task, untracked task

**Material Evidence**:
Source content that changes the factual basis of a follow-up or provides a substantive update to it. Acknowledgements and conversational noise do not qualify.
_Avoid_: Any new message, activity

**Task Activity**:
An immutable record that a Meaningful Task Change committed, including its task, event kind, actor, surface, occurrence time, and bounded change or evidence details.
_Avoid_: Bookkeeping update, raw audit log

**Meaningful Task Change**:
A committed task creation, Material Evidence addition, field change, status change, Completion Review opening, or Review Decision. Updating only bookkeeping timestamps is not meaningful.
_Avoid_: Any task write, `updated_at` change

**Task Attention Feed**:
The bounded, ranked set of existing reader-relevant tasks that may deserve presentation in a Brief, with server-owned reasons such as meaningful change, due state, priority, pending review, or continuity.
_Avoid_: Global backlog, task search result

**Known Task Memory**:
The broader bounded set of existing tasks supplied to prevent duplicate task creation. Presence in Known Task Memory does not imply that a task belongs in the Task Attention Feed or today’s Brief.
_Avoid_: Attention queue, presentation list

**Brief**:
A generated historical content snapshot that may display current state for linked durable records. Seed-candidate decisions remain attached to the evidence-specific proposal, while linked Completion Reviews display their latest recommendation and review state.
_Avoid_: Review queue, task record

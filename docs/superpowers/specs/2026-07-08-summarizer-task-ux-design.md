# Summarizer Task UX Design

Date: 2026-07-08
Worktree: `/Users/tanush/Developer/canvasxai/sketch-manual-qa-20260708-task-creation-anchored`

## Goal

Make Summarizer-generated project tasks understandable end to end. Users should understand when Summarizer creates tasks, where those tasks appear, who owns progress updates, and why admins can monitor tasks without editing them.

## Product Model

- Summarizer can create Sketch-native project tasks from generated follow-ups.
- Generated tasks appear on linked project drawers when the summary item has a project parent.
- The user who owns the generated task can update its local status.
- Admins can see progress for generated tasks on projects they can open.
- Admins cannot update local task status for another user's generated task in this pass.
- Read-only admin state is expected behavior, not an error.

## Scope

This is an end-to-end UX pass across existing surfaces:

- Global Summarizer config page.
- Individual summarizer config page.
- Project drawer task panel.
- Output/task copy that explains source, ownership, status, and read-only behavior.

This pass should not create a standalone Tasks product, assignment workflows, admin override editing, notifications, or reminders.

## Current UX Problems

- The project drawer shows generated tasks, but `Read-only` does not explain that admins are monitoring another user's task.
- Raw labels such as `action_item` and `in_progress` appear in the UI.
- Task cards do not show task owner or creator, so admins cannot tell whose progress they are monitoring.
- Summarizer task creation is controlled from agent config, but the UI does not explain where created tasks land.
- The global create-tasks toggle and individual summarizer pages feel disconnected.
- Admins can now see generated tasks, but the UI does not distinguish "visible for monitoring" from "editable by me."

## UX Direction

### Summarizer Config

Task creation should be presented as an output behavior:

- Label: `Create project tasks from action items`.
- Helper copy: `Tasks appear on linked projects. Task owners can update status; admins can monitor progress.`
- Enabled state should remain one global Summarizer setting for this pass.
- The same row should render consistently in global Summarizer config and individual summarizer config pages.
- Individual summarizer pages should make clear that the setting applies to generated action items for that summarizer's runs, even though the underlying toggle is global.

If task creation is enabled, the row should read as active and intentional. If disabled, it should explain that summaries still generate action items but do not write Sketch tasks.

### Project Drawer Task Panel

Project drawers should treat tasks as a progress-monitoring section, not a raw table.

Header:

- Show counts: total tasks, open, in progress, done, dropped.
- Example: `Tasks · 3 total · 1 in progress · 2 open`.
- If all tasks are read-only for the current user, add compact context such as `Monitoring only`.

Task row content:

- Title.
- Human status pill: `Open`, `In progress`, `Done`, `Dropped`.
- Source: `From Summarizer`, `From Daily Brief`, or external tracker reference.
- Priority when present: `High`, `Medium`, `Low`.
- Owner/creator: `Owned by Tanush Yadav` when the API can provide a name; otherwise `Owned by another user` or `Owned by you`.
- Permission state:
  - Owner/editor: status control is editable.
  - Admin non-owner: `Read-only for you` plus explanatory copy or tooltip: `Admins can monitor this task. Only the owner can update status.`
  - External tracker task: `Managed in Linear` or equivalent when possible; otherwise `Read-only`.

The row should not expose raw `statusRaw` for Summarizer/Daily Brief tasks when a human status is available. External tracker tasks may show raw external status as secondary metadata.

### Admin Progress Monitoring

Admins should be able to answer:

- How many generated tasks exist for this project?
- Which tasks are open, in progress, done, or dropped?
- Which user owns each task?
- Which tasks can I edit versus only monitor?

Admins should not see failed-looking UI when they cannot edit a task. The UI should make their role explicit: they are monitoring progress, not owning the task.

### Data Requirements

The current task DTO includes `createdByUserId` but not creator name or current viewer ownership. For a polished UX, the API should include enough display metadata to avoid showing raw ids.

Recommended DTO additions:

- `createdByUserName: string | null`
- `createdByUserEmail: string | null`
- `isOwnedByViewer: boolean`
- `readonlyReason: "not_owner" | "external_authority" | null`

The frontend can still derive fallback text when names are missing, but the preferred UX should use display names.

### Empty And Loading States

- No tasks: `No project tasks yet. Summarizer action items will appear here when they are linked to this project.`
- Task creation disabled: show this on Summarizer config, not as a project drawer warning.
- Loading should keep the drawer height stable with compact skeleton rows.
- Failed task load should show a small inline retry, not collapse the whole drawer.

## Acceptance Criteria

- Global and individual Summarizer config pages use the same task-creation row label and helper copy.
- The project drawer task panel shows task counts by status.
- Summarizer/Daily Brief task statuses render as human labels, never raw `action_item`.
- Admins viewing another user's generated tasks see progress and owner context, but not an editable status control.
- Owner users still see an editable status control for their own local generated tasks.
- Read-only copy clearly explains why the current user cannot edit.
- Existing external tracker tasks remain visible and read-only.
- No standalone Tasks page is introduced.

## Testing Plan

Automated tests:

- Update `entity-drawer` tests to cover:
  - owner editable row;
  - admin monitoring read-only row;
  - humanized status labels;
  - task count summary.
- Update agent config tests or MSW fixtures to cover the new task-creation copy on both global and individual summarizer surfaces.
- Update API route tests if creator display metadata is added.

Manual QA:

- Login as Tanush and confirm own generated tasks can be edited.
- Login as QA Task Admin and confirm the same tasks are visible but read-only.
- Confirm project drawer counts match the visible task rows.
- Confirm Summarizer config clearly explains task creation and admin monitoring.
- Confirm mobile/narrow drawer layout does not wrap task metadata into unreadable rows.

## Implementation Notes

- Keep changes inside the existing `TaskPanel` and Summarizer config row components unless a small shared component removes real duplication.
- Prefer a shared `TaskCreationToggleRow` variant for global and per-summarizer pages.
- Use current design language: compact rows, restrained badges, no nested cards.
- Avoid introducing a full task-management model or broad navigation changes in this pass.

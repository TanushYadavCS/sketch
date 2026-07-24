# Inline Follow-up Review Actions — Manual Testing Guide

Use this guide to manually verify the inline Daily Brief review workflow introduced by PR #398.

## Prerequisites

- Run the `feat/inline-followup-review-actions` branch.
- Start the local stack and confirm Sketch is available at `http://localhost:5173`.
- Sign in as the user receiving the fixture. The examples below use `tanush@canvasx.ai`.
- Run commands from the Sketch repository root.

The fixture command creates an online SQLite backup before changing data. It uses a deterministic, user-scoped namespace and resets only records created by this fixture.

## Seed a fresh fixture

```bash
pnpm fixture:inline-followup-review -- seed \
  --db "$PWD/data/sketch.db" \
  --user-email tanush@canvasx.ai
```

The command prints:

- The backup path.
- The fixture Daily Brief ID.
- Three completion-recommendation IDs.
- Two seed-candidate IDs.

Open or refresh:

```text
http://localhost:5173/home
```

Do not generate another Daily Brief during the test. A newer real brief can replace the fixture as the latest brief. Rerun the seed command if that happens.

## Expected fixture inventory

### Untracked follow-ups

| Card | Expected initial presentation |
| --- | --- |
| `QA: Send launch recap to the customer` | `Discuss with Sketch`, then grouped `Track` and `Dismiss` |
| `QA: Remove duplicate launch reminder` | `Discuss with Sketch`, then grouped `Track` and `Dismiss` |
| `QA: Legacy chat-only follow-up` | Only `Discuss with Sketch`; no review controls |

### Looks resolved

| Card | Expected initial presentation |
| --- | --- |
| `QA: Confirm completed launch checklist` | `Review with Sketch`, then grouped `Mark as done` and `Keep open`; task status `Open` |
| `QA: Keep customer handoff open` | `Review with Sketch`, then grouped `Mark as done` and `Keep open`; task status `Open` |
| `QA: Review an expired completion suggestion` | `Review expired` and `Review with Sketch`; no review controls |

If the expected initial state is missing, rerun the seed command and refresh the page.

## Pass A — Inline row actions

### A1. Mark a completion recommendation done

1. Find `QA: Confirm completed launch checklist`.
2. Click `Mark as done`.
3. Observe the card while the request is running.

Expected:

- The grouped review controls are disabled and `Updating…` appears beneath them.
- A success toast says the follow-up was marked done.
- The card displays `Marked done`.
- The live task status becomes `Done`.
- `Mark as done` and `Keep open` no longer appear.

Refresh the page.

Expected after refresh:

- `Marked done` persists.
- The task remains `Done`.
- Mutation controls do not return.

### A2. Keep a completion recommendation open

1. Find `QA: Keep customer handoff open`.
2. Click `Keep open`.

Expected:

- The grouped review controls are briefly disabled and `Updating…` appears beneath them.
- A success toast says the follow-up was kept open.
- The card displays `Kept open`.
- The linked task remains `Open`.
- Mutation controls disappear.

Refresh and confirm the outcome persists.

### A3. Track a reconstructed follow-up

1. Find `QA: Send launch recap to the customer`.
2. Click `Track`.

Expected:

- The grouped review controls are briefly disabled and `Updating…` appears beneath them.
- A success toast says the follow-up was tracked.
- The card displays `Tracked`.
- A canonical task appears with status `Open`.
- `Track` and `Dismiss` disappear.

Refresh and confirm the tracked state and task overlay persist.

### A4. Dismiss a reconstructed follow-up

1. Find `QA: Remove duplicate launch reminder`.
2. Click `Dismiss`.

Expected:

- The grouped review controls are briefly disabled and `Updating…` appears beneath them.
- A success toast says the follow-up was dismissed.
- The card displays `Dismissed`.
- `Track` and `Dismiss` disappear.
- No task is created for the dismissed card.

Refresh and confirm the dismissed state persists.

### A5. Verify non-actionable cards

For `QA: Review an expired completion suggestion`:

- Confirm `Review expired` is visible.
- Confirm `Mark as done` and `Keep open` are absent.
- Confirm `Review with Sketch` remains available.

For `QA: Legacy chat-only follow-up`:

- Confirm `Track` and `Dismiss` are absent.
- Confirm no review identity or terminal state is displayed.
- Confirm `Discuss with Sketch` remains available.

## Pass B — Detail drawer actions

Reseed the fixture before this pass:

```bash
pnpm fixture:inline-followup-review -- seed \
  --db "$PWD/data/sketch.db" \
  --user-email tanush@canvasx.ai
```

Refresh the Home page.

For one completion card and one seed card:

1. Click the card body to open its detail drawer.
2. Confirm the same review controls appear in the drawer.
3. Apply an action from the drawer.

Expected:

- The drawer disables the grouped review controls and displays `Updating…` beneath them during the request.
- The resulting terminal label and task state match the row behavior.
- The drawer remains coherent after the mutation.
- Closing the drawer reveals the same terminal state on the row.

Clicking an inline review action directly on a row must not accidentally open the drawer.

## Pass C — Keyboard and responsive behavior

Reseed before repeating action tests when necessary.

### Keyboard

1. Use Tab to move through the row controls.
2. Activate each review button with Enter or Space.

Expected:

- Every action is keyboard reachable.
- Focus indicators remain visible.
- Focus order follows the visible controls.
- The action is applied once.
- `Updating…` is announced as a live status by screen-reader tooling.

### Mobile layout

Test at approximately 375 px width.

Expected:

- Review and chat controls wrap without overlapping.
- No horizontal page scrolling is introduced.
- Card titles and task statuses remain readable.
- Detail drawer controls remain reachable.

## Pass D — Retry and conflict behavior

The seed command prints the resource IDs needed for these checks. Run requests from an authenticated browser console so the current Sketch session supplies authentication.

### Same-decision retry

After marking a completion recommendation done, repeat:

```js
await fetch("/api/task-completion-recommendations/<recommendation-id>", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ decision: "confirm_done" }),
}).then(async (response) => ({ status: response.status, body: await response.json() }));
```

Expected:

- Status `200`.
- Review remains `accepted`.
- Task remains `done`.
- No duplicate mutation is created.

### Opposite-decision retry

Against the same recommendation:

```js
await fetch("/api/task-completion-recommendations/<recommendation-id>", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ decision: "keep_open" }),
}).then(async (response) => ({ status: response.status, body: await response.json() }));
```

Expected:

- Status `409`.
- Error code `REVIEW_ALREADY_DECIDED`.
- Review and task state remain unchanged.

The same pattern applies to seed candidates using `/api/task-seed-candidates/<candidate-id>` and the `track` or `dismiss` decisions.

### Invalid decision

```js
await fetch("/api/task-seed-candidates/<candidate-id>", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ decision: "invalid" }),
}).then(async (response) => ({ status: response.status, body: await response.json() }));
```

Expected:

- Status `400`.
- Error code `INVALID_DECISION`.

## Pass E — Error recovery

1. Seed a fresh fixture and load the Home page.
2. Make the Sketch backend temporarily unavailable.
3. Click one pending review action.

Expected:

- An error toast appears.
- The UI does not retain a false terminal outcome.
- Controls recover after the backend returns and the brief refetches.

Restart the stack, reseed the fixture, and refresh before continuing.

## Reset or remove the fixture

Reset every card to its initial state:

```bash
pnpm fixture:inline-followup-review -- seed \
  --db "$PWD/data/sketch.db" \
  --user-email tanush@canvasx.ai
```

Remove all fixture-owned records:

```bash
pnpm fixture:inline-followup-review -- clear \
  --db "$PWD/data/sketch.db" \
  --user-email tanush@canvasx.ai
```

Both commands create a backup before changing the database.

## Pass criteria

- All four direct decisions produce the correct terminal outcome.
- Outcomes persist after refresh and through the detail drawer.
- The tracked seed returns a visible canonical task.
- The dismissed seed creates no task.
- Expired and legacy items never expose invalid controls.
- Same-decision retries are idempotent.
- Opposite decisions return a conflict without changing state.
- No authorization details, review identities, or inaccessible task IDs leak.
- Desktop, mobile, keyboard, and screen-reader behavior remain usable.
- No new frontend console errors or backend errors appear.

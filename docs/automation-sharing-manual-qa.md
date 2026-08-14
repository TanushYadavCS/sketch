# Automation Sharing — Manual QA Plan

Feature branch: `feat/automation-sharing`. Covers per-automation sharing, owner-scoped runs, whole-automation edit locks with steal, agent coverage (web chat / Slack / WhatsApp), run ACK + links, share management via agent, and admin restore.

## Stack

| Service | URL | Notes |
| --- | --- | --- |
| Sketch frontend | http://localhost:5173 | integration worktree, `feat/automation-sharing` |
| Sketch backend | http://localhost:5001 | fresh QA DB (`data/sketch.db`), migrations 001–185 |
| Canvas frontend | http://localhost:3000 | canonical checkout (stale master, dirty Outlook work — intentional) |
| Canvas backend | http://localhost:8000 | MongoDB + Redis up |

## Accounts (fresh QA DB)

| Role | Email | Login |
| --- | --- | --- |
| Owner + Admin | tanush@canvasx.ai | password (Settings admin password) |
| Member | maya.ui-seed@sketch.local | magic link (see below) |
| Member | apeksha.ui-seed@sketch.local | magic link |
| Member | omar.ui-seed@sketch.local | magic link |

**Member login (magic link):** `POST /api/auth/magic-link` with the member email, then grab the magic-link URL from the Sketch backend log (line starts `Magic link (no delivery channels configured)`) and open it in the QA browser. Use two browser profiles (owner / member) to keep sessions separate.

## One-time setup

1. **Sketch → Canvas:** Sketch Settings → Canvas connection → `http://localhost:8000` + the Canvas API key (from `canvas-ai/backend/.env`).
2. **Canvas → Sketch:** Canvas org settings → Sketch connection → `http://localhost:5001` + the Sketch API key (from the worktree `.env` / Settings).
3. **Integrations:** connect the same third-party app (e.g., Gmail) as the owner in Canvas (account used by Sketch automations) and separately as the member, to prove owner-credential isolation.
4. **Seed automations:** as the owner create (a) a scheduled automation with an agent step + a Canvas integration action, delivering to a Slack channel or DM; (b) a second automation with a canvas/webhook trigger.

## Test matrix

### A. Sharing flows (web)

- [ ] Owner opens an automation → ⋮ → Share → member list shows all org members (search works, owner excluded)
- [ ] Grant to maya → member sees the automation under "Shared with me" with badge
- [ ] Non-shared member (apeksha) does not see it (list, direct URL 404, API 404)
- [ ] Member can open the builder, edit steps, save (revision increments)
- [ ] Member can pause/resume and run; cannot delete; Share menu absent/hidden
- [ ] Owner revokes → member's list drops it immediately; direct URL 404s
- [ ] Re-grant is idempotent; self-grant and unknown-user grant return 400
- [ ] Share count chip updates in both list and builder

### B. Edit locks (web, two accounts)

- [ ] Owner and member both open the same automation → second opener sees read-only canvas + "Editing by X" banner; save disabled; Run stays enabled
- [ ] "Take over editing" → holder (other browser) gets Approve/Deny prompt within ~10 s (polling)
- [ ] Approve → requester becomes editor ("You're editing", heartbeat renews); old holder flips to read-only
- [ ] Deny → requester gets an error toast; holder keeps the lock
- [ ] No response → steal expires after 5 min; requester can retry
- [ ] Lock auto-expires after 15 min idle (close the holder tab; wait out the lease) → automation editable again
- [ ] Release on save/unmount → another user can edit immediately
- [ ] Save conflict fallback: with two editors racing outside the lock path, one gets REVISION_CONFLICT (never silent clobbering)

### C. Locks + agent (web chat, Slack, WhatsApp)

- [ ] Member asks the agent to edit a locked automation → "X is editing this automation right now. Reply 'take over'..."
- [ ] "take over" → holder receives confirmation UI in their surface (web: builder dialog; Slack: Approve/Deny buttons; WhatsApp: CONFIRM-STEAL <id> / DENY-STEAL <id> text)
- [ ] Agent `lockStatus` reports holder + expiry; `steal` reports the waiting state
- [ ] Slack button Approve flips the holder; outcome message reaches the requester's channel
- [ ] WhatsApp code parsing works (confirm, deny, malformed input ignored)
- [ ] Owner manages shares via the agent: "share automation X with maya" / "list shares for X" / "revoke maya from X" — member denied ("Only the owner can change sharing")

### D. Run identity, ACK + link, attribution

- [ ] Member runs a shared automation (web Run now + chat) → immediate ACK "Run started. Track it here: <link>" — no inline results in the member's chat
- [ ] Output arrives at the OWNER's configured destination (Slack channel / DM), not the member's channel
- [ ] Run link opens the builder with the run selected; run history shows the run + "triggered by <member>"
- [ ] Execution uses the OWNER's integration credentials (the connected Canvas integration action succeeds using the owner's Gmail account — verify the result content references the owner's account, not the member's)
- [ ] Member's run of the same automation as the owner produces the same result shape
- [ ] Owner's own runs behave identically (uniform ACK + link)

### E. Admin restore

- [ ] Admin sees an "All" tab (member does not) and can open any automation, including unshared
- [ ] Admin can edit, run, pause/resume, and delete any automation without a grant
- [ ] Admin still cannot grant/revoke shares on someone else's automation (share UI hidden, API 404)
- [ ] Admin edits also take the lock uniformly; admin delete while a member holds the lock works (locks cleared)

### F. Canvas cross-testing

- [ ] Canvas workflow triggers a Sketch automation (webhook trigger): Canvas run fires → Sketch run appears in history with trigger data
- [ ] Sketch automation with a `canvas` trigger pulls from Canvas correctly (if applicable)
- [ ] Sketch automation step "run Canvas integration action" executes against localhost:8000 using the owner's Canvas account
- [ ] Both instances' integration connections work simultaneously: owner connected in Canvas, member connected separately; sharing does not leak the member's credentials into runs

### G. Negative / security

- [ ] Non-shared member cannot trigger the automation via any route (list, run, get, edit — all 404)
- [ ] Revoke while member holds the lock → member's next save is denied; owner can re-grant or take over
- [ ] Webhook trigger URL keeps working after grant/revoke (grant writes do not bump task revision)
- [ ] Step-test runs work; attribution may be absent (known residual)
- [ ] WhatsApp group context with unresolved user fails closed (no accidental access)

## Known residuals (accepted for this round)

- WhatsApp holder notification for agent-originated steal requests is not wired (no WhatsApp runtime in the agent plumbing); steals lapse via expiry
- Duplicate ACKs possible if the agent re-invokes run (each is a real run)
- Step-test runs are not attributed (`triggered_by_user_id` null)

## Evidence checklist

For each section, capture: a screenshot/short clip, the expected-vs-actual behavior, and any error text. Report failures as "Section.flow — expected X, saw Y". The parent triages findings into fix lanes; full gates (`pnpm test` + `pnpm build`) run after QA sign-off.

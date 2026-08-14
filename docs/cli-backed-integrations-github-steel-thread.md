# CLI-backed integrations: GitHub steel-thread plan

## Goal

A user can find GitHub on **Integrations**, add a personal access token, verify it, choose who or which channel can use it, and immediately use the GitHub CLI through a managed GitHub skill in chat and Sketch-agent automation steps. GitHub operations must not execute through Canvas.

This is a new integration execution mode, not another Canvas app and not an indexed Files connector.

## User-visible contract

1. The Integrations catalog contains one GitHub card, regardless of whether Canvas also advertises GitHub.
2. Selecting GitHub opens an in-Sketch token form, not a Canvas popup.
3. Sketch verifies the token against GitHub and displays the authenticated GitHub login.
4. The connection is personal by default. The owner can reuse the existing environment-variable sharing controls to grant it to users, the organization, Slack channels, or WhatsApp groups.
5. In an authorized runtime context, Sketch exposes the managed `github` skill and the `gh` CLI runs with the resolved token.
6. In an unauthorized context, the GitHub credential is absent and loading or invoking the managed GitHub skill fails closed.
7. Sketch-agent automation steps run as the automation creator and receive the same context-resolved GitHub connection. The first steel thread does not add GitHub to deterministic JavaScript action steps.
8. Disconnecting GitHub removes the integration record and its managed environment variable and revokes all Sketch-side shares. It does not revoke the token at GitHub.
9. Canvas never connects, suggests, or executes GitHub for Sketch after this ships.

## Scope decisions

### In the first steel thread

- GitHub personal access tokens: classic and fine-grained tokens accepted if GitHub's authenticated-user endpoint accepts them.
- GitHub integration catalog/search, create, verify, list, update token, share, and disconnect.
- Managed `GH_TOKEN` credential backed by the existing encrypted agent environment-variable storage.
- Managed GitHub skill with `gh` usage guidance.
- Interactive web, Slack DM/channel, WhatsApp DM/group, and full Sketch-agent automation runtime resolution through the existing environment context rules.
- Server-side enforcement preventing Canvas-backed GitHub connections and actions.
- SQLite and Postgres coverage.

### Explicitly out of scope

- GitHub OAuth or GitHub App installation.
- Repository/issue/PR indexing into Files or org memory.
- Webhook triggers.
- Deterministic JavaScript automation actions using `ctx.integrations.executeAction`.
- Token scope inference beyond reporting GitHub's returned token-scope headers when available.
- Multiple GitHub accounts owned by one Sketch user. The first steel thread allows one GitHub connection per owner.
- Automatic token revocation at GitHub on disconnect.
- Linear, AWS, or other CLI-backed integrations. The contracts are plural-ready, but only GitHub is registered.

## Why this architecture

The current `mcp_servers` integration-provider row is organization-wide and `findIntegrationProvider()` returns one provider. Canvas owns its app catalog, connection lifecycle, broker, and direct actions. A GitHub PAT is per user and its access follows the existing environment-variable sharing model. Putting GitHub into `mcp_servers` would create incorrect ownership and force unrelated provider semantics onto a local credential.

The existing `agent_environment_variables` and `agent_environment_variable_shares` tables already provide encryption, owner scoping, collision detection, and context-aware resolution. CLI-backed connections should own managed variables in those tables rather than creating a second secret system. A small CLI-backed integration metadata layer supplies integration identity, verification state, and UI semantics that a bare variable name cannot safely provide.

## Domain model and contracts

### Static CLI-backed integration catalog

Add `packages/shared/src/cli-integrations.ts`:

```ts
export const cliIntegrationAppIdSchema = z.enum(["github"]);
export type CliIntegrationAppId = z.infer<typeof cliIntegrationAppIdSchema>;

export interface CliIntegrationAppDefinition {
  id: CliIntegrationAppId;
  name: string;
  description: string;
  icon: string;
  skillId: string;
  executable: string;
  credentialFields: Array<{
    id: string;
    label: string;
    envName: string;
    secret: true;
    inputType: "password";
  }>;
}
```

The server owns the authoritative registry in `packages/server/src/integrations/cli/registry.ts`. The first entry is fixed to:

- `id`: `github`
- `skillId`: `github`
- `executable`: `gh`
- one credential field mapped to `GH_TOKEN`

The API serializes safe catalog fields. The client must not duplicate behavior metadata.

### Database

Add an additive migration with the next free number at implementation time:

```text
cli_integration_connections
  id text primary key
  app_id text not null
  owner_user_id text not null references users(id) on delete cascade
  credential_variable_id text not null references agent_environment_variables(id) on delete cascade
  account_external_id text null
  account_login text not null
  status text not null                 -- active | invalid
  verified_at text not null
  last_verification_error text null    -- sanitized, never provider body/token
  created_at text not null default CURRENT_TIMESTAMP
  updated_at text not null default CURRENT_TIMESTAMP

unique(owner_user_id, app_id)
unique(credential_variable_id)
index(app_id, status)
```

Do not store token scopes initially. GitHub scope headers are incomplete for fine-grained PATs and would look authoritative when they are not.

`credential_variable_id` points to an ordinary secret `agent_environment_variables` row named `GH_TOKEN`. The service creates both records transactionally. The variable remains owner-scoped and uses existing share rows. The CLI-backed connection is the lifecycle owner of this managed variable; generic environment-variable APIs must prevent renaming (already unsupported) and must prevent deletion of a variable referenced by a CLI-backed connection except through CLI-backed integration disconnect. Value updates happen through the CLI-backed integration verification endpoint, not generic PATCH.

Because the foreign key cascades from variable to connection, direct variable deletion would otherwise silently disconnect GitHub. Add repository guards before deletion and return `409 MANAGED_ENVIRONMENT_VARIABLE`. Keep the foreign key as a final integrity guard for user deletion and cleanup.

### Repository/service boundary

Add:

- `packages/server/src/db/repositories/cli-integration-connections.ts`
- `packages/server/src/integrations/cli/service.ts`
- `packages/server/src/integrations/cli/github.ts`

The service is the only writer of CLI-backed connections and their credential variables.

Core methods:

```ts
listCatalog(query?: string): CliIntegrationApp[]
listConnections(viewerUserId: string): Promise<CliIntegrationConnection[]>
connectGitHub(ownerUserId: string, token: string): Promise<CliIntegrationConnection>
updateGitHubToken(ownerUserId: string, connectionId: string, token: string): Promise<CliIntegrationConnection>
disconnect(ownerUserId: string, connectionId: string): Promise<void>
replaceShares(
  ownerUserId: string,
  connectionId: string,
  targets: AgentEnvironmentShareTargetInput[],
): Promise<CliIntegrationConnection>
resolveAvailability(context: AgentEnvironmentRuntimeContext): Promise<CliIntegrationRuntimeAvailability>
```

`connectGitHub` transaction semantics:

1. Normalize by trimming surrounding whitespace; reject empty or excessively large values.
2. Verify before writing.
3. Begin a DB transaction.
4. Re-check the unique owner/app constraint.
5. Reject an existing owner variable named `GH_TOKEN` with a specific conflict that lets the UI offer migration later; do not overwrite it silently.
6. Insert an encrypted, secret `GH_TOKEN` environment variable.
7. Insert the active connection metadata.
8. Commit.

Token update verifies first, then updates variable value and connection identity/status in one transaction. A failed candidate token leaves the previous working token untouched.

Connection creation must map SQLite and Postgres unique violations to one `409 ALREADY_CONNECTED` response.

### GitHub verification

`packages/server/src/integrations/cli/github.ts` calls `GET https://api.github.com/user` with:

- `Authorization: Bearer <token>`
- `Accept: application/vnd.github+json`
- a pinned `X-GitHub-Api-Version`
- Sketch `User-Agent`
- a 10-second timeout

Accept only a 2xx response matching a Zod schema containing numeric `id` and non-empty `login`. Map 401/403 to a generic invalid-or-insufficient-token error. Map rate limit and upstream failures separately. Never log request headers, token fragments, response bodies, or GitHub email.

Verification proves authentication, not repository access. The UI must say this plainly.

At startup and in setup health, check that `gh` resolves to an executable and record capability health. A missing executable makes connect return `503 CLI_INTEGRATION_UNAVAILABLE`; do not accept a token for a runtime that cannot use it. Package/install `gh` in every supported deployment image and document it for self-hosted installs.

## API

Add authenticated resource routes under `/api/integration-apps`:

```text
GET    /api/integration-apps?q=git
GET    /api/integration-apps/connections
POST   /api/integration-apps/github/connections
PATCH  /api/integration-apps/github/connections/:id/credential
PUT    /api/integration-apps/github/connections/:id/shares
DELETE /api/integration-apps/github/connections/:id
```

Request bodies:

```ts
{ token: string }
{ targets: AgentEnvironmentShareTargetInput[] }
```

Responses reuse the safe app/connection shape where useful, but include `executionMode: "cli"` so the frontend never guesses by app ID or source. Never return the token, masked token, encrypted value, or underlying environment-variable value. Return the variable ID only if the existing share dialog requires it; prefer a CLI-backed share endpoint so UI does not need storage details.

Ownership rules:

- Any authenticated internal member can create their own connection.
- Only the owner can update credentials, change shares, or disconnect.
- Organization sharing still requires admin, matching the environment-variable API.
- External users cannot create or receive CLI-backed shares.
- Every ID-based mutation queries by both connection ID and owner ID; unauthorized and missing both return 404.

## Runtime credential resolution

Keep `createAgentEnvironmentVariableRepository.listForRuntimeContext()` authoritative. It already resolves:

- owned variables in a DM,
- user shares,
- org shares,
- Slack channel shares,
- WhatsApp group shares,
- automation creator credentials plus target shares.

Do not add a parallel CLI-backed token resolver. After the existing resolver returns an environment map, derive CLI-backed integration availability from the presence of the registry's required env names. `GH_TOKEN` is already protected from collisions per target by the share uniqueness constraint.

The current runner passes resolved environment variables into agent execution. Preserve that behavior for the steel thread. This means the model-controlled Bash process can read `GH_TOKEN`, just as it can read any user-created secret environment variable today. This is an accepted first-thread consequence of explicitly reusing environment-variable functionality, not a new guarantee that tokens are non-extractable.

Before broader rollout, evaluate a generic CLI broker that injects secrets only into `gh`, analogous to `integrations/wrapper.ts`. Do not claim secret non-disclosure until that exists. If product requires non-extractability now, it is a steel-thread blocker and the broker must move into scope.

## Managed GitHub skill

Add GitHub to the managed `sketch-skills` manifest and pin/sync it through the existing featured-skill mechanism. The skill should contain:

```yaml
---
name: GitHub CLI
provider-type: cli:github
requires-env:
  - GH_TOKEN
---
```

The body should teach discovery-first `gh` usage, JSON output plus `--jq`, repository disambiguation with `--repo OWNER/REPO`, pagination, safe write confirmation, PR/issue/workflow/release commands, API fallback through `gh api`, and explicit error handling. It must always use `gh`; it must never use `$CANVAS_CLI`, Canvas MCP tools, raw tokens, or token-printing commands.

Extend both skill parsers (`skills/loader.ts` and `agent/runtime/skills.ts`) with one shared frontmatter contract for `provider-type` and `requires-env`. Avoid maintaining two subtly different parsers.

### Conditional availability without breaking prompt caching

Do not add per-user skills to the filesystem and do not mutate the system/tool prefix based on connection state. Both would create stale lifecycle behavior and poison prompt caches.

Use this model:

1. Managed skills remain installed once per deployment.
2. Skill discovery and the Skill tool schema remain byte-stable.
3. At run setup, derive available CLI-backed integrations from the already-resolved env map.
4. Append a small dynamic runtime-capabilities block after the stable prompt prefix, alongside other per-run context. It lists `github: available` only when `GH_TOKEN` resolved.
5. The Skill tool checks `requires-env` before returning the skill body and denies unavailable skills with a safe reconnect instruction.
6. The Skills page hides provider-gated skills that are unavailable to the current viewer, while the Integrations page remains the setup surface.

This provides real runtime enforcement while preserving the cacheable prefix. Verify with the four-run cache protocol before merge.

## CLI execution and containment

The full Sketch agent already has Bash with workspace containment. Add `gh` to the ordinary CLI path; do not create an unrestricted permission bypass. Existing Bash/path validation and `canUseTool` remain authoritative.

The managed skill must direct file outputs into the workspace. Commands that pass workspace files to `gh` remain subject to the existing path guard. Add regression coverage for command substitution, absolute paths, symlinks, chained commands, and token-printing guidance. Do not add `gh` to a generic allowlist that bypasses `canUseTool`.

For the AI SDK runtime, confirm that per-run environment injection is isolated and cleaned up on success, error, and cancellation. Never mutate process-wide `process.env` with a user's token.

## Automation behavior

The first steel thread supports GitHub in full Sketch-agent steps:

- The automation authoring model emits an `agent` step with `agentMode: "sketch"` and `agentSkills: ["github"]` for GitHub work.
- Admission validates that each requested provider-gated skill exists and that the automation creator currently owns or can use the required CLI-backed connection.
- Execution resolves environment using `buildAgentEnvironmentRuntimeContext(task)`, so creator-owned `GH_TOKEN` is available for DM automations and the existing sharing rules apply to channel/group contexts.
- Execution re-checks availability every run. A deleted, unshared, or invalid connection fails closed with a reconnect message; saved automation definitions do not embed credentials.
- Manual/test/production runs use the same resolver.

Do not route GitHub through action-step `ctx.integrations.executeAction`. That interface remains Canvas-owned in this slice. A later deterministic CLI-backed integration capability should be an explicit, schema-validated subprocess capability, not arbitrary shell access from the current in-process `AsyncFunction` sandbox.

Fix the existing workflow invocation authorization gap before relying on creator-owned CLI-backed tokens: an authenticated caller must not be able to invoke another user's workflow and observe outputs produced with the creator's credentials. Owner/admin/API-key authority must be explicit at invoke routes and covered by denial tests.

## Blocking Canvas GitHub completely

A UI filter alone is insufficient. Enforce one canonical reserved-app policy in `packages/server/src/integrations/cli/policy.ts`:

```ts
isCanvasBlockedAppId("github") === true
isCanvasBlockedComponentKey("github-create-issue") === true
```

Apply it at every Canvas seam:

1. `CanvasProvider.listApps`: filter reserved CLI-backed app IDs and aliases (`github`, `github-oauth`) from results.
2. Connection intent routes: reject a reserved CLI-backed app before calling Canvas and return a CLI-backed integration setup URL/state.
3. `CanvasProvider.listConnections`: filter existing Canvas GitHub connections so Sketch never treats them as usable.
4. `CanvasProvider.executeAction`: reject reserved component keys before network I/O.
5. Canvas broker: extend `BrokerSpec` with an argv policy and reject explicit GitHub app IDs/component keys before spawning `canvas-cli.js`.
6. Integration cards and direct links: resolve GitHub missing-connection cards to `executionMode: "cli"` and the local token dialog.
7. Automation authoring: GitHub requests select the `github` skill/agent step, never `ctx.integrations.executeAction`.
8. Prompts and Canvas skill: state that reserved CLI-backed integrations must use their native skill.

Broad Canvas catalog/component searches can still mention GitHub in upstream output unless the external Canvas CLI supports provider deny lists. Before release, either:

- add a deny-list option enforced inside `canvas-cli.js` for search and execution responses, or
- replace its broad search path with a Sketch-owned filtered adapter.

Disabling Canvas MCP mode is required for the guarantee because Sketch cannot filter arbitrary remote MCP tool results or calls safely. Migrate Canvas provider rows to `mode: "skill"`, reject future `mode: "mcp"` for Canvas, and remove Canvas MCP wiring after compatibility validation. Side-effect execution is blocked server-side regardless of prompt behavior.

Existing Canvas GitHub connections are not deleted remotely. They become invisible and unusable in Sketch. Show a one-time migration notice inviting the owner to add a PAT locally.

## Integrations access UX

Users should not need to understand Canvas, environment variables, skills, or execution modes. `/integrations` remains one coherent product surface.

### Discovery

1. Search queries one Sketch aggregation endpoint that merges the local CLI-backed catalog with the configured Canvas catalog. The browser does not race or merge providers itself.
2. Canonical app identity and aliases are resolved server-side. A local CLI-backed definition wins, so GitHub appears exactly once even if Canvas returns `github` or `github-oauth`.
3. Cards use the same visual language and “Add” action. Do not expose internal execution modes, environment variables, or Canvas terminology. An optional capability line may say “Works through GitHub CLI” without creating a separate category.
4. Connected results rank first, exact name matches next, and provider pagination remains stable after deduplication.

### GitHub setup wizard

Selecting GitHub opens an in-page dialog with four explicit states:

1. **Understand access**
   - Explain that the token stays in Sketch, actions run as the token's GitHub account, and repository access is determined by GitHub permissions.
   - Recommend a fine-grained PAT and least privilege.
   - Link directly to GitHub's token creation page and a short “Which permissions?” disclosure covering common read, issue/PR write, workflow, and organization cases without claiming one universal scope set.
2. **Enter token**
   - One password field with paste support, reveal/hide control, password-manager compatibility, and no browser/query persistence.
   - “Verify and continue” is disabled for blank input and becomes a cancellable progress state.
   - The token exists only in component-local state until submission; clear it on success, cancellation, unmount, and error after the user chooses whether to retry.
3. **Verify identity**
   - The server verifies GitHub and CLI availability.
   - On success show avatar/login, account type when returned, and “Verified as @login.” Never echo or mask the token.
   - Errors are actionable and distinct: invalid token, GitHub unavailable/rate limited, `gh` unavailable on this Sketch deployment, and already connected.
4. **Choose access**
   - Default to “Only me.”
   - Offer existing target types with plain language: specific teammates, Slack channels, WhatsApp groups, and—admins only—the organization.
   - Show a final human-readable summary such as “Available to you and #engineering.”
   - Commit the connection and shares together from the user's perspective. If share validation fails, keep the verified draft so the token need not be pasted again; if persistence fails, create neither connection nor partial shares.

The success state closes the wizard, adds GitHub to “Your integrations,” and offers two useful next actions: **Try in chat** with a prefilled harmless prompt, or **Create automation** with GitHub already selected. Focus returns to the GitHub card and a screen-reader announcement confirms connection.

### Manage access and credentials

1. The GitHub connection detail shows verified account, owner, health, who can use it, last verified time, and concise examples of supported work.
2. “Manage access” reuses the existing target picker but saves through the integration endpoint. Revoking a target takes effect at the next run; the confirmation states this.
3. “Replace token” uses the same verify-first flow. The old token stays active until the new token verifies and commits atomically. The stored token is never displayed, including as a masked value.
4. “Re-verify” checks the current stored token server-side without returning it. Authentication failure marks the connection `invalid`, removes runtime availability, and shows a reconnect action.
5. “Disconnect” explains that Sketch access and all shares are removed immediately but the PAT remains active at GitHub; include a GitHub revocation link.
6. The Environment Variables section may show a read-only `GH_TOKEN` row labeled “Managed by GitHub integration,” but all edit/delete/share actions deep-link to GitHub settings. The integration—not a raw variable—is the primary UX.

### Access from chat and automations

1. Missing-GitHub cards in web chat open the same wizard in context. After success, the card changes to “Connected as @login” and offers **Retry request**; the user should not retype their original task.
2. Slack and WhatsApp links open `/integrations?connect=github&return_to=...`; after setup, the page confirms where access was granted and offers to return to the conversation.
3. Automation authoring detects missing access before save, opens the same setup wizard, then resumes the draft without losing it. Existing automations with revoked access show “GitHub connection required” and a reconnect action rather than a generic run failure.
4. Shared users can see that GitHub is available and who shared it, but cannot inspect or replace credentials. Only the owner can change the token or disconnect.

### Accessibility and failure behavior

- Full keyboard flow, labeled inputs, focus trapping/restoration, non-color status indicators, and `aria-live` progress/error announcements.
- Closing the dialog during verification aborts the request and clears token state.
- Double submission is idempotent and cannot create two variables/connections.
- Refreshing during setup creates no partial credential. Refreshing after success reconstructs state solely from safe server responses.
- The same local setup flow backs direct Integrations search, chat cards, automation prompts, and channel links; PAT setup never opens a Canvas/OAuth popup.

## Security and prerequisite hardening

The following are release blockers discovered in current code, not optional cleanup:

1. Add explicit admin checks to MCP/provider CRUD routes; comments currently claim admin-only behavior but handlers do not enforce it.
2. Mask all credential-shaped keys (`token`, `accessToken`, `bearerToken`, case-insensitive) or, preferably, return no credential values from MCP APIs.
3. Add owner/authority checks to workflow invoke routes before creator credentials can be used.
4. Add role checks to org-wide skill mutation routes or make managed provider skills immutable through that API.
5. Validate featured-skill manifest IDs and paths with containment checks before copying; pin or integrity-check the managed skill source.
6. Confirm the AI SDK light runtime cannot execute CLI-backed integration CLIs. GitHub automation must use full Sketch mode until equivalent permission/env isolation exists.
7. Never log message content, CLI stdin/stdout containing tokens, authorization headers, or GitHub API bodies.

## Rollout and rollback

There is no feature flag. Ship this as one coherent replacement for GitHub's Canvas-backed path; do not expose half of the lifecycle.

Use deployment sequencing instead:

1. Land additive schema and dormant backend support first if separate deploys are necessary, without advertising GitHub locally or blocking Canvas.
2. The cutover release atomically enables the local GitHub catalog, access UX, runtime skill, automation behavior, and Canvas exclusion.
3. Run pre-deploy checks that `gh` exists and the managed GitHub skill is installed; fail deployment before cutover if either is missing.
4. Roll forward for application defects. The additive table is safe for older code, but rolling back to an image that routes GitHub through Canvas would violate the execution guarantee.
5. If emergency rollback is unavoidable, keep a small compatibility patch that leaves GitHub blocked in Canvas and returns an explicit temporarily-unavailable state; never silently fall back to Canvas.
6. Existing locally stored connections remain encrypted and untouched through a rollback. No down migration should delete them.

## Implementation sequence

### Phase 0: hardening and contracts

1. Fix MCP/provider CRUD authorization and credential serialization.
2. Fix workflow invocation owner/authority checks.
3. Protect org skills and featured-skill sync paths.
4. Add shared CLI-backed app/connection schemas and the static GitHub registry.
5. Add contract tests for catalog identity, canonical aliases, and reserved Canvas policy.

### Phase 1: persistence and verification

1. Add the portable migration and schema types.
2. Add CLI-backed integration repository and transaction-based service.
3. Add managed-variable deletion/update guards to environment APIs.
4. Implement GitHub `/user` verifier and `gh` executable health check.
5. Add API routes with owner/admin/share authorization.
6. Test SQLite repositories plus PGlite integration behavior for unique constraints, foreign keys, transactions, and rollback.

### Phase 2: unified Integrations access experience

1. Add the server-side aggregated catalog and connection endpoint, API client methods, and MSW defaults.
2. Refactor catalog/search view models to discriminate execution internally while presenting one Integrations UX.
3. Implement the four-state GitHub setup wizard, token-state clearing, actionable errors, accessibility, and idempotency.
4. Reuse the share-target picker through the CLI-backed integration endpoint and make connection-plus-shares atomic from the user's perspective.
5. Implement connection details, replace/re-verify/disconnect flows, and mark `GH_TOKEN` as managed in Environment Variables UI.
6. Route web chat cards, automation setup prompts, and channel links to the same resumable flow.

### Phase 3: skill and runtime

1. Add the managed GitHub skill and secure featured-sync metadata.
2. Consolidate skill frontmatter parsing and support `requires-env`.
3. Resolve CLI-backed integration availability from runtime env.
4. Add dynamic post-prefix capability context and Skill-tool enforcement.
5. Confirm `GH_TOKEN` reaches only the current run's environment and is cleaned up.
6. Add full-agent chat tests that load the skill and invoke a fake `gh` executable.
7. Run the prompt-cache four-run live verification.

### Phase 4: automations

1. Teach authoring that GitHub means a full Sketch-agent step with `agentSkills: ["github"]`.
2. Add admission validation for provider-gated skills.
3. Re-check connection/share status on every run.
4. Cover scheduled, manual, and test runs and DM/channel/group contexts.
5. Prove another user cannot invoke or observe a creator-credential run without authority.

### Phase 5: Canvas exclusion and migration

1. Apply reserved-app filters to Canvas catalog, intents, connections, cards, and direct actions.
2. Add broker argv policy and Canvas CLI search deny-list support.
3. Force Canvas provider to skill mode and eliminate the unfilterable MCP path.
4. Make local GitHub win catalog deduplication.
5. Add migration notice for hidden legacy Canvas GitHub connections.
6. Run end-to-end negative tests proving no Canvas HTTP/MCP/CLI call occurs for GitHub setup or actions.

### Phase 6: cutover

1. Deploy additive migration/backend prerequisites without changing GitHub routing if a preparatory release is needed.
2. Verify `gh`, managed skill integrity, database migration, and GitHub API reachability in staging.
3. Ship the atomic GitHub cutover: unified catalog/access UX, runtime and automation support, and Canvas exclusion together.
4. Connect both a fine-grained PAT and a classic PAT and exercise web/Slack/WhatsApp and automation contexts.
5. Audit logs and traces for token leakage and verify prompt caching/runtime cleanup.
6. Monitor connect failures, invalidation, Canvas-block rejections, and automation failures; roll forward without Canvas fallback.

## Test matrix

### API and persistence

- Connect valid token; invalid/revoked/rate-limited/upstream timeout cases.
- Duplicate GitHub connection and pre-existing `GH_TOKEN` conflicts.
- Failed token replacement preserves old working token.
- Owner-only update/share/delete and admin-only org sharing.
- Managed env generic update/delete blocked.
- Disconnect atomically removes variable and shares.
- User deletion cascades safely.
- SQLite and Postgres unique/error behavior.

### Runtime sharing

- Owner DM gets `GH_TOKEN` and GitHub skill.
- Unshared user DM does not.
- Explicit user share does.
- Slack channel and WhatsApp group shares work only in that target.
- Org share works for internal members, not external users.
- Conflicting `GH_TOKEN` share is rejected deterministically.
- Revocation/disconnect during a queued run is checked at run start.

### Skill/CLI

- `requires-env` parser and unavailable-skill denial.
- Stable skill tool schema across connected/disconnected users.
- Fake `gh` receives token only in its run environment.
- Parallel runs for different users never cross tokens.
- Cancellation/error cleanup.
- Workspace path and shell-composition regression tests.
- Real deployment `gh --version` health probe.

### Canvas exclusion

- GitHub absent from Canvas app results and connection results.
- GitHub intent never calls Canvas.
- `github-*` direct action rejected before fetch.
- Canvas CLI GitHub argv rejected before spawn.
- Broad search cannot return an actionable GitHub Canvas component.
- Canvas MCP mode cannot be configured.
- Existing Canvas GitHub account cannot satisfy local connection status.

### UI and end to end

- Search “GitHub” returns one local card.
- PAT form verifies and renders account login.
- Token never appears in DOM after submission, API response, query cache, toast, or logs.
- Share/update/disconnect flows.
- Chat card opens local form.
- A real chat request reads a repo and creates a harmless test issue only after normal write confirmation.
- A full-agent automation reads GitHub and a write automation honors the same confirmation/admission policy.

## Steel-thread acceptance criteria

The first steel thread is complete only when all are true:

1. With the feature enabled, a user searches GitHub, enters a PAT, and sees the verified GitHub login without leaving Sketch.
2. No token or derivative is returned to the browser after submission or written to logs.
3. In the owner's web chat, Sketch loads the managed GitHub skill and successfully executes `gh api user` through the real runtime.
4. A non-shared member cannot load the GitHub skill or run authenticated `gh` commands.
5. Sharing with one Slack channel enables GitHub there and nowhere else.
6. A full Sketch-agent automation created by the owner can use GitHub; an unauthorized caller cannot invoke it with the owner's authority.
7. Disconnect immediately removes runtime availability and all shares.
8. Instrumented end-to-end tests prove zero Canvas network, MCP, or CLI execution for GitHub.
9. SQLite and Postgres tests, Biome, typecheck, full tests, and build pass.
10. Prompt-cache verification shows runs 2–4 retain the stable prefix when user messages and GitHub availability differ.

## Accepted residual risks

- PAT permissions remain user-managed and can be broader than necessary.
- Reusing environment variables means a full agent Bash process can read the token until a generic CLI-backed integration broker is implemented.
- Disconnect does not revoke the token at GitHub.
- GitHub API/CLI availability is an external dependency; runs fail closed and retry normally.
- Existing Canvas GitHub credentials remain stored in Canvas but are ignored by Sketch.
- One GitHub account per Sketch user is a deliberate steel-thread constraint.

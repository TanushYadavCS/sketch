/**
 * `POST /passes` is the only route in this file that spends money — it calls a
 * reasoning model per run. So the tests here are about the three ways it could
 * be reached by someone or something that should not have reached it, checked
 * over HTTP because that is the only surface a browser can hit.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { normalizeName } from "../connectors/name-normalize";
import type { ManualRunOutcome, WeeklyMintResult, WeeklyMintService } from "../connectors/weekly-mint";
import { createGraphPassRunRepository } from "../db/repositories/graph-pass-runs";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { confirmReview } from "../entities/resolve";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const logger = createTestLogger();
const ADMIN_EMAIL = "admin@test.com";
const MEMBER_EMAIL = "member@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    id: "admin-user",
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await users.create({
    id: "member-user",
    name: "member",
    email: MEMBER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

function startPass(app: ReturnType<typeof createApp>, cookie: string, companyEntityId: string) {
  return app.request("/api/project-minting/passes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ companyEntityId }),
  });
}

async function runCount(db: Kysely<DB>): Promise<number> {
  const rows = await db.selectFrom("graph_pass_runs").select("id").execute();
  return rows.length;
}

async function seedProjectMintingCluster(db: Kysely<DB>): Promise<string> {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values({
      id: "project-minting-route-connector",
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: "{}",
      scope_config: "{}",
      created_by: "admin-user",
    })
    .execute();
  await db
    .insertInto("entities")
    .values({
      id: "route-company",
      name: "Routeco",
      source_type: "company",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto("entity_domains")
    .values({
      id: "route-company-domain",
      entity_id: "route-company",
      domain: "routeco.example",
      kind: "corporate",
      is_primary: 1,
      confidence: 1,
      source: "manual",
    })
    .execute();

  for (const [index, date] of ["2026-08-01T09:00:00.000Z", "2026-08-08T09:00:00.000Z"].entries()) {
    const fileId = `route-file-${index}`;
    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: "project-minting-route-connector",
        provider_file_id: fileId,
        provider_url: null,
        file_name: "Routeco delivery sync",
        file_type: "transcript",
        content_category: "document",
        content: "Recurring Routeco delivery notes.",
        summary: null,
        source: "fireflies",
        source_path: null,
        content_hash: fileId,
        source_created_at: date,
        source_updated_at: null,
        synced_at: date,
        context_note: null,
        access_scope_id: null,
      })
      .execute();
    await db
      .insertInto("indexed_file_facts")
      .values({
        id: `route-fact-${index}`,
        indexed_file_id: fileId,
        connector_config_id: "project-minting-route-connector",
        created_by_user_id: null,
        source: "test",
        fact_type: "attendee",
        relation: "attended",
        subject_name: "Routeco Lead",
        subject_email: "lead@routeco.example",
        fact_key: `${fileId}:attendee`,
      })
      .execute();
  }

  return "route-company";
}

describe("project minting pass route", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
  });

  /**
   * Asserting on the reason, not just the 404: an unknown company also answers
   * 404, so a status-only assertion would pass with the gate deleted.
   */
  it("does not exist when dev tools are off", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: false }), { logger });
    const res = await startPass(app, await login(app, ADMIN_EMAIL), "company-1");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { message: "Project minting passes are not enabled" } });
    expect(await runCount(db)).toBe(0);
  });

  it("refuses a member even with dev tools on", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const res = await startPass(app, await login(app, MEMBER_EMAIL), "company-1");

    expect(res.status).toBe(403);
    expect(await runCount(db)).toBe(0);
  });

  /**
   * The pass filters by cluster name, so an id that matches no cluster must be
   * rejected before the run starts. Letting it through would run the pass with
   * a filter that matches nothing — a run row and a model client for no reason.
   */
  it("refuses a company that has no cluster, without opening a run", async () => {
    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const res = await startPass(app, await login(app, ADMIN_EMAIL), "not-a-company");

    expect(res.status).toBe(404);
    expect(await runCount(db)).toBe(0);
  });

  it("round-trips project minting runs without leaking into post-sync listings and closes interrupted runs", async () => {
    const companyEntityId = await seedProjectMintingCluster(db);
    const app = createApp(
      db,
      createTestConfig({
        DEV_TOOLS_ENABLED: true,
        OPENROUTER_API_KEY: "test-openrouter-key",
        PROJECT_MINTING_MODEL: "test/project-minting-model",
      }),
      { logger },
    );
    const cookie = await login(app, ADMIN_EMAIL);

    const start = await startPass(app, cookie, companyEntityId);
    expect(start.status).toBe(201);
    const startBody = (await start.json()) as { run: { id: string } };

    const read = await app.request(`/api/project-minting/passes/${startBody.run.id}`, { headers: { Cookie: cookie } });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as {
      run: {
        snapshot: {
          kind: string;
          companyEntityId: string;
          companyName: string;
          model: string;
          clustersConsidered: number;
          verdictsStored: number;
        };
      };
    };
    expect(readBody.run.snapshot).toEqual({
      kind: "project_minting",
      companyEntityId,
      companyName: "Routeco",
      model: "test/project-minting-model",
      clustersConsidered: 1,
      verdictsStored: 0,
    });

    const list = await app.request("/api/graph-passes/runs", { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { runs: Array<{ id: string }> };
    expect(listBody.runs.map((run) => run.id)).not.toContain(startBody.run.id);

    const runs = createGraphPassRunRepository(db);
    const interruptedId = await runs.start({
      kind: "project_minting",
      companyEntityId,
      companyName: "Routeco",
      model: "test/project-minting-model",
      clustersConsidered: 1,
      verdictsStored: 0,
    });
    await expect(runs.failUnfinishedProjectMintingRuns()).resolves.toBeGreaterThanOrEqual(1);
    await expect(runs.get(interruptedId)).resolves.toMatchObject({
      status: "failed",
      errorMessage: "project minting pass interrupted by restart",
    });
  });

  /**
   * The manual "Run now" surface and the server half of the project no-create
   * rule together: only an admin can force a run, the in-flight latch answers
   * 409, an app without the bootstrap service answers 503, and a one-row
   * confirm can never birth a project from file evidence.
   */
  it("guards the manual run route and refuses one-row project births", async () => {
    const emptyResult: WeeklyMintResult = {
      status: "completed",
      stage: "completed",
      clockWeek: "2026-08-17",
      candidatesGrouped: 0,
      verdictsRequested: 0,
      verdictsStored: 0,
      agedOut: 0,
      skippedGroups: 0,
      skippedCompanies: 0,
    };
    const outcomes: ManualRunOutcome[] = [
      { started: true, completion: Promise.resolve(emptyResult) },
      { started: false, reason: "in_flight" },
    ];
    let manualCalls = 0;
    const weeklyMint: WeeklyMintService = {
      runOnce: () => Promise.resolve(emptyResult),
      tryRunManual: () => {
        const outcome = outcomes[Math.min(manualCalls, outcomes.length - 1)];
        manualCalls += 1;
        return outcome;
      },
      start() {},
      stop: () => Promise.resolve(),
    };
    const app = createApp(db, createTestConfig({}), { logger, weeklyMint });
    const runNow = (cookie: string) =>
      app.request("/api/project-minting/runs", { method: "POST", headers: { Cookie: cookie } });

    const memberRes = await runNow(await login(app, MEMBER_EMAIL));
    expect(memberRes.status).toBe(403);
    expect(manualCalls).toBe(0);

    const adminCookie = await login(app, ADMIN_EMAIL);
    const started = await runNow(adminCookie);
    expect(started.status).toBe(202);
    const inFlight = await runNow(adminCookie);
    expect(inFlight.status).toBe(409);
    expect((await inFlight.json()) as object).toMatchObject({ error: { code: "RUN_IN_FLIGHT" } });

    const bareApp = createApp(db, createTestConfig({}), { logger });
    const unavailable = await bareApp.request("/api/project-minting/runs", {
      method: "POST",
      headers: { Cookie: await login(bareApp, ADMIN_EMAIL) },
    });
    expect(unavailable.status).toBe(503);

    const reviewId = randomUUID();
    const now = new Date().toISOString();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: reviewId,
        proposed_name: "Falcon Dashboard",
        normalized_name: normalizeName("Falcon Dashboard"),
        entity_type: "project",
        candidate_entity_id: null,
        candidate_score: null,
        candidate_reason: "birth-gated",
        candidate_generated_at: now,
        first_seen_at: now,
        last_seen_at: now,
        occurrence_count: 3,
        status: "pending",
        triggered_by_user_id: "admin-user",
        source: "llm_extraction",
        source_id: "file-1:project:falcon-dashboard",
      })
      .execute();

    await expect(
      confirmReview({ db, userId: "admin-user" }, reviewId, { candidateGeneratedAt: now }),
    ).rejects.toMatchObject({ code: "PROJECT_BIRTH_BLOCKED" });
    const projectEntities = await db.selectFrom("entities").select("id").where("source_type", "=", "project").execute();
    expect(projectEntities).toHaveLength(0);
  });

  /**
   * The trace payloads hold raw prompts over org content, so the reads answer
   * 403 to members and 404 (not 403) when dev tools are off — a production
   * deployment should not advertise that the surface exists.
   */
  it("serves weekly run observability to admins with dev tools on and hides it otherwise", async () => {
    await db
      .insertInto("weekly_mint_runs")
      .values({
        id: "wr-1",
        run_key: "weekly-mint:2026-08-17",
        status: "completed",
        stage: "completed",
        clock_week: "2026-08-17",
        completed_at: "2026-08-17T00:05:00.000Z",
      })
      .execute();
    await db
      .insertInto("weekly_mint_run_events")
      .values([
        {
          id: "ev-1",
          run_id: "wr-1",
          container_key: "company-1",
          company_entity_id: "company-1",
          company_name: "Acme",
          kind: "claimed",
          detail: JSON.stringify({ claimed: 3 }),
          created_at: "2026-08-17T00:01:00.000Z",
        },
        {
          id: "ev-2",
          run_id: "wr-1",
          container_key: "company-1",
          company_entity_id: "company-1",
          company_name: "Acme",
          kind: "verdict_stored",
          detail: JSON.stringify({ verdictId: "v-1", projects: 2 }),
          created_at: "2026-08-17T00:02:00.000Z",
        },
      ])
      .execute();
    await db
      .insertInto("weekly_mint_traces")
      .values({
        id: "tr-1",
        run_id: "wr-1",
        container_key: "company-1",
        seq: 1,
        kind: "prompt",
        payload: JSON.stringify({ prompt: "judge these groups" }),
      })
      .execute();

    const app = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: true }), { logger });
    const memberRes = await app.request("/api/project-minting/runs", {
      headers: { Cookie: await login(app, MEMBER_EMAIL) },
    });
    expect(memberRes.status).toBe(403);

    const cookie = await login(app, ADMIN_EMAIL);
    const runsRes = await app.request("/api/project-minting/runs", { headers: { Cookie: cookie } });
    expect(runsRes.status).toBe(200);
    expect(await runsRes.json()).toMatchObject({
      runs: [{ id: "wr-1", runKey: "weekly-mint:2026-08-17", status: "completed", eventCount: 2 }],
    });

    const eventsRes = await app.request("/api/project-minting/runs/wr-1/events", { headers: { Cookie: cookie } });
    expect(eventsRes.status).toBe(200);
    expect(await eventsRes.json()).toMatchObject({
      events: [
        { id: "ev-1", kind: "claimed", detail: { claimed: 3 } },
        { id: "ev-2", kind: "verdict_stored", detail: { verdictId: "v-1", projects: 2 } },
      ],
    });
    const missingRes = await app.request("/api/project-minting/runs/nope/events", { headers: { Cookie: cookie } });
    expect(missingRes.status).toBe(404);

    const traceRes = await app.request("/api/project-minting/runs/wr-1/traces/company-1", {
      headers: { Cookie: cookie },
    });
    expect(await traceRes.json()).toMatchObject({ steps: [{ seq: 1, kind: "prompt" }] });

    const offApp = createApp(db, createTestConfig({ DEV_TOOLS_ENABLED: false }), { logger });
    const offRes = await offApp.request("/api/project-minting/runs", {
      headers: { Cookie: await login(offApp, ADMIN_EMAIL) },
    });
    expect(offRes.status).toBe(404);
    expect(await offRes.json()).toMatchObject({ error: { message: "Weekly run observability is not enabled" } });
  });
});

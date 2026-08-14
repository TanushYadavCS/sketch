/**
 * `POST /passes` is the only route in this file that spends money — it calls a
 * reasoning model per run. So the tests here are about the three ways it could
 * be reached by someone or something that should not have reached it, checked
 * over HTTP because that is the only surface a browser can hit.
 */
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createGraphPassRunRepository } from "../db/repositories/graph-pass-runs";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
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
});

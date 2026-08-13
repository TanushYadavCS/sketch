import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import { duplicateDrainActor, duplicateDrainStateRowId } from "./duplicate-drain";
import { parseAliasesString } from "./materialize-json";

const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";

type Harness = {
  db: Kysely<DB>;
  app: ReturnType<typeof createApp>;
  cookie: string;
  ownerId: string;
};

async function createHarness(): Promise<Harness> {
  const db = await createTestPgDb();
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
    skipEntityLinking: true,
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const admin = await users.findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");

  const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), { logger: createTestLogger() });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  return { db, app, cookie: login.headers.get("set-cookie") ?? "", ownerId: admin.id };
}

async function triggerDuplicateDrain(h: Harness) {
  const res = await h.app.request("/api/graph-passes/duplicate-drain-runs", {
    method: "POST",
    headers: { Cookie: h.cookie },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { run: { status: string; inputSnapshot: Record<string, unknown> } | null };
}

async function seedEntity(
  db: Kysely<DB>,
  id: string,
  params: {
    name: string;
    type?: string;
    createdAt?: string;
    email?: string;
    aliases?: string[];
  },
): Promise<string> {
  const now = params.createdAt ?? new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name: params.name,
      source_type: params.type ?? "person",
      status: "active",
      hotness: 0,
      created_at: now,
      updated_at: now,
      metadata: params.email ? JSON.stringify({ email: params.email }) : null,
      aliases: params.aliases ? JSON.stringify(params.aliases) : null,
    })
    .execute();
  return id;
}

async function seedSourceRef(db: Kysely<DB>, entityId: string, sourceId: string): Promise<void> {
  await db
    .insertInto("entity_source_refs")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      source: "test",
      source_id: sourceId,
      source_url: null,
      last_seen_at: "2026-08-13T00:00:00.000Z",
    })
    .execute();
}

async function seedDomain(db: Kysely<DB>, entityId: string, domain: string): Promise<void> {
  await db
    .insertInto("entity_domains")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      domain,
      kind: "corporate",
      is_primary: 1,
      confidence: 1,
      source: "test",
    })
    .execute();
}

async function seedQueueRow(
  db: Kysely<DB>,
  ownerId: string,
  params: {
    proposedName: string;
    type?: string;
    candidateEntityId: string;
    status?: string;
    passReason?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: params.proposedName,
      normalized_name: params.proposedName.trim().toLowerCase(),
      entity_type: params.type ?? "person",
      candidate_entity_id: params.candidateEntityId,
      candidate_score: 1,
      candidate_reason: "test",
      candidate_generated_at: "2026-08-13T00:00:00.000Z",
      status: params.status ?? "pending",
      pass_reason: params.passReason ?? null,
      triggered_by_user_id: ownerId,
    })
    .execute();
  return id;
}

async function liveCount(db: Kysely<DB>, ids: string[]): Promise<number> {
  const row = await db
    .selectFrom("entities")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("id", "in", ids)
    .where("deleted_at", "is", null)
    .where("merged_into_entity_id", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function mergeCount(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_merges")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("duplicate drain", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) await harness.db.destroy();
    harness = null;
  });

  it("never fuses things the graph already knows are different", async () => {
    harness = await createHarness();
    const { db, ownerId } = harness;

    await seedEntity(db, "abhishek-moonshot", {
      name: "Abhishek Sharma",
      email: "abhinav.sharma@moonshotcom.com",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await seedEntity(db, "abhishek-ow", {
      name: "Sharma, Abhishek",
      email: "abhishek.sharma@oliverwyman.com",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    await seedEntity(db, "abhishek-onestop", {
      name: "Abhishek Sharma",
      email: "abhishek.sharma@onestop.ai",
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    await seedEntity(db, "cecilia-work", {
      name: "Cecilia Montessoro",
      email: "cecilia@oliverwyman.com",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await seedEntity(db, "cecilia-gmail", {
      name: "Montessoro, Cecilia",
      email: "cecilia@gmail.com",
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    const vetoedRow = await seedQueueRow(db, ownerId, {
      proposedName: "Montessoro, Cecilia",
      candidateEntityId: "cecilia-work",
      passReason: "different_emails",
    });

    await seedEntity(db, "meta", {
      name: "Meta",
      type: "company",
      aliases: ["Facebook"],
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    await seedEntity(db, "facebook", {
      name: "Facebook",
      type: "company",
      createdAt: "2026-03-02T00:00:00.000Z",
    });

    await triggerDuplicateDrain(harness);

    expect(await liveCount(db, ["abhishek-moonshot", "abhishek-ow", "abhishek-onestop"])).toBe(3);
    const personMerges = await db.selectFrom("entity_merges").selectAll().where("entity_type", "=", "person").execute();
    expect(personMerges).toHaveLength(0);
    const row = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", vetoedRow)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    expect(row.pass_reason).toBe("different_emails");
    expect(await liveCount(db, ["meta", "facebook"])).toBe(2);
    const aliasReview = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("proposed_name", "=", "Facebook")
      .where("candidate_entity_id", "=", "meta")
      .executeTakeFirst();
    expect(aliasReview).toMatchObject({ status: "pending", triggered_by_user_id: "system" });
  });

  it("collapses known duplicates, renames the survivor reversibly, and a second run applies nothing", async () => {
    harness = await createHarness();
    const { db, ownerId } = harness;

    await seedEntity(db, "sugarfit", {
      name: "Sugarfit",
      type: "company",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await seedEntity(db, "sugar-fit", {
      name: "Sugar Fit",
      type: "company",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    await seedSourceRef(db, "sugarfit", "sugarfit-a");
    await seedSourceRef(db, "sugar-fit", "sugarfit-b");

    await seedEntity(db, "open-router", {
      name: "Open Router",
      type: "product",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await seedEntity(db, "openrouter", {
      name: "OpenRouter",
      type: "product",
      createdAt: "2026-02-02T00:00:00.000Z",
    });

    await seedEntity(db, "ceren-comma", {
      name: "Gokoglu, Ceren",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    await seedEntity(db, "ceren-normal", {
      name: "Ceren Gokoglu",
      createdAt: "2026-03-02T00:00:00.000Z",
    });

    await seedEntity(db, "munaf-no-email", {
      name: "Munaf",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    await seedEntity(db, "munaf-email", {
      name: "Munaf",
      email: "munaf@sugarfit.com",
      createdAt: "2026-04-02T00:00:00.000Z",
    });

    await seedEntity(db, "alpha-candidate", {
      name: "Alpha Tool",
      type: "tool",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await seedEntity(db, "alpha-proposal", {
      name: "Tool Alpha",
      type: "tool",
      createdAt: "2026-05-02T00:00:00.000Z",
    });
    const m5Row = await seedQueueRow(db, ownerId, {
      proposedName: "Tool Alpha",
      type: "tool",
      candidateEntityId: "alpha-candidate",
    });

    await triggerDuplicateDrain(harness);

    expect(await liveCount(db, ["sugarfit", "sugar-fit"])).toBe(1);
    const sugar = await db.selectFrom("entities").selectAll().where("id", "=", "sugarfit").executeTakeFirstOrThrow();
    expect(sugar.name).toBe("Sugar Fit");
    expect(parseAliasesString(sugar.aliases)).toContain("Sugarfit");
    const refs = await db
      .selectFrom("entity_source_refs")
      .select("entity_id")
      .where("entity_id", "=", "sugarfit")
      .execute();
    expect(refs).toHaveLength(2);
    expect(await liveCount(db, ["open-router", "openrouter"])).toBe(1);
    expect(await liveCount(db, ["ceren-comma", "ceren-normal"])).toBe(1);
    expect(await liveCount(db, ["munaf-no-email", "munaf-email"])).toBe(1);
    expect(await liveCount(db, ["alpha-candidate", "alpha-proposal"])).toBe(1);
    const resolved = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", m5Row)
      .executeTakeFirstOrThrow();
    expect(resolved).toMatchObject({ status: "confirmed", resolved_by: duplicateDrainActor });
    expect(await mergeCount(db)).toBe(5);

    await triggerDuplicateDrain(harness);

    expect(await mergeCount(db)).toBe(5);
    const state = await db
      .selectFrom("graph_pass_runs")
      .select(["status", "input_snapshot_json"])
      .where("id", "=", duplicateDrainStateRowId)
      .executeTakeFirstOrThrow();
    expect(state.status).toBe("complete");
    expect(JSON.parse(state.input_snapshot_json)).toMatchObject({
      kind: "duplicate_drain",
      version: 1,
      status: "complete",
    });
  });

  it("reverses a chained group as a set without touching another group", async () => {
    harness = await createHarness();
    const { db, app, cookie } = harness;

    await seedEntity(db, "a", {
      name: "Alpha Tool",
      type: "product",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await seedEntity(db, "b", {
      name: "AlphaTool",
      type: "product",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    await triggerDuplicateDrain(harness);

    const firstMerge = await db
      .selectFrom("entity_merges")
      .selectAll()
      .where("merged_entity_id", "=", "b")
      .executeTakeFirstOrThrow();
    await seedEntity(db, "c", {
      name: "Container",
      type: "product",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const chain = await app.request("/api/entities/merges", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId: "c", loserId: "a", groupId: firstMerge.group_id }),
    });
    expect(chain.status).toBe(200);

    await seedEntity(db, "d", {
      name: "Other A",
      type: "product",
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    await seedEntity(db, "e", {
      name: "Other B",
      type: "product",
      createdAt: "2026-03-02T00:00:00.000Z",
    });
    const other = await app.request("/api/entities/merges", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ survivorId: "e", loserId: "d", groupId: "untouched-group" }),
    });
    expect(other.status).toBe(200);

    const reversed = await app.request(`/api/entities/merges/groups/${firstMerge.group_id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(reversed.status).toBe(200);

    expect(await liveCount(db, ["a", "b", "c"])).toBe(3);
    const restoredA = await db.selectFrom("entities").selectAll().where("id", "=", "a").executeTakeFirstOrThrow();
    expect(restoredA.name).toBe("Alpha Tool");
    expect(parseAliasesString(restoredA.aliases)).toEqual([]);
    const stillMerged = await db.selectFrom("entities").selectAll().where("id", "=", "d").executeTakeFirstOrThrow();
    expect(stillMerged.deleted_at).not.toBeNull();
    expect(stillMerged.merged_into_entity_id).toBe("e");
  });
});

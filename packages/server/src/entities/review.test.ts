/**
 * Route-level tests for /api/entity-review.
 *
 * Resolve-logic coverage lives in resolve.test.ts; this file focuses on
 * what only the HTTP layer can express: owner-scope enforcement,
 * auth-before-mutation on GET /:id, multi-user-evidence admin escalation,
 * and the entity-review route mount point.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { normalizeName } from "../connectors/name-normalize";
import { createEntityReviewRepo } from "../db/repositories/entity-review";
import { createSettingsRepository } from "../db/repositories/settings";
import { createTaskRepository } from "../db/repositories/tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "testpassword123";
const OWNER_EMAIL = "owner@test.com";
const ADMIN_EMAIL = "admin@test.com";
const OTHER_EMAIL = "other@test.com";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db, ENCRYPTION_KEY);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "admin",
  });
  await users.create({
    name: "owner",
    email: OWNER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await users.create({
    name: "other",
    email: OTHER_EMAIL,
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

async function userIdByEmail(db: Kysely<DB>, email: string): Promise<string> {
  const row = await db.selectFrom("users").select(["id"]).where("email", "=", email).executeTakeFirstOrThrow();
  return row.id;
}

async function seedConnectorConfig(db: Kysely<DB>, id: string, createdBy: string) {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "fireflies",
      auth_type: "api_key",
      credentials: JSON.stringify({ type: "api_key", apiKey: "x" }),
      created_by: createdBy,
      scope_config: JSON.stringify({}),
    })
    .execute();
}

async function seedIndexedFile(db: Kysely<DB>, id: string, configId: string) {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: configId,
      provider_file_id: `p-${id}`,
      file_name: `${id}.md`,
      file_type: "meeting_transcript",
      content_category: "document",
      source: "fireflies",
      source_path: null,
      provider_url: null,
      content: null,
      summary: null,
      context_note: null,
      access_scope_id: null,
      content_hash: null,
      source_updated_at: null,
      source_created_at: null,
      synced_at: new Date().toISOString(),
      embedding_status: "pending",
    })
    .execute();
}

async function seedPendingRow(
  db: Kysely<DB>,
  opts: { triggeredBy: string; evidenceFileIds: string[]; lastSeenAt?: string },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: "Simran Suri Neeli",
      normalized_name: `simran suri neeli ${id}`, // unique to avoid UNIQUE constraint across tests
      entity_type: "person",
      candidate_entity_id: null,
      candidate_score: null,
      candidate_reason: "token-superset",
      candidate_generated_at: now,
      first_seen_at: now,
      last_seen_at: opts.lastSeenAt ?? now,
      occurrence_count: 1,
      status: "pending",
      triggered_by_user_id: opts.triggeredBy,
    })
    .execute();
  for (const fid of opts.evidenceFileIds) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: id,
        indexed_file_id: fid,
        source: "fireflies",
        note: null,
        seen_at: now,
      })
      .execute();
  }
  return id;
}

async function seedReviewRow(
  db: Kysely<DB>,
  opts: {
    proposedName: string;
    entityType: string;
    triggeredBy: string;
    evidenceFileIds?: string[];
    source?: string | null;
    sourceId?: string | null;
    seedSource?: string | null;
    seedSourceId?: string | null;
    candidateReason?: string | null;
    candidateEntityId?: string | null;
    occurrenceCount?: number;
  },
): Promise<{ id: string; candidateGeneratedAt: string }> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: opts.proposedName,
      normalized_name: normalizeName(opts.proposedName),
      entity_type: opts.entityType,
      source: opts.source ?? null,
      source_id: opts.sourceId ?? null,
      seed_source: opts.seedSource ?? null,
      seed_source_id: opts.seedSourceId ?? null,
      candidate_entity_id: opts.candidateEntityId ?? null,
      candidate_score: opts.candidateEntityId ? 1 : null,
      candidate_reason: opts.candidateReason ?? null,
      candidate_generated_at: now,
      first_seen_at: now,
      last_seen_at: now,
      occurrence_count: opts.occurrenceCount ?? 1,
      status: "pending",
      triggered_by_user_id: opts.triggeredBy,
    })
    .execute();
  for (const fileId of opts.evidenceFileIds ?? []) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: id,
        indexed_file_id: fileId,
        source: opts.source ?? "fireflies",
        note: null,
        seen_at: now,
      })
      .execute();
  }
  return { id, candidateGeneratedAt: now };
}

async function seedEntity(
  db: Kysely<DB>,
  opts: { name: string; sourceType: string; id?: string; status?: string },
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name: opts.name,
      source_type: opts.sourceType,
      subtype: "external",
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: opts.status ?? "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function seedStructuralTask(
  db: Kysely<DB>,
  opts: {
    sourceTaskId: string;
    fileId: string;
    assigneeEntityId: string | null;
    parentEntityId: string | null;
    parentName: string | null;
    parentSourceRef?: string | null;
  },
): Promise<string> {
  const repo = createTaskRepository(db);
  const result = await repo.upsertTask({
    parentEntityId: opts.parentEntityId,
    parentSourceRef: opts.parentSourceRef ?? null,
    parentName: opts.parentName,
    source: "linear",
    externalRef: opts.sourceTaskId,
    title: opts.sourceTaskId,
    status: "open",
    statusRaw: "open",
    statusAuthority: "external",
    assigneeEntityId: opts.assigneeEntityId,
    priority: null,
    dueAt: null,
    provenance: "structural",
    sourceTaskId: opts.sourceTaskId,
  });
  await repo.upsertEvidence(result.taskId, "file", opts.fileId);
  return result.taskId;
}

async function structuralContributesToRows(db: Kysely<DB>) {
  return db
    .selectFrom("entity_relationships")
    .selectAll()
    .where("relationship_type", "=", "contributes_to")
    .where("source", "=", "structural_assignee")
    .orderBy("source_entity_id")
    .execute();
}

async function structuralContributesToEvidenceNotes(db: Kysely<DB>, relationshipId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("entity_relationship_evidence")
    .select("note")
    .where("relationship_id", "=", relationshipId)
    .orderBy("note")
    .execute();
  return rows.map((row) => row.note ?? "");
}

describe("entity-review routes — mounting", () => {
  it("returns 200 for the Files review route", async () => {
    const db = await createTestDb();
    try {
      await seedUsers(db);
      const app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
        logger: createTestLogger(),
      });
      const cookie = await login(app, OWNER_EMAIL);
      const res = await app.request("/api/entity-review", { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
    } finally {
      await db.destroy();
    }
  });
});

describe("entity-review routes — owner-scope & auth-before-mutation", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;
  let otherCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    ownerId = await userIdByEmail(db, OWNER_EMAIL);
    otherId = await userIdByEmail(db, OTHER_EMAIL);
    await seedConnectorConfig(db, "config-owner", ownerId);
    await seedConnectorConfig(db, "config-other", otherId);
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
    });
    ownerCookie = await login(app, OWNER_EMAIL);
    otherCookie = await login(app, OTHER_EMAIL);
    adminCookie = await login(app, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("non-owner GET /:id returns 403 and does NOT flip review_started_at", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });

    const res = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: otherCookie } });
    expect(res.status).toBe(403);

    // Critical regression guard: row state untouched.
    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(after.review_started_at).toBeNull();
    expect(after.review_started_by).toBeNull();
  });

  it("owner GET /:id sets review_started_at", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });

    const res = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);

    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(after.review_started_at).not.toBeNull();
    expect(after.review_started_by).toBe(ownerId);
  });

  it("multi-user-evidence row is admin-only, even for the original triggered_by owner", async () => {
    // Evidence spans both owner's connector and other's connector.
    await seedIndexedFile(db, "file-mine", "config-owner");
    await seedIndexedFile(db, "file-theirs", "config-other");
    const reviewId = await seedPendingRow(db, {
      triggeredBy: ownerId,
      evidenceFileIds: ["file-mine", "file-theirs"],
    });

    // Owner is blocked because the row spans other users.
    const ownerRes = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: ownerCookie } });
    expect(ownerRes.status).toBe(403);

    // Admin can read it.
    const adminRes = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: adminCookie } });
    expect(adminRes.status).toBe(200);
  });

  it("POST confirm 400 without candidateGeneratedAt", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });

    const res = await app.request(`/api/entity-review/${reviewId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST confirm 403 for non-owner", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });
    const row = await db
      .selectFrom("entity_review_queue")
      .select(["candidate_generated_at"])
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();

    const res = await app.request(`/api/entity-review/${reviewId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ candidateGeneratedAt: row.candidate_generated_at }),
    });
    expect(res.status).toBe(403);

    // Row unchanged.
    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", reviewId)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("pending");
  });

  it("non-admin list hides rows whose evidence spans other users", async () => {
    await seedIndexedFile(db, "file-mine", "config-owner");
    await seedIndexedFile(db, "file-theirs", "config-other");
    // Single-owner row — should be visible.
    const okId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-mine"] });
    // Multi-owner row — should be hidden.
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-mine", "file-theirs"] });

    const res = await app.request("/api/entity-review", { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }>; total: number };
    expect(body.rows.map((r) => r.id)).toEqual([okId]);
    // total must match visible rows for the non-admin owner (not the raw pending count).
    expect(body.total).toBe(1);
  });

  it("non-admin list applies owner visibility before count and pagination", async () => {
    await seedIndexedFile(db, "file-mine", "config-owner");
    await seedIndexedFile(db, "file-theirs", "config-other");

    for (let i = 0; i < 201; i++) {
      await seedPendingRow(db, {
        triggeredBy: ownerId,
        evidenceFileIds: ["file-mine", "file-theirs"],
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const visibleId = await seedPendingRow(db, {
      triggeredBy: ownerId,
      evidenceFileIds: ["file-mine"],
      lastSeenAt: "2025-01-01T00:00:00.000Z",
    });

    const res = await app.request("/api/entity-review?limit=1", { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.rows.map((r) => r.id)).toEqual([visibleId]);
  });

  it("403 carries code=OWNER_SCOPE_DENIED in body", async () => {
    await seedIndexedFile(db, "file-1", "config-owner");
    const reviewId = await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-1"] });
    const res = await app.request(`/api/entity-review/${reviewId}`, { headers: { Cookie: otherCookie } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("OWNER_SCOPE_DENIED");
  });
});

describe("entity-review routes — list endpoint shape", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let ownerCookie: string;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    ownerId = await userIdByEmail(db, OWNER_EMAIL);
    await seedConnectorConfig(db, "config-owner", ownerId);
    const otherId = await userIdByEmail(db, OTHER_EMAIL);
    await seedConnectorConfig(db, "config-other", otherId);
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
    });
    ownerCookie = await login(app, OWNER_EMAIL);
    adminCookie = await login(app, ADMIN_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("includes total and per-row evidenceCount + sourceBreakdown", async () => {
    await seedIndexedFile(db, "f1", "config-owner");
    await seedIndexedFile(db, "f2", "config-owner");
    await seedIndexedFile(db, "f3", "config-owner");
    // Row 1: 2 evidence rows across 1 source.
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["f1", "f2"] });
    // Row 2: 1 evidence row.
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["f3"] });

    const res = await app.request("/api/entity-review", { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; evidenceCount: number; sourceBreakdown: Array<{ source: string; count: number }> }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    // Sum of evidenceCount across rows should equal 3.
    const totalEvidence = body.rows.reduce((acc, r) => acc + r.evidenceCount, 0);
    expect(totalEvidence).toBe(3);
    // Each row's sourceBreakdown should sum to its evidenceCount.
    for (const row of body.rows) {
      const sum = row.sourceBreakdown.reduce((acc, s) => acc + s.count, 0);
      expect(sum).toBe(row.evidenceCount);
    }
  });

  it("?limit=0 short-circuits to { rows: [], total }", async () => {
    await seedIndexedFile(db, "f1", "config-owner");
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["f1"] });
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["f1"] });

    const res = await app.request("/api/entity-review?limit=0", { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(2);
  });

  it("admin total counts all pending rows including multi-user-evidence", async () => {
    await seedIndexedFile(db, "file-mine", "config-owner");
    await seedIndexedFile(db, "file-theirs", "config-other");
    // Single-owner row.
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-mine"] });
    // Multi-owner row.
    await seedPendingRow(db, { triggeredBy: ownerId, evidenceFileIds: ["file-mine", "file-theirs"] });

    const res = await app.request("/api/entity-review", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
  });
});

describe("entity-review routes — types filter", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let adminCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    ownerId = await userIdByEmail(db, OWNER_EMAIL);
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
    });
    adminCookie = await login(app, ADMIN_EMAIL);
    // One row per type: two spine types (product, team) plus a non-spine
    // person row that must never leak through a spine-scoped filter.
    await seedReviewRow(db, { proposedName: "Canvas Copilot", entityType: "product", triggeredBy: ownerId });
    await seedReviewRow(db, { proposedName: "Platform Team", entityType: "team", triggeredBy: ownerId });
    await seedReviewRow(db, { proposedName: "Simran Suri", entityType: "person", triggeredBy: ownerId });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("?types=product filters to product rows with a matching total", async () => {
    const res = await app.request("/api/entity-review?types=product", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ entity_type: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.rows.map((r) => r.entity_type)).toEqual(["product"]);
  });

  it("filters by any entity type (not just the spine) and ignores unknown tokens", async () => {
    // `person` is non-spine — the filter is generic, so it must work; `bogus`
    // matches no rows and must not error or leak.
    const res = await app.request("/api/entity-review?types=person,bogus", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ entity_type: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.rows.map((r) => r.entity_type)).toEqual(["person"]);
  });

  it("no types param leaves results unfiltered (regression guard)", async () => {
    const res = await app.request("/api/entity-review", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ entity_type: string }>; total: number };
    expect(body.total).toBe(3);
    expect(new Set(body.rows.map((r) => r.entity_type))).toEqual(new Set(["product", "team", "person"]));
  });
});

describe("entity-review A4 backend", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    ownerId = await userIdByEmail(db, OWNER_EMAIL);
    otherId = await userIdByEmail(db, OTHER_EMAIL);
    await seedConnectorConfig(db, "config-owner", ownerId);
    await seedConnectorConfig(db, "config-other", otherId);
    await seedIndexedFile(db, "a4-owner-file", "config-owner");
    await seedIndexedFile(db, "a4-other-file", "config-other");
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
    });
    ownerCookie = await login(app, OWNER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("bulk confirm/reject creates and clears rows idempotently with isolated drift and owner failures", async () => {
    const okOne = await seedReviewRow(db, {
      proposedName: "A4 Project One",
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      source: "linear",
      sourceId: "project-one",
      candidateReason: "birth-gated",
    });
    const okTwo = await seedReviewRow(db, {
      proposedName: "A4 Project Two",
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      source: "linear",
      sourceId: "project-two",
      candidateReason: "birth-gated",
    });
    const stale = await seedReviewRow(db, {
      proposedName: "A4 Project Stale",
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      source: "linear",
      sourceId: "project-stale",
      candidateReason: "birth-gated",
    });
    const denied = await seedReviewRow(db, {
      proposedName: "A4 Project Denied",
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file", "a4-other-file"],
      source: "linear",
      sourceId: "project-denied",
      candidateReason: "birth-gated",
    });
    await createTaskRepository(db).upsertTask({
      parentEntityId: null,
      parentSourceRef: "linear:project-one",
      parentName: "A4 Project One",
      source: "linear",
      externalRef: null,
      title: "Task waiting for A4 Project One",
      status: "open",
      statusRaw: "open",
      statusAuthority: "external",
      assigneeEntityId: null,
      priority: null,
      dueAt: null,
      provenance: "structural",
      sourceTaskId: "task-a4-project-one",
    });

    const confirmRes = await app.request("/api/entity-review/confirm-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        items: [
          { reviewId: okOne.id, candidateGeneratedAt: okOne.candidateGeneratedAt },
          { reviewId: okTwo.id, candidateGeneratedAt: okTwo.candidateGeneratedAt },
          { reviewId: stale.id, candidateGeneratedAt: "2020-01-01T00:00:00.000Z" },
          { reviewId: denied.id, candidateGeneratedAt: denied.candidateGeneratedAt },
        ],
      }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmBody = (await confirmRes.json()) as {
      results: Array<{ reviewId: string; ok: boolean; targetEntityId?: string; error?: { code: string } }>;
    };
    expect(
      confirmBody.results
        .filter((result) => result.ok)
        .map((result) => result.reviewId)
        .sort(),
    ).toEqual([okOne.id, okTwo.id].sort());
    expect(confirmBody.results.find((result) => result.reviewId === stale.id)?.error?.code).toBe("CANDIDATE_DRIFT");
    expect(confirmBody.results.find((result) => result.reviewId === denied.id)?.error?.code).toBe("OWNER_SCOPE_DENIED");
    const createdProjectIds = confirmBody.results
      .filter((result) => result.ok)
      .map((result) => result.targetEntityId)
      .filter((id): id is string => !!id);
    const task = await db
      .selectFrom("tasks")
      .select(["parent_entity_id"])
      .where("source_task_id", "=", "task-a4-project-one")
      .executeTakeFirstOrThrow();
    expect(task.parent_entity_id).toBe(createdProjectIds[0]);

    const replayRes = await app.request("/api/entity-review/confirm-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        items: [
          { reviewId: okOne.id, candidateGeneratedAt: okOne.candidateGeneratedAt },
          { reviewId: okTwo.id, candidateGeneratedAt: okTwo.candidateGeneratedAt },
        ],
      }),
    });
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as { results: Array<{ ok: boolean; targetEntityId?: string }> };
    expect(replayBody.results.every((result) => result.ok)).toBe(true);
    expect(replayBody.results.map((result) => result.targetEntityId).sort()).toEqual(createdProjectIds.sort());
    const projectCount = await db
      .selectFrom("entities")
      .select(db.fn.countAll<number>().as("c"))
      .where("source_type", "=", "project")
      .executeTakeFirstOrThrow();
    expect(Number(projectCount.c)).toBe(2);

    const rejectOne = await seedReviewRow(db, {
      proposedName: "A4 Reject One",
      entityType: "person",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
    });
    const rejectTwo = await seedReviewRow(db, {
      proposedName: "A4 Reject Two",
      entityType: "person",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
    });
    const rejectDenied = await seedReviewRow(db, {
      proposedName: "A4 Reject Denied",
      entityType: "person",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file", "a4-other-file"],
    });
    const rejectRes = await app.request("/api/entity-review/reject-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        items: [
          { reviewId: rejectOne.id, candidateGeneratedAt: rejectOne.candidateGeneratedAt },
          { reviewId: rejectTwo.id, candidateGeneratedAt: rejectTwo.candidateGeneratedAt },
          { reviewId: rejectDenied.id, candidateGeneratedAt: rejectDenied.candidateGeneratedAt },
          { reviewId: stale.id, candidateGeneratedAt: "2020-01-01T00:00:00.000Z" },
        ],
      }),
    });
    expect(rejectRes.status).toBe(200);
    const rejectBody = (await rejectRes.json()) as {
      results: Array<{ reviewId: string; ok: boolean; error?: { code: string } }>;
    };
    expect(
      rejectBody.results
        .filter((result) => result.ok)
        .map((result) => result.reviewId)
        .sort(),
    ).toEqual([rejectOne.id, rejectTwo.id].sort());
    expect(rejectBody.results.find((result) => result.reviewId === rejectDenied.id)?.error?.code).toBe(
      "OWNER_SCOPE_DENIED",
    );
    expect(rejectBody.results.find((result) => result.reviewId === stale.id)?.error?.code).toBe("CANDIDATE_DRIFT");

    const rejectReplay = await app.request("/api/entity-review/reject-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        items: [
          { reviewId: rejectOne.id, candidateGeneratedAt: rejectOne.candidateGeneratedAt },
          { reviewId: rejectTwo.id, candidateGeneratedAt: rejectTwo.candidateGeneratedAt },
        ],
      }),
    });
    expect(rejectReplay.status).toBe(200);
    const rejectReplayBody = (await rejectReplay.json()) as { results: Array<{ ok: boolean }> };
    expect(rejectReplayBody.results.every((result) => result.ok)).toBe(true);
  });

  it("batch confirm backfills structural assignee contributes_to for confirmed project tasks", async () => {
    const projectName = "A4 Batch Backfill Project";
    const personId = await seedEntity(db, { name: "A4 Batch Person", sourceType: "person" });
    const projectId = await seedEntity(db, { name: projectName, sourceType: "project" });
    const review = await seedReviewRow(db, {
      proposedName: projectName,
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      candidateEntityId: projectId,
    });
    const anchoredTaskId = await seedStructuralTask(db, {
      sourceTaskId: "a4-batch-anchored-task",
      fileId: "a4-owner-file",
      assigneeEntityId: personId,
      parentEntityId: projectId,
      parentName: projectName,
    });
    const reanchoredTaskId = await seedStructuralTask(db, {
      sourceTaskId: "a4-batch-reanchored-task",
      fileId: "a4-owner-file",
      assigneeEntityId: personId,
      parentEntityId: null,
      parentName: projectName,
    });

    const res = await app.request("/api/entity-review/confirm-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        items: [{ reviewId: review.id, candidateGeneratedAt: review.candidateGeneratedAt }],
      }),
    });
    expect(res.status).toBe(200);

    const relationships = await structuralContributesToRows(db);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      source_entity_id: personId,
      target_entity_id: projectId,
      confidence: "INFERRED",
      confidence_score: 0.9,
      source: "structural_assignee",
    });
    await expect(structuralContributesToEvidenceNotes(db, relationships[0].id)).resolves.toEqual(
      [`structural_assignee:task:${anchoredTaskId}`, `structural_assignee:task:${reanchoredTaskId}`].sort(),
    );
    const reanchoredTask = await db
      .selectFrom("tasks")
      .select("parent_entity_id")
      .where("id", "=", reanchoredTaskId)
      .executeTakeFirstOrThrow();
    expect(reanchoredTask.parent_entity_id).toBe(projectId);
  });

  it("single confirm backfills structural assignee contributes_to for confirmed project tasks", async () => {
    const projectName = "A4 Single Backfill Project";
    const personId = await seedEntity(db, { name: "A4 Single Person", sourceType: "person" });
    const review = await seedReviewRow(db, {
      proposedName: projectName,
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      source: "linear",
      sourceId: "a4-single-backfill-project",
      candidateReason: "birth-gated",
    });
    const taskId = await seedStructuralTask(db, {
      sourceTaskId: "a4-single-reanchored-task",
      fileId: "a4-owner-file",
      assigneeEntityId: personId,
      parentEntityId: null,
      parentName: projectName,
      parentSourceRef: "linear:a4-single-backfill-project",
    });

    const res = await app.request(`/api/entity-review/${review.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ candidateGeneratedAt: review.candidateGeneratedAt }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targetEntityId: string };

    const relationships = await structuralContributesToRows(db);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      source_entity_id: personId,
      target_entity_id: body.targetEntityId,
      confidence: "INFERRED",
      confidence_score: 0.9,
      source: "structural_assignee",
    });
    await expect(structuralContributesToEvidenceNotes(db, relationships[0].id)).resolves.toEqual([
      `structural_assignee:task:${taskId}`,
    ]);
    const task = await db
      .selectFrom("tasks")
      .select("parent_entity_id")
      .where("id", "=", taskId)
      .executeTakeFirstOrThrow();
    expect(task.parent_entity_id).toBe(body.targetEntityId);
  });

  it("reclassify changes type, merges compatible collisions, and refuses incompatible source or seed refs", async () => {
    const product = await seedReviewRow(db, {
      proposedName: "A4 Solo Foo",
      entityType: "product",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      source: "linear",
      sourceId: "solo-foo",
      candidateReason: "birth-gated",
    });
    const reclassifyRes = await app.request(`/api/entity-review/${product.id}/reclassify-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ newEntityType: "project", candidateGeneratedAt: product.candidateGeneratedAt }),
    });
    expect(reclassifyRes.status).toBe(200);
    const reclassified = (await reclassifyRes.json()) as {
      row: { id: string; entity_type: string; candidate_generated_at: string };
    };
    expect(reclassified.row.id).toBe(product.id);
    expect(reclassified.row.entity_type).toBe("project");
    const confirmRes = await app.request(`/api/entity-review/${product.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ candidateGeneratedAt: reclassified.row.candidate_generated_at }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmed = (await confirmRes.json()) as { targetEntityId: string };
    const entity = await db
      .selectFrom("entities")
      .select(["source_type"])
      .where("id", "=", confirmed.targetEntityId)
      .executeTakeFirstOrThrow();
    expect(entity.source_type).toBe("project");

    const target = await seedReviewRow(db, {
      proposedName: "A4 Merge Foo",
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      occurrenceCount: 2,
    });
    const source = await seedReviewRow(db, {
      proposedName: "A4 Merge Foo",
      entityType: "product",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      source: "clickup",
      sourceId: "merge-foo",
      seedSource: "linear",
      seedSourceId: "seed-merge-foo",
      candidateReason: "birth-gated",
      occurrenceCount: 3,
    });
    const mergeRes = await app.request(`/api/entity-review/${source.id}/reclassify-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ newEntityType: "project", candidateGeneratedAt: source.candidateGeneratedAt }),
    });
    expect(mergeRes.status).toBe(200);
    const merged = (await mergeRes.json()) as { result: string; row: { id: string } };
    expect(merged.result).toBe("RECLASSIFY");
    expect(merged.row.id).toBe(target.id);
    await expect(
      db.selectFrom("entity_review_queue").select("id").where("id", "=", source.id).executeTakeFirst(),
    ).resolves.toBeUndefined();
    const targetAfter = await db
      .selectFrom("entity_review_queue")
      .select(["source", "source_id", "seed_source", "seed_source_id", "occurrence_count"])
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    expect(targetAfter).toMatchObject({
      source: "clickup",
      source_id: "merge-foo",
      seed_source: "linear",
      seed_source_id: "seed-merge-foo",
      occurrence_count: 5,
    });
    const evidenceCount = await db
      .selectFrom("entity_review_evidence")
      .select(db.fn.countAll<number>().as("c"))
      .where("review_id", "=", target.id)
      .executeTakeFirstOrThrow();
    expect(Number(evidenceCount.c)).toBe(2);

    const sourceConflictProduct = await seedReviewRow(db, {
      proposedName: "A4 Source Conflict",
      entityType: "product",
      triggeredBy: ownerId,
      source: "linear",
      sourceId: "source-conflict-product",
    });
    const sourceConflictTarget = await seedReviewRow(db, {
      proposedName: "A4 Source Conflict",
      entityType: "project",
      triggeredBy: ownerId,
      source: "linear",
      sourceId: "source-conflict-project",
    });
    const sourceConflictRes = await app.request(`/api/entity-review/${sourceConflictProduct.id}/reclassify-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        newEntityType: "project",
        candidateGeneratedAt: sourceConflictProduct.candidateGeneratedAt,
      }),
    });
    expect(sourceConflictRes.status).toBe(200);
    const sourceConflict = (await sourceConflictRes.json()) as { result: string };
    expect(sourceConflict.result).toBe("TYPE_RECLASSIFY_COLLISION");

    const seedConflictProduct = await seedReviewRow(db, {
      proposedName: "A4 Seed Conflict",
      entityType: "product",
      triggeredBy: ownerId,
      seedSource: "linear",
      seedSourceId: "seed-conflict-product",
    });
    const seedConflictTarget = await seedReviewRow(db, {
      proposedName: "A4 Seed Conflict",
      entityType: "project",
      triggeredBy: ownerId,
      seedSource: "linear",
      seedSourceId: "seed-conflict-project",
    });
    const seedConflictRes = await app.request(`/api/entity-review/${seedConflictProduct.id}/reclassify-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        newEntityType: "project",
        candidateGeneratedAt: seedConflictProduct.candidateGeneratedAt,
      }),
    });
    expect(seedConflictRes.status).toBe(200);
    const seedConflict = (await seedConflictRes.json()) as { result: string };
    expect(seedConflict.result).toBe("TYPE_RECLASSIFY_COLLISION");
    const intactRows = await db
      .selectFrom("entity_review_queue")
      .select(["id"])
      .where("id", "in", [
        sourceConflictProduct.id,
        sourceConflictTarget.id,
        seedConflictProduct.id,
        seedConflictTarget.id,
      ])
      .execute();
    expect(intactRows.map((row) => row.id).sort()).toEqual(
      [sourceConflictProduct.id, sourceConflictTarget.id, seedConflictProduct.id, seedConflictTarget.id].sort(),
    );

    const invalidTypeRes = await app.request(`/api/entity-review/${target.id}/reclassify-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ newEntityType: "tool", candidateGeneratedAt: target.candidateGeneratedAt }),
    });
    expect(invalidTypeRes.status).toBe(400);
  });

  it("separates tracker and inferred bulk accept paths", async () => {
    const tracker = await seedReviewRow(db, {
      proposedName: "A4 Tracker Project",
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
      source: "linear",
      sourceId: "tracker-project",
      candidateReason: "birth-gated",
    });
    const inferred = await seedReviewRow(db, {
      proposedName: "A4 Inferred Project",
      entityType: "project",
      triggeredBy: ownerId,
      evidenceFileIds: ["a4-owner-file"],
    });

    const summaryRes = await app.request("/api/entity-review/summary", { headers: { Cookie: ownerCookie } });
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as {
      groups: Array<{ entityType: string; origin: string; count: number }>;
      total: number;
    };
    expect(summary.groups).toEqual(
      expect.arrayContaining([
        { entityType: "project", origin: "tracker", count: 1 },
        { entityType: "project", origin: "inferred", count: 1 },
      ]),
    );
    expect(summary.total).toBeGreaterThanOrEqual(2);

    const batchRes = await app.request("/api/entity-review/confirm-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({
        items: [
          { reviewId: tracker.id, candidateGeneratedAt: tracker.candidateGeneratedAt },
          { reviewId: inferred.id, candidateGeneratedAt: inferred.candidateGeneratedAt },
        ],
      }),
    });
    expect(batchRes.status).toBe(200);
    const batch = (await batchRes.json()) as {
      results: Array<{ reviewId: string; ok: boolean; error?: { code: string } }>;
    };
    expect(batch.results.find((result) => result.reviewId === tracker.id)?.ok).toBe(true);
    expect(batch.results.find((result) => result.reviewId === inferred.id)?.error?.code).toBe("CANDIDATE_MISSING");
  });
});

describe("entity-review routes — dismiss endpoint", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let otherCookie: string;
  let ownerCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    ownerId = await userIdByEmail(db, OWNER_EMAIL);
    await seedConnectorConfig(db, "config-owner", ownerId);
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
    });
    ownerCookie = await login(app, OWNER_EMAIL);
    otherCookie = await login(app, OTHER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("400 without candidateGeneratedAt, 403 for non-owner", async () => {
    const seed = await seedReviewRow(db, {
      proposedName: "Canvasx",
      entityType: "team",
      triggeredBy: ownerId,
      source: "clickup",
      sourceId: "clickup:team:canvasx",
      candidateReason: "birth-gated",
    });

    const badRes = await app.request(`/api/entity-review/${seed.id}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({}),
    });
    expect(badRes.status).toBe(400);

    const forbiddenRes = await app.request(`/api/entity-review/${seed.id}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: otherCookie },
      body: JSON.stringify({ candidateGeneratedAt: seed.candidateGeneratedAt }),
    });
    expect(forbiddenRes.status).toBe(403);

    const after = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", seed.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe("pending");
  });

  it("dismisses a birth row, creates no entity, and a later re-sync does not re-propose it", async () => {
    const seed = await seedReviewRow(db, {
      proposedName: "Canvasx",
      entityType: "team",
      triggeredBy: ownerId,
      source: "clickup",
      sourceId: "clickup:team:canvasx",
      candidateReason: "birth-gated",
    });

    const res = await app.request(`/api/entity-review/${seed.id}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ownerCookie },
      body: JSON.stringify({ candidateGeneratedAt: seed.candidateGeneratedAt }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { row: { status: string }; idempotent: boolean };
    expect(body.row.status).toBe("dismissed");
    expect(body.idempotent).toBe(false);

    const entityCount = await db
      .selectFrom("entities")
      .select((eb) => eb.fn.countAll<number>().as("c"))
      .executeTakeFirstOrThrow();
    expect(Number(entityCount.c)).toBe(0);

    // A later sync re-proposes the same source key: it must stay dismissed.
    const repo = createEntityReviewRepo(db);
    const resync = await repo.upsertQueueRow({
      proposedName: "Canvasx",
      normalizedName: normalizeName("Canvasx"),
      entityType: "team",
      source: "clickup",
      sourceId: "clickup:team:canvasx",
      candidateEntityId: null,
      candidateScore: null,
      candidateReason: "birth-gated",
      triggeredByUserId: ownerId,
    });
    expect(resync.skipEvidence).toBe(true);

    const afterResync = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("id", "=", seed.id)
      .executeTakeFirstOrThrow();
    expect(afterResync.status).toBe("dismissed");

    const pending = await db
      .selectFrom("entity_review_queue")
      .select((eb) => eb.fn.countAll<number>().as("c"))
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    expect(Number(pending.c)).toBe(0);
  });
});

describe("entity-review routes — child tasks preview", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let ownerCookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    ownerId = await userIdByEmail(db, OWNER_EMAIL);
    await seedConnectorConfig(db, "config-owner", ownerId);
    app = createApp(db, createTestConfig({ ENCRYPTION_KEY }), {
      logger: createTestLogger(),
    });
    ownerCookie = await login(app, OWNER_EMAIL);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedChildTask(fileId: string, parentSourceId: string, name: string, source = "linear") {
    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: "config-owner",
        provider_file_id: `pf-${fileId}`,
        file_name: name,
        file_type: "issue",
        content_category: "document",
        source,
        provider_url: `https://linear.app/${fileId}`,
        synced_at: new Date().toISOString(),
        source_updated_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("indexed_file_facts")
      .values({
        id: `fact-${fileId}`,
        indexed_file_id: fileId,
        source,
        fact_type: "parent_entity",
        relation: "mentioned",
        subject_source_id: parentSourceId,
        fact_key: `key-${fileId}`,
      })
      .execute();
  }

  it("returns child tasks for a structural-seed row, joined by parent source id", async () => {
    const seed = await seedReviewRow(db, {
      proposedName: "Sketch",
      entityType: "team",
      triggeredBy: ownerId,
      seedSource: "linear",
      seedSourceId: "team-1",
    });
    await seedChildTask("task-1", "team-1", "SKE-1: First");
    await seedChildTask("task-2", "team-1", "SKE-2: Second");

    const res = await app.request(`/api/entity-review/${seed.id}`, { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      childTaskCount: number;
      childTasks: Array<{ name: string; providerUrl: string | null }>;
    };
    expect(body.childTaskCount).toBe(2);
    expect(body.childTasks.map((t) => t.name).sort()).toEqual(["SKE-1: First", "SKE-2: Second"]);
    expect(body.childTasks.every((t) => t.providerUrl?.includes("linear.app"))).toBe(true);
  });

  it("omits child tasks for a non-seed (LLM) row", async () => {
    const seed = await seedReviewRow(db, {
      proposedName: "Acme Co",
      entityType: "company",
      triggeredBy: ownerId,
      source: "fireflies",
      sourceId: "fireflies:company:acme",
      candidateReason: "birth-gated",
    });
    // A parent_entity fact keyed on the same string must not be reachable for an LLM row.
    await seedChildTask("task-3", "fireflies:company:acme", "Should not appear");

    const res = await app.request(`/api/entity-review/${seed.id}`, { headers: { Cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { childTasks?: unknown; childTaskCount?: unknown };
    expect(body.childTasks).toBeUndefined();
    expect(body.childTaskCount).toBeUndefined();
  });
});

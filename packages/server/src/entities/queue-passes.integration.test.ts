import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import { duplicateDrainStateRowId } from "./duplicate-drain";
import { applyProjection } from "./queue-projection";
import { liveEntitiesForNames, loadQueueRows } from "./queue-reconcile";
import { startQueueDrainSequence } from "./queue-run";
import { structuralPass, withAttendeeFactChunkSizeForTest } from "./queue-structural";

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

async function runPasses(h: Harness): Promise<Record<string, unknown>> {
  const res = await h.app.request("/api/graph-passes/queue-runs", {
    method: "POST",
    headers: { Cookie: h.cookie },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { run: { status: string; inputSnapshot: Record<string, unknown> } };
  expect(body.run.status).toBe("complete");
  return body.run.inputSnapshot;
}

async function seedEntity(
  db: Kysely<DB>,
  params: {
    name: string;
    type?: string;
    createdAt?: string;
    metadata?: Record<string, unknown>;
    deletedAt?: string | null;
    mergedInto?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
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
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      deleted_at: params.deletedAt ?? null,
      merged_into_entity_id: params.mergedInto ?? null,
    })
    .execute();
  return id;
}

async function seedQueueRow(
  db: Kysely<DB>,
  ownerId: string,
  params: {
    name: string;
    type?: string;
    source?: string | null;
    candidateEntityId?: string | null;
    candidateEntityIds?: string[] | null;
    candidateUserIds?: string[] | null;
    candidateScore?: number | null;
    proposedEmail?: string | null;
    status?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: params.name,
      normalized_name: params.name.trim().toLowerCase(),
      entity_type: params.type ?? "person",
      source: params.source ?? null,
      source_id: params.source ? `${params.source}-${id}` : null,
      proposed_email: params.proposedEmail ?? null,
      candidate_entity_id: params.candidateEntityId ?? null,
      candidate_entity_ids: params.candidateEntityIds ? JSON.stringify(params.candidateEntityIds) : null,
      candidate_user_ids: params.candidateUserIds ? JSON.stringify(params.candidateUserIds) : null,
      candidate_score: params.candidateScore ?? null,
      candidate_generated_at: params.candidateEntityId ? "2020-01-01T00:00:00.000Z" : null,
      status: params.status ?? "pending",
      triggered_by_user_id: ownerId,
    })
    .execute();
  return id;
}

async function readRow(db: Kysely<DB>, id: string) {
  return db.selectFrom("entity_review_queue").selectAll().where("id", "=", id).executeTakeFirst();
}

async function seedConnector(db: Kysely<DB>, ownerId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "gmail",
      auth_type: "system",
      credentials: JSON.stringify({ type: "system" }),
      created_by: ownerId,
      scope_config: "{}",
      sync_status: "active",
    })
    .execute();
  return id;
}

async function seedIndexedFiles(db: Kysely<DB>, ownerId: string, prefix: string, count: number): Promise<string[]> {
  const connectorId = await seedConnector(db, ownerId);
  const now = new Date().toISOString();
  const fileIds = Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
  await db
    .insertInto("indexed_files")
    .values(
      fileIds.map((id, index) => ({
        id,
        connector_config_id: connectorId,
        provider_file_id: `${prefix}-${index + 1}-${id}`,
        file_name: `${prefix}-${index + 1}.eml`,
        content_category: "document",
        source: "gmail",
        synced_at: now,
      })),
    )
    .execute();
  return fileIds;
}

async function seedReviewEvidence(db: Kysely<DB>, reviewId: string, fileIds: string[]): Promise<void> {
  await db
    .insertInto("entity_review_evidence")
    .values(
      fileIds.map((fileId) => ({ id: randomUUID(), review_id: reviewId, indexed_file_id: fileId, source: "gmail" })),
    )
    .execute();
}

async function seedAttendeeFact(
  db: Kysely<DB>,
  fileId: string,
  params: { email: string; normalizedName: string },
): Promise<void> {
  const id = randomUUID();
  await db
    .insertInto("indexed_file_facts")
    .values({
      id,
      indexed_file_id: fileId,
      source: "gmail",
      fact_type: "attendee",
      relation: "attendee",
      subject_email: params.email,
      normalized_subject_name: params.normalizedName,
      fact_key: `${fileId}:attendee:${id}`,
    })
    .execute();
}

async function seedMention(db: Kysely<DB>, entityId: string, fileId: string): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      indexed_file_id: fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

async function queueState(db: Kysely<DB>, ids: string[]) {
  return db
    .selectFrom("entity_review_queue")
    .select(["id", "status", "pass_reason", "candidate_entity_id"])
    .where("id", "in", ids)
    .orderBy("id")
    .execute();
}

async function mergeCount(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom("entity_merges")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/**
 * Aliases are not a table — they live in `entities.aliases`, so `selectAll` on
 * entities already carries them.
 */
async function graphFingerprint(db: Kysely<DB>): Promise<string> {
  const entities = await db.selectFrom("entities").selectAll().orderBy("id").execute();
  const mentions = await db.selectFrom("entity_mentions").selectAll().orderBy("id").execute();
  const relationships = await db.selectFrom("entity_relationships").selectAll().orderBy("id").execute();
  return JSON.stringify({ entities, mentions, relationships });
}

describe("queue graph passes", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.db.destroy();
  });

  it("T1 defers on the register only when the type matches, and writes nothing to the graph", async () => {
    const rowId = await seedQueueRow(h.db, h.ownerId, { name: "Nadia Rahman", type: "person" });
    await seedEntity(h.db, { name: "Nadia Rahman", type: "company" });

    const before = await graphFingerprint(h.db);
    await runPasses(h);

    const sameTypeAbsent = await readRow(h.db, rowId);
    expect(sameTypeAbsent?.status).toBe("pending");
    expect(sameTypeAbsent?.pass_reason).toBeNull();
    expect(await graphFingerprint(h.db)).toBe(before);

    await seedEntity(h.db, { name: "Nadia Rahman", type: "person" });
    const beforeSecond = await graphFingerprint(h.db);
    await runPasses(h);

    const deferred = await readRow(h.db, rowId);
    expect(deferred?.status).toBe("deferred");
    expect(deferred?.pass_reason).toBe("name_already_resolved");
    expect(await graphFingerprint(h.db)).toBe(beforeSecond);
  });

  it("T2 re-points a superseded candidate and never touches identity-link rows", async () => {
    const candidate = await seedEntity(h.db, { name: "N. Rahman" });
    const supersedes = await seedEntity(h.db, { name: "Nadia Rahman" });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Nadia Rahman",
      candidateEntityId: candidate,
      candidateEntityIds: [candidate],
      candidateScore: 0.8,
    });

    const identityRows: string[] = [];
    for (const source of ["user_entity_link", "slack_user"]) {
      const other = await seedEntity(h.db, { name: `Other ${source}` });
      await seedEntity(h.db, { name: `Shadow ${source}` });
      identityRows.push(
        await seedQueueRow(h.db, h.ownerId, {
          name: `Shadow ${source}`,
          source,
          candidateEntityId: other,
          candidateScore: 0.5,
        }),
      );
    }
    const linkedCandidate = await seedEntity(h.db, { name: "Other linked" });
    await seedEntity(h.db, { name: "Shadow linked" });
    identityRows.push(
      await seedQueueRow(h.db, h.ownerId, {
        name: "Shadow linked",
        candidateEntityId: linkedCandidate,
        candidateUserIds: [h.ownerId],
        candidateScore: 0.5,
      }),
    );

    const nullSourceCandidate = await seedEntity(h.db, { name: "Older Priya" });
    const nullSourceLive = await seedEntity(h.db, { name: "Priya Menon" });
    const nullSourceRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Priya Menon",
      source: null,
      candidateEntityId: nullSourceCandidate,
      candidateScore: 0.4,
    });

    const identityBefore = await Promise.all(identityRows.map((id) => readRow(h.db, id)));
    await runPasses(h);

    const row = await readRow(h.db, rowId);
    expect(row?.status).toBe("deferred");
    expect(row?.pass_reason).toBe("name_already_resolved");
    expect(row?.candidate_entity_id).toBe(supersedes);
    expect(row?.candidate_entity_ids).toBeNull();
    expect(row?.candidate_score).toBeNull();
    expect(row?.candidate_generated_at).not.toBe("2020-01-01T00:00:00.000Z");

    const identityAfter = await Promise.all(identityRows.map((id) => readRow(h.db, id)));
    expect(identityAfter).toEqual(identityBefore);

    const processed = await readRow(h.db, nullSourceRow);
    expect(processed?.candidate_entity_id).toBe(nullSourceLive);
    expect(processed?.pass_reason).toBe("name_already_resolved");
  });

  it("keeps a re-pointed row verdict stable across queue runs", async () => {
    const candidate = await seedEntity(h.db, { name: "N. Rahman" });
    const resolved = await seedEntity(h.db, { name: "Nadia Rahman" });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Nadia Rahman",
      candidateEntityId: candidate,
      candidateEntityIds: [candidate],
      candidateScore: 0.8,
    });

    await runPasses(h);
    const run1 = await readRow(h.db, rowId);
    await runPasses(h);
    const run2 = await readRow(h.db, rowId);

    expect(run1).toMatchObject({
      status: "deferred",
      pass_reason: "name_already_resolved",
      candidate_entity_id: resolved,
    });
    expect({
      status: run2?.status,
      pass_reason: run2?.pass_reason,
      candidate_entity_id: run2?.candidate_entity_id,
    }).toEqual({
      status: run1?.status,
      pass_reason: run1?.pass_reason,
      candidate_entity_id: run1?.candidate_entity_id,
    });
  });

  it("T3 leaves no stale candidate fields after the merge and delete repairs", async () => {
    const survivor = await seedEntity(h.db, { name: "Survivor Entity" });
    const merged = await seedEntity(h.db, { name: "Merged Entity", mergedInto: survivor });
    const mergedRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Merged Proposal",
      candidateEntityId: merged,
      candidateEntityIds: [merged, survivor],
      candidateScore: 0.9,
    });

    const gone = await seedEntity(h.db, { name: "Gone Entity", deletedAt: new Date().toISOString() });
    const goneRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Gone Proposal",
      candidateEntityId: gone,
      candidateEntityIds: [gone],
      candidateScore: 0.7,
    });

    await runPasses(h);

    const repointed = await readRow(h.db, mergedRow);
    expect(repointed?.candidate_entity_id).toBe(survivor);
    expect(repointed?.pass_reason).toBe("no_shared_file");
    expect(repointed?.candidate_score).toBeNull();
    expect(repointed?.candidate_entity_ids).toBeNull();
    expect(repointed?.candidate_generated_at).not.toBe("2020-01-01T00:00:00.000Z");

    const cleared = await readRow(h.db, goneRow);
    expect(cleared?.candidate_entity_id).toBeNull();
    expect(cleared?.candidate_score).toBeNull();
    expect(cleared?.candidate_entity_ids).toBeNull();
    expect(cleared?.candidate_generated_at).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("keeps a repaired merged-away row stable and does not auto-merge it", async () => {
    const survivor = await seedEntity(h.db, { name: "Survivor Entity" });
    const merged = await seedEntity(h.db, { name: "Merged Entity", mergedInto: survivor });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Merged Proposal",
      candidateEntityId: merged,
      candidateEntityIds: [merged, survivor],
      candidateScore: 0.9,
    });
    const [fileId] = await seedIndexedFiles(h.db, h.ownerId, "merged-stability", 1);
    await seedReviewEvidence(h.db, rowId, [fileId]);
    await seedMention(h.db, survivor, fileId);

    await runPasses(h);
    const run1 = await readRow(h.db, rowId);
    await runPasses(h);
    const run2 = await readRow(h.db, rowId);

    expect({
      status: run2?.status,
      pass_reason: run2?.pass_reason,
      candidate_entity_id: run2?.candidate_entity_id,
    }).toEqual({
      status: run1?.status,
      pass_reason: run1?.pass_reason,
      candidate_entity_id: run1?.candidate_entity_id,
    });
    expect(run1).toMatchObject({
      status: "pending",
      pass_reason: null,
      candidate_entity_id: survivor,
    });

    const mergesBeforeDrain = await mergeCount(h.db);
    const drain = await h.app.request("/api/graph-passes/duplicate-drain-runs", {
      method: "POST",
      headers: { Cookie: h.cookie },
    });
    expect(drain.status).toBe(201);
    expect(await mergeCount(h.db)).toBe(mergesBeforeDrain);
    const afterDrain = await readRow(h.db, rowId);
    expect(afterDrain?.status).toBe("pending");
    expect(afterDrain?.resolved_entity_id).toBeNull();
  });

  /**
   * Deferred rows stay live queue records, so later evidence accrual is preserved.
   */
  it("T4 keeps a deferred row accruing evidence and hands it back when the cause disappears", async () => {
    const rowId = await seedQueueRow(h.db, h.ownerId, { name: "Deferrable Person" });
    const entityId = await seedEntity(h.db, { name: "Deferrable Person" });

    await runPasses(h);
    const deferred = await readRow(h.db, rowId);
    expect(deferred?.status).toBe("deferred");
    expect(deferred?.pass_reason).toBe("name_already_resolved");

    await h.db
      .updateTable("entity_review_queue")
      .set({
        occurrence_count: (deferred?.occurrence_count ?? 0) + 1,
        last_seen_at: new Date(Date.now() + 1000).toISOString(),
      })
      .where("id", "=", rowId)
      .execute();

    const accrued = await readRow(h.db, rowId);
    expect(accrued?.occurrence_count).toBeGreaterThan(deferred?.occurrence_count ?? 0);
    expect(accrued?.status).toBe("deferred");

    await h.db
      .updateTable("entities")
      .set({ deleted_at: new Date().toISOString() })
      .where("id", "=", entityId)
      .execute();

    await runPasses(h);
    const handedBack = await readRow(h.db, rowId);
    expect(handedBack?.status).toBe("pending");
    expect(handedBack?.pass_reason).toBeNull();
  });

  it("T6 lets a veto outrank a block and reads the proposal's own email", async () => {
    const candidate = await seedEntity(h.db, { name: "Sam Cole", metadata: { email: "sam.cole@acme.test" } });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Samuel Cole",
      candidateEntityId: candidate,
    });

    await runPasses(h);
    const blocked = await readRow(h.db, rowId);
    expect(blocked?.pass_reason).toBe("no_shared_file");

    await h.db
      .updateTable("entity_review_queue")
      .set({ proposed_email: "samuel.cole@other.test" })
      .where("id", "=", rowId)
      .execute();

    await runPasses(h);
    const vetoed = await readRow(h.db, rowId);
    expect(vetoed?.status).toBe("deferred");
    expect(vetoed?.pass_reason).toBe("different_emails");
  });

  it("T7 unions emails across all three stores and compares them normalised", async () => {
    const metadataOnly = await seedEntity(h.db, { name: "Meta One", metadata: { email: "one@a.test" } });
    const metadataRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Meta Proposal",
      candidateEntityId: metadataOnly,
      proposedEmail: "two@b.test",
    });

    const contactOnly = await seedEntity(h.db, { name: "Contact One" });
    await h.db
      .insertInto("entity_contact_points")
      .values({
        id: randomUUID(),
        entity_id: contactOnly,
        kind: "email",
        value: "contact@a.test",
        source: "test",
      })
      .execute();
    const contactRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Contact Proposal",
      candidateEntityId: contactOnly,
      proposedEmail: "different@b.test",
    });

    const bothStores = await seedEntity(h.db, { name: "Both Stores", metadata: { email: "shared@a.test" } });
    await h.db
      .insertInto("entity_contact_points")
      .values({
        id: randomUUID(),
        entity_id: bothStores,
        kind: "email",
        value: "second@a.test",
        source: "test",
      })
      .execute();
    const overlappingRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Both Proposal",
      candidateEntityId: bothStores,
      proposedEmail: "second@a.test",
    });

    const caseOnly = await seedEntity(h.db, { name: "Case One", metadata: { email: "Case.One@A.TEST" } });
    const caseRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Case Proposal",
      candidateEntityId: caseOnly,
      proposedEmail: "  case.one@a.test ",
    });

    await runPasses(h);

    expect((await readRow(h.db, metadataRow))?.pass_reason).toBe("different_emails");
    expect((await readRow(h.db, contactRow))?.pass_reason).toBe("different_emails");
    expect((await readRow(h.db, overlappingRow))?.pass_reason).toBe("no_shared_file");
    expect((await readRow(h.db, caseRow))?.pass_reason).toBe("no_shared_file");
  });

  /**
   * The split the whole feature turns on. A veto answers the row and hides it; a
   * block does not answer it and must stay in front of a person. Asserted
   * through the list endpoint rather than the column because visibility is the
   * property that matters, and a row already deferred by an earlier run has to
   * come back on its own.
   */
  it("T10 hides a vetoed row and keeps a blocked one in the pending list", async () => {
    const vetoCandidate = await seedEntity(h.db, {
      name: "Veto Candidate",
      metadata: { email: "veto.candidate@acme.test" },
    });
    const vetoRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Veto Proposal",
      candidateEntityId: vetoCandidate,
      proposedEmail: "veto.proposal@other.test",
    });

    const blockCandidate = await seedEntity(h.db, { name: "Block Candidate" });
    const blockRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Block Proposal",
      candidateEntityId: blockCandidate,
    });
    await h.db
      .updateTable("entity_review_queue")
      .set({ status: "deferred", pass_reason: "no_shared_file" })
      .where("id", "=", blockRow)
      .execute();

    await runPasses(h);

    const pending = (await (
      await h.app.request("/api/entity-review?limit=200", { headers: { Cookie: h.cookie } })
    ).json()) as {
      rows: { id: string }[];
    };
    const pendingIds = pending.rows.map((row) => row.id);
    expect(pendingIds).toContain(blockRow);
    expect(pendingIds).not.toContain(vetoRow);

    const deferred = (await (
      await h.app.request("/api/entity-review?limit=200&status=deferred", { headers: { Cookie: h.cookie } })
    ).json()) as { rows: { id: string }[] };
    const deferredIds = deferred.rows.map((row) => row.id);
    expect(deferredIds).toContain(vetoRow);
    expect(deferredIds).not.toContain(blockRow);

    expect((await readRow(h.db, blockRow))?.pass_reason).toBe("no_shared_file");
    expect((await readRow(h.db, vetoRow))?.pass_reason).toBe("different_emails");
  });

  it("F1 the register wins when the proposal's name resolves to the candidate", async () => {
    const candidate = await seedEntity(h.db, { name: "Admin", metadata: { email: "admin@one.test" } });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Admin",
      candidateEntityId: candidate,
      proposedEmail: "admin@two.test",
    });

    await runPasses(h);

    const row = await readRow(h.db, rowId);
    expect(row?.status).toBe("deferred");
    expect(row?.pass_reason).toBe("name_already_resolved");
  });

  /**
   * This calls `structuralPass` directly because on this shape phase A writes a
   * priority-1 reason that the projection keeps, so no API-observable assertion
   * can tell a kept fold from a deleted one.
   */
  it("F2 a different same-name entity still contributes its emails", async () => {
    await seedEntity(h.db, {
      name: "Anita Nayar",
      createdAt: "2020-01-01T00:00:00.000Z",
      metadata: { email: "anita@one.test" },
    });
    const candidate = await seedEntity(h.db, {
      name: "A. Nayar",
      createdAt: "2020-01-02T00:00:00.000Z",
      metadata: { email: "nayar@two.test" },
    });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Anita Nayar",
      candidateEntityId: candidate,
    });

    const rows = await loadQueueRows(h.db);
    const byName = await liveEntitiesForNames(h.db, rows);
    const result = await structuralPass(h.db, rows, byName);

    expect(result.hits).toEqual(expect.arrayContaining([{ rowId, reason: "different_emails" }]));
  });

  it("F3 an empty side still means no veto", async () => {
    const candidate = await seedEntity(h.db, { name: "Benjamin" });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Benjamin",
      candidateEntityId: candidate,
      proposedEmail: "benjamin@one.test",
    });

    await runPasses(h);

    const row = await readRow(h.db, rowId);
    expect(row?.pass_reason).not.toBe("different_emails");
  });

  it("F4 a shared name alone does not prove two participants", async () => {
    const candidate = await seedEntity(h.db, { name: "Rajesh Chaudhary" });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Rajesh Chaudhary",
      candidateEntityId: candidate,
    });

    const connectorId = "gmail-shared-name-facts";
    await h.db
      .insertInto("connector_configs")
      .values({
        id: connectorId,
        connector_type: "gmail",
        auth_type: "system",
        credentials: JSON.stringify({ type: "system" }),
        created_by: h.ownerId,
        scope_config: "{}",
        sync_status: "active",
      })
      .execute();
    const fileId = randomUUID();
    await h.db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: connectorId,
        provider_file_id: "msg-shared-name",
        file_name: "msg-shared-name.eml",
        content_category: "document",
        source: "gmail",
        synced_at: new Date().toISOString(),
      })
      .execute();

    await h.db
      .insertInto("entity_review_evidence")
      .values({ id: randomUUID(), review_id: rowId, indexed_file_id: fileId, source: "gmail" })
      .execute();
    await h.db
      .insertInto("entity_mentions")
      .values({
        id: randomUUID(),
        entity_id: candidate,
        indexed_file_id: fileId,
        chunk_index: null,
        context_snippet: null,
        confidence: "EXTRACTED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: new Date().toISOString(),
      })
      .execute();

    await h.db
      .insertInto("indexed_file_facts")
      .values([
        {
          id: randomUUID(),
          indexed_file_id: fileId,
          source: "gmail",
          fact_type: "attendee",
          relation: "attendee",
          subject_email: "stranger-one@x.test",
          normalized_subject_name: "rajesh chaudhary",
          fact_key: `${fileId}:attendee:1`,
        },
        {
          id: randomUUID(),
          indexed_file_id: fileId,
          source: "gmail",
          fact_type: "attendee",
          relation: "attendee",
          subject_email: "stranger-two@x.test",
          normalized_subject_name: "rajesh chaudhary",
          fact_key: `${fileId}:attendee:2`,
        },
      ])
      .execute();

    await runPasses(h);

    const row = await readRow(h.db, rowId);
    expect(row?.pass_reason).not.toBe("co_listed_participants");
  });

  it("C1 still sees co-listed attendee proof when it lands in the last evidence chunk", async () => {
    const candidate = await seedEntity(h.db, {
      name: "A. Boundary",
      metadata: { email: "candidate.boundary@acme.test" },
    });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Ada Boundary",
      candidateEntityId: candidate,
      proposedEmail: "ada.boundary@other.test",
    });
    const fileIds = await seedIndexedFiles(h.db, h.ownerId, "c1-boundary", 3);
    await seedReviewEvidence(h.db, rowId, fileIds);
    await seedMention(h.db, candidate, fileIds[2]);
    await seedAttendeeFact(h.db, fileIds[2], {
      email: "ada.boundary@other.test",
      normalizedName: "ada boundary",
    });
    await seedAttendeeFact(h.db, fileIds[2], {
      email: "candidate.boundary@acme.test",
      normalizedName: "a boundary",
    });

    await withAttendeeFactChunkSizeForTest(2, () => runPasses(h));

    const row = await readRow(h.db, rowId);
    expect(row?.status).toBe("deferred");
    expect(row?.pass_reason).toBe("co_listed_participants");
  });

  it("C2 does not pool attendees from different evidence chunks into one co-listed proof", async () => {
    const candidate = await seedEntity(h.db, {
      name: "B. Boundary",
      metadata: { email: "candidate.pool@acme.test" },
    });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Bea Boundary",
      candidateEntityId: candidate,
      proposedEmail: "bea.pool@other.test",
    });
    const fileIds = await seedIndexedFiles(h.db, h.ownerId, "c2-boundary", 3);
    await seedReviewEvidence(h.db, rowId, fileIds);
    await seedMention(h.db, candidate, fileIds[2]);
    await seedAttendeeFact(h.db, fileIds[0], {
      email: "bea.pool@other.test",
      normalizedName: "bea boundary",
    });
    await seedAttendeeFact(h.db, fileIds[2], {
      email: "candidate.pool@acme.test",
      normalizedName: "b boundary",
    });

    await withAttendeeFactChunkSizeForTest(2, () => runPasses(h));

    const row = await readRow(h.db, rowId);
    expect(row?.status).toBe("deferred");
    expect(row?.pass_reason).not.toBe("co_listed_participants");
    expect(row?.pass_reason).toBe("different_emails");
  });

  it("C3 converges over a multi-chunk corpus with candidate re-points without touching graph tables", async () => {
    const coListedCandidate = await seedEntity(h.db, {
      name: "C. Boundary",
      metadata: { email: "candidate.converge@acme.test" },
    });
    const coListedRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Cara Boundary",
      candidateEntityId: coListedCandidate,
      proposedEmail: "cara.converge@other.test",
    });
    const fileIds = await seedIndexedFiles(h.db, h.ownerId, "c3-boundary", 5);
    await seedReviewEvidence(h.db, coListedRow, fileIds);
    await seedMention(h.db, coListedCandidate, fileIds[4]);
    await seedAttendeeFact(h.db, fileIds[4], {
      email: "cara.converge@other.test",
      normalizedName: "cara boundary",
    });
    await seedAttendeeFact(h.db, fileIds[4], {
      email: "candidate.converge@acme.test",
      normalizedName: "c boundary",
    });

    const supersededCandidate = await seedEntity(h.db, { name: "Old Superseded" });
    const supersedingEntity = await seedEntity(h.db, { name: "Fresh Superseded" });
    const supersededRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Fresh Superseded",
      candidateEntityId: supersededCandidate,
      candidateEntityIds: [supersededCandidate],
      candidateScore: 0.8,
    });

    const mergeSurvivor = await seedEntity(h.db, { name: "Merge Survivor" });
    const mergedCandidate = await seedEntity(h.db, {
      name: "Merged Candidate",
      mergedInto: mergeSurvivor,
    });
    const mergedRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Merged Proposal",
      candidateEntityId: mergedCandidate,
      candidateEntityIds: [mergedCandidate],
      candidateScore: 0.7,
    });

    const deletedCandidate = await seedEntity(h.db, { name: "Deleted Candidate", deletedAt: new Date().toISOString() });
    const clearedRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Deleted Proposal",
      candidateEntityId: deletedCandidate,
      candidateEntityIds: [deletedCandidate],
      candidateScore: 0.6,
    });

    const rowIds = [coListedRow, supersededRow, mergedRow, clearedRow];
    const beforeGraph = await graphFingerprint(h.db);
    let previous = await queueState(h.db, rowIds);
    let convergedAt: number | null = null;

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await withAttendeeFactChunkSizeForTest(2, () => runPasses(h));
      const current = await queueState(h.db, rowIds);
      if (JSON.stringify(current) === JSON.stringify(previous)) {
        convergedAt = attempt;
        break;
      }
      previous = current;
    }

    expect(convergedAt).not.toBeNull();
    expect(convergedAt).toBeGreaterThan(1);
    expect(await graphFingerprint(h.db)).toBe(beforeGraph);

    const convergedRows = new Map((await queueState(h.db, rowIds)).map((row) => [row.id, row]));
    expect(convergedRows.get(coListedRow)?.pass_reason).toBe("co_listed_participants");
    expect(convergedRows.get(supersededRow)?.candidate_entity_id).toBe(supersedingEntity);
    expect(convergedRows.get(mergedRow)?.candidate_entity_id).toBe(mergeSurvivor);
    expect(convergedRows.get(clearedRow)?.candidate_entity_id).toBeNull();
  });

  it("T8 leaves a row alone while a person has it open, and defers it once the freeze lapses", async () => {
    const candidate = await seedEntity(h.db, {
      name: "Frozen Candidate",
      metadata: { email: "frozen.candidate@acme.test" },
    });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Frozen Proposal",
      candidateEntityId: candidate,
      proposedEmail: "frozen.proposal@other.test",
    });

    await h.db
      .updateTable("entity_review_queue")
      .set({ review_started_at: new Date().toISOString(), review_started_by: h.ownerId })
      .where("id", "=", rowId)
      .execute();

    await runPasses(h);
    const untouched = await readRow(h.db, rowId);
    expect(untouched?.status).toBe("pending");
    expect(untouched?.pass_reason).toBeNull();

    await h.db
      .updateTable("entity_review_queue")
      .set({ review_started_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() })
      .where("id", "=", rowId)
      .execute();

    await runPasses(h);
    const deferred = await readRow(h.db, rowId);
    expect(deferred?.status).toBe("deferred");
    expect(deferred?.pass_reason).toBe("different_emails");
  });

  /**
   * The interleaved half of T8. The HTTP endpoint runs the whole pass in one
   * call, so it cannot express "selected, then opened, then written" without a
   * test-only seam in the production path. This drives the projection directly
   * with a row set captured before the review was opened — which is exactly the
   * race, and it is the only case that tells a freeze check on the SELECT apart
   * from one on the UPDATE.
   */
  it("T8 interleaved: a review opened after selection still blocks the write", async () => {
    const candidate = await seedEntity(h.db, { name: "Interleaved Candidate" });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Interleaved Proposal",
      candidateEntityId: candidate,
    });

    const selected = (await loadQueueRows(h.db)).map((row) => row.id);
    expect(selected).toContain(rowId);

    const opened = await h.app.request(`/api/entity-review/${rowId}`, { headers: { Cookie: h.cookie } });
    expect(opened.status).toBe(200);
    expect((await readRow(h.db, rowId))?.review_started_at).not.toBeNull();

    const counts = await applyProjection(h.db, selected, new Map([[rowId, "different_emails"]]));
    expect(counts.frozen).toBe(1);

    const row = await readRow(h.db, rowId);
    expect(row?.status).toBe("pending");
    expect(row?.pass_reason).toBeNull();
  });

  it("T5 sweeps a deferred orphan on connector delete and spares a confirming row", async () => {
    const connectorId = "gmail-queue-cleanup";
    await h.db
      .insertInto("connector_configs")
      .values({
        id: connectorId,
        connector_type: "gmail",
        auth_type: "system",
        credentials: JSON.stringify({ type: "system" }),
        created_by: h.ownerId,
        scope_config: "{}",
        sync_status: "active",
      })
      .execute();
    const fileId = randomUUID();
    await h.db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: connectorId,
        provider_file_id: "msg-1",
        file_name: "msg-1.eml",
        content_category: "document",
        source: "gmail",
        synced_at: new Date().toISOString(),
      })
      .execute();

    const deferredRow = await seedQueueRow(h.db, h.ownerId, { name: "Cleanup Person" });
    await seedEntity(h.db, { name: "Cleanup Person" });
    const confirmingRow = await seedQueueRow(h.db, h.ownerId, {
      name: "Confirming Person",
      status: "confirming",
    });
    for (const reviewId of [deferredRow, confirmingRow]) {
      await h.db
        .insertInto("entity_review_evidence")
        .values({ id: randomUUID(), review_id: reviewId, indexed_file_id: fileId, source: "gmail" })
        .execute();
    }

    await runPasses(h);
    expect((await readRow(h.db, deferredRow))?.status).toBe("deferred");

    const res = await h.app.request(`/api/connectors/${connectorId}`, {
      method: "DELETE",
      headers: { Cookie: h.cookie },
    });
    expect(res.status).toBe(200);

    expect(await readRow(h.db, deferredRow)).toBeUndefined();
    expect((await readRow(h.db, confirmingRow))?.status).toBe("confirming");
  });

  it("reports per-reason counts on the run snapshot", async () => {
    await seedQueueRow(h.db, h.ownerId, { name: "Counted Person" });
    await seedEntity(h.db, { name: "Counted Person" });

    const snapshot = await runPasses(h);
    expect(snapshot.kind).toBe("queue");
    expect(snapshot.scannedRows).toBe(1);
    expect((snapshot.set as Record<string, number>).name_already_resolved).toBe(1);
  });

  it("runs queue passes before the boot duplicate drain", async () => {
    const candidate = await seedEntity(h.db, { name: "Alpha Tool", type: "tool" });
    await seedQueueRow(h.db, h.ownerId, {
      name: "Tool Alpha",
      type: "tool",
      candidateEntityId: candidate,
      candidateScore: 1,
    });

    const handle = startQueueDrainSequence(h.db, createTestLogger());
    await handle.done;

    const state = await h.db
      .selectFrom("graph_pass_runs")
      .select(["input_snapshot_json"])
      .where("id", "=", duplicateDrainStateRowId)
      .executeTakeFirstOrThrow();
    const snapshot = JSON.parse(state.input_snapshot_json) as { m5SkippedPassReason?: number };
    expect(snapshot.m5SkippedPassReason).toBeGreaterThan(0);
  });
});

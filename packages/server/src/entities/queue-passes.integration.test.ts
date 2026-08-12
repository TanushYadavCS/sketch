import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";
import { applyProjection } from "./queue-projection";
import { liveEntitiesForNames, loadQueueRows } from "./queue-reconcile";
import { structuralPass } from "./queue-structural";

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
    expect(row?.pass_reason).toBe("superseded_by_entity");
    expect(row?.candidate_entity_id).toBe(supersedes);
    expect(row?.candidate_entity_ids).toBeNull();
    expect(row?.candidate_score).toBeNull();
    expect(row?.candidate_generated_at).not.toBe("2020-01-01T00:00:00.000Z");

    const identityAfter = await Promise.all(identityRows.map((id) => readRow(h.db, id)));
    expect(identityAfter).toEqual(identityBefore);

    const processed = await readRow(h.db, nullSourceRow);
    expect(processed?.candidate_entity_id).toBe(nullSourceLive);
    expect(processed?.pass_reason).toBe("superseded_by_entity");
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
    expect(repointed?.pass_reason).toBe("candidate_merged_away");
    expect(repointed?.candidate_score).toBeNull();
    expect(repointed?.candidate_entity_ids).toBeNull();
    expect(repointed?.candidate_generated_at).not.toBe("2020-01-01T00:00:00.000Z");

    const cleared = await readRow(h.db, goneRow);
    expect(cleared?.candidate_entity_id).toBeNull();
    expect(cleared?.candidate_score).toBeNull();
    expect(cleared?.candidate_entity_ids).toBeNull();
    expect(cleared?.candidate_generated_at).not.toBe("2020-01-01T00:00:00.000Z");
  });

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

  it("F1 the veto fires when the proposal's name resolves to the candidate", async () => {
    const candidate = await seedEntity(h.db, { name: "Admin", metadata: { email: "admin@one.test" } });
    const rowId = await seedQueueRow(h.db, h.ownerId, {
      name: "Admin",
      candidateEntityId: candidate,
      proposedEmail: "admin@two.test",
    });

    await runPasses(h);

    const row = await readRow(h.db, rowId);
    expect(row?.status).toBe("deferred");
    expect(row?.pass_reason).toBe("different_emails");
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
});

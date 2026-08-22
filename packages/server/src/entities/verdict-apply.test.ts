import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { applyGraphVerdict, revertGraphVerdict } from "./verdict-apply";
import { fingerprintFor } from "./verdict-fingerprint";

const USER_ID = "verdict-apply-user";

async function seedUser(db: Kysely<DB>): Promise<void> {
  await db.insertInto("users").values({ id: USER_ID, name: "Verdict Apply User" }).execute();
}

async function seedEntity(db: Kysely<DB>, id: string, name: string): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "project",
      subtype: null,
      aliases: "[]",
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 0,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedRelationship(db: Kysely<DB>, id: string, sourceId: string, targetId: string): Promise<void> {
  await db
    .insertInto("entity_relationships")
    .values({
      id,
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relationship_type: "related_to",
      confidence: "high",
      confidence_score: 1,
      source: "llm_extraction",
    })
    .execute();
}

describe("graph verdict apply", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUser(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("applies and reverts an archive verdict when only llm_extraction relationships reference the entity", async () => {
    await seedEntity(db, "archive-subject", "Archive Subject");
    await seedEntity(db, "archive-anchor", "Archive Anchor");
    await seedRelationship(db, "rel-outgoing-machine", "archive-subject", "archive-anchor");
    await seedRelationship(db, "rel-incoming-machine", "archive-anchor", "archive-subject");
    const subject = await db
      .selectFrom("entities")
      .selectAll()
      .where("id", "=", "archive-subject")
      .executeTakeFirstOrThrow();
    const repo = createGraphVerdictRepository(db);
    const run = await repo.createRun({
      source: "test",
      proposedByUserId: USER_ID,
      tokenId: null,
      note: null,
      verdictsProposed: 1,
    });
    const stored = await repo.storeVerdicts([
      {
        runId: run.id,
        action: "archive",
        subjectEntityId: subject.id,
        subjectName: subject.name,
        subjectEntityType: subject.source_type,
        targetEntityId: null,
        resolvedTargetEntityId: null,
        targetName: null,
        reason: "Archive extraction-only project.",
        evidenceJson: JSON.stringify({ fileIds: [], reviewIds: [], notes: ["machine edges do not vouch"] }),
        evidenceFingerprint: fingerprintFor({
          action: "archive",
          subject,
          target: null,
          evidence: { fileIds: [], reviewIds: [], notes: ["machine edges do not vouch"] },
        }),
        validationStatus: "ok",
        validationReason: null,
        wouldChangeJson: JSON.stringify({ entities: 1 }),
        status: "awaiting_human",
      },
    ]);
    const verdictId = stored.ids[0] ?? "";
    const approved = await repo.markApproved({ id: verdictId, actorUserId: USER_ID });
    expect(approved).toBe(true);

    const preview = await applyGraphVerdict(db, { verdictId, actorUserId: USER_ID, dryRun: true });
    expect(preview.status).toBe("approved");
    expect(preview.plan.state).toBe("applied");

    const applied = await applyGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    expect(applied.status).toBe("applied");
    expect(applied.ledgerRef).toMatch(/^archived-at:/);
    const archivedAt = applied.ledgerRef?.slice("archived-at:".length) ?? "";
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", "archive-subject").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: archivedAt });
    await expect(
      db.selectFrom("entity_relationships").select("id").where("id", "like", "rel-%").execute(),
    ).resolves.toHaveLength(2);

    const reverted = await revertGraphVerdict(db, { verdictId, actorUserId: USER_ID });

    expect(reverted).toEqual({ verdictId, status: "reverted", ledgerRef: `archived-at:${archivedAt}` });
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["status", "applied_ledger_ref"])
        .where("id", "=", verdictId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "reverted", applied_ledger_ref: `archived-at:${archivedAt}` });
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", "archive-subject").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null });
    await expect(
      db.selectFrom("entity_relationships").select("id").where("id", "like", "rel-%").execute(),
    ).resolves.toHaveLength(2);
  });
});

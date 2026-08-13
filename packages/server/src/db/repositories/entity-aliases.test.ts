import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { listPendingNameProposalsByEntity, upsertEntityNameProposal } from "./entity-aliases";

describe("listPendingNameProposalsByEntity", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedEntity(id: string, name: string, nameStatus: string): Promise<void> {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id,
        name,
        source_type: "person",
        subtype: "external",
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        name_status: nameStatus,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedProposal(
    entityId: string,
    value: string,
    observedCount: number,
    lastSeenAt: string,
    status = "pending",
  ): Promise<void> {
    await db
      .insertInto("entity_name_proposals")
      .values({
        id: randomUUID(),
        entity_id: entityId,
        source: "whatsapp_pushname",
        value,
        normalized_value: value.toLowerCase(),
        observed_count: observedCount,
        first_seen_at: lastSeenAt,
        last_seen_at: lastSeenAt,
        status,
        resolved_by_user_id: null,
        resolved_at: null,
      })
      .execute();
  }

  it("returns the pending proposal for a placeholder entity", async () => {
    await seedEntity("e1", "+919891688787", "placeholder");
    await seedProposal("e1", "Tanush Yadav", 10, "2026-08-13T00:00:00.000Z");

    const result = await listPendingNameProposalsByEntity(db, ["e1"]);

    expect(result.get("e1")).toBe("Tanush Yadav");
  });

  it("returns nothing for a placeholder entity with no proposal", async () => {
    await seedEntity("e1", "+919891688787", "placeholder");

    const result = await listPendingNameProposalsByEntity(db, ["e1"]);

    expect(result.has("e1")).toBe(false);
  });

  it("returns nothing for a confirmed entity even when a proposal is pending", async () => {
    await seedEntity("e1", "Tanush Yadav", "confirmed");
    await seedProposal("e1", "Tanush", 4, "2026-08-13T00:00:00.000Z");

    const result = await listPendingNameProposalsByEntity(db, ["e1"]);

    expect(result.has("e1")).toBe(false);
  });

  it("ignores proposals that are no longer pending", async () => {
    await seedEntity("e1", "+919891688787", "placeholder");
    await seedProposal("e1", "Tanush Yadav", 10, "2026-08-13T00:00:00.000Z", "rejected");

    const result = await listPendingNameProposalsByEntity(db, ["e1"]);

    expect(result.has("e1")).toBe(false);
  });

  it("prefers the most observed proposal, then the most recent", async () => {
    await seedEntity("e1", "+919891688787", "placeholder");
    await seedProposal("e1", "Rarely Seen", 2, "2026-08-13T09:00:00.000Z");
    await seedProposal("e1", "Tanush Yadav", 9, "2026-08-13T01:00:00.000Z");
    await seedEntity("e2", "+919650805188", "placeholder");
    await seedProposal("e2", "Older Tie", 3, "2026-08-13T01:00:00.000Z");
    await seedProposal("e2", "Newer Tie", 3, "2026-08-13T08:00:00.000Z");

    const result = await listPendingNameProposalsByEntity(db, ["e1", "e2"]);

    expect(result.get("e1")).toBe("Tanush Yadav");
    expect(result.get("e2")).toBe("Newer Tie");
  });

  /**
   * An empty list renders as `IN ()`, which SQLite tolerates and Postgres
   * rejects as a syntax error, so the guard has to short-circuit before the
   * query is built rather than rely on the dialect being forgiving.
   */
  it("returns an empty map without querying when given no entity ids", async () => {
    const result = await listPendingNameProposalsByEntity(db, []);

    expect(result.size).toBe(0);
  });

  it("keeps proposals scoped to their own entity", async () => {
    await seedEntity("e1", "+919891688787", "placeholder");
    await seedEntity("e2", "+919650805188", "placeholder");
    await seedProposal("e1", "Tanush Yadav", 10, "2026-08-13T00:00:00.000Z");

    const result = await listPendingNameProposalsByEntity(db, ["e1", "e2"]);

    expect(result.get("e1")).toBe("Tanush Yadav");
    expect(result.has("e2")).toBe(false);
  });

  it("surfaces a proposal recorded through upsertEntityNameProposal", async () => {
    await seedEntity("e1", "+919891688787", "placeholder");
    await upsertEntityNameProposal(db, "e1", "whatsapp_pushname", "Tanush Yadav");

    const result = await listPendingNameProposalsByEntity(db, ["e1"]);

    expect(result.get("e1")).toBe("Tanush Yadav");
  });
});

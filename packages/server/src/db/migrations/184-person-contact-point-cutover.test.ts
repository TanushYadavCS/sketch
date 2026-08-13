import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import * as migration from "./184-person-contact-point-cutover";

describe("184 person contact point cutover", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await migration.down(db as never);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("backfills valid legacy email metadata and permits it across people", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values([
        {
          id: "person-a",
          name: "A",
          source_type: "person",
          metadata: JSON.stringify({ email: " Shared@Example.com " }),
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "person-b",
          name: "B",
          source_type: "person",
          metadata: JSON.stringify({ email: "shared@example.com" }),
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
        {
          id: "person-bad",
          name: "Bad",
          source_type: "person",
          metadata: "not-json",
          status: "confirmed",
          hotness: 0,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    await migration.up(db as never);

    await expect(
      db
        .selectFrom("entity_contact_points")
        .select(["entity_id", "kind", "value", "is_primary"])
        .where("value", "=", "shared@example.com")
        .orderBy("entity_id", "asc")
        .execute(),
    ).resolves.toEqual([
      { entity_id: "person-a", kind: "email", value: "shared@example.com", is_primary: 1 },
      { entity_id: "person-b", kind: "email", value: "shared@example.com", is_primary: 1 },
    ]);
    await expect(
      db.selectFrom("entity_contact_points").select("id").where("entity_id", "=", "person-bad").execute(),
    ).resolves.toEqual([]);
  });
});

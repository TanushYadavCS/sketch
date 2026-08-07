import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { buildEntityAdjudicationContext } from "./adjudicate";

describe("buildEntityAdjudicationContext", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("renders a legacy person subtype as external", async () => {
    await db
      .insertInto("entities")
      .values({
        id: "legacy-person",
        name: "Legacy Person",
        source_type: "person",
        subtype: null,
        aliases: null,
        metadata: null,
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    await expect(buildEntityAdjudicationContext(db, "legacy-person")).resolves.toMatchObject({
      subtype: "external",
    });
  });
});

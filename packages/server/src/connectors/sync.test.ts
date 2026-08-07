import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntityDomainsRepository } from "../db/repositories/entity-domains";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { seedTeamDirectoryEntities } from "./sync";

describe("seedTeamDirectoryEntities", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("does not seed external app users and promotes internal roster matches", async () => {
    await db
      .insertInto("users")
      .values([
        {
          id: "external-user",
          name: "External User",
          email: "external@outside.example",
          type: "external",
        },
        {
          id: "internal-user",
          name: "Internal User",
          email: "internal@example.com",
          type: "human",
        },
      ])
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "existing-internal-user",
        name: "Existing Internal User",
        source_type: "person",
        subtype: null,
        aliases: JSON.stringify(["internal@example.com"]),
        metadata: JSON.stringify({ email: "internal@example.com" }),
        source_ref_id: null,
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    await createEntityDomainsRepository(db).upsertDomain({
      entityId: "existing-internal-user",
      domain: "example.com",
      kind: "corporate",
      source: "test",
    });

    await seedTeamDirectoryEntities(db, createTestLogger());

    await expect(
      db.selectFrom("entities").select("id").where("name", "=", "External User").execute(),
    ).resolves.toHaveLength(0);
    await expect(
      db.selectFrom("entities").select("subtype").where("id", "=", "existing-internal-user").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ subtype: "internal" });
  });
});

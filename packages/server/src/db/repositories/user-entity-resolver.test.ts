import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { resolvePersonEntitiesForEmails, resolvePersonEntitiesForUser } from "./user-entity-resolver";

describe("user entity resolver", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function addEntity(id: string, email?: string): Promise<void> {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id,
        name: id,
        source_type: "person",
        subtype: "external",
        metadata: email ? JSON.stringify({ email }) : null,
        status: "confirmed",
        provenance_tier: "inferred",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  it("returns only requested emails while batching scoped user links", async () => {
    await db
      .insertInto("users")
      .values([
        { id: "requested-user", name: "Requested", type: "human", email: "requested@example.com" },
        { id: "unrelated-user", name: "Unrelated", type: "human", email: "unrelated@example.com" },
      ])
      .execute();
    await addEntity("requested-entity", "requested@example.com");
    await addEntity("unrelated-entity", "unrelated@example.com");
    await db
      .insertInto("user_entity_links")
      .values([
        {
          id: "requested-link",
          user_id: "requested-user",
          entity_id: "requested-entity",
          matched_via: "email",
          confirmed_by_user_id: null,
        },
        {
          id: "unrelated-link",
          user_id: "unrelated-user",
          entity_id: "unrelated-entity",
          matched_via: "email",
          confirmed_by_user_id: null,
        },
      ])
      .execute();

    const linkQueries: string[] = [];
    const instrumentedDb = db.withPlugin({
      transformQuery({ node }) {
        const serialized = JSON.stringify(node);
        if (serialized.includes('"name":"user_entity_links"')) linkQueries.push(serialized);
        return node;
      },
      async transformResult(args) {
        return args.result;
      },
    });

    const resolved = await resolvePersonEntitiesForEmails(instrumentedDb, ["REQUESTED@example.com"]);

    expect([...resolved.keys()]).toEqual(["requested@example.com"]);
    expect([...resolved.values()].flat().map((entity) => entity.id)).toEqual(["requested-entity"]);
    expect(linkQueries).toHaveLength(1);
  });

  it("terminates a merge cycle without returning a live entity", async () => {
    await db.insertInto("users").values({ id: "cycle-user", name: "Cycle User", type: "human" }).execute();
    await addEntity("cycle-a");
    await addEntity("cycle-b");
    await db
      .updateTable("entities")
      .set({ deleted_at: new Date().toISOString(), merged_into_entity_id: "cycle-b" })
      .where("id", "=", "cycle-a")
      .execute();
    await db
      .updateTable("entities")
      .set({ deleted_at: new Date().toISOString(), merged_into_entity_id: "cycle-a" })
      .where("id", "=", "cycle-b")
      .execute();
    await db
      .insertInto("user_entity_links")
      .values({
        id: "cycle-link",
        user_id: "cycle-user",
        entity_id: "cycle-a",
        matched_via: "email",
        confirmed_by_user_id: null,
      })
      .execute();

    await expect(resolvePersonEntitiesForUser(db, "cycle-user", [])).resolves.toEqual(new Map());
  });

  it("falls back to email entities when a linked entity resolves dead", async () => {
    await db
      .insertInto("users")
      .values({ id: "dead-link-user", name: "Dead Link", type: "human", email: "dead-link@example.com" })
      .execute();
    await addEntity("dead-link-loser");
    await addEntity("dead-link-fallback", "dead-link@example.com");
    await db
      .updateTable("entities")
      .set({ deleted_at: new Date().toISOString() })
      .where("id", "=", "dead-link-loser")
      .execute();
    await db
      .insertInto("user_entity_links")
      .values({
        id: "dead-link-row",
        user_id: "dead-link-user",
        entity_id: "dead-link-loser",
        matched_via: "email",
        confirmed_by_user_id: null,
      })
      .execute();

    await expect(resolvePersonEntitiesForUser(db, "dead-link-user", ["dead-link@example.com"])).resolves.toMatchObject(
      new Map([["dead-link@example.com", [expect.objectContaining({ id: "dead-link-fallback" })]]]),
    );
  });

  it("matches normalized stored user emails when resolving email links", async () => {
    await db
      .insertInto("users")
      .values({ id: "normalized-user", name: "Normalized", type: "human", email: "  Mixed@Example.com  " })
      .execute();
    await addEntity("normalized-entity", "mixed@example.com");
    await db
      .insertInto("user_entity_links")
      .values({
        id: "normalized-link",
        user_id: "normalized-user",
        entity_id: "normalized-entity",
        matched_via: "email",
        confirmed_by_user_id: null,
      })
      .execute();

    const resolved = await resolvePersonEntitiesForEmails(db, ["MIXED@example.com"]);

    expect([...(resolved.get("mixed@example.com") ?? [])].map((entity) => entity.id)).toEqual(["normalized-entity"]);
  });
});

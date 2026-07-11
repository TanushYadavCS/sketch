import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { buildSyncNameResolver } from "./sync-name-resolution";

async function insertEntity(
  db: Kysely<DB>,
  args: {
    id: string;
    name: string;
    sourceType?: string;
    email?: string | null;
    aliases?: string[];
    deletedAt?: string | null;
    mergedInto?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: args.id,
      name: args.name,
      source_type: args.sourceType ?? "person",
      status: "confirmed",
      hotness: 0,
      created_at: now,
      updated_at: now,
      aliases: args.aliases ? JSON.stringify(args.aliases) : null,
      metadata: args.email ? JSON.stringify({ email: args.email }) : null,
      deleted_at: args.deletedAt ?? null,
      merged_into_entity_id: args.mergedInto ?? null,
    })
    .execute();
}

async function insertUser(
  db: Kysely<DB>,
  args: { id: string; name: string; email: string | null; type?: string },
): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: args.id,
      name: args.name,
      email: args.email,
      type: args.type ?? "member",
      auth_role: "member",
    })
    .execute();
}

describe("buildSyncNameResolver", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("resolves a person entity by name and by alias", async () => {
    await insertEntity(db, {
      id: "p1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      aliases: ["Countess Lovelace"],
    });
    const resolve = await buildSyncNameResolver(db);

    expect(resolve("Ada Lovelace")).toEqual({ email: "ada@example.com", entityId: "p1", source: "entities" });
    expect(resolve("Countess Lovelace")).toEqual({
      email: "ada@example.com",
      entityId: "p1",
      source: "entities",
    });
    expect(resolve("Unknown Person")).toBeNull();
  });

  it("does not resolve non-person entities that share a name", async () => {
    await insertEntity(db, { id: "c1", name: "Acme", sourceType: "company", email: "billing@acme.com" });
    const resolve = await buildSyncNameResolver(db);

    expect(resolve("Acme")).toBeNull();
  });

  it("prefers the users table over person entities", async () => {
    await insertEntity(db, { id: "p1", name: "Grace Hopper", email: "grace-entity@example.com" });
    await insertUser(db, { id: "u1", name: "Grace Hopper", email: "grace@corp.com" });
    const resolve = await buildSyncNameResolver(db);

    expect(resolve("Grace Hopper")).toEqual({ email: "grace@corp.com", source: "users" });
  });

  it("skips external users and users without an email", async () => {
    await insertUser(db, { id: "ext", name: "External Guest", email: "guest@vendor.com", type: "external" });
    await insertUser(db, { id: "noemail", name: "No Email", email: null });
    const resolve = await buildSyncNameResolver(db);

    expect(resolve("External Guest")).toBeNull();
    expect(resolve("No Email")).toBeNull();
  });

  it("excludes soft-deleted and merged person entities", async () => {
    const now = new Date().toISOString();
    await insertEntity(db, { id: "survivor", name: "Live One", email: "live@example.com" });
    await insertEntity(db, { id: "gone", name: "Deleted One", email: "deleted@example.com", deletedAt: now });
    await insertEntity(db, {
      id: "merged",
      name: "Merged One",
      email: "merged@example.com",
      mergedInto: "survivor",
    });
    const resolve = await buildSyncNameResolver(db);

    expect(resolve("Live One")).toEqual({ email: "live@example.com", entityId: "survivor", source: "entities" });
    expect(resolve("Deleted One")).toBeNull();
    expect(resolve("Merged One")).toBeNull();
  });

  it("returns null for an ambiguous person name shared by two live entities", async () => {
    await insertEntity(db, { id: "a", name: "John Smith", email: "john.a@example.com" });
    await insertEntity(db, { id: "b", name: "John Smith", email: "john.b@example.com" });
    const resolve = await buildSyncNameResolver(db);

    expect(resolve("John Smith")).toBeNull();
  });
});

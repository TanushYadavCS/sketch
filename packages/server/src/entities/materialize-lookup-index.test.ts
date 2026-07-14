import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { buildMaterializeDeps, normalizeEntityMatchName, registerEntity } from "./materialize-deps";
import type { IndexEntityRow } from "./materialize-types";

async function seedEntity(
  db: Kysely<DB>,
  row: { id: string; name: string; sourceType?: string; aliases?: string[]; provenanceTier?: string },
): Promise<void> {
  await db
    .insertInto("entities")
    .values({
      id: row.id,
      name: row.name,
      source_type: row.sourceType ?? "company",
      subtype: null,
      aliases: row.aliases ? JSON.stringify(row.aliases) : null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: row.provenanceTier ?? "declared",
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
}

async function seedSourceRef(db: Kysely<DB>, id: string, entityId: string, source: string, sourceId: string) {
  await db
    .insertInto("entity_source_refs")
    .values({ id, entity_id: entityId, source, source_id: sourceId, last_seen_at: "2026" })
    .execute();
}

describe("lookup index row sharing", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("shares a single row instance across the type, name, alias, and source-ref indexes", async () => {
    await seedEntity(db, { id: "acme", name: "Acme", sourceType: "company", aliases: ["Acme Corp"] });
    await seedSourceRef(db, "ref-1", "acme", "hubspot", "company-1");
    await seedSourceRef(db, "ref-2", "acme", "salesforce", "account-1");

    const deps = await buildMaterializeDeps(db);
    const { index } = deps;

    const nameKey = normalizeEntityMatchName("company", "Acme");
    const aliasKey = normalizeEntityMatchName("company", "Acme Corp");
    const byType = index.entitiesByType.get("company") ?? [];
    const byName = index.byNormalizedName.get(nameKey) ?? [];
    const byAlias = index.byNormalizedAlias.get(aliasKey) ?? [];
    const ref1 = index.bySourceRef.get("hubspot:company-1");
    const ref2 = index.bySourceRef.get("salesforce:account-1");

    const shared = byType.find((e) => e.id === "acme");
    expect(shared).toBeDefined();
    expect(byName).toContain(shared);
    expect(byAlias).toContain(shared);
    expect(ref1).toBe(shared);
    expect(ref2).toBe(shared);

    const instances = new Set<IndexEntityRow>([
      shared as IndexEntityRow,
      ...byName,
      ...byAlias,
      ref1 as IndexEntityRow,
      ref2 as IndexEntityRow,
    ]);
    expect(instances.size).toBe(1);
  });

  it("omits wide columns not needed by matching from index rows", async () => {
    await seedEntity(db, { id: "acme", name: "Acme", sourceType: "company" });
    await db
      .updateTable("entities")
      .set({ ai_brief: "a very long generated brief" })
      .where("id", "=", "acme")
      .execute();

    const deps = await buildMaterializeDeps(db);
    const shared = (deps.index.entitiesByType.get("company") ?? []).find((e) => e.id === "acme");

    expect(shared).toBeDefined();
    expect((shared as Record<string, unknown>).ai_brief).toBeUndefined();
    expect(shared?.name).toBe("Acme");
    expect(shared?.source_type).toBe("company");
  });

  it("reflows a registerEntity update through the type, name, and alias buckets", async () => {
    await seedEntity(db, { id: "acme", name: "Acme", sourceType: "company", aliases: ["Acme Corp"] });

    const deps = await buildMaterializeDeps(db);
    const { index } = deps;

    const oldKey = normalizeEntityMatchName("company", "Acme");
    const aliasKey = normalizeEntityMatchName("company", "Acme Corp");
    const original = (index.entitiesByType.get("company") ?? []).find((e) => e.id === "acme") as IndexEntityRow;
    const updated: IndexEntityRow = { ...original, name: "Acme Renamed" };
    registerEntity(index, updated);

    const newKey = normalizeEntityMatchName("company", "Acme Renamed");
    const byType = index.entitiesByType.get("company") ?? [];
    const renamed = byType.find((e) => e.id === "acme");

    expect(renamed).toBe(updated);
    expect(index.byNormalizedName.get(newKey) ?? []).toContain(updated);
    expect((index.byNormalizedName.get(oldKey) ?? []).some((e) => e.id === "acme")).toBe(false);
    expect(index.byNormalizedAlias.get(aliasKey) ?? []).toContain(updated);
  });
});

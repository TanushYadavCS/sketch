import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

interface PersonContactPointCutoverDb {
  entities: {
    id: string;
    source_type: string;
    metadata: string | null;
    deleted_at: string | null;
  };
  entity_contact_points: {
    id: string;
    entity_id: string;
    kind: string;
    value: string;
    display_value: string | null;
    label: string | null;
    is_primary: number;
    source: string;
    connector_config_id: string | null;
    created_by_user_id: string | null;
    verified_at: string | null;
    last_contacted_at: string | null;
    created_at: string;
    updated_at: string;
  };
}

function legacyEmail(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as { email?: unknown }).email;
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

export async function up(db: Kysely<PersonContactPointCutoverDb>): Promise<void> {
  let cursor = "";
  while (true) {
    const entities = await db
      .selectFrom("entities")
      .select(["id", "metadata"])
      .where("source_type", "=", "person")
      .where("deleted_at", "is", null)
      .where("id", ">", cursor)
      .orderBy("id", "asc")
      .limit(500)
      .execute();
    if (entities.length === 0) break;

    for (const entity of entities) {
      const email = legacyEmail(entity.metadata);
      if (!email) continue;
      const existingEmail = await db
        .selectFrom("entity_contact_points")
        .select("id")
        .where("entity_id", "=", entity.id)
        .where("kind", "=", "email")
        .executeTakeFirst();
      const now = new Date().toISOString();
      await db
        .insertInto("entity_contact_points")
        .values({
          id: randomUUID(),
          entity_id: entity.id,
          kind: "email",
          value: email,
          display_value: email,
          label: null,
          is_primary: existingEmail ? 0 : 1,
          source: "legacy_metadata",
          connector_config_id: null,
          created_by_user_id: null,
          verified_at: null,
          last_contacted_at: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.columns(["entity_id", "kind", "value"]).doNothing())
        .execute();
    }
    cursor = entities.at(-1)?.id ?? cursor;
  }

  const primaries = await db
    .selectFrom("entity_contact_points")
    .select(["id", "entity_id", "kind"])
    .where("is_primary", "=", 1)
    .orderBy("entity_id", "asc")
    .orderBy("kind", "asc")
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  const seen = new Set<string>();
  for (const primary of primaries) {
    const key = `${primary.entity_id}\0${primary.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    await db.updateTable("entity_contact_points").set({ is_primary: 0 }).where("id", "=", primary.id).execute();
  }

  await db.schema
    .createIndex("idx_entity_contact_points_one_primary")
    .unique()
    .on("entity_contact_points")
    .columns(["entity_id", "kind"])
    .where(sql<boolean>`is_primary = 1`)
    .execute();
}

export async function down(db: Kysely<PersonContactPointCutoverDb>): Promise<void> {
  await db.schema.dropIndex("idx_entity_contact_points_one_primary").execute();
}

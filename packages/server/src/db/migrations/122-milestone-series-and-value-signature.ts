import type { Kysely } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import { seriesKeyFor } from "../../entities/sub-entity-signatures";
import { yieldToEventLoop } from "../../lib/event-loop";

interface SubEntityBackfillRow {
  id: string;
  parent_scope_key: string;
  kind: string;
  normalized_name: string;
  display_name: string;
}

interface MigrationDb {
  sub_entities: {
    id: string;
    parent_scope_key: string;
    kind: string;
    normalized_name: string;
    display_name: string;
    value_signature: string | null;
    series_key: string | null;
  };
  tasks: {
    id: string;
    milestone_series_key: string | null;
  };
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sub_entities").addColumn("value_signature", "text").execute();
  await db.schema.alterTable("sub_entities").addColumn("series_key", "text").execute();
  await db.schema.alterTable("tasks").addColumn("milestone_series_key", "text").execute();

  const typedDb = db as Kysely<MigrationDb>;
  const rows = await typedDb
    .selectFrom("sub_entities")
    .select(["id", "parent_scope_key", "kind", "normalized_name", "display_name"])
    .execute();

  for (const row of rows as SubEntityBackfillRow[]) {
    await typedDb
      .updateTable("sub_entities")
      .set({
        value_signature: normalizeName(row.display_name),
        series_key: seriesKeyFor(row.parent_scope_key, row.kind, row.normalized_name),
      })
      .where("id", "=", row.id)
      .execute();
    await yieldToEventLoop();
  }

  await db.schema.createIndex("idx_sub_entities_series_key").on("sub_entities").column("series_key").execute();
  await db.schema.createIndex("idx_tasks_milestone_series_key").on("tasks").column("milestone_series_key").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_tasks_milestone_series_key").ifExists().execute();
  await db.schema.dropIndex("idx_sub_entities_series_key").ifExists().execute();
  await db.schema.alterTable("tasks").dropColumn("milestone_series_key").execute();
  await db.schema.alterTable("sub_entities").dropColumn("series_key").execute();
  await db.schema.alterTable("sub_entities").dropColumn("value_signature").execute();
}

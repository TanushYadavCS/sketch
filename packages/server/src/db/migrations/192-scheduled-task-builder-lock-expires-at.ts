import type { Kysely } from "kysely";
import { isPg } from "../dialect";

const TABLE = "scheduled_task_builder_locks";
const COLUMN = "expires_at";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;

  await db.schema
    .alterTable(TABLE)
    .alterColumn(COLUMN, (column) => column.setDataType("bigint"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!isPg(db)) return;

  await db.schema
    .alterTable(TABLE)
    .alterColumn(COLUMN, (column) => column.setDataType("integer"))
    .execute();
}

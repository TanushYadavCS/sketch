import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const VERDICTS = "project_minting_verdicts";
const OLD_VERDICTS = "project_minting_verdicts_194_old";
const VERDICT_COLUMNS = [
  "id",
  "company_entity_id",
  "company_name",
  "file_count",
  "dossier",
  "verdict",
  "model",
  "prompt_version",
  "status",
  "superseded_at",
  "created_at",
  "updated_at",
  "flags",
  "vote_stats",
  "decided_at",
  "decided_by_user_id",
  "struck_projects",
  "accepted_result",
  "counterparty_kind",
  "client_stage",
  "declared_counterparty_kind",
  "declared_client_stage",
] as const;

async function createVerdictsTable(db: Kysely<unknown>, companyRequired: boolean): Promise<void> {
  const table = db.schema.createTable(VERDICTS).addColumn("id", "text", (col) => col.notNull().primaryKey());
  const withCompany = companyRequired
    ? table.addColumn("company_entity_id", "text", (col) => col.notNull())
    : table.addColumn("company_entity_id", "text");
  await withCompany
    .addColumn("company_name", "text", (col) => col.notNull())
    .addColumn("file_count", "integer", (col) => col.notNull())
    .addColumn("dossier", "text", (col) => col.notNull())
    .addColumn("verdict", "text", (col) => col.notNull())
    .addColumn("model", "text", (col) => col.notNull())
    .addColumn("prompt_version", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("superseded_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("flags", "text")
    .addColumn("vote_stats", "text")
    .addColumn("decided_at", "text")
    .addColumn("decided_by_user_id", "text")
    .addColumn("struck_projects", "text")
    .addColumn("accepted_result", "text")
    .addColumn("counterparty_kind", "text")
    .addColumn("client_stage", "text")
    .addColumn("declared_counterparty_kind", "text")
    .addColumn("declared_client_stage", "text")
    .execute();
}

async function createIndexes(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX IF NOT EXISTS idx_project_minting_verdicts_company_status
    ON project_minting_verdicts(company_entity_id, status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_project_minting_verdicts_status_decided
    ON project_minting_verdicts(status, decided_at)`.execute(db);
}

async function dropIndexes(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_project_minting_verdicts_status_decided`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_project_minting_verdicts_company_status`.execute(db);
}

async function rebuildSqlite(db: Kysely<unknown>, companyRequired: boolean): Promise<void> {
  await sql`DROP TABLE IF EXISTS project_minting_verdicts_194_old`.execute(db);
  await dropIndexes(db);
  await sql`ALTER TABLE project_minting_verdicts RENAME TO project_minting_verdicts_194_old`.execute(db);
  await createVerdictsTable(db, companyRequired);
  const columnList = sql.raw(VERDICT_COLUMNS.join(", "));
  const sourceFilter = companyRequired ? sql`WHERE company_entity_id IS NOT NULL` : sql``;
  await sql`INSERT INTO project_minting_verdicts (${columnList})
    SELECT ${columnList}
    FROM project_minting_verdicts_194_old
    ${sourceFilter}`.execute(db);
  await sql`DROP TABLE IF EXISTS project_minting_verdicts_194_old`.execute(db);
  await createIndexes(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`ALTER TABLE project_minting_verdicts ALTER COLUMN company_entity_id DROP NOT NULL`.execute(db);
    return;
  }

  await rebuildSqlite(db, false);
}

/**
 * Restoring `company_entity_id NOT NULL` necessarily discards internal-pot
 * verdict rows. They have no counterparty company by design, so there is no
 * portable value that can be written before the constraint comes back.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DELETE FROM project_minting_verdicts WHERE company_entity_id IS NULL`.execute(db);
    await sql`ALTER TABLE project_minting_verdicts ALTER COLUMN company_entity_id SET NOT NULL`.execute(db);
    return;
  }

  await rebuildSqlite(db, true);
}

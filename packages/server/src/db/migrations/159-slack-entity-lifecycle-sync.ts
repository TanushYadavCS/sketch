import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const REVIEW_QUEUE_COLUMNS = [
  "id",
  "proposed_name",
  "normalized_name",
  "entity_type",
  "source",
  "source_id",
  "proposed_email",
  "candidate_entity_id",
  "candidate_entity_ids",
  "candidate_score",
  "candidate_reason",
  "candidate_generated_at",
  "first_seen_at",
  "last_seen_at",
  "occurrence_count",
  "status",
  "triggered_by_user_id",
  "review_started_at",
  "review_started_by",
  "backfill_cursor",
  "resolved_by",
  "resolved_at",
  "resolved_entity_id",
  "seed_source",
  "seed_source_id",
  "seed_aliases",
] as const;

async function createNewSlackTables(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("organization_domains")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("domain", "text", (col) => col.notNull())
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("verified_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("organization_domains_domain_unique", ["domain"])
    .execute();

  await db.schema
    .createTable("slack_user_sync_state")
    .addColumn("team_id", "text", (col) => col.notNull())
    .addColumn("slack_user_id", "text", (col) => col.notNull())
    .addColumn("name", "text")
    .addColumn("real_name", "text")
    .addColumn("display_name", "text")
    .addColumn("email", "text")
    .addColumn("profile_team_id", "text")
    .addColumn("profile_json", "text")
    .addColumn("is_bot", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("is_guest", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("is_stranger", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("is_restricted", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("is_ultra_restricted", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("deleted", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("classification", "text")
    .addColumn("classification_source", "text")
    .addColumn("provider_updated_at", "text")
    .addColumn("fetched_at", "text")
    .addColumn("entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("inactive_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("slack_user_sync_state_pk", ["team_id", "slack_user_id"])
    .execute();

  await db.schema
    .createIndex("idx_slack_user_sync_state_entity")
    .on("slack_user_sync_state")
    .column("entity_id")
    .execute();

  await db.schema
    .createTable("slack_sync_runs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("team_id", "text", (col) => col.notNull())
    .addColumn("run_type", "text", (col) => col.notNull())
    .addColumn("trigger_key", "text", (col) => col.notNull())
    .addColumn("pinned_team_id", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("stage", "text")
    .addColumn("heartbeat_at", "text")
    .addColumn("users_cursor", "text")
    .addColumn("conversations_cursor", "text")
    .addColumn("members_cursor", "text")
    .addColumn("current_channel_id", "text")
    .addColumn("started_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("completed_at", "text")
    .addColumn("error", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("slack_sync_runs_team_trigger_unique", ["team_id", "trigger_key"])
    .execute();

  await db.schema
    .createIndex("idx_slack_sync_runs_status_heartbeat")
    .on("slack_sync_runs")
    .columns(["status", "heartbeat_at"])
    .execute();
}

async function rebuildReviewQueueForSqlite(db: Kysely<unknown>): Promise<void> {
  await sql`PRAGMA defer_foreign_keys = ON`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_entity_review_queue_status_last_seen`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_entity_review_queue_source_ref`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_entity_review_queue_seed_handle`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_entity_review_evidence_review`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_entity_review_evidence_seen_at`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_entity_review_domain_candidates_candidate`.execute(db);

  await sql`ALTER TABLE entity_review_evidence RENAME TO entity_review_evidence_159_old`.execute(db);
  await sql`ALTER TABLE entity_review_domain_candidates RENAME TO entity_review_domain_candidates_159_old`.execute(db);
  await sql`ALTER TABLE entity_review_queue RENAME TO entity_review_queue_159_old`.execute(db);

  await db.schema
    .createTable("entity_review_queue")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("proposed_name", "text", (col) => col.notNull())
    .addColumn("normalized_name", "text", (col) => col.notNull())
    .addColumn("entity_type", "text", (col) => col.notNull())
    .addColumn("source", "text")
    .addColumn("source_id", "text")
    .addColumn("proposed_email", "text")
    .addColumn("candidate_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("candidate_entity_ids", "text")
    .addColumn("candidate_score", "real")
    .addColumn("candidate_reason", "text")
    .addColumn("candidate_generated_at", "text")
    .addColumn("first_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("occurrence_count", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("triggered_by_user_id", "text", (col) => col.notNull())
    .addColumn("review_started_at", "text")
    .addColumn("review_started_by", "text")
    .addColumn("backfill_cursor", "text")
    .addColumn("resolved_by", "text")
    .addColumn("resolved_at", "text")
    .addColumn("resolved_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("seed_source", "text")
    .addColumn("seed_source_id", "text")
    .addColumn("seed_aliases", "text")
    .execute();

  const columnList = sql.raw(REVIEW_QUEUE_COLUMNS.join(", "));
  await sql`INSERT INTO entity_review_queue (${columnList})
    SELECT id, proposed_name, normalized_name, entity_type, source, source_id, proposed_email,
      candidate_entity_id, NULL, candidate_score, candidate_reason, candidate_generated_at,
      first_seen_at, last_seen_at, occurrence_count, status, triggered_by_user_id,
      review_started_at, review_started_by, backfill_cursor, resolved_by, resolved_at,
      resolved_entity_id, seed_source, seed_source_id, seed_aliases
    FROM entity_review_queue_159_old`.execute(db);

  await db.schema
    .createTable("entity_review_evidence")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("review_id", "text", (col) => col.notNull().references("entity_review_queue.id").onDelete("cascade"))
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("note", "text")
    .addColumn("seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("entity_review_evidence_unique", ["review_id", "indexed_file_id", "source"])
    .execute();
  await sql`INSERT INTO entity_review_evidence (id, review_id, indexed_file_id, source, note, seen_at)
    SELECT id, review_id, indexed_file_id, source, note, seen_at FROM entity_review_evidence_159_old`.execute(db);
  await db.schema
    .createIndex("idx_entity_review_evidence_review")
    .on("entity_review_evidence")
    .column("review_id")
    .execute();
  await db.schema
    .createIndex("idx_entity_review_evidence_seen_at")
    .on("entity_review_evidence")
    .column("seen_at")
    .execute();

  await db.schema
    .createTable("entity_review_domain_candidates")
    .addColumn("review_id", "text", (col) => col.notNull().references("entity_review_queue.id").onDelete("cascade"))
    .addColumn("domain_candidate_id", "text", (col) =>
      col.notNull().references("entity_candidates.id").onDelete("cascade"),
    )
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("entity_review_domain_candidates_pk", ["review_id", "domain_candidate_id"])
    .execute();
  await sql`INSERT INTO entity_review_domain_candidates (review_id, domain_candidate_id, created_at)
    SELECT review_id, domain_candidate_id, created_at FROM entity_review_domain_candidates_159_old`.execute(db);
  await db.schema
    .createIndex("idx_entity_review_domain_candidates_candidate")
    .on("entity_review_domain_candidates")
    .column("domain_candidate_id")
    .execute();

  await sql`DROP TABLE entity_review_evidence_159_old`.execute(db);
  await sql`DROP TABLE entity_review_domain_candidates_159_old`.execute(db);
  await sql`DROP TABLE entity_review_queue_159_old`.execute(db);

  await sql`CREATE INDEX idx_entity_review_queue_status_last_seen
    ON entity_review_queue(status, last_seen_at DESC)`.execute(db);
  await sql`CREATE UNIQUE INDEX uq_entity_review_queue_source_ref
    ON entity_review_queue(source, source_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX idx_entity_review_queue_seed_handle
    ON entity_review_queue(seed_source, seed_source_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX entity_review_queue_normalized_partial_unique
    ON entity_review_queue(normalized_name, entity_type) WHERE source IS NULL`.execute(db);
}

async function addReviewQueueColumnsAndIndexes(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await db.schema.alterTable("entity_review_queue").addColumn("candidate_entity_ids", "text").execute();
    await sql`ALTER TABLE entity_review_queue DROP CONSTRAINT IF EXISTS entity_review_queue_normalized_unique`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX entity_review_queue_normalized_partial_unique
      ON entity_review_queue(normalized_name, entity_type) WHERE source IS NULL`.execute(db);
    return;
  }

  await rebuildReviewQueueForSqlite(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("settings").addColumn("slack_team_id", "text").execute();
  await createNewSlackTables(db);
  await addReviewQueueColumnsAndIndexes(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DROP INDEX IF EXISTS entity_review_queue_normalized_partial_unique`.execute(db);
    await db.schema.alterTable("entity_review_queue").dropColumn("candidate_entity_ids").execute();
  }
  await db.schema.dropTable("slack_sync_runs").execute();
  await db.schema.dropTable("slack_user_sync_state").execute();
  await db.schema.dropTable("organization_domains").execute();
  await db.schema.alterTable("settings").dropColumn("slack_team_id").execute();
}

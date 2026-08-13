import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const SLICE_COLUMNS = [
  "id",
  "conversation_id",
  "first_message_id",
  "last_message_id",
  "started_at",
  "ended_at",
  "message_count",
  "denoised_message_ids",
  "flush_reason",
  "roster_snapshot",
  "salience_verdict",
  "salience_signals",
  "salience_claim_token",
  "salience_claimed_at",
  "indexed_file_id",
  "provider_thread_id",
  "created_at",
] as const;

const SLICE_COLUMN_LIST = SLICE_COLUMNS.join(", ");

/**
 * SQLite CHECK constraints are immutable, so changing flush_reason means rebuilding the table.
 * Foreign keys are disabled outside the transaction (the pragma is a no-op inside one) so that
 * dropping conversation_slices does not cascade-delete whatsapp_identity_candidates rows.
 */
async function rebuildSqliteSlices(db: Kysely<unknown>, includeLlmBoundary: boolean): Promise<void> {
  const flushReasonCheck = includeLlmBoundary
    ? "flush_reason IN ('gap', 'max_age', 'max_size', 'llm_boundary')"
    : "flush_reason IN ('gap', 'max_age', 'max_size')";
  const foreignKeys = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
  const wasEnabled = foreignKeys.rows[0]?.foreign_keys === 1;

  if (wasEnabled) await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    await db.transaction().execute(async (trx) => {
      await sql
        .raw(`
        CREATE TABLE conversation_slices_rebuild (
          id TEXT PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          first_message_id INTEGER NOT NULL,
          last_message_id INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          message_count INTEGER NOT NULL,
          denoised_message_ids TEXT,
          flush_reason TEXT NOT NULL CHECK (${flushReasonCheck}),
          roster_snapshot TEXT NOT NULL,
          salience_verdict TEXT CHECK (salience_verdict IS NULL OR salience_verdict IN ('kept', 'dropped')),
          salience_signals TEXT,
          salience_claim_token TEXT,
          salience_claimed_at TEXT,
          indexed_file_id TEXT REFERENCES indexed_files(id) ON DELETE SET NULL,
          provider_thread_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT conversation_slices_conversation_first_uidx UNIQUE (conversation_id, first_message_id)
        )
      `)
        .execute(trx);
      await sql
        .raw(`
        INSERT INTO conversation_slices_rebuild (${SLICE_COLUMN_LIST})
        SELECT ${SLICE_COLUMN_LIST} FROM conversation_slices
      `)
        .execute(trx);
      await sql`DROP TABLE conversation_slices`.execute(trx);
      await sql`ALTER TABLE conversation_slices_rebuild RENAME TO conversation_slices`.execute(trx);
      await sql`
        CREATE INDEX idx_conversation_slices_conversation_time
        ON conversation_slices(conversation_id, started_at, first_message_id)
      `.execute(trx);
      await sql`
        CREATE INDEX idx_conversation_slices_indexed_file
        ON conversation_slices(indexed_file_id)
      `.execute(trx);
      await sql`
        CREATE INDEX idx_conversation_slices_pending_salience
        ON conversation_slices(salience_verdict)
        WHERE salience_verdict IS NULL
      `.execute(trx);
      await sql`
        CREATE INDEX idx_conversation_slices_provider_thread
        ON conversation_slices(conversation_id, provider_thread_id)
      `.execute(trx);
    });
  } finally {
    if (wasEnabled) await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

async function updatePostgresConstraint(db: Kysely<unknown>, includeLlmBoundary: boolean): Promise<void> {
  await sql`
    ALTER TABLE conversation_slices
    DROP CONSTRAINT IF EXISTS conversation_slices_flush_reason_check
  `.execute(db);
  if (includeLlmBoundary) {
    await sql`
      ALTER TABLE conversation_slices
      ADD CONSTRAINT conversation_slices_flush_reason_check
      CHECK (flush_reason IN ('gap', 'max_age', 'max_size', 'llm_boundary'))
    `.execute(db);
  } else {
    await sql`
      ALTER TABLE conversation_slices
      ADD CONSTRAINT conversation_slices_flush_reason_check
      CHECK (flush_reason IN ('gap', 'max_age', 'max_size'))
    `.execute(db);
  }
}

async function updateConstraint(db: Kysely<unknown>, includeLlmBoundary: boolean): Promise<void> {
  if (isPg(db)) {
    await updatePostgresConstraint(db, includeLlmBoundary);
    return;
  }
  await rebuildSqliteSlices(db, includeLlmBoundary);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await updateConstraint(db, true);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await updateConstraint(db, false);
}

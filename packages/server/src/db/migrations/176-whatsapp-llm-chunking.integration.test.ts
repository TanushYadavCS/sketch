import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, createTestPgDb } from "../../test-utils";
import { isPg } from "../dialect";
import { createMigrator } from "../migrate";
import type { DB } from "../schema";

const PRE_PHASE_ONE_MIGRATION = "166-scheduled-task-builder-locks";

async function migrateToPhaseOne(db: Kysely<DB>): Promise<void> {
  const result = await createMigrator(db).migrateToLatest();
  expect(result.error).toBeUndefined();
}

async function rewindToPrePhaseOne(db: Kysely<DB>): Promise<void> {
  const result = await createMigrator(db).migrateTo(PRE_PHASE_ONE_MIGRATION);
  expect(result.error).toBeUndefined();
}

async function seedConversation(db: Kysely<DB>, jid: string): Promise<number> {
  await db.insertInto("whatsapp_groups").values({ jid, name: "Migration Group", description: null }).execute();
  const conversation = await db
    .insertInto("conversations")
    .values({ platform: "whatsapp", kind: "group", provider_conversation_id: jid, display_name: "Migration Group" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return conversation.id;
}

async function seedSliceAndCandidate(db: Kysely<DB>, conversationId: number, jid: string): Promise<void> {
  await db
    .insertInto("conversation_slices")
    .values({
      id: "legacy-slice",
      conversation_id: conversationId,
      first_message_id: 1,
      last_message_id: 2,
      started_at: "2026-08-01T00:00:00.000Z",
      ended_at: "2026-08-01T00:05:00.000Z",
      message_count: 2,
      denoised_message_ids: "[1,2]",
      flush_reason: "gap",
      roster_snapshot: "[]",
      salience_verdict: "kept",
      salience_signals: "{}",
      salience_claim_token: null,
      salience_claimed_at: null,
      indexed_file_id: null,
      provider_thread_id: null,
    })
    .execute();
  await db
    .insertInto("whatsapp_identity_candidates")
    .values({
      group_jid: jid,
      candidate_ref: "candidate-1",
      participant_jid_ref: "participant-1",
      display_name: "Candidate",
      kept_slice_count: 1,
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_seen_at: "2026-08-01T00:05:00.000Z",
      last_slice_id: "legacy-slice",
    })
    .execute();
}

async function indexNames(db: Kysely<DB>): Promise<string[]> {
  if (isPg(db)) {
    const rows = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'conversation_slices'
      ORDER BY indexname
    `.execute(db);
    return rows.rows.map((row) => row.indexname);
  }
  const rows = await sql<{ name: string }>`PRAGMA index_list('conversation_slices')`.execute(db);
  return rows.rows.map((row) => row.name).sort();
}

function runMigrationSuite(label: string, createDb: () => Promise<Kysely<DB>>): void {
  describe(label, () => {
    let db!: Kysely<DB>;

    beforeEach(async () => {
      db = await createDb();
      await rewindToPrePhaseOne(db);
    }, 30000);

    afterEach(async () => {
      await db.destroy();
    });

    it("preserves identity candidates and all later slice columns and indexes during the SQLite-safe rebuild", async () => {
      const jid = "phase-one-preservation@g.us";
      const conversationId = await seedConversation(db, jid);
      await seedSliceAndCandidate(db, conversationId, jid);

      await migrateToPhaseOne(db);

      await expect(db.selectFrom("whatsapp_identity_candidates").selectAll().execute()).resolves.toEqual([
        expect.objectContaining({
          group_jid: jid,
          candidate_ref: "candidate-1",
          last_slice_id: "legacy-slice",
        }),
      ]);
      await expect(db.selectFrom("conversation_slices").selectAll().execute()).resolves.toEqual([
        expect.objectContaining({
          id: "legacy-slice",
          denoised_message_ids: "[1,2]",
          provider_thread_id: null,
          status: "closed",
          facts_enriched_content_hash: null,
        }),
      ]);

      const sliceColumns = (await db.introspection.getTables())
        .find((table) => table.name === "conversation_slices")
        ?.columns.map((column) => column.name);
      expect(sliceColumns).toEqual(
        expect.arrayContaining(["denoised_message_ids", "provider_thread_id", "status", "facts_enriched_content_hash"]),
      );
      expect(await indexNames(db)).toEqual(
        expect.arrayContaining([
          "idx_conversation_slices_conversation_time",
          "idx_conversation_slices_indexed_file",
          "idx_conversation_slices_pending_salience",
          "idx_conversation_slices_provider_thread",
          "conversation_slices_one_open_per_conversation_uidx",
        ]),
      );
      if (!isPg(db)) {
        await expect(sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db)).resolves.toMatchObject({
          rows: [{ foreign_keys: 1 }],
        });
      }
    });

    it("creates topic, group knob, conversion state, and manifest storage", async () => {
      const jid = "phase-one-schema@g.us";
      const conversationId = await seedConversation(db, jid);
      await seedSliceAndCandidate(db, conversationId, jid);
      await migrateToPhaseOne(db);

      await expect(
        db
          .selectFrom("whatsapp_groups")
          .select([
            "chunk_window_messages",
            "chunk_window_tokens",
            "chunk_model",
            "chunk_last_llm_attempt_at",
            "chunker_mode",
            "chunker_conversion_claim",
            "chunker_conversion_claimed_at",
          ])
          .where("jid", "=", jid)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        chunk_window_messages: null,
        chunk_window_tokens: null,
        chunk_model: null,
        chunk_last_llm_attempt_at: null,
        chunker_mode: "deterministic",
        chunker_conversion_claim: null,
        chunker_conversion_claimed_at: null,
      });

      await db
        .insertInto("conversation_topics")
        .values({
          id: "topic-1",
          conversation_id: conversationId,
          name: "Launch",
          one_liner: "Launch planning",
          status: "open",
          last_activity_at: "2026-08-01T00:00:00.000Z",
          canonical_topic_id: null,
        })
        .execute();
      await db.insertInto("slice_topics").values({ slice_id: "legacy-slice", topic_id: "topic-1" }).execute();
      await db
        .insertInto("topic_merges")
        .values({
          merged_topic_id: "topic-1",
          canonical_topic_id: "topic-1",
          reason: "normalization",
        })
        .execute();
      await db
        .insertInto("chunk_conversion_manifest")
        .values({
          id: "manifest-1",
          group_jid: jid,
          artifact_type: "slice",
          artifact_id: "legacy-slice",
          action: "archive",
          payload: "{}",
          restored_at: null,
        })
        .execute();

      await expect(db.selectFrom("slice_topics").selectAll().execute()).resolves.toEqual([
        { slice_id: "legacy-slice", topic_id: "topic-1" },
      ]);
      await expect(db.selectFrom("chunk_conversion_manifest").selectAll().execute()).resolves.toEqual([
        expect.objectContaining({ id: "manifest-1", group_jid: jid, restored_at: null }),
      ]);
    });

    it("backfills closed status and rejects a second open slice for one conversation", async () => {
      const jid = "phase-one-open-slice@g.us";
      const conversationId = await seedConversation(db, jid);
      await db
        .insertInto("conversation_slices")
        .values({
          id: "legacy-slice",
          conversation_id: conversationId,
          first_message_id: 1,
          last_message_id: 2,
          started_at: "2026-08-01T00:00:00.000Z",
          ended_at: "2026-08-01T00:05:00.000Z",
          message_count: 2,
          denoised_message_ids: null,
          flush_reason: "gap",
          roster_snapshot: "[]",
          salience_verdict: null,
          salience_signals: null,
          salience_claim_token: null,
          salience_claimed_at: null,
          indexed_file_id: null,
          provider_thread_id: null,
        })
        .execute();

      await migrateToPhaseOne(db);

      await expect(
        db
          .selectFrom("conversation_slices")
          .select("status")
          .where("id", "=", "legacy-slice")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: "closed" });
      const openSlice = {
        conversation_id: conversationId,
        first_message_id: 10,
        last_message_id: 11,
        started_at: "2026-08-01T01:00:00.000Z",
        ended_at: "2026-08-01T01:05:00.000Z",
        message_count: 2,
        denoised_message_ids: null,
        flush_reason: "llm_boundary" as const,
        roster_snapshot: "[]",
        salience_verdict: "kept",
        salience_signals: null,
        salience_claim_token: null,
        salience_claimed_at: null,
        indexed_file_id: null,
        provider_thread_id: null,
        status: "open" as const,
        facts_enriched_content_hash: null,
      };
      await db
        .insertInto("conversation_slices")
        .values({ id: "open-slice-1", ...openSlice })
        .execute();
      await expect(
        db
          .insertInto("conversation_slices")
          .values({ id: "open-slice-2", ...openSlice, first_message_id: 20, last_message_id: 21 })
          .execute(),
      ).rejects.toThrow();
    });
  });
}

runMigrationSuite("WhatsApp LLM chunking migrations SQLite", createTestDb);
runMigrationSuite("WhatsApp LLM chunking migrations Postgres", createTestPgDb);

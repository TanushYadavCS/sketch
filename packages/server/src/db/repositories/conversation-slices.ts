import { randomUUID } from "node:crypto";
import { type Insertable, type Kysely, type Selectable, sql } from "kysely";
import type {
  ConversationSliceCursorsTable,
  ConversationSliceStreamCursorsTable,
  ConversationSlicesTable,
  DB,
  WhatsAppBackfillCheckpointsTable,
} from "../schema";

export type ConversationSliceFlushReason = "gap" | "max_age" | "max_size";
export type ConversationSliceSalienceVerdict = "kept" | "dropped";
export type WhatsAppBackfillCheckpointStatus = "in_progress" | "complete" | "failed";

export type ConversationSliceRow = Selectable<ConversationSlicesTable>;
export type ConversationSliceCursorRow = Selectable<ConversationSliceCursorsTable>;
export type ConversationSliceStreamCursorRow = Selectable<ConversationSliceStreamCursorsTable>;
export type WhatsAppBackfillCheckpointRow = Selectable<WhatsAppBackfillCheckpointsTable>;

export interface ConversationSliceInsert {
  id?: string;
  conversationId: number;
  firstMessageId: number;
  lastMessageId: number;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  denoisedMessageIds?: number[] | null;
  flushReason: ConversationSliceFlushReason;
  rosterSnapshot: string;
  salienceVerdict?: ConversationSliceSalienceVerdict | null;
  salienceSignals?: string | null;
  indexedFileId?: string | null;
  providerThreadId?: string | null;
}

export interface StreamCursorClaim {
  conversationId: number;
  streamKey: string;
  claimToken: string;
  now: string;
  staleBefore: string;
}

export interface StreamCursorAdvanceIfClaimed {
  conversationId: number;
  streamKey: string;
  lastMessageId: number;
  claimToken: string;
}

export interface StreamCursorRelease {
  conversationId: number;
  streamKey: string;
  claimToken: string;
}

export interface ConversationSliceCursorAdvance {
  conversationId: number;
  lastEffectiveAt: string;
  lastMessageId: number;
}

export interface ConversationSliceCursorAdvanceIfClaimed extends ConversationSliceCursorAdvance {
  claimToken: string;
}

export interface ConversationSliceCursorClaim {
  conversationId: number;
  claimToken: string;
  now: string;
  staleBefore: string;
}

export interface ConversationSliceCursorRelease {
  conversationId: number;
  claimToken: string;
}

export interface ConversationSliceSalienceClaim {
  claimToken: string;
  now: string;
  staleBefore: string;
}

export interface WhatsAppBackfillCheckpointSet {
  groupJid: string;
  lastFetchedKey?: string | null;
  status: WhatsAppBackfillCheckpointStatus;
}

export interface WhatsAppLiveStartSet {
  groupJid: string;
  effectiveAt: string;
  messageId: number;
}

function toSliceInsert(input: ConversationSliceInsert): Insertable<ConversationSlicesTable> {
  return {
    id: input.id ?? randomUUID(),
    conversation_id: input.conversationId,
    first_message_id: input.firstMessageId,
    last_message_id: input.lastMessageId,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    message_count: input.messageCount,
    denoised_message_ids: input.denoisedMessageIds ? JSON.stringify(input.denoisedMessageIds) : null,
    flush_reason: input.flushReason,
    roster_snapshot: input.rosterSnapshot,
    salience_verdict: input.salienceVerdict ?? null,
    salience_signals: input.salienceSignals ?? null,
    salience_claim_token: null,
    salience_claimed_at: null,
    indexed_file_id: input.indexedFileId ?? null,
    provider_thread_id: input.providerThreadId ?? null,
  };
}

export function createConversationSlicesRepository(db: Kysely<DB>) {
  return {
    async insertIfAbsent(input: ConversationSliceInsert): Promise<{ row: ConversationSliceRow; created: boolean }> {
      const values = toSliceInsert(input);
      const result = await db
        .insertInto("conversation_slices")
        .values(values)
        .onConflict((oc) => oc.columns(["conversation_id", "first_message_id"]).doNothing())
        .executeTakeFirst();

      const row = await db
        .selectFrom("conversation_slices")
        .selectAll()
        .where("conversation_id", "=", input.conversationId)
        .where("first_message_id", "=", input.firstMessageId)
        .executeTakeFirstOrThrow();

      return { row, created: Number(result.numInsertedOrUpdatedRows ?? 0) > 0 };
    },

    async claimSalienceIfPending(sliceId: string, input: ConversationSliceSalienceClaim): Promise<boolean> {
      const result = await db
        .updateTable("conversation_slices")
        .set({
          salience_claim_token: input.claimToken,
          salience_claimed_at: input.now,
        })
        .where("id", "=", sliceId)
        .where("salience_verdict", "is", null)
        .where((eb) =>
          eb.or([eb("salience_claimed_at", "is", null), eb("salience_claimed_at", "<", input.staleBefore)]),
        )
        .executeTakeFirst();

      return Number(result.numUpdatedRows ?? 0) === 1;
    },

    async updateSalienceVerdictIfClaimed(
      sliceId: string,
      claimToken: string,
      input: {
        verdict: ConversationSliceSalienceVerdict;
        signals?: string | null;
        indexedFileId?: string | null;
        rosterSnapshot?: string;
      },
    ): Promise<ConversationSliceRow | undefined> {
      const result = await db
        .updateTable("conversation_slices")
        .set({
          salience_verdict: input.verdict,
          salience_signals: input.signals ?? null,
          salience_claim_token: null,
          salience_claimed_at: null,
          ...(input.indexedFileId !== undefined ? { indexed_file_id: input.indexedFileId } : {}),
          ...(input.rosterSnapshot !== undefined ? { roster_snapshot: input.rosterSnapshot } : {}),
        })
        .where("id", "=", sliceId)
        .where("salience_verdict", "is", null)
        .where("salience_claim_token", "=", claimToken)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows ?? 0) === 0) return undefined;
      return db.selectFrom("conversation_slices").selectAll().where("id", "=", sliceId).executeTakeFirstOrThrow();
    },

    /**
     * Clears indexed-file links on kept slices so the next emission pass
     * re-renders and re-upserts them (verdicts persist, no LLM re-judging).
     * Used when rendered content is stale, e.g. after a channel rename.
     */
    async unlinkKeptSliceFiles(conversationId: number): Promise<number> {
      const result = await db
        .updateTable("conversation_slices")
        .set({ indexed_file_id: null })
        .where("conversation_id", "=", conversationId)
        .where("salience_verdict", "=", "kept")
        .where("indexed_file_id", "is not", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    async clearSalienceClaim(sliceId: string, claimToken: string): Promise<boolean> {
      const result = await db
        .updateTable("conversation_slices")
        .set({
          salience_claim_token: null,
          salience_claimed_at: null,
        })
        .where("id", "=", sliceId)
        .where("salience_claim_token", "=", claimToken)
        .executeTakeFirst();

      return Number(result.numUpdatedRows ?? 0) === 1;
    },

    async getCursor(conversationId: number): Promise<ConversationSliceCursorRow | undefined> {
      return db
        .selectFrom("conversation_slice_cursors")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
    },

    async claimCursor(input: ConversationSliceCursorClaim): Promise<boolean> {
      await db
        .insertInto("conversation_slice_cursors")
        .values({
          conversation_id: input.conversationId,
          updated_at: input.now,
        })
        .onConflict((oc) => oc.column("conversation_id").doNothing())
        .execute();

      const result = await db
        .updateTable("conversation_slice_cursors")
        .set({
          claim_token: input.claimToken,
          claimed_at: input.now,
          updated_at: input.now,
        })
        .where("conversation_id", "=", input.conversationId)
        .where((eb) =>
          eb.or([
            eb("claim_token", "is", null),
            eb("claimed_at", "is", null),
            eb("claimed_at", "<", input.staleBefore),
          ]),
        )
        .executeTakeFirst();

      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async releaseCursorClaim(input: ConversationSliceCursorRelease): Promise<boolean> {
      const result = await db
        .updateTable("conversation_slice_cursors")
        .set({
          claim_token: null,
          claimed_at: null,
          updated_at: new Date().toISOString(),
        })
        .where("conversation_id", "=", input.conversationId)
        .where("claim_token", "=", input.claimToken)
        .executeTakeFirst();

      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async advanceCursor(input: ConversationSliceCursorAdvance): Promise<ConversationSliceCursorRow> {
      const now = new Date().toISOString();
      await db
        .insertInto("conversation_slice_cursors")
        .values({
          conversation_id: input.conversationId,
          last_effective_at: input.lastEffectiveAt,
          last_message_id: input.lastMessageId,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("conversation_id").doNothing())
        .execute();
      await db
        .updateTable("conversation_slice_cursors")
        .set({
          last_effective_at: input.lastEffectiveAt,
          last_message_id: input.lastMessageId,
          updated_at: now,
        })
        .where("conversation_id", "=", input.conversationId)
        .where((eb) =>
          eb.or([
            eb("last_effective_at", "is", null),
            eb("last_message_id", "is", null),
            eb("last_effective_at", "<", input.lastEffectiveAt),
            eb.and([
              eb("last_effective_at", "=", input.lastEffectiveAt),
              eb("last_message_id", "<", input.lastMessageId),
            ]),
          ]),
        )
        .execute();

      return db
        .selectFrom("conversation_slice_cursors")
        .selectAll()
        .where("conversation_id", "=", input.conversationId)
        .executeTakeFirstOrThrow();
    },

    async advanceCursorIfClaimed(
      input: ConversationSliceCursorAdvanceIfClaimed,
    ): Promise<ConversationSliceCursorRow | undefined> {
      const now = new Date().toISOString();
      const result = await db
        .updateTable("conversation_slice_cursors")
        .set({
          last_effective_at: input.lastEffectiveAt,
          last_message_id: input.lastMessageId,
          updated_at: now,
        })
        .where("conversation_id", "=", input.conversationId)
        .where("claim_token", "=", input.claimToken)
        .where((eb) =>
          eb.or([
            eb("last_effective_at", "is", null),
            eb("last_message_id", "is", null),
            eb("last_effective_at", "<", input.lastEffectiveAt),
            eb.and([
              eb("last_effective_at", "=", input.lastEffectiveAt),
              eb("last_message_id", "<", input.lastMessageId),
            ]),
          ]),
        )
        .executeTakeFirst();

      if (Number(result.numUpdatedRows ?? 0) === 0) return undefined;
      return db
        .selectFrom("conversation_slice_cursors")
        .selectAll()
        .where("conversation_id", "=", input.conversationId)
        .executeTakeFirstOrThrow();
    },

    async getStreamCursor(
      conversationId: number,
      streamKey: string,
    ): Promise<ConversationSliceStreamCursorRow | undefined> {
      return db
        .selectFrom("conversation_slice_stream_cursors")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("stream_key", "=", streamKey)
        .executeTakeFirst();
    },

    async listStreamCursors(conversationId: number): Promise<ConversationSliceStreamCursorRow[]> {
      return db
        .selectFrom("conversation_slice_stream_cursors")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .execute();
    },

    /**
     * Transactional stream discovery: inserts a cursor row for every discovered
     * stream key, then advances the router high-water mark. Callers must run
     * this inside a transaction so a crash cannot advance the router past a
     * stream whose cursor row was never persisted (which would orphan the
     * stream forever — discovery is the only thing that learns about new keys).
     */
    async ensureStreamCursorsAndAdvanceRouter(input: {
      conversationId: number;
      routerStreamKey: string;
      streamKeys: string[];
      routerHighWaterMessageId: number;
    }): Promise<void> {
      const now = new Date().toISOString();
      const keys = [...new Set([input.routerStreamKey, ...input.streamKeys])];
      for (const streamKey of keys) {
        await db
          .insertInto("conversation_slice_stream_cursors")
          .values({
            conversation_id: input.conversationId,
            stream_key: streamKey,
            updated_at: now,
          })
          .onConflict((oc) => oc.columns(["conversation_id", "stream_key"]).doNothing())
          .execute();
      }
      await db
        .updateTable("conversation_slice_stream_cursors")
        .set({ last_message_id: input.routerHighWaterMessageId, updated_at: now })
        .where("conversation_id", "=", input.conversationId)
        .where("stream_key", "=", input.routerStreamKey)
        .where((eb) =>
          eb.or([eb("last_message_id", "is", null), eb("last_message_id", "<", input.routerHighWaterMessageId)]),
        )
        .execute();
    },

    async claimStreamCursorIfPending(input: StreamCursorClaim): Promise<boolean> {
      await db
        .insertInto("conversation_slice_stream_cursors")
        .values({
          conversation_id: input.conversationId,
          stream_key: input.streamKey,
          updated_at: input.now,
        })
        .onConflict((oc) => oc.columns(["conversation_id", "stream_key"]).doNothing())
        .execute();

      const result = await db
        .updateTable("conversation_slice_stream_cursors")
        .set({ claim_token: input.claimToken, claimed_at: input.now, updated_at: input.now })
        .where("conversation_id", "=", input.conversationId)
        .where("stream_key", "=", input.streamKey)
        .where((eb) =>
          eb.or([
            eb("claim_token", "is", null),
            eb("claimed_at", "is", null),
            eb("claimed_at", "<", input.staleBefore),
          ]),
        )
        .executeTakeFirst();

      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async advanceStreamCursorIfClaimed(
      input: StreamCursorAdvanceIfClaimed,
    ): Promise<ConversationSliceStreamCursorRow | undefined> {
      const result = await db
        .updateTable("conversation_slice_stream_cursors")
        .set({ last_message_id: input.lastMessageId, updated_at: new Date().toISOString() })
        .where("conversation_id", "=", input.conversationId)
        .where("stream_key", "=", input.streamKey)
        .where("claim_token", "=", input.claimToken)
        .where((eb) => eb.or([eb("last_message_id", "is", null), eb("last_message_id", "<", input.lastMessageId)]))
        .executeTakeFirst();

      if (Number(result.numUpdatedRows ?? 0) === 0) return undefined;
      return db
        .selectFrom("conversation_slice_stream_cursors")
        .selectAll()
        .where("conversation_id", "=", input.conversationId)
        .where("stream_key", "=", input.streamKey)
        .executeTakeFirstOrThrow();
    },

    async releaseStreamCursorClaim(input: StreamCursorRelease): Promise<boolean> {
      const result = await db
        .updateTable("conversation_slice_stream_cursors")
        .set({ claim_token: null, claimed_at: null, updated_at: new Date().toISOString() })
        .where("conversation_id", "=", input.conversationId)
        .where("stream_key", "=", input.streamKey)
        .where("claim_token", "=", input.claimToken)
        .executeTakeFirst();

      return Number(result.numUpdatedRows ?? 0) > 0;
    },

    async getBackfillCheckpoint(groupJid: string): Promise<WhatsAppBackfillCheckpointRow | undefined> {
      return db
        .selectFrom("whatsapp_backfill_checkpoints")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .executeTakeFirst();
    },

    async recordLiveStartOnce(input: WhatsAppLiveStartSet): Promise<WhatsAppBackfillCheckpointRow> {
      await db
        .insertInto("whatsapp_backfill_checkpoints")
        .values({
          group_jid: input.groupJid,
          last_fetched_key: null,
          status: "in_progress",
          live_start_effective_at: input.effectiveAt,
          live_start_message_id: input.messageId,
        })
        .onConflict((oc) =>
          oc.column("group_jid").doUpdateSet({
            live_start_effective_at: sql`CASE
              WHEN whatsapp_backfill_checkpoints.live_start_message_id IS NULL
              THEN excluded.live_start_effective_at
              ELSE whatsapp_backfill_checkpoints.live_start_effective_at
            END`,
            live_start_message_id: sql`COALESCE(
              whatsapp_backfill_checkpoints.live_start_message_id,
              excluded.live_start_message_id
            )`,
          }),
        )
        .execute();

      return db
        .selectFrom("whatsapp_backfill_checkpoints")
        .selectAll()
        .where("group_jid", "=", input.groupJid)
        .executeTakeFirstOrThrow();
    },

    /**
     * Atomically merges backfill checkpoint writes. `last_fetched_key` records
     * the oldest eligible durable history row reached, so it only moves to the
     * lexical minimum key. `complete` is sticky because later racing partial or
     * failed batches cannot make a completed passive history delivery incomplete.
     */
    async setBackfillCheckpoint(input: WhatsAppBackfillCheckpointSet): Promise<WhatsAppBackfillCheckpointRow> {
      const updatedAt = new Date().toISOString();
      await db
        .insertInto("whatsapp_backfill_checkpoints")
        .values({
          group_jid: input.groupJid,
          last_fetched_key: input.lastFetchedKey ?? null,
          status: input.status,
          updated_at: updatedAt,
        })
        .onConflict((oc) =>
          oc.column("group_jid").doUpdateSet({
            last_fetched_key: sql`CASE
              WHEN whatsapp_backfill_checkpoints.last_fetched_key IS NULL THEN excluded.last_fetched_key
              WHEN excluded.last_fetched_key IS NULL THEN whatsapp_backfill_checkpoints.last_fetched_key
              WHEN excluded.last_fetched_key < whatsapp_backfill_checkpoints.last_fetched_key THEN excluded.last_fetched_key
              ELSE whatsapp_backfill_checkpoints.last_fetched_key
            END`,
            status: sql`CASE
              WHEN whatsapp_backfill_checkpoints.status = 'complete' THEN whatsapp_backfill_checkpoints.status
              WHEN excluded.status = 'complete' THEN excluded.status
              ELSE excluded.status
            END`,
            updated_at: updatedAt,
          }),
        )
        .execute();

      return db
        .selectFrom("whatsapp_backfill_checkpoints")
        .selectAll()
        .where("group_jid", "=", input.groupJid)
        .executeTakeFirstOrThrow();
    },
  };
}

import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable } from "kysely";
import type {
  ConversationSliceCursorsTable,
  ConversationSlicesTable,
  DB,
  WhatsAppBackfillCheckpointsTable,
} from "../schema";

export type ConversationSliceFlushReason = "gap" | "max_age" | "max_size";
export type ConversationSliceSalienceVerdict = "kept" | "dropped";
export type WhatsAppBackfillCheckpointStatus = "in_progress" | "complete" | "failed";

export type ConversationSliceRow = Selectable<ConversationSlicesTable>;
export type ConversationSliceCursorRow = Selectable<ConversationSliceCursorsTable>;
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

export interface WhatsAppBackfillCheckpointSet {
  groupJid: string;
  lastFetchedKey?: string | null;
  status: WhatsAppBackfillCheckpointStatus;
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
    indexed_file_id: input.indexedFileId ?? null,
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

    async updateSalienceVerdictIfPending(
      sliceId: string,
      input: {
        verdict: ConversationSliceSalienceVerdict;
        signals?: string | null;
        indexedFileId?: string | null;
      },
    ): Promise<ConversationSliceRow | undefined> {
      const result = await db
        .updateTable("conversation_slices")
        .set({
          salience_verdict: input.verdict,
          salience_signals: input.signals ?? null,
          ...(input.indexedFileId !== undefined ? { indexed_file_id: input.indexedFileId } : {}),
        })
        .where("id", "=", sliceId)
        .where("salience_verdict", "is", null)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows ?? 0) === 0) return undefined;
      return db.selectFrom("conversation_slices").selectAll().where("id", "=", sliceId).executeTakeFirstOrThrow();
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

    async getBackfillCheckpoint(groupJid: string): Promise<WhatsAppBackfillCheckpointRow | undefined> {
      return db
        .selectFrom("whatsapp_backfill_checkpoints")
        .selectAll()
        .where("group_jid", "=", groupJid)
        .executeTakeFirst();
    },

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
            last_fetched_key: input.lastFetchedKey ?? null,
            status: input.status,
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

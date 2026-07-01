import { type Insertable, type Kysely, type Selectable, sql } from "kysely";
import type { Attachment } from "../../files";
import { isPg } from "../dialect";
import type { ConversationCursorsTable, ConversationMessagesTable, ConversationsTable, DB } from "../schema";

export type ConversationRow = Selectable<ConversationsTable>;
export type ConversationCursorRow = Selectable<ConversationCursorsTable>;
export type ConversationMessageRow = Selectable<ConversationMessagesTable>;

export interface ConversationRef {
  platform: string;
  kind: string;
  providerConversationId: string;
}

export interface ConversationMessageInsert {
  conversationId: number;
  providerMessageId: string;
  senderJid?: string | null;
  senderName: string;
  senderUserId?: string | null;
  isBot?: boolean;
  addressedToSketch?: boolean;
  text?: string;
  attachments?: Attachment[];
  providerThreadId?: string | null;
  providerParentMessageId?: string | null;
  isThreadReply?: boolean;
  providerTimestamp?: string | null;
  receivedAt?: string;
}

export interface StoredConversationMessage {
  id: number;
  conversationId: number;
  providerMessageId: string;
  senderJid: string;
  senderName: string;
  senderUserId: string | null;
  isBot: boolean;
  addressedToSketch: boolean;
  text: string;
  attachments: Attachment[];
  providerThreadId: string | null;
  providerParentMessageId: string | null;
  isThreadReply: boolean;
  providerTimestamp: string | null;
  receivedAt: string;
  createdAt: string;
}

export interface ListConversationMessagesOptions {
  afterMessageId?: number;
  beforeMessageId?: number;
  limit?: number;
  order?: "asc" | "desc";
  includeBotMessages?: boolean;
  providerThreadId?: string | null;
}

export interface SearchConversationMessagesOptions {
  query: string;
  afterMessageId?: number;
  beforeMessageId?: number;
  limit?: number;
  includeBotMessages?: boolean;
  providerThreadId?: string | null;
}

export interface SearchConversationMessageResult extends StoredConversationMessage {
  rank: number;
}

interface RankedConversationMessageRow extends ConversationMessageRow {
  rank: number;
}

function parseAttachments(value: string | null): Attachment[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    return [];
  }
}

function toStored(row: ConversationMessageRow): StoredConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    providerMessageId: row.provider_message_id,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    senderUserId: row.sender_user_id,
    isBot: row.is_bot === 1,
    addressedToSketch: row.addressed_to_sketch === 1,
    text: row.text,
    attachments: parseAttachments(row.attachments),
    providerThreadId: row.provider_thread_id,
    providerParentMessageId: row.provider_parent_message_id,
    isThreadReply: row.is_thread_reply === 1,
    providerTimestamp: row.provider_timestamp,
    receivedAt: row.received_at,
    createdAt: row.created_at,
  };
}

function messageUniqueWhere(db: Kysely<DB>, data: ConversationMessageInsert) {
  return db
    .selectFrom("conversation_messages")
    .selectAll()
    .where("conversation_id", "=", data.conversationId)
    .where("provider_message_id", "=", data.providerMessageId)
    .where("sender_jid", "=", data.senderJid ?? "")
    .where("is_bot", "=", data.isBot ? 1 : 0);
}

function sanitizePostgresWebsearchQuery(input: string): string {
  return input.split("\0").join(" ").replace(/\s+/g, " ").trim();
}

function sanitizeSqliteFtsQuery(input: string): string {
  const words = input.match(/[\p{L}\p{N}_]+/gu)?.filter((word) => !/^(OR|AND|NOT|NEAR)$/i.test(word)) ?? [];
  return words.join(" OR ");
}

function rankedToStored(row: RankedConversationMessageRow): SearchConversationMessageResult {
  return { ...toStored(row), rank: Number(row.rank) };
}

export function createConversationRepository(db: Kysely<DB>) {
  return {
    async getOrCreate(ref: ConversationRef, displayName?: string | null): Promise<ConversationRow> {
      const existing = await db
        .selectFrom("conversations")
        .selectAll()
        .where("platform", "=", ref.platform)
        .where("kind", "=", ref.kind)
        .where("provider_conversation_id", "=", ref.providerConversationId)
        .executeTakeFirst();

      if (existing) {
        if (displayName !== undefined && displayName !== existing.display_name) {
          await db
            .updateTable("conversations")
            .set({ display_name: displayName, updated_at: new Date().toISOString() })
            .where("id", "=", existing.id)
            .execute();
          return db.selectFrom("conversations").selectAll().where("id", "=", existing.id).executeTakeFirstOrThrow();
        }
        return existing;
      }

      const values: Insertable<ConversationsTable> = {
        platform: ref.platform,
        kind: ref.kind,
        provider_conversation_id: ref.providerConversationId,
        display_name: displayName ?? null,
      };

      try {
        await db.insertInto("conversations").values(values).execute();
      } catch {
        const row = await db
          .selectFrom("conversations")
          .selectAll()
          .where("platform", "=", ref.platform)
          .where("kind", "=", ref.kind)
          .where("provider_conversation_id", "=", ref.providerConversationId)
          .executeTakeFirst();
        if (row) return row;
        throw new Error("Failed to create conversation");
      }

      return db
        .selectFrom("conversations")
        .selectAll()
        .where("platform", "=", ref.platform)
        .where("kind", "=", ref.kind)
        .where("provider_conversation_id", "=", ref.providerConversationId)
        .executeTakeFirstOrThrow();
    },

    async find(ref: ConversationRef): Promise<ConversationRow | undefined> {
      return db
        .selectFrom("conversations")
        .selectAll()
        .where("platform", "=", ref.platform)
        .where("kind", "=", ref.kind)
        .where("provider_conversation_id", "=", ref.providerConversationId)
        .executeTakeFirst();
    },

    async claimProviderConversationId(
      id: number,
      ref: ConversationRef,
      displayName?: string | null,
    ): Promise<ConversationRow> {
      const now = new Date().toISOString();
      const existing = await db
        .selectFrom("conversations")
        .selectAll()
        .where("platform", "=", ref.platform)
        .where("kind", "=", ref.kind)
        .where("provider_conversation_id", "=", ref.providerConversationId)
        .executeTakeFirst();
      if (existing) return existing;

      try {
        await db
          .updateTable("conversations")
          .set({
            provider_conversation_id: ref.providerConversationId,
            ...(displayName !== undefined ? { display_name: displayName } : {}),
            updated_at: now,
          })
          .where("id", "=", id)
          .execute();
      } catch {
        const row = await db
          .selectFrom("conversations")
          .selectAll()
          .where("platform", "=", ref.platform)
          .where("kind", "=", ref.kind)
          .where("provider_conversation_id", "=", ref.providerConversationId)
          .executeTakeFirst();
        if (row) return row;
        throw new Error("Failed to claim conversation provider id");
      }

      return db.selectFrom("conversations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async findMessageByProviderMessageId(
      conversationId: number,
      providerMessageId: string,
    ): Promise<StoredConversationMessage | undefined> {
      const row = await db
        .selectFrom("conversation_messages")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("provider_message_id", "=", providerMessageId)
        .orderBy("id", "desc")
        .executeTakeFirst();
      return row ? toStored(row) : undefined;
    },

    async insertMessage(
      data: ConversationMessageInsert,
    ): Promise<{ row: StoredConversationMessage; inserted: boolean }> {
      const existing = await messageUniqueWhere(db, data).executeTakeFirst();
      if (existing) return { row: toStored(existing), inserted: false };

      const values: Insertable<ConversationMessagesTable> = {
        conversation_id: data.conversationId,
        provider_message_id: data.providerMessageId,
        sender_jid: data.senderJid ?? "",
        sender_name: data.senderName,
        sender_user_id: data.senderUserId ?? null,
        is_bot: data.isBot ? 1 : 0,
        addressed_to_sketch: data.addressedToSketch ? 1 : 0,
        text: data.text ?? "",
        attachments: data.attachments && data.attachments.length > 0 ? JSON.stringify(data.attachments) : null,
        provider_thread_id: data.providerThreadId ?? null,
        provider_parent_message_id: data.providerParentMessageId ?? null,
        is_thread_reply: data.isThreadReply ? 1 : 0,
        provider_timestamp: data.providerTimestamp ?? null,
        received_at: data.receivedAt ?? new Date().toISOString(),
      };

      try {
        await db.insertInto("conversation_messages").values(values).execute();
      } catch {
        const row = await messageUniqueWhere(db, data).executeTakeFirst();
        if (row) return { row: toStored(row), inserted: false };
        throw new Error("Failed to insert conversation message");
      }

      const row = await messageUniqueWhere(db, data).executeTakeFirstOrThrow();
      return { row: toStored(row), inserted: true };
    },

    async listMessages(
      conversationId: number,
      options: ListConversationMessagesOptions = {},
    ): Promise<{ messages: StoredConversationMessage[]; hasMore: boolean; nextCursor?: number }> {
      const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
      let query = db.selectFrom("conversation_messages").selectAll().where("conversation_id", "=", conversationId);
      if (options.afterMessageId !== undefined) query = query.where("id", ">", options.afterMessageId);
      if (options.beforeMessageId !== undefined) query = query.where("id", "<", options.beforeMessageId);
      if (!options.includeBotMessages) query = query.where("is_bot", "=", 0);
      if (options.providerThreadId !== undefined) {
        if (options.providerThreadId === null) {
          query = query.where("provider_thread_id", "is", null);
        } else {
          query = query.where("provider_thread_id", "=", options.providerThreadId);
        }
      }

      const order = options.order ?? "asc";
      const rows = await query
        .orderBy("id", order)
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const visibleRows = rows.slice(0, limit);
      const messages = visibleRows.map(toStored);
      return {
        messages,
        hasMore,
        nextCursor: hasMore ? visibleRows[visibleRows.length - 1]?.id : undefined,
      };
    },

    async searchMessages(
      conversationId: number,
      options: SearchConversationMessagesOptions,
    ): Promise<{ messages: SearchConversationMessageResult[]; hasMore: boolean }> {
      const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
      const threadFilter =
        options.providerThreadId === undefined
          ? sql``
          : options.providerThreadId === null
            ? sql`AND m.provider_thread_id IS NULL`
            : sql`AND m.provider_thread_id = ${options.providerThreadId}`;
      const afterFilter = options.afterMessageId === undefined ? sql`` : sql`AND m.id > ${options.afterMessageId}`;
      const beforeFilter = options.beforeMessageId === undefined ? sql`` : sql`AND m.id < ${options.beforeMessageId}`;
      const botFilter = options.includeBotMessages ? sql`` : sql`AND m.is_bot = 0`;

      if (isPg(db)) {
        const pgQuery = sanitizePostgresWebsearchQuery(options.query);
        if (!pgQuery) return { messages: [], hasMore: false };

        const rows = await sql<RankedConversationMessageRow>`
          WITH q AS (
            SELECT websearch_to_tsquery('simple', ${pgQuery}) AS query
          )
          SELECT
            m.id,
            m.conversation_id,
            m.provider_message_id,
            m.sender_jid,
            m.sender_name,
            m.sender_user_id,
            m.is_bot,
            m.addressed_to_sketch,
            m.text,
            m.attachments,
            m.provider_thread_id,
            m.provider_parent_message_id,
            m.is_thread_reply,
            m.provider_timestamp,
            m.received_at,
            m.created_at,
            ts_rank(m.search_vector, q.query) AS rank
          FROM conversation_messages m, q
          WHERE m.conversation_id = ${conversationId}
            ${botFilter}
            ${afterFilter}
            ${beforeFilter}
            ${threadFilter}
            AND m.search_vector @@ q.query
          ORDER BY rank DESC, m.id DESC
          LIMIT ${limit + 1}
        `.execute(db);

        const visibleRows = rows.rows.slice(0, limit);
        return {
          messages: visibleRows.map(rankedToStored),
          hasMore: rows.rows.length > limit,
        };
      }

      const ftsQuery = sanitizeSqliteFtsQuery(options.query);
      if (!ftsQuery) return { messages: [], hasMore: false };

      const rows = await sql<RankedConversationMessageRow>`
        SELECT
          m.id,
          m.conversation_id,
          m.provider_message_id,
          m.sender_jid,
          m.sender_name,
          m.sender_user_id,
          m.is_bot,
          m.addressed_to_sketch,
          m.text,
          m.attachments,
          m.provider_thread_id,
          m.provider_parent_message_id,
          m.is_thread_reply,
          m.provider_timestamp,
          m.received_at,
          m.created_at,
          bm25(conversation_messages_fts, 5.0, 1.0) AS rank
        FROM conversation_messages_fts
        INNER JOIN conversation_messages m ON m.id = conversation_messages_fts.rowid
        WHERE conversation_messages_fts MATCH ${ftsQuery}
          AND m.conversation_id = ${conversationId}
          ${botFilter}
          ${afterFilter}
          ${beforeFilter}
          ${threadFilter}
        ORDER BY rank, m.id DESC
        LIMIT ${limit + 1}
      `.execute(db);

      const visibleRows = rows.rows.slice(0, limit);
      return {
        messages: visibleRows.map(rankedToStored),
        hasMore: rows.rows.length > limit,
      };
    },

    async listBacklog(params: {
      conversationId: number;
      afterMessageId?: number | null;
      beforeMessageId: number;
      limit?: number;
      providerThreadId?: string | null;
    }): Promise<{ messages: StoredConversationMessage[]; hasMore: boolean; nextCursor?: number }> {
      return this.listMessages(params.conversationId, {
        afterMessageId: params.afterMessageId ?? undefined,
        beforeMessageId: params.beforeMessageId,
        limit: params.limit,
        order: "asc",
        includeBotMessages: false,
        providerThreadId: params.providerThreadId,
      });
    },

    async getMaxMessageId(
      conversationId: number,
      options: { providerThreadId?: string | null } = {},
    ): Promise<number | null> {
      let query = db
        .selectFrom("conversation_messages")
        .select((eb) => eb.fn.max<number>("id").as("max_id"))
        .where("conversation_id", "=", conversationId);
      if (options.providerThreadId !== undefined) {
        if (options.providerThreadId === null) {
          query = query.where("provider_thread_id", "is", null);
        } else {
          query = query.where("provider_thread_id", "=", options.providerThreadId);
        }
      }
      const row = await query.executeTakeFirst();
      return row?.max_id ?? null;
    },

    async updateWatermark(conversationId: number, messageId: number | null): Promise<ConversationRow> {
      await db
        .updateTable("conversations")
        .set({ last_seen_message_id: messageId, updated_at: new Date().toISOString() })
        .where("id", "=", conversationId)
        .execute();
      return db.selectFrom("conversations").selectAll().where("id", "=", conversationId).executeTakeFirstOrThrow();
    },

    async advanceWatermarkToCurrentMax(conversationId: number): Promise<ConversationRow> {
      const maxId = await this.getMaxMessageId(conversationId);
      return this.updateWatermark(conversationId, maxId);
    },

    async getCursor(params: {
      conversationId: number;
      scopeType: string;
      scopeKey: string;
    }): Promise<ConversationCursorRow | undefined> {
      return db
        .selectFrom("conversation_cursors")
        .selectAll()
        .where("conversation_id", "=", params.conversationId)
        .where("scope_type", "=", params.scopeType)
        .where("scope_key", "=", params.scopeKey)
        .executeTakeFirst();
    },

    async updateCursor(params: {
      conversationId: number;
      scopeType: string;
      scopeKey: string;
      messageId: number | null;
    }): Promise<ConversationCursorRow> {
      const existing = await this.getCursor(params);
      if (existing) {
        await db
          .updateTable("conversation_cursors")
          .set({ last_seen_message_id: params.messageId, updated_at: new Date().toISOString() })
          .where("id", "=", existing.id)
          .execute();
      } else {
        const values: Insertable<ConversationCursorsTable> = {
          conversation_id: params.conversationId,
          scope_type: params.scopeType,
          scope_key: params.scopeKey,
          last_seen_message_id: params.messageId,
        };
        try {
          await db.insertInto("conversation_cursors").values(values).execute();
        } catch {
          const row = await this.getCursor(params);
          if (!row) throw new Error("Failed to create conversation cursor");
          await db
            .updateTable("conversation_cursors")
            .set({ last_seen_message_id: params.messageId, updated_at: new Date().toISOString() })
            .where("id", "=", row.id)
            .execute();
        }
      }
      return db
        .selectFrom("conversation_cursors")
        .selectAll()
        .where("conversation_id", "=", params.conversationId)
        .where("scope_type", "=", params.scopeType)
        .where("scope_key", "=", params.scopeKey)
        .executeTakeFirstOrThrow();
    },

    async advanceCursorToCurrentMax(params: {
      conversationId: number;
      scopeType: string;
      scopeKey: string;
      providerThreadId?: string | null;
    }): Promise<ConversationCursorRow> {
      const maxId = await this.getMaxMessageId(params.conversationId, {
        providerThreadId: params.providerThreadId,
      });
      return this.updateCursor({ ...params, messageId: maxId });
    },
  };
}

import { type Expression, type Insertable, type Kysely, type Selectable, type Transaction, sql } from "kysely";
import type { Attachment } from "../../files";
import { effectiveWhatsAppMessageTimestamp } from "../../whatsapp/provider-timestamp";
import { isPg } from "../dialect";
import type { ConversationCursorsTable, ConversationMessagesTable, ConversationsTable, DB } from "../schema";

export type ConversationRow = Selectable<ConversationsTable>;
export type ConversationCursorRow = Selectable<ConversationCursorsTable>;
export type ConversationMessageRow = Selectable<ConversationMessagesTable>;
export type ConversationMessageSource = "live" | "history";
type ConversationDb = Kysely<DB> | Transaction<DB>;

export interface ConversationRef {
  platform: string;
  kind: string;
  providerConversationId: string;
}

export interface ConversationMessageInsert {
  conversationId: number;
  providerMessageId: string;
  eventKey?: string | null;
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
  providerFromMe?: boolean;
  receivedAt?: string;
  source?: ConversationMessageSource;
  connectionKey?: string | null;
  backfillRangeId?: string | null;
}

export interface StoredConversationMessage {
  id: number;
  conversationId: number;
  providerMessageId: string;
  eventKey?: string | null;
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
  providerFromMe?: boolean;
  receivedAt: string;
  source: ConversationMessageSource;
  effectiveAt: string;
  connectionKey: string | null;
  backfillRangeId: string | null;
  createdAt: string;
}

export interface ListConversationMessagesOptions {
  afterMessageId?: number;
  beforeMessageId?: number;
  limit?: number;
  order?: "asc" | "desc";
  includeBotMessages?: boolean;
  providerThreadId?: string | null;
  isThreadReply?: boolean;
}

export interface ListConversationMessagesInWindowOptions {
  afterReceivedAt: string;
  beforeReceivedAt: string;
  limit?: number;
  includeBotMessages?: boolean;
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

/**
 * Cross-conversation search takes authorization as an opaque conversation-id
 * subquery built by the caller (the tool layer owns the membership predicate,
 * mirroring how the history tools colocate their authz joins). Embedding the
 * subquery keeps this a single statement per dialect with no unbounded IN
 * parameter list. Rank stays internal: dialect rank scales differ (ts_rank
 * DESC vs bm25 ASC), so the contract is best-first ordering, not a number.
 *
 * hasMore is a truncation signal, not a pagination contract: results are
 * relevance-ordered, and the row-id bounds cannot resume a rank order, so
 * callers refine the query or raise the limit instead of paging. Matches the
 * single-conversation searchMessages semantics.
 */
export interface SearchMessagesAcrossConversationsOptions {
  query: string;
  authorizedConversationIds: Expression<unknown>;
  currentConversationId?: number;
  afterMessageId?: number;
  beforeMessageId?: number;
  limit?: number;
  includeBotMessages?: boolean;
}

export interface CrossConversationSearchMessage extends StoredConversationMessage {
  conversationPlatform: string;
  conversationKind: string;
  conversationDisplayName: string | null;
}

interface CrossConversationRankedRow extends RankedConversationMessageRow {
  conversation_platform: string;
  conversation_kind: string;
  conversation_display_name: string | null;
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
    eventKey: row.event_key,
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
    providerFromMe: row.provider_from_me === 1,
    receivedAt: row.received_at,
    source: row.source === "history" ? "history" : "live",
    effectiveAt: row.effective_at ?? effectiveWhatsAppMessageTimestamp(row.provider_timestamp, row.received_at),
    connectionKey: row.connection_key ?? null,
    backfillRangeId: row.backfill_range_id ?? null,
    createdAt: row.created_at,
  };
}

function legacyMessageUniqueWhere(db: ConversationDb, data: ConversationMessageInsert) {
  return db
    .selectFrom("conversation_messages")
    .selectAll()
    .where("conversation_id", "=", data.conversationId)
    .where("provider_message_id", "=", data.providerMessageId)
    .where("sender_jid", "=", data.senderJid ?? "")
    .where("is_bot", "=", data.isBot ? 1 : 0);
}

async function findExistingMessage(db: ConversationDb, data: ConversationMessageInsert) {
  if (data.eventKey) {
    const byEventKey = await db
      .selectFrom("conversation_messages")
      .selectAll()
      .where("event_key", "=", data.eventKey)
      .executeTakeFirst();
    if (byEventKey) return byEventKey;
  }
  if (data.source === "history" && data.providerFromMe && !data.isBot) {
    const legacyOutbound = await db
      .selectFrom("conversation_messages")
      .selectAll()
      .where("conversation_id", "=", data.conversationId)
      .where("provider_message_id", "=", data.providerMessageId)
      .where("is_bot", "=", 1)
      .orderBy("id", "asc")
      .executeTakeFirst();
    if (legacyOutbound) return legacyOutbound;
  }
  return legacyMessageUniqueWhere(db, data).executeTakeFirst();
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

function crossConversationRowToStored(row: CrossConversationRankedRow): CrossConversationSearchMessage {
  return {
    ...toStored(row),
    conversationPlatform: row.conversation_platform,
    conversationKind: row.conversation_kind,
    conversationDisplayName: row.conversation_display_name,
  };
}

function mergeSeenMessageId(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Math.min(left, right);
}
function whatsappPhoneSenderCandidates(phoneE164?: string | null): string[] {
  const phone = phoneE164?.trim();
  if (!phone) return [];
  const digits = phone.replace(/\D/gu, "");
  return [phone, digits ? `${digits}@s.whatsapp.net` : null, digits || null, `wati:${phone}`].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
  );
}

export function createConversationRepository(db: ConversationDb) {
  async function reconcileOutboundIdentity(
    row: ConversationMessageRow,
    data: ConversationMessageInsert,
  ): Promise<ConversationMessageRow> {
    if (!row.is_bot || !data.providerFromMe || !data.eventKey) return row;
    await db
      .updateTable("conversation_messages")
      .set({ event_key: data.eventKey, provider_from_me: 1 })
      .where("id", "=", row.id)
      .where("event_key", "is", null)
      .execute();
    return db.selectFrom("conversation_messages").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
  }

  async function stampBackfillRangeIfUnowned(
    row: ConversationMessageRow,
    backfillRangeId: string | null | undefined,
  ): Promise<ConversationMessageRow> {
    if (!backfillRangeId || row.backfill_range_id) return row;
    await db
      .updateTable("conversation_messages")
      .set({ backfill_range_id: backfillRangeId })
      .where("id", "=", row.id)
      .where("backfill_range_id", "is", null)
      .execute();
    return db.selectFrom("conversation_messages").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
  }

  async function insertMessage(
    data: ConversationMessageInsert,
  ): Promise<{ row: StoredConversationMessage; inserted: boolean }> {
    const existing = await findExistingMessage(db, data);
    if (existing) {
      const reconciled = await reconcileOutboundIdentity(existing, data);
      return { row: toStored(await stampBackfillRangeIfUnowned(reconciled, data.backfillRangeId)), inserted: false };
    }

    const receivedAt = data.receivedAt ?? new Date().toISOString();
    const values: Insertable<ConversationMessagesTable> = {
      conversation_id: data.conversationId,
      provider_message_id: data.providerMessageId,
      event_key: data.eventKey ?? null,
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
      provider_from_me: data.providerFromMe ? 1 : 0,
      received_at: receivedAt,
      source: data.source ?? "live",
      effective_at: effectiveWhatsAppMessageTimestamp(data.providerTimestamp, receivedAt),
      connection_key: data.connectionKey ?? null,
      backfill_range_id: data.backfillRangeId ?? null,
    };

    try {
      await db.insertInto("conversation_messages").values(values).execute();
    } catch {
      const row = await findExistingMessage(db, data);
      if (row) {
        const reconciled = await reconcileOutboundIdentity(row, data);
        return { row: toStored(await stampBackfillRangeIfUnowned(reconciled, data.backfillRangeId)), inserted: false };
      }
      throw new Error("Failed to insert conversation message");
    }

    const row = await findExistingMessage(db, data);
    if (!row) throw new Error("Inserted conversation message could not be loaded");
    return { row: toStored(row), inserted: true };
  }

  async function mergeConversationRows(
    sourceId: number,
    target: ConversationRow,
    displayName?: string | null,
  ): Promise<ConversationRow> {
    const now = new Date().toISOString();
    const source = await db.selectFrom("conversations").selectAll().where("id", "=", sourceId).executeTakeFirst();
    if (!source) return target;
    if (source.id === target.id) {
      if (displayName !== undefined && displayName !== target.display_name) {
        await db
          .updateTable("conversations")
          .set({ display_name: displayName, updated_at: now })
          .where("id", "=", target.id)
          .execute();
        return db.selectFrom("conversations").selectAll().where("id", "=", target.id).executeTakeFirstOrThrow();
      }
      return target;
    }

    async function findMergeDuplicate(
      message: Pick<ConversationMessageRow, "id" | "provider_message_id" | "event_key" | "sender_jid" | "is_bot">,
    ) {
      if (message.event_key) {
        const eventDuplicate = await db
          .selectFrom("conversation_messages")
          .select("id")
          .where("event_key", "=", message.event_key)
          .where("id", "!=", message.id)
          .executeTakeFirst();
        if (eventDuplicate) return eventDuplicate;
      }
      return db
        .selectFrom("conversation_messages")
        .select("id")
        .where("conversation_id", "=", target.id)
        .where("provider_message_id", "=", message.provider_message_id)
        .where("sender_jid", "=", message.sender_jid)
        .where("is_bot", "=", message.is_bot)
        .executeTakeFirst();
    }

    const sourceMessages = await db
      .selectFrom("conversation_messages")
      .select(["id", "provider_message_id", "event_key", "sender_jid", "is_bot"])
      .where("conversation_id", "=", source.id)
      .orderBy("id", "asc")
      .execute();

    for (const message of sourceMessages) {
      const duplicate = await findMergeDuplicate(message);

      if (duplicate) {
        await db.deleteFrom("conversation_messages").where("id", "=", message.id).execute();
        continue;
      }

      try {
        await db
          .updateTable("conversation_messages")
          .set({ conversation_id: target.id })
          .where("id", "=", message.id)
          .execute();
      } catch {
        const conflicting = await findMergeDuplicate(message);
        if (!conflicting) throw new Error("Failed to move legacy conversation message");
        await db.deleteFrom("conversation_messages").where("id", "=", message.id).execute();
      }
    }

    const sourceCursors = await db
      .selectFrom("conversation_cursors")
      .selectAll()
      .where("conversation_id", "=", source.id)
      .execute();

    for (const cursor of sourceCursors) {
      const existingCursor = await db
        .selectFrom("conversation_cursors")
        .selectAll()
        .where("conversation_id", "=", target.id)
        .where("scope_type", "=", cursor.scope_type)
        .where("scope_key", "=", cursor.scope_key)
        .executeTakeFirst();

      if (existingCursor) {
        await db
          .updateTable("conversation_cursors")
          .set({
            last_seen_message_id: mergeSeenMessageId(existingCursor.last_seen_message_id, cursor.last_seen_message_id),
            updated_at: now,
          })
          .where("id", "=", existingCursor.id)
          .execute();
        await db.deleteFrom("conversation_cursors").where("id", "=", cursor.id).execute();
        continue;
      }

      try {
        await db
          .updateTable("conversation_cursors")
          .set({ conversation_id: target.id, updated_at: now })
          .where("id", "=", cursor.id)
          .execute();
      } catch {
        const conflicting = await db
          .selectFrom("conversation_cursors")
          .selectAll()
          .where("conversation_id", "=", target.id)
          .where("scope_type", "=", cursor.scope_type)
          .where("scope_key", "=", cursor.scope_key)
          .executeTakeFirst();
        if (!conflicting) throw new Error("Failed to move legacy conversation cursor");
        await db
          .updateTable("conversation_cursors")
          .set({
            last_seen_message_id: mergeSeenMessageId(conflicting.last_seen_message_id, cursor.last_seen_message_id),
            updated_at: now,
          })
          .where("id", "=", conflicting.id)
          .execute();
        await db.deleteFrom("conversation_cursors").where("id", "=", cursor.id).execute();
      }
    }

    await db
      .updateTable("conversations")
      .set({
        ...(displayName !== undefined ? { display_name: displayName } : {}),
        last_seen_message_id: mergeSeenMessageId(target.last_seen_message_id, source.last_seen_message_id),
        updated_at: now,
      })
      .where("id", "=", target.id)
      .execute();
    await db.deleteFrom("conversations").where("id", "=", source.id).execute();

    return db.selectFrom("conversations").selectAll().where("id", "=", target.id).executeTakeFirstOrThrow();
  }

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

    async findLatestInboundWhatsAppDmFromRecipient(params: {
      recipientUserId: string;
      phoneE164?: string | null;
    }): Promise<StoredConversationMessage | undefined> {
      const senderJids = whatsappPhoneSenderCandidates(params.phoneE164);
      let query = db
        .selectFrom("conversation_messages")
        .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
        .selectAll("conversation_messages")
        .where("conversations.platform", "=", "whatsapp")
        .where("conversations.kind", "=", "dm")
        .where("conversation_messages.is_bot", "=", 0);

      if (senderJids.length > 0) {
        query = query.where(({ eb, or }) =>
          or([
            eb("conversation_messages.sender_user_id", "=", params.recipientUserId),
            eb("conversation_messages.sender_jid", "in", senderJids),
          ]),
        );
      } else {
        query = query.where("conversation_messages.sender_user_id", "=", params.recipientUserId);
      }

      const row = await query
        .orderBy("conversation_messages.received_at", "desc")
        .orderBy("conversation_messages.id", "desc")
        .executeTakeFirst();
      return row ? toStored(row) : undefined;
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
      if (existing) return mergeConversationRows(id, existing, displayName);

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
        if (row) return mergeConversationRows(id, row, displayName);
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

    async findMessageByEventKey(eventKey: string): Promise<StoredConversationMessage | undefined> {
      const row = await db
        .selectFrom("conversation_messages")
        .selectAll()
        .where("event_key", "=", eventKey)
        .executeTakeFirst();
      return row ? toStored(row) : undefined;
    },

    insertMessage,

    async captureOrGet(data: ConversationMessageInsert): Promise<StoredConversationMessage> {
      return (await insertMessage(data)).row;
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
      if (options.isThreadReply !== undefined) {
        query = query.where("is_thread_reply", "=", options.isThreadReply ? 1 : 0);
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

    async listMessagesInWindow(
      conversationId: number,
      options: ListConversationMessagesInWindowOptions,
    ): Promise<{ messages: StoredConversationMessage[]; hasMore: boolean }> {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
      let query = db
        .selectFrom("conversation_messages")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("received_at", ">", options.afterReceivedAt)
        .where("received_at", "<=", options.beforeReceivedAt);
      if (!options.includeBotMessages) query = query.where("is_bot", "=", 0);
      const rows = await query
        .orderBy("received_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();
      const visibleRows = rows.slice(0, limit).reverse();
      return {
        messages: visibleRows.map(toStored),
        hasMore: rows.length > limit,
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
            m.provider_from_me,
            m.received_at,
            m.source,
            m.effective_at,
            m.connection_key,
            m.backfill_range_id,
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
          m.provider_from_me,
          m.received_at,
          m.source,
          m.effective_at,
          m.connection_key,
          m.backfill_range_id,
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

    async searchMessagesAcrossConversations(
      options: SearchMessagesAcrossConversationsOptions,
    ): Promise<{ messages: CrossConversationSearchMessage[]; hasMore: boolean }> {
      const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
      const afterFilter = options.afterMessageId === undefined ? sql`` : sql`AND m.id > ${options.afterMessageId}`;
      const beforeFilter = options.beforeMessageId === undefined ? sql`` : sql`AND m.id < ${options.beforeMessageId}`;
      const botFilter = options.includeBotMessages ? sql`` : sql`AND m.is_bot = 0`;
      const currentConversationFilter =
        options.currentConversationId === undefined
          ? sql``
          : sql`OR m.conversation_id = ${options.currentConversationId}`;
      const scopeFilter = sql`AND (m.conversation_id IN (${options.authorizedConversationIds}) ${currentConversationFilter})`;

      if (isPg(db)) {
        const pgQuery = sanitizePostgresWebsearchQuery(options.query);
        if (!pgQuery) return { messages: [], hasMore: false };

        const rows = await sql<CrossConversationRankedRow>`
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
            m.provider_from_me,
            m.received_at,
            m.source,
            m.effective_at,
            m.connection_key,
            m.backfill_range_id,
            m.created_at,
            c.platform AS conversation_platform,
            c.kind AS conversation_kind,
            c.display_name AS conversation_display_name,
            ts_rank(m.search_vector, q.query) AS rank
          FROM conversation_messages m
          CROSS JOIN q
          INNER JOIN conversations c ON c.id = m.conversation_id
          WHERE m.search_vector @@ q.query
            ${scopeFilter}
            ${botFilter}
            ${afterFilter}
            ${beforeFilter}
          ORDER BY rank DESC, m.id DESC
          LIMIT ${limit + 1}
        `.execute(db);

        const visibleRows = rows.rows.slice(0, limit);
        return {
          messages: visibleRows.map(crossConversationRowToStored),
          hasMore: rows.rows.length > limit,
        };
      }

      const ftsQuery = sanitizeSqliteFtsQuery(options.query);
      if (!ftsQuery) return { messages: [], hasMore: false };

      const rows = await sql<CrossConversationRankedRow>`
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
          m.provider_from_me,
          m.received_at,
          m.source,
          m.effective_at,
          m.connection_key,
          m.backfill_range_id,
          m.created_at,
          c.platform AS conversation_platform,
          c.kind AS conversation_kind,
          c.display_name AS conversation_display_name,
          bm25(conversation_messages_fts, 5.0, 1.0) AS rank
        FROM conversation_messages_fts
        INNER JOIN conversation_messages m ON m.id = conversation_messages_fts.rowid
        INNER JOIN conversations c ON c.id = m.conversation_id
        WHERE conversation_messages_fts MATCH ${ftsQuery}
          ${scopeFilter}
          ${botFilter}
          ${afterFilter}
          ${beforeFilter}
        ORDER BY rank, m.id DESC
        LIMIT ${limit + 1}
      `.execute(db);

      const visibleRows = rows.rows.slice(0, limit);
      return {
        messages: visibleRows.map(crossConversationRowToStored),
        hasMore: rows.rows.length > limit,
      };
    },

    async listBacklog(params: {
      conversationId: number;
      afterMessageId?: number | null;
      beforeMessageId: number;
      limit?: number;
      providerThreadId?: string | null;
      isThreadReply?: boolean;
    }): Promise<{ messages: StoredConversationMessage[]; hasMore: boolean; nextCursor?: number }> {
      const result = await this.listMessages(params.conversationId, {
        afterMessageId: params.afterMessageId ?? undefined,
        beforeMessageId: params.beforeMessageId,
        limit: params.limit,
        order: "desc",
        includeBotMessages: false,
        providerThreadId: params.providerThreadId,
        isThreadReply: params.isThreadReply,
      });
      return { ...result, messages: result.messages.reverse() };
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

import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { ConversationTopicsTable, DB } from "../schema";

export type ConversationTopicRow = Selectable<ConversationTopicsTable>;

export interface ConversationTopicUpsert {
  conversationId: number;
  name: string;
  oneLiner?: string | null;
  activityAt: string;
  recordMerge?: boolean;
}

export interface ConversationTopicUpsertResult {
  topic: ConversationTopicRow;
  mergedTopicId?: string;
}

const TOPIC_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeConversationTopicName(name: string): string {
  return name.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function topicIsNewer(left: string, right: string): boolean {
  return left > right;
}

function staleBefore(activityAt: string): string {
  const activityMs = Date.parse(activityAt);
  if (!Number.isFinite(activityMs)) return new Date(0).toISOString();
  return new Date(activityMs - TOPIC_STALE_MS).toISOString();
}

export function createConversationTopicsRepository(db: Kysely<DB>) {
  return {
    async upsertTopic(input: ConversationTopicUpsert): Promise<ConversationTopicUpsertResult> {
      const normalizedName = normalizeConversationTopicName(input.name);
      if (!normalizedName) throw new Error("Conversation topic name cannot be empty");

      const existingTopics = await db
        .selectFrom("conversation_topics")
        .selectAll()
        .where("conversation_id", "=", input.conversationId)
        .execute();
      const trimmedName = input.name.trim();
      const exactName = existingTopics.find((topic) => topic.name === trimmedName);
      const existing =
        exactName ?? existingTopics.find((topic) => normalizeConversationTopicName(topic.name) === normalizedName);

      if (existing) {
        const canonicalTopicId = existing.canonical_topic_id ?? existing.id;
        const topic = await db
          .updateTable("conversation_topics")
          .set({
            one_liner: input.oneLiner ?? existing.one_liner,
            status: "open",
            last_activity_at: topicIsNewer(input.activityAt, existing.last_activity_at)
              ? input.activityAt
              : existing.last_activity_at,
            canonical_topic_id: existing.canonical_topic_id,
          })
          .where("id", "=", canonicalTopicId)
          .returningAll()
          .executeTakeFirstOrThrow();

        if (input.recordMerge && existing.name !== input.name.trim() && existing.id === canonicalTopicId) {
          const existingAlias = existingTopics.find(
            (topic) => topic.name === trimmedName && topic.canonical_topic_id === canonicalTopicId,
          );
          if (existingAlias) return { topic };
          const mergedTopicId = randomUUID();
          await db
            .insertInto("conversation_topics")
            .values({
              id: mergedTopicId,
              conversation_id: input.conversationId,
              name: trimmedName,
              one_liner: input.oneLiner ?? null,
              status: "stale",
              last_activity_at: input.activityAt,
              canonical_topic_id: canonicalTopicId,
            })
            .execute();
          await db
            .insertInto("topic_merges")
            .values({
              merged_topic_id: mergedTopicId,
              canonical_topic_id: canonicalTopicId,
              reason: "normalized_name_match",
            })
            .execute();
          return { topic, mergedTopicId };
        }

        return { topic };
      }

      const topic = await db
        .insertInto("conversation_topics")
        .values({
          id: randomUUID(),
          conversation_id: input.conversationId,
          name: input.name.trim(),
          one_liner: input.oneLiner ?? null,
          status: "open",
          last_activity_at: input.activityAt,
          canonical_topic_id: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { topic };
    },

    async markStale(conversationId: number, activityAt: string): Promise<number> {
      const result = await db
        .updateTable("conversation_topics")
        .set({ status: "stale" })
        .where("conversation_id", "=", conversationId)
        .where("status", "=", "open")
        .where("last_activity_at", "<", staleBefore(activityAt))
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },

    async listPromptRegistry(conversationId: number, activityAt: string, cap: number): Promise<ConversationTopicRow[]> {
      await this.markStale(conversationId, activityAt);
      return db
        .selectFrom("conversation_topics")
        .selectAll()
        .where("conversation_id", "=", conversationId)
        .where("status", "=", "open")
        .orderBy("last_activity_at", "desc")
        .orderBy("id", "asc")
        .limit(Math.max(0, cap))
        .execute();
    },

    async replaceSliceTopics(sliceId: string, topicIds: string[]): Promise<void> {
      await db.deleteFrom("slice_topics").where("slice_id", "=", sliceId).execute();
      const uniqueTopicIds = [...new Set(topicIds)];
      if (uniqueTopicIds.length === 0) return;
      await db
        .insertInto("slice_topics")
        .values(uniqueTopicIds.map((topicId) => ({ slice_id: sliceId, topic_id: topicId })))
        .onConflict((oc) => oc.columns(["slice_id", "topic_id"]).doNothing())
        .execute();
    },

    async listSliceTopics(sliceId: string): Promise<ConversationTopicRow[]> {
      return db
        .selectFrom("conversation_topics as topic")
        .innerJoin("slice_topics as link", "link.topic_id", "topic.id")
        .selectAll("topic")
        .where("link.slice_id", "=", sliceId)
        .orderBy("topic.name", "asc")
        .execute();
    },
  };
}

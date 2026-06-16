import { randomUUID } from "node:crypto";
import { type Insertable, type Kysely, type Selectable, sql } from "kysely";
import type { DB } from "../schema";

export const DAILY_BRIEF_AGENT_KEY = "daily_brief";
export const DAILY_BRIEF_AGENT_VERSION = "2026-06-daily-brief-v1";

export type DailyBriefStatus = "running" | "completed" | "failed";
export type DailyBriefTriggerType = "manual" | "scheduled";
export type DailyBriefSectionKey = "todos" | "customer_updates" | "active_projects";
export type DailyBriefPriority = "high" | "medium" | "low";
export type DailyBriefTodoLabel = "todo" | "in_progress" | "blocked" | "waiting" | "done";
export type DailyBriefCustomerUpdateLabel = "owed_follow_up" | "warm" | "inbound" | "stuck" | "cold" | "at_risk";
export type DailyBriefActiveProjectLabel = "active" | "at_risk" | "blocked" | "needs_attention";
export type DailyBriefItemLabel = DailyBriefTodoLabel | DailyBriefCustomerUpdateLabel | DailyBriefActiveProjectLabel;

export const DAILY_BRIEF_SECTION_LABELS = {
  todos: ["todo", "in_progress", "blocked", "waiting", "done"],
  customer_updates: ["owed_follow_up", "warm", "inbound", "stuck", "cold", "at_risk"],
  active_projects: ["active", "at_risk", "blocked", "needs_attention"],
} as const satisfies Record<DailyBriefSectionKey, readonly string[]>;

export const DAILY_BRIEF_ACTION_LABELS = {
  todos: ["Plan with Sketch", "Unblock with Sketch", "Review with Sketch"],
  customer_updates: [
    "Prepare with Sketch",
    "Draft follow-up",
    "Plan next step",
    "Catch me up",
    "Unblock with Sketch",
    "Review risk",
    "Plan re-engagement",
  ],
  active_projects: ["Catch me up"],
} as const satisfies Record<DailyBriefSectionKey, readonly string[]>;

export interface DailyBriefKnowledgeRefs {
  entityIds: string[];
  fileIds: string[];
  relationshipIds?: string[];
  mentionIds?: string[];
  sourceRefIds?: string[];
  factIds?: string[];
}

export interface DailyBriefMasthead {
  title: string;
  summary: string;
  generatedFor?: string;
}

export interface DailyBriefItemInput {
  sectionKey: DailyBriefSectionKey;
  title: string;
  summary: string;
  priority: DailyBriefPriority;
  label: DailyBriefItemLabel;
  displayRef?: string | null;
  actionType?: string | null;
  actionLabel?: string | null;
  actionPrompt?: string | null;
  sourceUrl?: string | null;
  knowledgeRefs: DailyBriefKnowledgeRefs;
  sortOrder: number;
}

export interface DailyBriefConfig {
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  timezone: string | null;
  maxItemsPerSection: number;
}

export type DailyBriefRow = Selectable<DB["daily_briefs"]>;
export type DailyBriefItemRow = Selectable<DB["daily_brief_items"]>;

type NewDailyBrief = Insertable<DB["daily_briefs"]>;
type NewDailyBriefItem = Insertable<DB["daily_brief_items"]>;

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}

function affectedRows(value: { numUpdatedRows?: bigint | number | string }): number {
  return Number(value.numUpdatedRows ?? 0);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

function toConfig(row: Selectable<DB["daily_brief_configs"]> | undefined): DailyBriefConfig {
  return {
    enabled: row ? row.enabled !== 0 : true,
    scheduleHour: row?.schedule_hour ?? 8,
    scheduleMinute: row?.schedule_minute ?? 0,
    timezone: row?.timezone ?? null,
    maxItemsPerSection: row?.max_items_per_section ?? 4,
  };
}

export interface DailyBriefWithItems {
  brief: DailyBriefRow;
  masthead: DailyBriefMasthead | null;
  items: Array<DailyBriefItemRow & { knowledgeRefs: DailyBriefKnowledgeRefs }>;
}

export function createDailyBriefRepository(db: Kysely<DB>) {
  return {
    async getConfig(userId: string): Promise<DailyBriefConfig> {
      const row = await db
        .selectFrom("daily_brief_configs")
        .selectAll()
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return toConfig(row);
    },

    async createRunning(params: {
      userId: string;
      briefDate: string;
      timezone: string;
      triggerType: DailyBriefTriggerType;
    }): Promise<{ row: DailyBriefRow; created: boolean }> {
      const now = new Date().toISOString();
      const row: NewDailyBrief = {
        id: randomUUID(),
        user_id: params.userId,
        brief_date: params.briefDate,
        timezone: params.timezone,
        status: "running",
        trigger_type: params.triggerType,
        agent_key: DAILY_BRIEF_AGENT_KEY,
        agent_version: DAILY_BRIEF_AGENT_VERSION,
        created_at: now,
        updated_at: now,
      };
      try {
        await db.insertInto("daily_briefs").values(row).execute();
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const existing = await db
          .selectFrom("daily_briefs")
          .selectAll()
          .where("user_id", "=", params.userId)
          .where("brief_date", "=", params.briefDate)
          .where("status", "=", "running")
          .executeTakeFirst();
        if (existing) return { row: existing, created: false };
        throw err;
      }
      return {
        row: await db.selectFrom("daily_briefs").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow(),
        created: true,
      };
    },

    async findRunning(userId: string, briefDate: string): Promise<DailyBriefRow | undefined> {
      return db
        .selectFrom("daily_briefs")
        .selectAll()
        .where("user_id", "=", userId)
        .where("brief_date", "=", briefDate)
        .where("status", "=", "running")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    },

    async findLatestAny(userId: string, briefDate: string): Promise<DailyBriefRow | undefined> {
      return db
        .selectFrom("daily_briefs")
        .selectAll()
        .where("user_id", "=", userId)
        .where("brief_date", "=", briefDate)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();
    },

    async findLatestCompleted(userId: string, briefDate: string): Promise<DailyBriefWithItems | null> {
      const brief = await db
        .selectFrom("daily_briefs")
        .selectAll()
        .where("user_id", "=", userId)
        .where("brief_date", "=", briefDate)
        .where("status", "=", "completed")
        .orderBy("generated_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();

      if (!brief) return null;
      const items = await db
        .selectFrom("daily_brief_items")
        .selectAll()
        .where("daily_brief_id", "=", brief.id)
        .orderBy("section_key", "asc")
        .orderBy("sort_order", "asc")
        .execute();

      return {
        brief,
        masthead: parseJson<DailyBriefMasthead>(brief.masthead_json),
        items: items.map((item) => ({
          ...item,
          knowledgeRefs: parseJson<DailyBriefKnowledgeRefs>(item.knowledge_refs_json) ?? { entityIds: [], fileIds: [] },
        })),
      };
    },

    async getByIdForUser(id: string, userId: string): Promise<DailyBriefWithItems | null> {
      const brief = await db
        .selectFrom("daily_briefs")
        .selectAll()
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!brief) return null;
      const items = await db
        .selectFrom("daily_brief_items")
        .selectAll()
        .where("daily_brief_id", "=", brief.id)
        .orderBy("section_key", "asc")
        .orderBy("sort_order", "asc")
        .execute();
      return {
        brief,
        masthead: parseJson<DailyBriefMasthead>(brief.masthead_json),
        items: items.map((item) => ({
          ...item,
          knowledgeRefs: parseJson<DailyBriefKnowledgeRefs>(item.knowledge_refs_json) ?? { entityIds: [], fileIds: [] },
        })),
      };
    },

    async completeBrief(params: {
      briefId: string;
      masthead: DailyBriefMasthead;
      rawPayload: unknown;
      items: DailyBriefItemInput[];
      agentRunId?: string | null;
    }): Promise<void> {
      const now = new Date().toISOString();
      await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("daily_briefs")
          .set({
            status: "completed",
            agent_run_id: params.agentRunId ?? null,
            masthead_json: JSON.stringify(params.masthead),
            raw_payload_json: JSON.stringify(params.rawPayload),
            error_message: null,
            generated_at: now,
            updated_at: now,
          })
          .where("id", "=", params.briefId)
          .where("status", "=", "running")
          .executeTakeFirst();
        if (affectedRows(updated) === 0) {
          throw new Error("Daily Brief generation is no longer running.");
        }
        await trx.deleteFrom("daily_brief_items").where("daily_brief_id", "=", params.briefId).execute();
        if (params.items.length > 0) {
          const rows: NewDailyBriefItem[] = params.items.map((item) => ({
            id: randomUUID(),
            daily_brief_id: params.briefId,
            section_key: item.sectionKey,
            title: item.title,
            summary: item.summary,
            priority: item.priority,
            label: item.label,
            display_ref: item.displayRef ?? null,
            action_type: item.actionType ?? null,
            action_label: item.actionLabel ?? null,
            action_prompt: item.actionPrompt ?? null,
            knowledge_refs_json: JSON.stringify(item.knowledgeRefs),
            source_url: item.sourceUrl ?? null,
            sort_order: item.sortOrder,
            created_at: now,
          }));
          await trx.insertInto("daily_brief_items").values(rows).execute();
        }
      });
    },

    async markFailed(briefId: string, message: string): Promise<void> {
      await db
        .updateTable("daily_briefs")
        .set({
          status: "failed",
          error_message: message,
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", briefId)
        .where("status", "=", "running")
        .execute();
    },

    async countKnownEntities(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const row = await db
        .selectFrom("entities")
        .select(sql<number>`COUNT(id)`.as("count"))
        .where("id", "in", ids)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async countKnownFiles(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const row = await db
        .selectFrom("indexed_files")
        .select(sql<number>`COUNT(id)`.as("count"))
        .where("id", "in", ids)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },
  };
}

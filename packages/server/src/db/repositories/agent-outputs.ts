import { randomUUID } from "node:crypto";
import { type Insertable, type Kysely, type Selectable, sql } from "kysely";
import type { DB } from "../schema";

export type AgentOutputStatus = "running" | "completed" | "failed";
export type AgentOutputTriggerType = "manual" | "scheduled";
export type AgentItemPriority = "high" | "medium" | "low";

export interface AgentKnowledgeRefs {
  entityIds: string[];
  fileIds: string[];
  relationshipIds?: string[];
  mentionIds?: string[];
  sourceRefIds?: string[];
  factIds?: string[];
}

export interface AgentMasthead {
  title: string;
  summary: string;
  generatedFor?: string;
}

export interface AgentOutputItemInput {
  sectionKey: string;
  title: string;
  summary: string;
  priority: AgentItemPriority;
  label: string;
  displayRef?: string | null;
  actionType?: string | null;
  actionLabel?: string | null;
  actionPrompt?: string | null;
  sourceUrl?: string | null;
  knowledgeRefs: AgentKnowledgeRefs;
  sortOrder: number;
}

export type AgentDeliveryPlatform = "slack" | "whatsapp";
export type AgentDeliveryTargetType = "channel" | "dm" | "group";

export interface AgentDeliveryConfig {
  enabled: true;
  platform: AgentDeliveryPlatform;
  targetType: AgentDeliveryTargetType;
  targetId: string;
  label: string | null;
}

/**
 * Per-user reconfiguration of a prebuilt agent. `prefs` carries the additive,
 * structured preferences (section toggles + plain-language focus); agent behavior
 * itself stays code-owned in the definition.
 */
export interface AgentUserPrefs {
  sections?: Record<string, boolean>;
  focus?: string | null;
  delivery?: AgentDeliveryConfig | null;
}

export interface AgentUserConfig {
  enabled: boolean;
  scheduleHour: number | null;
  scheduleMinute: number | null;
  timezone: string | null;
  maxItemsPerSection: number | null;
  prefs: AgentUserPrefs | null;
  exists: boolean;
}

export type AgentOutputRow = Selectable<DB["agent_outputs"]>;
export type AgentOutputItemRow = Selectable<DB["agent_output_items"]>;

type NewAgentOutput = Insertable<DB["agent_outputs"]>;
type NewAgentOutputItem = Insertable<DB["agent_output_items"]>;

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
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toConfig(row: Selectable<DB["agent_user_configs"]> | undefined): AgentUserConfig {
  if (!row) {
    return {
      enabled: true,
      scheduleHour: null,
      scheduleMinute: null,
      timezone: null,
      maxItemsPerSection: null,
      prefs: null,
      exists: false,
    };
  }
  return {
    enabled: row.enabled !== 0,
    scheduleHour: row.schedule_hour,
    scheduleMinute: row.schedule_minute,
    timezone: row.timezone ?? null,
    maxItemsPerSection: row.max_items_per_section,
    prefs: parseJson<AgentUserPrefs>(row.prefs_json),
    exists: true,
  };
}

export interface AgentOutputWithItems {
  output: AgentOutputRow;
  masthead: AgentMasthead | null;
  items: Array<AgentOutputItemRow & { knowledgeRefs: AgentKnowledgeRefs }>;
}

function withRefs(item: AgentOutputItemRow): AgentOutputItemRow & { knowledgeRefs: AgentKnowledgeRefs } {
  return {
    ...item,
    knowledgeRefs: parseJson<AgentKnowledgeRefs>(item.knowledge_refs_json) ?? { entityIds: [], fileIds: [] },
  };
}

export interface UpsertAgentConfigPatch {
  enabled?: boolean;
  scheduleHour?: number;
  scheduleMinute?: number;
  timezone?: string | null;
  maxItemsPerSection?: number;
  prefs?: AgentUserPrefs | null;
}

/**
 * Generic persistence for prebuilt-agent runs. Every read and write is scoped by
 * `agent_key` so multiple agents share the same tables without cross-contamination.
 */
export function createAgentOutputRepository(db: Kysely<DB>) {
  return {
    async getConfig(agentKey: string, userId: string): Promise<AgentUserConfig> {
      const row = await db
        .selectFrom("agent_user_configs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return toConfig(row);
    },

    async upsertConfig(
      agentKey: string,
      userId: string,
      patch: UpsertAgentConfigPatch,
      defaults: { scheduleHour: number; scheduleMinute: number; maxItemsPerSection: number; enabled: boolean },
    ): Promise<AgentUserConfig> {
      const now = new Date().toISOString();
      const enabled = patch.enabled ?? defaults.enabled;
      const scheduleHour = patch.scheduleHour ?? defaults.scheduleHour;
      const scheduleMinute = patch.scheduleMinute ?? defaults.scheduleMinute;
      const maxItems = patch.maxItemsPerSection ?? defaults.maxItemsPerSection;
      const prefsJson =
        patch.prefs === undefined ? undefined : patch.prefs === null ? null : JSON.stringify(patch.prefs);

      const updateSet: Record<string, unknown> = { updated_at: now };
      if (patch.enabled !== undefined) updateSet.enabled = enabled ? 1 : 0;
      if (patch.scheduleHour !== undefined) updateSet.schedule_hour = scheduleHour;
      if (patch.scheduleMinute !== undefined) updateSet.schedule_minute = scheduleMinute;
      if (patch.timezone !== undefined) updateSet.timezone = patch.timezone;
      if (patch.maxItemsPerSection !== undefined) updateSet.max_items_per_section = maxItems;
      if (patch.prefs !== undefined) updateSet.prefs_json = prefsJson;

      await db
        .insertInto("agent_user_configs")
        .values({
          agent_key: agentKey,
          user_id: userId,
          enabled: enabled ? 1 : 0,
          schedule_hour: scheduleHour,
          schedule_minute: scheduleMinute,
          timezone: patch.timezone ?? null,
          max_items_per_section: maxItems,
          prefs_json: prefsJson ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(["agent_key", "user_id"]).doUpdateSet(updateSet))
        .execute();

      return this.getConfig(agentKey, userId);
    },

    async createRunning(params: {
      agentKey: string;
      agentVersion: string;
      userId: string;
      outputDate: string;
      timezone: string;
      triggerType: AgentOutputTriggerType;
    }): Promise<{ row: AgentOutputRow; created: boolean }> {
      const now = new Date().toISOString();
      const row: NewAgentOutput = {
        id: randomUUID(),
        agent_key: params.agentKey,
        user_id: params.userId,
        output_date: params.outputDate,
        timezone: params.timezone,
        status: "running",
        trigger_type: params.triggerType,
        agent_version: params.agentVersion,
        created_at: now,
        updated_at: now,
      };
      try {
        await db.insertInto("agent_outputs").values(row).execute();
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const existing = await db
          .selectFrom("agent_outputs")
          .selectAll()
          .where("agent_key", "=", params.agentKey)
          .where("user_id", "=", params.userId)
          .where("output_date", "=", params.outputDate)
          .where("status", "=", "running")
          .executeTakeFirst();
        if (existing) return { row: existing, created: false };
        throw err;
      }
      return {
        row: await db.selectFrom("agent_outputs").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow(),
        created: true,
      };
    },

    async findById(agentKey: string, id: string): Promise<AgentOutputRow | undefined> {
      return db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async findRunning(agentKey: string, userId: string, outputDate: string): Promise<AgentOutputRow | undefined> {
      return db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("output_date", "=", outputDate)
        .where("status", "=", "running")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    },

    async findLatestAny(agentKey: string, userId: string, outputDate: string): Promise<AgentOutputRow | undefined> {
      return db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("output_date", "=", outputDate)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();
    },

    async findLatestCompleted(
      agentKey: string,
      userId: string,
      outputDate: string,
    ): Promise<AgentOutputWithItems | null> {
      const output = await db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("output_date", "=", outputDate)
        .where("status", "=", "completed")
        .orderBy("generated_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();
      if (!output) return null;
      const items = await db
        .selectFrom("agent_output_items")
        .selectAll()
        .where("agent_output_id", "=", output.id)
        .orderBy("section_key", "asc")
        .orderBy("sort_order", "asc")
        .execute();
      return {
        output,
        masthead: parseJson<AgentMasthead>(output.masthead_json),
        items: items.map(withRefs),
      };
    },

    async getByIdForUser(agentKey: string, id: string, userId: string): Promise<AgentOutputWithItems | null> {
      const output = await db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("id", "=", id)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!output) return null;
      const items = await db
        .selectFrom("agent_output_items")
        .selectAll()
        .where("agent_output_id", "=", output.id)
        .orderBy("section_key", "asc")
        .orderBy("sort_order", "asc")
        .execute();
      return {
        output,
        masthead: parseJson<AgentMasthead>(output.masthead_json),
        items: items.map(withRefs),
      };
    },

    async completeOutput(params: {
      outputId: string;
      masthead: AgentMasthead;
      rawPayload: unknown;
      items: AgentOutputItemInput[];
      agentRunId?: string | null;
    }): Promise<void> {
      const now = new Date().toISOString();
      await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("agent_outputs")
          .set({
            status: "completed",
            agent_run_id: params.agentRunId ?? null,
            masthead_json: JSON.stringify(params.masthead),
            raw_payload_json: JSON.stringify(params.rawPayload),
            error_message: null,
            generated_at: now,
            updated_at: now,
          })
          .where("id", "=", params.outputId)
          .where("status", "=", "running")
          .executeTakeFirst();
        if (affectedRows(updated) === 0) {
          throw new Error("Agent output generation is no longer running.");
        }
        await trx.deleteFrom("agent_output_items").where("agent_output_id", "=", params.outputId).execute();
        if (params.items.length > 0) {
          const rows: NewAgentOutputItem[] = params.items.map((item) => ({
            id: randomUUID(),
            agent_output_id: params.outputId,
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
          await trx.insertInto("agent_output_items").values(rows).execute();
        }
      });
    },

    async markFailed(outputId: string, message: string): Promise<void> {
      await db
        .updateTable("agent_outputs")
        .set({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
        .where("id", "=", outputId)
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

export type AgentOutputRepository = ReturnType<typeof createAgentOutputRepository>;

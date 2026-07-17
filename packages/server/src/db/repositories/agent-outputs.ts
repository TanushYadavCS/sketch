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

/** Section-specific structured data carried alongside the generic item shape. */
export type AgentStructuredPayload = Record<string, unknown>;

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
  structuredPayload?: AgentStructuredPayload | null;
  canonicalTaskId?: string | null;
  knowledgeRefs: AgentKnowledgeRefs;
  sortOrder: number;
}

export interface PersistedAgentOutputItemRef {
  id: string;
  sectionKey: string;
  sortOrder: number;
}

export type AgentDeliveryPlatform = "slack" | "whatsapp";
export type AgentDeliveryTargetType = "channel" | "dm" | "group";
export type AgentSourcePlatform = "slack" | "whatsapp";
export type AgentSourceTargetType = "channel" | "dm" | "group";

export interface AgentDeliveryMention {
  platform: AgentDeliveryPlatform;
  targetId: string;
  label: string | null;
}

export interface AgentDeliveryConfig {
  enabled: true;
  platform: AgentDeliveryPlatform;
  targetType: AgentDeliveryTargetType;
  targetId: string;
  label: string | null;
  recipientUserId?: string;
  mentions?: AgentDeliveryMention[];
}

export type AgentSourceKey = `${AgentSourcePlatform}:${AgentSourceTargetType}:${string}`;
export type AgentRouteFrequency = "daily" | "weekly" | "every_n_hours";

export interface AgentRouteSchedule {
  frequency: AgentRouteFrequency;
  hour: number;
  minute: number;
  daysOfWeek?: number[];
  intervalHours?: number;
}

export interface AgentCombinedDeliveryConfig extends AgentDeliveryConfig {
  ackNonDm?: true;
}

export type AgentPerSourceDelivery =
  | { kind: "self" }
  | { kind: "off" }
  | { kind: "target"; target: AgentDeliveryConfig };

export type AgentDeliveryModel =
  | {
      mode: "per_source";
      defaultRoute: "self" | "off";
      perSource: Record<string, AgentPerSourceDelivery>;
      combined: null;
    }
  | {
      mode: "combined";
      combined: AgentCombinedDeliveryConfig;
    };

export interface AgentSourceConfig {
  platform: AgentSourcePlatform;
  targetType: AgentSourceTargetType;
  targetId: string;
  label: string | null;
}

export type AgentRouteId = string;

export type AgentRouteDestination =
  | { kind: "self" }
  | { kind: "off" }
  | { kind: "member"; platform: "slack" | "whatsapp"; memberUserId: string }
  | { kind: "channel"; platform: "slack"; targetType: "channel"; targetId: string; label: string | null }
  | { kind: "channel"; platform: "whatsapp"; targetType: "group"; targetId: string; label: string | null };

export interface AgentRoute {
  id: AgentRouteId;
  sources: AgentSourceKey[];
  focus: string | null;
  sections: Record<string, boolean> | null;
  maxItemsPerSection: number | null;
  schedule: AgentRouteSchedule | null;
  destination: AgentRouteDestination;
  enabled: boolean;
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
  deliveryModel?: AgentDeliveryModel;
  sources?: AgentSourceConfig[];
  routes?: AgentRoute[];
  createTasks?: boolean;
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

export type AgentStoredItemRow = AgentOutputItemRow & {
  knowledgeRefs: AgentKnowledgeRefs;
  structuredPayload: AgentStructuredPayload | null;
};

export interface AgentOutputWithItems {
  output: AgentOutputRow;
  masthead: AgentMasthead | null;
  items: AgentStoredItemRow[];
}

export interface AgentOutputListResult {
  outputs: AgentOutputWithItems[];
  nextCursor: string | null;
}

export type SummarizerSeedCandidate = Omit<AgentOutputItemInput, "sectionKey" | "sortOrder"> & {
  outputId: string;
  sourceKey: string;
  origin: "action_item" | "task_candidate";
};

export interface AgentUserConfigWithOwner {
  userId: string;
  name: string;
  email: string | null;
  authRole: string;
  config: AgentUserConfig;
}

function withRefs(item: AgentOutputItemRow): AgentStoredItemRow {
  return {
    ...item,
    knowledgeRefs: parseJson<AgentKnowledgeRefs>(item.knowledge_refs_json) ?? { entityIds: [], fileIds: [] },
    structuredPayload: parseJson<AgentStructuredPayload>(item.structured_payload_json),
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function seedKnowledgeRefs(value: unknown): AgentKnowledgeRefs {
  const record = recordFromUnknown(value);
  const strings = (key: string): string[] =>
    Array.isArray(record?.[key]) ? record[key].filter((entry): entry is string => typeof entry === "string") : [];
  return {
    entityIds: strings("entityIds"),
    fileIds: strings("fileIds"),
    relationshipIds: strings("relationshipIds"),
    mentionIds: strings("mentionIds"),
    sourceRefIds: strings("sourceRefIds"),
    factIds: strings("factIds"),
  };
}

function seedCandidateFromRawItem(output: AgentOutputRow, value: unknown): SummarizerSeedCandidate | null {
  const item = recordFromUnknown(value);
  if (!item || item.sectionKey !== "task_candidates") return null;
  const title = stringOrNull(item.title);
  if (!title) return null;
  const priority = item.priority === "high" || item.priority === "low" ? item.priority : "medium";
  return {
    outputId: output.id,
    sourceKey: output.source_key,
    origin: "task_candidate",
    title,
    summary: stringOrNull(item.summary) ?? title,
    priority,
    label: stringOrNull(item.label) ?? "action_item",
    displayRef: stringOrNull(item.displayRef),
    actionType: stringOrNull(item.actionType),
    actionLabel: stringOrNull(item.actionLabel),
    actionPrompt: stringOrNull(item.actionPrompt),
    sourceUrl: stringOrNull(item.sourceUrl),
    structuredPayload: recordFromUnknown(item.structuredPayload),
    knowledgeRefs: seedKnowledgeRefs(item.knowledgeRefs),
  };
}

function normalizedIdentityValues(value: unknown, lowercase: boolean): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number")
        .map((entry) => String(entry).normalize("NFKC").trim())
        .filter(Boolean)
        .map((entry) => (lowercase ? entry.toLocaleLowerCase("en-US") : entry)),
    ),
  ].sort();
}

function seedCandidateIdentity(candidate: SummarizerSeedCandidate): string {
  const title = candidate.title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  const payload = recordFromUnknown(candidate.structuredPayload);
  return JSON.stringify([
    title,
    candidate.sourceKey,
    normalizedIdentityValues(payload?.sourceLabels, true),
    normalizedIdentityValues(payload?.messageIds, false),
  ]);
}

/**
 * Merges visible Summarizer action items with extraction-only task candidates
 * retained in raw output payloads. Inputs are expected newest-first; the first
 * occurrence wins so visible items and newer evidence remain canonical.
 */
export function extractSummarizerSeedCandidates(outputs: AgentOutputWithItems[]): SummarizerSeedCandidate[] {
  const candidates: SummarizerSeedCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: SummarizerSeedCandidate) => {
    const identity = seedCandidateIdentity(candidate);
    if (seen.has(identity)) return;
    seen.add(identity);
    candidates.push(candidate);
  };

  for (const entry of outputs) {
    for (const item of entry.items) {
      if (item.section_key !== "action_items") continue;
      add({
        outputId: entry.output.id,
        sourceKey: entry.output.source_key,
        origin: "action_item",
        title: item.title,
        summary: item.summary,
        priority: item.priority === "high" || item.priority === "low" ? item.priority : "medium",
        label: item.label ?? "action_item",
        displayRef: item.display_ref,
        actionType: item.action_type,
        actionLabel: item.action_label,
        actionPrompt: item.action_prompt,
        sourceUrl: item.source_url,
        structuredPayload: item.structuredPayload,
        knowledgeRefs: item.knowledgeRefs,
      });
    }

    const rawPayload = parseJson<unknown>(entry.output.raw_payload_json);
    const rawItems = recordFromUnknown(rawPayload)?.items;
    if (!Array.isArray(rawItems)) continue;
    for (const value of rawItems) {
      const candidate = seedCandidateFromRawItem(entry.output, value);
      if (candidate) add(candidate);
    }
  }
  return candidates;
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
  function dmSourceLabel(platform: AgentSourcePlatform, userName: string): string {
    return `${platform === "slack" ? "Slack" : "WhatsApp"} DM with ${userName}`;
  }

  async function findDmSourceForUser(
    userId: string,
    platform: AgentSourcePlatform,
    targetId: string,
  ): Promise<AgentSourceConfig | undefined> {
    const conversationId = Number(targetId);
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return undefined;
    const user = await db.selectFrom("users").select("name").where("id", "=", userId).executeTakeFirst();
    if (!user) return undefined;
    const conversation = await db
      .selectFrom("conversations as c")
      .select("c.id")
      .where("c.id", "=", conversationId)
      .where("c.platform", "=", platform)
      .where("c.kind", "=", "dm")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("conversation_messages as m")
            .select("m.id")
            .whereRef("m.conversation_id", "=", "c.id")
            .where("m.sender_user_id", "=", userId)
            .where("m.is_bot", "=", 0),
        ),
      )
      .executeTakeFirst();
    if (!conversation) return undefined;
    return {
      platform,
      targetType: "dm",
      targetId: String(conversation.id),
      label: dmSourceLabel(platform, user.name),
    };
  }

  async function outputWithItems(output: AgentOutputRow): Promise<AgentOutputWithItems> {
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
  }

  async function outputsWithItems(rows: AgentOutputRow[]): Promise<AgentOutputWithItems[]> {
    const ids = rows.map((row) => row.id);
    const itemRows =
      ids.length === 0
        ? []
        : await db
            .selectFrom("agent_output_items")
            .selectAll()
            .where("agent_output_id", "in", ids)
            .orderBy("agent_output_id", "asc")
            .orderBy("section_key", "asc")
            .orderBy("sort_order", "asc")
            .execute();
    const itemsByOutput = new Map<string, AgentStoredItemRow[]>();
    for (const item of itemRows) {
      const items = itemsByOutput.get(item.agent_output_id) ?? [];
      items.push(withRefs(item));
      itemsByOutput.set(item.agent_output_id, items);
    }
    return rows.map((output) => ({
      output,
      masthead: parseJson<AgentMasthead>(output.masthead_json),
      items: itemsByOutput.get(output.id) ?? [],
    }));
  }

  return {
    async listDmSourceOptionsForUser(userId: string): Promise<AgentSourceConfig[]> {
      const user = await db.selectFrom("users").select("name").where("id", "=", userId).executeTakeFirst();
      if (!user) return [];
      const conversations = await db
        .selectFrom("conversations as c")
        .select(["c.id", "c.platform"])
        .where("c.kind", "=", "dm")
        .where("c.platform", "in", ["slack", "whatsapp"])
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("conversation_messages as m")
              .select("m.id")
              .whereRef("m.conversation_id", "=", "c.id")
              .where("m.sender_user_id", "=", userId)
              .where("m.is_bot", "=", 0),
          ),
        )
        .orderBy("c.updated_at", "desc")
        .orderBy("c.id", "desc")
        .execute();
      const latestByPlatform = new Map<AgentSourcePlatform, AgentSourceConfig>();
      for (const conversation of conversations) {
        if (conversation.platform !== "slack" && conversation.platform !== "whatsapp") continue;
        if (latestByPlatform.has(conversation.platform)) continue;
        latestByPlatform.set(conversation.platform, {
          platform: conversation.platform,
          targetType: "dm",
          targetId: String(conversation.id),
          label: dmSourceLabel(conversation.platform, user.name),
        });
      }
      return (["slack", "whatsapp"] as const).flatMap((platform) => {
        const source = latestByPlatform.get(platform);
        return source ? [source] : [];
      });
    },

    findDmSourceForUser,

    async getConfig(agentKey: string, userId: string): Promise<AgentUserConfig> {
      const row = await db
        .selectFrom("agent_user_configs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return toConfig(row);
    },

    async listHumanConfigs(agentKey: string): Promise<AgentUserConfigWithOwner[]> {
      const rows = await db
        .selectFrom("agent_user_configs as c")
        .innerJoin("users as u", "u.id", "c.user_id")
        .select([
          "c.agent_key as agentKey",
          "c.user_id as userId",
          "c.enabled as enabled",
          "c.schedule_hour as scheduleHour",
          "c.schedule_minute as scheduleMinute",
          "c.timezone as timezone",
          "c.max_items_per_section as maxItemsPerSection",
          "c.prefs_json as prefsJson",
          "c.created_at as createdAt",
          "c.updated_at as updatedAt",
          "u.name as name",
          "u.email as email",
          "u.auth_role as authRole",
        ])
        .where("c.agent_key", "=", agentKey)
        .where("u.type", "=", "human")
        .orderBy("c.created_at", "asc")
        .orderBy("c.user_id", "asc")
        .execute();

      return rows.map((row) => ({
        userId: row.userId,
        name: row.name,
        email: row.email,
        authRole: row.authRole,
        config: toConfig({
          agent_key: row.agentKey,
          user_id: row.userId,
          enabled: row.enabled,
          schedule_hour: row.scheduleHour,
          schedule_minute: row.scheduleMinute,
          timezone: row.timezone,
          max_items_per_section: row.maxItemsPerSection,
          prefs_json: row.prefsJson,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        }),
      }));
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
      periodKey?: string;
      sourceKey?: string;
      sourceLabel?: string | null;
      timezone: string;
      triggerType: AgentOutputTriggerType;
    }): Promise<{ row: AgentOutputRow; created: boolean }> {
      const now = new Date().toISOString();
      const sourceKey = params.sourceKey ?? "";
      const row: NewAgentOutput = {
        id: randomUUID(),
        agent_key: params.agentKey,
        user_id: params.userId,
        output_date: params.outputDate,
        period_key: params.periodKey ?? params.outputDate,
        source_key: sourceKey,
        source_label: params.sourceLabel ?? null,
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
          .where("period_key", "=", params.periodKey ?? params.outputDate)
          .where("source_key", "=", sourceKey)
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

    async promoteRunningToManual(agentKey: string, id: string): Promise<AgentOutputRow | undefined> {
      const result = await db
        .updateTable("agent_outputs")
        .set({ trigger_type: "manual", updated_at: new Date().toISOString() })
        .where("agent_key", "=", agentKey)
        .where("id", "=", id)
        .where("status", "=", "running")
        .where("trigger_type", "=", "scheduled")
        .executeTakeFirst();
      if (affectedRows(result) === 0) return undefined;
      return this.findById(agentKey, id);
    },

    async findRunning(
      agentKey: string,
      userId: string,
      periodKey: string,
      sourceKey = "",
    ): Promise<AgentOutputRow | undefined> {
      return db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("period_key", "=", periodKey)
        .where("source_key", "=", sourceKey)
        .where("status", "=", "running")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    },

    async findRunningAcrossScopes(
      agentKey: string,
      userId: string,
      outputDate: string,
    ): Promise<AgentOutputRow | undefined> {
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

    async findLatestAny(
      agentKey: string,
      userId: string,
      periodKey: string,
      sourceKey = "",
    ): Promise<AgentOutputRow | undefined> {
      return db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("period_key", "=", periodKey)
        .where("source_key", "=", sourceKey)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();
    },

    async findLatestCompletedForScope(
      agentKey: string,
      userId: string,
      sourceKey: string,
      periodKey?: string,
    ): Promise<AgentOutputWithItems | null> {
      let query = db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("source_key", "=", sourceKey)
        .where("status", "=", "completed");
      if (periodKey) query = query.where("period_key", "=", periodKey);
      const output = await query.orderBy("generated_at", "desc").orderBy("id", "desc").executeTakeFirst();
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

    async findLatestCompletedForScopeOnDate(
      agentKey: string,
      userId: string,
      sourceKey: string,
      outputDate: string,
    ): Promise<AgentOutputWithItems | null> {
      const query = db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("source_key", "=", sourceKey)
        .where("output_date", "=", outputDate)
        .where("status", "=", "completed");
      const output = await query.orderBy("generated_at", "desc").orderBy("id", "desc").executeTakeFirst();
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

    async findLatestCompletedAcrossScopes(
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

    async getByIdForHumanUser(agentKey: string, id: string): Promise<AgentOutputWithItems | null> {
      const output = await db
        .selectFrom("agent_outputs as o")
        .innerJoin("users as u", "u.id", "o.user_id")
        .selectAll("o")
        .where("o.agent_key", "=", agentKey)
        .where("o.id", "=", id)
        .where("u.type", "=", "human")
        .executeTakeFirst();
      return output ? outputWithItems(output) : null;
    },

    async listCompletedForUser(
      agentKey: string,
      userId: string,
      options: { limit?: number; cursor?: string | null } = {},
    ): Promise<AgentOutputListResult> {
      const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
      let query = db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("status", "=", "completed");

      if (options.cursor) {
        const cursorRow = await db
          .selectFrom("agent_outputs")
          .selectAll()
          .where("agent_key", "=", agentKey)
          .where("user_id", "=", userId)
          .where("id", "=", options.cursor)
          .executeTakeFirst();
        if (cursorRow?.generated_at) {
          query = query.where((eb) =>
            eb.or([
              eb("generated_at", "<", cursorRow.generated_at),
              eb.and([eb("generated_at", "=", cursorRow.generated_at), eb("id", "<", cursorRow.id)]),
            ]),
          );
        }
      }

      const rows = await query
        .orderBy("generated_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();
      const visibleRows = rows.slice(0, limit);
      const ids = visibleRows.map((row) => row.id);
      const itemRows =
        ids.length === 0
          ? []
          : await db
              .selectFrom("agent_output_items")
              .selectAll()
              .where("agent_output_id", "in", ids)
              .orderBy("agent_output_id", "asc")
              .orderBy("section_key", "asc")
              .orderBy("sort_order", "asc")
              .execute();
      const itemsByOutput = new Map<string, AgentStoredItemRow[]>();
      for (const item of itemRows) {
        const items = itemsByOutput.get(item.agent_output_id) ?? [];
        items.push(withRefs(item));
        itemsByOutput.set(item.agent_output_id, items);
      }
      return {
        outputs: visibleRows.map((output) => ({
          output,
          masthead: parseJson<AgentMasthead>(output.masthead_json),
          items: itemsByOutput.get(output.id) ?? [],
        })),
        nextCursor: rows.length > limit ? (visibleRows[visibleRows.length - 1]?.id ?? null) : null,
      };
    },

    async listCompletedForUserSince(
      agentKey: string,
      userId: string,
      sinceIso: string,
      options: {
        limit?: number;
        before?: { generatedAt: string; id: string };
        sourceKeys?: string[];
      } = {},
    ): Promise<AgentOutputWithItems[]> {
      const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
      const sourceKeys = options.sourceKeys ? [...new Set(options.sourceKeys)].filter(Boolean) : null;
      if (sourceKeys && sourceKeys.length === 0) return [];
      let query = db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("status", "=", "completed")
        .where("generated_at", ">", sinceIso);
      if (sourceKeys) query = query.where("source_key", "in", sourceKeys);
      if (options.before) {
        query = query.where((eb) =>
          eb.or([
            eb("generated_at", "<", options.before?.generatedAt ?? ""),
            eb.and([
              eb("generated_at", "=", options.before?.generatedAt ?? ""),
              eb("id", "<", options.before?.id ?? ""),
            ]),
          ]),
        );
      }
      const rows = await query.orderBy("generated_at", "desc").orderBy("id", "desc").limit(limit).execute();
      return outputsWithItems(rows.reverse());
    },

    async listCompletedForScopeSince(
      agentKey: string,
      userId: string,
      sourceKey: string,
      sinceIso: string,
      options: { limit?: number } = {},
    ): Promise<AgentOutputWithItems[]> {
      const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
      const rows = await db
        .selectFrom("agent_outputs")
        .selectAll()
        .where("agent_key", "=", agentKey)
        .where("user_id", "=", userId)
        .where("source_key", "=", sourceKey)
        .where("status", "=", "completed")
        .where(sql<boolean>`COALESCE(generated_at, updated_at) > ${sinceIso}`)
        .orderBy(sql<string>`COALESCE(generated_at, updated_at)`, "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return outputsWithItems(rows);
    },

    async listCompletedForHumanUsers(
      agentKey: string,
      options: { limit?: number; cursor?: string | null } = {},
    ): Promise<AgentOutputListResult> {
      const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
      let query = db
        .selectFrom("agent_outputs as o")
        .innerJoin("users as u", "u.id", "o.user_id")
        .selectAll("o")
        .where("o.agent_key", "=", agentKey)
        .where("o.status", "=", "completed")
        .where("u.type", "=", "human");

      if (options.cursor) {
        const cursorRow = await db
          .selectFrom("agent_outputs")
          .selectAll()
          .where("agent_key", "=", agentKey)
          .where("id", "=", options.cursor)
          .executeTakeFirst();
        if (cursorRow?.generated_at) {
          query = query.where((eb) =>
            eb.or([
              eb("o.generated_at", "<", cursorRow.generated_at),
              eb.and([eb("o.generated_at", "=", cursorRow.generated_at), eb("o.id", "<", cursorRow.id)]),
            ]),
          );
        }
      }

      const rows = await query
        .orderBy("o.generated_at", "desc")
        .orderBy("o.id", "desc")
        .limit(limit + 1)
        .execute();
      const visibleRows = rows.slice(0, limit);
      return {
        outputs: await outputsWithItems(visibleRows),
        nextCursor: rows.length > limit ? (visibleRows[visibleRows.length - 1]?.id ?? null) : null,
      };
    },

    async findLatestCompletedAcrossHumanUsers(
      agentKey: string,
      outputDate: string,
    ): Promise<AgentOutputWithItems | null> {
      const output = await db
        .selectFrom("agent_outputs as o")
        .innerJoin("users as u", "u.id", "o.user_id")
        .selectAll("o")
        .where("o.agent_key", "=", agentKey)
        .where("o.output_date", "=", outputDate)
        .where("o.status", "=", "completed")
        .where("u.type", "=", "human")
        .orderBy("o.generated_at", "desc")
        .orderBy("o.id", "desc")
        .executeTakeFirst();
      return output ? outputWithItems(output) : null;
    },

    async findRunningAcrossHumanUsers(agentKey: string, outputDate: string): Promise<AgentOutputRow | undefined> {
      return db
        .selectFrom("agent_outputs as o")
        .innerJoin("users as u", "u.id", "o.user_id")
        .selectAll("o")
        .where("o.agent_key", "=", agentKey)
        .where("o.output_date", "=", outputDate)
        .where("o.status", "=", "running")
        .where("u.type", "=", "human")
        .orderBy("o.created_at", "desc")
        .executeTakeFirst();
    },

    async completeOutput(params: {
      outputId: string;
      masthead: AgentMasthead;
      rawPayload: unknown;
      items: AgentOutputItemInput[];
      agentRunId?: string | null;
    }): Promise<PersistedAgentOutputItemRef[]> {
      const now = new Date().toISOString();
      const rows: NewAgentOutputItem[] = params.items.map((item) => ({
        id: randomUUID(),
        agent_output_id: params.outputId,
        task_id: item.canonicalTaskId ?? null,
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
        structured_payload_json: item.structuredPayload ? JSON.stringify(item.structuredPayload) : null,
        sort_order: item.sortOrder,
        created_at: now,
      }));
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
        if (rows.length > 0) {
          await trx.insertInto("agent_output_items").values(rows).execute();
        }
      });
      return rows.map((row) => ({
        id: String(row.id),
        sectionKey: String(row.section_key),
        sortOrder: Number(row.sort_order),
      }));
    },

    async markFailed(outputId: string, message: string): Promise<void> {
      await db
        .updateTable("agent_outputs")
        .set({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
        .where("id", "=", outputId)
        .where("status", "=", "running")
        .execute();
    },

    async markDeliveryFailed(outputId: string, message: string): Promise<void> {
      await db
        .updateTable("agent_outputs")
        .set({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
        .where("id", "=", outputId)
        .where("status", "=", "completed")
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

import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { DB } from "../db/schema";
import type { GeminiGenerator } from "./gemini-generate";

const CRM_ACTIVITY_FILE_TYPES = ["crm_task", "crm_note", "crm_call", "crm_event", "crm_meeting"] as const;
const DEFAULT_MAX_GROUPS_PER_RUN = 100;
const DEFAULT_ACTIVITY_CHUNK_SIZE = 50;
const MAX_ACTIVITY_TEXT_CHARS = 1200;

type CrmSummaryGenerator = Pick<GeminiGenerator, "generate">;

type ActivityRow = {
  id: string;
  provider_file_id: string;
  file_name: string;
  file_type: string | null;
  content: string | null;
  content_hash: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  synced_at: string;
};

export interface RefreshCrmActivityRollupsParams {
  db: Kysely<DB>;
  connectorConfigId: string;
  dirtyGroupIds?: string[];
  affectedIndexedFileIds?: string[];
  generator?: CrmSummaryGenerator | null;
  logger?: Logger;
  maxGroupsPerRun?: number;
  activityChunkSize?: number;
}

export interface RefreshCrmActivityRollupsResult {
  groupsConsidered: number;
  groupsRefreshed: number;
  groupsSkipped: number;
  groupsDeleted: number;
  groupsCapped: number;
  errors: Array<{ groupId: string; error: string }>;
}

export async function refreshCrmActivityRollups(
  params: RefreshCrmActivityRollupsParams,
): Promise<RefreshCrmActivityRollupsResult> {
  const result: RefreshCrmActivityRollupsResult = {
    groupsConsidered: 0,
    groupsRefreshed: 0,
    groupsSkipped: 0,
    groupsDeleted: 0,
    groupsCapped: 0,
    errors: [],
  };

  const groupIds = await collectDirtyGroupIds(params);
  result.groupsConsidered = groupIds.length;
  if (groupIds.length === 0) return result;

  const maxGroups = params.maxGroupsPerRun ?? DEFAULT_MAX_GROUPS_PER_RUN;
  const cappedGroupIds = groupIds.slice(0, maxGroups);
  result.groupsCapped = Math.max(0, groupIds.length - cappedGroupIds.length);
  if (result.groupsCapped > 0) {
    params.logger?.warn(
      { connectorConfigId: params.connectorConfigId, skippedGroups: result.groupsCapped, maxGroups },
      "CRM rollup refresh capped dirty groups",
    );
  }

  for (const groupId of cappedGroupIds) {
    try {
      const outcome = await refreshOneGroup(params, groupId);
      if (outcome === "refreshed") result.groupsRefreshed++;
      if (outcome === "skipped") result.groupsSkipped++;
      if (outcome === "deleted") result.groupsDeleted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ groupId, error: message });
      params.logger?.warn({ err, connectorConfigId: params.connectorConfigId, groupId }, "CRM rollup refresh failed");
    }
  }

  return result;
}

async function collectDirtyGroupIds(params: RefreshCrmActivityRollupsParams): Promise<string[]> {
  const ids = new Set((params.dirtyGroupIds ?? []).filter(Boolean));
  const affectedIds = params.affectedIndexedFileIds ?? [];
  if (affectedIds.length > 0) {
    const rows = await params.db
      .selectFrom("indexed_files")
      .select("rollup_group_id")
      .where("connector_config_id", "=", params.connectorConfigId)
      .where("id", "in", affectedIds)
      .where("rollup_group_id", "is not", null)
      .execute();
    for (const row of rows) {
      if (row.rollup_group_id) ids.add(row.rollup_group_id);
    }
  }
  return [...ids].sort();
}

async function refreshOneGroup(
  params: RefreshCrmActivityRollupsParams,
  groupId: string,
): Promise<"refreshed" | "skipped" | "deleted"> {
  const activities = await loadGroupActivities(params.db, params.connectorConfigId, groupId);
  if (activities.length === 0) {
    await params.db
      .deleteFrom("crm_object_summaries")
      .where("connector_config_id", "=", params.connectorConfigId)
      .where("group_id", "=", groupId)
      .execute();
    return "deleted";
  }

  const basis = buildBasis(activities);
  const existing = await params.db
    .selectFrom("crm_object_summaries")
    .select("basis_hash")
    .where("connector_config_id", "=", params.connectorConfigId)
    .where("group_id", "=", groupId)
    .executeTakeFirst();
  if (existing?.basis_hash === basis.hash) return "skipped";

  const anchorName = await loadAnchorName(params.db, params.connectorConfigId, groupId);
  const summary = await summarizeActivities({
    groupId,
    anchorName,
    activities,
    generator: params.generator,
    chunkSize: params.activityChunkSize ?? DEFAULT_ACTIVITY_CHUNK_SIZE,
  });
  const now = new Date().toISOString();

  await params.db
    .insertInto("crm_object_summaries")
    .values({
      connector_config_id: params.connectorConfigId,
      group_id: groupId,
      summary,
      activity_count: activities.length,
      basis_first_at: basis.firstAt,
      basis_last_at: basis.lastAt,
      basis_hash: basis.hash,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["connector_config_id", "group_id"]).doUpdateSet({
        summary,
        activity_count: activities.length,
        basis_first_at: basis.firstAt,
        basis_last_at: basis.lastAt,
        basis_hash: basis.hash,
        updated_at: now,
      }),
    )
    .execute();

  return "refreshed";
}

async function loadGroupActivities(db: Kysely<DB>, connectorConfigId: string, groupId: string): Promise<ActivityRow[]> {
  const rows = await db
    .selectFrom("indexed_files")
    .select([
      "id",
      "provider_file_id",
      "file_name",
      "file_type",
      "content",
      "content_hash",
      "source_created_at",
      "source_updated_at",
      "synced_at",
    ])
    .where("connector_config_id", "=", connectorConfigId)
    .where("source", "=", "zoho_crm")
    .where("is_archived", "=", 0)
    .where("rollup_group_id", "=", groupId)
    .where("provider_file_id", "!=", groupId)
    .where("file_type", "in", CRM_ACTIVITY_FILE_TYPES)
    .execute();

  return rows.sort(
    (a, b) => activityTime(a).localeCompare(activityTime(b)) || a.provider_file_id.localeCompare(b.provider_file_id),
  );
}

async function loadAnchorName(db: Kysely<DB>, connectorConfigId: string, groupId: string): Promise<string> {
  const anchor = await db
    .selectFrom("indexed_files")
    .select("file_name")
    .where("connector_config_id", "=", connectorConfigId)
    .where("provider_file_id", "=", groupId)
    .where("is_archived", "=", 0)
    .executeTakeFirst();
  return anchor?.file_name ?? groupId;
}

function buildBasis(activities: ActivityRow[]): { firstAt: string | null; lastAt: string | null; hash: string } {
  const times = activities.map(activityTime).filter(Boolean);
  const payload = activities.map((activity) => ({
    providerFileId: activity.provider_file_id,
    contentHash: activity.content_hash,
    occurredAt: activityTime(activity),
  }));
  return {
    firstAt: times[0] ?? null,
    lastAt: times[times.length - 1] ?? null,
    hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

function activityTime(activity: ActivityRow): string {
  return activity.source_updated_at ?? activity.source_created_at ?? activity.synced_at;
}

async function summarizeActivities(params: {
  groupId: string;
  anchorName: string;
  activities: ActivityRow[];
  generator?: CrmSummaryGenerator | null;
  chunkSize: number;
}): Promise<string> {
  if (!params.generator) return fallbackSummary(params.anchorName, params.activities);

  const chunks = chunk(params.activities, params.chunkSize);
  const chunkSummaries = [];
  for (const [index, activities] of chunks.entries()) {
    chunkSummaries.push(
      await params.generator.generate(renderChunkPrompt(params.anchorName, activities), {
        maxTokens: 512,
        label: `crmRollup:${params.groupId}:chunk:${index + 1}`,
      }),
    );
  }

  if (chunkSummaries.length === 1) return chunkSummaries[0].trim();

  return (
    await params.generator.generate(renderReducePrompt(params.anchorName, chunkSummaries), {
      maxTokens: 768,
      label: `crmRollup:${params.groupId}:reduce`,
    })
  ).trim();
}

function renderChunkPrompt(anchorName: string, activities: ActivityRow[]): string {
  return `Summarize these CRM activities for ${anchorName}. Focus on concrete customer/account/deal activity, decisions, risks, next steps, and recent status. Do not mention that this is a summary.\n\n${activities.map(renderActivity).join("\n\n")}`;
}

function renderReducePrompt(anchorName: string, summaries: string[]): string {
  return `Combine these partial CRM activity summaries for ${anchorName} into one concise account/deal brief. Preserve concrete names, dates, outcomes, risks, and next steps. Avoid repetition.\n\n${summaries.map((summary, index) => `Partial ${index + 1}:\n${summary}`).join("\n\n")}`;
}

function renderActivity(activity: ActivityRow): string {
  return [
    `Title: ${activity.file_name}`,
    `Type: ${activity.file_type ?? "crm_activity"}`,
    `When: ${activityTime(activity)}`,
    `Content:\n${truncate(activity.content ?? "", MAX_ACTIVITY_TEXT_CHARS)}`,
  ].join("\n");
}

function fallbackSummary(anchorName: string, activities: ActivityRow[]): string {
  const first = activityTime(activities[0]);
  const last = activityTime(activities[activities.length - 1]);
  const recent = activities
    .slice(-3)
    .reverse()
    .map((activity) => `${activity.file_name}${activityTime(activity) ? ` (${activityTime(activity)})` : ""}`);
  return [
    `${anchorName} has ${activities.length} CRM ${activities.length === 1 ? "activity" : "activities"}${first && last ? ` from ${first} to ${last}` : ""}.`,
    `Recent activity: ${recent.join("; ")}.`,
  ].join(" ");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}...`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

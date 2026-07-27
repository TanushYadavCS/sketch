import { createHash, randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { DB, TaskActivityActorType, TaskActivityEventKind, TaskActivitySurface } from "../schema";

export type { TaskActivityActorType, TaskActivityEventKind, TaskActivitySurface } from "../schema";

export type TaskActivityChanges = Record<string, { before: unknown; after: unknown }>;

export interface AppendTaskActivityInput {
  taskId: string;
  eventKind: TaskActivityEventKind;
  actorType: TaskActivityActorType;
  actorUserId?: string | null;
  actorKey?: string | null;
  surface: TaskActivitySurface;
  sourceAgentOutputId?: string | null;
  changes?: TaskActivityChanges;
  evidence?: {
    messageIds?: number[];
    fileIds?: string[];
  };
  identityParts: Array<string | number | null>;
  occurredAt: string;
}

const EVIDENCE_IDENTIFIER_LIMIT = 5;

export function createTaskActivityRepository(db: Kysely<DB> | Transaction<DB>) {
  return {
    async append(input: AppendTaskActivityInput): Promise<{ id: string; created: boolean }> {
      const changes = normalizeChanges(input.changes);
      const evidence = normalizeEvidence(input.evidence);
      const dedupeKey = activityDedupeKey(input.eventKind, input.identityParts);
      const id = randomUUID();
      const result = await db
        .insertInto("task_activity_events")
        .values({
          id,
          task_id: input.taskId,
          event_kind: input.eventKind,
          actor_type: input.actorType,
          actor_user_id: input.actorUserId ?? null,
          actor_key: input.actorKey ?? null,
          surface: input.surface,
          source_agent_output_id: input.sourceAgentOutputId ?? null,
          changes_json: changes ? JSON.stringify(changes) : null,
          evidence_json: evidence ? JSON.stringify(evidence) : null,
          dedupe_key: dedupeKey,
          occurred_at: input.occurredAt,
        })
        .onConflict((oc) => oc.column("dedupe_key").doNothing())
        .executeTakeFirst();
      const created = Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
      if (created) return { id, created: true };
      const existing = await db
        .selectFrom("task_activity_events")
        .select("id")
        .where("dedupe_key", "=", dedupeKey)
        .executeTakeFirstOrThrow();
      return { id: existing.id, created: false };
    },
  };
}

function activityDedupeKey(eventKind: TaskActivityEventKind, identityParts: Array<string | number | null>): string {
  const digest = createHash("sha256").update(JSON.stringify(identityParts)).digest("hex");
  return `${eventKind}:${digest}`;
}

function normalizeChanges(changes: TaskActivityChanges | undefined): TaskActivityChanges | null {
  if (!changes) return null;
  const entries = Object.entries(changes)
    .filter(([, change]) => JSON.stringify(change.before) !== JSON.stringify(change.after))
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeEvidence(evidence: AppendTaskActivityInput["evidence"]) {
  if (!evidence) return null;
  const messageIds = [...new Set(evidence.messageIds ?? [])].sort((a, b) => a - b);
  const fileIds = [...new Set(evidence.fileIds ?? [])].sort();
  return {
    messageIds: messageIds.slice(0, EVIDENCE_IDENTIFIER_LIMIT),
    messageCount: messageIds.length,
    fileIds: fileIds.slice(0, EVIDENCE_IDENTIFIER_LIMIT),
    fileCount: fileIds.length,
    truncated: messageIds.length > EVIDENCE_IDENTIFIER_LIMIT || fileIds.length > EVIDENCE_IDENTIFIER_LIMIT,
  };
}

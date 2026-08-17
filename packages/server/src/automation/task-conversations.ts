import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import {
  type AutomationTaskLockRow,
  LEGACY_LOCK_SESSION_ID,
  createAutomationLocksRepository,
} from "../db/repositories/automation-locks";
import {
  type ScheduledTaskConversationKind,
  type ScheduledTaskConversationRow,
  type UpsertScheduledTaskConversationInput,
  createScheduledTaskConversationRepository,
} from "../db/repositories/scheduled-task-conversations";
import type { DB } from "../db/schema";
import type { TaskContext } from "../scheduler/types";
import { acquireOrRenewLock, releaseLock } from "./lock-service";

export type { ScheduledTaskConversationKind } from "../db/repositories/scheduled-task-conversations";

export const BUILDER_CHAT_LOCK_LEASE_MS = 5 * 60 * 1000;
export const BUILDER_CHAT_LOCK_RENEWAL_INTERVAL_MS = 60 * 1000;

export interface AutomationTaskConversationLockSummary {
  state: "available" | "held";
  conversationId: string | null;
  owner: "self" | "other" | null;
  expiresAt: string | null;
  generation: number | null;
}

export interface AutomationTaskConversationSummary {
  conversationId: string;
  kinds: ScheduledTaskConversationKind[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  archivedAt: string | null;
  state: "active" | "archived";
  transcriptUserName?: string;
}

export interface UpsertAutomationTaskConversationAssociationInput {
  taskId: string;
  conversationId: string;
  transcriptUserId: string;
  kind: ScheduledTaskConversationKind;
}

export type AutomationTaskConversationAssociation = Omit<UpsertAutomationTaskConversationAssociationInput, "taskId">;

export function webChatTaskConversationAssociation(
  context: Pick<TaskContext, "conversationKind" | "createdBy" | "currentAutomation" | "origin">,
): AutomationTaskConversationAssociation | undefined {
  const conversationKind =
    context.conversationKind ??
    (context.origin?.platform === "web" && !context.currentAutomation ? ("web_chat" as const) : undefined);
  const conversationId = context.origin?.platform === "web" ? context.origin.conversationId.trim() : "";
  const transcriptUserId = context.createdBy?.trim() ?? "";
  if (conversationKind !== "web_chat" || !conversationId || !transcriptUserId) return undefined;
  return { conversationId, transcriptUserId, kind: "web_chat" };
}

function earlier(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function later(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function summarizeRows(rows: ScheduledTaskConversationRow[]): AutomationTaskConversationSummary | undefined {
  if (rows.length === 0) return undefined;

  const kinds = [...new Set(rows.map((row) => row.kind as ScheduledTaskConversationKind))].sort();
  const createdAt = rows.slice(1).reduce((value, row) => earlier(value, row.created_at), rows[0].created_at);
  const updatedAt = rows.slice(1).reduce((value, row) => later(value, row.updated_at), rows[0].updated_at);
  const lastActiveAt = rows.slice(1).reduce((value, row) => later(value, row.last_active_at), rows[0].last_active_at);
  const activeRows = rows.filter((row) => row.archived_at === null);
  const archivedTimes = rows.flatMap((row) => (row.archived_at === null ? [] : [row.archived_at]));
  const archivedAt =
    activeRows.length > 0
      ? null
      : archivedTimes.reduce<string | null>(
          (value, timestamp) => (value === null ? timestamp : later(value, timestamp)),
          null,
        );

  const transcriptUserName =
    (rows[0] as ScheduledTaskConversationRow & { transcript_user_name?: string | null }).transcript_user_name ??
    undefined;

  return {
    conversationId: rows[0].conversation_id,
    kinds,
    createdAt,
    updatedAt,
    lastActiveAt,
    archivedAt,
    state: activeRows.length > 0 ? "active" : "archived",
    transcriptUserName,
  };
}

function groupSummaries(rows: ScheduledTaskConversationRow[]): AutomationTaskConversationSummary[] {
  const grouped = new Map<string, ScheduledTaskConversationRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.conversation_id) ?? [];
    group.push(row);
    grouped.set(row.conversation_id, group);
  }

  return [...grouped.values()]
    .map((group) => summarizeRows(group))
    .filter((summary): summary is AutomationTaskConversationSummary => Boolean(summary))
    .sort((left, right) => {
      const activeSort = Number(left.state === "archived") - Number(right.state === "archived");
      if (activeSort !== 0) return activeSort;
      const lastActiveSort = Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt);
      if (lastActiveSort !== 0) return lastActiveSort;
      return left.conversationId.localeCompare(right.conversationId);
    });
}

function generatedBuilderConversationId(): string {
  return `builder-${randomUUID()}`;
}

function availableBuilderLock(): AutomationTaskConversationLockSummary {
  return { state: "available", conversationId: null, owner: null, expiresAt: null, generation: null };
}

function summarizeBuilderLock(
  row: AutomationTaskLockRow | undefined,
  transcriptUserId: string,
  clientSessionId?: string,
  nowMs = Date.now(),
): AutomationTaskConversationLockSummary {
  if (!row || Date.parse(row.expires_at) <= nowMs) return availableBuilderLock();
  return {
    state: "held",
    conversationId: row.holder_conversation_id,
    owner:
      row.holder_user_id === transcriptUserId &&
      (clientSessionId === undefined || row.holder_session_id === clientSessionId)
        ? "self"
        : "other",
    expiresAt: row.expires_at,
    generation: row.generation,
  };
}

async function claimAuthoringLease(
  db: Kysely<DB>,
  taskId: string,
  conversationId: string,
  transcriptUserId: string,
  clientSessionId = LEGACY_LOCK_SESSION_ID,
  generation?: number,
): Promise<{ acquired: boolean; stale: boolean; lock: AutomationTaskConversationLockSummary }> {
  const existing = await createAutomationLocksRepository(db).getByTaskId(taskId);
  if (
    existing &&
    Date.parse(existing.expires_at) > Date.now() &&
    existing.holder_user_id === transcriptUserId &&
    existing.holder_session_id === clientSessionId &&
    existing.holder_conversation_id !== null &&
    existing.holder_conversation_id !== conversationId
  ) {
    return {
      acquired: false,
      stale: false,
      lock: summarizeBuilderLock(existing, transcriptUserId, clientSessionId),
    };
  }
  if (
    existing &&
    Date.parse(existing.expires_at) > Date.now() &&
    existing.holder_user_id === transcriptUserId &&
    existing.holder_session_id === clientSessionId &&
    generation !== undefined &&
    generation !== existing.generation
  ) {
    return {
      acquired: false,
      stale: true,
      lock: summarizeBuilderLock(existing, transcriptUserId, clientSessionId),
    };
  }

  const result = await acquireOrRenewLock(db, {
    taskId,
    holder: {
      userId: transcriptUserId,
      sessionId: clientSessionId,
      platform: "web",
      surface: "builder",
      conversationId,
    },
  });
  if (result.kind === "locked") {
    return {
      acquired: false,
      stale: false,
      lock: summarizeBuilderLock(result.lock, transcriptUserId, clientSessionId),
    };
  }

  if (result.lock.holder_conversation_id !== conversationId) {
    await db
      .updateTable("automation_task_locks")
      .set({ holder_conversation_id: conversationId })
      .where("task_id", "=", taskId)
      .where("holder_user_id", "=", transcriptUserId)
      .where("holder_session_id", "=", clientSessionId)
      .where("generation", "=", result.lock.generation)
      .execute();
  }
  const bound = await createAutomationLocksRepository(db).getByTaskId(taskId);
  return {
    acquired: true,
    stale: false,
    lock: summarizeBuilderLock(bound, transcriptUserId, clientSessionId),
  };
}

export type BuilderConversationAccessResult =
  | {
      kind: "active";
      association: ScheduledTaskConversationRow;
      lock: AutomationTaskConversationLockSummary;
      created: false;
    }
  | { kind: "locked"; lock: AutomationTaskConversationLockSummary }
  | { kind: "stale"; lock: AutomationTaskConversationLockSummary }
  | { kind: "not_found" | "archived" | "unavailable" };

/**
 * Builder transcripts remain scoped to the authenticated transcript user. A task
 * may have historical associations for several users, but it has at most one
 * non-expired builder lease. The lease owner may renew it through builder
 * requests or the client heartbeat; archiving the leased conversation releases
 * it, and an idle lease becomes available after five minutes. Another user may
 * inspect and edit the task definition while the lease is held, but cannot read
 * or mutate the leased transcript until the owner releases it or the lease
 * expires.
 */

export function createAutomationTaskConversationService(db: Kysely<DB>) {
  const repo = createScheduledTaskConversationRepository(db);

  return {
    async associate(input: UpsertAutomationTaskConversationAssociationInput) {
      return repo.upsert(input);
    },

    async listForTranscriptUser(
      taskId: string,
      transcriptUserId: string,
      options: { includeArchived?: boolean; kind?: ScheduledTaskConversationKind } = {},
    ): Promise<AutomationTaskConversationSummary[]> {
      const rows = await repo.listByTaskAndTranscriptUser(taskId, transcriptUserId, options);
      return groupSummaries(rows);
    },

    async listForTask(
      taskId: string,
      options: { includeArchived?: boolean; kind?: ScheduledTaskConversationKind } = {},
    ): Promise<AutomationTaskConversationSummary[]> {
      const rows = await repo.listByTask(taskId, options);
      return groupSummaries(rows);
    },

    async getForTask(
      taskId: string,
      conversationId: string,
      options: { includeArchived?: boolean } = {},
    ): Promise<AutomationTaskConversationSummary | undefined> {
      const rows = await repo.listByTaskConversationForTask(taskId, conversationId, options);
      return summarizeRows(rows);
    },

    async getForTranscriptUser(
      taskId: string,
      conversationId: string,
      transcriptUserId: string,
      options: { includeArchived?: boolean } = {},
    ): Promise<AutomationTaskConversationSummary | undefined> {
      const rows = await repo.listByTaskConversationForTranscriptUser(
        taskId,
        conversationId,
        transcriptUserId,
        options,
      );
      return summarizeRows(rows);
    },

    async getBuilderLock(
      taskId: string,
      transcriptUserId: string,
      clientSessionId?: string,
    ): Promise<AutomationTaskConversationLockSummary> {
      return summarizeBuilderLock(
        await createAutomationLocksRepository(db).getByTaskId(taskId),
        transcriptUserId,
        clientSessionId,
      );
    },

    async hasAnyAssociation(taskId: string, conversationId: string): Promise<boolean> {
      return (await repo.listByTaskConversation(taskId, conversationId)).length > 0;
    },

    async archiveForTranscriptUser(
      taskId: string,
      conversationId: string,
      transcriptUserId: string,
      archived: boolean,
      lease?: { clientSessionId?: string; generation?: number },
    ): Promise<AutomationTaskConversationSummary | undefined> {
      const changed = await db.transaction().execute(async (trx) => {
        const trxRepo = createScheduledTaskConversationRepository(trx);
        const updated = await trxRepo.setArchivedForTaskConversation(
          taskId,
          conversationId,
          transcriptUserId,
          archived,
        );
        if (updated && archived) {
          await releaseLock(trx, {
            taskId,
            userId: transcriptUserId,
            sessionId: lease?.clientSessionId,
            generation: lease?.generation,
          });
        }
        return updated;
      });
      if (!changed) return undefined;
      return this.getForTranscriptUser(taskId, conversationId, transcriptUserId, { includeArchived: true });
    },

    async getOrCreateBuilderConversation(
      taskId: string,
      transcriptUserId: string,
      lease?: { clientSessionId?: string; generation?: number },
    ) {
      const existing = await repo.listByTaskAndTranscriptUser(taskId, transcriptUserId, {
        kind: "builder",
      });
      if (existing.length > 0) {
        return this.selectBuilderConversation(taskId, existing[0].conversation_id, transcriptUserId, "builder", lease);
      }

      return this.createBuilderConversation(taskId, transcriptUserId, undefined, lease);
    },

    async createBuilderConversation(
      taskId: string,
      transcriptUserId: string,
      conversationId?: string,
      lease?: { clientSessionId?: string; generation?: number },
    ) {
      return db.transaction().execute(async (trx) => {
        const trxRepo = createScheduledTaskConversationRepository(trx);
        const builderConversationId = conversationId ?? generatedBuilderConversationId();
        const claimed = await claimAuthoringLease(
          trx,
          taskId,
          builderConversationId,
          transcriptUserId,
          lease?.clientSessionId,
          lease?.generation,
        );
        if (claimed.stale) return { kind: "stale" as const, lock: claimed.lock };
        if (!claimed.acquired) return { kind: "locked" as const, lock: claimed.lock };

        const association = await trxRepo.upsert({
          taskId,
          conversationId: builderConversationId,
          transcriptUserId,
          kind: "builder",
        });
        return { kind: "created" as const, association, created: true as const, lock: claimed.lock };
      });
    },

    async selectBuilderConversation(
      taskId: string,
      conversationId: string,
      transcriptUserId: string,
      kind?: ScheduledTaskConversationKind,
      lease?: { clientSessionId?: string; generation?: number },
    ): Promise<BuilderConversationAccessResult> {
      return db.transaction().execute(async (trx) => {
        const trxRepo = createScheduledTaskConversationRepository(trx);
        const rows = await trxRepo.listByTaskConversationForTranscriptUser(taskId, conversationId, transcriptUserId, {
          includeArchived: true,
        });
        if (rows.length === 0) return { kind: "not_found" as const };

        const activeRows = rows.filter((row) => row.archived_at === null);
        if (activeRows.length === 0) return { kind: "archived" as const };
        const selectedKind = kind ?? (activeRows[0]?.kind as ScheduledTaskConversationKind | undefined);
        if (!selectedKind || !activeRows.some((row) => row.kind === selectedKind)) {
          return { kind: "not_found" as const };
        }

        const claimed = await claimAuthoringLease(
          trx,
          taskId,
          conversationId,
          transcriptUserId,
          lease?.clientSessionId,
          lease?.generation,
        );
        if (claimed.stale) return { kind: "stale" as const, lock: claimed.lock };
        if (!claimed.acquired) return { kind: "locked" as const, lock: claimed.lock };
        const touchedRows = await touchActiveAutomationTaskConversationAssociations(trx, {
          taskId,
          conversationId,
          transcriptUserId,
        });
        if (touchedRows === 0) return { kind: "unavailable" as const };
        const association = activeRows.find((row) => row.kind === selectedKind) ?? activeRows[0];
        return { kind: "active" as const, association, lock: claimed.lock, created: false };
      });
    },

    async acquireBuilderConversationLock(
      taskId: string,
      conversationId: string,
      transcriptUserId: string,
      lease?: { clientSessionId?: string; generation?: number },
    ): Promise<BuilderConversationAccessResult> {
      return db.transaction().execute(async (trx) => {
        const trxRepo = createScheduledTaskConversationRepository(trx);
        const rows = await trxRepo.listByTaskConversationForTranscriptUser(taskId, conversationId, transcriptUserId, {
          includeArchived: true,
        });
        if (rows.length === 0) return { kind: "not_found" as const };
        const activeRows = rows.filter((row) => row.archived_at === null);
        if (activeRows.length === 0) return { kind: "archived" as const };

        const claimed = await claimAuthoringLease(
          trx,
          taskId,
          conversationId,
          transcriptUserId,
          lease?.clientSessionId,
          lease?.generation,
        );
        if (claimed.stale) return { kind: "stale" as const, lock: claimed.lock };
        if (!claimed.acquired) return { kind: "locked" as const, lock: claimed.lock };
        const touchedRows = await touchActiveAutomationTaskConversationAssociations(trx, {
          taskId,
          conversationId,
          transcriptUserId,
        });
        if (touchedRows === 0) return { kind: "unavailable" as const };
        return { kind: "active" as const, association: activeRows[0], lock: claimed.lock, created: false };
      });
    },
  };
}

/**
 * Idempotently records task/chat provenance or builder navigation.
 *
 * The normal web-chat provenance worker should call this once per canonical
 * create or update with kind `web_chat`, the task ID, conversation ID, and
 * authenticated transcript user ID. Transcript user scope must remain
 * separate from task ownership because admins can access foreign-owned tasks
 * without receiving the owner's transcript content.
 */
export async function upsertAutomationTaskConversationAssociation(
  db: Kysely<DB>,
  input: UpsertAutomationTaskConversationAssociationInput,
): Promise<ScheduledTaskConversationRow> {
  return createAutomationTaskConversationService(db).associate(input);
}

export async function touchActiveAutomationTaskConversationAssociations(
  db: Kysely<DB>,
  input: Pick<UpsertAutomationTaskConversationAssociationInput, "taskId" | "conversationId" | "transcriptUserId">,
): Promise<number> {
  const result = await db
    .updateTable("scheduled_task_conversations")
    .set({
      updated_at: sql<string>`CURRENT_TIMESTAMP`,
      last_active_at: sql<string>`CURRENT_TIMESTAMP`,
    })
    .where("task_id", "=", input.taskId)
    .where("conversation_id", "=", input.conversationId)
    .where("transcript_user_id", "=", input.transcriptUserId)
    .where("archived_at", "is", null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows ?? 0);
}

import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import {
  type ScheduledTaskConversationKind,
  type ScheduledTaskConversationRow,
  type UpsertScheduledTaskConversationInput,
  createScheduledTaskConversationRepository,
} from "../db/repositories/scheduled-task-conversations";
import type { DB } from "../db/schema";

export type { ScheduledTaskConversationKind } from "../db/repositories/scheduled-task-conversations";

export interface AutomationTaskConversationSummary {
  conversationId: string;
  kinds: ScheduledTaskConversationKind[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  archivedAt: string | null;
  state: "active" | "archived";
}

export interface UpsertAutomationTaskConversationAssociationInput {
  taskId: string;
  conversationId: string;
  transcriptUserId: string;
  kind: ScheduledTaskConversationKind;
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

  return {
    conversationId: rows[0].conversation_id,
    kinds,
    createdAt,
    updatedAt,
    lastActiveAt,
    archivedAt,
    state: activeRows.length > 0 ? "active" : "archived",
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

    async hasAnyAssociation(taskId: string, conversationId: string): Promise<boolean> {
      return (await repo.listByTaskConversation(taskId, conversationId)).length > 0;
    },

    async archiveForTranscriptUser(
      taskId: string,
      conversationId: string,
      transcriptUserId: string,
      archived: boolean,
    ): Promise<AutomationTaskConversationSummary | undefined> {
      const changed = await repo.setArchivedForTaskConversation(taskId, conversationId, transcriptUserId, archived);
      if (!changed) return undefined;
      return this.getForTranscriptUser(taskId, conversationId, transcriptUserId, { includeArchived: true });
    },

    async getOrCreateBuilderConversation(taskId: string, transcriptUserId: string) {
      const existing = await repo.listByTaskAndTranscriptUser(taskId, transcriptUserId, {
        kind: "builder",
      });
      if (existing.length > 0) {
        const association = await repo.upsert({
          taskId,
          conversationId: existing[0].conversation_id,
          transcriptUserId,
          kind: "builder",
        });
        return { association, created: false };
      }

      const association = await repo.upsert({
        taskId,
        conversationId: generatedBuilderConversationId(),
        transcriptUserId,
        kind: "builder",
      });
      return { association, created: true };
    },

    async createBuilderConversation(taskId: string, transcriptUserId: string, conversationId?: string) {
      const association = await repo.upsert({
        taskId,
        conversationId: conversationId ?? generatedBuilderConversationId(),
        transcriptUserId,
        kind: "builder",
      });
      return { association, created: true };
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

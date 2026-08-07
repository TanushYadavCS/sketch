import { sql } from "kysely";
import type { Kysely, Selectable } from "kysely";
import { fileAccessFilterSql } from "../connectors/search";
import type { DB, TaskActivityEventsTable, TasksTable } from "../db/schema";
import type { Logger } from "../logger";
import { parseOnceSchedule } from "../scheduler/parse-once";

const TASK_CANDIDATE_LIMIT = 100;
const ACTIVITY_EVENT_LIMIT = 200;
const PENDING_REVIEW_LIMIT = 100;
const PREVIOUS_TASK_LIMIT = 100;
const EVIDENCE_LIMIT = 5;
const MAX_ATTENTION_ITEMS = 50;
const HIGH_PRIORITY_VALUES = ["high", "urgent", "critical", "p0", "p1"] as const;
const ATTENTION_RANK_KEYS = [
  "overdue",
  "pending_completion_review",
  "recent_change",
  "due_soon",
  "high_priority",
  "carried_from_previous_brief",
] as const;

type AttentionRankKey = (typeof ATTENTION_RANK_KEYS)[number];

export type DailyBriefTaskAttentionReason =
  | "new_since_last_brief"
  | "meaningfully_changed"
  | "status_changed"
  | "due_soon"
  | "overdue"
  | "high_priority"
  | "pending_completion_review"
  | "carried_from_previous_brief";

export interface DailyBriefTaskAttentionItem {
  taskId: string;
  title: string;
  status: "open" | "in_progress";
  priority: string | null;
  dueAt: string | null;
  parentEntityId: string | null;
  parentName: string | null;
  assigneeEntityId: string | null;
  assigneeName: string | null;
  proposedAssigneeName: string | null;
  sourcePlatform: string | null;
  sourceAnchorKey: string | null;
  lastMeaningfulActivityAt: string;
  lastEventKind: TaskActivityEventsTable["event_kind"] | null;
  changedFields: string[];
  attentionReasons: DailyBriefTaskAttentionReason[];
  evidence: {
    messageIds: number[];
    fileIds: string[];
    truncated: boolean;
  };
}

export interface DailyBriefTaskAttentionContext {
  windowStart: string;
  windowEnd: string;
  partial: boolean;
  items: DailyBriefTaskAttentionItem[];
}

type CandidateTask = Selectable<TasksTable> & {
  resolved_parent_name: string | null;
  resolved_assignee_name: string | null;
  latest_evidence_at: string | null;
  latest_activity_at: string | null;
  latest_meaningful_activity_at: string;
  latest_event_kind: TaskActivityEventsTable["event_kind"] | null;
};

type ActivityEvent = Pick<
  Selectable<TaskActivityEventsTable>,
  "id" | "task_id" | "event_kind" | "changes_json" | "occurred_at"
>;

export async function resolveDailyBriefTaskAttention(input: {
  db: Kysely<DB>;
  userId: string;
  userEmails: string[];
  slackEntitySyncEnabled: boolean;
  assigneeEntityIds: string[];
  outputDate: string;
  timezone: string;
  generatedAt: string;
  maxItemsPerSection: number;
  initialPartial?: boolean;
  logger: Pick<Logger, "warn">;
}): Promise<DailyBriefTaskAttentionContext> {
  const windowEnd = new Date(outputDateWindowEndMs(input.outputDate, input.timezone)).toISOString();
  const fallbackWindowStart = new Date(Date.parse(windowEnd) - 24 * 60 * 60 * 1000).toISOString();
  const previous = await loadPreviousBrief(input.db, input.userId).catch(() => ({
    generatedAt: null,
    taskIds: [] as string[],
    partial: true,
    failed: true,
  }));
  const windowStart = previous.generatedAt ?? fallbackWindowStart;
  let partial = previous.partial || input.initialPartial === true;

  let activityFailed = false;
  let candidateRows: CandidateTask[];
  try {
    candidateRows = await loadCandidateTasks(input.db, {
      userId: input.userId,
      userEmails: input.userEmails,
      slackEntitySyncEnabled: input.slackEntitySyncEnabled,
      assigneeEntityIds: input.assigneeEntityIds,
      carriedTaskIds: previous.failed ? [] : previous.taskIds,
      windowStart,
      windowEnd,
      outputDate: input.outputDate,
      generatedAt: input.generatedAt,
      includeLatestActivity: true,
    });
  } catch {
    try {
      candidateRows = await loadCandidateTasks(input.db, {
        userId: input.userId,
        userEmails: input.userEmails,
        slackEntitySyncEnabled: input.slackEntitySyncEnabled,
        assigneeEntityIds: input.assigneeEntityIds,
        carriedTaskIds: previous.failed ? [] : previous.taskIds,
        windowStart,
        windowEnd,
        outputDate: input.outputDate,
        generatedAt: input.generatedAt,
        includeLatestActivity: false,
      });
      activityFailed = true;
      partial = true;
      input.logger.warn(
        { event: "daily_brief_task_attention_fallback", stage: "activity", userId: input.userId },
        "Daily Brief: task attention used conservative activity fallback",
      );
    } catch {
      input.logger.warn(
        { event: "daily_brief_task_attention_failed", stage: "candidates", userId: input.userId },
        "Daily Brief: task attention loading failed",
      );
      return { windowStart, windowEnd, partial: true, items: [] };
    }
  }
  if (candidateRows.length > TASK_CANDIDATE_LIMIT) partial = true;
  const candidates = candidateRows.slice(0, TASK_CANDIDATE_LIMIT);
  const candidateIds = candidates.map((task) => task.id);
  if (candidateIds.length === 0) return { windowStart, windowEnd, partial, items: [] };

  let events: ActivityEvent[] = [];
  if (!activityFailed) {
    try {
      const rows = await input.db
        .selectFrom("task_activity_events")
        .select(["id", "task_id", "event_kind", "changes_json", "occurred_at"])
        .where("task_id", "in", candidateIds)
        .where("occurred_at", ">", windowStart)
        .where("occurred_at", "<=", windowEnd)
        .orderBy("occurred_at", "desc")
        .orderBy("id", "desc")
        .limit(ACTIVITY_EVENT_LIMIT + 1)
        .execute();
      if (rows.length > ACTIVITY_EVENT_LIMIT) partial = true;
      events = rows.slice(0, ACTIVITY_EVENT_LIMIT);
    } catch {
      activityFailed = true;
      partial = true;
      input.logger.warn(
        { event: "daily_brief_task_attention_fallback", stage: "activity", userId: input.userId },
        "Daily Brief: task attention used conservative activity fallback",
      );
    }
  }

  const pendingRows = await input.db
    .selectFrom("task_completion_recommendations")
    .select(["id", "task_id"])
    .where("task_id", "in", candidateIds)
    .where("review_state", "=", "pending")
    .where("expires_at", ">", input.generatedAt)
    .where("delivery_count", "<=", 3)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(PENDING_REVIEW_LIMIT + 1)
    .execute()
    .catch(() => {
      partial = true;
      return [];
    });
  if (pendingRows.length > PENDING_REVIEW_LIMIT) partial = true;
  const pendingTaskIds = new Set(pendingRows.slice(0, PENDING_REVIEW_LIMIT).map((row) => row.task_id));
  const carriedTaskIds = new Set(previous.failed ? [] : previous.taskIds);
  const eventsByTask = groupEvents(events);
  const cap = Math.min(Math.max(1, input.maxItemsPerSection * 4), MAX_ATTENTION_ITEMS);
  const ranked = candidates
    .flatMap((task): DailyBriefTaskAttentionItem[] => {
      if (task.status !== "open" && task.status !== "in_progress") return [];
      const taskEvents = eventsByTask.get(task.id) ?? [];
      const inWindow = activityFailed
        ? []
        : taskEvents.filter((event) => event.occurred_at > windowStart && event.occurred_at <= windowEnd);
      const reasons = attentionReasons({
        task,
        inWindow,
        outputDate: input.outputDate,
        pending: pendingTaskIds.has(task.id),
        carried: carriedTaskIds.has(task.id),
      });
      if (reasons.length === 0) return [];
      return [
        {
          taskId: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueAt: task.due_at,
          parentEntityId: task.parent_entity_id,
          parentName: task.resolved_parent_name ?? task.parent_name,
          assigneeEntityId: task.assignee_entity_id,
          assigneeName: task.resolved_assignee_name ?? task.assignee_name,
          proposedAssigneeName: task.proposed_assignee_name,
          sourcePlatform: task.source_platform,
          sourceAnchorKey: task.source_anchor_key,
          lastMeaningfulActivityAt: task.latest_meaningful_activity_at,
          lastEventKind: task.latest_event_kind,
          changedFields: changedFields(inWindow),
          attentionReasons: reasons,
          evidence: { messageIds: [], fileIds: [], truncated: false },
        },
      ];
    })
    .sort(compareAttentionItems)
    .slice(0, cap);

  const evidence = await loadEvidence(
    input.db,
    ranked.map((item) => item.taskId),
    input.userEmails,
    input.slackEntitySyncEnabled,
  ).catch(() => {
    partial = true;
    return new Map<string, DailyBriefTaskAttentionItem["evidence"]>();
  });
  for (const item of ranked) {
    item.evidence = evidence.get(item.taskId) ?? item.evidence;
    if (item.evidence.truncated) partial = true;
  }
  if (partial) {
    input.logger.warn(
      {
        event: "daily_brief_task_attention_partial",
        userId: input.userId,
        candidateCount: candidateRows.length,
        eventCount: events.length,
        itemCount: ranked.length,
      },
      "Daily Brief: task attention context is partial",
    );
  }
  return { windowStart, windowEnd, partial, items: ranked };
}

async function loadPreviousBrief(db: Kysely<DB>, userId: string) {
  const output = await db
    .selectFrom("agent_outputs")
    .select(["id", "generated_at"])
    .where("agent_key", "=", "daily_brief")
    .where("user_id", "=", userId)
    .where("status", "=", "completed")
    .where("generated_at", "is not", null)
    .orderBy("generated_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (!output?.generated_at) return { generatedAt: null, taskIds: [], partial: false, failed: false };
  const rows = await db
    .selectFrom("agent_output_items")
    .select("task_id")
    .where("agent_output_id", "=", output.id)
    .where("section_key", "=", "todos")
    .where("task_id", "is not", null)
    .orderBy("sort_order")
    .limit(PREVIOUS_TASK_LIMIT + 1)
    .execute();
  return {
    generatedAt: output.generated_at,
    taskIds: rows.slice(0, PREVIOUS_TASK_LIMIT).flatMap((row) => (row.task_id ? [row.task_id] : [])),
    partial: rows.length > PREVIOUS_TASK_LIMIT,
    failed: false,
  };
}

async function loadCandidateTasks(
  db: Kysely<DB>,
  input: {
    userId: string;
    userEmails: string[];
    slackEntitySyncEnabled: boolean;
    assigneeEntityIds: string[];
    carriedTaskIds: string[];
    windowStart: string;
    windowEnd: string;
    outputDate: string;
    generatedAt: string;
    includeLatestActivity: boolean;
  },
): Promise<CandidateTask[]> {
  const visibleFileEvidence =
    input.userEmails.length === 0
      ? sql<boolean>`false`
      : sql<boolean>`exists (
          select 1
          from task_evidence
          inner join indexed_files on indexed_files.id = task_evidence.ref_id
          where task_evidence.task_id = t.id
            and task_evidence.kind = 'file'
            and ${fileAccessFilterSql(input.userEmails, input.slackEntitySyncEnabled)}
        )`;
  const carriedRank =
    input.carriedTaskIds.length === 0
      ? sql<number>`case when 1 = 0 then 1 else 0 end`
      : sql<number>`case when t.id in (${sql.join(input.carriedTaskIds)}) then 1 else 0 end`;
  const latestEvidence = sql<string | null>`(
    select max(cm.received_at)
    from task_message_evidence tme
    inner join conversation_messages cm on cm.id = tme.conversation_message_id
    where tme.task_id = t.id
  )`;
  const latestActivity = input.includeLatestActivity
    ? sql<string | null>`(
        select tae.occurred_at
        from task_activity_events tae
        where tae.task_id = t.id
          and tae.occurred_at <= ${input.windowEnd}
        order by tae.occurred_at desc, tae.id desc
        limit 1
      )`
    : sql<string | null>`null`;
  const changedRank = input.includeLatestActivity
    ? sql<number>`case when exists (
        select 1
        from task_activity_events tae
        where tae.task_id = t.id
          and tae.occurred_at > ${input.windowStart}
          and tae.occurred_at <= ${input.windowEnd}
      ) then 1 else 0 end`
    : sql<number>`case when 1 = 0 then 1 else 0 end`;
  const fallbackMeaningfulActivity = sql<string>`case
    when coalesce(t.valid_from, '') >= coalesce(t.status_changed_at, '')
      and coalesce(t.valid_from, '') >= coalesce(${latestEvidence}, '')
      and coalesce(t.valid_from, '') >= coalesce(t.created_at, '')
      then t.valid_from
    when coalesce(t.status_changed_at, '') >= coalesce(${latestEvidence}, '')
      and coalesce(t.status_changed_at, '') >= coalesce(t.created_at, '')
      then t.status_changed_at
    when coalesce(${latestEvidence}, '') >= coalesce(t.created_at, '')
      then ${latestEvidence}
    else t.created_at
  end`;
  const latestMeaningfulActivity = sql<string>`coalesce(${latestActivity}, ${fallbackMeaningfulActivity})`;
  const dueDate = sql<string | null>`substr(t.due_at, 1, 10)`;
  const rankExpressions = {
    overdue: sql<number>`case when t.due_at is not null and ${dueDate} < ${input.outputDate} then 1 else 0 end`,
    pending_completion_review: sql<number>`case when exists (
      select 1
      from task_completion_recommendations tcr
      where tcr.task_id = t.id
        and tcr.review_state = 'pending'
        and tcr.expires_at > ${input.generatedAt}
        and tcr.delivery_count <= 3
    ) then 1 else 0 end`,
    recent_change: changedRank,
    due_soon: sql<number>`case when t.due_at is not null
      and ${dueDate} >= ${input.outputDate}
      and ${dueDate} <= ${addCalendarDays(input.outputDate, 7)}
      then 1 else 0 end`,
    high_priority: sql<number>`case when lower(trim(t.priority)) in (${sql.join(HIGH_PRIORITY_VALUES)}) then 1 else 0 end`,
    carried_from_previous_brief: carriedRank,
  } satisfies Record<AttentionRankKey, ReturnType<typeof sql<number>>>;
  return db
    .selectFrom("tasks as t")
    .leftJoin("entities as parent", "parent.id", "t.parent_entity_id")
    .leftJoin("entities as assignee", "assignee.id", "t.assignee_entity_id")
    .selectAll("t")
    .select([
      "parent.name as resolved_parent_name",
      "assignee.name as resolved_assignee_name",
      latestEvidence.as("latest_evidence_at"),
      latestMeaningfulActivity.as("latest_meaningful_activity_at"),
      ...(input.includeLatestActivity
        ? [
            latestActivity.as("latest_activity_at"),
            sql<TaskActivityEventsTable["event_kind"] | null>`(
              select tae.event_kind
              from task_activity_events tae
              where tae.task_id = t.id
                and tae.occurred_at <= ${input.windowEnd}
              order by tae.occurred_at desc, tae.id desc
              limit 1
            )`.as("latest_event_kind"),
          ]
        : [
            sql<string | null>`null`.as("latest_activity_at"),
            sql<TaskActivityEventsTable["event_kind"] | null>`null`.as("latest_event_kind"),
          ]),
    ])
    .where("t.valid_to", "is", null)
    .where("t.status", "in", ["open", "in_progress"])
    .where((eb) =>
      eb.or([
        eb.and([
          eb("t.provenance", "in", ["brief", "summary"]),
          eb.or([
            eb("t.created_by_user_id", "=", input.userId),
            ...(input.assigneeEntityIds.length > 0 ? [eb("t.assignee_entity_id", "in", input.assigneeEntityIds)] : []),
          ]),
        ]),
        eb.and([
          eb("t.provenance", "=", "structural"),
          visibleFileEvidence,
          eb.or([
            ...(input.assigneeEntityIds.length > 0 ? [eb("t.assignee_entity_id", "in", input.assigneeEntityIds)] : []),
            ...(input.carriedTaskIds.length > 0 ? [eb("t.id", "in", input.carriedTaskIds)] : []),
          ]),
        ]),
      ]),
    )
    .$call((query) =>
      ATTENTION_RANK_KEYS.reduce((rankedQuery, key) => rankedQuery.orderBy(rankExpressions[key], "desc"), query),
    )
    .orderBy(latestMeaningfulActivity, "desc")
    .orderBy("t.id", "asc")
    .limit(TASK_CANDIDATE_LIMIT + 1)
    .execute();
}

function groupEvents(events: ActivityEvent[]) {
  const grouped = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const taskEvents = grouped.get(event.task_id) ?? [];
    taskEvents.push(event);
    grouped.set(event.task_id, taskEvents);
  }
  return grouped;
}

function attentionReasons(input: {
  task: CandidateTask;
  inWindow: ActivityEvent[];
  outputDate: string;
  pending: boolean;
  carried: boolean;
}): DailyBriefTaskAttentionReason[] {
  const reasons: DailyBriefTaskAttentionReason[] = [];
  const dueDate = input.task.due_at?.slice(0, 10) ?? null;
  if (input.inWindow.some((event) => event.event_kind === "created")) {
    reasons.push("new_since_last_brief");
  }
  if (input.inWindow.length > 0) reasons.push("meaningfully_changed");
  if (input.inWindow.some((event) => event.event_kind === "status_changed")) reasons.push("status_changed");
  if (dueDate && dueDate < input.outputDate) reasons.push("overdue");
  else if (dueDate && dueDate <= addCalendarDays(input.outputDate, 7)) reasons.push("due_soon");
  if (isHighPriority(input.task.priority)) reasons.push("high_priority");
  if (input.pending) reasons.push("pending_completion_review");
  if (input.carried) reasons.push("carried_from_previous_brief");
  return reasons;
}

function changedFields(events: ActivityEvent[]): string[] {
  const fields = new Set<string>();
  for (const event of events) {
    if (event.event_kind === "status_changed") fields.add("status");
    if (!event.changes_json) continue;
    try {
      for (const field of Object.keys(JSON.parse(event.changes_json) as Record<string, unknown>)) fields.add(field);
    } catch {}
  }
  return [...fields].sort();
}

function compareAttentionItems(left: DailyBriefTaskAttentionItem, right: DailyBriefTaskAttentionItem): number {
  for (const key of ATTENTION_RANK_KEYS) {
    const delta = Number(hasAttentionRank(right, key)) - Number(hasAttentionRank(left, key));
    if (delta !== 0) return delta;
  }
  const activityOrder = right.lastMeaningfulActivityAt.localeCompare(left.lastMeaningfulActivityAt);
  return activityOrder !== 0 ? activityOrder : left.taskId.localeCompare(right.taskId);
}

function hasAttentionRank(item: DailyBriefTaskAttentionItem, key: AttentionRankKey): boolean {
  if (key === "recent_change") {
    return (
      item.attentionReasons.includes("new_since_last_brief") || item.attentionReasons.includes("meaningfully_changed")
    );
  }
  return item.attentionReasons.includes(key);
}

async function loadEvidence(db: Kysely<DB>, taskIds: string[], userEmails: string[], slackEntitySyncEnabled: boolean) {
  if (taskIds.length === 0) return new Map<string, DailyBriefTaskAttentionItem["evidence"]>();
  const messageRows = await sql<{ task_id: string; conversation_message_id: number; row_number: number }>`
    select task_id, conversation_message_id, row_number
    from (
      select
        task_id,
        conversation_message_id,
        row_number() over (partition by task_id order by conversation_message_id asc) as row_number
      from task_message_evidence
      where task_id in (${sql.join(taskIds)})
    ) ranked
    where row_number <= ${EVIDENCE_LIMIT + 1}
  `.execute(db);
  const fileRows =
    userEmails.length === 0
      ? { rows: [] as Array<{ task_id: string; ref_id: string; row_number: number }> }
      : await sql<{ task_id: string; ref_id: string; row_number: number }>`
    select task_id, ref_id, row_number
    from (
      select
        task_evidence.task_id,
        task_evidence.ref_id,
        row_number() over (partition by task_evidence.task_id order by task_evidence.ref_id asc) as row_number
      from task_evidence
      inner join indexed_files on indexed_files.id = task_evidence.ref_id
      where task_evidence.task_id in (${sql.join(taskIds)})
        and task_evidence.kind = 'file'
        and ${fileAccessFilterSql(userEmails, slackEntitySyncEnabled)}
    ) ranked
    where row_number <= ${EVIDENCE_LIMIT + 1}
  `.execute(db);
  const result = new Map<string, DailyBriefTaskAttentionItem["evidence"]>();
  for (const taskId of taskIds) {
    const messages = messageRows.rows.filter((row) => row.task_id === taskId).map((row) => row.conversation_message_id);
    const files = fileRows.rows.filter((row) => row.task_id === taskId).map((row) => row.ref_id);
    result.set(taskId, {
      messageIds: messages.slice(0, EVIDENCE_LIMIT),
      fileIds: files.slice(0, EVIDENCE_LIMIT),
      truncated: messages.length > EVIDENCE_LIMIT || files.length > EVIDENCE_LIMIT,
    });
  }
  return result;
}

function outputDateWindowEndMs(outputDate: string, timezone: string): number {
  return parseOnceSchedule(`${outputDate}T23:59:59.999`, timezone).getTime();
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isHighPriority(priority: string | null): boolean {
  if (!priority) return false;
  const normalized = priority.trim().toLowerCase();
  return HIGH_PRIORITY_VALUES.some((value) => value === normalized);
}

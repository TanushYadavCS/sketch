import type { Kysely } from "kysely";
import { normalizeName } from "../../connectors/name-normalize";
import {
  type AgentOutputItemInput,
  type AgentSourceConfig,
  type AgentStructuredPayload,
  createAgentOutputRepository,
} from "../../db/repositories/agent-outputs";
import {
  type SummarizerTaskChange,
  type TaskMemoryItem,
  createConversationFollowupsRepository,
} from "../../db/repositories/conversation-followups";
import { type StoredConversationMessage, createConversationRepository } from "../../db/repositories/conversations";
import { createEntityRepository } from "../../db/repositories/entities";
import { createTaskDurabilityTransitionRepository } from "../../db/repositories/task-durability-transition";
import { createTaskRepository } from "../../db/repositories/tasks";
import type { DB } from "../../db/schema";
import type {
  AgentApiItem,
  AgentDefinition,
  AgentOutputSavedArgs,
  AgentRuntimeContextParams,
  AgentStoredItem,
} from "../types";

export const CONVERSATION_SUMMARY_AGENT_KEY = "conversation_summary";
export const CONVERSATION_SUMMARY_AGENT_VERSION = "2026-07-conversation-summary-v1";
export const CONVERSATION_SUMMARY_FIRST_RUN_LOOKBACK_HOURS = 24;
export const CONVERSATION_SUMMARY_MAX_MESSAGES_PER_SOURCE = 300;
export const CONVERSATION_SUMMARY_MAX_SOURCES = 12;
export const CONVERSATION_SUMMARY_TASK_CANDIDATE_LIMIT = 25;

const CONVERSATION_SUMMARY_ALLOWED_TOOLS = ["mcp__sketch__WriteAgentOutput"];
const CONVERSATION_SUMMARY_TASK_CANDIDATE_SECTION = "task_candidates";
const CONVERSATION_SUMMARY_TASK_CHANGE_SECTION = "task_changes";

const SECTION_LABELS = {
  highlights: ["highlight"],
  decisions: ["decision"],
  action_items: ["action_item"],
  open_questions: ["open_question"],
  task_candidates: ["action_item"],
  task_changes: ["action_item"],
} as const satisfies Record<string, readonly string[]>;

type ConversationRow = {
  id: number;
  display_name: string | null;
};

type LatestOutputRow = {
  id: string;
  generated_at: string | null;
  raw_payload_json: string | null;
  updated_at: string;
};

type NewTaskChange = Extract<SummarizerTaskChange, { kind: "new" }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sourceKind(source: AgentSourceConfig): "channel" | "dm" | "group" {
  if (source.targetType === "dm") return "dm";
  return source.platform === "slack" ? "channel" : "group";
}

function sourceLabel(source: AgentSourceConfig, conversation: ConversationRow | undefined): string {
  if (source.label) return source.label;
  if (conversation?.display_name) return conversation.display_name;
  if (source.targetType === "dm") {
    return source.platform === "slack" ? "Slack direct message" : "WhatsApp direct message";
  }
  return source.targetId;
}

function fallbackWindowStart(now: Date, lookbackHours: number): string {
  return new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString();
}

async function findLatestCompletedOutput(
  db: Kysely<DB>,
  userId: string,
  sourceKey: string,
): Promise<LatestOutputRow | undefined> {
  const latest = await createAgentOutputRepository(db).findLatestCompletedForScope(
    CONVERSATION_SUMMARY_AGENT_KEY,
    userId,
    sourceKey,
  );
  if (!latest) return undefined;
  return {
    id: latest.output.id,
    generated_at: latest.output.generated_at,
    raw_payload_json: latest.output.raw_payload_json,
    updated_at: latest.output.updated_at,
  };
}

function summaryWindowEndFromRawPayload(rawPayloadJson: string | null): string | null {
  if (!rawPayloadJson) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayloadJson);
  } catch {
    return null;
  }

  const payloadRecord = asRecord(payload);
  const summaryWindow = asRecord(payloadRecord?.summaryWindow);
  const end = summaryWindow?.end;
  return typeof end === "string" && end.trim().length > 0 ? end : null;
}

function previousOutputWatermark(
  previousOutput: LatestOutputRow | undefined,
  now: Date,
  firstRunLookbackHours: number,
): string {
  if (!previousOutput) return fallbackWindowStart(now, firstRunLookbackHours);
  return (
    summaryWindowEndFromRawPayload(previousOutput.raw_payload_json) ??
    previousOutput.generated_at ??
    previousOutput.updated_at
  );
}

/**
 * Resolves the window start. Scheduled runs stay strictly incremental — the
 * previous run's watermark — so consecutive digests never overlap. A manual "run
 * now" instead floors the window at the frequency period (now -
 * firstRunLookbackHours): it always covers at least that period — a weekly run
 * spans ~7 days — even when an earlier same-day run already advanced the
 * watermark to "now", which is what a user expects when they trigger it by hand.
 * The floor takes the earlier of watermark and period so it never skips older
 * messages the watermark has not yet covered. `floored` reports whether the floor
 * extended the window past the watermark, for payload observability only.
 */
function resolveWindowStart(
  previousOutput: LatestOutputRow | undefined,
  now: Date,
  firstRunLookbackHours: number,
  floorToPeriod: boolean,
): { windowStart: string; floored: boolean } {
  const watermark = previousOutputWatermark(previousOutput, now, firstRunLookbackHours);
  if (!floorToPeriod || !previousOutput) return { windowStart: watermark, floored: false };
  const floor = fallbackWindowStart(now, firstRunLookbackHours);
  const windowStart = watermark < floor ? watermark : floor;
  return { windowStart, floored: windowStart !== watermark };
}

function firstRunLookbackHours(params: AgentRuntimeContextParams): number {
  const value = params.agentConfig?.firstRunLookbackHours;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : CONVERSATION_SUMMARY_FIRST_RUN_LOOKBACK_HOURS;
}

async function findConversation(
  db: Kysely<DB>,
  userId: string,
  source: AgentSourceConfig,
): Promise<ConversationRow | undefined> {
  if (source.targetType === "dm") {
    const resolved = await createAgentOutputRepository(db).findDmSourceForUser(
      userId,
      source.platform,
      source.targetId,
    );
    if (!resolved) return undefined;
    return db
      .selectFrom("conversations")
      .select(["id", "display_name"])
      .where("id", "=", Number(resolved.targetId))
      .where("platform", "=", source.platform)
      .where("kind", "=", "dm")
      .executeTakeFirst();
  }
  return db
    .selectFrom("conversations")
    .select(["id", "display_name"])
    .where("platform", "=", source.platform)
    .where("kind", "=", sourceKind(source))
    .where("provider_conversation_id", "=", source.targetId)
    .executeTakeFirst();
}

function renderAttachment(attachment: StoredConversationMessage["attachments"][number]): Record<string, unknown> {
  return {
    name: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    transcription: attachment.transcription ?? null,
  };
}

function renderMessage(message: StoredConversationMessage): Record<string, unknown> {
  return {
    id: message.id,
    senderName: message.senderName,
    senderUserId: message.senderUserId,
    text: message.text,
    attachments: message.attachments.map(renderAttachment),
    isThreadReply: message.isThreadReply,
    providerThreadId: message.providerThreadId,
    providerTimestamp: message.providerTimestamp,
    receivedAt: message.receivedAt,
  };
}

export async function buildConversationSummaryRuntimeContext(
  params: AgentRuntimeContextParams,
): Promise<Record<string, unknown>> {
  const sources = params.agentConfig?.sources ?? [];
  const previousOutput = await findLatestCompletedOutput(
    params.db,
    params.user.id,
    params.agentConfig?.sourceKey ?? "",
  );
  const windowEnd = params.now.toISOString();
  const fallbackHours = firstRunLookbackHours(params);
  const { windowStart, floored } = resolveWindowStart(
    previousOutput,
    params.now,
    fallbackHours,
    params.agentConfig?.floorWindowToPeriod ?? false,
  );
  const conversations = createConversationRepository(params.db);

  const summarySources = await Promise.all(
    sources.map(async (source) => {
      const conversation = await findConversation(params.db, params.user.id, source);
      const result = conversation
        ? await conversations.listMessagesInWindow(conversation.id, {
            afterReceivedAt: windowStart,
            beforeReceivedAt: windowEnd,
            limit: CONVERSATION_SUMMARY_MAX_MESSAGES_PER_SOURCE,
            includeBotMessages: false,
          })
        : { messages: [], hasMore: false };

      return {
        platform: source.platform,
        targetType: source.targetType,
        targetId: source.targetId,
        label: sourceLabel(source, conversation),
        conversationId: conversation?.id ?? null,
        messageCount: result.messages.length,
        truncated: result.hasMore,
        messages: result.messages.map(renderMessage),
      };
    }),
  );
  const conversationIds = summarySources.flatMap((source) =>
    typeof source.conversationId === "number" ? [source.conversationId] : [],
  );
  const allowedMessageIds = summarySources.flatMap((source) =>
    source.messages.flatMap((message) => (typeof message.id === "number" ? [message.id] : [])),
  );
  let taskMemory: TaskMemoryItem[] = [];
  let assigneeEntityIds: string[] = [];
  let durabilityTransition: Record<string, unknown> | null = null;
  if (params.agentConfig?.createTasks) {
    const sourceKey = params.agentConfig.sourceKey;
    const routeId = params.agentConfig.routeId ?? sourceKey;
    const transition = createTaskDurabilityTransitionRepository(params.db);
    durabilityTransition = await transition.ensureRouteTransition({
      agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
      userId: params.user.id,
      routeId,
      sourceKey,
      sourceKeys: params.agentConfig.sources.map(
        (source) => `${source.platform}:${source.targetType}:${source.targetId}`,
      ),
      allowedConversationIds: conversationIds,
      now: params.now.toISOString(),
    });
    const identityEmails = [
      ...new Set(
        [params.user.email, ...(params.contentUserEmails ?? [])].filter(
          (email): email is string => typeof email === "string" && email.length > 0,
        ),
      ),
    ];
    const peopleByEmail = await createEntityRepository(params.db)
      .getPersonEntitiesByEmails(identityEmails)
      .catch(() => new Map());
    assigneeEntityIds = [...new Set([...peopleByEmail.values()].flat().map((person) => person.id))];
    taskMemory = await createConversationFollowupsRepository(params.db).loadTaskMemory({
      userId: params.user.id,
      conversationIds,
      assigneeEntityIds,
      limit: CONVERSATION_SUMMARY_TASK_CANDIDATE_LIMIT * 2,
    });
  }

  return {
    summaryWindow: {
      mode: !previousOutput
        ? `first_run_last_${fallbackHours}h`
        : floored
          ? `floored_to_last_${fallbackHours}h`
          : "since_last_successful_run",
      start: windowStart,
      end: windowEnd,
      previousOutputId: previousOutput?.id ?? null,
      firstRunFallbackHours: fallbackHours,
    },
    deliveryPlatform: params.agentConfig?.deliveryPlatform ?? null,
    taskExtraction: {
      createTasks: params.agentConfig?.createTasks ?? false,
      sectionKey: CONVERSATION_SUMMARY_TASK_CANDIDATE_SECTION,
      changeSectionKey: CONVERSATION_SUMMARY_TASK_CHANGE_SECTION,
      visibleSectionKey: "action_items",
      maxCandidates: CONVERSATION_SUMMARY_TASK_CANDIDATE_LIMIT,
      label: "action_item",
    },
    allowedConversationIds: conversationIds,
    allowedMessageIds,
    authorizedAssigneeEntityIds: assigneeEntityIds,
    taskMemory,
    durabilityTransition,
    durabilityRouteId: params.agentConfig?.routeId ?? params.agentConfig?.sourceKey ?? null,
    durabilitySourceKey: params.agentConfig?.sourceKey ?? null,
    summarySources,
  };
}

const CONVERSATION_SUMMARY_INSTRUCTIONS = [
  "You are Sketch's Summarizer.",
  "",
  "Generate a concise summary from the configured Slack and WhatsApp conversations in the runtime context.",
  "The runtime context contains the complete source material available for this run. Do not use external knowledge or infer facts that are not supported by those messages.",
  "Call WriteAgentOutput exactly once when the summary is ready.",
  "",
  "Output shape:",
  "- Pass a flat `items` array. Every item carries a `sectionKey` field.",
  "- Emit visible summary items only for section keys listed in the runtime context `sections` field.",
  "- If runtime context `taskExtraction.createTasks` is true, also emit internal `task_candidates` items for task creation. Do not emit `task_candidates` when createTasks is false.",
  "- When taskExtraction.createTasks is true, use internal `task_changes` only for changed or resolved verdicts against runtime `taskMemory`. New tasks belong only in task_candidates.",
  "- Use empty knowledgeRefs arrays unless a runtime message explicitly provides a valid Sketch entity or file id.",
  "- Put sourceLabels and messageIds in structuredPayload when useful, e.g. { sourceLabels: ['#sales'], messageIds: [12, 13] }.",
  "- When action_items belong to an explicit project or parent from the messages, copy parentEntityId, parentSourceRef, or parentName into each action item's structuredPayload. Prefer parentEntityId when present.",
  "- When task_candidates belong to an explicit project or parent from the messages, copy parentEntityId, parentSourceRef, or parentName into each task candidate's structuredPayload. Prefer parentEntityId when present.",
  "",
  "Sections:",
  "- highlights: important updates, context changes, status shifts, and notable activity.",
  "- decisions: explicit or strongly implied decisions, owners, and dates when present.",
  "- action_items: concrete follow-ups, asks, blockers, or owners that need action.",
  "- open_questions: unresolved questions, risks, or unclear next steps.",
  "- task_candidates: internal extraction-only items for all concrete, valid, still-open new tasks that should be created from the source messages.",
  "- task_changes: internal extraction-only changed or resolved verdicts against runtime taskMemory.",
  "",
  "Labels:",
  "- highlights.label must be: highlight.",
  "- decisions.label must be: decision.",
  "- action_items.label must be: action_item.",
  "- open_questions.label must be: open_question.",
  "- task_candidates.label must be: action_item.",
  "- task_changes.label must be: action_item.",
  "",
  "Task extraction:",
  "- Minting a task_candidates item creates a durable, tracked commitment that a person is expected to act on. Be strict: emit one only when you are highly confident it is a specific, currently-open commitment with a clear owner. When in doubt, do not emit it — a missed soft follow-up is far better than a task nobody truly owns.",
  "- Aim for precision, not coverage. Do not try to be exhaustive. Most windows should yield few or zero task_candidates. Leave soft, implied, or ambiguous follow-ups in the visible action_items digest only; never promote them to task_candidates.",
  "- Emit a task_candidates item only when ALL of these hold: (1) it is a specific concrete action, not a theme, topic, or area of work; (2) it has a single clear owner who explicitly committed (e.g. 'I'll do X', 'sure', 'on it') or was directly asked by name and did not decline — never an inferred or assumed owner; (3) the action is still open at the end of the window; (4) the action is actionable now and is not blocked on a precondition that has not happened yet.",
  "- Do not emit a task for work that is waiting on someone else. If a message says a third party 'will get back to us', 'will send it', or 'is processing', the person waiting is not an owner and there is no task yet.",
  "- Do not emit a task that depends on an earlier step that has not happened yet, such as acting on a list that has not been shared. Premature or speculative next steps are not tasks.",
  "- Emit at most one task per real commitment. Drop restatements, sub-steps, and near-duplicates of another candidate; keep only the primary commitment.",
  "- Do not create tasks from hypothetical, conditional, speculative, or sizing statements such as 'if we win', 'would need a team', or 'we could'. A task requires a real current commitment or a direct ask to a named person.",
  "- If a question is answered later in the same window, emit no task for it. Only unresolved questions that require off-channel action qualify.",
  "- If a later message in the window shows that a directive was carried out, reported on, superseded, completed, or canceled, do not emit it as an open task.",
  "- Do not emit a task_candidates item for FYI-only updates, status reports, or vague discussion with no committed follow-up.",
  "- Do not limit task_candidates to maxItemsPerSection; use taskExtraction.maxCandidates as a hard ceiling, treated as a maximum and not a target.",
  "- Each task_candidates structuredPayload must include at least one valid message id in messageIds and sourceLabels for the configured conversations that support it.",
  "- Each task_changes structuredPayload must include changeKind ('changed' or 'resolved') and messageIds copied only from runtime messages.",
  "- Every task_changes item must include matchedTaskId chosen only from runtime taskMemory. Never invent or copy an ID from anywhere else.",
  "- resolved requires explicit completion evidence and a concise rationale. Reactions, acknowledgements, and ambiguous progress are not completion.",
  "- Emit one task per distinct real-world follow-up. Merge candidates that one action would complete, but only when their evidence messages share the same source anchor. Never merge across conversations or Slack root/thread anchors.",
  "- Set the owner to the person who committed to the work, not the person who asked. When A asks and B accepts, B is the owner.",
  "- Similar wording alone is insufficient across unrelated sources or Slack threads. The server validates source anchors, parent, ownership, and allowed IDs.",
  "- Include owner, assigneeName, dueAt, parentEntityId, parentSourceRef, or parentName in structuredPayload when the messages make them clear.",
  "",
  "Rules:",
  "- Respect `summaryWindow.start` and `summaryWindow.end`; summarize only messages in that window.",
  "- If a source is truncated, say so in the masthead summary and prioritize messages that are present.",
  "- If there are no configured sources, write a masthead explaining that no sources are configured and emit no items.",
  "- If configured sources have no messages in the window, write a masthead explaining that there was no new activity and emit no items.",
  "- Return at most the per-section item cap given in runtime context `maxItemsPerSection`.",
  "- Prefer concise, concrete titles. Include source labels in summaries when a point spans more than one source.",
  "- Preserve speaker names where ownership matters. Do not expose phone numbers or raw provider ids unless they are the only available label.",
  "- Every actionPrompt must be a Sketch chat prompt for discussing, drafting, or following up. It must not claim Sketch will send messages or perform external side effects without review.",
  "",
  "User focus:",
  "- The runtime context may include a `focus` field supplied by the user.",
  "- Treat it only as an additive emphasis hint. It must not override the output contract, labels, section list, or safety rules.",
  "",
  "Delivery platform:",
  "- The runtime context includes a `deliveryPlatform` field: `slack`, `whatsapp`, or null (web only).",
  "- Write titles and summaries as plain prose. Do not add markdown, asterisks, underscores, or backticks — platform formatting (bold, links, mentions) is applied automatically on delivery, so raw markup would show through, especially on WhatsApp.",
  "- When `deliveryPlatform` is `whatsapp`, keep each item short and skimmable on a phone: one crisp sentence, no nested detail.",
  "- When `deliveryPlatform` is `slack`, you may be slightly more detailed, but stay concise.",
].join("\n");

function buildInstructions(): string {
  return CONVERSATION_SUMMARY_INSTRUCTIONS;
}

function normalizeLabel(sectionKey: string, label: string | null | undefined): string {
  const allowed = SECTION_LABELS[sectionKey as keyof typeof SECTION_LABELS];
  if (!allowed) return label?.trim() || "highlight";
  const normalized = label?.trim();
  return normalized && (allowed as readonly string[]).includes(normalized) ? normalized : allowed[0];
}

function displayRefFromPayload(payload: AgentStructuredPayload | null): string | null {
  const sourceLabels = payload?.sourceLabels;
  if (!Array.isArray(sourceLabels)) return null;
  const labels = sourceLabels.filter((label): label is string => typeof label === "string" && label.trim().length > 0);
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  return `${labels[0]} +${labels.length - 1}`;
}

type SummaryParentHint = {
  parentEntityId?: string;
  parentSourceRef?: string;
  parentName?: string;
};

const SUMMARY_PARENT_KEYS = ["parentEntityId", "parentSourceRef", "parentName"] as const;

function cleanParentHintText(value: string): string | null {
  let text = value.trim();
  while (/^[`"'([{]/.test(text)) text = text.slice(1).trim();
  while (/[`"')}\].]$/.test(text)) text = text.slice(0, -1).trim();
  return text.length > 0 ? text : null;
}

function readStructuredParentHint(payload: AgentStructuredPayload | null | undefined): SummaryParentHint | null {
  const record = asRecord(payload);
  if (!record) return null;
  const hint: SummaryParentHint = {};
  for (const key of SUMMARY_PARENT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) hint[key] = value.trim();
  }
  return Object.keys(hint).length > 0 ? hint : null;
}

function readTextParentHint(item: AgentOutputItemInput): SummaryParentHint | null {
  const text = [item.title, item.summary, item.actionPrompt].filter(Boolean).join("\n");
  const hint: SummaryParentHint = {};
  for (const key of ["parentEntityId", "parentSourceRef"] as const) {
    const match = text.match(new RegExp(`${key}\\s*[:=]\\s*([^\\s,;]+)`, "i"));
    const value = match?.[1] ? cleanParentHintText(match[1]) : null;
    if (value) hint[key] = value;
  }
  return Object.keys(hint).length > 0 ? hint : null;
}

function mergeParentHints(base: SummaryParentHint, next: SummaryParentHint | null): SummaryParentHint {
  if (!next) return base;
  return {
    parentEntityId: base.parentEntityId ?? next.parentEntityId,
    parentSourceRef: base.parentSourceRef ?? next.parentSourceRef,
    parentName: base.parentName ?? next.parentName,
  };
}

function parentHintSignature(hint: SummaryParentHint): string | null {
  if (hint.parentEntityId) return `entity:${hint.parentEntityId}`;
  if (hint.parentSourceRef) return `source:${hint.parentSourceRef}`;
  if (hint.parentName) return `name:${hint.parentName.toLowerCase()}`;
  return null;
}

function collectOutputParentHint(items: AgentOutputItemInput[]): SummaryParentHint | null {
  let hint: SummaryParentHint = {};
  const signatures = new Set<string>();
  for (const item of items) {
    for (const itemHint of [readStructuredParentHint(item.structuredPayload), readTextParentHint(item)]) {
      if (!itemHint) continue;
      const signature = parentHintSignature(itemHint);
      if (signature) signatures.add(signature);
      if (signatures.size > 1) return null;
      hint = mergeParentHints(hint, itemHint);
    }
  }
  return Object.keys(hint).length > 0 ? hint : null;
}

function withParentHint(item: AgentOutputItemInput, hint: SummaryParentHint | null): AgentOutputItemInput {
  if (!hint) return item;
  const structuredPayload = { ...(asRecord(item.structuredPayload) ?? {}) };
  const mergedHint = mergeParentHints(readStructuredParentHint(item.structuredPayload) ?? {}, hint);
  for (const key of SUMMARY_PARENT_KEYS) {
    const value = mergedHint[key];
    if (value) structuredPayload[key] = value;
  }
  return {
    ...item,
    structuredPayload,
  };
}

async function enrichItems(_db: Kysely<DB>, items: AgentOutputItemInput[]): Promise<AgentOutputItemInput[]> {
  return items.map((item) => ({
    ...item,
    label: normalizeLabel(item.sectionKey, item.label),
    displayRef: item.displayRef ?? displayRefFromPayload(item.structuredPayload ?? null),
    actionType: item.actionType ?? "chat",
    actionLabel: item.actionLabel?.trim() || "Discuss with Sketch",
  }));
}

async function onOutputSaved(args: AgentOutputSavedArgs): Promise<void> {
  if (!args.createTasks) return;
  const routeId = readRuntimeString(args.runtimeContext.durabilityRouteId);
  const sourceKey = readRuntimeString(args.runtimeContext.durabilitySourceKey);
  const durabilityEnabled = Boolean(routeId && sourceKey);
  const taskChangeItems = args.items.filter((item) => item.sectionKey === CONVERSATION_SUMMARY_TASK_CHANGE_SECTION);
  const changes = taskChangeItems.flatMap(parseTaskChange);
  const taskCandidateItems = args.items.filter(
    (item) => item.sectionKey === CONVERSATION_SUMMARY_TASK_CANDIDATE_SECTION,
  );
  const actionItems = args.items.filter((item) => item.sectionKey === "action_items");
  const syntheticNew = taskCandidateItems.flatMap(synthesizeNewTaskChange);
  const modelUpdates = changes.filter((change) => change.kind !== "new");
  const mergedNew = deduplicateNewTaskChanges([...changes.filter(isNewTaskChange), ...syntheticNew]);
  const orderedChanges = [...modelUpdates, ...mergedNew];
  const allowedMessageIds = readRuntimeNumberArray(args.runtimeContext.allowedMessageIds);
  const allowedConversationIds = readRuntimeNumberArray(args.runtimeContext.allowedConversationIds);
  let invalidDurabilityOutput =
    durabilityEnabled &&
    (taskChangeItems.length !== changes.length ||
      syntheticNew.length !== taskCandidateItems.length ||
      (orderedChanges.length === 0 && (taskChangeItems.length > 0 || taskCandidateItems.length > 0)) ||
      (orderedChanges.length > 0 && (allowedMessageIds.length === 0 || allowedConversationIds.length === 0)));
  const taskMemory = Array.isArray(args.runtimeContext.taskMemory)
    ? (args.runtimeContext.taskMemory as TaskMemoryItem[])
    : [];
  const authorizedAssigneeEntityIds = readRuntimeStringArray(args.runtimeContext.authorizedAssigneeEntityIds);
  const applicableChanges = durabilityEnabled ? orderedChanges : changes;
  if (applicableChanges.length > 0 && allowedMessageIds.length > 0 && allowedConversationIds.length > 0) {
    const results = await createConversationFollowupsRepository(args.db).applyTaskChanges({
      userId: args.userId,
      outputId: args.outputId,
      taskMemory,
      authorizedAssigneeEntityIds,
      allowedMessageIds,
      allowedConversationIds,
      changes: applicableChanges,
      ...(routeId && sourceKey
        ? {
            routeGuard: {
              agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
              routeId,
              sourceKey,
            },
          }
        : {}),
      now: new Date().toISOString(),
    });
    for (const result of results) {
      if (result.status === "rejected") {
        if (durabilityEnabled) invalidDurabilityOutput = true;
        args.logger.warn(
          { outputId: args.outputId, userId: args.userId, reason: result.reason },
          "Summarizer: durable task change rejected",
        );
      }
    }
  } else if (!durabilityEnabled) {
    const taskRepo = createTaskRepository(args.db);
    const parentHint = collectOutputParentHint(args.items);
    const promotableItems = taskCandidateItems.length > 0 ? taskCandidateItems : actionItems;
    for (const item of promotableItems) {
      try {
        await taskRepo.promoteSummaryTask({ userId: args.userId, item: withParentHint(item, parentHint) });
      } catch (err) {
        args.logger.warn({ err, outputId: args.outputId, userId: args.userId }, "Summarizer: task promotion failed");
      }
    }
  }
  if (invalidDurabilityOutput) {
    args.logger.warn(
      { outputId: args.outputId, userId: args.userId, routeId },
      "Summarizer: durability output omitted a valid task diff",
    );
  }
  if (routeId && sourceKey && !invalidDurabilityOutput) {
    try {
      await createTaskDurabilityTransitionRepository(args.db).recordIncrementalSuccess({
        agentKey: CONVERSATION_SUMMARY_AGENT_KEY,
        userId: args.userId,
        routeId,
        expectedSourceKey: sourceKey,
        now: new Date().toISOString(),
      });
    } catch (err) {
      args.logger.warn(
        { err, outputId: args.outputId, userId: args.userId, routeId, sourceKey },
        "Summarizer: durability transition update failed",
      );
    }
  }
}

function synthesizeNewTaskChange(item: AgentOutputItemInput): NewTaskChange[] {
  const evidenceMessageIds = canonicalizeEvidenceMessageIds(item.structuredPayload?.messageIds);
  return evidenceMessageIds.length > 0 ? [{ kind: "new", evidenceMessageIds, item }] : [];
}

function isNewTaskChange(change: SummarizerTaskChange): change is NewTaskChange {
  return change.kind === "new";
}

function deduplicateNewTaskChanges(changes: NewTaskChange[]): NewTaskChange[] {
  const seen = new Set<string>();
  return changes.flatMap((change) => {
    const canonical = { ...change, evidenceMessageIds: canonicalizeEvidenceMessageIds(change.evidenceMessageIds) };
    const key = newTaskChangeDedupKey(canonical);
    if (seen.has(key)) return [];
    seen.add(key);
    return [canonical];
  });
}

function newTaskChangeDedupKey(change: NewTaskChange): string {
  const payload = change.item.structuredPayload ?? {};
  const ownerIdentity =
    identityPart("entity", payload.assigneeEntityId) ??
    identityPart("name", payload.assigneeName) ??
    identityPart("name", payload.owner);
  const parentIdentity =
    identityPart("entity", payload.parentEntityId) ??
    identityPart("source", payload.parentSourceRef) ??
    identityPart("name", payload.parentName);
  return JSON.stringify([
    normalizeName(change.item.title),
    canonicalizeEvidenceMessageIds(change.evidenceMessageIds),
    ownerIdentity,
    parentIdentity,
  ]);
}

function identityPart(kind: "entity" | "name" | "source", value: unknown): string | null {
  const text = readRuntimeString(value);
  if (!text) return null;
  return `${kind}:${kind === "name" ? normalizeName(text) : text}`;
}

function canonicalizeEvidenceMessageIds(value: unknown): number[] {
  return readRuntimeNumberArray(value).sort((left, right) => left - right);
}

function parseTaskChange(item: AgentOutputItemInput): SummarizerTaskChange[] {
  const payload = item.structuredPayload ?? {};
  const kind = readRuntimeString(payload.changeKind) ?? readRuntimeString(payload.kind);
  const evidenceMessageIds = readRuntimeNumberArray(payload.messageIds);
  if (kind === "new" && evidenceMessageIds.length > 0) {
    return [{ kind, evidenceMessageIds, item }];
  }
  const taskId = readRuntimeString(payload.matchedTaskId) ?? readRuntimeString(payload.taskId);
  if (!taskId || evidenceMessageIds.length === 0) return [];
  if (kind === "resolved") {
    return [
      {
        kind,
        taskId,
        evidenceMessageIds,
        rationale: readRuntimeString(payload.rationale) ?? item.summary,
        metadata: {
          parentEntityId: readRuntimeString(payload.parentEntityId),
          assigneeEntityId: readRuntimeString(payload.assigneeEntityId),
          assigneeName: readRuntimeString(payload.assigneeName),
          proposedAssigneeName:
            readRuntimeString(payload.proposedAssigneeName) ??
            readRuntimeString(payload.ownerName) ??
            readRuntimeString(payload.owner),
        },
      },
    ];
  }
  if (kind !== "changed") return [];
  return [
    {
      kind,
      taskId,
      evidenceMessageIds,
      metadata: {
        title: item.title,
        priority: item.priority,
        parentEntityId: readRuntimeString(payload.parentEntityId),
        assigneeEntityId: readRuntimeString(payload.assigneeEntityId),
        assigneeName: readRuntimeString(payload.assigneeName),
        proposedAssigneeName:
          readRuntimeString(payload.proposedAssigneeName) ??
          readRuntimeString(payload.ownerName) ??
          readRuntimeString(payload.owner),
      },
    },
  ];
}

function readRuntimeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRuntimeNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((entry) => {
        if (typeof entry === "number" && Number.isInteger(entry)) return [entry];
        if (typeof entry === "string" && /^\d+$/.test(entry.trim())) return [Number(entry)];
        return [];
      }),
    ),
  ];
}

function readRuntimeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.flatMap((entry) => (typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []))),
  ];
}

function toApiItem(item: AgentStoredItem): AgentApiItem {
  return {
    id: item.id,
    taskId: item.task_id,
    sectionKey: item.section_key,
    title: item.title,
    summary: item.summary,
    priority: item.priority,
    label: normalizeLabel(item.section_key, item.label),
    displayRef: item.display_ref ?? displayRefFromPayload(item.structuredPayload),
    actionType: item.action_type,
    actionLabel: item.action_label ?? "Discuss with Sketch",
    actionPrompt: item.action_prompt,
    sourceUrl: item.source_url,
    structuredPayload: item.structuredPayload,
    knowledgeRefs: item.knowledgeRefs,
    sortOrder: item.sort_order,
  };
}

export const conversationSummaryDefinition: AgentDefinition = {
  key: CONVERSATION_SUMMARY_AGENT_KEY,
  version: CONVERSATION_SUMMARY_AGENT_VERSION,
  title: "Summarizer",
  tagline: "Summarizes selected Slack and WhatsApp conversations.",
  description:
    "Reads configured shared conversations and produces focused summaries with highlights, decisions, action items, and open questions.",
  category: "Briefings",
  defaults: {
    enabled: false,
    scheduleHour: 18,
    scheduleMinute: 0,
    maxItemsPerSection: 5,
  },
  sections: [
    { key: "highlights", title: "Highlights", enabledByDefault: true, labels: SECTION_LABELS.highlights },
    { key: "decisions", title: "Decisions", enabledByDefault: true, labels: SECTION_LABELS.decisions },
    { key: "action_items", title: "Action items", enabledByDefault: true, labels: SECTION_LABELS.action_items },
    { key: "open_questions", title: "Open questions", enabledByDefault: true, labels: SECTION_LABELS.open_questions },
  ],
  internalOutputSections: [CONVERSATION_SUMMARY_TASK_CANDIDATE_SECTION, CONVERSATION_SUMMARY_TASK_CHANGE_SECTION],
  sourceConfig: {
    maxSources: CONVERSATION_SUMMARY_MAX_SOURCES,
    supportsSlackChannels: true,
    supportsSlackDms: true,
    supportsWhatsAppGroups: true,
    supportsWhatsAppDms: true,
  },
  allowedTools: CONVERSATION_SUMMARY_ALLOWED_TOOLS,
  itemsPerSectionRange: { min: 1, max: 12 },
  requiresKnowledgeRefs: false,
  buildInstructions,
  buildRuntimeContext: buildConversationSummaryRuntimeContext,
  enrichItems,
  onOutputSaved,
  toApiItem,
};

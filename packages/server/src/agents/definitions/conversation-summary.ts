import type { Kysely } from "kysely";
import type {
  AgentOutputItemInput,
  AgentSourceConfig,
  AgentStructuredPayload,
} from "../../db/repositories/agent-outputs";
import { type StoredConversationMessage, createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import type { AgentApiItem, AgentDefinition, AgentRuntimeContextParams, AgentStoredItem } from "../types";

export const CONVERSATION_SUMMARY_AGENT_KEY = "conversation_summary";
export const CONVERSATION_SUMMARY_AGENT_VERSION = "2026-07-conversation-summary-v1";
export const CONVERSATION_SUMMARY_FIRST_RUN_LOOKBACK_HOURS = 24;
export const CONVERSATION_SUMMARY_MAX_MESSAGES_PER_SOURCE = 300;
export const CONVERSATION_SUMMARY_MAX_SOURCES = 12;

const CONVERSATION_SUMMARY_ALLOWED_TOOLS = ["mcp__sketch__WriteAgentOutput"];

const SECTION_LABELS = {
  highlights: ["highlight"],
  decisions: ["decision"],
  action_items: ["action_item"],
  open_questions: ["open_question"],
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sourceKind(source: AgentSourceConfig): "channel" | "group" {
  return source.platform === "slack" ? "channel" : "group";
}

function sourceLabel(source: AgentSourceConfig, conversation: ConversationRow | undefined): string {
  if (source.label) return source.label;
  if (conversation?.display_name) return conversation.display_name;
  if (source.platform === "slack") return source.targetId;
  return source.targetId;
}

function fallbackWindowStart(now: Date): string {
  return new Date(now.getTime() - CONVERSATION_SUMMARY_FIRST_RUN_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
}

async function findLatestCompletedOutput(db: Kysely<DB>, userId: string): Promise<LatestOutputRow | undefined> {
  return db
    .selectFrom("agent_outputs")
    .select(["id", "generated_at", "raw_payload_json", "updated_at"])
    .where("agent_key", "=", CONVERSATION_SUMMARY_AGENT_KEY)
    .where("user_id", "=", userId)
    .where("status", "=", "completed")
    .orderBy("generated_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
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

function previousOutputWatermark(previousOutput: LatestOutputRow | undefined, now: Date): string {
  if (!previousOutput) return fallbackWindowStart(now);
  return (
    summaryWindowEndFromRawPayload(previousOutput.raw_payload_json) ??
    previousOutput.generated_at ??
    previousOutput.updated_at
  );
}

async function findConversation(db: Kysely<DB>, source: AgentSourceConfig): Promise<ConversationRow | undefined> {
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
  const previousOutput = await findLatestCompletedOutput(params.db, params.user.id);
  const windowEnd = params.now.toISOString();
  const windowStart = previousOutputWatermark(previousOutput, params.now);
  const conversations = createConversationRepository(params.db);

  const summarySources = await Promise.all(
    sources.map(async (source) => {
      const conversation = await findConversation(params.db, source);
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

  return {
    summaryWindow: {
      mode: previousOutput ? "since_last_successful_run" : "first_run_last_24h",
      start: windowStart,
      end: windowEnd,
      previousOutputId: previousOutput?.id ?? null,
      firstRunFallbackHours: CONVERSATION_SUMMARY_FIRST_RUN_LOOKBACK_HOURS,
    },
    summarySources,
  };
}

const CONVERSATION_SUMMARY_INSTRUCTIONS = [
  "You are Sketch's Summarizer.",
  "",
  "Generate a concise summary from the configured Slack channels and WhatsApp groups in the runtime context.",
  "The runtime context contains the complete source material available for this run. Do not use external knowledge or infer facts that are not supported by those messages.",
  "Call WriteAgentOutput exactly once when the summary is ready.",
  "",
  "Output shape:",
  "- Pass a flat `items` array. Every item carries a `sectionKey` field.",
  "- Emit items only for section keys listed in the runtime context `sections` field.",
  "- Use empty knowledgeRefs arrays unless a runtime message explicitly provides a valid Sketch entity or file id.",
  "- Put sourceLabels and messageIds in structuredPayload when useful, e.g. { sourceLabels: ['#sales'], messageIds: [12, 13] }.",
  "",
  "Sections:",
  "- highlights: important updates, context changes, status shifts, and notable activity.",
  "- decisions: explicit or strongly implied decisions, owners, and dates when present.",
  "- action_items: concrete follow-ups, asks, blockers, or owners that need action.",
  "- open_questions: unresolved questions, risks, or unclear next steps.",
  "",
  "Labels:",
  "- highlights.label must be: highlight.",
  "- decisions.label must be: decision.",
  "- action_items.label must be: action_item.",
  "- open_questions.label must be: open_question.",
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

async function enrichItems(_db: Kysely<DB>, items: AgentOutputItemInput[]): Promise<AgentOutputItemInput[]> {
  return items.map((item) => ({
    ...item,
    label: normalizeLabel(item.sectionKey, item.label),
    displayRef: item.displayRef ?? displayRefFromPayload(item.structuredPayload ?? null),
    actionType: item.actionType ?? "chat",
    actionLabel: item.actionLabel?.trim() || "Discuss with Sketch",
  }));
}

function toApiItem(item: AgentStoredItem): AgentApiItem {
  return {
    id: item.id,
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
  tagline: "Summarizes selected Slack channels and WhatsApp groups.",
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
  sourceConfig: {
    maxSources: CONVERSATION_SUMMARY_MAX_SOURCES,
    supportsSlackChannels: true,
    supportsWhatsAppGroups: true,
  },
  allowedTools: CONVERSATION_SUMMARY_ALLOWED_TOOLS,
  itemsPerSectionRange: { min: 1, max: 12 },
  requiresKnowledgeRefs: false,
  buildInstructions,
  buildRuntimeContext: buildConversationSummaryRuntimeContext,
  enrichItems,
  toApiItem,
};

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import {
  type AutomationArtifact,
  type AutomationDraftHandoff,
  type WebChatIntegrationConnectionData,
  type WebChatProgressData,
  type WebChatQuestion,
  type WebChatQuestionAnswer,
  type WebChatQuestionBatch,
  type WebChatQuestionBatchAnswer,
  type WebChatQuestionInteraction,
  type WebProgressItem,
  type WorkflowEdge,
  type WorkflowStep,
  automationArtifactSchema,
  automationDraftHandoffSchema,
  webChatQuestionAnswerSchema,
  webChatQuestionBatchAnswerSchema,
  webChatQuestionBatchSchema,
  webChatQuestionSchema,
  workflowEdgeSchema,
  workflowStepSchema,
} from "@sketch/shared";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import {
  builderWebChatRunKey,
  interruptActiveBuilderWebChatRun,
  interruptActiveWebChatRun,
  webChatRunKey,
  withActiveBuilderWebChatRun,
  withActiveWebChatRun,
} from "../agent/active-runs";
import { type BufferedMessage, buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, ProgressEvent, RunAgentParams, RunAgentResult } from "../agent/runner";
import { archiveRuntimeSessions } from "../agent/sessions";
import { createProgressRenderer, createWebProgressData } from "../agent/tool-progress";
import { handleManageScheduledTasks } from "../agent/tools/scheduled-tasks";
import { AutomationArtifactCollector } from "../agent/tools/types";
import { ensureWorkspace } from "../agent/workspace";
import { isAutomationPlaceholderDraft } from "../automation/definition";
import { type AutomationCreateContext, createAutomationDraft } from "../automation/persistence";
import {
  type AutomationTaskConversationLockSummary,
  BUILDER_CHAT_LOCK_RENEWAL_INTERVAL_MS,
  createAutomationTaskConversationService,
} from "../automation/task-conversations";
import { TOOL_PROGRESS_OPTIONS, type ToolProgressCommand } from "../commands";
import type { Config } from "../config";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationSharesRepository } from "../db/repositories/automation-shares";
import type { StepContentRow, createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { Attachment } from "../files";
import { extensionToMime } from "../files";
import {
  type CliIntegrationCardResolver,
  connectedAccountCardsForUser,
  dedupeIntegrationCards,
  isConnectedAccountsInquiry,
} from "../integrations/cards";
import { sanitizeIntegrationConnectionText } from "../integrations/connection-links";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import {
  progressDisplaySettingsForWebChatMode,
  resolveProgressDisplaySettings,
  resolveToolProgress,
  resolveWebChatProgressRendererMode,
} from "../progress-settings";
import type { QueueManager } from "../queue";
import { resolveScheduledTaskAccess } from "../scheduler/access";
import type { TaskScheduler } from "../scheduler/service";
import type { CurrentAutomation, ScheduledTask, TaskContext } from "../scheduler/types";
import type { SlackBot } from "../slack/bot";
import { transcribeAudioFile } from "../transcription/service";
import type { WhatsAppTemplateRequest } from "../whatsapp/templates";

type UserRepo = ReturnType<typeof createUserRepository>;
type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepo = ReturnType<typeof createInboxMessagesRepository>;
interface WebChatRouteDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  users: UserRepo;
  settings: SettingsRepo;
  inboxMessagesRepo: InboxMessagesRepo;
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  cliIntegrations?: CliIntegrationCardResolver;
  listAgentEnvForRuntime?: (context: {
    currentUserId?: string | null;
    contextType?: "dm" | "channel_mention" | "scheduled_task";
    allowOrgSharedEnv?: boolean;
    taskContext?: RunAgentParams["taskContext"];
  }) => Promise<Record<string, string>>;
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: QueueManager;
  getSlack?: () => SlackBot | null;
  sendDm?: (params: {
    userId: string;
    platform: string;
    message: string;
    template?: WhatsAppTemplateRequest;
    senderUserId?: string;
    storeInInbox?: boolean;
    inboxKind?: string;
    inboxMetadata?: Record<string, unknown> | null;
  }) => Promise<{
    channelId: string;
    messageRef: string;
    inboxMessageId?: string;
  }>;
  sendTargetMessage?: RunAgentParams["sendTargetMessage"];
}

function badRequest(code: string, message: string) {
  return { error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWebChatToolProgress(value: unknown): value is ToolProgressCommand {
  return typeof value === "string" && TOOL_PROGRESS_OPTIONS.includes(value as ToolProgressCommand);
}

function extractTextPart(part: unknown): string[] {
  if (!isRecord(part)) return [];
  if (part.type === "text" && typeof part.text === "string") return [part.text];
  if (typeof part.content === "string") return [part.content];
  return [];
}

function extractMessageText(message: unknown): string | null {
  if (!isRecord(message)) return null;
  if (typeof message.text === "string") return message.text.trim() || null;
  if (typeof message.content === "string") return message.content.trim() || null;
  if (Array.isArray(message.parts)) {
    const text = message.parts.flatMap(extractTextPart).join("\n").trim();
    return text || null;
  }
  if (Array.isArray(message.content)) {
    const text = message.content.flatMap(extractTextPart).join("\n").trim();
    return text || null;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Agent run failed";
}

interface WebChatFile {
  name: string;
  url: string;
  mediaType: string;
  sizeBytes: number;
}

interface WebChatInterruptionData {
  label: string;
  detail?: string;
}

const WEB_CHAT_INTERRUPTION_DATA = {
  detail: "Sketch paused.",
  label: "What should Sketch do differently?",
} satisfies WebChatInterruptionData;

type WebChatTranscriptPart =
  | { type: "text"; text: string }
  | { type: "data-file"; id: string; data: WebChatFile }
  | { type: "data-automation"; id: string; data: AutomationArtifact }
  | { type: "data-automation-handoff"; id: string; data: AutomationDraftHandoff }
  | { type: "data-integration-connection"; id: string; data: WebChatIntegrationConnectionData }
  | { type: "data-question"; id: string; data: WebChatQuestion }
  | { type: "data-question-batch"; id: string; data: WebChatQuestionBatch }
  | { type: "data-question-answer"; id: string; data: WebChatQuestionAnswer }
  | { type: "data-question-batch-answer"; id: string; data: WebChatQuestionBatchAnswer }
  | { type: "data-interruption"; id: string; data: WebChatInterruptionData };
type WebChatProgressTranscriptPart = { type: "data-progress"; id: string; data: WebChatProgressData };
type WebChatStoredPart = WebChatTranscriptPart | WebChatProgressTranscriptPart;

export interface WebChatTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  createdAt?: string;
  parts: WebChatStoredPart[];
}

interface WebChatTranscript {
  version: 1;
  messages: WebChatTranscriptMessage[];
}

interface WebChatConversationSummary {
  id: string;
  title: string;
  channel: "web";
  updatedAt: string;
  builderTaskId?: string;
}

interface LatestUserMessage {
  id: string | null;
  text: string;
}

interface ExtractedQuestionAnswer {
  present: boolean;
  answer: WebChatQuestionAnswer | WebChatQuestionBatchAnswer | null;
}

interface ParsedWebChatAttachment {
  attachment: Attachment;
  file: WebChatFile;
}

type WebChatQuestionPart = { id: string; data: WebChatQuestion } | { id: string; data: WebChatQuestionBatch };

function isQuestionBatch(value: WebChatQuestionInteraction): value is WebChatQuestionBatch {
  return "batchId" in value;
}

function questionPartFromInteraction(interaction: WebChatQuestionInteraction): WebChatQuestionPart {
  if (isQuestionBatch(interaction)) {
    return { id: `question-${interaction.batchId}`, data: interaction };
  }
  return { id: `question-${interaction.id}`, data: interaction };
}

type AutomationBuilderContext = {
  task: ScheduledTask;
  stepContentRows: StepContentRow[];
  currentAutomation: CurrentAutomation;
  isPlaceholderDraft: boolean;
} | null;

type WebChatUiChunk =
  | { type: "start"; messageMetadata?: { createdAt: string } }
  | { type: "start-step" }
  | { type: "data-progress"; id: string; data: WebChatProgressData }
  | { type: "data-file"; id: string; data: WebChatFile }
  | { type: "data-automation"; id: string; data: AutomationArtifact }
  | { type: "data-automation-handoff"; id: string; data: AutomationDraftHandoff }
  | { type: "data-integration-connection"; id: string; data: WebChatIntegrationConnectionData }
  | { type: "data-question"; id: string; data: WebChatQuestion }
  | { type: "data-question-batch"; id: string; data: WebChatQuestionBatch }
  | { type: "data-interruption"; id: string; data: WebChatInterruptionData }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "finish-step" }
  | { type: "finish" }
  | { type: "error"; errorText: string };

type WebChatUiWriter = (chunk: WebChatUiChunk) => void;
type WebChatUiCancelRegistrar = (handler: () => void) => void;

function webChatUiStreamResponse(
  execute: (write: WebChatUiWriter, setOnCancel: WebChatUiCancelRegistrar) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  let onCancel: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: WebChatUiChunk) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        } catch {
          cancelled = true;
        }
      };

      try {
        await execute(write, (handler) => {
          onCancel = handler;
        });
      } finally {
        if (!cancelled) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            cancelled = true;
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      onCancel?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
      "x-accel-buffering": "no",
    },
  });
}

function extractMessageId(message: unknown): string | null {
  if (!isRecord(message)) return null;
  return typeof message.id === "string" && message.id.trim() ? message.id : null;
}

function extractQuestionAnswerFromMessage(message: unknown): ExtractedQuestionAnswer {
  if (!isRecord(message) || !Array.isArray(message.parts)) return { present: false, answer: null };
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (!isRecord(part)) continue;
    if (part.type === "data-question-answer") {
      const parsed = webChatQuestionAnswerSchema.safeParse(part.data);
      return { present: true, answer: parsed.success ? parsed.data : null };
    }
    if (part.type === "data-question-batch-answer") {
      const parsed = webChatQuestionBatchAnswerSchema.safeParse(part.data);
      return { present: true, answer: parsed.success ? parsed.data : null };
    }
  }
  return { present: false, answer: null };
}

function extractLatestQuestionAnswer(body: unknown): ExtractedQuestionAnswer {
  if (!isRecord(body)) return { present: false, answer: null };
  if (isRecord(body.message)) return extractQuestionAnswerFromMessage(body.message);
  if (!Array.isArray(body.messages)) return { present: false, answer: null };

  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    return extractQuestionAnswerFromMessage(message);
  }
  return { present: false, answer: null };
}

function extractLatestUserMessage(body: unknown): LatestUserMessage | null {
  if (!isRecord(body)) return null;
  if (typeof body.message === "string") {
    const text = body.message.trim();
    return text ? { id: null, text } : null;
  }
  if (isRecord(body.message)) {
    const text = extractMessageText(body.message);
    return text ? { id: extractMessageId(body.message), text } : null;
  }
  if (!Array.isArray(body.messages)) return null;

  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = extractMessageText(message);
    if (text) return { id: extractMessageId(message), text };
  }
  return null;
}

function extractAutomationTaskId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const taskId = typeof body.automationTaskId === "string" ? body.automationTaskId.trim() : "";
  return /^[A-Za-z0-9_-]{1,120}$/.test(taskId) ? taskId : null;
}

type BuilderLease = { clientSessionId: string; generation: number };

function parseBuilderLease(body: unknown): BuilderLease | null {
  if (!isRecord(body)) return null;
  const clientSessionId = typeof body.clientSessionId === "string" ? body.clientSessionId.trim() : "";
  const generation = body.generation;
  if (
    clientSessionId.length === 0 ||
    clientSessionId.length > 200 ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 1
  ) {
    return null;
  }
  return { clientSessionId, generation: generation as number };
}

function automationBuilderUrl(config: Config, taskId: string, conversationId: string): string {
  const base = config.BASE_URL?.replace(/\/$/, "") ?? `http://localhost:${config.PORT}`;
  return `${base}/scheduled-tasks/${encodeURIComponent(taskId)}/edit?conversationId=${encodeURIComponent(conversationId)}`;
}

function hasSuccessfulCreateAutomationSkill(result: RunAgentResult): boolean {
  return (result.rawUsage?.toolCalls ?? []).some(
    (toolCall) => toolCall.skillName?.trim() === "create-automation" && toolCall.success === true,
  );
}

const AUTOMATION_CREATE_INTENT_PATTERN =
  /\b(?:create|make|set up|set-up|build|add|start|write|design)\b[^.!?\n]{0,80}\b(?:a|an|another|new)\b[^.!?\n]{0,80}\b(?:automation|workflow|scheduled task|recurring task)\b|\b(?:want|need)\b[^.!?\n]{0,40}\b(?:a|an|new)\b[^.!?\n]{0,40}\b(?:automation|workflow|scheduled task)\b|\b(?:remind me to|set a reminder|create a reminder|make a reminder)\b/i;

const AUTOMATION_UPDATE_INTENT_PATTERN =
  /\b(?:update|edit|change|modify|adjust|fix|improve|remove|delete|pause|resume|stop|disable|enable|rename|alter)\b[^.!?\n]{0,180}\b(?:automation|workflow|scheduled task)\b|\badd\b[^.!?\n]{0,120}\b(?:my|our|the|this|that|their)\b[^.!?\n]{0,60}\b(?:automation|workflow|scheduled task)\b/i;

function hasAutomationCreateIntent(message: string): boolean {
  return AUTOMATION_CREATE_INTENT_PATTERN.test(message) && !AUTOMATION_UPDATE_INTENT_PATTERN.test(message);
}

function hasAutomationUpdateIntent(message: string): boolean {
  return AUTOMATION_UPDATE_INTENT_PATTERN.test(message);
}

function normalizedAutomationReference(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueExplicitAutomationMatch(tasks: ScheduledTask[], message: string): ScheduledTask | undefined {
  const normalizedMessage = normalizedAutomationReference(message);
  const titledTasks = tasks.filter((task) => task.title?.trim());
  const exactMatches = titledTasks.filter((task) => {
    const title = normalizedAutomationReference(task.title as string);
    return normalizedMessage.includes(title);
  });
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return undefined;

  const messageWords = new Set(normalizedMessage.split(" "));
  const stopWords = new Set(["a", "an", "and", "for", "my", "of", "the", "to"]);
  const tokenMatches = titledTasks.filter((task) => {
    const titleWords = normalizedAutomationReference(task.title as string)
      .split(" ")
      .filter((word) => word.length >= 3 && !stopWords.has(word));
    return titleWords.length >= 2 && titleWords.every((word) => messageWords.has(word));
  });
  return tokenMatches.length === 1 ? tokenMatches[0] : undefined;
}

function automationReferenceTerms(message: string): string[] {
  const ignoredWords = new Set([
    "a",
    "an",
    "another",
    "and",
    "automation",
    "change",
    "delete",
    "disable",
    "edit",
    "enable",
    "fix",
    "for",
    "from",
    "i",
    "improve",
    "my",
    "need",
    "new",
    "of",
    "our",
    "pause",
    "please",
    "remove",
    "rename",
    "resume",
    "schedule",
    "scheduled",
    "stop",
    "task",
    "the",
    "this",
    "to",
    "update",
    "want",
    "workflow",
  ]);
  return [
    ...new Set(
      normalizedAutomationReference(message)
        .split(" ")
        .filter((word) => word.length >= 3 && !ignoredWords.has(word)),
    ),
  ];
}

function automationUpdateCandidates(tasks: ScheduledTask[], message: string): ScheduledTask[] {
  const terms = automationReferenceTerms(message);
  if (terms.length === 0) return [];
  return tasks.filter((task) => {
    const searchableText = normalizedAutomationReference(task.title ?? "");
    const searchableWords = new Set(searchableText.split(" "));
    return terms.some((term) => searchableWords.has(term));
  });
}

type AutomationUpdateResolution =
  | { kind: "match"; task: ScheduledTask }
  | { kind: "ambiguous"; candidates: ScheduledTask[] }
  | { kind: "none"; candidates: ScheduledTask[] };
type UnmatchedAutomationUpdateResolution = Exclude<AutomationUpdateResolution, { kind: "match" }>;

async function resolveAutomationUpdate(params: {
  scheduler: TaskScheduler | undefined;
  userId: string;
  message: string;
}): Promise<AutomationUpdateResolution> {
  if (!params.scheduler) return { kind: "none", candidates: [] };
  try {
    const tasks = await params.scheduler.listTasks({ createdBy: params.userId, includeInactive: true });
    const exactMatch = uniqueExplicitAutomationMatch(tasks, params.message);
    if (exactMatch) return { kind: "match", task: exactMatch };
    const candidates = automationUpdateCandidates(tasks, params.message);
    return candidates.length === 1
      ? { kind: "match", task: candidates[0] }
      : candidates.length > 1
        ? { kind: "ambiguous", candidates }
        : { kind: "none", candidates: tasks };
  } catch {
    return { kind: "none", candidates: [] };
  }
}

function automationUpdateOptionId(task: ScheduledTask): string {
  const taskSuffix = task.id.replace(/[^A-Za-z0-9._-]/g, "").slice(-64);
  return `automation-choice-${taskSuffix || "unknown"}`;
}

async function automationTaskForUpdateOption(params: {
  scheduler: TaskScheduler | undefined;
  userId: string;
  optionId: string;
}): Promise<ScheduledTask | undefined> {
  if (!params.scheduler) return undefined;
  try {
    const tasks = await params.scheduler.listTasks({ createdBy: params.userId, includeInactive: true });
    return tasks.find((task) => automationUpdateOptionId(task) === params.optionId);
  } catch {
    return undefined;
  }
}

function automationUpdateQuestion(conversationId: string, candidates: ScheduledTask[]): WebChatQuestion {
  const titleCounts = new Map<string, number>();
  for (const task of candidates) {
    const title = task.title?.trim() || task.prompt;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const visibleCandidates = candidates.slice(0, 3);
  const options = visibleCandidates.map((task) => {
    const title = task.title?.trim() || task.prompt;
    const duplicateSuffix = (titleCounts.get(title) ?? 0) > 1 ? ` · ${task.id.slice(0, 8)}` : "";
    return {
      id: automationUpdateOptionId(task),
      label: `${title}${duplicateSuffix}`,
      description: `${task.scheduleType}: ${task.scheduleValue}`,
    };
  });
  options.push({
    id: "automation-update-none-of-these",
    label: "None of these",
    description:
      candidates.length > visibleCandidates.length
        ? "More automations are available; tell me the exact name instead."
        : "Tell me the automation's exact name instead.",
  });
  return {
    id: `automation-update-${builderQuestionIdSuffix(conversationId)}`,
    prompt: "Which automation should I open in the builder?",
    options,
  };
}

function automationUpdateClarification(message: string, resolution: UnmatchedAutomationUpdateResolution): string {
  if (resolution.kind === "none" && resolution.candidates.length === 0) {
    return "I couldn't identify the existing automation from that message. Tell me its exact name and I'll open it in the builder. No changes were made.";
  }
  const terms = automationReferenceTerms(message);
  const reference =
    resolution.kind === "ambiguous" ? (terms[0] ? ` matching “${terms[0]}”` : " matching that description") : "";
  const choices = resolution.candidates
    .slice(0, 8)
    .map((task) => `- ${task.title?.trim() || task.prompt}`)
    .join("\n");
  const remaining = resolution.candidates.length - Math.min(resolution.candidates.length, 8);
  return [
    resolution.kind === "ambiguous"
      ? `I found multiple automations${reference}. Which one should I open in the builder?`
      : "Which automation should I open in the builder?",
    choices,
    remaining > 0 ? `- And ${remaining} more matching automation${remaining === 1 ? "" : "s"}` : "",
    "No changes were made.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function openExplicitAutomationBuilder(params: {
  deps: WebChatRouteDeps;
  taskContext: TaskContext;
  taskId: string;
}): Promise<AutomationArtifact[]> {
  const collector = new AutomationArtifactCollector();
  await handleManageScheduledTasks(
    { action: "open", task_id: params.taskId },
    {
      db: params.deps.db,
      scheduler: params.deps.scheduler as TaskScheduler,
      taskContext: params.taskContext,
      config: params.deps.config,
      encryptionKey: params.deps.config.ENCRYPTION_KEY,
      automationArtifactCollector: collector,
    },
  );
  return collector.drain();
}

async function createAutomationDraftHandoff(params: {
  deps: WebChatRouteDeps;
  currentUser: NonNullable<Awaited<ReturnType<UserRepo["findById"]>>>;
  conversationId: string;
  dmContext: { platform: "slack" | "whatsapp"; deliveryTarget: string } | null;
}): Promise<{ id: string; data: AutomationDraftHandoff }> {
  const builderConversationId = `builder-${randomUUID()}`;
  const delivery = params.dmContext ?? {
    platform: "slack" as const,
    deliveryTarget: params.currentUser.slack_user_id ?? params.currentUser.id,
  };
  const context: AutomationCreateContext = {
    platform: delivery.platform,
    contextType: "dm",
    deliveryTarget: delivery.deliveryTarget,
    threadTs: null,
    createdBy: params.currentUser.id,
    originPlatform: "web",
    originConversationId: params.conversationId,
    originProviderThreadId: null,
    originMessageId: null,
  };
  const result = await createAutomationDraft({
    db: params.deps.db,
    context,
    timezone: params.currentUser.timezone ?? "UTC",
    taskConversationAssociations: [
      { conversationId: params.conversationId, transcriptUserId: params.currentUser.id, kind: "web_chat" },
      { conversationId: builderConversationId, transcriptUserId: params.currentUser.id, kind: "builder" },
    ],
  });
  return {
    id: "automation-handoff-0",
    data: automationDraftHandoffSchema.parse({
      kind: "automation-draft",
      taskId: result.row.id,
      sourceConversationId: params.conversationId,
      builderConversationId,
      builderUrl: automationBuilderUrl(params.deps.config, result.row.id, builderConversationId),
      status: "paused",
    }),
  };
}

async function resolveAutomationBuilderContext(params: {
  deps: WebChatRouteDeps;
  currentUserId: string;
  role: string | undefined;
  automationTaskId: string | null;
  builderConversationId: string;
  logger: Logger;
}): Promise<AutomationBuilderContext> {
  if (!params.automationTaskId || !params.deps.scheduler?.getTaskById) {
    return null;
  }

  const task = await params.deps.scheduler.getTaskById(params.automationTaskId).catch((err) => {
    params.logger.warn({ err, taskId: params.automationTaskId }, "Failed to resolve automation builder context");
    return null;
  });
  const shares = createAutomationSharesRepository(params.deps.db);
  const hasGrant = await shares.hasGrant(params.automationTaskId, params.currentUserId);
  const accessibleTask = resolveScheduledTaskAccess(
    task,
    task?.createdBy,
    hasGrant ? new Set([params.currentUserId]) : new Set<string>(),
    {
      userId: params.currentUserId,
      role: params.role,
    },
  );
  if (!accessibleTask) {
    return null;
  }

  const stepContentRows = params.deps.stepContentRepo
    ? await params.deps.stepContentRepo.getByTask(accessibleTask.id).catch((err) => {
        params.logger.warn({ err, taskId: accessibleTask.id }, "Failed to load automation builder step content");
        return [] as StepContentRow[];
      })
    : [];
  const persistedTask = await createScheduledTaskRepository(params.deps.db)
    .getById(accessibleTask.id)
    .catch((err) => {
      params.logger.warn({ err, taskId: accessibleTask.id }, "Failed to load automation builder task metadata");
      return undefined;
    });
  const runRows = await (params.deps.automationRunsRepo ?? createAutomationRunsRepository(params.deps.db))
    .list(accessibleTask.id)
    .catch((err) => {
      params.logger.warn({ err, taskId: accessibleTask.id }, "Failed to load automation builder run metadata");
      return [];
    });
  const isPlaceholderDraft = Boolean(
    params.deps.stepContentRepo &&
      persistedTask &&
      isAutomationPlaceholderDraft({ row: persistedTask, stepContentRows, runRows }),
  );
  return {
    task: accessibleTask,
    stepContentRows,
    currentAutomation: buildCurrentAutomation({
      task: accessibleTask,
      stepContentRows,
      builderConversationId: params.builderConversationId,
    }),
    isPlaceholderDraft,
  };
}

type AutomationBuilderConversationAccess =
  | { kind: "active" }
  | { kind: "not_found" }
  | { kind: "archived" }
  | { kind: "locked"; lock: AutomationTaskConversationLockSummary }
  | { kind: "stale"; lock: AutomationTaskConversationLockSummary }
  | { kind: "unavailable" }
  | { kind: "error" };

async function resolveAutomationBuilderConversationAccess(params: {
  deps: WebChatRouteDeps;
  taskId: string;
  conversationId: string;
  transcriptUserId: string;
  lease: BuilderLease;
  logger: Logger;
}): Promise<AutomationBuilderConversationAccess> {
  try {
    const access = await createAutomationTaskConversationService(params.deps.db).acquireBuilderConversationLock(
      params.taskId,
      params.conversationId,
      params.transcriptUserId,
      params.lease,
    );
    if (access.kind === "locked") return access;
    if (access.kind === "stale") return access;
    if (access.kind === "active") return { kind: "active" as const };
    if (access.kind === "not_found" || access.kind === "archived") return access;
    return { kind: "error" as const };
  } catch (err) {
    params.logger.warn(
      {
        errorType: err instanceof Error ? err.name : "unknown",
        taskId: params.taskId,
        conversationId: params.conversationId,
        transcriptUserId: params.transcriptUserId,
      },
      "Failed to resolve automation builder conversation access",
    );
    return { kind: "error" };
  }
}

function parseBuilderSteps(value: string | null): WorkflowStep[] {
  if (!value) return [];
  try {
    const parsed = workflowStepSchema.array().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseBuilderEdges(value: string | null): WorkflowEdge[] {
  if (!value) return [];
  try {
    const parsed = workflowEdgeSchema.array().safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function parseBuilderApps(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

const MAX_CURRENT_AUTOMATION_STEPS = 12;
const MAX_CURRENT_AUTOMATION_EDGES = 24;
const MAX_CURRENT_AUTOMATION_CONTENT = 800;
const MAX_CURRENT_AUTOMATION_LIST_ITEMS = 12;

function boundedOptionalBuilderText(value: string | undefined, maxLength: number): string | undefined {
  return value === undefined ? undefined : builderContextText(value, maxLength);
}

function boundedBuilderStep(step: WorkflowStep): WorkflowStep {
  const triggerConfig = step.triggerConfig
    ? (() => {
        const { configuredProps: _configuredProps, ...rest } = step.triggerConfig;
        return {
          ...rest,
          channelId: boundedOptionalBuilderText(rest.channelId, 160),
          scheduleValue: boundedOptionalBuilderText(rest.scheduleValue, 160),
          timezone: boundedOptionalBuilderText(rest.timezone, 120),
          app: boundedOptionalBuilderText(rest.app, 120),
          eventDescription: boundedOptionalBuilderText(rest.eventDescription, 240),
          componentKey: boundedOptionalBuilderText(rest.componentKey, 160),
          canvasWorkflowId: boundedOptionalBuilderText(rest.canvasWorkflowId, 160),
          canvasTriggerNodeId: boundedOptionalBuilderText(rest.canvasTriggerNodeId, 160),
          canvasActionNodeId: boundedOptionalBuilderText(rest.canvasActionNodeId, 160),
          errorMessage: boundedOptionalBuilderText(rest.errorMessage, 400),
        };
      })()
    : undefined;
  return {
    ...step,
    label: builderContextText(step.label, 160),
    icon: builderContextText(step.icon, 80),
    ...(step.agentModel ? { agentModel: builderContextText(step.agentModel, 160) } : {}),
    ...(step.agentSkills
      ? {
          agentSkills: step.agentSkills
            .slice(0, MAX_CURRENT_AUTOMATION_LIST_ITEMS)
            .map((item) => builderContextText(item, 120)),
        }
      : {}),
    ...(step.agentMcpServers
      ? {
          agentMcpServers: step.agentMcpServers
            .slice(0, MAX_CURRENT_AUTOMATION_LIST_ITEMS)
            .map((item) => builderContextText(item, 120)),
        }
      : {}),
    ...(triggerConfig ? { triggerConfig } : {}),
  };
}

function boundedBuilderEdge(edge: WorkflowEdge): WorkflowEdge {
  return {
    ...edge,
    ...(edge.condition ? { condition: builderContextText(edge.condition, 240) } : {}),
    ...(edge.label ? { label: builderContextText(edge.label, 160) } : {}),
  };
}

function buildCurrentAutomation(params: {
  task: ScheduledTask;
  stepContentRows: StepContentRow[];
  builderConversationId: string;
}): CurrentAutomation {
  const steps = parseBuilderSteps(params.task.steps).slice(0, MAX_CURRENT_AUTOMATION_STEPS).map(boundedBuilderStep);
  const stepIds = new Set(steps.map((step) => step.id));
  const edges = parseBuilderEdges(params.task.edges)
    .filter((edge) => stepIds.has(edge.from) && stepIds.has(edge.to))
    .slice(0, MAX_CURRENT_AUTOMATION_EDGES)
    .map(boundedBuilderEdge);
  const stepContent = Object.fromEntries(
    params.stepContentRows
      .filter((row) => stepIds.has(row.step_id))
      .slice(0, MAX_CURRENT_AUTOMATION_STEPS)
      .map((row) => [
        row.step_id,
        {
          contentType: row.content_type === "script" ? ("script" as const) : ("prompt" as const),
          content: builderContextText(row.content, MAX_CURRENT_AUTOMATION_CONTENT),
          apps: parseBuilderApps(row.apps).slice(0, MAX_CURRENT_AUTOMATION_STEPS),
        },
      ]),
  );

  return {
    taskId: params.task.id,
    revision: params.task.revision,
    builderConversationId: params.builderConversationId,
    builderState: {
      title: builderContextText(params.task.title, 240) || null,
      description: builderContextText(params.task.description, 500) || null,
      prompt: builderContextText(params.task.prompt, MAX_CURRENT_AUTOMATION_CONTENT),
      scheduleType: params.task.scheduleType,
      scheduleValue: builderContextText(params.task.scheduleValue, 160),
      timezone: builderContextText(params.task.timezone, 120),
      status: params.task.status,
      delivery: {
        ...params.task.delivery,
        targetId: builderContextText(params.task.delivery.targetId, 160),
        threadTs: params.task.delivery.threadTs ? builderContextText(params.task.delivery.threadTs, 80) : null,
      },
      steps,
      edges,
      stepContent,
    },
  };
}

function builderContextText(value: string | null | undefined, maxLength = 500): string {
  const normalized = (value ?? "")
    .replace(/<\/?automation_builder>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function builderDeliverySummary(task: ScheduledTask): string {
  const delivery = task.delivery;
  const target = builderContextText(delivery.targetId, 160);
  const thread = delivery.threadTs ? ` thread=${builderContextText(delivery.threadTs, 80)}` : "";
  return `${delivery.platform} ${delivery.targetType} ${target}${thread} mode=${delivery.mode}`;
}

function builderStepSummary(step: WorkflowStep, content: StepContentRow | undefined): string {
  const parts = [`- ${builderContextText(step.id, 80)} [${step.type}]: ${builderContextText(step.label, 160)}`];
  if (step.type === "trigger" && step.triggerConfig) {
    parts.push(`trigger: ${builderContextText(JSON.stringify(step.triggerConfig), 260)}`);
  }
  if (step.actionCapabilities) {
    parts.push(`actionCapabilities: ${builderContextText(JSON.stringify(step.actionCapabilities), 260)}`);
  }
  if (content) {
    const kind = content.content_type === "script" ? "script" : "prompt";
    parts.push(`${kind}: ${builderContextText(content.content, 360)}`);
    const apps = parseBuilderApps(content.apps);
    if (apps.length > 0) parts.push(`apps: ${apps.map((app) => builderContextText(app, 60)).join(", ")}`);
  }
  return parts.join(" | ");
}

function automationBuilderContextLines(context: Exclude<AutomationBuilderContext, null>): string[] {
  const { task, stepContentRows } = context;
  const steps = parseBuilderSteps(task.steps);
  const edges = parseBuilderEdges(task.edges);
  const contentByStep = new Map(stepContentRows.map((row) => [row.step_id, row]));
  const lines = [
    "<automation_builder>",
    `task_id: ${task.id}`,
    "The user is working on the automation currently open in the builder.",
    "Treat requests like 'this automation' or 'make it stricter' as applying to this task.",
    "Apply automation changes with ManageScheduledTasks instead of asking the user to edit the builder directly.",
    "current_automation:",
    `title: ${builderContextText(task.title ?? task.prompt, 240)}`,
    `status: ${task.status}`,
    `schedule: ${task.scheduleType} ${builderContextText(task.scheduleValue, 160)} (${task.timezone})`,
    `delivery: ${builderDeliverySummary(task)}`,
    "The originating chat context is authoritative for the user's requested automation. Reuse it before asking the user to repeat details; placeholder builder fields are not the user's request.",
    "Treat the builder transcript plus the current automation revision as the workflow checkpoint. Resume from the last completed action instead of repeating discovery or completed tool calls.",
    "For bounded setup choices such as trigger, schedule, delivery, or execution mode, use AskUserQuestion with 2–4 concrete options, or AskUserQuestions when 2–4 independent choices are ready together. Stop after either question tool call and wait for the user's answer; do not repeat details already present in the originating chat.",
  ];
  const description = builderContextText(task.description, 500);
  if (description) lines.push(`description: ${description}`);
  lines.push(`prompt: ${builderContextText(task.prompt, 700)}`);

  if (steps.length > 0) {
    lines.push("steps:");
    for (const step of steps.slice(0, 12)) {
      lines.push(builderStepSummary(step, contentByStep.get(step.id)));
    }
    if (steps.length > 12) lines.push(`- ... ${steps.length - 12} more steps`);
  }

  if (edges.length > 0) {
    lines.push(`edges: ${edges.map((edge) => `${edge.from}->${edge.to}`).join(", ")}`);
  }

  return lines;
}

function webChatCurrentMessage(
  message: string,
  automationBuilderContext: AutomationBuilderContext,
  planOnly: boolean,
): string {
  if (!automationBuilderContext) return message;
  const lines = [...automationBuilderContextLines(automationBuilderContext), "</automation_builder>"];
  if (planOnly) {
    lines.push(
      "",
      "This turn is plan-only. Inspect and explain, but do not change, run, pause, share, delete, or request the lock for the automation.",
    );
  }
  return [...lines, "", message].join("\n");
}

const MAX_AUTOMATION_BUILDER_HISTORY_MESSAGES = 12;
const MAX_AUTOMATION_BUILDER_HISTORY_MESSAGE_LENGTH = 1200;
const AUTOMATION_BUILDER_MAX_TURNS = 24;
const AUTOMATION_BUILDER_MAX_TOOL_CALLS = 20;
const AUTOMATION_BUILDER_MAX_REPEATED_TOOL_CALLS = 3;
const AUTOMATION_BUILDER_MAX_ELAPSED_MS = 2 * 60_000;
const AUTOMATION_BUILDER_MAX_PERSISTED_TEXT_BYTES = 24 * 1024;
const AUTOMATION_BUILDER_ALLOWED_TOOLS = [
  "mcp__sketch__ManageScheduledTasks",
  "mcp__sketch__ManageAutomationShares",
  "mcp__sketch__SearchDeliveryTargets",
  "mcp__sketch__Search",
  "mcp__sketch__SearchEntities",
  "mcp__sketch__GetEntityContext",
  "mcp__sketch__GetFileContent",
  "mcp__sketch__AskUserQuestion",
  "mcp__sketch__AskUserQuestions",
];

function isAutomationBuilderPlanOnlyMessage(message: string): boolean {
  return /\b(?:plan only|just plan|planning only|do not (?:make )?(?:any )?changes|don't (?:make )?(?:any )?changes|without (?:making|applying) changes|no changes)\b/i.test(
    message,
  );
}

function builderTranscriptPromptMessages(messages: WebChatTranscriptMessage[], userName: string): BufferedMessage[] {
  const promptMessages = messages.flatMap<BufferedMessage>((message) => {
    const text = textFromTranscriptMessage(message);
    if (!text) return [];
    return [
      {
        userName: message.role === "user" ? userName : "Sketch",
        text: builderContextText(text, MAX_AUTOMATION_BUILDER_HISTORY_MESSAGE_LENGTH),
        ts: message.createdAt ?? "",
      },
    ];
  });
  if (promptMessages.length <= MAX_AUTOMATION_BUILDER_HISTORY_MESSAGES) return promptMessages;

  return [promptMessages[0], ...promptMessages.slice(-(MAX_AUTOMATION_BUILDER_HISTORY_MESSAGES - 1))];
}

async function automationBuilderHistoryForPrompt(params: {
  context: Exclude<AutomationBuilderContext, null>;
  builderConversationId: string;
  config: Config;
  workspaceDir: string;
  userId: string;
  userName: string;
  logger: Logger;
}): Promise<BufferedMessage[]> {
  const originConversationId =
    params.context.task.originChat?.platform === "web" ? params.context.task.originChat.conversationId : null;
  const conversationIds = [originConversationId, params.builderConversationId].filter(
    (conversationId, index, ids): conversationId is string =>
      Boolean(conversationId) && ids.indexOf(conversationId) === index,
  );
  const transcripts = await Promise.all(
    conversationIds.map((conversationId) =>
      readWebChatTranscript(params.config, params.workspaceDir, params.userId, params.logger, conversationId),
    ),
  );
  const promptMessages = transcripts.flatMap((messages) => builderTranscriptPromptMessages(messages, params.userName));
  if (promptMessages.length <= MAX_AUTOMATION_BUILDER_HISTORY_MESSAGES) return promptMessages;
  return [promptMessages[0], ...promptMessages.slice(-(MAX_AUTOMATION_BUILDER_HISTORY_MESSAGES - 1))];
}

function isExecutionModeSelectionMessage(message: string): boolean {
  return /\bexecution mode\b/i.test(message) && /\b(?:deterministic|hybrid|agent-led)\b/i.test(message);
}

function builderQuestionIdSuffix(messageId: string): string {
  const suffix = messageId.replace(/[^A-Za-z0-9._-]/g, "").slice(-32);
  return suffix || "current";
}

function deterministicBuilderSetupQuestion(sourceText: string, messageId: string): WebChatQuestion {
  const suffix = builderQuestionIdSuffix(messageId);
  if (/\b(?:invoice|invoices|saas|billing|bill|receipt|receipts)\b/i.test(sourceText)) {
    return {
      id: `invoice-source-${suffix}`,
      prompt: "Where do the SaaS invoices live that this automation should find and send?",
      options: [
        {
          id: "gmail",
          label: "Gmail",
          description: "Search invoice emails or attachments, such as billing messages or an invoices label.",
        },
        {
          id: "outlook",
          label: "Outlook",
          description: "Search Outlook invoice messages or attachments.",
        },
        {
          id: "google-drive",
          label: "Google Drive",
          description: "Find invoice files in a specific Drive folder.",
        },
        {
          id: "another-source",
          label: "Another source",
          description: "Use a different app or storage location; I will ask which one next.",
        },
      ],
    };
  }

  return {
    id: `automation-input-source-${suffix}`,
    prompt: "Where should this automation get the information it needs?",
    options: [
      { id: "email", label: "Email", description: "Read messages or attachments from an email account." },
      {
        id: "cloud-files",
        label: "Cloud files",
        description: "Read files from Drive or another cloud storage location.",
      },
      {
        id: "project-app",
        label: "Project or CRM app",
        description: "Read records, tasks, tickets, or contacts from a connected app.",
      },
      {
        id: "another-source",
        label: "Another source",
        description: "Use a different source; I will ask which one next.",
      },
    ],
  };
}

const AUTOMATION_CARD_INTRO_TEXT = "All set - here's the automation.";
const AUTOMATION_BUILDER_FOLLOW_UP_TEXT =
  "I couldn't finish that step before the turn ended. Your conversation and completed automation changes are saved—tell me to continue and I'll resume from the current automation.";
const AUTOMATION_BUILDER_INTERRUPTED_TEXT =
  "I paused this turn before it could continue. Your conversation and completed automation changes are saved—tell me to continue and I'll resume from the current automation.";
const EMPTY_WEB_CHAT_RESPONSE_TEXT = "I wasn't able to complete that request. Please try again.";
const AUTOMATION_SETUP_MODE_SELECTION_MARKER = "[automation-setup-mode-selection]";

function cleanAutomationSetupModeSelectionMessage(message: string): string {
  if (!message.includes(AUTOMATION_SETUP_MODE_SELECTION_MARKER)) return message;
  const normalized = message.toLowerCase();
  if (/\b(?:deterministic|fixed recipe)\b/.test(normalized)) return "Deterministic selected.";
  if (/\b(?:agent|agent-led|agent led)\b/.test(normalized)) return "Agent selected.";
  if (/\b(?:hybrid|recipe \+ ai)\b/.test(normalized)) return "Hybrid selected.";
  return "Automation mode selected.";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function automationBuilderReferences(artifact: AutomationArtifact): string[] {
  const references = new Set<string>();
  const builderUrl = artifact.builderUrl.trim();
  if (builderUrl) references.add(builderUrl);
  references.add(`/scheduled-tasks/${encodeURIComponent(artifact.taskId)}/edit`);

  const absoluteBuilderUrl = safeUrl(builderUrl);
  if (absoluteBuilderUrl) {
    references.add(`${absoluteBuilderUrl.pathname}${absoluteBuilderUrl.search}${absoluteBuilderUrl.hash}`);
  }

  return Array.from(references).filter((reference) => reference.length > 0);
}

function stripAutomationBuilderReferences(text: string, artifacts: AutomationArtifact[]): string {
  let stripped = text;
  for (const artifact of artifacts) {
    for (const reference of automationBuilderReferences(artifact)) {
      const pattern = escapeRegExp(reference);
      stripped = stripped
        .replace(new RegExp(`\\[[^\\]]*\\]\\(${pattern}\\)`, "gi"), "")
        .replace(new RegExp(`<${pattern}>`, "gi"), "")
        .replace(new RegExp(pattern, "gi"), "");
    }
  }

  return stripped
    .replace(/^[ \t]*(?:open|view|edit|builder|link)(?: the)?(?: automation| builder)?[: -]*$/gim, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeAutomationToolDump(text: string): boolean {
  return (
    /^Automation created:\s*[{[]/s.test(text) ||
    (/^Automation created:/i.test(text) && /"(?:id|prompt|scheduleType|schedule_type|deliveryTarget)"/.test(text))
  );
}

function normalizeAutomationAssistantText(text: string, artifacts: AutomationArtifact[]): string {
  if (artifacts.length === 0) return text;

  const stripped = stripAutomationBuilderReferences(text, artifacts)
    .replace(/\s+(?:open|view|edit|builder|link)(?: the)?(?: automation| builder)?[: -]*$/i, "")
    .trim();
  if (!stripped || /^Automation created:?\.?$/i.test(stripped) || looksLikeAutomationToolDump(stripped)) {
    return AUTOMATION_CARD_INTRO_TEXT;
  }

  return stripped;
}

function relativeWorkspacePath(workspaceDir: string, filePath: string): string | null {
  const workspace = resolve(workspaceDir);
  const file = resolve(filePath);
  const relativePath = relative(workspace, file);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return relativePath.replaceAll("\\", "/");
}

async function webChatFileForUpload(workspaceDir: string, filePath: string): Promise<WebChatFile | null> {
  const relativePath = relativeWorkspacePath(workspaceDir, filePath);
  if (!relativePath) return null;

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return null;

  const ext = extname(filePath).slice(1);
  return {
    name: basename(filePath),
    url: webChatFileUrl(relativePath),
    mediaType: extensionToMime(ext),
    sizeBytes: info.size,
  };
}

function webChatFileUrl(relativePath: string): string {
  return `/api/web-chat/files?path=${encodeURIComponent(relativePath)}`;
}

async function parseWebChatAttachments(
  rawAttachments: unknown[],
  workspaceDir: string,
): Promise<ParsedWebChatAttachment[]> {
  const parsed: ParsedWebChatAttachment[] = [];

  for (const rawAttachment of rawAttachments) {
    if (!isRecord(rawAttachment)) {
      throw new WebChatAttachmentError("VALIDATION_ERROR", "Attachment metadata is invalid", 400);
    }

    const originalName =
      typeof rawAttachment.name === "string" && rawAttachment.name.trim() ? rawAttachment.name : null;
    const requestedPath =
      typeof rawAttachment.relativePath === "string" && rawAttachment.relativePath.trim()
        ? rawAttachment.relativePath
        : typeof rawAttachment.path === "string" && rawAttachment.path.trim()
          ? rawAttachment.path
          : null;

    if (!originalName || !requestedPath) {
      throw new WebChatAttachmentError("VALIDATION_ERROR", "Attachment metadata is incomplete", 400);
    }

    const filePath = resolve(workspaceDir, requestedPath);
    const relativePath = relativeWorkspacePath(workspaceDir, filePath);
    if (!relativePath) {
      throw new WebChatAttachmentError("FORBIDDEN", "Attachment is outside workspace", 403);
    }

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new WebChatAttachmentError("FILE_NOT_FOUND", "Attachment file not found", 404);
    }

    const ext = extname(filePath).slice(1);
    const mimeType =
      typeof rawAttachment.mediaType === "string" && rawAttachment.mediaType.trim()
        ? rawAttachment.mediaType
        : extensionToMime(ext);

    parsed.push({
      attachment: {
        originalName,
        mimeType,
        localPath: filePath,
        sizeBytes: info.size,
      },
      file: {
        name: originalName,
        url: webChatFileUrl(relativePath),
        mediaType: mimeType,
        sizeBytes: info.size,
      },
    });
  }

  return parsed;
}

class WebChatAttachmentError extends Error {
  code: string;
  status: 400 | 403 | 404;

  constructor(code: string, message: string, status: 400 | 403 | 404) {
    super(message);
    this.name = "WebChatAttachmentError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_WEB_CHAT_CONVERSATION_ID = "default";
const WEB_CHAT_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const webChatTranscriptLocks = new Map<string, Promise<void>>();
const webChatAgentRunLocks = new Map<string, Promise<void>>();

function normalizeWebChatConversationId(value: string | null | undefined): string | null {
  const id = (value ?? DEFAULT_WEB_CHAT_CONVERSATION_ID).trim();
  return WEB_CHAT_CONVERSATION_ID_RE.test(id) ? id : null;
}

async function withWebChatTranscriptLock<T>(userId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
  const key = webChatRunKey(userId, conversationId);
  const previous = webChatTranscriptLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  webChatTranscriptLocks.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (webChatTranscriptLocks.get(key) === tail) {
      webChatTranscriptLocks.delete(key);
    }
  }
}

async function withWebChatAgentRunLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = webChatAgentRunLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  webChatAgentRunLocks.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (webChatAgentRunLocks.get(key) === tail) {
      webChatAgentRunLocks.delete(key);
    }
  }
}

function webChatTranscriptDir(config: Config, userId: string): string {
  return resolve(config.DATA_DIR, "web-chat", userId);
}

function webChatTranscriptPath(
  config: Config,
  userId: string,
  conversationId = DEFAULT_WEB_CHAT_CONVERSATION_ID,
): string {
  return resolve(webChatTranscriptDir(config, userId), `${conversationId}.json`);
}

function legacyWebChatTranscriptDir(workspaceDir: string): string {
  return resolve(workspaceDir, "web-chat");
}

function legacyWebChatTranscriptPath(workspaceDir: string, conversationId = DEFAULT_WEB_CHAT_CONVERSATION_ID): string {
  return resolve(legacyWebChatTranscriptDir(workspaceDir), `${conversationId}.json`);
}

async function removeEmptyLegacyWebChatTranscriptDir(workspaceDir: string): Promise<void> {
  await rm(legacyWebChatTranscriptDir(workspaceDir)).catch(() => undefined);
}

async function migrateLegacyWebChatTranscript(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  conversationId: string,
): Promise<void> {
  const transcriptPath = webChatTranscriptPath(config, userId, conversationId);
  const legacyPath = legacyWebChatTranscriptPath(workspaceDir, conversationId);
  const currentInfo = await stat(transcriptPath).catch(() => null);

  if (currentInfo?.isFile()) {
    await rm(legacyPath, { force: true }).catch((err: unknown) => {
      logger.warn({ err, legacyPath }, "Failed to remove legacy web chat transcript");
    });
    await removeEmptyLegacyWebChatTranscriptDir(workspaceDir);
    return;
  }

  const legacyInfo = await stat(legacyPath).catch(() => null);
  if (!legacyInfo?.isFile()) return;

  await mkdir(webChatTranscriptDir(config, userId), { recursive: true });
  await rename(legacyPath, transcriptPath).catch(async (err: unknown) => {
    logger.warn({ err, legacyPath, transcriptPath }, "Failed to move legacy web chat transcript");
    throw err;
  });
  await removeEmptyLegacyWebChatTranscriptDir(workspaceDir);
}

async function migrateLegacyWebChatTranscripts(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
): Promise<void> {
  const legacyDir = legacyWebChatTranscriptDir(workspaceDir);
  const entries = await readdir(legacyDir, { withFileTypes: true }).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    logger.warn({ err, legacyDir }, "Failed to list legacy web chat transcripts");
    return [];
  });

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return;
      const id = entry.name.slice(0, -".json".length);
      const conversationId = normalizeWebChatConversationId(id);
      if (!conversationId || conversationId !== id) return;
      await migrateLegacyWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
    }),
  );
}

function sanitizeTranscriptPart(part: unknown): WebChatStoredPart | null {
  if (!isRecord(part)) return null;
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (part.type === "data-progress" && typeof part.id === "string" && isRecord(part.data)) {
    const { lines } = part.data;
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return null;
    const items = sanitizeWebProgressItems(part.data.items);
    return { type: "data-progress", id: part.id, data: { lines, ...(items ? { items } : {}) } };
  }
  if (part.type === "data-interruption" && typeof part.id === "string" && isRecord(part.data)) {
    const { label, detail } = part.data;
    if (typeof label !== "string" || !label.trim()) return null;
    return {
      type: "data-interruption",
      id: part.id,
      data: { label: label.trim(), ...(typeof detail === "string" && detail.trim() ? { detail: detail.trim() } : {}) },
    };
  }
  if (part.type === "data-integration-connection" && typeof part.id === "string") {
    const data = sanitizeIntegrationConnectionData(part.data);
    return data ? { type: "data-integration-connection", id: part.id, data } : null;
  }
  if (part.type === "data-automation" && typeof part.id === "string") {
    const artifact = automationArtifactSchema.safeParse(part.data);
    return artifact.success ? { type: "data-automation", id: part.id, data: artifact.data } : null;
  }
  if (part.type === "data-automation-handoff" && typeof part.id === "string") {
    const handoff = automationDraftHandoffSchema.safeParse(part.data);
    return handoff.success ? { type: "data-automation-handoff", id: part.id, data: handoff.data } : null;
  }
  if (part.type === "data-question" && typeof part.id === "string") {
    const question = webChatQuestionSchema.safeParse(part.data);
    return question.success ? { type: "data-question", id: part.id, data: question.data } : null;
  }
  if (part.type === "data-question-batch" && typeof part.id === "string") {
    const batch = webChatQuestionBatchSchema.safeParse(part.data);
    return batch.success ? { type: "data-question-batch", id: part.id, data: batch.data } : null;
  }
  if (part.type === "data-question-answer" && typeof part.id === "string") {
    const answer = webChatQuestionAnswerSchema.safeParse(part.data);
    return answer.success ? { type: "data-question-answer", id: part.id, data: answer.data } : null;
  }
  if (part.type === "data-question-batch-answer" && typeof part.id === "string") {
    const answer = webChatQuestionBatchAnswerSchema.safeParse(part.data);
    return answer.success ? { type: "data-question-batch-answer", id: part.id, data: answer.data } : null;
  }
  if (part.type !== "data-file" || typeof part.id !== "string" || !isRecord(part.data)) return null;

  const { name, url, mediaType, sizeBytes } = part.data;
  if (typeof name !== "string" || typeof url !== "string" || typeof mediaType !== "string") return null;
  if (typeof sizeBytes !== "number") return null;
  return {
    type: "data-file",
    id: part.id,
    data: { name, url, mediaType, sizeBytes },
  };
}

function sanitizeWebProgressItems(value: unknown): WebProgressItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.flatMap((item) => {
    const sanitized = sanitizeWebProgressItem(item);
    return sanitized ? [sanitized] : [];
  });
  return items.length > 0 ? items : null;
}

const webProgressIconTypes = new Set(["tool", "skill", "canvas", "generic"]);

function sanitizeWebProgressIcon(value: unknown): WebProgressItem["icon"] | null {
  if (!isRecord(value)) return null;
  const { type, name } = value;
  if (typeof type !== "string" || !webProgressIconTypes.has(type)) return null;
  if (name !== undefined && typeof name !== "string") return null;
  return {
    type: type as WebProgressItem["icon"]["type"],
    ...(name !== undefined ? { name } : {}),
  };
}

function sanitizeWebProgressItem(value: unknown): WebProgressItem | null {
  if (!isRecord(value)) return null;
  const { kind, label, icon, detail, toolName } = value;
  if (typeof kind !== "string" || typeof label !== "string") return null;
  const sanitizedIcon = sanitizeWebProgressIcon(icon);
  if (!sanitizedIcon) return null;
  if (detail !== undefined && typeof detail !== "string") return null;
  if (toolName !== undefined && typeof toolName !== "string") return null;
  return {
    kind: kind as WebProgressItem["kind"],
    label,
    icon: sanitizedIcon,
    ...(detail !== undefined ? { detail } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
  };
}

function sanitizeIntegrationConnectionData(value: unknown): WebChatIntegrationConnectionData | null {
  if (!isRecord(value)) return null;
  const { requestId, appId, appName, executionMode, state, icon, reason, accountName, connectionId } = value;
  if (typeof requestId !== "string" || !requestId.trim()) return null;
  if (typeof appId !== "string" || !appId.trim()) return null;
  if (typeof appName !== "string" || !appName.trim()) return null;
  if (state !== undefined && state !== "connect" && state !== "connected") return null;
  if (icon !== undefined && typeof icon !== "string") return null;
  if (reason !== undefined && typeof reason !== "string") return null;
  if (accountName !== undefined && typeof accountName !== "string") return null;
  if (connectionId !== undefined && connectionId !== null && typeof connectionId !== "string") return null;
  return {
    requestId: requestId.trim(),
    appId: appId.trim(),
    appName: appName.trim(),
    ...(state === "connect" || state === "connected" ? { state } : {}),
    ...(typeof icon === "string" && icon.trim() ? { icon: icon.trim() } : {}),
    ...(executionMode === "cli" || executionMode === "api" ? { executionMode } : {}),
    ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
    ...(typeof accountName === "string" && accountName.trim() ? { accountName: accountName.trim() } : {}),
    ...(typeof connectionId === "string" && connectionId.trim()
      ? { connectionId: connectionId.trim() }
      : connectionId === null
        ? { connectionId: null }
        : {}),
  };
}

function sanitizeTranscriptMessage(message: unknown): WebChatTranscriptMessage | null {
  if (!isRecord(message)) return null;
  if (typeof message.id !== "string") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (!Array.isArray(message.parts)) return null;
  const createdAt = typeof message.createdAt === "string" && message.createdAt.trim() ? message.createdAt : undefined;

  const parts: WebChatStoredPart[] = message.parts.flatMap((part) => {
    const sanitized = sanitizeTranscriptPart(part);
    return sanitized ? [sanitized] : [];
  });
  if (parts.length === 0) return null;
  const integrationConnections = parts
    .filter((part) => part.type === "data-integration-connection")
    .map((part) => part.data);
  const sanitizedParts: WebChatStoredPart[] =
    message.role === "assistant" && integrationConnections.length > 0
      ? parts.flatMap((part): WebChatStoredPart[] => {
          if (part.type !== "text") return [part];
          const text = sanitizeIntegrationConnectionText(part.text, integrationConnections);
          return text ? [{ type: "text" as const, text }] : [];
        })
      : parts;
  if (sanitizedParts.length === 0) return null;
  return { id: message.id, role: message.role, ...(createdAt ? { createdAt } : {}), parts: sanitizedParts };
}

export async function readWebChatTranscript(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  conversationId = DEFAULT_WEB_CHAT_CONVERSATION_ID,
): Promise<WebChatTranscriptMessage[]> {
  await migrateLegacyWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
  const transcriptPath = webChatTranscriptPath(config, userId, conversationId);
  const raw = await readFile(transcriptPath, "utf-8").catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    logger.warn({ err, transcriptPath }, "Failed to read web chat transcript");
    return null;
  });
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return [];
    return parsed.messages.flatMap((message) => {
      const sanitized = sanitizeTranscriptMessage(message);
      return sanitized ? [sanitized] : [];
    });
  } catch (err) {
    logger.warn({ err, transcriptPath }, "Failed to parse web chat transcript");
    return [];
  }
}

function latestPendingWebChatInteraction(messages: WebChatTranscriptMessage[]): WebChatQuestionInteraction | null {
  const latest = messages.at(-1);
  if (!latest || latest.role !== "assistant") return null;
  for (let index = latest.parts.length - 1; index >= 0; index -= 1) {
    const part = latest.parts[index];
    if (part.type === "data-question") return part.data;
    if (part.type === "data-question-batch") return part.data;
  }
  return null;
}

function questionAnswerMatchesPendingInteraction(
  answer: WebChatQuestionAnswer | WebChatQuestionBatchAnswer,
  pending: WebChatQuestionInteraction | null,
): boolean {
  if (!pending) return false;
  if ("batchId" in pending) {
    if (
      !("answers" in answer) ||
      answer.batchId !== pending.batchId ||
      answer.answers.length !== pending.questions.length
    ) {
      return false;
    }
    return pending.questions.every((question) => {
      const selected = answer.answers.find((candidate) => candidate.questionId === question.id);
      return Boolean(
        selected &&
          ("customResponse" in selected || question.options.some((option) => option.id === selected.optionId)),
      );
    });
  }
  if ("answers" in answer || answer.questionId !== pending.id) return false;
  return "customResponse" in answer || pending.options.some((option) => option.id === answer.optionId);
}

export async function readWebChatTranscriptUpdatedAt(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  conversationId = DEFAULT_WEB_CHAT_CONVERSATION_ID,
): Promise<string | null> {
  await migrateLegacyWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
  const transcriptPath = webChatTranscriptPath(config, userId, conversationId);
  const info = await stat(transcriptPath).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    logger.warn({ err, transcriptPath }, "Failed to stat web chat transcript");
    return null;
  });
  return info?.isFile() ? info.mtime.toISOString() : null;
}

async function writeWebChatTranscript(
  config: Config,
  userId: string,
  conversationId: string,
  messages: WebChatTranscriptMessage[],
): Promise<void> {
  const transcriptPath = webChatTranscriptPath(config, userId, conversationId);
  await mkdir(webChatTranscriptDir(config, userId), { recursive: true });
  const transcript: WebChatTranscript = { version: 1, messages };
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
}

function createUserTranscriptMessage(
  message: LatestUserMessage,
  files: Array<{ id: string; data: WebChatFile }> = [],
  questionAnswer?: WebChatQuestionAnswer | WebChatQuestionBatchAnswer,
): WebChatTranscriptMessage {
  const parts: WebChatTranscriptPart[] = [{ type: "text", text: message.text }];
  if (questionAnswer && "batchId" in questionAnswer) {
    parts.push({
      type: "data-question-batch-answer",
      id: `question-batch-answer-${questionAnswer.batchId}`,
      data: questionAnswer,
    });
  } else if (questionAnswer) {
    parts.push({
      type: "data-question-answer",
      id: `question-answer-${questionAnswer.questionId}`,
      data: questionAnswer,
    });
  }
  for (const file of files) {
    parts.push({ type: "data-file", id: file.id, data: file.data });
  }

  return {
    id: message.id ?? `user-${randomUUID()}`,
    role: "user",
    createdAt: new Date().toISOString(),
    parts,
  };
}

function createProgressTranscriptMessage(
  id: string,
  progress: WebChatProgressData = { lines: ["Thinking…"] },
): WebChatTranscriptMessage {
  return {
    id,
    role: "assistant",
    createdAt: new Date().toISOString(),
    parts: [{ type: "data-progress", id: "progress", data: progress }],
  };
}

function isPendingProgressTranscriptMessage(message: WebChatTranscriptMessage): boolean {
  return (
    message.role === "assistant" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "data-progress")
  );
}

function createAssistantTranscriptMessage(
  finalText: string,
  files: Array<{ id: string; data: WebChatFile }>,
  automations: Array<{ id: string; data: AutomationArtifact }> = [],
  integrationConnections: Array<{ id: string; data: WebChatIntegrationConnectionData }> = [],
  question?: WebChatQuestionPart,
): WebChatTranscriptMessage | null {
  const parts: WebChatTranscriptPart[] = [];
  if (finalText) parts.push({ type: "text", text: finalText });
  for (const file of files) {
    parts.push({ type: "data-file", id: file.id, data: file.data });
  }
  for (const automation of automations) {
    parts.push({ type: "data-automation", id: automation.id, data: automation.data });
  }
  for (const connection of integrationConnections) {
    parts.push({ type: "data-integration-connection", id: connection.id, data: connection.data });
  }
  if (question) {
    if (isQuestionBatch(question.data)) {
      parts.push({ type: "data-question-batch", id: question.id, data: question.data });
    } else {
      parts.push({ type: "data-question", id: question.id, data: question.data });
    }
  }
  if (parts.length === 0) return null;
  return { id: `assistant-${randomUUID()}`, role: "assistant", createdAt: new Date().toISOString(), parts };
}

function createAutomationDraftAssistantTranscriptMessage(
  finalText: string,
  handoff: { id: string; data: AutomationDraftHandoff },
): WebChatTranscriptMessage {
  return {
    id: `assistant-${randomUUID()}`,
    role: "assistant",
    createdAt: new Date().toISOString(),
    parts: [
      ...(finalText ? [{ type: "text" as const, text: finalText }] : []),
      { type: "data-automation-handoff" as const, id: handoff.id, data: handoff.data },
    ],
  };
}

function createInterruptedAssistantTranscriptMessage(finalText: string): WebChatTranscriptMessage {
  const parts: WebChatTranscriptPart[] = [];
  if (finalText) parts.push({ type: "text", text: finalText });
  parts.push({ type: "data-interruption", id: "interruption", data: WEB_CHAT_INTERRUPTION_DATA });
  return { id: `assistant-${randomUUID()}`, role: "assistant", createdAt: new Date().toISOString(), parts };
}

async function deterministicIntegrationCardsForWebChat(params: {
  deps: WebChatRouteDeps;
  userId: string;
  userMessage: string;
  userEmail: string | null;
  userName: string | null;
  logger: Logger;
}): Promise<WebChatIntegrationConnectionData[]> {
  if (!isConnectedAccountsInquiry(params.userMessage)) return [];
  try {
    return await connectedAccountCardsForUser({
      loadIntegrationProvider: params.deps.loadIntegrationProvider,
      cliIntegrations: params.deps.cliIntegrations,
      currentUserId: params.userId,
      userEmail: params.userEmail,
      userName: params.userName,
    });
  } catch (err) {
    params.logger.warn({ err }, "Failed to resolve connected account cards for web chat");
    return [];
  }
}

function shouldBufferWebChatTextAfterProgress(event: ProgressEvent): boolean {
  if (event.kind !== "tool_use") return false;
  const toolName = event.toolName.toLowerCase().replace(/_/g, "-");
  if (toolName === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";
    return /\$\{?CANVAS_CLI\}?/.test(command);
  }
  return (
    toolName.includes("canvas") ||
    toolName.includes("pipedream") ||
    toolName.includes("search-app") ||
    toolName.includes("direct-execute-action") ||
    toolName.includes("fetch-remote-options") ||
    toolName.includes("create-sketch-trigger-workflow")
  );
}

async function appendWebChatPendingTurn(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  conversationId: string,
  userMessage: WebChatTranscriptMessage,
  progressMessage: WebChatTranscriptMessage,
  questionAnswer?: WebChatQuestionAnswer | WebChatQuestionBatchAnswer,
): Promise<boolean> {
  return withWebChatTranscriptLock(userId, conversationId, async () => {
    const existing = await readWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
    if (
      questionAnswer &&
      !questionAnswerMatchesPendingInteraction(questionAnswer, latestPendingWebChatInteraction(existing))
    ) {
      return false;
    }
    const next = [...existing];
    if (!next.some((message) => message.id === userMessage.id)) {
      next.push(userMessage);
    }
    const progressIndex = next.findIndex((message) => message.id === progressMessage.id);
    if (progressIndex === -1) {
      next.push(progressMessage);
    } else {
      next[progressIndex] = progressMessage;
    }
    await writeWebChatTranscript(config, userId, conversationId, next);
    return true;
  });
}

async function updateWebChatProgressMessage(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  conversationId: string,
  progressMessageId: string,
  progress: WebChatProgressData,
): Promise<void> {
  await withWebChatTranscriptLock(userId, conversationId, async () => {
    const existing = await readWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
    if (!existing.some((message) => message.id === progressMessageId)) return;
    await writeWebChatTranscript(
      config,
      userId,
      conversationId,
      existing.map((message) =>
        message.id === progressMessageId ? createProgressTranscriptMessage(progressMessageId, progress) : message,
      ),
    );
  });
}

async function completeWebChatProgressMessage(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  conversationId: string,
  progressMessageId: string,
  assistantMessage: WebChatTranscriptMessage | null,
): Promise<void> {
  await withWebChatTranscriptLock(userId, conversationId, async () => {
    const existing = await readWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
    const progressIndex = existing.findIndex((message) => message.id === progressMessageId);
    if (progressIndex === -1) {
      await writeWebChatTranscript(
        config,
        userId,
        conversationId,
        assistantMessage ? [...existing, assistantMessage] : existing,
      );
      return;
    }

    const next = assistantMessage
      ? existing.map((message, index) => (index === progressIndex ? assistantMessage : message))
      : existing.filter((_, index) => index !== progressIndex);
    await writeWebChatTranscript(config, userId, conversationId, next);
  });
}

async function interruptLatestPendingWebChatProgress(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  conversationId: string,
): Promise<boolean> {
  return withWebChatTranscriptLock(userId, conversationId, async () => {
    const existing = await readWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
    const latest = existing.at(-1);
    if (!latest || !isPendingProgressTranscriptMessage(latest)) return false;

    const next = [...existing];
    next[next.length - 1] = createInterruptedAssistantTranscriptMessage("");
    await writeWebChatTranscript(config, userId, conversationId, next);
    return true;
  });
}

function textFromTranscriptMessage(message: WebChatTranscriptMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function readWebChatConversationSummaries(
  config: Config,
  workspaceDir: string,
  userId: string,
  logger: Logger,
  db: Kysely<DB>,
  includeBuilder: boolean,
): Promise<WebChatConversationSummary[]> {
  await migrateLegacyWebChatTranscripts(config, workspaceDir, userId, logger);
  const transcriptDir = webChatTranscriptDir(config, userId);
  const entries = await readdir(transcriptDir, { withFileTypes: true }).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    logger.warn({ err, transcriptDir }, "Failed to list web chat transcripts");
    return [];
  });

  const associations = await createScheduledTaskConversationRepository(db).listByTranscriptUser(userId, {
    includeArchived: true,
  });
  const kindsByConversation = new Map<string, Set<string>>();
  const builderTaskByConversation = new Map<string, string>();
  for (const association of associations) {
    const kinds = kindsByConversation.get(association.conversation_id) ?? new Set<string>();
    kinds.add(association.kind);
    kindsByConversation.set(association.conversation_id, kinds);
    if (association.kind === "web_chat" && !builderTaskByConversation.has(association.conversation_id)) {
      builderTaskByConversation.set(association.conversation_id, association.task_id);
    }
  }

  const summaries = await Promise.all(
    entries.flatMap(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
      const id = entry.name.slice(0, -".json".length);
      const conversationId = normalizeWebChatConversationId(id);
      if (!conversationId || conversationId !== id) return [];
      const kinds = kindsByConversation.get(conversationId);
      if (!includeBuilder && kinds?.has("builder") && !kinds.has("web_chat")) return [];

      const messages = await readWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
      const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
      if (!latestUserMessage) return [];

      const title = cleanAutomationSetupModeSelectionMessage(textFromTranscriptMessage(latestUserMessage));
      const updatedAt = await readWebChatTranscriptUpdatedAt(config, workspaceDir, userId, logger, conversationId);
      if (!title || !updatedAt) return [];

      const builderTaskId = builderTaskByConversation.get(conversationId);
      return [
        { id: conversationId, title, channel: "web" as const, updatedAt, ...(builderTaskId ? { builderTaskId } : {}) },
      ];
    }),
  );

  return summaries
    .flat()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function whatsappJid(phoneNumber: string): string {
  return `${phoneNumber.replace("+", "")}@s.whatsapp.net`;
}

async function resolveWebChatDmContext(
  deps: WebChatRouteDeps,
  currentUser: Awaited<ReturnType<UserRepo["findById"]>>,
  settingsRow: Awaited<ReturnType<SettingsRepo["get"]>>,
): Promise<{ platform: "slack" | "whatsapp"; deliveryTarget: string } | null> {
  if (currentUser?.slack_user_id && deps.getSlack) {
    const slack = deps.getSlack();
    if (slack) {
      try {
        const channelId = await slack.openDmChannel(
          currentUser.slack_user_id,
          settingsRow?.slack_bot_token ?? undefined,
        );
        if (channelId) {
          return { platform: "slack", deliveryTarget: channelId };
        }
      } catch (err) {
        deps.logger.warn({ err, userId: currentUser.id }, "Failed to resolve Slack DM for web chat");
      }
    }
  }

  if (currentUser?.whatsapp_number) {
    return { platform: "whatsapp", deliveryTarget: whatsappJid(currentUser.whatsapp_number) };
  }

  return null;
}

function automationBuilderTaskContext(params: {
  context: Exclude<AutomationBuilderContext, null>;
  currentUser: NonNullable<Awaited<ReturnType<UserRepo["findById"]>>>;
  role: string | undefined;
  conversationId: string;
  lease: BuilderLease;
  planOnly: boolean;
}) {
  const task = params.context.task;
  return {
    platform: task.platform,
    contextType: task.contextType,
    deliveryTarget: task.deliveryTarget,
    createdBy: params.currentUser.id,
    conversationKind: "builder" as const,
    creatorTimezone: params.currentUser.timezone,
    threadTs: task.threadTs ?? undefined,
    canManageAnyTask: params.role === "admin",
    currentAutomation: params.context.currentAutomation,
    authoringLease: { sessionId: params.lease.clientSessionId, generation: params.lease.generation },
    planOnly: params.planOnly,
    origin: {
      platform: "web" as const,
      conversationId: params.conversationId,
      providerThreadId: null,
      currentMessageId: null,
    },
  };
}

export function webChatRoutes(deps: WebChatRouteDeps) {
  const routes = new Hono();
  const toolConfig = { BASE_URL: deps.config.BASE_URL, PORT: deps.config.PORT };

  routes.get("/progress-settings", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    return c.json({ toolProgress: resolveToolProgress(currentUser.tool_progress) });
  });

  routes.patch("/progress-settings", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const toolProgress = isRecord(body) ? body.toolProgress : null;
    if (!isWebChatToolProgress(toolProgress)) {
      return c.json(badRequest("VALIDATION_ERROR", "Tool progress must be off, friendly, or technical"), 400);
    }

    const updated = await deps.users.update(currentUser.id, { toolProgress });
    return c.json({ toolProgress: resolveToolProgress(updated.tool_progress) });
  });

  routes.get("/conversations", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    const conversations = await readWebChatConversationSummaries(
      deps.config,
      workspaceDir,
      currentUser.id,
      deps.logger,
      deps.db,
      c.req.query("includeBuilder") === "true",
    );
    return c.json({ conversations });
  });

  routes.delete("/conversations/:conversationId", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const conversationId = normalizeWebChatConversationId(c.req.param("conversationId"));
    if (!conversationId) {
      return c.json(badRequest("VALIDATION_ERROR", "Conversation id is invalid"), 400);
    }

    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    await migrateLegacyWebChatTranscript(deps.config, workspaceDir, currentUser.id, deps.logger, conversationId);
    const transcriptPath = webChatTranscriptPath(deps.config, currentUser.id, conversationId);
    const info = await stat(transcriptPath).catch(() => null);
    if (!info?.isFile()) {
      return c.json(badRequest("CONVERSATION_NOT_FOUND", "Conversation not found"), 404);
    }

    await rm(transcriptPath);
    await rm(legacyWebChatTranscriptPath(workspaceDir, conversationId), { force: true });
    await removeEmptyLegacyWebChatTranscriptDir(workspaceDir);
    await archiveRuntimeSessions(deps.db, currentUser.id, conversationId);
    return c.json({ success: true });
  });

  routes.post("/conversations/:conversationId/interruptions", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const conversationId = normalizeWebChatConversationId(c.req.param("conversationId"));
    if (!conversationId) {
      return c.json(badRequest("VALIDATION_ERROR", "Conversation id is invalid"), 400);
    }

    const automationTaskId = extractAutomationTaskId({ automationTaskId: c.req.query("automationTaskId") });
    const interruptionBody = automationTaskId ? await c.req.json().catch(() => ({})) : {};
    const interruptionLease = automationTaskId ? parseBuilderLease(interruptionBody) : null;
    if (automationTaskId && !interruptionLease) {
      return c.json(badRequest("VALIDATION_ERROR", "clientSessionId and generation are required"), 400);
    }
    let builderInterruption = false;
    let builderConversationRequest = false;
    if (automationTaskId && deps.scheduler?.getTaskById) {
      const task = await deps.scheduler.getTaskById(automationTaskId).catch((err) => {
        deps.logger.warn({ err, taskId: automationTaskId }, "Failed to resolve builder interruption task");
        return null;
      });
      const shares = createAutomationSharesRepository(deps.db);
      const hasGrant = await shares.hasGrant(automationTaskId, currentUser.id);
      const accessibleTask = resolveScheduledTaskAccess(
        task,
        task?.createdBy,
        hasGrant ? new Set([currentUser.id]) : new Set<string>(),
        {
          userId: currentUser.id,
          role: c.get("role"),
        },
      );
      if (!accessibleTask) {
        return c.json(badRequest("AUTOMATION_NOT_FOUND", "Automation not found"), 404);
      }

      const conversationAccess = await createAutomationTaskConversationService(deps.db)
        .acquireBuilderConversationLock(
          accessibleTask.id,
          conversationId,
          currentUser.id,
          interruptionLease ?? undefined,
        )
        .catch((err) => {
          deps.logger.warn(
            { err, taskId: accessibleTask.id, conversationId, userId: currentUser.id },
            "Failed to resolve builder interruption conversation",
          );
          return { kind: "unavailable" as const };
        });
      if (conversationAccess.kind === "not_found") {
        return c.json(badRequest("CONVERSATION_NOT_FOUND", "Conversation is not associated with this task"), 404);
      }
      if (conversationAccess.kind === "archived") {
        return c.json(
          badRequest("CONVERSATION_ARCHIVED", "Conversation is archived; restore it before selecting"),
          409,
        );
      }
      if (conversationAccess.kind === "locked") {
        return c.json(
          {
            error: {
              code: "BUILDER_CHAT_LOCKED",
              message: "This automation's builder chat is in use by another session",
              builderLock: conversationAccess.lock,
            },
          },
          409,
        );
      }
      if (conversationAccess.kind === "stale") {
        return c.json(
          {
            error: {
              code: "LEASE_STALE",
              message: "This builder session is no longer current",
              builderLock: conversationAccess.lock,
            },
          },
          409,
        );
      }
      if (conversationAccess.kind === "unavailable") {
        return c.json(badRequest("CONVERSATION_UNAVAILABLE", "Conversation is temporarily unavailable"), 503);
      }

      builderConversationRequest = true;
      builderInterruption = interruptActiveBuilderWebChatRun(accessibleTask.id);
    }

    const interruptedActiveRun = builderConversationRequest
      ? builderInterruption
      : interruptActiveWebChatRun(currentUser.id, conversationId);
    if (interruptedActiveRun) {
      return c.json({ success: true, interrupted: true });
    }

    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    const interruptedPendingTranscript = await interruptLatestPendingWebChatProgress(
      deps.config,
      workspaceDir,
      currentUser.id,
      deps.logger,
      conversationId,
    );
    return c.json({ success: true, interrupted: interruptedPendingTranscript });
  });

  routes.get("/messages", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const conversationId = normalizeWebChatConversationId(c.req.query("conversationId"));
    if (!conversationId) {
      return c.json(badRequest("VALIDATION_ERROR", "Conversation id is invalid"), 400);
    }

    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    await migrateLegacyWebChatTranscripts(deps.config, workspaceDir, currentUser.id, deps.logger);
    const messages = await readWebChatTranscript(
      deps.config,
      workspaceDir,
      currentUser.id,
      deps.logger,
      conversationId,
    );
    const updatedAt = await readWebChatTranscriptUpdatedAt(
      deps.config,
      workspaceDir,
      currentUser.id,
      deps.logger,
      conversationId,
    );
    return c.json({ messages, updatedAt });
  });

  routes.get("/files", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const requestedPath = c.req.query("path");
    if (!requestedPath) {
      return c.json(badRequest("VALIDATION_ERROR", "File path is required"), 400);
    }

    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    const filePath = resolve(workspaceDir, requestedPath);
    const relativePath = relativeWorkspacePath(workspaceDir, filePath);
    if (!relativePath) {
      return c.json(badRequest("FORBIDDEN", "File is outside workspace"), 403);
    }

    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      return c.json(badRequest("FILE_NOT_FOUND", "File not found"), 404);
    }

    const bytes = await readFile(filePath);
    const ext = extname(filePath).slice(1);
    const filename = basename(filePath).replaceAll('"', "_").replaceAll("\\", "_");

    return new Response(bytes, {
      headers: {
        "content-type": extensionToMime(ext),
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  routes.post("/transcribe", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json(badRequest("VALIDATION_ERROR", "Audio file is required"), 400);
    }

    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    const ext = extname(file.name || "audio.webm").slice(1) || "webm";
    const filename = `voice-${Date.now()}.${ext}`;
    const filePath = resolve(workspaceDir, "attachments", filename);
    const mimeType = file.type || extensionToMime(ext);
    await mkdir(resolve(workspaceDir, "attachments"), { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    const maxSize = deps.config.MAX_FILE_SIZE_MB * 1024 * 1024;
    if (buffer.length > maxSize) {
      return c.json(
        badRequest("FILE_TOO_LARGE", `File exceeds maximum size of ${deps.config.MAX_FILE_SIZE_MB}MB`),
        413,
      );
    }
    await writeFile(filePath, buffer);

    let transcriptPath: string | null = null;
    try {
      const result = await transcribeAudioFile(filePath, {
        loadSettings: () => deps.settings.get(),
        logger: deps.logger,
        env: { ...process.env, OPENROUTER_API_KEY: deps.config.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY },
        mimeType,
      });
      if (result.kind === "file") {
        transcriptPath = result.transcriptPath;
      }
      const text = result.kind === "inline" ? result.text : await readFile(result.transcriptPath, "utf-8");
      return c.json({ text });
    } catch (err) {
      deps.logger.warn({ err }, "Web chat transcription failed");
      return c.json(badRequest("TRANSCRIPTION_FAILED", errorMessage(err)), 500);
    } finally {
      await rm(filePath, { force: true });
      if (transcriptPath) {
        await rm(transcriptPath, { force: true });
      }
    }
  });

  routes.post("/attachments", async (c) => {
    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || typeof file === "string") {
      return c.json(badRequest("VALIDATION_ERROR", "File is required"), 400);
    }

    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    const buffer = Buffer.from(await file.arrayBuffer());
    const maxSize = deps.config.MAX_FILE_SIZE_MB * 1024 * 1024;
    if (buffer.length > maxSize) {
      return c.json(
        badRequest("FILE_TOO_LARGE", `File exceeds maximum size of ${deps.config.MAX_FILE_SIZE_MB}MB`),
        413,
      );
    }

    const originalName = file.name || "unnamed";
    const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${Date.now()}-${sanitized}`;
    const attachmentsDir = resolve(workspaceDir, "attachments");
    await mkdir(attachmentsDir, { recursive: true });
    const filePath = resolve(attachmentsDir, filename);
    await writeFile(filePath, buffer);

    const ext = extname(filePath).slice(1);
    const mimeType = file.type || extensionToMime(ext);
    const relativePath = relativeWorkspacePath(workspaceDir, filePath);
    if (!relativePath) {
      await rm(filePath, { force: true });
      return c.json(badRequest("FORBIDDEN", "File is outside workspace"), 403);
    }

    return c.json({
      name: originalName,
      path: relativePath,
      relativePath,
      url: webChatFileUrl(relativePath),
      mediaType: mimeType,
      sizeBytes: buffer.length,
    });
  });

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const incomingQuestionAnswer = extractLatestQuestionAnswer(body);
    let latestUserMessage = extractLatestUserMessage(body);
    let selectedAutomationTaskOptionId: string | undefined;
    if (!latestUserMessage && !incomingQuestionAnswer.present) {
      return c.json(badRequest("VALIDATION_ERROR", "Message is required"), 400);
    }

    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }
    const conversationId = normalizeWebChatConversationId(c.req.query("conversationId"));
    if (!conversationId) {
      return c.json(badRequest("VALIDATION_ERROR", "Conversation id is invalid"), 400);
    }

    const settingsRow = await deps.settings.get();
    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    let questionAnswer: WebChatQuestionAnswer | WebChatQuestionBatchAnswer | undefined;
    if (incomingQuestionAnswer.present) {
      const incomingAnswer = incomingQuestionAnswer.answer;
      if (!incomingAnswer) {
        return c.json(badRequest("QUESTION_ANSWER_INVALID", "Question answer is invalid"), 400);
      }
      const existingTranscript = await withWebChatTranscriptLock(currentUser.id, conversationId, () =>
        readWebChatTranscript(deps.config, workspaceDir, currentUser.id, deps.logger, conversationId),
      );
      const pendingInteraction = latestPendingWebChatInteraction(existingTranscript);
      if (!pendingInteraction) {
        return c.json(badRequest("QUESTION_NOT_PENDING", "There is no pending question to answer"), 409);
      }

      if ("batchId" in pendingInteraction) {
        const answer = incomingAnswer;
        if (!("answers" in answer) || answer.batchId !== pendingInteraction.batchId) {
          return c.json(badRequest("QUESTION_STALE", "That question batch is no longer pending"), 409);
        }
        if (answer.answers.length !== pendingInteraction.questions.length) {
          return c.json(badRequest("QUESTION_ANSWER_INVALID", "Every pending question needs one answer"), 400);
        }
        const selectedLabels: string[] = [];
        for (const question of pendingInteraction.questions) {
          const selected = answer.answers.find((candidate) => candidate.questionId === question.id);
          if (!selected) {
            return c.json(
              badRequest("QUESTION_OPTION_INVALID", "That option is not available for the pending question batch"),
              400,
            );
          }
          if ("customResponse" in selected) {
            selectedLabels.push(selected.customResponse);
            continue;
          }
          const option = question.options.find((candidate) => candidate.id === selected.optionId);
          if (!option) {
            return c.json(
              badRequest("QUESTION_OPTION_INVALID", "That option is not available for the pending question batch"),
              400,
            );
          }
          selectedLabels.push(option.label);
        }
        questionAnswer = answer;
        latestUserMessage = { id: latestUserMessage?.id ?? null, text: selectedLabels.join(", ") };
      } else {
        const answer = incomingAnswer;
        if ("answers" in answer || answer.questionId !== pendingInteraction.id) {
          return c.json(badRequest("QUESTION_STALE", "That question is no longer pending"), 409);
        }
        if ("customResponse" in answer) {
          questionAnswer = answer;
          latestUserMessage = { id: latestUserMessage?.id ?? null, text: answer.customResponse };
        } else {
          const selectedOption = pendingInteraction.options.find((option) => option.id === answer.optionId);
          if (!selectedOption) {
            return c.json(
              badRequest("QUESTION_OPTION_INVALID", "That option is not available for the pending question"),
              400,
            );
          }
          questionAnswer = answer;
          if (pendingInteraction.id.startsWith("automation-update-") && "optionId" in answer) {
            selectedAutomationTaskOptionId = answer.optionId;
          }
          latestUserMessage = { id: latestUserMessage?.id ?? null, text: selectedOption.label };
        }
      }
    }
    if (!latestUserMessage) {
      return c.json(badRequest("VALIDATION_ERROR", "Message is required"), 400);
    }
    const message = latestUserMessage.text;
    const automationTaskId = extractAutomationTaskId(body);
    const builderLease = automationTaskId ? parseBuilderLease(body) : null;
    if (automationTaskId && !builderLease) {
      return c.json(badRequest("VALIDATION_ERROR", "clientSessionId and generation are required"), 400);
    }
    const rawAttachments = isRecord(body) && Array.isArray(body.attachments) ? body.attachments : [];
    let parsedAttachments: ParsedWebChatAttachment[];
    try {
      parsedAttachments = await parseWebChatAttachments(rawAttachments, workspaceDir);
    } catch (err) {
      if (err instanceof WebChatAttachmentError) {
        return c.json(badRequest(err.code, err.message), err.status);
      }
      throw err;
    }
    const attachments = parsedAttachments.map((item) => item.attachment);
    const transcriptUserFiles = parsedAttachments.map((item, index) => ({
      id: `attachment-${index}`,
      data: item.file,
    }));
    const automationBuilderContext = await resolveAutomationBuilderContext({
      deps,
      currentUserId: currentUser.id,
      role: c.get("role"),
      automationTaskId,
      builderConversationId: conversationId,
      logger: deps.logger,
    });
    if (automationTaskId && !automationBuilderContext) {
      return c.json(badRequest("AUTOMATION_NOT_FOUND", "Automation not found"), 404);
    }
    if (automationBuilderContext) {
      const conversationAccess = await resolveAutomationBuilderConversationAccess({
        deps,
        taskId: automationBuilderContext.task.id,
        conversationId,
        transcriptUserId: currentUser.id,
        lease: builderLease as BuilderLease,
        logger: deps.logger,
      });
      if (conversationAccess.kind === "not_found") {
        return c.json(badRequest("CONVERSATION_NOT_FOUND", "Conversation is not associated with this task"), 404);
      }
      if (conversationAccess.kind === "archived") {
        return c.json(
          badRequest("CONVERSATION_ARCHIVED", "Conversation is archived; restore it before selecting"),
          409,
        );
      }
      if (conversationAccess.kind === "locked") {
        return c.json(
          {
            error: {
              code: "BUILDER_CHAT_LOCKED",
              message: "This automation's builder chat is in use by another session",
              builderLock: conversationAccess.lock,
            },
          },
          409,
        );
      }
      if (conversationAccess.kind === "stale") {
        return c.json(
          {
            error: {
              code: "LEASE_STALE",
              message: "This builder session is no longer current",
              builderLock: conversationAccess.lock,
            },
          },
          409,
        );
      }
      if (conversationAccess.kind === "error") {
        return c.json(badRequest("CONVERSATION_UNAVAILABLE", "Conversation is temporarily unavailable"), 503);
      }
    }
    await migrateLegacyWebChatTranscripts(deps.config, workspaceDir, currentUser.id, deps.logger);
    const dmContext = await resolveWebChatDmContext(deps, currentUser, settingsRow);
    const integrationMcpServers = deps.buildMcpServers ? await deps.buildMcpServers(currentUser.email) : {};
    const builderPlanOnly = Boolean(automationBuilderContext && isAutomationBuilderPlanOnlyMessage(message));
    const taskContext = automationBuilderContext
      ? automationBuilderTaskContext({
          context: automationBuilderContext,
          currentUser,
          role: c.get("role"),
          conversationId,
          lease: builderLease as BuilderLease,
          planOnly: builderPlanOnly,
        })
      : dmContext
        ? {
            platform: dmContext.platform,
            contextType: "dm" as const,
            deliveryTarget: dmContext.deliveryTarget,
            createdBy: currentUser.id,
            conversationKind: "web_chat" as const,
            creatorTimezone: currentUser.timezone,
            canManageAnyTask: c.get("role") === "admin",
            currentAutomation: undefined,
            origin: {
              platform: "web" as const,
              conversationId,
              providerThreadId: null,
              currentMessageId: null,
            },
          }
        : deps.scheduler
          ? {
              platform: "slack" as const,
              contextType: "dm" as const,
              deliveryTarget: currentUser.slack_user_id ?? currentUser.id,
              createdBy: currentUser.id,
              conversationKind: "web_chat" as const,
              creatorTimezone: currentUser.timezone,
              canManageAnyTask: c.get("role") === "admin",
              currentAutomation: undefined,
              origin: {
                platform: "web" as const,
                conversationId,
                providerThreadId: null,
                currentMessageId: null,
              },
            }
          : null;
    const builderHistory = automationBuilderContext
      ? await automationBuilderHistoryForPrompt({
          context: automationBuilderContext,
          builderConversationId: conversationId,
          config: deps.config,
          workspaceDir,
          userId: currentUser.id,
          userName: currentUser.name,
          logger: deps.logger,
        })
      : [];
    const deliveryPlatform = taskContext?.platform ?? "slack";
    const abortController = new AbortController();
    const baseProgressSettings = resolveProgressDisplaySettings(currentUser);
    const progressMode = resolveWebChatProgressRendererMode(
      isRecord(body) ? (body.progressRendererMode ?? body.progressMode) : undefined,
      baseProgressSettings.toolProgress,
    );
    const progressSettings = progressDisplaySettingsForWebChatMode(baseProgressSettings, progressMode);
    const progressRenderer = createProgressRenderer(progressSettings);
    const transcriptUserMessage = createUserTranscriptMessage(
      { ...latestUserMessage, text: cleanAutomationSetupModeSelectionMessage(latestUserMessage.text) },
      transcriptUserFiles,
      questionAnswer,
    );
    const progressMessageId = `assistant-progress-${transcriptUserMessage.id}`;
    const appended = await appendWebChatPendingTurn(
      deps.config,
      workspaceDir,
      currentUser.id,
      deps.logger,
      conversationId,
      transcriptUserMessage,
      createProgressTranscriptMessage(progressMessageId),
      questionAnswer,
    );
    if (!appended) {
      return c.json(badRequest("QUESTION_STALE", "That question is no longer pending"), 409);
    }

    const userMessage = buildSketchContext({
      messages: builderHistory,
      currentUserName: currentUser.name,
      currentMessage: webChatCurrentMessage(message, automationBuilderContext, builderPlanOnly),
      currentUserEmail: currentUser.email,
      currentUserPhone: currentUser.whatsapp_number,
      workspaceDir,
      orgDir: deps.config.CLAUDE_CONFIG_DIR,
      timezone: currentUser.timezone,
      isSharedContext: false,
    });
    const selectedAutomationTask = selectedAutomationTaskOptionId
      ? await automationTaskForUpdateOption({
          scheduler: deps.scheduler,
          userId: currentUser.id,
          optionId: selectedAutomationTaskOptionId,
        })
      : undefined;
    const updateResolution =
      !automationBuilderContext && !selectedAutomationTask && hasAutomationUpdateIntent(message)
        ? await resolveAutomationUpdate({ scheduler: deps.scheduler, userId: currentUser.id, message })
        : undefined;
    const explicitUpdateTaskId =
      selectedAutomationTask?.id ?? (updateResolution?.kind === "match" ? updateResolution.task.id : undefined);

    const builderTurnStartedAt = Date.now();
    let builderAbortSource: string | null = null;
    const abortBuilderRun = (source: string) => {
      if (!automationBuilderContext || abortController.signal.aborted) return;
      builderAbortSource = source;
      abortController.abort();
    };
    const requestAbortListener = () => abortBuilderRun("request_cancelled");
    if (automationBuilderContext) c.req.raw.signal.addEventListener("abort", requestAbortListener, { once: true });

    return webChatUiStreamResponse(async (write, setOnCancel) => {
      if (automationBuilderContext) setOnCancel(() => abortBuilderRun("stream_cancelled"));
      write({ type: "start", messageMetadata: { createdAt: new Date().toISOString() } });
      write({ type: "start-step" });
      let textPartId: string | null = null;
      let textPartIndex = 0;
      let progressPartIndex = 0;
      let wroteOffProgress = false;
      let currentTextPart = "";
      let bufferTextDeltas = false;
      let bufferedTextDeltas = "";
      let sawAutomationTool = false;
      let bufferedTextAfterAutomationTool = "";
      let builderToolCalls = 0;
      const builderRepeatedToolCalls = new Map<string, number>();

      const startTextPart = () => {
        textPartId = `text-${textPartIndex}`;
        textPartIndex += 1;
        currentTextPart = "";
        write({ type: "text-start", id: textPartId });
      };

      const closeTextPart = () => {
        if (!textPartId) return;
        write({ type: "text-end", id: textPartId });
        textPartId = null;
        currentTextPart = "";
      };

      const writeTextDelta = (delta: string) => {
        if (!delta) return;
        if (!textPartId) startTextPart();
        if (!textPartId) return;
        currentTextPart += delta;
        write({ type: "text-delta", id: textPartId, delta });
      };

      const writeBufferedTextDeltas = () => {
        if (!bufferedTextDeltas) return;
        const text = bufferedTextDeltas;
        bufferedTextDeltas = "";
        writeTextDelta(text);
      };

      const writeOrBufferTextDelta = (delta: string) => {
        if (!delta) return;
        if (bufferTextDeltas) {
          bufferedTextDeltas += delta;
          return;
        }
        writeTextDelta(delta);
      };

      const writeFinalText = (finalText: string) => {
        if (!finalText) {
          closeTextPart();
          return;
        }

        if (!textPartId) {
          startTextPart();
          writeTextDelta(finalText);
          closeTextPart();
          return;
        }

        if (finalText.startsWith(currentTextPart)) {
          writeTextDelta(finalText.slice(currentTextPart.length));
          closeTextPart();
          return;
        }

        closeTextPart();
        write({ type: "start-step" });
        startTextPart();
        writeTextDelta(finalText);
        closeTextPart();
      };

      try {
        if (taskContext && explicitUpdateTaskId) {
          const automationArtifacts = await openExplicitAutomationBuilder({
            deps,
            taskContext,
            taskId: explicitUpdateTaskId,
          });
          if (automationArtifacts.length > 0) {
            const handoffText = "I’ll open the existing automation in the builder so we can make that change there.";
            writeFinalText(handoffText);
            const automationParts = automationArtifacts.map((artifact, index) => {
              const id = `automation-${index}`;
              write({ type: "data-automation", id, data: artifact });
              return { id, data: artifact };
            });
            await completeWebChatProgressMessage(
              deps.config,
              workspaceDir,
              currentUser.id,
              deps.logger,
              conversationId,
              progressMessageId,
              createAssistantTranscriptMessage(handoffText, [], automationParts),
            );
            return;
          }
        }

        if (taskContext && !automationBuilderContext && selectedAutomationTaskOptionId && !selectedAutomationTask) {
          const responseText =
            "That automation is no longer available. Please tell me its current name and I’ll look it up again. No changes were made.";
          writeFinalText(responseText);
          await completeWebChatProgressMessage(
            deps.config,
            workspaceDir,
            currentUser.id,
            deps.logger,
            conversationId,
            progressMessageId,
            createAssistantTranscriptMessage(responseText, []),
          );
          return;
        }

        if (taskContext && !automationBuilderContext && updateResolution && updateResolution.kind !== "match") {
          const responseText = automationUpdateClarification(message, updateResolution);
          const questionPart =
            updateResolution.candidates.length > 0
              ? questionPartFromInteraction(automationUpdateQuestion(conversationId, updateResolution.candidates))
              : undefined;
          writeFinalText(responseText);
          if (questionPart) {
            const question = questionPart.data;
            if (isQuestionBatch(question)) {
              write({ type: "data-question-batch", id: questionPart.id, data: question });
            } else {
              write({ type: "data-question", id: questionPart.id, data: question });
            }
          }
          await completeWebChatProgressMessage(
            deps.config,
            workspaceDir,
            currentUser.id,
            deps.logger,
            conversationId,
            progressMessageId,
            createAssistantTranscriptMessage(responseText, [], [], [], questionPart),
          );
          return;
        }

        if (!automationBuilderContext && hasAutomationCreateIntent(message)) {
          const handoff = await createAutomationDraftHandoff({ deps, currentUser, conversationId, dmContext });
          const handoffText = "I’ll open the automation builder so we can finish configuring it there.";
          writeFinalText(handoffText);
          write({ type: "data-automation-handoff", id: handoff.id, data: handoff.data });
          await completeWebChatProgressMessage(
            deps.config,
            workspaceDir,
            currentUser.id,
            deps.logger,
            conversationId,
            progressMessageId,
            createAutomationDraftAssistantTranscriptMessage(handoffText, handoff),
          );
          return;
        }

        const activeBuilderTaskId = automationBuilderContext?.task.id;
        const runKey = activeBuilderTaskId
          ? builderWebChatRunKey(activeBuilderTaskId)
          : webChatRunKey(currentUser.id, conversationId);
        const runAgent = async () => {
          const runtimeContextType =
            taskContext && taskContext.contextType !== "dm" ? ("channel_mention" as const) : ("dm" as const);
          const agentEnv = deps.listAgentEnvForRuntime
            ? await deps.listAgentEnvForRuntime({
                currentUserId: currentUser.id,
                contextType: runtimeContextType,
                allowOrgSharedEnv: true,
                ...(taskContext ? { taskContext } : {}),
              })
            : undefined;
          return deps.runAgent({
            db: deps.db,
            workspaceKey: currentUser.id,
            threadTs: conversationId,
            userMessage,
            workspaceDir,
            claudeConfigDir: deps.config.CLAUDE_CONFIG_DIR,
            userName: currentUser.name,
            userEmail: currentUser.email,
            userPhone: currentUser.whatsapp_number,
            logger: deps.logger,
            getSlack: deps.getSlack,
            platform: deliveryPlatform,
            responseSurface: "web",
            contextType: runtimeContextType,
            stopAfterCreateAutomationSkill: true,
            automationBuilderChat: Boolean(automationBuilderContext),
            onProgressEvent: async (event) => {
              if (automationBuilderContext && event.kind === "tool_use") {
                builderToolCalls += 1;
                const signature = `${event.toolName}:${JSON.stringify(event.input)}`;
                const repeatedCalls = (builderRepeatedToolCalls.get(signature) ?? 0) + 1;
                builderRepeatedToolCalls.set(signature, repeatedCalls);
                if (builderToolCalls > AUTOMATION_BUILDER_MAX_TOOL_CALLS) {
                  abortBuilderRun("tool_call_limit");
                  return;
                }
                if (repeatedCalls > AUTOMATION_BUILDER_MAX_REPEATED_TOOL_CALLS) {
                  abortBuilderRun("repeated_tool_call_limit");
                  return;
                }
              }
              if (shouldBufferWebChatTextAfterProgress(event)) bufferTextDeltas = true;
              if (event.kind === "tool_use" && event.toolName === "ManageScheduledTasks") {
                sawAutomationTool = true;
                closeTextPart();
              }
              progressRenderer.renderEvent(event);
              const lines = progressRenderer.getLines();
              const progressData = createWebProgressData(event, progressSettings, progressMode, lines);
              if (progressMode === "off" && wroteOffProgress) return;
              if (progressData) {
                if (progressMode === "off") wroteOffProgress = true;
                closeTextPart();
                const progressPartId = `progress-${progressPartIndex}`;
                progressPartIndex += 1;
                write({ type: "data-progress", id: progressPartId, data: progressData });
                await updateWebChatProgressMessage(
                  deps.config,
                  workspaceDir,
                  currentUser.id,
                  deps.logger,
                  conversationId,
                  progressMessageId,
                  progressData,
                );
              }
            },
            onTextDelta: async (delta) => {
              if (sawAutomationTool) {
                bufferedTextAfterAutomationTool += delta;
                return;
              }
              writeOrBufferTextDelta(delta);
            },
            onSessionId: async () => {},
            abortController,
            sessionMode: "chat",
            persistSession: true,
            ...(automationBuilderContext
              ? {
                  maxTurns: AUTOMATION_BUILDER_MAX_TURNS,
                  maxPersistedTextBytes: AUTOMATION_BUILDER_MAX_PERSISTED_TEXT_BYTES,
                  agentAllowedTools: AUTOMATION_BUILDER_ALLOWED_TOOLS,
                }
              : {}),
            orgName: settingsRow?.org_name,
            botName: settingsRow?.bot_name,
            integrationMcpServers,
            loadIntegrationProvider: deps.loadIntegrationProvider,
            cliIntegrations: deps.cliIntegrations,
            agentEnv,
            scheduler: deps.scheduler,
            stepContentRepo: deps.stepContentRepo,
            automationRunsRepo: deps.automationRunsRepo,
            queueManager: deps.queueManager,
            toolConfig,
            inboxMessagesRepo: deps.inboxMessagesRepo,
            userRepo: deps.users,
            currentUserId: currentUser.id,
            sendDm: deps.sendDm,
            sendTargetMessage: deps.sendTargetMessage,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(taskContext ? { taskContext } : {}),
            ...(taskContext?.currentAutomation ? { currentAutomation: taskContext.currentAutomation } : {}),
          });
        };
        let leaseRenewalTimer: ReturnType<typeof setInterval> | undefined;
        let builderBudgetTimer: ReturnType<typeof setTimeout> | undefined;
        if (activeBuilderTaskId) {
          builderBudgetTimer = setTimeout(
            () => abortBuilderRun("elapsed_time_limit"),
            AUTOMATION_BUILDER_MAX_ELAPSED_MS,
          );
          leaseRenewalTimer = setInterval(() => {
            void createAutomationTaskConversationService(deps.db)
              .acquireBuilderConversationLock(
                activeBuilderTaskId,
                conversationId,
                currentUser.id,
                builderLease ?? undefined,
              )
              .then((access) => {
                if (access.kind !== "active") abortBuilderRun("lease_lost");
              })
              .catch(() => abortBuilderRun("lease_renewal_failed"));
          }, BUILDER_CHAT_LOCK_RENEWAL_INTERVAL_MS);
        }

        let result: RunAgentResult;
        try {
          result = await withWebChatAgentRunLock(runKey, () =>
            activeBuilderTaskId
              ? withActiveBuilderWebChatRun(activeBuilderTaskId, abortController, runAgent)
              : withActiveWebChatRun(currentUser.id, conversationId, abortController, runAgent),
          );
        } finally {
          if (leaseRenewalTimer) clearInterval(leaseRenewalTimer);
          if (builderBudgetTimer) clearTimeout(builderBudgetTimer);
        }

        const fileParts: Array<{ id: string; data: WebChatFile }> = [];
        for (const [index, filePath] of result.pendingUploads.entries()) {
          const file = await webChatFileForUpload(workspaceDir, filePath);
          if (!file) {
            deps.logger.warn({ filePath, userId: currentUser.id }, "Skipping web chat file outside workspace");
            continue;
          }
          const id = `file-${index}`;
          fileParts.push({ id, data: file });
        }
        const deterministicIntegrationCards = await deterministicIntegrationCardsForWebChat({
          deps,
          userId: currentUser.id,
          userMessage,
          userEmail: currentUser.email,
          userName: currentUser.name,
          logger: deps.logger,
        });
        const integrationCards = dedupeIntegrationCards([
          ...(result.pendingIntegrationConnections ?? []),
          ...deterministicIntegrationCards,
        ]);
        const automationArtifacts = result.trace.automationArtifacts ?? [];
        const pendingInteraction = result.pendingInteraction ?? result.pendingQuestion;
        const rawFinalText = result.trace.finalText?.trim()
          ? result.trace.finalText
          : sawAutomationTool
            ? bufferedTextAfterAutomationTool
            : bufferedTextDeltas;
        const automationText = normalizeAutomationAssistantText(rawFinalText, automationArtifacts);
        const finalText = sanitizeIntegrationConnectionText(automationText, integrationCards) ?? "";
        if (
          !automationBuilderContext &&
          automationArtifacts.length === 0 &&
          !pendingInteraction &&
          (hasAutomationCreateIntent(message) ||
            (hasSuccessfulCreateAutomationSkill(result) && !hasAutomationUpdateIntent(message)))
        ) {
          const handoff = await createAutomationDraftHandoff({ deps, currentUser, conversationId, dmContext });
          const handoffText = "Your automation is ready to configure. We recommend finishing it in the builder.";
          closeTextPart();
          writeFinalText(handoffText);
          write({ type: "data-automation-handoff", id: handoff.id, data: handoff.data });
          await completeWebChatProgressMessage(
            deps.config,
            workspaceDir,
            currentUser.id,
            deps.logger,
            conversationId,
            progressMessageId,
            createAutomationDraftAssistantTranscriptMessage(handoffText, handoff),
          );
          return;
        }
        const fallbackBuilderQuestion =
          !pendingInteraction &&
          automationBuilderContext &&
          automationBuilderContext.isPlaceholderDraft &&
          isExecutionModeSelectionMessage(message) &&
          fileParts.length === 0 &&
          automationArtifacts.length === 0 &&
          integrationCards.length === 0
            ? deterministicBuilderSetupQuestion(
                builderHistory.map((historyMessage) => historyMessage.text).join("\n"),
                transcriptUserMessage.id,
              )
            : undefined;
        const questionPart: WebChatQuestionPart | undefined = pendingInteraction
          ? questionPartFromInteraction(pendingInteraction)
          : fallbackBuilderQuestion
            ? { id: `question-${fallbackBuilderQuestion.id}`, data: fallbackBuilderQuestion }
            : undefined;
        const responseText =
          (fallbackBuilderQuestion ? "Let's start by identifying the input source." : "") ||
          (finalText.trim() ? finalText : "") ||
          (automationBuilderContext &&
          fileParts.length === 0 &&
          automationArtifacts.length === 0 &&
          integrationCards.length === 0 &&
          !questionPart
            ? AUTOMATION_BUILDER_FOLLOW_UP_TEXT
            : "") ||
          (fileParts.length === 0 && automationArtifacts.length === 0 && integrationCards.length === 0 && !questionPart
            ? EMPTY_WEB_CHAT_RESPONSE_TEXT
            : "");
        if (automationBuilderContext) {
          deps.logger.info(
            {
              taskId: automationBuilderContext.task.id,
              conversationId,
              finishReason: result.rawUsage.stopReason,
              abortSource: builderAbortSource,
              toolCalls: result.rawUsage.toolCalls.length,
              turns: result.rawUsage.numTurns,
              assistantOutputBytes: Buffer.byteLength(responseText, "utf8"),
              persistedTextLimitBytes: AUTOMATION_BUILDER_MAX_PERSISTED_TEXT_BYTES,
              elapsedMs: Date.now() - builderTurnStartedAt,
            },
            "Automation builder turn finished",
          );
        }
        if (integrationCards.length === 0 && automationArtifacts.length === 0) {
          writeBufferedTextDeltas();
        } else {
          bufferedTextDeltas = "";
        }
        writeFinalText(responseText);

        for (const file of fileParts) {
          write({ type: "data-file", id: file.id, data: file.data });
        }
        const integrationConnectionParts = integrationCards.map((connection, index) => {
          const id = `integration-connection-${index}`;
          write({ type: "data-integration-connection", id, data: connection });
          return { id, data: connection };
        });
        const automationParts = automationArtifacts.map((artifact, index) => {
          const id = `automation-${index}`;
          write({ type: "data-automation", id, data: artifact });
          return { id, data: artifact };
        });
        if (questionPart) {
          const question = questionPart.data;
          if (isQuestionBatch(question)) {
            write({ type: "data-question-batch", id: questionPart.id, data: question });
          } else {
            write({ type: "data-question", id: questionPart.id, data: question });
          }
        }
        await completeWebChatProgressMessage(
          deps.config,
          workspaceDir,
          currentUser.id,
          deps.logger,
          conversationId,
          progressMessageId,
          createAssistantTranscriptMessage(
            responseText,
            fileParts,
            automationParts,
            integrationConnectionParts,
            questionPart,
          ),
        );
      } catch (err) {
        if (abortController.signal.aborted) {
          writeBufferedTextDeltas();
          const partialText = currentTextPart.trim();
          const interruptedText = automationBuilderContext
            ? [partialText, AUTOMATION_BUILDER_INTERRUPTED_TEXT].filter(Boolean).join("\n\n")
            : partialText;
          closeTextPart();
          if (automationBuilderContext) {
            deps.logger.info(
              {
                taskId: automationBuilderContext.task.id,
                conversationId,
                finishReason: "aborted",
                abortSource: builderAbortSource ?? "interrupted",
                toolCalls: builderToolCalls,
                assistantOutputBytes: Buffer.byteLength(interruptedText, "utf8"),
                persistedTextLimitBytes: AUTOMATION_BUILDER_MAX_PERSISTED_TEXT_BYTES,
                elapsedMs: Date.now() - builderTurnStartedAt,
              },
              "Automation builder turn finished",
            );
          }
          if (automationBuilderContext) {
            writeTextDelta(AUTOMATION_BUILDER_INTERRUPTED_TEXT);
            closeTextPart();
          }
          write({ type: "data-interruption", id: "interruption", data: WEB_CHAT_INTERRUPTION_DATA });
          await completeWebChatProgressMessage(
            deps.config,
            workspaceDir,
            currentUser.id,
            deps.logger,
            conversationId,
            progressMessageId,
            createInterruptedAssistantTranscriptMessage(interruptedText),
          );
          return;
        }
        const message = errorMessage(err);
        writeBufferedTextDeltas();
        closeTextPart();
        deps.logger.warn({ err }, "Web chat run failed");
        await completeWebChatProgressMessage(
          deps.config,
          workspaceDir,
          currentUser.id,
          deps.logger,
          conversationId,
          progressMessageId,
          createAssistantTranscriptMessage(message, []),
        );
        write({ type: "error", errorText: message });
      } finally {
        if (automationBuilderContext) c.req.raw.signal.removeEventListener("abort", requestAbortListener);
        write({ type: "finish-step" });
        write({ type: "finish" });
      }
    });
  });

  return routes;
}

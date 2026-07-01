import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import {
  type AutomationArtifact,
  type WebChatIntegrationConnectionData,
  type WebChatProgressData,
  type WebProgressItem,
  type WorkflowEdge,
  type WorkflowStep,
  automationArtifactSchema,
  workflowEdgeSchema,
  workflowStepSchema,
} from "@sketch/shared";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, ProgressEvent, RunAgentParams, RunAgentResult } from "../agent/runner";
import { deleteSessionId } from "../agent/sessions";
import { createProgressRenderer, createWebProgressData } from "../agent/tool-progress";
import { ensureWorkspace } from "../agent/workspace";
import { TOOL_PROGRESS_OPTIONS, type ToolProgressCommand } from "../commands";
import type { Config } from "../config";
import type { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import type { StepContentRow, createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import type { createInboxMessagesRepository } from "../db/repositories/inbox-messages";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import type { Attachment } from "../files";
import { extensionToMime } from "../files";
import {
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
import type { TaskScheduler } from "../scheduler/service";
import type { ScheduledTask } from "../scheduler/types";
import { transcribeAudioFile } from "../transcription/service";
import type { WhatsAppTemplateRequest } from "../whatsapp/templates";

type UserRepo = ReturnType<typeof createUserRepository>;
type SettingsRepo = ReturnType<typeof createSettingsRepository>;
type InboxMessagesRepo = ReturnType<typeof createInboxMessagesRepository>;
type SlackDmResolver = {
  openDmChannel(slackUserId: string, botToken?: string): Promise<string | null>;
};

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
  scheduler?: TaskScheduler;
  stepContentRepo?: ReturnType<typeof createAutomationStepContentRepository>;
  automationRunsRepo?: ReturnType<typeof createAutomationRunsRepository>;
  queueManager?: QueueManager;
  getSlack?: () => SlackDmResolver | null;
  sendDm?: (params: {
    userId: string;
    platform: string;
    message: string;
    template?: WhatsAppTemplateRequest;
  }) => Promise<{
    channelId: string;
    messageRef: string;
  }>;
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
  label: "Tell Sketch what to do differently.",
} satisfies WebChatInterruptionData;

type WebChatTranscriptPart =
  | { type: "text"; text: string }
  | { type: "data-file"; id: string; data: WebChatFile }
  | { type: "data-automation"; id: string; data: AutomationArtifact }
  | { type: "data-integration-connection"; id: string; data: WebChatIntegrationConnectionData }
  | { type: "data-interruption"; id: string; data: WebChatInterruptionData };
type WebChatProgressTranscriptPart = { type: "data-progress"; id: string; data: WebChatProgressData };
type WebChatStoredPart = WebChatTranscriptPart | WebChatProgressTranscriptPart;

interface WebChatTranscriptMessage {
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
}

interface LatestUserMessage {
  id: string | null;
  text: string;
}

interface ParsedWebChatAttachment {
  attachment: Attachment;
  file: WebChatFile;
}

type AutomationBuilderContext = { task: ScheduledTask; stepContentRows: StepContentRow[] } | null;

type WebChatUiChunk =
  | { type: "start"; messageMetadata?: { createdAt: string } }
  | { type: "start-step" }
  | { type: "data-progress"; id: string; data: WebChatProgressData }
  | { type: "data-file"; id: string; data: WebChatFile }
  | { type: "data-automation"; id: string; data: AutomationArtifact }
  | { type: "data-integration-connection"; id: string; data: WebChatIntegrationConnectionData }
  | { type: "data-interruption"; id: string; data: WebChatInterruptionData }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "finish-step" }
  | { type: "finish" }
  | { type: "error"; errorText: string };

type WebChatUiWriter = (chunk: WebChatUiChunk) => void;

function webChatUiStreamResponse(execute: (write: WebChatUiWriter) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
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
        await execute(write);
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

async function resolveAutomationBuilderContext(params: {
  deps: WebChatRouteDeps;
  currentUserId: string;
  role: string | undefined;
  automationTaskId: string | null;
  logger: Logger;
}): Promise<AutomationBuilderContext> {
  if (!params.automationTaskId || !params.deps.scheduler?.getTaskById) {
    return null;
  }

  const task = await params.deps.scheduler.getTaskById(params.automationTaskId).catch((err) => {
    params.logger.warn({ err, taskId: params.automationTaskId }, "Failed to resolve automation builder context");
    return null;
  });
  if (!task || (params.role !== "admin" && task.createdBy !== params.currentUserId)) {
    return null;
  }

  const stepContentRows = params.deps.stepContentRepo
    ? await params.deps.stepContentRepo.getByTask(task.id).catch((err) => {
        params.logger.warn({ err, taskId: task.id }, "Failed to load automation builder step content");
        return [] as StepContentRow[];
      })
    : [];
  return { task, stepContentRows };
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

function webChatCurrentMessage(message: string, automationBuilderContext: AutomationBuilderContext): string {
  if (!automationBuilderContext) return message;
  const lines = [...automationBuilderContextLines(automationBuilderContext), "</automation_builder>"];
  return [...lines, "", message].join("\n");
}

const AUTOMATION_CARD_INTRO_TEXT = "All set - here's the automation.";

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
const activeWebChatRuns = new Map<string, AbortController>();

function webChatRunKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

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

async function withWebChatAgentRunLock<T>(userId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
  const key = webChatRunKey(userId, conversationId);
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

async function withActiveWebChatRun<T>(
  userId: string,
  conversationId: string,
  abortController: AbortController,
  fn: () => Promise<T>,
): Promise<T> {
  const key = webChatRunKey(userId, conversationId);
  activeWebChatRuns.set(key, abortController);
  try {
    return await fn();
  } finally {
    if (activeWebChatRuns.get(key) === abortController) {
      activeWebChatRuns.delete(key);
    }
  }
}

function interruptActiveWebChatRun(userId: string, conversationId: string): boolean {
  const activeRun = activeWebChatRuns.get(webChatRunKey(userId, conversationId));
  if (!activeRun || activeRun.signal.aborted) return false;
  activeRun.abort();
  return true;
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
  const { requestId, appId, appName, state, icon, reason, accountName, connectionId } = value;
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

async function readWebChatTranscript(
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

async function readWebChatTranscriptUpdatedAt(
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
): WebChatTranscriptMessage {
  const parts: WebChatTranscriptPart[] = [{ type: "text", text: message.text }];
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
  if (parts.length === 0) return null;
  return { id: `assistant-${randomUUID()}`, role: "assistant", createdAt: new Date().toISOString(), parts };
}

function createInterruptedAssistantTranscriptMessage(finalText: string): WebChatTranscriptMessage {
  const parts: WebChatTranscriptPart[] = [];
  if (finalText) parts.push({ type: "text", text: finalText });
  parts.push({ type: "data-interruption", id: "interruption", data: WEB_CHAT_INTERRUPTION_DATA });
  return { id: `assistant-${randomUUID()}`, role: "assistant", createdAt: new Date().toISOString(), parts };
}

async function deterministicIntegrationCardsForWebChat(params: {
  deps: WebChatRouteDeps;
  userMessage: string;
  userEmail: string | null;
  userName: string | null;
  logger: Logger;
}): Promise<WebChatIntegrationConnectionData[]> {
  if (!isConnectedAccountsInquiry(params.userMessage)) return [];
  try {
    return await connectedAccountCardsForUser({
      loadIntegrationProvider: params.deps.loadIntegrationProvider,
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
): Promise<void> {
  await withWebChatTranscriptLock(userId, conversationId, async () => {
    const existing = await readWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
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
): Promise<WebChatConversationSummary[]> {
  await migrateLegacyWebChatTranscripts(config, workspaceDir, userId, logger);
  const transcriptDir = webChatTranscriptDir(config, userId);
  const entries = await readdir(transcriptDir, { withFileTypes: true }).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    logger.warn({ err, transcriptDir }, "Failed to list web chat transcripts");
    return [];
  });

  const summaries = await Promise.all(
    entries.flatMap(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
      const id = entry.name.slice(0, -".json".length);
      const conversationId = normalizeWebChatConversationId(id);
      if (!conversationId || conversationId !== id) return [];

      const messages = await readWebChatTranscript(config, workspaceDir, userId, logger, conversationId);
      const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
      if (!latestUserMessage) return [];

      const title = textFromTranscriptMessage(latestUserMessage);
      const updatedAt = await readWebChatTranscriptUpdatedAt(config, workspaceDir, userId, logger, conversationId);
      if (!title || !updatedAt) return [];

      return [{ id: conversationId, title, channel: "web" as const, updatedAt }];
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
}) {
  const task = params.context.task;
  return {
    platform: task.platform,
    contextType: task.contextType,
    deliveryTarget: task.deliveryTarget,
    createdBy: params.currentUser.id,
    creatorTimezone: params.currentUser.timezone,
    threadTs: task.threadTs ?? undefined,
    canManageAnyTask: params.role === "admin",
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
    await deleteSessionId(deps.db, currentUser.id, conversationId);
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

    const interruptedActiveRun = interruptActiveWebChatRun(currentUser.id, conversationId);
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
    const latestUserMessage = extractLatestUserMessage(body);
    if (!latestUserMessage) {
      return c.json(badRequest("VALIDATION_ERROR", "Message is required"), 400);
    }
    const message = latestUserMessage.text;

    const currentUser = await deps.users.findById(c.get("sub"));
    if (!currentUser) {
      return c.json(badRequest("USER_NOT_FOUND", "Current user not found"), 404);
    }
    const conversationId = normalizeWebChatConversationId(c.req.query("conversationId"));
    if (!conversationId) {
      return c.json(badRequest("VALIDATION_ERROR", "Conversation id is invalid"), 400);
    }

    const settingsRow = await deps.settings.get();
    const integrationMcpServers = deps.buildMcpServers ? await deps.buildMcpServers(currentUser.email) : {};
    const workspaceDir = await ensureWorkspace(deps.config, currentUser.id);
    const automationTaskId = extractAutomationTaskId(body);
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
    await migrateLegacyWebChatTranscripts(deps.config, workspaceDir, currentUser.id, deps.logger);
    const dmContext = await resolveWebChatDmContext(deps, currentUser, settingsRow);
    const automationBuilderContext = await resolveAutomationBuilderContext({
      deps,
      currentUserId: currentUser.id,
      role: c.get("role"),
      automationTaskId,
      logger: deps.logger,
    });
    const taskContext = automationBuilderContext
      ? automationBuilderTaskContext({
          context: automationBuilderContext,
          currentUser,
          role: c.get("role"),
          conversationId,
        })
      : dmContext
        ? {
            platform: dmContext.platform,
            contextType: "dm" as const,
            deliveryTarget: dmContext.deliveryTarget,
            createdBy: currentUser.id,
            creatorTimezone: currentUser.timezone,
            canManageAnyTask: c.get("role") === "admin",
            origin: {
              platform: "web" as const,
              conversationId,
              providerThreadId: null,
              currentMessageId: null,
            },
          }
        : null;
    const deliveryPlatform = taskContext?.platform ?? "slack";
    const abortController = new AbortController();
    const baseProgressSettings = resolveProgressDisplaySettings(currentUser);
    const progressMode = resolveWebChatProgressRendererMode(
      isRecord(body) ? (body.progressRendererMode ?? body.progressMode) : undefined,
      baseProgressSettings.toolProgress,
    );
    const progressSettings = progressDisplaySettingsForWebChatMode(baseProgressSettings, progressMode);
    const progressRenderer = createProgressRenderer(progressSettings);
    const transcriptUserMessage = createUserTranscriptMessage(latestUserMessage, transcriptUserFiles);
    const progressMessageId = `assistant-progress-${transcriptUserMessage.id}`;
    await appendWebChatPendingTurn(
      deps.config,
      workspaceDir,
      currentUser.id,
      deps.logger,
      conversationId,
      transcriptUserMessage,
      createProgressTranscriptMessage(progressMessageId),
    );

    const userMessage = buildSketchContext({
      messages: [],
      currentUserName: currentUser.name,
      currentMessage: webChatCurrentMessage(message, automationBuilderContext),
      currentUserEmail: currentUser.email,
      currentUserPhone: currentUser.whatsapp_number,
      workspaceDir,
      orgDir: deps.config.CLAUDE_CONFIG_DIR,
      timezone: currentUser.timezone,
      isSharedContext: false,
    });

    return webChatUiStreamResponse(async (write) => {
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
        const result = await withWebChatAgentRunLock(currentUser.id, conversationId, () =>
          withActiveWebChatRun(currentUser.id, conversationId, abortController, () =>
            deps.runAgent({
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
              platform: deliveryPlatform,
              responseSurface: "web",
              contextType: "dm",
              onProgressEvent: async (event) => {
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
                  await updateWebChatProgressMessage(
                    deps.config,
                    workspaceDir,
                    currentUser.id,
                    deps.logger,
                    conversationId,
                    progressMessageId,
                    progressData,
                  );
                  const progressPartId = `progress-${progressPartIndex}`;
                  progressPartIndex += 1;
                  write({ type: "data-progress", id: progressPartId, data: progressData });
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
              orgName: settingsRow?.org_name,
              botName: settingsRow?.bot_name,
              integrationMcpServers,
              loadIntegrationProvider: deps.loadIntegrationProvider,
              scheduler: deps.scheduler,
              stepContentRepo: deps.stepContentRepo,
              automationRunsRepo: deps.automationRunsRepo,
              queueManager: deps.queueManager,
              toolConfig,
              inboxMessagesRepo: deps.inboxMessagesRepo,
              userRepo: deps.users,
              currentUserId: currentUser.id,
              sendDm: deps.sendDm,
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(taskContext ? { taskContext } : {}),
            }),
          ),
        );

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
        const rawFinalText = result.trace.finalText?.trim()
          ? result.trace.finalText
          : sawAutomationTool
            ? bufferedTextAfterAutomationTool
            : bufferedTextDeltas;
        const automationText = normalizeAutomationAssistantText(rawFinalText, automationArtifacts);
        const finalText = sanitizeIntegrationConnectionText(automationText, integrationCards) ?? "";
        if (integrationCards.length === 0 && automationArtifacts.length === 0) {
          writeBufferedTextDeltas();
        } else {
          bufferedTextDeltas = "";
        }
        writeFinalText(finalText);

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
        await completeWebChatProgressMessage(
          deps.config,
          workspaceDir,
          currentUser.id,
          deps.logger,
          conversationId,
          progressMessageId,
          createAssistantTranscriptMessage(finalText, fileParts, automationParts, integrationConnectionParts),
        );
      } catch (err) {
        if (abortController.signal.aborted) {
          writeBufferedTextDeltas();
          const interruptedText = currentTextPart.trim();
          closeTextPart();
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
        write({ type: "finish-step" });
        write({ type: "finish" });
      }
    });
  });

  return routes;
}

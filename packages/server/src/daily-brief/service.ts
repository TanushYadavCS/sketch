import { join } from "node:path";
import type { Kysely, Selectable } from "kysely";
import { buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, RunAgentParams, RunAgentResult } from "../agent/runner";
import type { DailyBriefWriter, WriteDailyBriefPayload } from "../agent/tools/daily-brief";
import { ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import {
  DAILY_BRIEF_ACTION_LABELS,
  DAILY_BRIEF_AGENT_KEY,
  DAILY_BRIEF_AGENT_VERSION,
  DAILY_BRIEF_SECTION_LABELS,
  type DailyBriefItemInput,
  type DailyBriefKnowledgeRefs,
  type DailyBriefMasthead,
  type DailyBriefRow,
  type DailyBriefTriggerType,
  createDailyBriefRepository,
} from "../db/repositories/daily-briefs";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB, UsersTable } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";

const SECTION_KEYS = ["todos", "customer_updates", "active_projects"] as const;
const RUNNING_BRIEF_STALE_AFTER_MS = 30 * 60 * 1000;
const SCHEDULED_FAILURE_SUPPRESS_AFTER_MS = 60 * 60 * 1000;
const TASK_SOURCE_PREFIX: Record<string, string> = {
  clickup: "CU",
  jira: "JIRA",
  linear: "LINEAR",
};
const DAILY_BRIEF_ALLOWED_TOOLS = [
  "mcp__sketch__Search",
  "mcp__sketch__SearchEntities",
  "mcp__sketch__GetEntityContext",
  "mcp__sketch__GetFileContent",
  "mcp__sketch__WriteDailyBrief",
];

type UserRow = Selectable<UsersTable>;

export interface DailyBriefServiceDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  users: ReturnType<typeof createUserRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  queueManager?: QueueManager;
}

export interface RequestDailyBriefGenerationParams {
  userId: string;
  briefDate?: string;
  triggerType: DailyBriefTriggerType;
  skipIfCompleted?: boolean;
}

export interface DailyBriefApiItem {
  id: string;
  sectionKey: string;
  title: string;
  summary: string;
  priority: string;
  label: string;
  displayRef: string | null;
  actionType: string | null;
  actionLabel: string | null;
  actionPrompt: string | null;
  sourceUrl: string | null;
  knowledgeRefs: DailyBriefKnowledgeRefs;
  sortOrder: number;
}

export interface DailyBriefApiBrief {
  id: string;
  userId: string;
  briefDate: string;
  timezone: string;
  status: string;
  generatedAt: string | null;
  masthead: DailyBriefMasthead | null;
  sections: {
    todos: DailyBriefApiItem[];
    customer_updates: DailyBriefApiItem[];
    active_projects: DailyBriefApiItem[];
  };
}

function localDateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function timestampAgeMs(value: string, now: Date): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return now.getTime() - parsed;
}

function isOlderThan(value: string, now: Date, thresholdMs: number): boolean {
  const age = timestampAgeMs(value, now);
  return age !== null && age >= thresholdMs;
}

function isNewerThan(value: string, now: Date, thresholdMs: number): boolean {
  const age = timestampAgeMs(value, now);
  return age !== null && age >= 0 && age < thresholdMs;
}

function normalizeStoredLabel(sectionKey: string, value: string | null): string {
  const labels = DAILY_BRIEF_SECTION_LABELS[sectionKey as keyof typeof DAILY_BRIEF_SECTION_LABELS] as
    | readonly string[]
    | undefined;
  if (labels?.includes(value ?? "")) return value as string;
  if (sectionKey === "customer_updates") return "warm";
  if (sectionKey === "active_projects") return "active";
  return "todo";
}

function defaultActionLabel(sectionKey: string, label: string | null, actionType: string | null): string {
  const normalizedLabel = normalizeStoredLabel(sectionKey, label);
  if (sectionKey === "active_projects") {
    return "Catch me up";
  }
  if (sectionKey === "customer_updates") {
    if (normalizedLabel === "owed_follow_up") return "Draft follow-up";
    if (normalizedLabel === "inbound") return "Prepare with Sketch";
    if (normalizedLabel === "stuck") return "Unblock with Sketch";
    if (normalizedLabel === "cold") return "Plan re-engagement";
    if (normalizedLabel === "at_risk") return "Review risk";
    return "Plan next step";
  }
  if (normalizedLabel === "blocked") return "Unblock with Sketch";
  if (normalizedLabel === "done") return "Review with Sketch";
  return "Plan with Sketch";
}

function normalizeStoredActionLabel(
  sectionKey: string,
  label: string | null,
  actionType: string | null,
  value: string | null,
): string {
  const allowed = DAILY_BRIEF_ACTION_LABELS[sectionKey as keyof typeof DAILY_BRIEF_ACTION_LABELS] as
    | readonly string[]
    | undefined;
  if (value && allowed?.includes(value)) return value;
  return defaultActionLabel(sectionKey, label, actionType);
}

function shortId(prefix: string, value: string | undefined): string | null {
  if (!value) return null;
  const compact = value.replaceAll("-", "").slice(0, 6);
  return compact ? `${prefix}-${compact}` : null;
}

function fallbackDisplayRef(sectionKey: string, refs: DailyBriefKnowledgeRefs): string | null {
  if (sectionKey !== "todos") return null;
  return (
    shortId("FACT", refs.factIds?.[0]) ??
    shortId("SRC", refs.sourceRefIds?.[0]) ??
    shortId("MENT", refs.mentionIds?.[0]) ??
    shortId("FILE", refs.fileIds[0]) ??
    shortId("ENT", refs.entityIds[0])
  );
}

function extractTaskKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const issueKey = value.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
  if (issueKey) return issueKey;
  const linearSlug = value.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)(?:\/|$|-)/)?.[1];
  return linearSlug ?? null;
}

type DailyBriefReferencedFile = {
  id: string;
  source: string;
  provider_file_id: string;
  provider_url: string | null;
  file_name: string;
  source_path: string | null;
};

function deriveTodoDisplayRef(refs: DailyBriefKnowledgeRefs, files: DailyBriefReferencedFile[]): string | null {
  for (const file of files) {
    const key =
      extractTaskKey(file.provider_file_id) ??
      extractTaskKey(file.provider_url) ??
      extractTaskKey(file.file_name) ??
      extractTaskKey(file.source_path);
    if (key) return key;
    const prefix = TASK_SOURCE_PREFIX[file.source];
    if (prefix && file.provider_file_id) return `${prefix}-${file.provider_file_id.replaceAll("-", "").slice(0, 8)}`;
  }
  return fallbackDisplayRef("todos", refs);
}

function displayRefForItem(item: DailyBriefItemInput, files: DailyBriefReferencedFile[]): string | null {
  if (item.sectionKey !== "todos") return null;
  return item.displayRef ?? deriveTodoDisplayRef(item.knowledgeRefs, files);
}

function sourceUrlForItem(files: DailyBriefReferencedFile[]): string | null {
  for (const file of files) {
    if (file.provider_url) return file.provider_url;
  }
  return null;
}

function normalizeActionLabel(item: DailyBriefItemInput): string {
  const allowed = DAILY_BRIEF_ACTION_LABELS[item.sectionKey] as readonly string[];
  if (item.actionLabel && allowed.includes(item.actionLabel)) return item.actionLabel;
  return defaultActionLabel(item.sectionKey, item.label, item.actionType ?? null);
}

function formatBriefForContext(brief: DailyBriefApiBrief | null) {
  if (!brief) return null;
  return {
    id: brief.id,
    briefDate: brief.briefDate,
    generatedAt: brief.generatedAt,
    items: SECTION_KEYS.flatMap((sectionKey) =>
      brief.sections[sectionKey].map((item) => ({
        id: item.id,
        sectionKey,
        title: item.title,
        summary: item.summary,
        priority: item.priority,
        label: item.label,
        actionType: item.actionType,
        entityIds: item.knowledgeRefs.entityIds,
        fileIds: item.knowledgeRefs.fileIds,
      })),
    ),
  };
}

function toApiBrief(
  value: Awaited<ReturnType<ReturnType<typeof createDailyBriefRepository>["findLatestCompleted"]>>,
): DailyBriefApiBrief | null {
  if (!value) return null;
  const sections: DailyBriefApiBrief["sections"] = {
    todos: [],
    customer_updates: [],
    active_projects: [],
  };
  for (const item of value.items) {
    const apiItem: DailyBriefApiItem = {
      id: item.id,
      sectionKey: item.section_key,
      title: item.title,
      summary: item.summary,
      priority: item.priority,
      label: normalizeStoredLabel(item.section_key, item.label),
      displayRef: item.display_ref ?? fallbackDisplayRef(item.section_key, item.knowledgeRefs),
      actionType: item.action_type,
      actionLabel: normalizeStoredActionLabel(item.section_key, item.label, item.action_type, item.action_label),
      actionPrompt: item.action_prompt,
      sourceUrl: item.source_url,
      knowledgeRefs: item.knowledgeRefs,
      sortOrder: item.sort_order,
    };
    if (item.section_key in sections) {
      sections[item.section_key as keyof typeof sections].push(apiItem);
    }
  }
  return {
    id: value.brief.id,
    userId: value.brief.user_id,
    briefDate: value.brief.brief_date,
    timezone: value.brief.timezone,
    status: value.brief.status,
    generatedAt: value.brief.generated_at,
    masthead: value.masthead,
    sections,
  };
}

function buildStableInstructions(maxItemsPerSection: number): string {
  return [
    `You are Sketch's Daily Briefing Agent (${DAILY_BRIEF_AGENT_VERSION}).`,
    "",
    "Generate a concise Daily Brief from indexed organizational knowledge.",
    "Use the existing Sketch knowledge tools first. Search broadly, resolve relevant entities, then drill into entities and files only where needed.",
    "Call WriteDailyBrief exactly once when the complete brief is ready.",
    "",
    "Fixed sections:",
    "- todos: concrete follow-ups, blockers, unanswered asks, or decisions that appear actionable.",
    "- customerUpdates: customer/company/account changes, risks, asks, demos, or decisions.",
    "- activeProjects: internal project/workstream/product movement and next steps.",
    "",
    "Labels:",
    "- todos.label must be one of: todo, in_progress, blocked, waiting, done.",
    "- customerUpdates.label must be one of: owed_follow_up, warm, inbound, stuck, cold, at_risk.",
    "- activeProjects.label must be one of: active, at_risk, blocked, needs_attention.",
    "- Use previous brief labels as state memory. If yesterday's todo is still being worked, prefer in_progress. If it is waiting on someone, use waiting. If it is no longer relevant, omit it instead of marking done unless completion is explicit.",
    "",
    "Sketch chat actions:",
    "- Every action must start a Sketch chat only. Do not use external-agent language such as Ask Claude, Review PR, send email, or run automation.",
    "- todos.actionLabel must be Plan with Sketch for todo, in_progress, and waiting; Unblock with Sketch for blocked; Review with Sketch only for done items that are still worth showing.",
    "- customerUpdates.actionLabel must be one of: Prepare with Sketch, Draft follow-up, Plan next step, Catch me up, Unblock with Sketch, Review risk, Plan re-engagement.",
    "- activeProjects.actionLabel must always be Catch me up.",
    "- actionPrompt must be a complete instruction to Sketch chat with enough context to discuss, prepare, draft, plan, catch up, or unblock. It must not claim Sketch will perform an external side effect without user review.",
    "",
    "Rules:",
    "- Do not create a meetings or calendar section.",
    "- Output a complete new brief snapshot, not patches.",
    `- Return at most ${maxItemsPerSection} items per section.`,
    "- Every item must include at least one real entityId or fileId in knowledgeRefs.",
    "- Do not invent IDs. Use only IDs returned by tools.",
    "- Prefer entityIds and fileIds because those are exposed by the existing knowledge tools.",
    "- For todos, if a source task issue key such as SKE-180 is visible in the source title or URL, keep it in the title or summary; the system will derive the display ref from source metadata.",
    "- Keep titles and summaries short, specific, and useful for someone starting their day.",
    "- Use prior brief context to avoid needless churn, but include still-active items when they remain important.",
  ].join("\n");
}

export class DailyBriefService {
  private repo: ReturnType<typeof createDailyBriefRepository>;
  private deps: DailyBriefServiceDeps;

  constructor(deps: DailyBriefServiceDeps) {
    this.deps = deps;
    this.repo = createDailyBriefRepository(deps.db);
  }

  getLocalDateForUser(user: Pick<UserRow, "timezone">, now = new Date()): string {
    return localDateInTimezone(now, user.timezone || "UTC");
  }

  async resolveUserId(sub: string, email?: string | null): Promise<string | null> {
    const byId = await this.deps.users.findById(sub);
    if (byId) return byId.id;
    if (email) {
      const byEmail = await this.deps.users.findByEmail(email);
      if (byEmail) return byEmail.id;
    }
    if (sub.includes("@")) {
      const bySubEmail = await this.deps.users.findByEmail(sub);
      if (bySubEmail) return bySubEmail.id;
    }
    return null;
  }

  async getLatestForUser(
    userId: string,
    briefDate?: string,
  ): Promise<{
    brief: DailyBriefApiBrief | null;
    running: boolean;
    briefDate: string;
    timezone: string;
  }> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw new Error("User not found");
    const config = await this.repo.getConfig(user.id);
    const timezone = config.timezone || user.timezone || "UTC";
    const date = briefDate || localDateInTimezone(new Date(), timezone);
    const now = new Date();
    const [brief, running] = await Promise.all([
      this.repo.findLatestCompleted(user.id, date),
      this.repo.findRunning(user.id, date),
    ]);
    return {
      brief: toApiBrief(brief),
      running: Boolean(running && !this.isRunningBriefStale(running, now)),
      briefDate: date,
      timezone,
    };
  }

  async getByIdForUser(id: string, userId: string): Promise<DailyBriefApiBrief | null> {
    return toApiBrief(await this.repo.getByIdForUser(id, userId));
  }

  async requestGenerationForUser(params: RequestDailyBriefGenerationParams) {
    const user = await this.deps.users.findById(params.userId);
    if (!user) throw new Error("User not found");
    const config = await this.repo.getConfig(user.id);
    const timezone = config.timezone || user.timezone || "UTC";
    const briefDate = params.briefDate || localDateInTimezone(new Date(), timezone);
    const now = new Date();
    let recoveredStaleRunning = false;
    const existingRunning = await this.repo.findRunning(user.id, briefDate);
    if (existingRunning) {
      if (!this.isRunningBriefStale(existingRunning, now)) return existingRunning;
      recoveredStaleRunning = true;
      await this.repo.markFailed(existingRunning.id, "Brief generation expired after being left running.");
    }
    if (params.skipIfCompleted && (await this.repo.findLatestCompleted(user.id, briefDate))) {
      return null;
    }
    if (params.skipIfCompleted && params.triggerType === "scheduled" && !recoveredStaleRunning) {
      const latest = await this.repo.findLatestAny(user.id, briefDate);
      if (latest && this.isRecentScheduledFailure(latest, now)) return latest;
    }
    const result = await this.repo.createRunning({
      userId: user.id,
      briefDate,
      timezone,
      triggerType: params.triggerType,
    });
    if (result.created) this.enqueueRun(result.row.id, user.id);
    return result.row;
  }

  async listSchedulableUsers(): Promise<UserRow[]> {
    const rows = await this.deps.users.list();
    return rows.filter((user) => user.type === "human");
  }

  async shouldGenerateForUser(user: UserRow, now = new Date()): Promise<{ briefDate: string } | null> {
    const config = await this.repo.getConfig(user.id);
    if (!config.enabled) return null;
    const timezone = config.timezone || user.timezone || "UTC";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    if (hour !== config.scheduleHour || minute < config.scheduleMinute) return null;
    const briefDate = localDateInTimezone(now, timezone);
    const [running, completed] = await Promise.all([
      this.repo.findRunning(user.id, briefDate),
      this.repo.findLatestCompleted(user.id, briefDate),
    ]);
    if (running && !this.isRunningBriefStale(running, now)) return null;
    if (completed) return null;
    const latest = await this.repo.findLatestAny(user.id, briefDate);
    if (latest && this.isRecentScheduledFailure(latest, now)) return null;
    return { briefDate };
  }

  private isRunningBriefStale(brief: DailyBriefRow, now: Date): boolean {
    return brief.status === "running" && isOlderThan(brief.created_at, now, RUNNING_BRIEF_STALE_AFTER_MS);
  }

  private isRecentScheduledFailure(brief: DailyBriefRow, now: Date): boolean {
    return (
      brief.status === "failed" &&
      brief.trigger_type === "scheduled" &&
      isNewerThan(brief.updated_at, now, SCHEDULED_FAILURE_SUPPRESS_AFTER_MS)
    );
  }

  private enqueueRun(briefId: string, userId: string): void {
    const task = async () => {
      await this.generateExistingBrief(briefId, userId);
    };
    if (this.deps.queueManager) {
      this.deps.queueManager.getQueue(`daily-brief-${userId}`).enqueue(task);
      return;
    }
    task().catch((err) => {
      this.deps.logger.error({ err, briefId, userId }, "Daily Brief: background generation failed");
    });
  }

  private async generateExistingBrief(briefId: string, userId: string): Promise<void> {
    const brief = await this.deps.db
      .selectFrom("daily_briefs")
      .selectAll()
      .where("id", "=", briefId)
      .executeTakeFirst();
    const user = await this.deps.users.findById(userId);
    if (!brief || !user) return;

    let saved = false;
    const writer = this.createWriter({
      briefId,
      expectedUserId: user.id,
      expectedBriefDate: brief.brief_date,
      expectedTimezone: brief.timezone,
      onSaved: () => {
        saved = true;
      },
    });

    try {
      const config = await this.repo.getConfig(user.id);
      const [settings, sameDayPrevious, previousDay] = await Promise.all([
        this.deps.settings.get(),
        this.getLatestForUser(user.id, brief.brief_date),
        this.getLatestForUser(user.id, addDays(brief.brief_date, -1)),
      ]);
      const runtimeContext = {
        agentKey: DAILY_BRIEF_AGENT_KEY,
        agentVersion: DAILY_BRIEF_AGENT_VERSION,
        briefId,
        briefDate: brief.brief_date,
        timezone: brief.timezone,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        sections: ["todos", "customerUpdates", "activeProjects"],
        maxItemsPerSection: config.maxItemsPerSection,
        sameDayPreviousBrief: formatBriefForContext(sameDayPrevious.brief),
        previousDayBrief: formatBriefForContext(previousDay.brief),
      };
      const userMessage = buildSketchContext({
        messages: [],
        currentUserName: user.name,
        currentUserEmail: user.email,
        currentMessage: [
          "Generate today's Daily Brief using the runtime context below.",
          "Use tools to inspect the knowledge graph and then call WriteDailyBrief.",
          "",
          "Runtime context:",
          JSON.stringify(runtimeContext, null, 2),
        ].join("\n"),
        workspaceDir: await ensureWorkspace(this.deps.config, user.id),
        orgDir: this.deps.config.CLAUDE_CONFIG_DIR,
        timezone: brief.timezone,
      });
      const integrationMcpServers = this.deps.buildMcpServers ? await this.deps.buildMcpServers(user.email) : {};
      const workspaceDir = join(this.deps.config.DATA_DIR, "workspaces", user.id);
      const result = await this.deps.runAgent({
        db: this.deps.db,
        workspaceKey: user.id,
        userMessage,
        workspaceDir,
        claudeConfigDir: this.deps.config.CLAUDE_CONFIG_DIR,
        userName: user.name,
        userEmail: user.email,
        logger: this.deps.logger,
        platform: "slack",
        responseSurface: "web",
        onProgressEvent: async () => {},
        integrationMcpServers,
        loadIntegrationProvider: this.deps.loadIntegrationProvider,
        sessionMode: "fresh",
        persistSession: false,
        contextType: "scheduled_task",
        currentUserId: user.id,
        userRepo: this.deps.users,
        maxTurns: 35,
        agentInstructions: buildStableInstructions(config.maxItemsPerSection),
        agentAllowedTools: DAILY_BRIEF_ALLOWED_TOOLS,
        dailyBriefWriter: writer,
      });
      if (!saved) {
        await this.repo.markFailed(briefId, "Briefing agent did not call WriteDailyBrief.");
      } else {
        await this.deps.db
          .updateTable("daily_briefs")
          .set({ agent_run_id: result.sessionId || null })
          .where("id", "=", briefId)
          .execute();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed(briefId, message);
      this.deps.logger.error({ err, briefId, userId }, "Daily Brief: generation failed");
    }
  }

  private createWriter(params: {
    briefId: string;
    expectedUserId: string;
    expectedBriefDate: string;
    expectedTimezone: string;
    onSaved: () => void;
  }): DailyBriefWriter {
    return {
      write: async (payload: {
        briefDate: string;
        timezone: string;
        masthead: DailyBriefMasthead;
        rawPayload: WriteDailyBriefPayload;
        items: DailyBriefItemInput[];
      }) => {
        if (payload.briefDate !== params.expectedBriefDate) {
          throw new Error(`Brief date mismatch: expected ${params.expectedBriefDate}, got ${payload.briefDate}`);
        }
        if (payload.timezone !== params.expectedTimezone) {
          throw new Error(`Timezone mismatch: expected ${params.expectedTimezone}, got ${payload.timezone}`);
        }
        const items = await this.enrichItems(payload.items);
        await this.validateItemRefs(items);
        await this.repo.completeBrief({
          briefId: params.briefId,
          masthead: payload.masthead,
          rawPayload: payload.rawPayload,
          items,
        });
        params.onSaved();
      },
    };
  }

  private async enrichItems(items: DailyBriefItemInput[]): Promise<DailyBriefItemInput[]> {
    const fileIds = [...new Set(items.flatMap((item) => item.knowledgeRefs.fileIds))];
    const files = await this.loadDailyBriefReferencedFiles(fileIds);
    const fileById = new Map(files.map((file) => [file.id, file]));

    return items.map((item) => {
      const referencedFiles = this.referencedFilesForItem(item, fileById);
      return {
        ...item,
        displayRef: displayRefForItem(item, referencedFiles),
        sourceUrl: sourceUrlForItem(referencedFiles),
        actionLabel: normalizeActionLabel(item),
      };
    });
  }

  private async loadDailyBriefReferencedFiles(fileIds: string[]): Promise<DailyBriefReferencedFile[]> {
    if (fileIds.length === 0) return [];
    return this.deps.db
      .selectFrom("indexed_files")
      .select(["id", "source", "provider_file_id", "provider_url", "file_name", "source_path"])
      .where("id", "in", fileIds)
      .execute();
  }

  private referencedFilesForItem(
    item: DailyBriefItemInput,
    fileById: Map<string, DailyBriefReferencedFile>,
  ): DailyBriefReferencedFile[] {
    const referencedFiles: DailyBriefReferencedFile[] = [];
    for (const id of item.knowledgeRefs.fileIds) {
      const file = fileById.get(id);
      if (file) referencedFiles.push(file);
    }
    return referencedFiles;
  }

  private async validateItemRefs(items: DailyBriefItemInput[]): Promise<void> {
    const errors: string[] = [];
    for (const item of items) {
      if (item.knowledgeRefs.entityIds.length + item.knowledgeRefs.fileIds.length === 0) {
        errors.push(`${item.sectionKey}:${item.title} has no entityIds or fileIds`);
      }
      const entityCount = await this.repo.countKnownEntities(item.knowledgeRefs.entityIds);
      if (entityCount !== item.knowledgeRefs.entityIds.length) {
        errors.push(`${item.sectionKey}:${item.title} references unknown entityIds`);
      }
      const fileCount = await this.repo.countKnownFiles(item.knowledgeRefs.fileIds);
      if (fileCount !== item.knowledgeRefs.fileIds.length) {
        errors.push(`${item.sectionKey}:${item.title} references unknown fileIds`);
      }
    }
    if (errors.length > 0) throw new Error(`Daily Brief validation failed:\n${errors.join("\n")}`);
  }
}

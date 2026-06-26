import { join } from "node:path";
import type { Kysely, Selectable } from "kysely";
import { buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, RunAgentParams, RunAgentResult } from "../agent/runner";
import type { AgentOutputWriter, WriteAgentOutputPayload } from "../agent/tools/agent-output";
import { ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import {
  type AgentDeliveryConfig,
  type AgentMasthead,
  type AgentOutputItemInput,
  type AgentOutputRow,
  type AgentOutputTriggerType,
  type AgentUserPrefs,
  createAgentOutputRepository,
} from "../db/repositories/agent-outputs";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB, UsersTable } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { AgentOutputDeliveryPublisher } from "./output-delivery";
import { getAgentDefinition, listAgentDefinitions, requireAgentDefinition } from "./registry";
import type { AgentApiItem, AgentDefinition } from "./types";

const RUNNING_STALE_AFTER_MS = 30 * 60 * 1000;
const SCHEDULED_FAILURE_SUPPRESS_AFTER_MS = 60 * 60 * 1000;

type UserRow = Selectable<UsersTable>;

export interface AgentRunServiceDeps {
  db: Kysely<DB>;
  config: Config;
  logger: Logger;
  users: ReturnType<typeof createUserRepository>;
  settings: ReturnType<typeof createSettingsRepository>;
  runAgent: (params: RunAgentParams) => Promise<RunAgentResult>;
  buildMcpServers?: (email: string | null) => Promise<Record<string, McpServerConfig>>;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
  queueManager?: QueueManager;
  outputDelivery?: AgentOutputDeliveryPublisher;
}

export interface RequestAgentGenerationParams {
  agentKey: string;
  userId: string;
  outputDate?: string;
  triggerType: AgentOutputTriggerType;
  skipIfCompleted?: boolean;
}

export interface ResolvedAgentConfig {
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  timezone: string | null;
  maxItemsPerSection: number;
  enabledSections: Record<string, boolean>;
  focus: string | null;
  delivery: AgentDeliveryConfig | null;
}

export interface AgentSectionView {
  key: string;
  title: string;
  enabled: boolean;
}

export interface AgentConfigView {
  agentKey: string;
  title: string;
  tagline: string;
  description: string;
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  timezone: string | null;
  maxItemsPerSection: number;
  itemsPerSectionRange: { min: number; max: number };
  focus: string | null;
  delivery: AgentDeliveryConfig | null;
  sections: AgentSectionView[];
}

export interface AgentOutputApi {
  id: string;
  agentKey: string;
  userId: string;
  outputDate: string;
  timezone: string;
  status: string;
  generatedAt: string | null;
  masthead: AgentMasthead | null;
  sections: Record<string, AgentApiItem[]>;
}

export interface AgentSummaryView {
  key: string;
  title: string;
  tagline: string;
  description: string;
  category: string;
  version: string;
  enabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
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

function emptySections(def: AgentDefinition): Record<string, AgentApiItem[]> {
  const sections: Record<string, AgentApiItem[]> = {};
  for (const section of def.sections) sections[section.key] = [];
  return sections;
}

/**
 * Generic engine that runs every prebuilt agent. Behavior is supplied by the
 * code-owned {@link AgentDefinition} resolved from the registry; per-user config and
 * outputs are data. Idempotency, scheduling, and the run lifecycle live here so each
 * definition only describes contract and shaping.
 */
export class AgentRunService {
  private repo: ReturnType<typeof createAgentOutputRepository>;
  private deps: AgentRunServiceDeps;

  constructor(deps: AgentRunServiceDeps) {
    this.deps = deps;
    this.repo = createAgentOutputRepository(deps.db);
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

  private async resolveConfig(def: AgentDefinition, userId: string): Promise<ResolvedAgentConfig> {
    const raw = await this.repo.getConfig(def.key, userId);
    const prefs: AgentUserPrefs = raw.prefs ?? {};
    const enabledSections: Record<string, boolean> = {};
    for (const section of def.sections) {
      enabledSections[section.key] = prefs.sections?.[section.key] ?? section.enabledByDefault;
    }
    return {
      enabled: raw.exists ? raw.enabled : def.defaults.enabled,
      scheduleHour: raw.scheduleHour ?? def.defaults.scheduleHour,
      scheduleMinute: raw.scheduleMinute ?? def.defaults.scheduleMinute,
      timezone: raw.timezone,
      maxItemsPerSection: raw.maxItemsPerSection ?? def.defaults.maxItemsPerSection,
      enabledSections,
      focus: prefs.focus ?? null,
      delivery: prefs.delivery ?? null,
    };
  }

  listDefinitions(): readonly AgentDefinition[] {
    return listAgentDefinitions();
  }

  async listForUser(userId: string): Promise<AgentSummaryView[]> {
    const result: AgentSummaryView[] = [];
    for (const def of listAgentDefinitions()) {
      const config = await this.resolveConfig(def, userId);
      result.push({
        key: def.key,
        title: def.title,
        tagline: def.tagline,
        description: def.description,
        category: def.category,
        version: def.version,
        enabled: config.enabled,
        scheduleHour: config.scheduleHour,
        scheduleMinute: config.scheduleMinute,
      });
    }
    return result;
  }

  async getConfigView(agentKey: string, userId: string): Promise<AgentConfigView | null> {
    const def = getAgentDefinition(agentKey);
    if (!def) return null;
    const config = await this.resolveConfig(def, userId);
    return {
      agentKey: def.key,
      title: def.title,
      tagline: def.tagline,
      description: def.description,
      enabled: config.enabled,
      scheduleHour: config.scheduleHour,
      scheduleMinute: config.scheduleMinute,
      timezone: config.timezone,
      maxItemsPerSection: config.maxItemsPerSection,
      itemsPerSectionRange: def.itemsPerSectionRange,
      focus: config.focus,
      delivery: config.delivery,
      sections: def.sections.map((section) => ({
        key: section.key,
        title: section.title,
        enabled: config.enabledSections[section.key] ?? section.enabledByDefault,
      })),
    };
  }

  async updateConfigForUser(
    agentKey: string,
    userId: string,
    patch: {
      enabled?: boolean;
      scheduleHour?: number;
      scheduleMinute?: number;
      maxItemsPerSection?: number;
      sections?: Record<string, boolean>;
      focus?: string | null;
      delivery?: AgentDeliveryConfig | null;
    },
  ): Promise<AgentConfigView | null> {
    const def = getAgentDefinition(agentKey);
    if (!def) return null;
    const current = await this.resolveConfig(def, userId);

    const range = def.itemsPerSectionRange;
    const maxItemsPerSection =
      patch.maxItemsPerSection !== undefined
        ? Math.min(range.max, Math.max(range.min, patch.maxItemsPerSection))
        : undefined;

    let prefs: AgentUserPrefs | undefined;
    if (patch.sections !== undefined || patch.focus !== undefined || patch.delivery !== undefined) {
      const sections: Record<string, boolean> = { ...current.enabledSections };
      if (patch.sections) {
        for (const section of def.sections) {
          if (patch.sections[section.key] !== undefined) sections[section.key] = Boolean(patch.sections[section.key]);
        }
      }
      const focus = patch.focus !== undefined ? (patch.focus?.trim() ? patch.focus.trim() : null) : current.focus;
      const delivery = patch.delivery !== undefined ? patch.delivery : current.delivery;
      prefs = { sections, focus, delivery };
    }

    await this.repo.upsertConfig(
      def.key,
      userId,
      {
        enabled: patch.enabled,
        scheduleHour: patch.scheduleHour,
        scheduleMinute: patch.scheduleMinute,
        maxItemsPerSection,
        prefs,
      },
      {
        enabled: def.defaults.enabled,
        scheduleHour: def.defaults.scheduleHour,
        scheduleMinute: def.defaults.scheduleMinute,
        maxItemsPerSection: def.defaults.maxItemsPerSection,
      },
    );
    return this.getConfigView(agentKey, userId);
  }

  private toApiOutput(
    def: AgentDefinition,
    value: Awaited<ReturnType<ReturnType<typeof createAgentOutputRepository>["findLatestCompleted"]>>,
  ): AgentOutputApi | null {
    if (!value) return null;
    const sections = emptySections(def);
    for (const item of value.items) {
      if (!(item.section_key in sections)) continue;
      sections[item.section_key].push(def.toApiItem(item));
    }
    return {
      id: value.output.id,
      agentKey: value.output.agent_key,
      userId: value.output.user_id,
      outputDate: value.output.output_date,
      timezone: value.output.timezone,
      status: value.output.status,
      generatedAt: value.output.generated_at,
      masthead: value.masthead,
      sections,
    };
  }

  async getLatestForUser(
    agentKey: string,
    userId: string,
    outputDate?: string,
  ): Promise<{
    output: AgentOutputApi | null;
    running: boolean;
    outputDate: string;
    timezone: string;
    enabledSections: string[];
  }> {
    const def = requireAgentDefinition(agentKey);
    const user = await this.deps.users.findById(userId);
    if (!user) throw new Error("User not found");
    const config = await this.resolveConfig(def, user.id);
    const timezone = config.timezone || user.timezone || "UTC";
    const date = outputDate || localDateInTimezone(new Date(), timezone);
    const now = new Date();
    const [completed, running] = await Promise.all([
      this.repo.findLatestCompleted(def.key, user.id, date),
      this.repo.findRunning(def.key, user.id, date),
    ]);
    return {
      output: this.toApiOutput(def, completed),
      running: Boolean(running && !this.isRunningStale(running, now)),
      outputDate: date,
      timezone,
      enabledSections: def.sections.filter((s) => config.enabledSections[s.key]).map((s) => s.key),
    };
  }

  async getByIdForUser(agentKey: string, id: string, userId: string): Promise<AgentOutputApi | null> {
    const def = requireAgentDefinition(agentKey);
    return this.toApiOutput(def, await this.repo.getByIdForUser(def.key, id, userId));
  }

  async requestGenerationForUser(params: RequestAgentGenerationParams): Promise<AgentOutputRow | null> {
    const def = requireAgentDefinition(params.agentKey);
    const user = await this.deps.users.findById(params.userId);
    if (!user) throw new Error("User not found");
    const config = await this.resolveConfig(def, user.id);
    const timezone = config.timezone || user.timezone || "UTC";
    const outputDate = params.outputDate || localDateInTimezone(new Date(), timezone);
    const now = new Date();

    let recoveredStaleRunning = false;
    const existingRunning = await this.repo.findRunning(def.key, user.id, outputDate);
    if (existingRunning) {
      if (!this.isRunningStale(existingRunning, now)) return existingRunning;
      recoveredStaleRunning = true;
      await this.repo.markFailed(existingRunning.id, "Generation expired after being left running.");
    }
    if (params.skipIfCompleted && (await this.repo.findLatestCompleted(def.key, user.id, outputDate))) {
      return null;
    }
    if (params.skipIfCompleted && params.triggerType === "scheduled" && !recoveredStaleRunning) {
      const latest = await this.repo.findLatestAny(def.key, user.id, outputDate);
      if (latest && this.isRecentScheduledFailure(latest, now)) return latest;
    }
    const result = await this.repo.createRunning({
      agentKey: def.key,
      agentVersion: def.version,
      userId: user.id,
      outputDate,
      timezone,
      triggerType: params.triggerType,
    });
    if (result.created) this.enqueueRun(def.key, result.row.id, user.id);
    return result.row;
  }

  async listSchedulableUsers(): Promise<UserRow[]> {
    const rows = await this.deps.users.list();
    return rows.filter((user) => user.type === "human");
  }

  async shouldGenerateForUser(
    def: AgentDefinition,
    user: UserRow,
    now = new Date(),
  ): Promise<{ outputDate: string } | null> {
    const config = await this.resolveConfig(def, user.id);
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
    const outputDate = localDateInTimezone(now, timezone);
    const [running, completed] = await Promise.all([
      this.repo.findRunning(def.key, user.id, outputDate),
      this.repo.findLatestCompleted(def.key, user.id, outputDate),
    ]);
    if (running && !this.isRunningStale(running, now)) return null;
    if (completed) return null;
    const latest = await this.repo.findLatestAny(def.key, user.id, outputDate);
    if (latest && this.isRecentScheduledFailure(latest, now)) return null;
    return { outputDate };
  }

  private isRunningStale(output: AgentOutputRow, now: Date): boolean {
    return output.status === "running" && isOlderThan(output.created_at, now, RUNNING_STALE_AFTER_MS);
  }

  private isRecentScheduledFailure(output: AgentOutputRow, now: Date): boolean {
    return (
      output.status === "failed" &&
      output.trigger_type === "scheduled" &&
      isNewerThan(output.updated_at, now, SCHEDULED_FAILURE_SUPPRESS_AFTER_MS)
    );
  }

  private enqueueRun(agentKey: string, outputId: string, userId: string): void {
    const task = async () => {
      await this.generateExistingOutput(agentKey, outputId, userId);
    };
    if (this.deps.queueManager) {
      this.deps.queueManager.getQueue(`agent-${agentKey}-${userId}`).enqueue(task);
      return;
    }
    task().catch((err) => {
      this.deps.logger.error({ err, agentKey, outputId, userId }, "Agent: background generation failed");
    });
  }

  private formatOutputForContext(api: AgentOutputApi | null) {
    if (!api) return null;
    return {
      id: api.id,
      outputDate: api.outputDate,
      generatedAt: api.generatedAt,
      items: Object.entries(api.sections).flatMap(([sectionKey, items]) =>
        items.map((item) => ({
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

  private async generateExistingOutput(agentKey: string, outputId: string, userId: string): Promise<void> {
    const def = requireAgentDefinition(agentKey);
    const output = await this.repo.findById(def.key, outputId);
    const user = await this.deps.users.findById(userId);
    if (!output || !user) return;

    let saved = false;
    const config = await this.resolveConfig(def, user.id);
    const enabledSections = def.sections.filter((s) => config.enabledSections[s.key]).map((s) => s.key);
    const writer = this.createWriter(def, {
      outputId,
      enabledSections: new Set(enabledSections),
      expectedOutputDate: output.output_date,
      expectedTimezone: output.timezone,
      onSaved: () => {
        saved = true;
      },
    });

    try {
      const now = new Date();
      const settings = await this.deps.settings.get();
      const adminCanReadAllFiles = settings?.admin_can_read_all_files === 1;
      const contentUserEmails =
        user.auth_role === "admin" && adminCanReadAllFiles
          ? undefined
          : await this.deps.users.getAllEmailsForUser(user.id);
      const [sameDayPrevious, previousDay, definitionContext] = await Promise.all([
        this.getLatestForUser(def.key, user.id, output.output_date),
        this.getLatestForUser(def.key, user.id, addDays(output.output_date, -1)),
        def.buildRuntimeContext
          ? def.buildRuntimeContext({
              db: this.deps.db,
              user,
              outputDate: output.output_date,
              timezone: output.timezone,
              now,
              adminCanReadAllFiles,
              contentUserEmails,
            })
          : Promise.resolve({}),
      ]);
      const runtimeContext = {
        agentKey: def.key,
        agentVersion: def.version,
        outputId,
        outputDate: output.output_date,
        timezone: output.timezone,
        user: { id: user.id, name: user.name, email: user.email },
        sections: enabledSections,
        maxItemsPerSection: config.maxItemsPerSection,
        focus: config.focus,
        sameDayPreviousOutput: this.formatOutputForContext(sameDayPrevious.output),
        previousDayOutput: this.formatOutputForContext(previousDay.output),
        ...definitionContext,
      };
      const userMessage = buildSketchContext({
        messages: [],
        currentUserName: user.name,
        currentUserEmail: user.email,
        currentMessage: [
          `Generate today's ${def.title} using the runtime context below.`,
          "Use tools to inspect the knowledge graph and then call WriteAgentOutput.",
          "",
          "Runtime context:",
          JSON.stringify(runtimeContext, null, 2),
        ].join("\n"),
        workspaceDir: await ensureWorkspace(this.deps.config, user.id),
        orgDir: this.deps.config.CLAUDE_CONFIG_DIR,
        timezone: output.timezone,
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
        agentInstructions: def.buildInstructions(),
        agentAllowedTools: def.allowedTools,
        agentOutputWriter: writer,
      });
      if (!saved) {
        await this.repo.markFailed(outputId, "Agent did not call WriteAgentOutput.");
      } else {
        await this.deps.db
          .updateTable("agent_outputs")
          .set({ agent_run_id: result.sessionId || null })
          .where("id", "=", outputId)
          .execute();
        await this.deliverCompletedOutput(def, outputId, user.id, output.trigger_type, config.delivery);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed(outputId, message);
      this.deps.logger.error({ err, agentKey, outputId, userId }, "Agent: generation failed");
    }
  }

  private async deliverCompletedOutput(
    def: AgentDefinition,
    outputId: string,
    userId: string,
    triggerType: string,
    delivery: AgentDeliveryConfig | null,
  ): Promise<void> {
    if (triggerType !== "scheduled" || !delivery || !this.deps.outputDelivery) return;
    try {
      const completed = await this.getByIdForUser(def.key, outputId, userId);
      if (!completed) return;
      await this.deps.outputDelivery.deliver({ definition: def, output: completed, delivery });
    } catch (err) {
      this.deps.logger.warn({ err, agentKey: def.key, outputId, userId }, "Agent: output delivery failed");
    }
  }

  private createWriter(
    def: AgentDefinition,
    params: {
      outputId: string;
      enabledSections: Set<string>;
      expectedOutputDate: string;
      expectedTimezone: string;
      onSaved: () => void;
    },
  ): AgentOutputWriter {
    return {
      write: async (payload: {
        outputDate: string;
        timezone: string;
        masthead: AgentMasthead;
        rawPayload: WriteAgentOutputPayload;
        items: AgentOutputItemInput[];
      }) => {
        if (payload.outputDate !== params.expectedOutputDate) {
          throw new Error(`Output date mismatch: expected ${params.expectedOutputDate}, got ${payload.outputDate}`);
        }
        if (payload.timezone !== params.expectedTimezone) {
          throw new Error(`Timezone mismatch: expected ${params.expectedTimezone}, got ${payload.timezone}`);
        }
        const sectionKeys = new Set(def.sections.map((s) => s.key));
        const filtered = payload.items.filter(
          (item) => sectionKeys.has(item.sectionKey) && params.enabledSections.has(item.sectionKey),
        );
        const items = await def.enrichItems(this.deps.db, filtered);
        await this.validateItemRefs(def, items);
        await this.repo.completeOutput({
          outputId: params.outputId,
          masthead: payload.masthead,
          rawPayload: payload.rawPayload,
          items,
        });
        params.onSaved();
      },
    };
  }

  private async validateItemRefs(def: AgentDefinition, items: AgentOutputItemInput[]): Promise<void> {
    const errors: string[] = [];
    for (const item of items) {
      if (def.requiresKnowledgeRefs && item.knowledgeRefs.entityIds.length + item.knowledgeRefs.fileIds.length === 0) {
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
    if (errors.length > 0) throw new Error(`Agent output validation failed:\n${errors.join("\n")}`);
  }
}

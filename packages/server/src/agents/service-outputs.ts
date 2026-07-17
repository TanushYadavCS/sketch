import type {
  AgentOutputRow,
  AgentOutputTriggerType,
  createAgentOutputRepository,
} from "../db/repositories/agent-outputs";
import { CONVERSATION_SUMMARY_AGENT_KEY } from "./definitions/conversation-summary";
import { requireAgentDefinition } from "./registry";
import { AgentOutputRunQueue, type ScheduledRunAdmission } from "./run-queue";
import type {
  AgentDueGenerationGroup,
  AgentExpectedScope,
  AgentGenerationScope,
  AgentOutputApi,
  AgentRunServiceDeps,
  AgentViewerRole,
  RequestAgentGenerationParams,
  ResolvedAgentConfig,
  UserRow,
} from "./service-contracts";
import {
  computeDuePeriodKey,
  emptySections,
  isNewerThan,
  isOlderThan,
  localDateInTimezone,
} from "./service-output-utils";
import { decodeOrgRouteId, labelForRoute, scopeKeyForRoute } from "./service-routing";
import { AgentTargetService } from "./service-targets";
import type { AgentDefinition } from "./types";

const RUNNING_STALE_AFTER_MS = 30 * 60 * 1000;
const SCHEDULED_FAILURE_SUPPRESS_AFTER_MS = 60 * 60 * 1000;
export abstract class AgentOutputService extends AgentTargetService {
  protected readonly runQueue: AgentOutputRunQueue;

  protected abstract generateExistingOutput(
    agentKey: string,
    outputId: string,
    userId: string,
    scheduledAdmission?: ScheduledRunAdmission,
  ): Promise<void>;

  constructor(deps: AgentRunServiceDeps) {
    super(deps);
    this.runQueue = new AgentOutputRunQueue({
      logger: deps.logger,
      queueManager: deps.queueManager,
      repo: this.repo,
      run: ({ agentKey, outputId, userId, scheduledAdmission }) =>
        this.generateExistingOutput(agentKey, outputId, userId, scheduledAdmission),
    });
  }

  protected toApiOutput(
    def: AgentDefinition,
    value: Awaited<ReturnType<ReturnType<typeof createAgentOutputRepository>["findLatestCompletedForScope"]>>,
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
      sourceKey: value.output.source_key,
      sourceLabel: value.output.source_label,
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
      this.repo.findLatestCompletedAcrossScopes(def.key, user.id, date),
      this.repo.findRunningAcrossScopes(def.key, user.id, date),
    ]);
    return {
      output: this.toApiOutput(def, completed),
      running: Boolean(running && !this.isRunningStale(running, now)),
      outputDate: date,
      timezone,
      enabledSections: def.sections.filter((s) => config.enabledSections[s.key]).map((s) => s.key),
    };
  }

  async getLatestForViewer(
    agentKey: string,
    userId: string,
    role: AgentViewerRole,
    outputDate?: string,
  ): Promise<{
    output: AgentOutputApi | null;
    running: boolean;
    outputDate: string;
    timezone: string;
    enabledSections: string[];
  }> {
    if (!this.usesOrgWideSummarizerView(agentKey, role)) {
      const configUserId = await this.resolveConfigControlUserId(agentKey, userId, role);
      return this.getLatestForUser(agentKey, configUserId, outputDate);
    }

    const def = requireAgentDefinition(agentKey);
    const user = await this.deps.users.findById(userId);
    if (!user) throw new Error("User not found");
    const timezone = user.timezone || "UTC";
    const date = outputDate || localDateInTimezone(new Date(), timezone);
    const now = new Date();
    const [completed, running] = await Promise.all([
      this.repo.findLatestCompletedAcrossHumanUsers(def.key, date),
      this.repo.findRunningAcrossHumanUsers(def.key, date),
    ]);
    return {
      output: this.toApiOutput(def, completed),
      running: Boolean(running && !this.isRunningStale(running, now)),
      outputDate: date,
      timezone,
      enabledSections: def.sections.map((section) => section.key),
    };
  }

  async getByIdForUser(agentKey: string, id: string, userId: string): Promise<AgentOutputApi | null> {
    const def = requireAgentDefinition(agentKey);
    return this.toApiOutput(def, await this.repo.getByIdForUser(def.key, id, userId));
  }

  async getByIdForViewer(
    agentKey: string,
    id: string,
    userId: string,
    role: AgentViewerRole,
  ): Promise<AgentOutputApi | null> {
    const def = requireAgentDefinition(agentKey);
    if (this.usesOrgWideSummarizerView(agentKey, role)) {
      return this.toApiOutput(def, await this.repo.getByIdForHumanUser(def.key, id));
    }
    const configUserId = await this.resolveConfigControlUserId(agentKey, userId, role);
    return this.getByIdForUser(agentKey, id, configUserId);
  }

  async listOutputsForUser(
    agentKey: string,
    userId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ outputs: AgentOutputApi[]; nextCursor: string | null }> {
    const def = requireAgentDefinition(agentKey);
    const result = await this.repo.listCompletedForUser(def.key, userId, options);
    return {
      outputs: result.outputs.flatMap((output) => {
        const api = this.toApiOutput(def, output);
        return api ? [api] : [];
      }),
      nextCursor: result.nextCursor,
    };
  }

  async listOutputsForViewer(
    agentKey: string,
    userId: string,
    role: AgentViewerRole,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ outputs: AgentOutputApi[]; nextCursor: string | null }> {
    const def = requireAgentDefinition(agentKey);
    if (!this.usesOrgWideSummarizerView(agentKey, role)) {
      const configUserId = await this.resolveConfigControlUserId(agentKey, userId, role);
      return this.listOutputsForUser(agentKey, configUserId, options);
    }
    const result = await this.repo.listCompletedForHumanUsers(def.key, options);
    return {
      outputs: result.outputs.flatMap((output) => {
        const api = this.toApiOutput(def, output);
        return api ? [api] : [];
      }),
      nextCursor: result.nextCursor,
    };
  }

  private async resolveExpectedScopesForUser(
    def: AgentDefinition,
    _user: UserRow,
    config: ResolvedAgentConfig,
  ): Promise<AgentExpectedScope[]> {
    if (!def.sourceConfig) {
      return [{ kind: "combined", sourceKey: "", sourceLabel: null, sources: [] }];
    }

    return config.routes
      .filter((route) => route.enabled)
      .map((route): AgentExpectedScope => {
        const sourceKey = scopeKeyForRoute(route, route.resolvedSources);
        const sourceLabel = labelForRoute(route, route.resolvedSources);
        if (route.resolvedSources.length === 1) {
          const [source] = route.resolvedSources;
          return { kind: "source", source, sourceKey, sourceLabel, route, sources: route.resolvedSources };
        }
        return { kind: "combined", sourceKey, sourceLabel, route, sources: route.resolvedSources };
      });
  }

  async requestGenerationForViewer(
    params: RequestAgentGenerationParams & { viewerRole: AgentViewerRole },
  ): Promise<AgentOutputRow[]> {
    const { viewerRole, ...requestParams } = params;
    if (!this.usesOrgWideSummarizerView(requestParams.agentKey, viewerRole)) {
      const configUserId = await this.resolveConfigControlUserId(
        requestParams.agentKey,
        requestParams.userId,
        viewerRole,
      );
      return this.requestGenerationForUser({ ...requestParams, userId: configUserId });
    }

    const ownerRoutes = new Map<string, string[] | null>();
    if (requestParams.routeIds?.length) {
      for (const routeId of requestParams.routeIds) {
        const decoded = decodeOrgRouteId(routeId);
        const ownerUserId = decoded?.ownerUserId ?? requestParams.userId;
        const plainRouteId = decoded?.routeId ?? routeId;
        const routeIds = ownerRoutes.get(ownerUserId) ?? [];
        routeIds.push(plainRouteId);
        ownerRoutes.set(ownerUserId, routeIds);
      }
    } else {
      const owners = await this.repo.listHumanConfigs(requestParams.agentKey);
      for (const owner of owners) ownerRoutes.set(owner.userId, null);
      if (ownerRoutes.size === 0) ownerRoutes.set(requestParams.userId, null);
    }

    const rows: AgentOutputRow[] = [];
    for (const [ownerUserId, routeIds] of ownerRoutes) {
      rows.push(
        ...(await this.requestGenerationForUser({
          ...requestParams,
          userId: ownerUserId,
          ...(routeIds ? { routeIds } : {}),
        })),
      );
    }
    return rows;
  }

  async requestGenerationForUser(params: RequestAgentGenerationParams): Promise<AgentOutputRow[]> {
    const def = requireAgentDefinition(params.agentKey);
    const user = await this.deps.users.findById(params.userId);
    if (!user) throw new Error("User not found");
    const config = await this.resolveConfig(def, user.id);
    const timezone = config.timezone || user.timezone || "UTC";
    const outputDate = params.outputDate || localDateInTimezone(new Date(), timezone);
    const periodKey = params.periodKey ?? outputDate;
    const now = new Date();
    const scopes = await this.resolveExpectedScopesForUser(def, user, config);
    const scopeKeys = params.scopeKeys ? new Set(params.scopeKeys) : null;
    const routeIds = params.routeIds ? new Set(params.routeIds) : null;
    const rows: AgentOutputRow[] = [];

    for (const scope of scopes.filter((candidate) => {
      if (scopeKeys && !scopeKeys.has(candidate.sourceKey)) return false;
      if (routeIds && (!candidate.route || !routeIds.has(candidate.route.id))) return false;
      return true;
    })) {
      let recoveredStaleRunning = false;
      const existingRunning = await this.repo.findRunning(def.key, user.id, periodKey, scope.sourceKey);
      if (existingRunning && !this.isRunningStale(existingRunning, now)) {
        rows.push(await this.reuseRunningOutput(def.key, user.id, params.triggerType, existingRunning));
        continue;
      }
      if (existingRunning) {
        recoveredStaleRunning = true;
        await this.repo.markFailed(existingRunning.id, "Generation expired after being left running.");
      }
      if (
        params.skipIfCompleted &&
        (await this.repo.findLatestCompletedForScope(def.key, user.id, scope.sourceKey, periodKey))
      ) {
        continue;
      }
      if (params.skipIfCompleted && params.triggerType === "scheduled" && !recoveredStaleRunning) {
        const latest = await this.repo.findLatestAny(def.key, user.id, periodKey, scope.sourceKey);
        if (latest && this.isRecentScheduledFailure(latest, now)) {
          rows.push(latest);
          continue;
        }
      }
      const result = await this.repo.createRunning({
        agentKey: def.key,
        agentVersion: def.version,
        userId: user.id,
        outputDate,
        periodKey,
        sourceKey: scope.sourceKey,
        sourceLabel: scope.sourceLabel,
        timezone,
        triggerType: params.triggerType,
      });
      if (result.created) {
        this.runQueue.enqueue({
          agentKey: def.key,
          outputId: result.row.id,
          userId: user.id,
          triggerType: params.triggerType,
        });
      }
      rows.push(result.row);
    }

    return rows;
  }

  async listSchedulableUsers(): Promise<UserRow[]> {
    const rows = await this.deps.users.list();
    return rows.filter((user) => user.type === "human");
  }

  async shouldGenerateForUser(
    def: AgentDefinition,
    user: UserRow,
    now = new Date(),
  ): Promise<AgentDueGenerationGroup[]> {
    const config = await this.resolveConfig(def, user.id);
    if (def.sourceConfig && config.routes.length === 0) return [];
    if (!config.enabled) return [];
    const timezone = config.timezone || user.timezone || "UTC";
    const outputDate = localDateInTimezone(now, timezone);
    const scopes = await this.resolveExpectedScopesForUser(def, user, config);
    if (scopes.length === 0) return [];
    const dueByPeriodKey = new Map<string, AgentDueGenerationGroup>();

    for (const scope of scopes) {
      const schedule = scope.route?.schedule ?? {
        frequency: "daily" as const,
        hour: config.scheduleHour,
        minute: config.scheduleMinute,
      };
      const periodKey = computeDuePeriodKey(schedule, now, timezone);
      if (!periodKey) continue;
      const [running, completed] = await Promise.all([
        this.repo.findRunning(def.key, user.id, periodKey, scope.sourceKey),
        this.repo.findLatestCompletedForScope(def.key, user.id, scope.sourceKey, periodKey),
      ]);
      if (completed) continue;
      if (running && !this.isRunningStale(running, now)) continue;
      const latest = await this.repo.findLatestAny(def.key, user.id, periodKey, scope.sourceKey);
      if (latest && this.isRecentScheduledFailure(latest, now)) continue;
      const group = dueByPeriodKey.get(periodKey) ?? { outputDate, periodKey, scopeKeys: [] };
      group.scopeKeys.push(scope.sourceKey);
      dueByPeriodKey.set(periodKey, group);
    }

    return [...dueByPeriodKey.values()];
  }

  private isRunningStale(output: AgentOutputRow, now: Date): boolean {
    return output.status === "running" && isOlderThan(output.created_at, now, RUNNING_STALE_AFTER_MS);
  }

  private async reuseRunningOutput(
    agentKey: string,
    userId: string,
    triggerType: AgentOutputTriggerType,
    output: AgentOutputRow,
  ): Promise<AgentOutputRow> {
    if (triggerType !== "manual" || output.trigger_type !== "scheduled") return output;
    return this.runQueue.promoteScheduledToManual({ agentKey, output, userId });
  }

  private isRecentScheduledFailure(output: AgentOutputRow, now: Date): boolean {
    return (
      output.status === "failed" &&
      output.trigger_type === "scheduled" &&
      isNewerThan(output.updated_at, now, SCHEDULED_FAILURE_SUPPRESS_AFTER_MS)
    );
  }

  protected formatOutputForContext(api: AgentOutputApi | null) {
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

  protected async resolveScopeForOutput(
    def: AgentDefinition,
    _user: UserRow,
    config: ResolvedAgentConfig,
    output: AgentOutputRow,
  ): Promise<AgentExpectedScope | null> {
    if (!def.sourceConfig) {
      return { kind: "combined", sourceKey: "", sourceLabel: null, sources: [] };
    }

    const route = config.routes.find(
      (candidate) => scopeKeyForRoute(candidate, candidate.resolvedSources) === output.source_key,
    );
    if (!route) return null;
    const sourceKey = scopeKeyForRoute(route, route.resolvedSources);
    const sourceLabel = output.source_label ?? labelForRoute(route, route.resolvedSources);
    if (route.resolvedSources.length === 1) {
      const [source] = route.resolvedSources;
      return { kind: "source", source, sourceKey, sourceLabel, route, sources: route.resolvedSources };
    }
    return { kind: "combined", sourceKey, sourceLabel, route, sources: route.resolvedSources };
  }

  protected async getPreviousOutputForContext(
    def: AgentDefinition,
    user: UserRow,
    outputDate: string,
    scope: AgentGenerationScope,
  ): Promise<AgentOutputApi | null> {
    if (def.key === CONVERSATION_SUMMARY_AGENT_KEY && scope.kind === "source") return null;
    return this.toApiOutput(
      def,
      await this.repo.findLatestCompletedForScopeOnDate(def.key, user.id, scope.sourceKey, outputDate),
    );
  }
}

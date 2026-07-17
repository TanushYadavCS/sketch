import {
  type AgentDeliveryModel,
  type AgentRoute,
  type AgentSourceConfig,
  type AgentUserConfigWithOwner,
  type AgentUserPrefs,
  createAgentOutputRepository,
} from "../../db/repositories/agent-outputs";
import { CONVERSATION_SUMMARY_AGENT_KEY } from "../definitions/conversation-summary";
import { getAgentDefinition, listAgentDefinitions } from "../registry";
import type { AgentDefinition } from "../types";
import type {
  AgentConfigRouteView,
  AgentConfigUpdatePatch,
  AgentConfigView,
  AgentRunServiceDeps,
  AgentSummaryView,
  AgentViewerRole,
  ResolvedAgentConfig,
  ResolvedRoute,
  UserRow,
} from "./contracts";
import { localDateInTimezone } from "./output-utils";
import {
  normalizeDeliveryModelFromValue,
  normalizeLegacyDeliveryModel,
  normalizeRoutesFromValue,
  parseSourceKey,
  projectLegacyDelivery,
  reconcileDeliveryModel,
  routeWithOwner,
  sourceKeyForTarget,
  stripOrgRouteOwner,
  synthesizeRoutesFromDeliveryModel,
} from "./routing";

/**
 * Generic engine that runs every prebuilt agent. Behavior is supplied by the
 * code-owned {@link AgentDefinition} resolved from the registry; per-user config and
 * outputs are data. Idempotency, scheduling, and the run lifecycle live here so each
 * definition only describes contract and shaping.
 */
export abstract class AgentRunConfigLayer {
  protected readonly repo: ReturnType<typeof createAgentOutputRepository>;
  protected readonly deps: AgentRunServiceDeps;

  constructor(deps: AgentRunServiceDeps) {
    this.deps = deps;
    this.repo = createAgentOutputRepository(deps.db);
  }

  protected abstract resolveDeliveryModelForUser(
    sources: AgentSourceConfig[],
    deliveryModel: AgentDeliveryModel,
  ): AgentDeliveryModel;

  protected abstract resolveRoutesForUser(
    def: AgentDefinition,
    sources: AgentSourceConfig[],
    routes: AgentRoute[],
  ): AgentRoute[];

  abstract resolveSourceConfigsForUser(
    agentKeyOrDef: string | AgentDefinition,
    userId: string,
    sources: AgentSourceConfig[],
  ): Promise<AgentSourceConfig[]>;

  protected abstract resolveRoutesForRun(
    def: AgentDefinition,
    userId: string,
    routes: AgentRoute[],
    sources: AgentSourceConfig[],
  ): Promise<ResolvedRoute[]>;

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

  protected async resolveConfig(def: AgentDefinition, userId: string): Promise<ResolvedAgentConfig> {
    const raw = await this.repo.getConfig(def.key, userId);
    const prefs: AgentUserPrefs = raw.prefs ?? {};
    const enabledSections: Record<string, boolean> = {};
    for (const section of def.sections) {
      enabledSections[section.key] = prefs.sections?.[section.key] ?? section.enabledByDefault;
    }
    const sources = prefs.sources ?? [];
    const deliveryModel =
      normalizeDeliveryModelFromValue(prefs.deliveryModel, sources) ??
      normalizeLegacyDeliveryModel(prefs.delivery ?? null, sources);
    const maxItemsPerSection = raw.maxItemsPerSection ?? def.defaults.maxItemsPerSection;
    const configuredRoutes =
      normalizeRoutesFromValue(prefs.routes) ??
      synthesizeRoutesFromDeliveryModel(deliveryModel, sources, prefs, maxItemsPerSection);
    const routes = await this.resolveRoutesForRun(def, userId, configuredRoutes, sources);
    return {
      enabled: raw.exists ? raw.enabled : def.defaults.enabled,
      scheduleHour: raw.scheduleHour ?? def.defaults.scheduleHour,
      scheduleMinute: raw.scheduleMinute ?? def.defaults.scheduleMinute,
      timezone: raw.timezone,
      maxItemsPerSection,
      enabledSections,
      focus: prefs.focus ?? null,
      delivery: projectLegacyDelivery(deliveryModel, sources),
      deliveryModel,
      sources,
      routes,
      configuredRoutes,
      createTasks: prefs.createTasks ?? false,
    };
  }

  protected usesOrgWideSummarizerView(agentKey: string, role: AgentViewerRole): boolean {
    return role === "admin" && agentKey === CONVERSATION_SUMMARY_AGENT_KEY;
  }

  private async getOrgWideSummarizerConfigView(
    def: AgentDefinition,
    viewerUserId: string,
  ): Promise<AgentConfigView | null> {
    const [owners, viewerConfig] = await Promise.all([
      this.repo.listHumanConfigs(def.key),
      this.resolveConfig(def, viewerUserId),
    ]);
    if (owners.length === 0) return this.getConfigView(def.key, viewerUserId);

    const sources: AgentSourceConfig[] = [];
    const sourceKeys = new Set<string>();
    const routes: AgentConfigRouteView[] = [];
    let enabled = false;

    for (const owner of owners) {
      const config = await this.resolveConfig(def, owner.userId);
      enabled = enabled || config.enabled;
      for (const source of config.sources) {
        const key = sourceKeyForTarget(source);
        if (sourceKeys.has(key)) continue;
        sourceKeys.add(key);
        sources.push(source);
      }
      routes.push(...config.configuredRoutes.map((route) => routeWithOwner(route, owner)));
    }

    return {
      agentKey: def.key,
      title: def.title,
      tagline: def.tagline,
      description: def.description,
      enabled,
      scheduleHour: viewerConfig.scheduleHour,
      scheduleMinute: viewerConfig.scheduleMinute,
      timezone: viewerConfig.timezone,
      maxItemsPerSection: viewerConfig.maxItemsPerSection,
      itemsPerSectionRange: def.itemsPerSectionRange,
      focus: viewerConfig.focus,
      delivery: viewerConfig.delivery,
      deliveryModel: viewerConfig.deliveryModel,
      sourceConfig: def.sourceConfig ?? null,
      sources,
      routes,
      createTasks: viewerConfig.createTasks,
      sections: def.sections.map((section) => ({
        key: section.key,
        title: section.title,
        enabled: viewerConfig.enabledSections[section.key] ?? section.enabledByDefault,
      })),
    };
  }

  private async sourceLookupForOwnerPatch(
    def: AgentDefinition,
    owners: AgentUserConfigWithOwner[],
    patchSources: AgentSourceConfig[] | undefined,
  ): Promise<Map<string, AgentSourceConfig>> {
    const lookup = new Map<string, AgentSourceConfig>();
    for (const source of patchSources ?? []) lookup.set(sourceKeyForTarget(source), source);
    for (const owner of owners) {
      const config = await this.resolveConfig(def, owner.userId);
      for (const source of config.sources) {
        const key = sourceKeyForTarget(source);
        if (!lookup.has(key)) lookup.set(key, source);
      }
    }
    return lookup;
  }

  private sourcesForRoutes(routes: AgentRoute[], lookup: Map<string, AgentSourceConfig>): AgentSourceConfig[] {
    const sources: AgentSourceConfig[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      for (const key of route.sources) {
        if (seen.has(key)) continue;
        const source = lookup.get(key) ?? parseSourceKey(key);
        seen.add(key);
        sources.push(source);
      }
    }
    return sources;
  }

  listDefinitions(): readonly AgentDefinition[] {
    return listAgentDefinitions();
  }

  async resolveConfigControlUserId(_agentKey: string, viewerUserId: string, _role: AgentViewerRole): Promise<string> {
    return viewerUserId;
  }

  async listForViewer(userId: string, role: AgentViewerRole): Promise<AgentSummaryView[]> {
    const result: AgentSummaryView[] = [];
    for (const def of listAgentDefinitions()) {
      if (this.usesOrgWideSummarizerView(def.key, role)) {
        const agent = await this.getOrgWideSummarizerConfigView(def, userId);
        if (!agent) continue;
        result.push({
          key: def.key,
          title: def.title,
          tagline: def.tagline,
          description: def.description,
          category: def.category,
          version: def.version,
          enabled: agent.enabled,
          scheduleHour: agent.scheduleHour,
          scheduleMinute: agent.scheduleMinute,
          sourceConfig: def.sourceConfig ?? null,
          sources: agent.sources,
          routes: agent.routes,
        });
        continue;
      }
      const configUserId = await this.resolveConfigControlUserId(def.key, userId, role);
      const config = await this.resolveConfig(def, configUserId);
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
        sourceConfig: def.sourceConfig ?? null,
        sources: config.sources,
        routes: config.configuredRoutes,
      });
    }
    return result;
  }

  async listForUser(userId: string): Promise<AgentSummaryView[]> {
    return this.listForViewer(userId, "member");
  }

  async getConfigViewForViewer(
    agentKey: string,
    userId: string,
    role: AgentViewerRole,
  ): Promise<AgentConfigView | null> {
    const def = getAgentDefinition(agentKey);
    if (!def) return null;
    if (this.usesOrgWideSummarizerView(agentKey, role)) return this.getOrgWideSummarizerConfigView(def, userId);
    const configUserId = await this.resolveConfigControlUserId(agentKey, userId, role);
    return this.getConfigView(agentKey, configUserId);
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
      deliveryModel: config.deliveryModel,
      sourceConfig: def.sourceConfig ?? null,
      sources: config.sources,
      routes: config.configuredRoutes,
      createTasks: config.createTasks,
      sections: def.sections.map((section) => ({
        key: section.key,
        title: section.title,
        enabled: config.enabledSections[section.key] ?? section.enabledByDefault,
      })),
    };
  }

  async updateConfigForViewer(
    agentKey: string,
    userId: string,
    role: AgentViewerRole,
    patch: AgentConfigUpdatePatch,
  ): Promise<AgentConfigView | null> {
    const def = getAgentDefinition(agentKey);
    if (!def) return null;
    if (!this.usesOrgWideSummarizerView(agentKey, role)) {
      const configUserId = await this.resolveConfigControlUserId(agentKey, userId, role);
      return this.updateConfigForUser(agentKey, configUserId, patch);
    }

    const hasRoutePatch = patch.routes !== undefined;
    const owners = await this.repo.listHumanConfigs(def.key);

    if (!hasRoutePatch) {
      const patchKeys = Object.keys(patch);
      const isEnabledOnlyPatch = patch.enabled !== undefined && patchKeys.length === 1;
      const targetUserIds = isEnabledOnlyPatch && owners.length > 0 ? owners.map((owner) => owner.userId) : [userId];
      for (const targetUserId of targetUserIds) await this.updateConfigForUser(agentKey, targetUserId, patch);
      return this.getOrgWideSummarizerConfigView(def, userId);
    }

    const routesByOwner = new Map<string, AgentRoute[]>();
    if (patch.routes !== undefined) {
      for (const owner of owners) routesByOwner.set(owner.userId, []);
    }

    for (const route of patch.routes ?? []) {
      const stripped = stripOrgRouteOwner(route);
      const ownerUserId = stripped.ownerUserId ?? userId;
      const routes = routesByOwner.get(ownerUserId) ?? [];
      routes.push(stripped.route);
      routesByOwner.set(ownerUserId, routes);
    }

    const sourceLookup = await this.sourceLookupForOwnerPatch(def, owners, patch.sources);
    for (const [ownerUserId, routes] of routesByOwner) {
      const ownerPatch: AgentConfigUpdatePatch = { ...patch };
      if (patch.routes !== undefined) ownerPatch.routes = routes;
      if (patch.sources !== undefined) ownerPatch.sources = this.sourcesForRoutes(routes, sourceLookup);
      if (patch.enabled !== undefined && ownerUserId !== userId && patch.routes !== undefined) {
        ownerPatch.enabled = undefined;
      }
      await this.updateConfigForUser(agentKey, ownerUserId, ownerPatch);
    }

    return this.getOrgWideSummarizerConfigView(def, userId);
  }

  async updateConfigForUser(
    agentKey: string,
    userId: string,
    patch: AgentConfigUpdatePatch,
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
    if (
      patch.enabled !== undefined ||
      patch.scheduleHour !== undefined ||
      patch.scheduleMinute !== undefined ||
      patch.sections !== undefined ||
      patch.focus !== undefined ||
      patch.delivery !== undefined ||
      patch.deliveryModel !== undefined ||
      patch.sources !== undefined ||
      patch.routes !== undefined ||
      patch.createTasks !== undefined ||
      maxItemsPerSection !== undefined
    ) {
      const sections: Record<string, boolean> = { ...current.enabledSections };
      if (patch.sections) {
        for (const section of def.sections) {
          if (patch.sections[section.key] !== undefined) sections[section.key] = Boolean(patch.sections[section.key]);
        }
      }
      const focus = patch.focus !== undefined ? (patch.focus?.trim() ? patch.focus.trim() : null) : current.focus;
      const sources =
        patch.sources !== undefined
          ? await this.resolveSourceConfigsForUser(def, userId, patch.sources)
          : current.sources;
      const deliveryModel =
        patch.deliveryModel !== undefined || patch.delivery !== undefined || patch.sources !== undefined
          ? this.resolveDeliveryModelForUser(
              sources,
              patch.deliveryModel !== undefined
                ? patch.deliveryModel
                : patch.delivery !== undefined
                  ? normalizeLegacyDeliveryModel(patch.delivery, sources)
                  : reconcileDeliveryModel(current.deliveryModel, sources),
            )
          : current.deliveryModel;
      const routes =
        patch.routes !== undefined
          ? this.resolveRoutesForUser(def, sources, patch.routes)
          : patch.deliveryModel !== undefined || patch.delivery !== undefined || patch.sources !== undefined
            ? synthesizeRoutesFromDeliveryModel(
                deliveryModel,
                sources,
                { sections, focus },
                maxItemsPerSection ?? current.maxItemsPerSection,
              )
            : current.configuredRoutes.map((route) => ({
                ...route,
                ...(patch.sections !== undefined ? { sections } : {}),
                ...(patch.focus !== undefined ? { focus } : {}),
                ...(maxItemsPerSection !== undefined ? { maxItemsPerSection } : {}),
              }));
      const createTasks = patch.createTasks !== undefined ? patch.createTasks : current.createTasks;
      prefs = {
        sections,
        focus,
        delivery: projectLegacyDelivery(deliveryModel, sources),
        deliveryModel,
        sources,
        routes,
        createTasks,
      };
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
}

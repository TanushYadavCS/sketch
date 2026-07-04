import { createHash } from "node:crypto";
import { join } from "node:path";
import { areJidsSameUser } from "@whiskeysockets/baileys";
import type { Kysely, Selectable } from "kysely";
import { buildSketchContext } from "../agent/prompt";
import type { McpServerConfig, RunAgentParams, RunAgentResult } from "../agent/runner";
import type { AgentOutputWriter, WriteAgentOutputPayload } from "../agent/tools/agent-output";
import { ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import {
  type AgentCombinedDeliveryConfig,
  type AgentDeliveryConfig,
  type AgentDeliveryMention,
  type AgentDeliveryModel,
  type AgentMasthead,
  type AgentOutputItemInput,
  type AgentOutputRow,
  type AgentOutputTriggerType,
  type AgentPerSourceDelivery,
  type AgentRoute,
  type AgentRouteDestination,
  type AgentSourceConfig,
  type AgentSourceKey,
  type AgentUserPrefs,
  createAgentOutputRepository,
} from "../db/repositories/agent-outputs";
import type { createSettingsRepository } from "../db/repositories/settings";
import type { createUserRepository } from "../db/repositories/users";
import type { DB, UsersTable } from "../db/schema";
import type { IntegrationProvider } from "../integrations/types";
import type { Logger } from "../logger";
import type { QueueManager } from "../queue";
import type { SlackBot } from "../slack/bot";
import type { WhatsAppBot } from "../whatsapp/bot";
import { CONVERSATION_SUMMARY_AGENT_KEY } from "./definitions/conversation-summary";
import type { AgentOutputDeliveryPublisher } from "./output-delivery";
import { getAgentDefinition, listAgentDefinitions, requireAgentDefinition } from "./registry";
import type { AgentApiItem, AgentDefinition, AgentSourceConfigDef } from "./types";

const RUNNING_STALE_AFTER_MS = 30 * 60 * 1000;
const SCHEDULED_FAILURE_SUPPRESS_AFTER_MS = 60 * 60 * 1000;

type UserRow = Selectable<UsersTable>;

export type AgentGenerationScope =
  | { kind: "combined"; sourceKey: string; sourceLabel: string | null }
  | { kind: "source"; source: AgentSourceConfig; sourceKey: string; sourceLabel: string | null };

export type ResolvedRoute = AgentRoute & { resolvedSources: AgentSourceConfig[] };

type AgentExpectedScope = AgentGenerationScope & { sources: AgentSourceConfig[]; route?: ResolvedRoute };

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
  getSlack?: () => Pick<SlackBot, "isUserInChannel" | "listChannels"> | null;
  getWhatsApp?: () =>
    | (Pick<WhatsAppBot, "getGroupMetadata"> & {
        resolveJidToPhone?: (jid: string) => Promise<string | null>;
      })
    | null;
}

export interface RequestAgentGenerationParams {
  agentKey: string;
  userId: string;
  outputDate?: string;
  triggerType: AgentOutputTriggerType;
  skipIfCompleted?: boolean;
  scopeKeys?: string[];
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
  deliveryModel: AgentDeliveryModel;
  sources: AgentSourceConfig[];
  routes: ResolvedRoute[];
  configuredRoutes: AgentRoute[];
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
  deliveryModel: AgentDeliveryModel;
  sourceConfig: AgentSourceConfigDef | null;
  sources: AgentSourceConfig[];
  routes: AgentRoute[];
  sections: AgentSectionView[];
}

export interface AgentRouteMember {
  userId: string;
  name: string;
  slackUserId: string;
}

export interface AgentOutputApi {
  id: string;
  agentKey: string;
  userId: string;
  outputDate: string;
  timezone: string;
  status: string;
  sourceKey: string;
  sourceLabel: string | null;
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
  sourceConfig: AgentSourceConfigDef | null;
  sources: AgentSourceConfig[];
  routes: AgentRoute[];
}

export class AgentDeliveryTargetError extends Error {}
export class AgentSourceTargetError extends Error {}

export function sourceKeyForTarget(
  target: Pick<AgentSourceConfig, "platform" | "targetType" | "targetId">,
): AgentSourceKey {
  return `${target.platform}:${target.targetType}:${target.targetId}`;
}

function deliveryKeyForTarget(target: Pick<AgentDeliveryConfig, "platform" | "targetType" | "targetId">): string {
  return `${target.platform}:${target.targetType}:${target.targetId}`;
}

function isDmDelivery(delivery: AgentDeliveryConfig): boolean {
  return delivery.targetType === "dm";
}

function sourceAsDelivery(source: AgentSourceConfig): AgentDeliveryConfig {
  return {
    enabled: true,
    platform: source.platform,
    targetType: source.targetType,
    targetId: source.targetId,
    label: source.label,
  };
}

function stableRouteHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
}

function canonicalRouteSources(sources: readonly AgentSourceKey[]): AgentSourceKey[] {
  return [...sources].sort();
}

function routeScopeKeyForSources(sources: readonly AgentSourceKey[]): string {
  if (sources.length === 1) return sources[0];
  return `route:${stableRouteHash(canonicalRouteSources(sources))}`;
}

function routeIdForSources(sources: readonly AgentSourceKey[]): string {
  return routeScopeKeyForSources(sources);
}

export function scopeKeyForRoute(route: Pick<AgentRoute, "sources">, resolvedSources: AgentSourceConfig[]): string {
  if (route.sources.length === 1) return sourceKeyForTarget(resolvedSources[0] ?? parseSourceKey(route.sources[0]));
  return routeScopeKeyForSources(route.sources);
}

export function labelForRoute(route: Pick<AgentRoute, "sources">, resolvedSources: AgentSourceConfig[]): string | null {
  if (resolvedSources.length === 0) return null;
  const first = resolvedSources[0].label ?? resolvedSources[0].targetId;
  return route.sources.length === 1 ? first : `${first} +${route.sources.length - 1}`;
}

function parseSourceKey(sourceKey: AgentSourceKey): AgentSourceConfig {
  const [platform, targetType, ...targetParts] = sourceKey.split(":");
  return {
    platform: platform as AgentSourceConfig["platform"],
    targetType: targetType as AgentSourceConfig["targetType"],
    targetId: targetParts.join(":"),
    label: null,
  };
}

function routeFromDefault(defaultRoute: "self" | "off"): AgentPerSourceDelivery {
  return defaultRoute === "self" ? { kind: "self" } : { kind: "off" };
}

function normalizePerSourceDelivery(value: unknown, defaultRoute: "self" | "off"): AgentPerSourceDelivery {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const kind = (value as Record<string, unknown>).kind;
    if (kind === "self" || kind === "off") return { kind };
  }
  return routeFromDefault(defaultRoute);
}

function looksLikeDeliveryConfig(value: unknown): value is AgentDeliveryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    raw.enabled === true &&
    (raw.platform === "slack" || raw.platform === "whatsapp") &&
    (raw.targetType === "channel" || raw.targetType === "dm" || raw.targetType === "group") &&
    typeof raw.targetId === "string" &&
    raw.targetId.length > 0
  );
}

function normalizeDeliveryModelFromValue(value: unknown, sources: AgentSourceConfig[]): AgentDeliveryModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.mode === "combined" && looksLikeDeliveryConfig(raw.combined)) {
    const combined = raw.combined as AgentCombinedDeliveryConfig;
    return {
      mode: "combined",
      combined: {
        ...combined,
        ...(combined.ackNonDm === true ? { ackNonDm: true as const } : {}),
      },
    };
  }

  if (raw.mode !== "per_source") return null;
  const defaultRoute = raw.defaultRoute === "self" ? "self" : "off";
  const rawPerSource =
    raw.perSource && typeof raw.perSource === "object" && !Array.isArray(raw.perSource)
      ? (raw.perSource as Record<string, unknown>)
      : {};
  const perSource: Record<string, AgentPerSourceDelivery> = {};
  for (const source of sources) {
    const key = sourceKeyForTarget(source);
    perSource[key] = normalizePerSourceDelivery(rawPerSource[key], defaultRoute);
  }
  return { mode: "per_source", defaultRoute, perSource, combined: null };
}

function normalizeLegacyDeliveryModel(
  delivery: AgentDeliveryConfig | null | undefined,
  sources: AgentSourceConfig[],
): AgentDeliveryModel {
  const offModel = (): AgentDeliveryModel => ({
    mode: "per_source",
    defaultRoute: "off",
    perSource: Object.fromEntries(sources.map((source) => [sourceKeyForTarget(source), { kind: "off" as const }])),
    combined: null,
  });
  if (!delivery) return offModel();

  const matchingSource = sources.find((source) => sourceKeyForTarget(source) === deliveryKeyForTarget(delivery));
  if (matchingSource) {
    return {
      mode: "per_source",
      defaultRoute: "off",
      perSource: Object.fromEntries(
        sources.map((source) => [
          sourceKeyForTarget(source),
          { kind: sourceKeyForTarget(source) === sourceKeyForTarget(matchingSource) ? "self" : "off" },
        ]),
      ) as Record<string, AgentPerSourceDelivery>,
      combined: null,
    };
  }

  return {
    mode: "combined",
    combined: {
      ...delivery,
      ...(!isDmDelivery(delivery) ? { ackNonDm: true as const } : {}),
    },
  };
}

function reconcileDeliveryModel(model: AgentDeliveryModel, sources: AgentSourceConfig[]): AgentDeliveryModel {
  if (model.mode === "combined") return model;
  const perSource: Record<string, AgentPerSourceDelivery> = {};
  for (const source of sources) {
    const key = sourceKeyForTarget(source);
    perSource[key] = normalizePerSourceDelivery(model.perSource[key], model.defaultRoute);
  }
  return { ...model, perSource, combined: null };
}

function projectLegacyDelivery(model: AgentDeliveryModel, sources: AgentSourceConfig[]): AgentDeliveryConfig | null {
  if (model.mode === "combined") {
    const { ackNonDm: _ackNonDm, ...delivery } = model.combined;
    return delivery;
  }

  const selfSources = sources.filter((source) => model.perSource[sourceKeyForTarget(source)]?.kind === "self");
  return selfSources.length === 1 ? sourceAsDelivery(selfSources[0]) : null;
}

function normalizeRouteDestination(value: unknown): AgentRouteDestination | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "self" || raw.kind === "off") return { kind: raw.kind };
  if (raw.kind !== "member" || raw.platform !== "slack") return null;
  const memberUserId = typeof raw.memberUserId === "string" ? raw.memberUserId.trim() : "";
  return memberUserId ? { kind: "member", platform: "slack", memberUserId } : null;
}

function normalizeRouteSchedule(value: unknown): AgentRoute["schedule"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return Number.isInteger(raw.hour) &&
    Number.isInteger(raw.minute) &&
    Number(raw.hour) >= 0 &&
    Number(raw.hour) <= 23 &&
    Number(raw.minute) >= 0 &&
    Number(raw.minute) <= 59
    ? { hour: Number(raw.hour), minute: Number(raw.minute) }
    : null;
}

function normalizeRouteSections(value: unknown): Record<string, boolean> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, enabled]) => [key, Boolean(enabled)]),
  );
}

function normalizeRouteSources(value: unknown): AgentSourceKey[] {
  if (!Array.isArray(value)) return [];
  const result: AgentSourceKey[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const source = parseSourceKey(entry as AgentSourceKey);
    if (
      (source.platform !== "slack" && source.platform !== "whatsapp") ||
      (source.targetType !== "channel" && source.targetType !== "group") ||
      !source.targetId
    ) {
      continue;
    }
    const key = sourceKeyForTarget(source);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function normalizeRoutesFromValue(value: unknown): AgentRoute[] | null {
  if (!Array.isArray(value)) return null;
  const routes: AgentRoute[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const sources = normalizeRouteSources(raw.sources);
    if (sources.length === 0) continue;
    const destination = normalizeRouteDestination(raw.destination) ?? { kind: "off" as const };
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : routeIdForSources(sources);
    if (seen.has(id)) continue;
    seen.add(id);
    routes.push({
      id,
      sources,
      focus: typeof raw.focus === "string" && raw.focus.trim() ? raw.focus.trim() : null,
      sections: normalizeRouteSections(raw.sections),
      maxItemsPerSection:
        Number.isInteger(raw.maxItemsPerSection) && Number(raw.maxItemsPerSection) > 0
          ? Number(raw.maxItemsPerSection)
          : null,
      schedule: normalizeRouteSchedule(raw.schedule),
      destination,
      enabled: raw.enabled !== false,
    });
  }
  return routes;
}

function synthesizeRoutesFromDeliveryModel(
  deliveryModel: AgentDeliveryModel,
  sources: AgentSourceConfig[],
  prefs: AgentUserPrefs,
  maxItemsPerSection: number,
): AgentRoute[] {
  const content = {
    focus: prefs.focus?.trim() ? prefs.focus.trim() : null,
    sections: prefs.sections ?? null,
    maxItemsPerSection,
    schedule: null,
    enabled: true,
  };

  if (deliveryModel.mode === "combined") {
    const routeSources = sources.map(sourceKeyForTarget);
    if (routeSources.length === 0) return [];
    return [
      {
        id: routeIdForSources(routeSources),
        sources: routeSources,
        ...content,
        destination: { kind: "off" },
      },
    ];
  }

  return sources.map((source) => {
    const sourceKey = sourceKeyForTarget(source);
    const delivery = normalizePerSourceDelivery(deliveryModel.perSource[sourceKey], deliveryModel.defaultRoute);
    return {
      id: sourceKey,
      sources: [sourceKey],
      ...content,
      destination: delivery.kind === "self" ? { kind: "self" } : { kind: "off" },
    };
  });
}

function enabledSectionsForRoute(def: AgentDefinition, route: AgentRoute | undefined): Record<string, boolean> {
  const sections: Record<string, boolean> = {};
  for (const section of def.sections) {
    sections[section.key] = route?.sections?.[section.key] ?? section.enabledByDefault;
  }
  return sections;
}

function enabledSectionsForScope(
  def: AgentDefinition,
  config: Pick<ResolvedAgentConfig, "enabledSections">,
  route: AgentRoute | undefined,
): Record<string, boolean> {
  return route ? enabledSectionsForRoute(def, route) : config.enabledSections;
}

function maxItemsPerSectionForRoute(def: AgentDefinition, route: AgentRoute | undefined): number {
  return route?.maxItemsPerSection ?? def.defaults.maxItemsPerSection;
}

function maxItemsPerSectionForScope(
  def: AgentDefinition,
  config: Pick<ResolvedAgentConfig, "maxItemsPerSection">,
  route: AgentRoute | undefined,
): number {
  return route ? maxItemsPerSectionForRoute(def, route) : config.maxItemsPerSection;
}

function whatsappNumberToJid(whatsappNumber: string): string {
  return `${normalizeWhatsappNumber(whatsappNumber)}@s.whatsapp.net`;
}

function normalizeWhatsappNumber(whatsappNumber: string): string {
  return whatsappNumber.replace(/^\+/, "");
}

function normalizeWhatsappMentionTarget(targetId: string): string {
  if (targetId.startsWith("dm:+")) return targetId.slice("dm:".length);
  if (targetId.startsWith("+")) return targetId;
  if (targetId.endsWith("@s.whatsapp.net")) {
    return `+${normalizeWhatsappNumber(targetId.replace("@s.whatsapp.net", ""))}`;
  }
  if (/^\d+$/.test(targetId)) return `+${targetId}`;
  return targetId;
}

async function whatsappGroupHasParticipant(
  group: Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>>,
  whatsappNumber: string,
  resolveJidToPhone?: (jid: string) => Promise<string | null>,
): Promise<boolean> {
  const userJid = whatsappNumberToJid(whatsappNumber);
  const userNumber = normalizeWhatsappNumber(whatsappNumber);

  for (const participant of group?.participants ?? []) {
    if (areJidsSameUser(participant.id, userJid)) return true;

    const participantPhone = await resolveJidToPhone?.(participant.id);
    if (participantPhone && normalizeWhatsappNumber(participantPhone) === userNumber) return true;
  }

  return false;
}

function withMentions(mentions: AgentDeliveryMention[]): Pick<AgentDeliveryConfig, "mentions"> {
  return mentions.length > 0 ? { mentions } : {};
}

function isSummaryWindow(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).start === "string" &&
    typeof (value as Record<string, unknown>).end === "string"
  );
}

function rawPayloadWithRunMetadata(
  rawPayload: WriteAgentOutputPayload,
  runtimeContext: Record<string, unknown>,
): WriteAgentOutputPayload | (WriteAgentOutputPayload & { summaryWindow: Record<string, unknown> }) {
  const summaryWindow = runtimeContext.summaryWindow;
  return isSummaryWindow(summaryWindow) ? { ...rawPayload, summaryWindow } : rawPayload;
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
        sourceConfig: def.sourceConfig ?? null,
        sources: config.sources,
        routes: config.configuredRoutes,
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
      deliveryModel: config.deliveryModel,
      sourceConfig: def.sourceConfig ?? null,
      sources: config.sources,
      routes: config.configuredRoutes,
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
      deliveryModel?: AgentDeliveryModel;
      sources?: AgentSourceConfig[];
      routes?: AgentRoute[];
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
      prefs = {
        sections,
        focus,
        delivery: projectLegacyDelivery(deliveryModel, sources),
        deliveryModel,
        sources,
        routes,
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

  private resolveDeliveryModelForUser(
    sources: AgentSourceConfig[],
    deliveryModel: AgentDeliveryModel,
  ): AgentDeliveryModel {
    const reconciled = reconcileDeliveryModel(deliveryModel, sources);
    if (reconciled.mode === "per_source") return reconciled;

    const deliveryKey = deliveryKeyForTarget(reconciled.combined);
    if (sources.some((source) => sourceKeyForTarget(source) === deliveryKey)) {
      throw new AgentDeliveryTargetError("Combined delivery cannot target one of the selected sources");
    }
    if (!isDmDelivery(reconciled.combined) && reconciled.combined.ackNonDm !== true) {
      throw new AgentDeliveryTargetError("Non-DM combined delivery requires acknowledgement");
    }

    return reconciled;
  }

  private resolveRoutesForUser(def: AgentDefinition, sources: AgentSourceConfig[], routes: AgentRoute[]): AgentRoute[] {
    const sourceKeys = new Set(sources.map(sourceKeyForTarget));
    const sectionKeys = new Set(def.sections.map((section) => section.key));
    const range = def.itemsPerSectionRange;
    const seenScopeKeys = new Set<string>();

    return routes.map((route) => {
      const sources = [...new Set(route.sources)];
      if (sources.length === 0) {
        throw new AgentSourceTargetError("Route must include at least one source");
      }
      if (sources.length > 1 && route.destination.kind === "self") {
        throw new AgentDeliveryTargetError("Combined routes cannot use self destination");
      }
      let destination = route.destination;
      if (route.destination.kind === "member") {
        const raw = route.destination as Record<string, unknown>;
        const memberUserId = typeof raw.memberUserId === "string" ? raw.memberUserId.trim() : "";
        if (raw.platform !== "slack" || !memberUserId) {
          throw new AgentDeliveryTargetError("Member route destination must include a Slack member");
        }
        destination = { kind: "member", platform: "slack", memberUserId };
      }
      for (const sourceKey of sources) {
        if (!sourceKeys.has(sourceKey)) {
          throw new AgentSourceTargetError("Route source must be one of the selected sources");
        }
      }
      for (const sectionKey of Object.keys(route.sections ?? {})) {
        if (!sectionKeys.has(sectionKey)) throw new AgentSourceTargetError(`Unknown route section: ${sectionKey}`);
      }
      if (
        route.schedule &&
        (!Number.isInteger(route.schedule.hour) ||
          route.schedule.hour < 0 ||
          route.schedule.hour > 23 ||
          !Number.isInteger(route.schedule.minute) ||
          route.schedule.minute < 0 ||
          route.schedule.minute > 59)
      ) {
        throw new AgentSourceTargetError("Route schedule must be a valid hour and minute");
      }
      const scopeKey = routeScopeKeyForSources(sources);
      if (seenScopeKeys.has(scopeKey)) {
        throw new AgentSourceTargetError("Routes must not duplicate the same output scope");
      }
      seenScopeKeys.add(scopeKey);

      return {
        ...route,
        id: route.id.trim() || routeIdForSources(sources),
        sources,
        focus: route.focus?.trim() ? route.focus.trim() : null,
        sections: route.sections ? { ...route.sections } : null,
        maxItemsPerSection:
          route.maxItemsPerSection === null ? null : Math.min(range.max, Math.max(range.min, route.maxItemsPerSection)),
        destination,
        enabled: route.enabled !== false,
      };
    });
  }

  async resolveDeliveryConfigForUser(
    userId: string,
    delivery: AgentDeliveryConfig | null,
  ): Promise<AgentDeliveryConfig | null> {
    if (!delivery) return null;

    const user = await this.deps.users.findById(userId);
    if (!user) throw new AgentDeliveryTargetError("User not found");

    if (delivery.platform === "slack") {
      if (!user.slack_user_id) {
        throw new AgentDeliveryTargetError("Slack delivery is not available for this user");
      }

      const slack = this.deps.getSlack?.() ?? null;
      if (!slack) throw new AgentDeliveryTargetError("Slack is not connected");

      if (delivery.targetType === "dm") {
        if (delivery.targetId !== user.slack_user_id) {
          throw new AgentDeliveryTargetError("Slack DM delivery must target the current user");
        }
        const normalized = {
          ...delivery,
          targetId: user.slack_user_id,
          label: user.email ? `${user.name} <${user.email}>` : user.name,
        };
        return {
          ...normalized,
          ...withMentions(await this.resolveDeliveryMentions(normalized)),
        };
      }

      const channel = (await slack.listChannels()).find((candidate) => candidate.id === delivery.targetId);
      if (!channel?.isMember) {
        throw new AgentDeliveryTargetError("Slack channel is not available for delivery");
      }
      if (!(await slack.isUserInChannel(delivery.targetId, user.slack_user_id))) {
        throw new AgentDeliveryTargetError("Slack channel is not available for this user");
      }
      const normalized = {
        ...delivery,
        targetId: channel.id,
        label: `#${channel.name}`,
      };
      return {
        ...normalized,
        ...withMentions(await this.resolveDeliveryMentions(normalized)),
      };
    }

    const group = await this.deps.db
      .selectFrom("whatsapp_groups")
      .select(["jid", "name"])
      .where("jid", "=", delivery.targetId)
      .executeTakeFirst();
    if (!group) throw new AgentDeliveryTargetError("WhatsApp group is not available for delivery");
    if (!user.whatsapp_number) {
      throw new AgentDeliveryTargetError("WhatsApp group delivery is not available for this user");
    }

    const whatsapp = this.deps.getWhatsApp?.() ?? null;
    if (!whatsapp) throw new AgentDeliveryTargetError("WhatsApp is not connected");
    const groupMetadata = await whatsapp.getGroupMetadata(group.jid);
    if (
      !(await whatsappGroupHasParticipant(
        groupMetadata,
        user.whatsapp_number,
        async (jid) => (await whatsapp.resolveJidToPhone?.(jid)) ?? null,
      ))
    ) {
      throw new AgentDeliveryTargetError("WhatsApp group is not available for this user");
    }

    const normalized = {
      ...delivery,
      targetId: group.jid,
      label: group.name,
    };
    return {
      ...normalized,
      ...withMentions(await this.resolveDeliveryMentions(normalized, { whatsappGroup: groupMetadata })),
    };
  }

  async listEligibleRouteMembers(userId: string, sourceKeys: string[]): Promise<AgentRouteMember[]> {
    const sources = [...new Set(sourceKeys)].map((sourceKey) => parseSourceKey(sourceKey as AgentSourceKey));
    if (sources.length === 0 || sources.some((source) => source.platform !== "slack")) return [];
    const slack = this.deps.getSlack?.() ?? null;
    if (!slack) return [];
    const requester = await this.deps.users.findById(userId);
    if (!requester?.slack_user_id) return [];
    for (const source of sources) {
      if (source.targetType !== "channel" || !(await slack.isUserInChannel(source.targetId, requester.slack_user_id))) {
        return [];
      }
    }

    const members: AgentRouteMember[] = [];
    for (const user of await this.deps.users.list()) {
      if (!user.slack_user_id) continue;
      let eligible = true;
      for (const source of sources) {
        if (source.targetType !== "channel" || !(await slack.isUserInChannel(source.targetId, user.slack_user_id))) {
          eligible = false;
          break;
        }
      }
      if (eligible) members.push({ userId: user.id, name: user.name, slackUserId: user.slack_user_id });
    }

    return members;
  }

  private async resolveDeliveryMentions(
    delivery: AgentDeliveryConfig,
    context: { whatsappGroup?: Awaited<ReturnType<WhatsAppBot["getGroupMetadata"]>> } = {},
  ): Promise<AgentDeliveryMention[]> {
    const mentions = delivery.mentions ?? [];
    if (mentions.length === 0) return [];

    const resolved: AgentDeliveryMention[] = [];
    const seen = new Set<string>();

    for (const mention of mentions) {
      if (mention.platform !== delivery.platform) {
        throw new AgentDeliveryTargetError("Delivery mention platform must match the delivery platform");
      }

      if (mention.platform === "slack") {
        const user = await this.deps.users.findBySlackId(mention.targetId);
        if (!user || user.type === "agent" || !user.slack_user_id) {
          throw new AgentDeliveryTargetError("Slack mention target is not available");
        }
        if (delivery.targetType === "channel") {
          const slack = this.deps.getSlack?.() ?? null;
          if (!slack) throw new AgentDeliveryTargetError("Slack is not connected");
          if (!(await slack.isUserInChannel(delivery.targetId, user.slack_user_id))) {
            throw new AgentDeliveryTargetError("Slack mention target is not in the delivery channel");
          }
        }
        const key = `${mention.platform}:${user.slack_user_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({
          platform: "slack",
          targetId: user.slack_user_id,
          label: user.email ? `${user.name} <${user.email}>` : user.name,
        });
        continue;
      }

      const whatsappNumber = normalizeWhatsappMentionTarget(mention.targetId);
      const user = await this.deps.users.findByWhatsappNumber(whatsappNumber);
      if (!user || user.type === "agent" || !user.whatsapp_number) {
        throw new AgentDeliveryTargetError("WhatsApp mention target is not available");
      }
      if (delivery.targetType === "group") {
        const whatsapp = this.deps.getWhatsApp?.() ?? null;
        if (!whatsapp) throw new AgentDeliveryTargetError("WhatsApp is not connected");
        const group = context.whatsappGroup ?? (await whatsapp.getGroupMetadata(delivery.targetId));
        if (
          !(await whatsappGroupHasParticipant(
            group,
            user.whatsapp_number,
            async (jid) => (await whatsapp.resolveJidToPhone?.(jid)) ?? null,
          ))
        ) {
          throw new AgentDeliveryTargetError("WhatsApp mention target is not in the delivery group");
        }
      }
      const key = `${mention.platform}:${user.whatsapp_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ platform: "whatsapp", targetId: user.whatsapp_number, label: user.name });
    }

    return resolved;
  }

  async resolveSourceConfigsForUser(
    agentKeyOrDef: string | AgentDefinition,
    userId: string,
    sources: AgentSourceConfig[],
  ): Promise<AgentSourceConfig[]> {
    const def = typeof agentKeyOrDef === "string" ? getAgentDefinition(agentKeyOrDef) : agentKeyOrDef;
    if (!def?.sourceConfig) {
      if (sources.length > 0) throw new AgentSourceTargetError("This agent does not support conversation sources");
      return [];
    }
    if (sources.length > def.sourceConfig.maxSources) {
      throw new AgentSourceTargetError(`Select at most ${def.sourceConfig.maxSources} sources`);
    }

    const resolved: AgentSourceConfig[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      const normalized = await this.resolveSourceConfigForUser(userId, source, def.sourceConfig);
      const key = `${normalized.platform}:${normalized.targetType}:${normalized.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(normalized);
    }
    return resolved;
  }

  private async resolveSourceConfigForUser(
    userId: string,
    source: AgentSourceConfig,
    config: AgentSourceConfigDef,
  ): Promise<AgentSourceConfig> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw new AgentSourceTargetError("User not found");

    if (source.platform === "slack") {
      if (!config.supportsSlackChannels || source.targetType !== "channel") {
        throw new AgentSourceTargetError("Slack sources must be channels");
      }
      if (!user.slack_user_id) throw new AgentSourceTargetError("Slack sources are not available for this user");
      const slack = this.deps.getSlack?.() ?? null;
      if (!slack) throw new AgentSourceTargetError("Slack is not connected");
      const channel = (await slack.listChannels()).find((candidate) => candidate.id === source.targetId);
      if (!channel?.isMember) throw new AgentSourceTargetError("Slack channel is not available as a source");
      if (!(await slack.isUserInChannel(source.targetId, user.slack_user_id))) {
        throw new AgentSourceTargetError("Slack channel is not available for this user");
      }
      return {
        platform: "slack",
        targetType: "channel",
        targetId: channel.id,
        label: `#${channel.name}`,
      };
    }

    if (!config.supportsWhatsAppGroups || source.targetType !== "group") {
      throw new AgentSourceTargetError("WhatsApp sources must be groups");
    }
    const group = await this.deps.db
      .selectFrom("whatsapp_groups")
      .select(["jid", "name"])
      .where("jid", "=", source.targetId)
      .executeTakeFirst();
    if (!group) throw new AgentSourceTargetError("WhatsApp group is not available as a source");
    if (!user.whatsapp_number) throw new AgentSourceTargetError("WhatsApp sources are not available for this user");
    const whatsapp = this.deps.getWhatsApp?.() ?? null;
    if (!whatsapp) throw new AgentSourceTargetError("WhatsApp is not connected");
    const groupMetadata = await whatsapp.getGroupMetadata(group.jid);
    if (
      !(await whatsappGroupHasParticipant(
        groupMetadata,
        user.whatsapp_number,
        async (jid) => (await whatsapp.resolveJidToPhone?.(jid)) ?? null,
      ))
    ) {
      throw new AgentSourceTargetError("WhatsApp group is not available for this user");
    }
    return {
      platform: "whatsapp",
      targetType: "group",
      targetId: group.jid,
      label: group.name,
    };
  }

  private async resolveSourcesForRun(
    def: AgentDefinition,
    userId: string,
    sources: AgentSourceConfig[],
  ): Promise<AgentSourceConfig[]> {
    if (!def.sourceConfig) return [];

    const resolved: AgentSourceConfig[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      try {
        const normalized = await this.resolveSourceConfigForUser(userId, source, def.sourceConfig);
        const key = `${normalized.platform}:${normalized.targetType}:${normalized.targetId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push(normalized);
      } catch (err) {
        this.deps.logger.warn(
          { err, agentKey: def.key, userId, platform: source.platform, targetType: source.targetType },
          "Agent: dropping inaccessible source for generation",
        );
      }
    }

    return resolved;
  }

  private async resolveRoutesForRun(
    def: AgentDefinition,
    userId: string,
    routes: AgentRoute[],
    sources: AgentSourceConfig[],
  ): Promise<ResolvedRoute[]> {
    if (!def.sourceConfig) return routes.map((route) => ({ ...route, resolvedSources: [] }));
    const resolvedSources = await this.resolveSourcesForRun(def, userId, sources);
    const byKey = new Map(resolvedSources.map((source) => [sourceKeyForTarget(source), source]));
    const resolvedRoutes: ResolvedRoute[] = [];

    for (const route of routes) {
      const routeSources = route.sources
        .map((sourceKey) => byKey.get(sourceKey))
        .filter((source) => source !== undefined);
      if (routeSources.length !== route.sources.length) continue;
      resolvedRoutes.push({ ...route, resolvedSources: routeSources });
    }

    return resolvedRoutes;
  }

  private toApiOutput(
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

  async getByIdForUser(agentKey: string, id: string, userId: string): Promise<AgentOutputApi | null> {
    const def = requireAgentDefinition(agentKey);
    return this.toApiOutput(def, await this.repo.getByIdForUser(def.key, id, userId));
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

  async requestGenerationForUser(params: RequestAgentGenerationParams): Promise<AgentOutputRow[]> {
    const def = requireAgentDefinition(params.agentKey);
    const user = await this.deps.users.findById(params.userId);
    if (!user) throw new Error("User not found");
    const config = await this.resolveConfig(def, user.id);
    const timezone = config.timezone || user.timezone || "UTC";
    const outputDate = params.outputDate || localDateInTimezone(new Date(), timezone);
    const now = new Date();
    const scopes = await this.resolveExpectedScopesForUser(def, user, config);
    const scopeKeys = params.scopeKeys ? new Set(params.scopeKeys) : null;
    const rows: AgentOutputRow[] = [];

    for (const scope of scopeKeys ? scopes.filter((candidate) => scopeKeys.has(candidate.sourceKey)) : scopes) {
      let recoveredStaleRunning = false;
      const existingRunning = await this.repo.findRunning(def.key, user.id, outputDate, scope.sourceKey);
      if (existingRunning) {
        if (!this.isRunningStale(existingRunning, now)) {
          rows.push(existingRunning);
          continue;
        }
        recoveredStaleRunning = true;
        await this.repo.markFailed(existingRunning.id, "Generation expired after being left running.");
      }
      if (
        params.skipIfCompleted &&
        (await this.repo.findLatestCompletedForScope(def.key, user.id, scope.sourceKey, outputDate))
      ) {
        continue;
      }
      if (params.skipIfCompleted && params.triggerType === "scheduled" && !recoveredStaleRunning) {
        const latest = await this.repo.findLatestAny(def.key, user.id, outputDate, scope.sourceKey);
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
        sourceKey: scope.sourceKey,
        sourceLabel: scope.sourceLabel,
        timezone,
        triggerType: params.triggerType,
      });
      if (result.created) this.enqueueRun(def.key, result.row.id, user.id);
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
  ): Promise<{ outputDate: string; scopeKeys: string[] } | null> {
    const config = await this.resolveConfig(def, user.id);
    if (def.sourceConfig && config.routes.length === 0) return null;
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
    const outputDate = localDateInTimezone(now, timezone);
    const scopes = await this.resolveExpectedScopesForUser(def, user, config);
    if (scopes.length === 0) return null;
    const dueScopeKeys: string[] = [];

    for (const scope of scopes) {
      const schedule = scope.route?.schedule ?? { hour: config.scheduleHour, minute: config.scheduleMinute };
      if (hour !== schedule.hour || minute < schedule.minute) continue;
      const [running, completed] = await Promise.all([
        this.repo.findRunning(def.key, user.id, outputDate, scope.sourceKey),
        this.repo.findLatestCompletedForScope(def.key, user.id, scope.sourceKey, outputDate),
      ]);
      if (completed) continue;
      if (running && !this.isRunningStale(running, now)) continue;
      const latest = await this.repo.findLatestAny(def.key, user.id, outputDate, scope.sourceKey);
      if (latest && this.isRecentScheduledFailure(latest, now)) continue;
      dueScopeKeys.push(scope.sourceKey);
    }

    return dueScopeKeys.length > 0 ? { outputDate, scopeKeys: dueScopeKeys } : null;
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

  private async resolveScopeForOutput(
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

  private async getPreviousOutputForContext(
    def: AgentDefinition,
    user: UserRow,
    outputDate: string,
    scope: AgentGenerationScope,
  ): Promise<AgentOutputApi | null> {
    if (def.key === CONVERSATION_SUMMARY_AGENT_KEY && scope.kind === "source") return null;
    return this.toApiOutput(
      def,
      await this.repo.findLatestCompletedForScope(def.key, user.id, scope.sourceKey, outputDate),
    );
  }

  private async generateExistingOutput(agentKey: string, outputId: string, userId: string): Promise<void> {
    const def = requireAgentDefinition(agentKey);
    const output = await this.repo.findById(def.key, outputId);
    const user = await this.deps.users.findById(userId);
    if (!output || !user) return;

    let saved = false;
    const config = await this.resolveConfig(def, user.id);
    const scope = await this.resolveScopeForOutput(def, user, config, output);
    if (!scope) {
      await this.repo.markFailed(outputId, "Generation route was removed.");
      return;
    }
    const routeSections = enabledSectionsForScope(def, config, scope.route);
    const routeMaxItemsPerSection = maxItemsPerSectionForScope(def, config, scope.route);
    const routeFocus = scope.route ? scope.route.focus : config.focus;
    const enabledSections = def.sections.filter((s) => routeSections[s.key]).map((s) => s.key);

    try {
      const now = new Date();
      const settings = await this.deps.settings.get();
      const adminCanReadAllFiles = settings?.admin_can_read_all_files === 1;
      const contentUserEmails =
        user.auth_role === "admin" && adminCanReadAllFiles
          ? undefined
          : await this.deps.users.getAllEmailsForUser(user.id);
      const [sameDayPrevious, previousDay, definitionContext] = await Promise.all([
        this.getPreviousOutputForContext(def, user, output.output_date, scope),
        this.getPreviousOutputForContext(def, user, addDays(output.output_date, -1), scope),
        def.buildRuntimeContext
          ? def.buildRuntimeContext({
              db: this.deps.db,
              user,
              outputDate: output.output_date,
              timezone: output.timezone,
              now,
              adminCanReadAllFiles,
              contentUserEmails,
              agentConfig: {
                enabledSections: routeSections,
                maxItemsPerSection: routeMaxItemsPerSection,
                focus: routeFocus,
                delivery: config.delivery,
                sources: scope.sources,
                sourceKey: scope.sourceKey,
              },
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
        maxItemsPerSection: routeMaxItemsPerSection,
        focus: routeFocus,
        sources: scope.sources,
        sameDayPreviousOutput: this.formatOutputForContext(sameDayPrevious),
        previousDayOutput: this.formatOutputForContext(previousDay),
        ...definitionContext,
      };
      const writer = this.createWriter(def, {
        outputId,
        enabledSections: new Set(enabledSections),
        expectedOutputDate: output.output_date,
        expectedTimezone: output.timezone,
        runtimeContext,
        onSaved: () => {
          saved = true;
        },
      });
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
        await this.deliverCompletedOutput(def, outputId, user.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed(outputId, message);
      this.deps.logger.error({ err, agentKey, outputId, userId }, "Agent: generation failed");
    }
  }

  private async deliverCompletedOutput(def: AgentDefinition, outputId: string, userId: string): Promise<void> {
    if (!this.deps.outputDelivery) return;
    let markFailedOnRouteTargetError = false;
    try {
      const output = await this.repo.findById(def.key, outputId);
      const user = await this.deps.users.findById(userId);
      if (!output || !user) return;
      const config = await this.resolveConfig(def, userId);
      const scope = await this.resolveScopeForOutput(def, user, config, output);
      if (!scope) return;
      let delivery: AgentDeliveryConfig | null;
      if (scope.route) {
        markFailedOnRouteTargetError = true;
        delivery = await this.deliveryForRoute(userId, scope.route, scope.sources);
      } else {
        delivery = await this.resolveDeliveryConfigForUser(userId, config.delivery);
      }
      if (!delivery) return;
      const completed = await this.getByIdForUser(def.key, outputId, userId);
      if (!completed) return;
      await this.deps.outputDelivery.deliver({ definition: def, output: completed, delivery });
    } catch (err) {
      if (markFailedOnRouteTargetError && err instanceof AgentDeliveryTargetError) {
        await this.repo.markDeliveryFailed(outputId, err.message);
      }
      this.deps.logger.warn({ err, agentKey: def.key, outputId, userId }, "Agent: output delivery failed");
    }
  }

  private async deliveryForRoute(
    userId: string,
    route: AgentRoute,
    resolvedSources: AgentSourceConfig[],
  ): Promise<AgentDeliveryConfig | null> {
    if (route.destination.kind === "off") return null;
    if (route.destination.kind === "member") {
      return this.resolveMemberRouteDelivery(route.destination, resolvedSources);
    }
    if (resolvedSources.length !== 1) {
      throw new AgentDeliveryTargetError("Combined routes cannot use self destination");
    }
    return this.resolveDeliveryConfigForUser(userId, sourceAsDelivery(resolvedSources[0]));
  }

  private async resolveMemberRouteDelivery(
    destination: Extract<AgentRouteDestination, { kind: "member" }>,
    resolvedSources: AgentSourceConfig[],
  ): Promise<AgentDeliveryConfig> {
    const member = await this.deps.users.findById(destination.memberUserId);
    if (!member?.slack_user_id) {
      throw new AgentDeliveryTargetError("Recipient is not available for Slack delivery");
    }

    const slack = this.deps.getSlack?.() ?? null;
    if (!slack) throw new AgentDeliveryTargetError("Slack is not connected");

    for (const source of resolvedSources) {
      if (
        source.platform !== "slack" ||
        source.targetType !== "channel" ||
        !(await slack.isUserInChannel(source.targetId, member.slack_user_id))
      ) {
        throw new AgentDeliveryTargetError("Recipient is not a member of every source");
      }
    }

    return {
      enabled: true,
      platform: "slack",
      targetType: "dm",
      targetId: member.slack_user_id,
      label: member.name,
    };
  }

  private createWriter(
    def: AgentDefinition,
    params: {
      outputId: string;
      enabledSections: Set<string>;
      expectedOutputDate: string;
      expectedTimezone: string;
      runtimeContext: Record<string, unknown>;
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
        const reconciled = def.reconcileItems
          ? await def.reconcileItems({ db: this.deps.db, items: filtered, runtimeContext: params.runtimeContext })
          : filtered;
        const items = await def.enrichItems(this.deps.db, reconciled);
        await this.validateItemRefs(def, items);
        await this.repo.completeOutput({
          outputId: params.outputId,
          masthead: payload.masthead,
          rawPayload: rawPayloadWithRunMetadata(payload.rawPayload, params.runtimeContext),
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

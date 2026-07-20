import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  AgentCombinedDeliveryConfig,
  AgentDeliveryConfig,
  AgentDeliveryModel,
  AgentPerSourceDelivery,
  AgentRoute,
  AgentRouteDestination,
  AgentRouteFrequency,
  AgentSourceConfig,
  AgentSourceKey,
  AgentUserConfigWithOwner,
  AgentUserPrefs,
} from "../../db/repositories/agent-outputs";
import type { AgentDefinition } from "../types";
import type { AgentConfigRouteView, AgentRouteOwnerView, ResolvedAgentConfig } from "./contracts";

const ROUTE_FREQUENCIES = new Set<AgentRouteFrequency>(["daily", "weekly", "every_n_hours"]);
const ROUTE_INTERVAL_HOURS = new Set([1, 2, 3, 4, 6, 8, 12]);

export function sourceKeyForTarget(
  target: Pick<AgentSourceConfig, "platform" | "targetType" | "targetId">,
): AgentSourceKey {
  return `${target.platform}:${target.targetType}:${target.targetId}`;
}

export function deliveryKeyForTarget(
  target: Pick<AgentDeliveryConfig, "platform" | "targetType" | "targetId">,
): string {
  return `${target.platform}:${target.targetType}:${target.targetId}`;
}

export function isDmDelivery(delivery: AgentDeliveryConfig): boolean {
  return delivery.targetType === "dm";
}

export function sourceAsDelivery(source: AgentSourceConfig): AgentDeliveryConfig {
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

export function routeScopeKeyForSources(sources: readonly AgentSourceKey[]): string {
  if (sources.length === 1) return sources[0];
  return `route:${stableRouteHash(canonicalRouteSources(sources))}`;
}

export function routeIdForSources(sources: readonly AgentSourceKey[]): string {
  return routeScopeKeyForSources(sources);
}

const ORG_ROUTE_ID_PREFIX = "org:";

function encodeRouteIdSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeRouteIdSegment(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function encodeOrgRouteId(ownerUserId: string, routeId: string): string {
  return `${ORG_ROUTE_ID_PREFIX}${encodeRouteIdSegment(ownerUserId)}:${encodeRouteIdSegment(routeId)}`;
}

export function decodeOrgRouteId(routeId: string): { ownerUserId: string; routeId: string } | null {
  if (!routeId.startsWith(ORG_ROUTE_ID_PREFIX)) return null;
  const [ownerSegment, routeSegment, ...extra] = routeId.slice(ORG_ROUTE_ID_PREFIX.length).split(":");
  if (!ownerSegment || !routeSegment || extra.length > 0) return null;
  const ownerUserId = decodeRouteIdSegment(ownerSegment);
  const decodedRouteId = decodeRouteIdSegment(routeSegment);
  return ownerUserId && decodedRouteId ? { ownerUserId, routeId: decodedRouteId } : null;
}

function routeOwnerView(owner: AgentUserConfigWithOwner): AgentRouteOwnerView {
  return {
    userId: owner.userId,
    name: owner.name,
    email: owner.email,
    authRole: owner.authRole,
  };
}

export function routeWithOwner(route: AgentRoute, owner: AgentUserConfigWithOwner): AgentConfigRouteView {
  return {
    ...route,
    id: encodeOrgRouteId(owner.userId, route.id),
    owner: routeOwnerView(owner),
  };
}

export function stripOrgRouteOwner(route: AgentConfigRouteView): { ownerUserId: string | null; route: AgentRoute } {
  const decoded = decodeOrgRouteId(route.id);
  const { owner: _owner, ...rest } = route;
  return {
    ownerUserId: decoded?.ownerUserId ?? null,
    route: {
      ...rest,
      id: decoded?.routeId ?? route.id,
    },
  };
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

export function parseSourceKey(sourceKey: AgentSourceKey): AgentSourceConfig {
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

export function normalizeDeliveryModelFromValue(
  value: unknown,
  sources: AgentSourceConfig[],
): AgentDeliveryModel | null {
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

export function normalizeLegacyDeliveryModel(
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

export function reconcileDeliveryModel(model: AgentDeliveryModel, sources: AgentSourceConfig[]): AgentDeliveryModel {
  if (model.mode === "combined") return model;
  const perSource: Record<string, AgentPerSourceDelivery> = {};
  for (const source of sources) {
    const key = sourceKeyForTarget(source);
    perSource[key] = normalizePerSourceDelivery(model.perSource[key], model.defaultRoute);
  }
  return { ...model, perSource, combined: null };
}

export function projectLegacyDelivery(
  model: AgentDeliveryModel,
  sources: AgentSourceConfig[],
): AgentDeliveryConfig | null {
  if (model.mode === "combined") {
    const { ackNonDm: _ackNonDm, ...delivery } = model.combined;
    return delivery;
  }

  const selfSources = sources.filter((source) => model.perSource[sourceKeyForTarget(source)]?.kind === "self");
  return selfSources.length === 1 ? sourceAsDelivery(selfSources[0]) : null;
}

export function normalizeRouteDestination(value: unknown): AgentRouteDestination | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "self" || raw.kind === "off") return { kind: raw.kind };
  if (raw.kind === "member") {
    if (raw.platform !== "slack" && raw.platform !== "whatsapp") return null;
    const memberUserId = typeof raw.memberUserId === "string" ? raw.memberUserId.trim() : "";
    return memberUserId ? { kind: "member", platform: raw.platform, memberUserId } : null;
  }
  if (raw.kind === "channel") {
    const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";
    if (!targetId) return null;
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
    if (raw.platform === "slack" && raw.targetType === "channel") {
      return { kind: "channel", platform: "slack", targetType: "channel", targetId, label };
    }
    if (raw.platform === "whatsapp" && raw.targetType === "group") {
      return { kind: "channel", platform: "whatsapp", targetType: "group", targetId, label };
    }
  }
  return null;
}

export function normalizeRouteSchedule(value: unknown): AgentRoute["schedule"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !Number.isInteger(raw.hour) ||
    !Number.isInteger(raw.minute) ||
    Number(raw.hour) < 0 ||
    Number(raw.hour) > 23 ||
    Number(raw.minute) < 0 ||
    Number(raw.minute) > 59
  ) {
    return null;
  }
  const frequency = raw.frequency === undefined ? "daily" : raw.frequency;
  if (!ROUTE_FREQUENCIES.has(frequency as AgentRouteFrequency)) return null;
  const base = { frequency: frequency as AgentRouteFrequency, hour: Number(raw.hour), minute: Number(raw.minute) };
  if (base.frequency === "daily") return base;
  if (base.frequency === "weekly") {
    if (!Array.isArray(raw.daysOfWeek)) return null;
    const daysOfWeek = [...new Set(raw.daysOfWeek)];
    if (
      daysOfWeek.length === 0 ||
      daysOfWeek.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)
    ) {
      return null;
    }
    return { ...base, daysOfWeek: daysOfWeek.map(Number) };
  }
  if (!Number.isInteger(raw.intervalHours) || !ROUTE_INTERVAL_HOURS.has(Number(raw.intervalHours))) return null;
  return { ...base, intervalHours: Number(raw.intervalHours) };
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
      (source.targetType !== "channel" && source.targetType !== "dm" && source.targetType !== "group") ||
      (source.platform === "slack" && source.targetType === "group") ||
      (source.platform === "whatsapp" && source.targetType === "channel") ||
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

export function normalizeRoutesFromValue(value: unknown): AgentRoute[] | null {
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

export function synthesizeRoutesFromDeliveryModel(
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

export function enabledSectionsForScope(
  def: AgentDefinition,
  config: Pick<ResolvedAgentConfig, "enabledSections">,
  route: AgentRoute | undefined,
): Record<string, boolean> {
  return route ? enabledSectionsForRoute(def, route) : config.enabledSections;
}

function maxItemsPerSectionForRoute(def: AgentDefinition, route: AgentRoute | undefined): number {
  return route?.maxItemsPerSection ?? def.defaults.maxItemsPerSection;
}

export function maxItemsPerSectionForScope(
  def: AgentDefinition,
  config: Pick<ResolvedAgentConfig, "maxItemsPerSection">,
  route: AgentRoute | undefined,
): number {
  return route ? maxItemsPerSectionForRoute(def, route) : config.maxItemsPerSection;
}

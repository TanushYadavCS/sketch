import { Hono } from "hono";
import type { Kysely } from "kysely";
import type {
  AgentDeliveryConfig,
  AgentDeliveryMention,
  AgentDeliveryModel,
  AgentDeliveryPlatform,
  AgentPerSourceDelivery,
  AgentRoute,
  AgentRouteDestination,
  AgentRouteFrequency,
  AgentSourceConfig,
  AgentSourceKey,
} from "../db/repositories/agent-outputs";
import type { DB } from "../db/schema";
import { CONVERSATION_SUMMARY_AGENT_KEY } from "./definitions/conversation-summary";
import { DAILY_BRIEF_AGENT_KEY } from "./definitions/daily-brief";
import { getAgentDefinition } from "./registry";
import {
  AgentDeliveryTargetError,
  type AgentOutputApi,
  type AgentRunService,
  AgentSourceTargetError,
  type AgentViewerRole,
} from "./service";
import type { AgentDefinition } from "./types";

async function getCurrentUserId(c: { get: (key: "sub" | "email") => string | undefined }, service: AgentRunService) {
  const sub = c.get("sub");
  if (!sub) return null;
  return service.resolveUserId(sub, c.get("email"));
}

function getCurrentRole(c: { get: (key: "role") => string | undefined }): AgentViewerRole {
  return c.get("role") === "admin" ? "admin" : "member";
}

/**
 * Adapts the generic agent output into the legacy Daily Brief response shape the
 * `/home` page consumes. Keeps `/api/daily-briefs` byte-compatible so the flagship
 * Home surface stays decoupled from the generic `/api/agents` routes.
 */
function toBriefShape(output: AgentOutputApi | null) {
  if (!output) return null;
  return {
    id: output.id,
    userId: output.userId,
    briefDate: output.outputDate,
    timezone: output.timezone,
    status: output.status,
    generatedAt: output.generatedAt,
    masthead: output.masthead,
    sections: {
      meetings: output.sections.meetings ?? [],
      todos: output.sections.todos ?? [],
      customer_updates: output.sections.customer_updates ?? [],
      active_projects: output.sections.active_projects ?? [],
    },
  };
}

function toGenerationShape(row: { id: string; status: string; output_date: string; source_key: string }) {
  return { id: row.id, sourceKey: row.source_key, status: row.status, outputDate: row.output_date };
}

/**
 * Whether the reader has connected their own calendar. Drives the meetings
 * section empty state: a connect nudge when false, an "empty day" line when true.
 */
async function hasCalendarConnector(db: Kysely<DB>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom("connector_configs")
    .select("id")
    .where("connector_type", "=", "google_calendar")
    .where("created_by", "=", userId)
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

export function dailyBriefRoutes(service: AgentRunService, db: Kysely<DB>) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const date = c.req.query("date") || undefined;
    const [result, calendarConnected] = await Promise.all([
      service.getLatestForUser(DAILY_BRIEF_AGENT_KEY, userId, date),
      hasCalendarConnector(db, userId),
    ]);
    return c.json({
      brief: toBriefShape(result.output),
      running: result.running,
      briefDate: result.outputDate,
      timezone: result.timezone,
      enabledSections: result.enabledSections,
      calendarConnected,
    });
  });

  routes.get("/:id", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const output = await service.getByIdForUser(DAILY_BRIEF_AGENT_KEY, c.req.param("id"), userId);
    if (!output) return c.json({ error: { code: "NOT_FOUND", message: "Daily Brief not found" } }, 404);
    return c.json({ brief: toBriefShape(output) });
  });

  routes.post("/", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { briefDate?: unknown };
    const outputDate = typeof body.briefDate === "string" && body.briefDate.trim() ? body.briefDate.trim() : undefined;
    const rows = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId,
      outputDate,
      triggerType: "manual",
    });
    const row = rows[0] ?? null;
    return c.json({ generation: row ? { id: row.id, status: row.status, briefDate: row.output_date } : null }, 202);
  });

  return routes;
}

class ConfigPatchError extends Error {}

const ROUTE_FREQUENCIES = new Set<AgentRouteFrequency>(["daily", "weekly", "every_n_hours"]);
const ROUTE_INTERVAL_HOURS = new Set([1, 2, 3, 4, 6, 8, 12]);

function parseDeliveryMentions(value: unknown, deliveryPlatform: AgentDeliveryPlatform): AgentDeliveryMention[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigPatchError("delivery.mentions must be an array");
  if (value.length > 20) throw new ConfigPatchError("delivery.mentions supports at most 20 people");
  const mentions: AgentDeliveryMention[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new ConfigPatchError("delivery mention must be an object");
    const raw = entry as Record<string, unknown>;
    const platform = raw.platform;
    const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";
    if (platform !== "slack" && platform !== "whatsapp") {
      throw new ConfigPatchError("delivery mention platform must be slack or whatsapp");
    }
    if (platform !== deliveryPlatform) {
      throw new ConfigPatchError("delivery mention platform must match delivery.platform");
    }
    if (!targetId) throw new ConfigPatchError("delivery mention targetId is required");
    const key = `${platform}:${targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
    mentions.push({ platform, targetId, label });
  }

  return mentions;
}

function parseDeliveryConfig(value: unknown): AgentDeliveryConfig | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new ConfigPatchError("delivery must be an object or null");
  const raw = value as Record<string, unknown>;
  if (raw.enabled === false) return null;
  if (raw.enabled !== true) throw new ConfigPatchError("delivery.enabled must be true or false");
  const platform = raw.platform;
  const targetType = raw.targetType;
  const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";
  if (platform !== "slack" && platform !== "whatsapp") {
    throw new ConfigPatchError("delivery.platform must be slack or whatsapp");
  }
  if (targetType !== "channel" && targetType !== "dm" && targetType !== "group") {
    throw new ConfigPatchError("delivery.targetType must be channel, dm, or group");
  }
  if (!targetId) throw new ConfigPatchError("delivery.targetId is required");
  if (platform === "slack" && targetType !== "channel" && targetType !== "dm") {
    throw new ConfigPatchError("Slack delivery supports channel or dm targets");
  }
  if (platform === "whatsapp" && targetType !== "group") {
    throw new ConfigPatchError("WhatsApp delivery supports group targets");
  }
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
  const mentions = parseDeliveryMentions(raw.mentions, platform);
  return {
    enabled: true,
    platform,
    targetType,
    targetId,
    label,
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

function parseRequiredDeliveryConfig(value: unknown, path: string): AgentDeliveryConfig {
  const parsed = parseDeliveryConfig(value);
  if (!parsed) throw new ConfigPatchError(`${path} must be an enabled delivery object`);
  return parsed;
}

function parsePerSourceDelivery(value: unknown): AgentPerSourceDelivery {
  if (!value || typeof value !== "object")
    throw new ConfigPatchError("deliveryModel.perSource route must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "self" || raw.kind === "off") return { kind: raw.kind };
  throw new ConfigPatchError("deliveryModel.perSource route kind must be self or off");
}

function parseDeliveryModel(value: unknown): AgentDeliveryModel | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigPatchError("deliveryModel must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.mode === "combined") {
    const combined = parseRequiredDeliveryConfig(raw.combined, "deliveryModel.combined");
    const ackNonDm = (raw.combined as Record<string, unknown>).ackNonDm;
    if (ackNonDm !== undefined && ackNonDm !== true) {
      throw new ConfigPatchError("deliveryModel.combined.ackNonDm must be true when present");
    }
    return {
      mode: "combined",
      combined: {
        ...combined,
        ...(ackNonDm === true ? { ackNonDm: true as const } : {}),
      },
    };
  }

  if (raw.mode !== "per_source") throw new ConfigPatchError("deliveryModel.mode must be per_source or combined");
  const defaultRoute = raw.defaultRoute === "self" ? "self" : raw.defaultRoute === "off" ? "off" : null;
  if (!defaultRoute) throw new ConfigPatchError("deliveryModel.defaultRoute must be self or off");
  if (!raw.perSource || typeof raw.perSource !== "object" || Array.isArray(raw.perSource)) {
    throw new ConfigPatchError("deliveryModel.perSource must be an object");
  }
  const perSource: Record<string, AgentPerSourceDelivery> = {};
  for (const [key, route] of Object.entries(raw.perSource as Record<string, unknown>)) {
    perSource[key] = parsePerSourceDelivery(route);
  }
  return { mode: "per_source", defaultRoute, perSource, combined: null };
}

function parseSourceConfigs(value: unknown): AgentSourceConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ConfigPatchError("sources must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new ConfigPatchError("source must be an object");
    const raw = entry as Record<string, unknown>;
    const platform = raw.platform;
    const targetType = raw.targetType;
    const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";
    if (platform !== "slack" && platform !== "whatsapp") {
      throw new ConfigPatchError("source.platform must be slack or whatsapp");
    }
    if (targetType !== "channel" && targetType !== "group") {
      throw new ConfigPatchError("source.targetType must be channel or group");
    }
    if (!targetId) throw new ConfigPatchError("source.targetId is required");
    if (platform === "slack" && targetType !== "channel") {
      throw new ConfigPatchError("Slack sources must be channels");
    }
    if (platform === "whatsapp" && targetType !== "group") {
      throw new ConfigPatchError("WhatsApp sources must be groups");
    }
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
    return { platform, targetType, targetId, label };
  });
}

function sourceKeyForConfig(source: AgentSourceConfig): AgentSourceKey {
  return `${source.platform}:${source.targetType}:${source.targetId}`;
}

function parseRouteSourceKey(value: unknown): AgentSourceKey {
  if (typeof value !== "string" || !value.trim()) throw new ConfigPatchError("route source must be a source key");
  const [platform, targetType, ...targetParts] = value.trim().split(":");
  const targetId = targetParts.join(":");
  if ((platform !== "slack" && platform !== "whatsapp") || !targetId) {
    throw new ConfigPatchError("route source must be a valid source key");
  }
  if (targetType !== "channel" && targetType !== "group") {
    throw new ConfigPatchError("route source must be a valid source key");
  }
  if (platform === "slack" && targetType !== "channel") {
    throw new ConfigPatchError("Slack route sources must be channels");
  }
  if (platform === "whatsapp" && targetType !== "group") {
    throw new ConfigPatchError("WhatsApp route sources must be groups");
  }
  return `${platform}:${targetType}:${targetId}`;
}

function parseRouteSections(value: unknown, def: AgentDefinition): Record<string, boolean> | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigPatchError("route.sections must be an object or null");
  }
  const knownSections = new Set(def.sections.map((section) => section.key));
  const sections: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (!knownSections.has(key)) throw new ConfigPatchError(`Unknown route section: ${key}`);
    if (typeof enabled !== "boolean") throw new ConfigPatchError("route section values must be booleans");
    sections[key] = enabled;
  }
  return sections;
}

function parseRouteSchedule(value: unknown): AgentRoute["schedule"] {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigPatchError("route.schedule must be an object or null");
  }
  const raw = value as Record<string, unknown>;
  if (!Number.isInteger(raw.hour) || Number(raw.hour) < 0 || Number(raw.hour) > 23) {
    throw new ConfigPatchError("route.schedule.hour must be an integer from 0 to 23");
  }
  if (!Number.isInteger(raw.minute) || Number(raw.minute) < 0 || Number(raw.minute) > 59) {
    throw new ConfigPatchError("route.schedule.minute must be an integer from 0 to 59");
  }
  const frequency = raw.frequency === undefined ? "daily" : raw.frequency;
  if (!ROUTE_FREQUENCIES.has(frequency as AgentRouteFrequency)) {
    throw new ConfigPatchError("route.schedule.frequency must be daily, weekly, or every_n_hours");
  }
  const base = { frequency: frequency as AgentRouteFrequency, hour: Number(raw.hour), minute: Number(raw.minute) };
  if (base.frequency === "daily") return base;
  if (base.frequency === "weekly") {
    if (!Array.isArray(raw.daysOfWeek)) {
      throw new ConfigPatchError("route.schedule.daysOfWeek must be a non-empty array for weekly schedules");
    }
    const daysOfWeek = [...new Set(raw.daysOfWeek)];
    if (
      daysOfWeek.length === 0 ||
      daysOfWeek.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)
    ) {
      throw new ConfigPatchError("route.schedule.daysOfWeek values must be integers from 0 to 6");
    }
    return { ...base, daysOfWeek: daysOfWeek.map(Number) };
  }
  if (!Number.isInteger(raw.intervalHours) || !ROUTE_INTERVAL_HOURS.has(Number(raw.intervalHours))) {
    throw new ConfigPatchError("route.schedule.intervalHours must be one of 1, 2, 3, 4, 6, 8, or 12");
  }
  return { ...base, intervalHours: Number(raw.intervalHours) };
}

function parseRouteDestination(value: unknown): AgentRouteDestination {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigPatchError("route.destination must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "self" || raw.kind === "off") return { kind: raw.kind };
  if (raw.kind === "member") {
    if (raw.platform !== "slack" && raw.platform !== "whatsapp") {
      throw new ConfigPatchError("route.destination.platform must be slack or whatsapp");
    }
    const memberUserId = typeof raw.memberUserId === "string" ? raw.memberUserId.trim() : "";
    if (!memberUserId) throw new ConfigPatchError("route.destination.memberUserId is required");
    return { kind: "member", platform: raw.platform, memberUserId };
  }
  if (raw.kind === "channel") {
    if (raw.platform === "slack") {
      if (raw.targetType !== "channel") {
        throw new ConfigPatchError("Slack route destination targetType must be channel");
      }
      const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";
      if (!targetId) throw new ConfigPatchError("route.destination.targetId is required");
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
      return { kind: "channel", platform: "slack", targetType: "channel", targetId, label };
    }
    if (raw.platform === "whatsapp") {
      if (raw.targetType !== "group") {
        throw new ConfigPatchError("WhatsApp route destination targetType must be group");
      }
      const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";
      if (!targetId) throw new ConfigPatchError("route.destination.targetId is required");
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
      return { kind: "channel", platform: "whatsapp", targetType: "group", targetId, label };
    }
    throw new ConfigPatchError("route.destination.platform must be slack or whatsapp");
  }
  throw new ConfigPatchError("route.destination.kind must be self, off, member, or channel");
}

function parseRoutes(value: unknown, def: AgentDefinition): AgentRoute[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ConfigPatchError("routes must be an array");
  const routes: AgentRoute[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigPatchError("route must be an object");
    }
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
    if (!id) throw new ConfigPatchError("route.id is required");
    if (seenIds.has(id)) throw new ConfigPatchError("route.id values must be unique");
    seenIds.add(id);
    if (!Array.isArray(raw.sources)) throw new ConfigPatchError("route.sources must be an array");
    const sources: AgentSourceKey[] = [];
    const seenSources = new Set<string>();
    for (const source of raw.sources.map(parseRouteSourceKey)) {
      if (seenSources.has(source)) continue;
      seenSources.add(source);
      sources.push(source);
    }
    if (sources.length === 0) throw new ConfigPatchError("route.sources must include at least one source");
    const destination = parseRouteDestination(raw.destination);
    if (sources.length > 1 && destination.kind === "self") {
      throw new ConfigPatchError("Combined routes cannot use self destination");
    }
    if (
      destination.kind === "member" &&
      destination.platform === "slack" &&
      sources.some((source) => source.startsWith("whatsapp:"))
    ) {
      throw new ConfigPatchError("Member route destinations support Slack sources only");
    }
    const maxItemsPerSection =
      raw.maxItemsPerSection === null || raw.maxItemsPerSection === undefined
        ? null
        : Number.isInteger(raw.maxItemsPerSection)
          ? Number(raw.maxItemsPerSection)
          : null;
    if (raw.maxItemsPerSection !== null && raw.maxItemsPerSection !== undefined && maxItemsPerSection === null) {
      throw new ConfigPatchError("route.maxItemsPerSection must be an integer or null");
    }
    routes.push({
      id,
      sources,
      focus: typeof raw.focus === "string" && raw.focus.trim() ? raw.focus.trim() : null,
      sections: parseRouteSections(raw.sections, def),
      maxItemsPerSection,
      schedule: parseRouteSchedule(raw.schedule),
      destination,
      enabled: raw.enabled !== false,
    });
  }
  return routes;
}

function parseRouteMemberSources(value: unknown): AgentSourceKey[] {
  if (!Array.isArray(value)) throw new ConfigPatchError("sources must be an array");
  const sources: AgentSourceKey[] = [];
  const seen = new Set<string>();
  for (const source of value.map(parseRouteSourceKey)) {
    if (seen.has(source)) continue;
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

function assertRoutesReferenceSources(routes: AgentRoute[] | undefined, sources: AgentSourceConfig[] | undefined) {
  if (!routes || !sources) return;
  const sourceKeys = new Set(sources.map(sourceKeyForConfig));
  for (const route of routes) {
    for (const sourceKey of route.sources) {
      if (!sourceKeys.has(sourceKey)) throw new ConfigPatchError("Route source must be one of the selected sources");
    }
  }
}

function parseConfigPatch(body: Record<string, unknown>, def: AgentDefinition) {
  const patch: {
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
  } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.scheduleHour === "number" && Number.isInteger(body.scheduleHour)) {
    patch.scheduleHour = Math.min(23, Math.max(0, body.scheduleHour));
  }
  if (typeof body.scheduleMinute === "number" && Number.isInteger(body.scheduleMinute)) {
    patch.scheduleMinute = Math.min(59, Math.max(0, body.scheduleMinute));
  }
  if (typeof body.maxItemsPerSection === "number" && Number.isInteger(body.maxItemsPerSection)) {
    patch.maxItemsPerSection = body.maxItemsPerSection;
  }
  if (body.sections && typeof body.sections === "object") {
    const sections: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(body.sections as Record<string, unknown>)) {
      if (typeof value === "boolean") sections[key] = value;
    }
    patch.sections = sections;
  }
  if (body.focus === null || typeof body.focus === "string") {
    patch.focus = body.focus as string | null;
  }
  const delivery = parseDeliveryConfig(body.delivery);
  if (delivery !== undefined) patch.delivery = delivery;
  const deliveryModel = parseDeliveryModel(body.deliveryModel);
  if (deliveryModel !== undefined) patch.deliveryModel = deliveryModel;
  const sources = parseSourceConfigs(body.sources);
  if (sources !== undefined) patch.sources = sources;
  const routes = parseRoutes(body.routes, def);
  assertRoutesReferenceSources(routes, sources);
  if (routes !== undefined) patch.routes = routes;
  return patch;
}

async function validateDeliveryTargets(
  service: AgentRunService,
  userId: string,
  patch: ReturnType<typeof parseConfigPatch>,
) {
  if (patch.delivery !== undefined) await service.resolveDeliveryConfigForUser(userId, patch.delivery);
  if (patch.deliveryModel?.mode === "combined") {
    await service.resolveDeliveryConfigForUser(userId, patch.deliveryModel.combined);
  }
}

export function agentRoutes(service: AgentRunService) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    return c.json({ agents: await service.listForViewer(userId, getCurrentRole(c)) });
  });

  routes.get("/:agentKey", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    const role = getCurrentRole(c);
    const agent = await service.getConfigViewForViewer(agentKey, userId, role);
    if (!agent) return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    const latest = await service.getLatestForViewer(agentKey, userId, role);
    return c.json({
      agent,
      output: latest.output,
      running: latest.running,
      outputDate: latest.outputDate,
      timezone: latest.timezone,
    });
  });

  routes.put("/:agentKey/config", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    const def = getAgentDefinition(agentKey);
    if (!def) return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const role = getCurrentRole(c);
    let patch: ReturnType<typeof parseConfigPatch>;
    let agent: Awaited<ReturnType<AgentRunService["updateConfigForUser"]>>;
    try {
      patch = parseConfigPatch(body, def);
      if (role === "admin" && agentKey === CONVERSATION_SUMMARY_AGENT_KEY) {
        agent = await service.updateConfigForViewer(agentKey, userId, role, patch);
      } else {
        const configUserId = await service.resolveConfigControlUserId(agentKey, userId, role);
        await validateDeliveryTargets(service, configUserId, patch);
        agent = await service.updateConfigForUser(agentKey, configUserId, patch);
      }
    } catch (err) {
      if (
        err instanceof ConfigPatchError ||
        err instanceof AgentDeliveryTargetError ||
        err instanceof AgentSourceTargetError
      ) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: err.message } }, 400);
      }
      throw err;
    }
    if (!agent) return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    return c.json({ agent });
  });

  routes.post("/:agentKey/route-members", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    const def = getAgentDefinition(agentKey);
    if (!def) return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const sources = parseRouteMemberSources(body.sources);
      const routeId = typeof body.routeId === "string" && body.routeId.trim() ? body.routeId.trim() : null;
      return c.json({
        members: await service.listEligibleRouteMembersForViewer(agentKey, userId, getCurrentRole(c), sources, routeId),
      });
    } catch (err) {
      if (err instanceof ConfigPatchError) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: err.message } }, 400);
      }
      throw err;
    }
  });

  routes.get("/:agentKey/route-members/whatsapp", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    const def = getAgentDefinition(agentKey);
    if (!def) return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    return c.json({ members: await service.listWhatsAppDmMembers() });
  });

  routes.get("/:agentKey/outputs", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    if (!service.listDefinitions().some((def) => def.key === agentKey)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    }
    const rawLimit = Number(c.req.query("limit") ?? "20");
    const limit = Number.isInteger(rawLimit) ? rawLimit : 20;
    const cursor = c.req.query("cursor") || null;
    return c.json(await service.listOutputsForViewer(agentKey, userId, getCurrentRole(c), { limit, cursor }));
  });

  routes.get("/:agentKey/outputs/:id", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    if (!service.listDefinitions().some((def) => def.key === agentKey)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    }
    const output = await service.getByIdForViewer(agentKey, c.req.param("id"), userId, getCurrentRole(c));
    if (!output) return c.json({ error: { code: "NOT_FOUND", message: "Output not found" } }, 404);
    return c.json({ output });
  });

  routes.post("/:agentKey/runs", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    if (!service.listDefinitions().some((def) => def.key === agentKey)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const rawRouteId =
      body && typeof body === "object" && !Array.isArray(body) ? (body as { routeId?: unknown }).routeId : undefined;
    const routeId = typeof rawRouteId === "string" && rawRouteId.trim() ? rawRouteId.trim() : undefined;
    const rows = await service.requestGenerationForViewer({
      agentKey,
      userId,
      viewerRole: getCurrentRole(c),
      triggerType: "manual",
      ...(routeId ? { routeIds: [routeId] } : {}),
    });
    if (routeId && rows.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404);
    }
    const generations = rows.map(toGenerationShape);
    return c.json({ generation: generations[0] ?? null, generations }, 202);
  });

  return routes;
}

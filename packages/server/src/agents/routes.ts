import { Hono } from "hono";
import type { AgentDeliveryConfig } from "../db/repositories/agent-outputs";
import { DAILY_BRIEF_AGENT_KEY } from "./definitions/daily-brief";
import type { AgentOutputApi, AgentRunService } from "./service";

async function getCurrentUserId(c: { get: (key: "sub" | "email") => string | undefined }, service: AgentRunService) {
  const sub = c.get("sub");
  if (!sub) return null;
  return service.resolveUserId(sub, c.get("email"));
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
      todos: output.sections.todos ?? [],
      customer_updates: output.sections.customer_updates ?? [],
      active_projects: output.sections.active_projects ?? [],
    },
  };
}

export function dailyBriefRoutes(service: AgentRunService) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const date = c.req.query("date") || undefined;
    const result = await service.getLatestForUser(DAILY_BRIEF_AGENT_KEY, userId, date);
    return c.json({
      brief: toBriefShape(result.output),
      running: result.running,
      briefDate: result.outputDate,
      timezone: result.timezone,
      enabledSections: result.enabledSections,
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
    const row = await service.requestGenerationForUser({
      agentKey: DAILY_BRIEF_AGENT_KEY,
      userId,
      outputDate,
      triggerType: "manual",
    });
    return c.json({ generation: row ? { id: row.id, status: row.status, briefDate: row.output_date } : null }, 202);
  });

  return routes;
}

class ConfigPatchError extends Error {}

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
  return { enabled: true, platform, targetType, targetId, label };
}

function parseConfigPatch(body: Record<string, unknown>) {
  const patch: {
    enabled?: boolean;
    scheduleHour?: number;
    scheduleMinute?: number;
    maxItemsPerSection?: number;
    sections?: Record<string, boolean>;
    focus?: string | null;
    delivery?: AgentDeliveryConfig | null;
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
  return patch;
}

export function agentRoutes(service: AgentRunService) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    return c.json({ agents: await service.listForUser(userId) });
  });

  routes.get("/:agentKey", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    const agent = await service.getConfigView(agentKey, userId);
    if (!agent) return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    const latest = await service.getLatestForUser(agentKey, userId);
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
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let patch: ReturnType<typeof parseConfigPatch>;
    try {
      patch = parseConfigPatch(body);
    } catch (err) {
      if (err instanceof ConfigPatchError) {
        return c.json({ error: { code: "VALIDATION_ERROR", message: err.message } }, 400);
      }
      throw err;
    }
    const agent = await service.updateConfigForUser(agentKey, userId, patch);
    if (!agent) return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    return c.json({ agent });
  });

  routes.get("/:agentKey/outputs/:id", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const agentKey = c.req.param("agentKey");
    if (!service.listDefinitions().some((def) => def.key === agentKey)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Agent not found" } }, 404);
    }
    const output = await service.getByIdForUser(agentKey, c.req.param("id"), userId);
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
    const row = await service.requestGenerationForUser({ agentKey, userId, triggerType: "manual" });
    return c.json({ generation: row ? { id: row.id, status: row.status, outputDate: row.output_date } : null }, 202);
  });

  return routes;
}

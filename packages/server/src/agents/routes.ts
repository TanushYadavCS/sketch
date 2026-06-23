import { Hono } from "hono";
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

function parseConfigPatch(body: Record<string, unknown>) {
  const patch: {
    enabled?: boolean;
    scheduleHour?: number;
    scheduleMinute?: number;
    maxItemsPerSection?: number;
    sections?: Record<string, boolean>;
    focus?: string | null;
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
    const agent = await service.updateConfigForUser(agentKey, userId, parseConfigPatch(body));
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

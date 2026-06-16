import { Hono } from "hono";
import type { DailyBriefService } from "./service";

async function getCurrentUserId(c: { get: (key: "sub" | "email") => string | undefined }, service: DailyBriefService) {
  const sub = c.get("sub");
  if (!sub) return null;
  return service.resolveUserId(sub, c.get("email"));
}

export function dailyBriefRoutes(service: DailyBriefService) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const date = c.req.query("date") || undefined;
    const result = await service.getLatestForUser(userId, date);
    return c.json(result);
  });

  routes.get("/:id", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const brief = await service.getByIdForUser(c.req.param("id"), userId);
    if (!brief) return c.json({ error: { code: "NOT_FOUND", message: "Daily Brief not found" } }, 404);
    return c.json({ brief });
  });

  routes.post("/", async (c) => {
    const userId = await getCurrentUserId(c, service);
    if (!userId) return c.json({ error: { code: "UNAUTHORIZED", message: "User not found" } }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { briefDate?: unknown };
    const briefDate = typeof body.briefDate === "string" && body.briefDate.trim() ? body.briefDate.trim() : undefined;
    const row = await service.requestGenerationForUser({ userId, briefDate, triggerType: "manual" });
    return c.json({ generation: row ? { id: row.id, status: row.status, briefDate: row.brief_date } : null }, 202);
  });

  return routes;
}

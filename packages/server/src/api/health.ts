import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { DB } from "../db/schema";

export function healthRoutes(db: Kysely<DB>, getWhatsAppHealth?: () => { missingProviderIdEvents: number }) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const version = process.env.SKETCH_VERSION || "dev";
    try {
      await db.selectFrom("users").select("id").limit(1).execute();
      return c.json({
        status: "ok",
        db: "ok",
        uptime: process.uptime(),
        version,
        ...(getWhatsAppHealth ? { whatsapp: getWhatsAppHealth() } : {}),
      });
    } catch {
      return c.json({ status: "error", db: "error", version }, 500);
    }
  });

  return routes;
}

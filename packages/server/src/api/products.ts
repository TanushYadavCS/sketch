import { Hono } from "hono";
import type { Kysely } from "kysely";
import { z } from "zod";
import { createEntityRepository } from "../db/repositories/entities";
import type { DB } from "../db/schema";
import { denyIfNotAdmin } from "./auth-helpers";

const declareProductBodySchema = z.object({
  name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).optional(),
});

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function productRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const repo = createEntityRepository(db);

  routes.post("/", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;

    const parsed = declareProductBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: "name is required" } }, 400);
    }

    const entity = await repo.declareProduct(parsed.data);
    return c.json({
      entity: {
        id: entity.id,
        name: entity.name,
        aliases: parseAliases(entity.aliases),
        hotness: Number(entity.hotness ?? 0),
        provenance_tier: entity.provenance_tier,
      },
    });
  });

  routes.get("/", async (c) => {
    const products = await repo.listCuratedProducts();
    return c.json({ products });
  });

  return routes;
}

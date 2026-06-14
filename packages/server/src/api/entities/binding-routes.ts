import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { DB } from "../../db/schema";
import { ProjectBindingError, createProjectBindingsService } from "../../entities/project-bindings";
import { denyIfNotAdmin } from "../auth-helpers";

function statusForBindingError(code: "NOT_A_PROJECT" | "ALREADY_GROUPED" | "WOULD_CYCLE"): 409 | 422 {
  return code === "NOT_A_PROJECT" ? 422 : 409;
}

function handleBindingError(c: Context, err: unknown): Response {
  if (err instanceof ProjectBindingError) {
    return c.json({ error: { code: err.code, message: err.message } }, statusForBindingError(err.code));
  }
  throw err;
}

export function createEntityBindingRoutes(db: Kysely<DB>) {
  const routes = new Hono();
  const service = createProjectBindingsService(db);

  routes.get("/:id/bindings", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const effective = c.req.query("effective") === "true";
    const bindings = await service.listBindings(c.req.param("id"), effective);
    return c.json({ bindings });
  });

  routes.post("/:id/bindings", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: string;
      containerId?: string;
      containerKind?: string;
      label?: string | null;
      connectorConfigId?: string | null;
    };
    if (!body.source || !body.containerId || !body.containerKind) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "source, containerId and containerKind are required" } },
        400,
      );
    }
    try {
      const binding = await service.addBinding(
        c.req.param("id"),
        {
          source: body.source,
          containerId: body.containerId,
          containerKind: body.containerKind,
          label: body.label ?? null,
          connectorConfigId: body.connectorConfigId ?? null,
        },
        c.get("sub"),
      );
      return c.json({ binding });
    } catch (err) {
      return handleBindingError(c, err);
    }
  });

  routes.delete("/:id/bindings/:bindingId", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const removed = await service.removeBinding(c.req.param("id"), c.req.param("bindingId"));
    if (!removed) return c.json({ error: { code: "BINDING_NOT_FOUND", message: "binding not found" } }, 404);
    return c.json({ ok: true });
  });

  routes.post("/:id/group", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { childId?: string };
    if (!body.childId) return c.json({ error: { code: "BAD_REQUEST", message: "childId is required" } }, 400);
    try {
      await service.groupProject(c.req.param("id"), body.childId);
      return c.json({ ok: true });
    } catch (err) {
      return handleBindingError(c, err);
    }
  });

  routes.delete("/:id/group/:childId", async (c) => {
    const denied = denyIfNotAdmin(c);
    if (denied) return denied;
    await service.ungroupProject(c.req.param("childId"));
    return c.json({ ok: true });
  });

  return routes;
}

import { isReservedAgentEnvName } from "@sketch/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { createAgentEnvironmentVariableRepository } from "../db/repositories/agent-environment-variables";

type AgentEnvironmentRepo = ReturnType<typeof createAgentEnvironmentVariableRepository>;

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, numbers, and underscores. Start with a letter or underscore.");

const createVariableSchema = z.object({
  name: envNameSchema,
  value: z.string(),
  isSecret: z.boolean(),
});

const updateVariableSchema = z.object({
  value: z.string(),
});

function validationError(message: string) {
  return { error: { code: "VALIDATION_ERROR", message } };
}

export function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) return true;
  if (!err || typeof err !== "object") return false;
  const { code, cause } = err as { code?: unknown; cause?: unknown };
  if (code === "23505") return true;
  return isUniqueConstraintError(cause);
}

export function agentEnvironmentRoutes(envVars: AgentEnvironmentRepo) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const userId = c.get("sub");
    return c.json({ variables: await envVars.list(userId) });
  });

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createVariableSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json(validationError(message), 400);
    }
    if (isReservedAgentEnvName(parsed.data.name)) {
      return c.json(validationError("This environment variable name is reserved by Sketch."), 400);
    }

    try {
      const variable = await envVars.create(c.get("sub"), parsed.data);
      return c.json({ variable }, 201);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return c.json(
          { error: { code: "CONFLICT", message: "An environment variable with this name already exists." } },
          409,
        );
      }
      throw err;
    }
  });

  routes.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateVariableSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json(validationError(message), 400);
    }

    const variable = await envVars.updateValue(c.req.param("id"), c.get("sub"), parsed.data.value);
    if (!variable) {
      return c.json({ error: { code: "NOT_FOUND", message: "Environment variable not found" } }, 404);
    }
    return c.json({ variable });
  });

  routes.delete("/:id", async (c) => {
    const removed = await envVars.remove(c.req.param("id"), c.get("sub"));
    if (!removed) {
      return c.json({ error: { code: "NOT_FOUND", message: "Environment variable not found" } }, 404);
    }
    return c.json({ success: true });
  });

  return routes;
}

import {
  type AgentEnvironmentShareTargetInput,
  type IntegrationApp,
  cliIntegrationAppIdSchema,
  cliIntegrationShareTargetSchema,
} from "@sketch/shared";
import { Hono } from "hono";
import { z } from "zod";
import { checkGithubCli } from "../integrations/cli/github";
import { isCanvasBlockedAppId } from "../integrations/cli/policy";
import type { CliIntegrationServiceError, createCliIntegrationService } from "../integrations/cli/service";
import type { IntegrationProvider } from "../integrations/types";
import { type AgentEnvironmentRouteDeps, validateShareTargets } from "./agent-environment";

const tokenSchema = z.object({
  token: z.string(),
  targets: z.array(cliIntegrationShareTargetSchema).optional(),
});

const sharesSchema = z.object({
  targets: z.array(cliIntegrationShareTargetSchema),
});

type CliIntegrationService = ReturnType<typeof createCliIntegrationService>;

type CliIntegrationRouteDeps = Pick<
  AgentEnvironmentRouteDeps,
  "users" | "channels" | "whatsappGroups" | "getSlack" | "logger"
> & {
  service: CliIntegrationService;
  loadIntegrationProvider?: () => Promise<IntegrationProvider | null>;
};

function errorResponse(c: import("hono").Context, error: CliIntegrationServiceError | unknown) {
  if (error instanceof Error && "status" in error && "code" in error) {
    const serviceError = error as CliIntegrationServiceError;
    return c.json({ error: { code: serviceError.code, message: serviceError.message } }, serviceError.status);
  }
  throw error;
}

function isUniqueTargets(targets: AgentEnvironmentShareTargetInput[]): AgentEnvironmentShareTargetInput[] {
  return [...new Map(targets.map((target) => [`${target.type}:${target.id}`, target])).values()];
}

async function validateOwner(c: import("hono").Context, deps: CliIntegrationRouteDeps): Promise<Response | null> {
  const user = await deps.users.findById(c.get("sub"));
  if (!user || user.type === "external") {
    return c.json({ error: { code: "FORBIDDEN", message: "Only internal members can use CLI integrations." } }, 403);
  }
  return null;
}

async function validateTargets(
  c: import("hono").Context,
  targets: AgentEnvironmentShareTargetInput[],
  deps: CliIntegrationRouteDeps,
): Promise<Response | null> {
  const validation = await validateShareTargets(targets, deps, c.get("role"));
  if (!validation) return null;
  return c.json({ error: { code: "VALIDATION_ERROR", message: validation.message } }, validation.status);
}

export function cliIntegrationRoutes(deps: CliIntegrationRouteDeps) {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const viewerAccess = await validateOwner(c, deps);
    if (viewerAccess) return viewerAccess;
    const viewerId = c.get("sub");
    const query = c.req.query("q")?.trim() ?? "";
    const connections = await deps.service.listConnections(viewerId);
    const connectedByApp = new Map(connections.map((connection) => [connection.appId, connection]));
    const localApps = deps.service.listCatalog(query).map((app) => {
      const connection = connectedByApp.get(app.id);
      return {
        ...app,
        connected: connection?.status === "active",
        connectionId: connection?.id ?? null,
      };
    });

    const canvasApps: IntegrationApp[] = [];
    const shouldQueryCanvas = !query.toLowerCase().includes("github") && !query.toLowerCase().includes("linear");
    const viewer = shouldQueryCanvas ? await deps.users.findById(viewerId) : null;
    if (shouldQueryCanvas && deps.loadIntegrationProvider && viewer?.email) {
      try {
        const provider = await deps.loadIntegrationProvider();
        if (provider) {
          const [result, canvasConnections] = await Promise.all([
            provider.listApps(query || undefined, 20, undefined),
            provider.listConnections(viewer.email, viewer.name),
          ]);
          const canvasConnectedByApp = new Set(
            canvasConnections
              .filter((connection) => connection.status === "active")
              .map((connection) => connection.appId.trim().toLowerCase()),
          );
          for (const app of result.apps) {
            if (isCanvasBlockedAppId(app.id) || isCanvasBlockedAppId(app.name)) continue;
            canvasApps.push({
              ...app,
              executionMode: "canvas",
              connected: canvasConnectedByApp.has(app.id.trim().toLowerCase()),
              connectionId: null,
            });
          }
        }
      } catch {}
    }

    const seen = new Set(localApps.map((app) => app.id.trim().toLowerCase()));
    const apps = [...localApps, ...canvasApps.filter((app) => !seen.has(app.id.trim().toLowerCase()))];
    return c.json({ apps });
  });

  routes.get("/health", async (c) => c.json({ executable: await checkGithubCli() }));

  routes.get("/connections", async (c) => {
    const viewerAccess = await validateOwner(c, deps);
    if (viewerAccess) return viewerAccess;
    const connections = await deps.service.listConnections(c.get("sub"));
    return c.json({ connections });
  });

  routes.post("/:appId/verification", async (c) => {
    const appId = cliIntegrationAppIdSchema.safeParse(c.req.param("appId").trim().toLowerCase());
    if (!appId.success) {
      return c.json({ error: { code: "NOT_FOUND", message: "Managed integration not found." } }, 404);
    }
    const denied = await validateOwner(c, deps);
    if (denied) return denied;
    const body = z.object({ token: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: body.error.issues[0]?.message ?? "Invalid request" } },
        400,
      );
    }
    try {
      const identity =
        appId.data === "linear"
          ? await deps.service.verifyLinearApiKey(body.data.token)
          : await deps.service.verifyGitHubToken(body.data.token);
      return c.json({ identity });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/:appId/connections", async (c) => {
    const appId = cliIntegrationAppIdSchema.safeParse(c.req.param("appId").trim().toLowerCase());
    if (!appId.success) {
      return c.json({ error: { code: "NOT_FOUND", message: "Managed integration not found." } }, 404);
    }
    const denied = await validateOwner(c, deps);
    if (denied) return denied;
    const body = tokenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: body.error.issues[0]?.message ?? "Invalid request" } },
        400,
      );
    }
    const targets = isUniqueTargets(body.data.targets ?? []);
    const targetError = await validateTargets(c, targets, deps);
    if (targetError) return targetError;

    try {
      const connection =
        appId.data === "linear"
          ? await deps.service.connectLinear(c.get("sub"), body.data.token, targets)
          : await deps.service.connectGitHub(c.get("sub"), body.data.token, targets);
      return c.json({ connection }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.patch("/:appId/connections/:id/credential", async (c) => {
    const appId = cliIntegrationAppIdSchema.safeParse(c.req.param("appId").trim().toLowerCase());
    if (!appId.success) {
      return c.json({ error: { code: "NOT_FOUND", message: "Managed integration not found." } }, 404);
    }
    const denied = await validateOwner(c, deps);
    if (denied) return denied;
    const body = z.object({ token: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: body.error.issues[0]?.message ?? "Invalid request" } },
        400,
      );
    }
    try {
      const connection =
        appId.data === "linear"
          ? await deps.service.updateLinearApiKey(c.get("sub"), c.req.param("id"), body.data.token)
          : await deps.service.updateGitHubToken(c.get("sub"), c.req.param("id"), body.data.token);
      return c.json({ connection });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/:appId/connections/:id/verification", async (c) => {
    const appId = cliIntegrationAppIdSchema.safeParse(c.req.param("appId").trim().toLowerCase());
    if (!appId.success) {
      return c.json({ error: { code: "NOT_FOUND", message: "Managed integration not found." } }, 404);
    }
    const denied = await validateOwner(c, deps);
    if (denied) return denied;
    try {
      const connection = await deps.service.reverify(c.get("sub"), c.req.param("id"), appId.data);
      return c.json({ connection });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.put("/:appId/connections/:id/shares", async (c) => {
    const appId = cliIntegrationAppIdSchema.safeParse(c.req.param("appId").trim().toLowerCase());
    if (!appId.success) {
      return c.json({ error: { code: "NOT_FOUND", message: "Managed integration not found." } }, 404);
    }
    const denied = await validateOwner(c, deps);
    if (denied) return denied;
    if (!(await deps.service.canManage(c.get("sub"), c.req.param("id"), appId.data))) {
      return c.json({ error: { code: "NOT_FOUND", message: "Managed integration connection not found." } }, 404);
    }
    const body = sharesSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: body.error.issues[0]?.message ?? "Invalid request" } },
        400,
      );
    }
    const targets = isUniqueTargets(body.data.targets);
    const targetError = await validateTargets(c, targets, deps);
    if (targetError) return targetError;
    try {
      const connection = await deps.service.replaceShares(c.get("sub"), c.req.param("id"), targets, appId.data);
      return c.json({ connection });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.delete("/:appId/connections/:id", async (c) => {
    const appId = cliIntegrationAppIdSchema.safeParse(c.req.param("appId").trim().toLowerCase());
    if (!appId.success) {
      return c.json({ error: { code: "NOT_FOUND", message: "Managed integration not found." } }, 404);
    }
    const denied = await validateOwner(c, deps);
    if (denied) return denied;
    try {
      await deps.service.disconnect(c.get("sub"), c.req.param("id"), appId.data);
      return c.json({ success: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}

/**
 * Provider Identity API — manage per-user OAuth connections to external providers.
 *
 * Endpoints for:
 * - Listing a user's connected provider accounts
 * - Connecting a provider account (admin maps user → provider identity)
 * - Disconnecting a provider account
 *
 * In V1, admin maps users to provider identities manually.
 * In V2, users will connect their own accounts via OAuth redirect flow.
 */
import { Hono } from "hono";
import { z } from "zod";
import { VALID_CONNECTOR_TYPES } from "../connectors/registry";
import type { ConnectorType } from "../connectors/types";
import type { createProviderIdentityRepository } from "../db/repositories/provider-identities";
import type { createUserRepository } from "../db/repositories/users";
import { requireAdmin } from "./middleware";

type IdentityRepo = ReturnType<typeof createProviderIdentityRepository>;
type UserRepo = ReturnType<typeof createUserRepository>;

const connectSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  provider: z.enum(VALID_CONNECTOR_TYPES as [string, ...string[]]),
  providerUserId: z.string().min(1, "Provider user ID is required"),
  providerEmail: z.string().email().optional().nullable(),
});

const disconnectSchema = z.object({
  provider: z.enum(VALID_CONNECTOR_TYPES as [string, ...string[]]),
});

export function providerIdentityRoutes(identityRepo: IdentityRepo, userRepo: UserRepo) {
  const routes = new Hono();

  /** List all provider identities for a user. */
  routes.get("/user/:userId", async (c) => {
    const user = await userRepo.findById(c.req.param("userId"));
    if (!user) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }

    const identities = await identityRepo.findByUser(user.id);
    return c.json({
      identities: identities.map((i) => ({
        id: i.id,
        provider: i.provider,
        providerUserId: i.provider_user_id,
        providerEmail: i.provider_email,
        connectedAt: i.connected_at,
        hasToken: !!i.access_token,
      })),
    });
  });

  /**
   * Create a user-to-provider identity mapping.
   * In V1, admin does this manually (maps Sketch user → provider user ID).
   */
  routes.post("/", requireAdmin(), async (c) => {
    const body = await c.req.json();
    const parsed = connectSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const user = await userRepo.findById(parsed.data.userId);
    if (!user) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }

    const identity = await identityRepo.upsert({
      userId: user.id,
      provider: parsed.data.provider as ConnectorType,
      providerUserId: parsed.data.providerUserId,
      providerEmail: parsed.data.providerEmail ?? null,
    });

    return c.json(
      {
        identity: {
          id: identity.id,
          provider: identity.provider,
          providerUserId: identity.provider_user_id,
          providerEmail: identity.provider_email,
          connectedAt: identity.connected_at,
        },
      },
      201,
    );
  });

  /** Disconnect a user from a provider. */
  routes.delete("/user/:userId/provider/:provider", requireAdmin(), async (c) => {
    const user = await userRepo.findById(c.req.param("userId"));
    if (!user) {
      return c.json({ error: { code: "NOT_FOUND", message: "User not found" } }, 404);
    }

    const provider = c.req.param("provider") as ConnectorType;
    if (!VALID_CONNECTOR_TYPES.includes(provider as ConnectorType)) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid provider" } }, 400);
    }

    await identityRepo.remove(user.id, provider);
    return c.json({ success: true });
  });

  /** List all users connected to a specific provider (admin overview). */
  routes.get("/provider/:provider", async (c) => {
    const provider = c.req.param("provider") as ConnectorType;
    if (!VALID_CONNECTOR_TYPES.includes(provider as ConnectorType)) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Invalid provider" } }, 400);
    }

    const identities = await identityRepo.findByProvider(provider);
    return c.json({
      identities: identities.map((i) => ({
        id: i.id,
        userId: i.user_id,
        providerUserId: i.provider_user_id,
        providerEmail: i.provider_email,
        connectedAt: i.connected_at,
      })),
    });
  });

  return routes;
}

import { Hono } from "hono";
import type { Kysely } from "kysely";
import { z } from "zod";
import { createLocalDeviceRepository } from "../db/repositories/local-devices";
import type { DB } from "../db/schema";
import type { LocalDeviceGateway } from "../local-devices/gateway";
import {
  generateLocalDeviceToken,
  getLocalDeviceTokenDisplayPrefix,
  hashLocalDeviceToken,
} from "../local-devices/token";

const createDeviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  platform: z.string().trim().min(1).max(40).optional(),
});

function buildWebSocketUrl(opts: { baseUrl?: string; port: number }): string {
  if (!opts.baseUrl) return `ws://localhost:${opts.port}/api/local-devices/ws`;
  const base = opts.baseUrl.replace(/\/$/, "");
  if (base.startsWith("https://")) return `${base.replace(/^https:\/\//, "wss://")}/api/local-devices/ws`;
  if (base.startsWith("http://")) return `${base.replace(/^http:\/\//, "ws://")}/api/local-devices/ws`;
  return `${base}/api/local-devices/ws`;
}

function buildBaseUrl(opts: { baseUrl?: string; port: number }): string {
  if (!opts.baseUrl) return `localhost:${opts.port}`;
  return opts.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function toResponseDevice(
  row: {
    id: string;
    name: string;
    platform: string;
    prefix: string;
    status: string;
    last_seen_at: string | null;
    created_at: string;
    revoked_at: string | null;
  },
  online: boolean,
) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    prefix: row.prefix,
    status: row.revoked_at ? "revoked" : online ? "online" : "offline",
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function localDeviceRoutes(
  db: Kysely<DB>,
  opts: { baseUrl?: string; port: number; gateway: LocalDeviceGateway },
) {
  const routes = new Hono();
  const devices = createLocalDeviceRepository(db);

  routes.get("/", async (c) => {
    const rows = await devices.listForUser(c.get("sub"));
    return c.json({
      devices: rows.map((row) => toResponseDevice(row, opts.gateway.isOnline(row.id))),
      baseUrl: buildBaseUrl(opts),
      websocketUrl: buildWebSocketUrl(opts),
    });
  });

  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createDeviceSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const token = generateLocalDeviceToken();
    const row = await devices.create({
      userId: c.get("sub"),
      name: parsed.data.name,
      platform: parsed.data.platform ?? "macos",
      tokenHash: hashLocalDeviceToken(token),
      prefix: getLocalDeviceTokenDisplayPrefix(token),
    });

    return c.json({
      device: toResponseDevice(row, false),
      plaintext: token,
      baseUrl: buildBaseUrl(opts),
      websocketUrl: buildWebSocketUrl(opts),
    });
  });

  routes.delete("/:id", async (c) => {
    const deviceId = c.req.param("id");
    const revoked = await devices.revoke(c.get("sub"), deviceId);
    if (!revoked) {
      return c.json({ error: { code: "NOT_FOUND", message: "Local device not found" } }, 404);
    }
    opts.gateway.disconnect(deviceId);
    return c.json({ success: true });
  });

  return routes;
}

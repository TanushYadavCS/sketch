import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { createLocalDeviceRepository } from "../db/repositories/local-devices";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import type { LocalDeviceGateway } from "../local-devices/gateway";
import { hashLocalDeviceToken } from "../local-devices/token";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function setupSession(email: string) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  if (!(await settings.get())) {
    await settings.create();
  }
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const user = await users.create({
    name: email.split("@")[0] ?? "user",
    email,
    emailVerified: true,
    passwordHash: await hashPassword("testpassword123"),
    authRole: "member",
  });
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("Missing jwt secret");
  return {
    user,
    cookie: `sketch_session=${await signJwt(user.id, "member", row.jwt_secret)}`,
  };
}

function fakeGateway(onlineIds = new Set<string>()) {
  return {
    isOnline: (deviceId: string) => onlineIds.has(deviceId),
    disconnect: vi.fn(),
  } as unknown as LocalDeviceGateway;
}

describe("local device routes", () => {
  it("creates and lists a paired local Mac token", async () => {
    const { cookie } = await setupSession("alice@example.com");
    const gateway = fakeGateway();
    const app = createApp(db, createTestConfig({ PORT: 3099 }), {
      logger: createTestLogger(),
      localDeviceGateway: gateway,
    });

    const createRes = await app.request("/api/local-devices", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice Mac" }),
    });

    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      plaintext: string;
      websocketUrl: string;
      device: { id: string; name: string; prefix: string; status: string };
    };
    expect(created.plaintext).toMatch(/^skl_/);
    expect(created.websocketUrl).toBe("ws://localhost:3099/api/local-devices/ws");
    expect(created.device.name).toBe("Alice Mac");
    expect(created.device.status).toBe("offline");

    const stored = await createLocalDeviceRepository(db).findActiveByHash(hashLocalDeviceToken(created.plaintext));
    expect(stored?.id).toBe(created.device.id);

    const listRes = await app.request("/api/local-devices", { headers: { Cookie: cookie } });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { devices: Array<{ id: string; name: string }> };
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({ id: created.device.id, name: "Alice Mac" });
  });

  it("does not let one user revoke another user's local device", async () => {
    const alice = await setupSession("alice@example.com");
    const bob = await setupSession("bob@example.com");
    const gateway = fakeGateway();
    const devices = createLocalDeviceRepository(db);
    const row = await devices.create({
      userId: alice.user.id,
      name: "Alice Mac",
      platform: "macos",
      tokenHash: "hash",
      prefix: "skl_1234",
    });
    const app = createApp(db, createTestConfig(), { logger: createTestLogger(), localDeviceGateway: gateway });

    const res = await app.request(`/api/local-devices/${row.id}`, {
      method: "DELETE",
      headers: { Cookie: bob.cookie },
    });

    expect(res.status).toBe(404);
    expect(gateway.disconnect).not.toHaveBeenCalled();
    expect(await devices.findActiveById(alice.user.id, row.id)).toBeDefined();
  });
});

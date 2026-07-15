import { describe, expect, it } from "vitest";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";
import {
  InProcessWhatsAppLease,
  classifyWhatsAppGatewayLease,
  whatsappGatewayExitDecision,
  whatsappGatewayHealthDecision,
  whatsappGatewayHealthMatches,
  whatsappGatewayRestartBackoffMs,
  whatsappGatewayShouldRespawn,
} from "./supervisor";

describe("InProcessWhatsAppLease", () => {
  it("guards socket open after a newer owner takes over", async () => {
    const db = await createTestDb();
    const lease = new InProcessWhatsAppLease({ db, config: createTestConfig(), logger: createTestLogger() });
    await lease.acquire();
    await expect(lease.assertOwned()).resolves.toBeUndefined();
    await db
      .updateTable("whatsapp_session_lease")
      .set({ owner_token: "new-owner", generation: 2 })
      .where("id", "=", "default")
      .execute();
    await expect(lease.assertOwned()).rejects.toThrow("session lease is not owned");
    await lease.release();
    await db.destroy();
  });
});

describe("WhatsApp gateway supervision decisions", () => {
  const lease = {
    owner_kind: "gateway",
    gateway_http_token: "token",
    host_id: "host",
    boot_id: "boot",
    script_hash: "hash",
    contract_version: "1.0",
  } as Parameters<typeof classifyWhatsAppGatewayLease>[0]["lease"];

  it("adopts only a fresh same-host lease with matching health", () => {
    expect(
      classifyWhatsAppGatewayLease({
        lease,
        hostId: "host",
        bootId: "boot",
        health: { scriptHash: "hash", contractVersion: "1.0" },
        expectedHash: "hash",
        heartbeatFresh: true,
      }),
    ).toBe("adopt");
    expect(
      classifyWhatsAppGatewayLease({
        lease,
        hostId: "other-host",
        bootId: "boot",
        health: { scriptHash: "hash", contractVersion: "1.0" },
        expectedHash: "hash",
        heartbeatFresh: true,
      }),
    ).toBe("wait");
  });

  it("replaces skew and spawns only without a fresh lease", () => {
    expect(
      classifyWhatsAppGatewayLease({
        lease,
        hostId: "host",
        bootId: "boot",
        health: { scriptHash: "old", contractVersion: "1.0" },
        expectedHash: "new",
        heartbeatFresh: true,
      }),
    ).toBe("replace");
    expect(
      classifyWhatsAppGatewayLease({
        lease,
        hostId: "host",
        bootId: "boot",
        health: { scriptHash: "hash", contractVersion: "1.0" },
        expectedHash: "hash",
        heartbeatFresh: false,
      }),
    ).toBe("spawn");
    expect(
      classifyWhatsAppGatewayLease({
        lease: null,
        hostId: "host",
        bootId: "boot",
        expectedHash: "new",
        heartbeatFresh: false,
      }),
    ).toBe("spawn");
    expect(whatsappGatewayHealthMatches({ scriptHash: "new", contractVersion: "2.0" }, "new")).toBe(false);
  });

  it("uses capped exponential backoff for unexpected exits", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(whatsappGatewayRestartBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(whatsappGatewayShouldRespawn(64)).toBe(false);
    expect(whatsappGatewayShouldRespawn(1)).toBe(true);
    expect(whatsappGatewayExitDecision(64, 1)).toEqual({ action: "re-pair" });
    expect(whatsappGatewayExitDecision(1, 6)).toEqual({ action: "respawn", delayMs: 30_000 });
  });

  it("restarts for script or contract skew", () => {
    expect(whatsappGatewayHealthDecision({ scriptHash: "old", contractVersion: "1.0" }, "new")).toBe("restart");
    expect(whatsappGatewayHealthDecision({ scriptHash: "new", contractVersion: "2.0" }, "new")).toBe("restart");
    expect(whatsappGatewayHealthDecision({ scriptHash: "new", contractVersion: "1.0" }, "new")).toBe("healthy");
  });
});

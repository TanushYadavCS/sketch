import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";
import { GatewayClientFacade } from "../gateway-client-facade";
import {
  InProcessWhatsAppLease,
  WhatsAppGatewaySupervisor,
  classifyWhatsAppGatewayLease,
  whatsappGatewayExitDecision,
  whatsappGatewayHealthDecision,
  whatsappGatewayHealthMatches,
  whatsappGatewayRestartBackoffMs,
  whatsappGatewayShouldRespawn,
} from "./supervisor";

function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

type SupervisorInternals = {
  child: ChildProcess | null;
  client: GatewayClientFacade | null;
  lease: null;
  lastHealth: Awaited<ReturnType<GatewayClientFacade["health"]>> | null;
  loggedOut: boolean;
  restarting: boolean;
  startedSuccessfully: boolean;
  onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): Promise<void>;
  restart(reason: string): Promise<void>;
  spawnAndWait(scriptPath: string, expectedHash: string): Promise<GatewayClientFacade>;
  stopGateway(): Promise<void>;
  startHealthPolling(scriptPath: string): void;
};

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

  it("clears history generation while retaining ownership after explicit logout", async () => {
    const db = await createTestDb();
    const lease = new InProcessWhatsAppLease({ db, config: createTestConfig(), logger: createTestLogger() });
    await lease.acquire();
    await db
      .updateTable("whatsapp_session_lease")
      .set({ last_live_at: "2026-07-15T08:00:00.000Z", disconnected_at: "2026-07-15T08:01:00.000Z" })
      .where("id", "=", "default")
      .execute();

    await lease.resetHistoryGeneration();

    await expect(
      db
        .selectFrom("whatsapp_session_lease")
        .select(["owner_kind", "last_live_at", "disconnected_at"])
        .where("id", "=", "default")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ owner_kind: "inprocess", last_live_at: null, disconnected_at: null });
    await expect(lease.assertOwned()).resolves.toBeUndefined();
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

describe("WhatsAppGatewaySupervisor lifecycle", () => {
  it("continues startup in pairing-required state after an initial logout exit", async () => {
    const db = await createTestDb();
    const child = fakeChild(100);
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 64, null));
      return child;
    });
    const supervisor = new WhatsAppGatewaySupervisor({
      db,
      config: createTestConfig({ WHATSAPP_RUNTIME_MODE: "gateway" }),
      logger: createTestLogger(),
      gatewayScriptPath: fileURLToPath(import.meta.url),
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });

    await expect(supervisor.start()).resolves.toBeNull();
    expect(supervisor.requiresPairing).toBe(true);

    const internals = supervisor as unknown as SupervisorInternals;
    const appFacade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      beforePairingStart: () => supervisor.ensurePairingReady().then(() => undefined),
      fetch: async () =>
        new Response('data: {"type":"qr","qr":"initial-pair-qr"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    vi.spyOn(internals, "spawnAndWait").mockImplementation(async () => {
      internals.child = fakeChild(101);
      internals.client = appFacade;
      return appFacade;
    });
    vi.spyOn(internals, "startHealthPolling").mockImplementation(() => undefined);
    const events: unknown[] = [];

    await appFacade.pairing.startQr(async (event) => {
      events.push(event);
    });

    expect(events).toEqual([{ type: "qr", qr: "initial-pair-qr" }]);
    expect(supervisor.requiresPairing).toBe(false);
    expect(spawn).toHaveBeenCalledOnce();
    await db.destroy();
  });

  it("rejects startup failures that are not logout exits", async () => {
    const db = await createTestDb();
    const supervisor = new WhatsAppGatewaySupervisor({
      db,
      config: createTestConfig({ WHATSAPP_RUNTIME_MODE: "gateway" }),
      logger: createTestLogger(),
      gatewayScriptPath: fileURLToPath(import.meta.url),
    });
    const internals = supervisor as unknown as SupervisorInternals;
    vi.spyOn(internals, "spawnAndWait").mockRejectedValue(new Error("spawn failed"));

    await expect(supervisor.start()).rejects.toThrow("spawn failed");
    expect(supervisor.requiresPairing).toBe(false);
    await db.destroy();
  });

  it("respawns on a pairing request after a logout exit and streams QR events", async () => {
    const db = await createTestDb();
    const supervisorRef: { current?: WhatsAppGatewaySupervisor } = {};
    const qrEvents: unknown[] = [];
    const appFacade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
      beforePairingStart: () => {
        if (!supervisorRef.current) throw new Error("Supervisor is unavailable");
        return supervisorRef.current.ensurePairingReady().then(() => undefined);
      },
      fetch: async () =>
        new Response('data: {"type":"qr","qr":"re-pair-qr"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    const supervisor = new WhatsAppGatewaySupervisor({
      db,
      config: createTestConfig({ WHATSAPP_RUNTIME_MODE: "gateway" }),
      logger: createTestLogger(),
      gatewayScriptPath: fileURLToPath(import.meta.url),
    });
    supervisorRef.current = supervisor;
    const internals = supervisor as unknown as SupervisorInternals;
    const loggedOutChild = fakeChild(101);
    internals.child = loggedOutChild;
    internals.client = appFacade;
    internals.startedSuccessfully = true;
    await internals.onChildExit(loggedOutChild, 64, null);
    expect(supervisor.requiresPairing).toBe(true);

    const replacement = fakeChild(102);
    const spawnAndWait = vi.spyOn(internals, "spawnAndWait").mockImplementation(async () => {
      internals.child = replacement;
      internals.client = appFacade;
      return appFacade;
    });
    vi.spyOn(internals, "startHealthPolling").mockImplementation(() => undefined);
    await appFacade.pairing.startQr(async (event) => {
      qrEvents.push(event);
    });

    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(internals.child).toBe(replacement);
    expect(supervisor.requiresPairing).toBe(false);
    expect(qrEvents).toEqual([{ type: "qr", qr: "re-pair-qr" }]);
    await db.destroy();
  });

  it("shares one spawn across concurrent pairing requests", async () => {
    const db = await createTestDb();
    const supervisor = new WhatsAppGatewaySupervisor({
      db,
      config: createTestConfig({ WHATSAPP_RUNTIME_MODE: "gateway" }),
      logger: createTestLogger(),
      gatewayScriptPath: fileURLToPath(import.meta.url),
    });
    const internals = supervisor as unknown as SupervisorInternals;
    internals.loggedOut = true;
    const facade = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
    });
    const replacement = fakeChild(103);
    const spawnAndWait = vi.spyOn(internals, "spawnAndWait").mockImplementation(async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      internals.child = replacement;
      internals.client = facade;
      return facade;
    });
    vi.spyOn(internals, "startHealthPolling").mockImplementation(() => undefined);

    const [first, second] = await Promise.all([supervisor.ensurePairingReady(), supervisor.ensurePairingReady()]);

    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    expect(first).toBe(facade);
    expect(second).toBe(facade);
    await expect(supervisor.ensurePairingReady()).resolves.toBe(facade);
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
    await db.destroy();
  });

  it("schedules another attempt when a replacement child dies before readiness", async () => {
    const db = await createTestDb();
    const sleepCalls: number[] = [];
    const supervisor = new WhatsAppGatewaySupervisor({
      db,
      config: createTestConfig({ WHATSAPP_RUNTIME_MODE: "gateway" }),
      logger: createTestLogger(),
      sleep: async (milliseconds) => {
        sleepCalls.push(milliseconds);
        await new Promise<void>(() => undefined);
      },
    });
    const internals = supervisor as unknown as SupervisorInternals;
    const replacement = fakeChild(201);
    internals.child = replacement;
    internals.client = null;
    internals.startedSuccessfully = true;
    internals.restarting = true;

    await internals.onChildExit(replacement, 1, null);

    expect(sleepCalls).toEqual([1_000]);
    await db.destroy();
  });

  it("schedules another attempt when restart throws", async () => {
    const db = await createTestDb();
    const sleepCalls: number[] = [];
    const supervisor = new WhatsAppGatewaySupervisor({
      db,
      config: createTestConfig({ WHATSAPP_RUNTIME_MODE: "gateway" }),
      logger: createTestLogger(),
      gatewayScriptPath: fileURLToPath(import.meta.url),
      sleep: async (milliseconds) => {
        sleepCalls.push(milliseconds);
        await new Promise<void>(() => undefined);
      },
    });
    const internals = supervisor as unknown as SupervisorInternals;
    internals.startedSuccessfully = true;
    vi.spyOn(internals, "stopGateway").mockResolvedValue();
    vi.spyOn(internals, "spawnAndWait").mockRejectedValue(new Error("spawn failed"));

    await expect(internals.restart("test restart failure")).rejects.toThrow("spawn failed");

    expect(sleepCalls).toEqual([1_000]);
    await db.destroy();
  });

  it("reports connectivity only from a live client with connected cached health", async () => {
    const db = await createTestDb();
    const supervisor = new WhatsAppGatewaySupervisor({
      db,
      config: createTestConfig({ WHATSAPP_RUNTIME_MODE: "gateway" }),
      logger: createTestLogger(),
    });
    const internals = supervisor as unknown as SupervisorInternals;
    internals.client = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
    });
    internals.lastHealth = {
      socketState: "connected",
      queueDepth: 0,
      insertFailures: 0,
      uptime: 1,
      scriptHash: "hash",
      contractVersion: "1.0",
    };
    expect(supervisor.isConnected).toBe(true);
    internals.lastHealth = { ...internals.lastHealth, socketState: "disconnected" };
    expect(supervisor.isConnected).toBe(false);
    internals.lastHealth = { ...internals.lastHealth, socketState: "connected" };
    internals.client = null;
    expect(supervisor.isConnected).toBe(false);
    internals.client = new GatewayClientFacade({
      baseUrl: "http://127.0.0.1:3901",
      token: "secret",
      logger: createTestLogger(),
    });
    internals.loggedOut = true;
    expect(supervisor.isConnected).toBe(false);
    await db.destroy();
  });
});

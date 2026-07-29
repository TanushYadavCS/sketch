import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OperationalAlertRow, createOperationalAlertsRepository } from "../db/repositories/operational-alerts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { channelsReconnectUrl, createOperationalAlertDefinitions } from "./definitions";
import { BAILEYS_DISCONNECT_GRACE_MS, createOperationalAlertService } from "./service";
import { BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY, OperationalAlertRetryableError } from "./types";
import { OperationalAlertWorker } from "./worker";

describe("operational alerts", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("deduplicates disconnect observations and fans out one durable delivery per WhatsApp destination", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z");
    const alerts = createOperationalAlertsRepository(db);
    const users = createUserRepository(db);
    const settings = createSettingsRepository(db);
    await settings.ensure();
    await settings.update({ orgName: "Goosebumps", botName: "Sketch" });
    await users.create({
      id: "admin-1",
      name: "Admin One",
      email: "admin-1@example.com",
      authRole: "admin",
      whatsappNumber: "+919876543210",
    });
    await users.create({
      id: "admin-2",
      name: "Admin Two",
      email: "admin-2@example.com",
      authRole: "admin",
      whatsappNumber: "+919876543211",
    });
    await users.create({
      id: "member-1",
      name: "Member",
      email: "member@example.com",
      authRole: "member",
      whatsappNumber: "+919111111111",
    });

    const service = createOperationalAlertService({ alerts, now: () => now });
    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 7,
      socketGeneration: 1,
      socketState: "disconnected",
      occurredAt: new Date(now.getTime() - BAILEYS_DISCONNECT_GRACE_MS).toISOString(),
      statusCode: 408,
    });
    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 7,
      socketGeneration: 1,
      socketState: "disconnected",
      occurredAt: new Date(now.getTime() - 60_000).toISOString(),
      statusCode: 413,
      reason: "connection_closed",
    });

    const active = await alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY);
    expect(active).toMatchObject({ state: "observing", severity: "warning" });
    expect(JSON.parse(active?.payload ?? "{}")).toMatchObject({ statusCode: 413, gatewayGeneration: 7 });
    const send = vi.fn().mockResolvedValue({ providerMessageId: "provider-message-1" });
    const worker = new OperationalAlertWorker({
      alerts,
      users,
      settings,
      definitions: createOperationalAlertDefinitions({
        isBaileysGatewayDisconnected: () => true,
        getConnectedWhatsAppNumber: () => "+91 9980470200",
        reconnectUrl: "https://goosebumps.getsketch.ai/channels",
      }),
      transports: { whatsapp: { send } },
      logger: createTestLogger(),
      now: () => now,
    });
    worker.start();
    await worker.drain();
    await worker.stop();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: expect.objectContaining({ id: "admin-1", destination: "+919876543210" }),
        orgName: "Goosebumps",
        directMessage:
          "Hi Admin One, your WhatsApp connection for +91 9980470200 needs a quick reconnect. Please rescan the QR code on https://goosebumps.getsketch.ai/channels to restore the group updates.",
        template: expect.objectContaining({
          key: "whatsapp.reconnect_notification",
          params: {
            recipientName: "Admin One",
            phoneNumber: "+91 9980470200",
            reconnectUrl: "https://goosebumps.getsketch.ai/channels",
          },
        }),
      }),
    );
    const opened = await alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY);
    expect(opened?.state).toBe("open");
    const deliveries = await alerts.listDeliveries(opened?.id ?? "missing");
    expect(deliveries).toHaveLength(2);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "sent", attempts: 0, provider_message_id: "provider-message-1" }),
      ]),
    );

    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 7,
      socketGeneration: 2,
      socketState: "connected",
      occurredAt: new Date(now.getTime() + 1_000).toISOString(),
    });
    await expect(
      alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY),
    ).resolves.toBeUndefined();
  });

  it("resolves a transient disconnect before fan-out and retries provider failures", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z");
    const alerts = createOperationalAlertsRepository(db);
    const users = createUserRepository(db);
    const settings = createSettingsRepository(db);
    await settings.ensure();
    await users.create({
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      authRole: "admin",
      whatsappNumber: "+919876543210",
    });
    const service = createOperationalAlertService({ alerts, now: () => now });
    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 1,
      socketGeneration: 1,
      socketState: "disconnected",
      occurredAt: now.toISOString(),
    });

    const transport = {
      send: vi.fn().mockRejectedValue(Object.assign(new Error("provider unavailable"), { providerCode: "503" })),
    };
    const worker = new OperationalAlertWorker({
      alerts,
      users,
      settings,
      definitions: createOperationalAlertDefinitions({ isBaileysGatewayDisconnected: () => false }),
      transports: { whatsapp: transport },
      logger: createTestLogger(),
      now: () => new Date(now.getTime() + BAILEYS_DISCONNECT_GRACE_MS),
    });
    worker.start();
    await worker.drain();
    await worker.stop();
    expect(transport.send).not.toHaveBeenCalled();

    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 2,
      socketGeneration: 1,
      socketState: "logged-out",
      occurredAt: now.toISOString(),
      statusCode: 401,
    });
    const retryWorker = new OperationalAlertWorker({
      alerts,
      users,
      settings,
      definitions: createOperationalAlertDefinitions({ isBaileysGatewayDisconnected: () => true }),
      transports: { whatsapp: transport },
      logger: createTestLogger(),
      now: () => now,
    });
    retryWorker.start();
    await retryWorker.drain();
    await retryWorker.stop();

    expect(transport.send).toHaveBeenCalledTimes(1);
    const active = await alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY);
    await expect(alerts.listDeliveries(active?.id ?? "missing")).resolves.toEqual([
      expect.objectContaining({ state: "retry", attempts: 1, last_error_code: "503" }),
    ]);
  });

  it("reconciles a persisted open alert before fan-out after startup recovery", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z");
    const alerts = createOperationalAlertsRepository(db);
    const users = createUserRepository(db);
    const settings = createSettingsRepository(db);
    await settings.ensure();
    await users.create({
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      authRole: "admin",
      whatsappNumber: "+919876543210",
    });
    const service = createOperationalAlertService({ alerts, now: () => now });
    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 1,
      socketGeneration: 1,
      socketState: "logged-out",
      occurredAt: now.toISOString(),
      statusCode: 401,
    });
    const active = await alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY);
    expect(active).toBeDefined();
    await alerts.promote(active?.id ?? "missing", now.toISOString());

    const send = vi.fn().mockResolvedValue({ providerMessageId: "stale-alert" });
    const worker = new OperationalAlertWorker({
      alerts,
      users,
      settings,
      definitions: createOperationalAlertDefinitions({ isBaileysGatewayDisconnected: () => false }),
      transports: { whatsapp: { send } },
      logger: createTestLogger(),
      now: () => new Date(now.getTime() + 1_000),
    });
    await worker.drain();
    await worker.stop();

    expect(send).not.toHaveBeenCalled();
    await expect(
      alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY),
    ).resolves.toBeUndefined();
    await expect(alerts.listDeliveries(active?.id ?? "missing")).resolves.toEqual([]);
  });

  it("does not resolve a replacement outage when reconciling a stale alert row", async () => {
    const now = new Date("2026-07-17T10:00:00.000Z");
    const alerts = createOperationalAlertsRepository(db);
    const service = createOperationalAlertService({ alerts, now: () => now });
    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 1,
      socketGeneration: 1,
      socketState: "logged-out",
      occurredAt: now.toISOString(),
    });
    const stale = await alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY);
    expect(stale).toBeDefined();
    await alerts.resolveById(stale?.id ?? "missing", new Date(now.getTime() + 1_000).toISOString());

    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 2,
      socketGeneration: 2,
      socketState: "disconnected",
      occurredAt: new Date(now.getTime() + 2_000).toISOString(),
      statusCode: 413,
    });
    const replacement = await alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY);
    expect(replacement?.id).not.toBe(stale?.id);

    await alerts.resolveById(stale?.id ?? "missing", new Date(now.getTime() + 3_000).toISOString());

    await expect(
      alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY),
    ).resolves.toMatchObject({ id: replacement?.id, state: "observing" });
  });

  it("keeps an opened disconnect alert retryable through a long outage and delivers it after recovery", async () => {
    let now = new Date("2026-07-17T10:00:00.000Z");
    const alerts = createOperationalAlertsRepository(db);
    const users = createUserRepository(db);
    const settings = createSettingsRepository(db);
    await settings.ensure();
    await users.create({
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      authRole: "admin",
      whatsappNumber: "+919876543210",
    });
    const service = createOperationalAlertService({ alerts, now: () => now });
    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 1,
      socketGeneration: 1,
      socketState: "logged-out",
      occurredAt: now.toISOString(),
      statusCode: 401,
    });
    const transport = {
      send: vi
        .fn()
        .mockRejectedValue(new OperationalAlertRetryableError("socket unavailable", "transport_unavailable")),
    };
    const worker = new OperationalAlertWorker({
      alerts,
      users,
      settings,
      definitions: createOperationalAlertDefinitions({ isBaileysGatewayDisconnected: () => true }),
      transports: { whatsapp: transport },
      logger: createTestLogger(),
      now: () => now,
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await worker.drain();
      now = new Date(now.getTime() + 60 * 60_000);
    }

    const active = await alerts.findActive(BAILEYS_DISCONNECTED_ALERT_TYPE, BAILEYS_GATEWAY_RESOURCE_KEY);
    await expect(alerts.listDeliveries(active?.id ?? "missing")).resolves.toEqual([
      expect.objectContaining({ state: "retry", attempts: 6, last_error_code: "transport_unavailable" }),
    ]);

    await service.observeBaileysSocketState({
      ownerToken: "owner",
      generation: 2,
      socketGeneration: 1,
      socketState: "connected",
      occurredAt: now.toISOString(),
    });
    transport.send.mockResolvedValue({ providerMessageId: "recovery-message" });
    await worker.drain();
    await worker.stop();

    const recoverySend = transport.send.mock.calls.at(-1)?.[0] as { directMessage: string; template?: unknown };
    expect(recoverySend.directMessage).toContain("is now reconnected");
    expect(recoverySend.directMessage).not.toContain(now.toISOString());
    expect(recoverySend.template).toBeUndefined();
    await expect(alerts.listDeliveries(active?.id ?? "missing")).resolves.toEqual([
      expect.objectContaining({ state: "sent", attempts: 0, provider_message_id: "recovery-message" }),
    ]);
  });

  it("contains persistence failures so alert monitoring cannot interrupt the socket lifecycle", async () => {
    const alerts = createOperationalAlertsRepository(db);
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    vi.spyOn(alerts, "observe").mockRejectedValue(new Error("database unavailable"));
    const service = createOperationalAlertService({ alerts, logger });

    await expect(
      service.observeBaileysSocketState({
        ownerToken: "owner",
        generation: 1,
        socketGeneration: 1,
        socketState: "disconnected",
        statusCode: 413,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ socketState: "disconnected", statusCode: 413 }),
      "Operational alert observation failed",
    );
  });
});

describe("baileys disconnect alert copy", () => {
  const context = { orgName: "Goosebumps", botName: "Sketch", recipientName: "Ashish" };
  const alertRow = {
    payload: JSON.stringify({
      version: 1,
      socketState: "disconnected",
      occurredAt: "2026-07-29T06:55:47.436Z",
      statusCode: 428,
      reason: "inprocess_disconnected",
    }),
    resolved_at: null,
  } as OperationalAlertRow;

  it("falls back to the org name and a described location when the number and URL are unavailable", async () => {
    const definitions = createOperationalAlertDefinitions({
      isBaileysGatewayDisconnected: () => true,
      getConnectedWhatsAppNumber: () => {
        throw new Error("gateway down");
      },
    });
    const definition = definitions.get(BAILEYS_DISCONNECTED_ALERT_TYPE);
    const rendered = await definition?.render(alertRow, context);

    expect(rendered?.directMessage).toBe(
      "Hi Ashish, your WhatsApp connection for Goosebumps needs a quick reconnect. Please rescan the QR code on Settings > Channels in your Sketch dashboard to restore the group updates.",
    );
    expect(rendered?.template?.params).toMatchObject({ phoneNumber: "Goosebumps" });
  });

  it("never leaks technical jargon into the delivered copy", async () => {
    const definitions = createOperationalAlertDefinitions({
      isBaileysGatewayDisconnected: () => true,
      getConnectedWhatsAppNumber: () => "+91 9980470200",
      reconnectUrl: "https://goosebumps.getsketch.ai/channels",
    });
    const definition = definitions.get(BAILEYS_DISCONNECTED_ALERT_TYPE);
    const rendered = await definition?.render(alertRow, context);

    for (const text of [rendered?.directMessage ?? "", rendered?.templateSummary ?? ""]) {
      expect(text).not.toMatch(/baileys|status code|428|inprocess_disconnected|\d{4}-\d{2}-\d{2}T/i);
    }
  });
});

describe("channelsReconnectUrl", () => {
  it("builds the channels page URL from a configured base URL", () => {
    expect(channelsReconnectUrl("https://goosebumps.getsketch.ai")).toBe("https://goosebumps.getsketch.ai/channels");
    expect(channelsReconnectUrl("https://goosebumps.getsketch.ai/")).toBe("https://goosebumps.getsketch.ai/channels");
  });

  it("returns null for missing or malformed base URLs", () => {
    expect(channelsReconnectUrl(undefined)).toBeNull();
    expect(channelsReconnectUrl("")).toBeNull();
    expect(channelsReconnectUrl("not a url")).toBeNull();
    expect(channelsReconnectUrl("ftp://example.com")).toBeNull();
  });
});

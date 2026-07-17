import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppInboundEventsRepository } from "../db/repositories/whatsapp-inbound-events";
import { createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppAdapterHandlers } from "./adapter";
import { whatsAppHistoryBatchEnvelopeSchema, whatsAppMessageEnvelopeSchema } from "./facade-contract";
import { WhatsAppInboundConsumer, moveWhatsAppStagedMedia } from "./inbound-consumer";
import { createWhatsAppRuntime } from "./runtime";

function messageEnvelope(id: string | null, eventKey = id ? `event-${id}` : null) {
  return whatsAppMessageEnvelopeSchema.parse({
    version: "1.1",
    kind: "message",
    providerTimestamp: "2026-07-15T08:27:00.000Z",
    providerConversationId: "15551234567@s.whatsapp.net",
    providerMessageId: id,
    eventKey,
    fromMe: false,
    message: {
      type: "dm",
      text: "hello",
      jid: "15551234567@s.whatsapp.net",
      messageId: id ?? "",
      pushName: "Roopak",
      phoneNumber: "+15551234567",
      rawProviderPayload: { key: { id, remoteJid: "15551234567@s.whatsapp.net", fromMe: false } },
      stagedMediaRef: null,
      mediaStagingError: null,
    },
  });
}

function groupEnvelope(id: string, eventKey = `event-${id}`) {
  return whatsAppMessageEnvelopeSchema.parse({
    ...messageEnvelope(id, eventKey),
    providerConversationId: "120363000000001@g.us",
    message: {
      type: "group",
      text: "hello group",
      jid: "120363000000001@g.us",
      messageId: id,
      pushName: "Roopak",
      isMentioned: true,
      senderJid: "15551234567@s.whatsapp.net",
      senderPhone: "+15551234567",
      rawProviderPayload: {
        key: {
          id,
          remoteJid: "120363000000001@g.us",
          participant: "15551234567@s.whatsapp.net",
          fromMe: false,
        },
      },
      stagedMediaRef: null,
      mediaStagingError: null,
    },
  });
}

function providerFilter(dmProviderId: string, groupProviderId: string) {
  return createWhatsAppRuntime({
    dmProviderId,
    groupProviderId,
    dmProviders: [],
    groupProviders: [],
    inboundProviders: [],
    logger: createTestLogger(),
  }).shouldHandleInboundMessage;
}

function handlers(overrides: Partial<WhatsAppAdapterHandlers> = {}): WhatsAppAdapterHandlers {
  return {
    captureQueuedMessage: async () => null,
    dispatchCapturedMessage: async () => true,
    handleHistoryMessages: async () => ({ persisted: 0, skippedOld: 0, skippedDup: 0 }),
    ...overrides,
  };
}

describe("WhatsAppInboundConsumer", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let stagingDir: string;

  beforeEach(async () => {
    db = await createTestDb();
    stagingDir = await mkdtemp(join(tmpdir(), "sketch-wa-consumer-"));
  });

  afterEach(async () => {
    await db.destroy();
    await rm(stagingDir, { recursive: true, force: true });
  });

  it("keeps an admitted message dispatched until the queued run starts", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-one",
      providerMessageId: "one",
      envelope: JSON.stringify(messageEnvelope("one", "event-one")),
    });
    let dispatched = 0;
    let statusAtDispatch: string | undefined;
    let onRunStart: (() => Promise<void>) | undefined;
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        dispatchCapturedMessage: async (_message, _capture, hooks) => {
          statusAtDispatch = (
            await db
              .selectFrom("whatsapp_inbound_events")
              .select("status")
              .where("id", "=", inserted.row.id)
              .executeTakeFirst()
          )?.status;
          onRunStart = hooks.onRunStart;
          dispatched += 1;
          return true;
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();

    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["status", "attempts"])
      .where("id", "=", inserted.row.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "dispatched", attempts: 1 });
    expect(statusAtDispatch).toBe("dispatched");
    expect(dispatched).toBe(1);
    await onRunStart?.();
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select(["status", "consumed_at"])
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "consumed", consumed_at: expect.any(String) });
  });

  it("resets a dispatched row on boot and reclaims and redispatches it", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-restart",
      providerMessageId: "restart",
      envelope: JSON.stringify(messageEnvelope("restart", "event-restart")),
    });
    const dispatchStatuses: string[] = [];
    let dispatchCount = 0;
    const makeConsumer = () =>
      new WhatsAppInboundConsumer({
        db,
        logger: createTestLogger(),
        stagingDir,
        shouldHandleInboundMessage: () => true,
        handlers: handlers({
          dispatchCapturedMessage: async (_message, _capture, hooks) => {
            dispatchStatuses.push(
              (
                await db
                  .selectFrom("whatsapp_inbound_events")
                  .select("status")
                  .where("id", "=", inserted.row.id)
                  .executeTakeFirstOrThrow()
              ).status,
            );
            dispatchCount += 1;
            if (dispatchCount === 2) await hooks.onRunStart();
            return true;
          },
        }),
      });

    const firstConsumer = makeConsumer();
    firstConsumer.start();
    await firstConsumer.wake();
    await firstConsumer.stop();
    await expect(repo.resetDispatched()).resolves.toBe(1);

    const restartedConsumer = makeConsumer();
    restartedConsumer.start();
    await restartedConsumer.wake();
    await restartedConsumer.stop();

    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select(["status", "attempts"])
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "consumed", attempts: 2 });
    expect(dispatchStatuses).toEqual(["dispatched", "dispatched"]);
  });

  it("warns and continues when a queued run starts after losing durable ownership", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-lost-token",
      providerMessageId: "lost-token",
      envelope: JSON.stringify(messageEnvelope("lost-token", "event-lost-token")),
    });
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    let continued = false;
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger,
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        dispatchCapturedMessage: async (_message, _capture, hooks) => {
          await db
            .updateTable("whatsapp_inbound_events")
            .set({ status: "captured", claim_token: null })
            .where("id", "=", inserted.row.id)
            .execute();
          await hooks.onRunStart();
          continued = true;
          return true;
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();

    expect(continued).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      { inboundEventId: inserted.row.id },
      "WhatsApp inbound event dispatch started after durable claim ownership was lost",
    );
  });

  it("survives a failing claim without rejecting the poll loop", async () => {
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers(),
    });
    await db.schema.dropTable("whatsapp_inbound_events").execute();
    consumer.start();
    await expect(consumer.wake()).resolves.toBeUndefined();
    await consumer.stop();
  });

  it("reverts a shed dispatch to captured with backoff", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-shed",
      providerMessageId: "shed",
      envelope: JSON.stringify(messageEnvelope("shed", "event-shed")),
    });
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({ dispatchCapturedMessage: async () => false }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();
    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["status", "last_error"])
      .where("id", "=", inserted.row.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("captured");
    expect(row.last_error).toBe("channel queue shed inbound event");
  });

  it("serializes overlapping wake and poll triggers", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-overlap",
      providerMessageId: "overlap",
      envelope: JSON.stringify(messageEnvelope("overlap", "event-overlap")),
    });
    let captures = 0;
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        captureQueuedMessage: async () => {
          captures += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return null;
        },
      }),
    });
    consumer.start();
    await Promise.all([consumer.wake(), consumer.wake()]);
    await consumer.stop();
    expect(captures).toBe(1);
  });

  it("captures but never dispatches a message without a provider id", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      providerMessageId: null,
      envelope: JSON.stringify(messageEnvelope(null)),
    });
    let dispatched = false;
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        dispatchCapturedMessage: async () => {
          dispatched = true;
          return true;
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();
    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select("status")
      .where("id", "=", inserted.row.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("consumed");
    expect(dispatched).toBe(false);
    expect(consumer.missingProviderIdEvents).toBe(1);
  });

  it("captures and consumes a fromMe envelope without dispatching it", async () => {
    const envelope = messageEnvelope("outbound", "event-outbound");
    envelope.fromMe = true;
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "history_message",
      origin: "gateway",
      eventKey: "event-outbound",
      providerMessageId: "outbound",
      envelope: JSON.stringify(envelope),
    });
    let captured = 0;
    let dispatched = 0;
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger,
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        captureQueuedMessage: async () => {
          captured += 1;
          return null;
        },
        dispatchCapturedMessage: async () => {
          dispatched += 1;
          return true;
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();

    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select("status")
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "consumed" });
    expect(captured).toBe(1);
    expect(dispatched).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      { inboundEventId: inserted.row.id },
      "Captured outbound WhatsApp event from the durable inbound queue; dispatch skipped",
    );
  });

  it("records the first live group boundary once and ignores promoted history for the boundary", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const history = groupEnvelope("boundary-history");
    history.kind = "history_message";
    const firstLive = groupEnvelope("boundary-live-first");
    const secondLive = groupEnvelope("boundary-live-second");
    await repo.insert({
      kind: "history_message",
      origin: "gateway",
      eventKey: history.eventKey,
      providerMessageId: history.providerMessageId,
      envelope: JSON.stringify(history),
    });
    await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: firstLive.eventKey,
      providerMessageId: firstLive.providerMessageId,
      envelope: JSON.stringify(firstLive),
    });
    await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: secondLive.eventKey,
      providerMessageId: secondLive.providerMessageId,
      envelope: JSON.stringify(secondLive),
    });
    const effectiveById = new Map([
      ["boundary-history", "2026-07-15T08:20:00.000Z"],
      ["boundary-live-first", "2026-07-15T08:27:00.000Z"],
      ["boundary-live-second", "2026-07-15T08:28:00.000Z"],
    ]);
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        captureQueuedMessage: async (message, params) => {
          if (!params.commitCapture) throw new Error("expected transactional capture");
          return params.commitCapture(async (conversationRepository) => {
            const conversation = await conversationRepository.getOrCreate({
              platform: "whatsapp",
              kind: "group",
              providerConversationId: "120363000000001@g.us",
            });
            const captured = await conversationRepository.captureOrGet({
              conversationId: conversation.id,
              providerMessageId: message.providerMessageId,
              eventKey: params.eventKey,
              senderJid: message.senderProviderId,
              senderName: message.senderName,
              text: message.text,
              receivedAt: effectiveById.get(message.providerMessageId),
              source: params.source,
              connectionKey: params.connectionKey,
            });
            return { conversation, captured, attachments: [], inserted: true, omitted: false };
          });
        },
        dispatchCapturedMessage: async (_message, _capture, hooks) => {
          await hooks.onRunStart();
          return true;
        },
      }),
    });

    consumer.start();
    await consumer.wake();
    await consumer.stop();

    const messages = await createConversationRepository(db).listMessages(
      (
        await db
          .selectFrom("conversations")
          .select("id")
          .where("provider_conversation_id", "=", "120363000000001@g.us")
          .executeTakeFirstOrThrow()
      ).id,
      { includeBotMessages: true },
    );
    const firstLiveRow = messages.messages.find((message) => message.providerMessageId === "boundary-live-first");
    const checkpoint = await db
      .selectFrom("whatsapp_backfill_checkpoints")
      .selectAll()
      .where("group_jid", "=", "120363000000001@g.us")
      .executeTakeFirstOrThrow();
    const initialRange = await db
      .selectFrom("whatsapp_backfill_ranges")
      .select(["kind", "status", "upper_bound_at"])
      .where("group_jid", "=", "120363000000001@g.us")
      .where("range_key", "=", "initial")
      .executeTakeFirstOrThrow();
    expect(messages.messages.map((message) => message.source)).toEqual(["history", "live", "live"]);
    expect(checkpoint).toMatchObject({
      live_start_effective_at: "2026-07-15T08:27:00.000Z",
      live_start_message_id: firstLiveRow?.id,
    });
    expect(initialRange).toMatchObject({
      kind: "initial",
      upper_bound_at: "2026-07-15T08:27:00.000Z",
    });
  });

  it("terminally consumes a Baileys DM when the configured DM provider is Wati", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const envelope = messageEnvelope("filtered-dm", "event-filtered-dm");
    envelope.kind = "history_message";
    const inserted = await repo.insert({
      kind: "history_message",
      origin: "gateway",
      eventKey: "event-filtered-dm",
      providerMessageId: "filtered-dm",
      envelope: JSON.stringify(envelope),
    });
    const logger = createTestLogger();
    const info = vi.spyOn(logger, "info");
    const captureQueuedMessage = vi.fn(async () => null);
    const dispatchCapturedMessage = vi.fn(async () => true);
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger,
      stagingDir,
      shouldHandleInboundMessage: providerFilter("wati", "baileys"),
      handlers: handlers({ captureQueuedMessage, dispatchCapturedMessage }),
    });

    consumer.start();
    await consumer.wake();
    await consumer.stop();

    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select(["status", "attempts", "consumed_at"])
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "consumed", attempts: 1, consumed_at: expect.any(String) });
    expect(captureQueuedMessage).not.toHaveBeenCalled();
    expect(dispatchCapturedMessage).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { inboundEventId: inserted.row.id, messageKind: "dm" },
      "Consumed WhatsApp inbound event disabled by provider configuration",
    );
  });

  it("terminally consumes a Baileys group message when groups are disabled", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-filtered-group",
      providerMessageId: "filtered-group",
      envelope: JSON.stringify(groupEnvelope("filtered-group")),
    });
    const captureQueuedMessage = vi.fn(async () => null);
    const dispatchCapturedMessage = vi.fn(async () => true);
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: providerFilter("baileys", "none"),
      handlers: handlers({ captureQueuedMessage, dispatchCapturedMessage }),
    });

    consumer.start();
    await consumer.wake();
    await consumer.stop();

    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select("status")
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "consumed" });
    expect(captureQueuedMessage).not.toHaveBeenCalled();
    expect(dispatchCapturedMessage).not.toHaveBeenCalled();
  });

  it("does not index a history batch whose message kind is disabled", async () => {
    const envelope = whatsAppHistoryBatchEnvelopeSchema.parse({
      version: "1.0",
      kind: "history_batch",
      providerTimestamp: "2026-07-15T08:27:00.000Z",
      batch: {
        batchId: "filtered-history",
        chunkIndex: 0,
        chunkCount: 1,
        syncType: 1,
        progress: 100,
        isLatest: true,
      },
      messages: [groupEnvelope("filtered-history-group")],
    });
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "history_batch",
      origin: "gateway",
      envelope: JSON.stringify(envelope),
      batchId: "filtered-history",
      chunkIndex: 0,
      chunkCount: 1,
    });
    const handleHistoryMessages = vi.fn(async () => ({ persisted: 0, skippedOld: 0, skippedDup: 0 }));
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: providerFilter("baileys", "none"),
      handlers: handlers({ handleHistoryMessages }),
    });

    consumer.start();
    await consumer.wake();
    await consumer.stop();

    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select("status")
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "consumed" });
    expect(handleHistoryMessages).not.toHaveBeenCalled();
  });

  it("dead-letters after five failed processing attempts", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-dead-five",
      providerMessageId: "dead-five",
      envelope: JSON.stringify(messageEnvelope("dead-five", "event-dead-five")),
    });
    let failures = 0;
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        captureQueuedMessage: async () => {
          failures += 1;
          throw new Error("capture failed");
        },
      }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      consumer.start();
      await consumer.wake();
      await consumer.stop();
      await db
        .updateTable("whatsapp_inbound_events")
        .set({ next_attempt_at: "2000-01-01T00:00:00.000Z" })
        .where("id", "=", inserted.row.id)
        .execute();
    }
    consumer.start();
    await consumer.wake();
    await consumer.stop();
    const row = await db
      .selectFrom("whatsapp_inbound_events")
      .select(["status", "attempts", "last_error"])
      .where("id", "=", inserted.row.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "dead", attempts: 5, last_error: "capture failed" });
    expect(failures).toBe(5);
  });

  it("marks missing staged media dead immediately", async () => {
    const envelope = messageEnvelope("missing-media", "event-missing-media");
    envelope.message.stagedMediaRef = {
      stagedPath: join(stagingDir, "missing.bin"),
      mime: "application/octet-stream",
      size: 5,
      sha256: createHash("sha256").update("media").digest("hex"),
    };
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: "event-missing-media",
      providerMessageId: "missing-media",
      envelope: JSON.stringify(envelope),
    });
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        captureQueuedMessage: async (_message, params) => {
          await params.attachmentsForWorkspace?.(join(stagingDir, "workspace"));
          return null;
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select(["status", "last_error", "attempts"])
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "dead", last_error: "staged media missing", attempts: 1 });
  });

  it("captures and dispatches message text without a permanently failed staged attachment", async () => {
    const envelope = messageEnvelope("staging-error", "event-staging-error");
    envelope.message.mediaStagingError = "gateway media download failed";
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: envelope.eventKey,
      providerMessageId: envelope.providerMessageId,
      envelope: JSON.stringify(envelope),
    });
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    let capturedAttachments: unknown;
    let dispatchedText: string | undefined;
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger,
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        captureQueuedMessage: async (message, params) => {
          expect(message.text).toBe("hello");
          capturedAttachments = await params.attachmentsForWorkspace?.(join(stagingDir, "workspace"));
          return null;
        },
        dispatchCapturedMessage: async (message, _capture, hooks) => {
          dispatchedText = message.text;
          await hooks.onRunStart();
          return true;
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();

    expect(capturedAttachments).toEqual([]);
    expect(dispatchedText).toBe("hello");
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select("status")
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "consumed" });
    expect(warn).toHaveBeenCalledWith(
      { inboundEventId: inserted.row.id, mediaStagingError: "gateway media download failed" },
      "Stored WhatsApp media staging failed; continuing without attachment",
    );
  });

  it("processes history text without a permanently failed staged attachment", async () => {
    const item = messageEnvelope("history-staging-error", "event-history-staging-error");
    item.message.mediaStagingError = "gateway history media download failed";
    const envelope = whatsAppHistoryBatchEnvelopeSchema.parse({
      version: "1.0",
      kind: "history_batch",
      providerTimestamp: "2026-07-15T08:27:00.000Z",
      batch: {
        batchId: "media-error-batch",
        chunkIndex: 0,
        chunkCount: 1,
        syncType: 1,
        progress: 100,
        isLatest: true,
      },
      messages: [item],
    });
    const repo = createWhatsAppInboundEventsRepository(db);
    const inserted = await repo.insert({
      kind: "history_batch",
      origin: "gateway",
      envelope: JSON.stringify(envelope),
      batchId: "media-error-batch",
      chunkIndex: 0,
      chunkCount: 1,
    });
    let historyCaptureMetadata: unknown;
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        handleHistoryMessages: async (messages, _metadata, options) => {
          expect(messages.map((message) => message.text)).toEqual(["hello"]);
          historyCaptureMetadata = options?.captureMetadataForMessage?.(messages[0]);
          return { persisted: 1, skippedOld: 0, skippedDup: 0 };
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();

    expect(historyCaptureMetadata).toEqual({
      eventKey: "event-history-staging-error",
      connectionKey: null,
      fromMe: false,
    });
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select("status")
        .where("id", "=", inserted.row.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "consumed" });
  });

  it("only exposes completion progress to the final history chunk", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const progress: Array<number | null | undefined> = [];
    const checkpoints: Array<boolean | undefined> = [];
    for (const chunkIndex of [0, 1]) {
      const envelope = whatsAppHistoryBatchEnvelopeSchema.parse({
        version: "1.0",
        kind: "history_batch",
        providerTimestamp: `2026-07-15T08:27:0${chunkIndex}.000Z`,
        batch: { batchId: "batch", chunkIndex, chunkCount: 2, syncType: 1, progress: 100, isLatest: true },
        messages: [messageEnvelope(`history-${chunkIndex}`, `history-event-${chunkIndex}`)],
      });
      await repo.insert({
        kind: "history_batch",
        origin: "gateway",
        envelope: JSON.stringify(envelope),
        batchId: "batch",
        chunkIndex,
        chunkCount: 2,
      });
    }
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({
        handleHistoryMessages: async (_messages, metadata, options) => {
          progress.push(metadata?.progress);
          checkpoints.push(options?.checkpoint);
          return { persisted: 1, skippedOld: 0, skippedDup: 0 };
        },
      }),
    });
    consumer.start();
    await consumer.wake();
    await consumer.stop();
    expect(progress).toEqual([99, 100]);
    expect(checkpoints).toEqual([false, true]);
  });

  it("stages on-demand history without blocking the following live dispatch", async () => {
    const repo = createWhatsAppInboundEventsRepository(db);
    const history = whatsAppHistoryBatchEnvelopeSchema.parse({
      version: "1.1",
      kind: "history_batch",
      providerTimestamp: "2026-07-15T08:20:00.000Z",
      connectionKey: "000000000001:000000000002",
      batch: {
        batchId: "batch-on-demand",
        chunkIndex: 0,
        chunkCount: 1,
        syncType: 6,
        progress: null,
        isLatest: null,
        peerDataRequestSessionId: "request-on-demand",
      },
      messages: [],
    });
    const staged = await repo.insert({
      kind: "history_batch",
      origin: "gateway",
      envelope: JSON.stringify(history),
      batchId: "batch-on-demand",
      chunkIndex: 0,
      chunkCount: 1,
      requestSessionId: "request-on-demand",
    });
    const live = messageEnvelope("live-after-fetch", "event-live-after-fetch");
    const liveRow = await repo.insert({
      kind: "message",
      origin: "gateway",
      eventKey: live.eventKey,
      providerMessageId: live.providerMessageId,
      envelope: JSON.stringify(live),
    });
    const dispatchCapturedMessage = vi.fn(async (_message, _capture, hooks) => {
      await hooks.onRunStart();
      return true;
    });
    const handleHistoryMessages = vi.fn(async () => ({ persisted: 0, skippedOld: 0, skippedDup: 0 }));
    const backfillWorker = {
      correlateOnDemandSession: vi.fn(async () => true),
      handleOnDemandResponse: vi.fn(async () => true),
      adoptPassiveHistory: vi.fn(async () => undefined),
    };
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      shouldHandleInboundMessage: () => true,
      handlers: handlers({ dispatchCapturedMessage, handleHistoryMessages }),
      backfillWorker,
    });

    consumer.start();
    await consumer.wake();
    await consumer.stop();

    expect(handleHistoryMessages).not.toHaveBeenCalled();
    expect(backfillWorker.handleOnDemandResponse).toHaveBeenCalledWith("request-on-demand");
    expect(dispatchCapturedMessage).toHaveBeenCalledTimes(1);
    await expect(
      db
        .selectFrom("whatsapp_inbound_events")
        .select(["id", "status"])
        .where("id", "in", [staged.row.id, liveRow.row.id])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      { id: staged.row.id, status: "consumed" },
      { id: liveRow.row.id, status: "consumed" },
    ]);
  });
});

describe("moveWhatsAppStagedMedia", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sketch-wa-media-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is idempotent when a crash occurs after rename", async () => {
    const stagingDir = join(root, "staging");
    const workspaceDir = join(root, "workspace");
    await mkdir(stagingDir, { recursive: true });
    const stagedPath = join(stagingDir, "media.txt");
    await writeFile(stagedPath, "media");
    const hash = "721c9525f8a9b5b7f2f981bca5c98c4a9c2b7f4f1d4e946c4377ab711d24f6d8";
    const ref = { stagedPath, mime: "text/plain", size: 5, sha256: hash, originalName: "media.txt" };
    const actualHash = createHash("sha256").update("media").digest("hex");
    ref.sha256 = actualHash;

    const first = await moveWhatsAppStagedMedia({ ref, eventKey: "event", workspaceDir, stagingDir });
    const second = await moveWhatsAppStagedMedia({ ref, eventKey: "event", workspaceDir, stagingDir });
    expect(second).toEqual(first);
    expect(await readFile(second.localPath, "utf8")).toBe("media");
  });

  it("replays safely when a crash leaves the staged file before rename", async () => {
    const stagingDir = join(root, "staging");
    const workspaceDir = join(root, "workspace");
    await mkdir(stagingDir, { recursive: true });
    const stagedPath = join(stagingDir, "before-rename.txt");
    await writeFile(stagedPath, "media");
    const ref = {
      stagedPath,
      mime: "text/plain",
      size: 5,
      sha256: createHash("sha256").update("media").digest("hex"),
      originalName: "before-rename.txt",
    };
    const moved = await moveWhatsAppStagedMedia({ ref, eventKey: "event", workspaceDir, stagingDir });
    expect(await readFile(moved.localPath, "utf8")).toBe("media");
  });

  it("rejects staging-root escapes and verifies sha256 before rename", async () => {
    const stagingDir = join(root, "staging");
    const workspaceDir = join(root, "workspace");
    await mkdir(stagingDir, { recursive: true });
    const outsidePath = join(root, "outside.txt");
    const linkedPath = join(stagingDir, "linked.txt");
    await writeFile(outsidePath, "media");
    await symlink(outsidePath, linkedPath);
    const ref = {
      stagedPath: linkedPath,
      mime: "text/plain",
      size: 5,
      sha256: createHash("sha256").update("media").digest("hex"),
      originalName: "linked.txt",
    };
    await expect(moveWhatsAppStagedMedia({ ref, eventKey: "event", workspaceDir, stagingDir })).rejects.toThrow(
      "escaped the staging root",
    );
    await rm(linkedPath);
    await writeFile(linkedPath, "media");
    await expect(
      moveWhatsAppStagedMedia({
        ref: { ...ref, sha256: "0".repeat(64) },
        eventKey: "event",
        workspaceDir,
        stagingDir,
      }),
    ).rejects.toThrow("hash or size mismatch");
  });

  it("rejects a symlinked attachments directory that escapes the workspace", async () => {
    const stagingDir = join(root, "staging");
    const workspaceDir = join(root, "workspace");
    const outsideDir = join(root, "outside");
    await mkdir(stagingDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, join(workspaceDir, "attachments"));
    const stagedPath = join(stagingDir, "media.txt");
    await writeFile(stagedPath, "media");
    const ref = {
      stagedPath,
      mime: "text/plain",
      size: 5,
      sha256: createHash("sha256").update("media").digest("hex"),
      originalName: "media.txt",
    };

    await expect(moveWhatsAppStagedMedia({ ref, eventKey: "event", workspaceDir, stagingDir })).rejects.toThrow(
      "attachment directory escaped the workspace root",
    );
    await expect(readFile(stagedPath, "utf8")).resolves.toBe("media");
  });
});

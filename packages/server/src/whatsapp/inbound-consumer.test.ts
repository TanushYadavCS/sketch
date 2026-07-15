import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWhatsAppInboundEventsRepository } from "../db/repositories/whatsapp-inbound-events";
import { createTestDb, createTestLogger } from "../test-utils";
import type { WhatsAppAdapterHandlers } from "./adapter";
import { whatsAppHistoryBatchEnvelopeSchema, whatsAppMessageEnvelopeSchema } from "./facade-contract";
import { WhatsAppInboundConsumer, moveWhatsAppStagedMedia } from "./inbound-consumer";

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

  it("captures, consumes, then dispatches a pending message", async () => {
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
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
      handlers: handlers({
        dispatchCapturedMessage: async () => {
          statusAtDispatch = (
            await db
              .selectFrom("whatsapp_inbound_events")
              .select("status")
              .where("id", "=", inserted.row.id)
              .executeTakeFirst()
          )?.status;
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
    expect(row).toEqual({ status: "consumed", attempts: 1 });
    expect(statusAtDispatch).toBe("consumed");
    expect(dispatched).toBe(1);
  });

  it("survives a failing claim without rejecting the poll loop", async () => {
    const consumer = new WhatsAppInboundConsumer({
      db,
      logger: createTestLogger(),
      stagingDir,
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
});

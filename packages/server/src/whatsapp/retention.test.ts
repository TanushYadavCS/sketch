import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, createTestLogger } from "../test-utils";
import {
  WHATSAPP_STAGED_MEDIA_RETENTION_MS,
  startWhatsAppInboundRetention,
  sweepWhatsAppStagedMedia,
} from "./retention";

describe("WhatsApp inbound retention", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let directory: string;

  beforeEach(async () => {
    db = await createTestDb();
    directory = await mkdtemp(join(tmpdir(), "sketch-wa-retention-"));
  });

  afterEach(async () => {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  it("schedules queue cleanup and staged-media cleanup shortly after startup", async () => {
    const sweepEvents = vi.fn(async () => ({ consumed: 0, dead: 0 }));
    const sweepMedia = vi.fn(async () => 0);
    const job = startWhatsAppInboundRetention({
      db,
      logger: createTestLogger(),
      stagingDir: directory,
      initialDelayMs: 0,
      intervalMs: 60_000,
      sweepEvents,
      sweepMedia,
    });

    await vi.waitFor(() => {
      expect(sweepEvents).toHaveBeenCalledTimes(1);
      expect(sweepMedia).toHaveBeenCalledTimes(1);
    });
    job.stop();
  });

  it("removes staged files older than 72 hours and keeps fresh files", async () => {
    const stagingDir = join(directory, "wa-staging");
    await mkdir(stagingDir, { recursive: true });
    const oldPath = join(stagingDir, "old.bin");
    const freshPath = join(stagingDir, "fresh.bin");
    await writeFile(oldPath, "old");
    await writeFile(freshPath, "fresh");
    const now = Date.now();
    const oldTimestamp = new Date(now - WHATSAPP_STAGED_MEDIA_RETENTION_MS - 1_000);
    await utimes(oldPath, oldTimestamp, oldTimestamp);

    await expect(sweepWhatsAppStagedMedia({ db, stagingDir, now: () => now })).resolves.toBe(1);
    await expect(readFile(oldPath)).rejects.toThrow();
    await expect(readFile(freshPath, "utf8")).resolves.toBe("fresh");
  });

  it("keeps old staged files referenced by dispatched events", async () => {
    const stagingDir = join(directory, "wa-staging");
    await mkdir(stagingDir, { recursive: true });
    const dispatchedPath = join(stagingDir, "dispatched.bin");
    await writeFile(dispatchedPath, "queued");
    const now = Date.now();
    const oldTimestamp = new Date(now - WHATSAPP_STAGED_MEDIA_RETENTION_MS - 1_000);
    await utimes(dispatchedPath, oldTimestamp, oldTimestamp);
    await db
      .insertInto("whatsapp_inbound_events")
      .values({
        kind: "message",
        origin: "gateway",
        status: "dispatched",
        envelope: JSON.stringify({ stagedPath: await realpath(dispatchedPath) }),
      })
      .execute();

    await expect(sweepWhatsAppStagedMedia({ db, stagingDir, now: () => now })).resolves.toBe(0);
    await expect(readFile(dispatchedPath, "utf8")).resolves.toBe("queued");
  });
});

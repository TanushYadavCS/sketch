import { readdir, realpath, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Kysely } from "kysely";
import {
  WHATSAPP_INBOUND_SWEEP_BATCH_SIZE,
  createWhatsAppInboundEventsRepository,
} from "../db/repositories/whatsapp-inbound-events";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";

export const WHATSAPP_INBOUND_RETENTION_INTERVAL_MS = 60 * 60_000;
export const WHATSAPP_INBOUND_RETENTION_INITIAL_DELAY_MS = 10_000;
export const WHATSAPP_STAGED_MEDIA_RETENTION_MS = 72 * 60 * 60_000;

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function collectStagedPaths(value: unknown, paths: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStagedPaths(item, paths);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "stagedPath" && typeof item === "string") paths.add(resolve(item));
    collectStagedPaths(item, paths);
  }
}

async function liveStagedPaths(db: Kysely<DB>): Promise<Set<string>> {
  const rows = await db
    .selectFrom("whatsapp_inbound_events")
    .select("envelope")
    .where("status", "in", ["pending", "processing", "captured"])
    .execute();
  const paths = new Set<string>();
  for (const row of rows) {
    try {
      collectStagedPaths(JSON.parse(row.envelope), paths);
    } catch {}
  }
  return paths;
}

export async function sweepWhatsAppStagedMedia(params: {
  db: Kysely<DB>;
  stagingDir: string;
  now?: () => number;
}): Promise<number> {
  const stagingRoot = await realpath(params.stagingDir).catch(() => null);
  if (!stagingRoot) return 0;
  const referenced = await liveStagedPaths(params.db);
  const cutoff = (params.now ?? Date.now)() - WHATSAPP_STAGED_MEDIA_RETENTION_MS;
  let removed = 0;

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (!inside(stagingRoot, path) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || referenced.has(path)) continue;
      const metadata = await stat(path);
      if (metadata.mtimeMs >= cutoff) continue;
      await rm(path, { force: true });
      removed += 1;
    }
  };

  await visit(stagingRoot);
  return removed;
}

export interface WhatsAppInboundRetentionJob {
  stop(): void;
}

export function startWhatsAppInboundRetention(params: {
  db: Kysely<DB>;
  logger: Logger;
  stagingDir: string;
  initialDelayMs?: number;
  intervalMs?: number;
  sweepEvents?: () => Promise<{ consumed: number; dead: number }>;
  sweepMedia?: () => Promise<number>;
}): WhatsAppInboundRetentionJob {
  const events = createWhatsAppInboundEventsRepository(params.db);
  const sweepEvents = params.sweepEvents ?? (() => events.sweep());
  const sweepMedia = params.sweepMedia ?? (() => sweepWhatsAppStagedMedia(params));
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      let consumed = 0;
      let dead = 0;
      for (;;) {
        const batch = await sweepEvents();
        consumed += batch.consumed;
        dead += batch.dead;
        if (batch.consumed < WHATSAPP_INBOUND_SWEEP_BATCH_SIZE && batch.dead < WHATSAPP_INBOUND_SWEEP_BATCH_SIZE) {
          break;
        }
      }
      const stagedMedia = await sweepMedia();
      if (consumed > 0 || dead > 0 || stagedMedia > 0) {
        params.logger.info({ consumed, dead, stagedMedia }, "WhatsApp inbound retention sweep completed");
      }
    } catch (error) {
      params.logger.warn({ error }, "WhatsApp inbound retention sweep failed");
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(
    () => void run(),
    params.initialDelayMs ?? WHATSAPP_INBOUND_RETENTION_INITIAL_DELAY_MS,
  );
  initialTimer.unref?.();
  const intervalTimer = setInterval(() => void run(), params.intervalMs ?? WHATSAPP_INBOUND_RETENTION_INTERVAL_MS);
  intervalTimer.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

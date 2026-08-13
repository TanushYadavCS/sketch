import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";

const CO_MENTION_FULL_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");

vi.mock("../entities/co-mention-sweep", () => ({
  sweepCoMentionContributesTo: vi.fn(),
}));

type SpyLogger = Logger & {
  child: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

function createSpyLogger(): SpyLogger {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as SpyLogger;
  logger.child.mockReturnValue(logger);
  return logger;
}

async function loadRunAllSyncs() {
  vi.resetModules();
  const coMentionModule = await import("../entities/co-mention-sweep");
  const sweepCoMentionContributesTo = vi.mocked(coMentionModule.sweepCoMentionContributesTo);
  sweepCoMentionContributesTo.mockReset();
  sweepCoMentionContributesTo.mockResolvedValue({
    scannedPairs: 0,
    upsertedRelationships: 0,
    addedEvidence: 0,
    removedEvidence: 0,
    removedRelationships: 0,
  });
  const syncModule = await import("./sync");
  return { runAllSyncs: syncModule.runAllSyncs, sweepCoMentionContributesTo };
}

describe("runAllSyncs co-mention full sweep cadence", () => {
  let db: Kysely<DB> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  it("runs the full sweep on the first scheduled sync and passes the configured threshold", async () => {
    const { runAllSyncs, sweepCoMentionContributesTo } = await loadRunAllSyncs();
    db = await createTestDb();
    const logger = createSpyLogger();

    await runAllSyncs(db, logger, { appConfig: { CO_MENTION_CONTRIBUTES_TO_THRESHOLD: 4 } });

    expect(sweepCoMentionContributesTo).toHaveBeenCalledTimes(1);
    expect(sweepCoMentionContributesTo).toHaveBeenCalledWith(db, logger, {
      scope: { kind: "full" },
      threshold: 4,
    });
    expect(logger.child).toHaveBeenCalledWith({ component: "co-mention-full-sweep" });
  });

  it("throttles the full sweep until the interval elapses", async () => {
    const { runAllSyncs, sweepCoMentionContributesTo } = await loadRunAllSyncs();
    db = await createTestDb();
    const logger = createSpyLogger();

    await runAllSyncs(db, logger);
    await runAllSyncs(db, logger);

    expect(sweepCoMentionContributesTo).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(BASE_TIME.getTime() + CO_MENTION_FULL_SWEEP_INTERVAL_MS + 1));
    await runAllSyncs(db, logger);

    expect(sweepCoMentionContributesTo).toHaveBeenCalledTimes(2);
  });

  it("logs and resolves when the full sweep fails", async () => {
    const { runAllSyncs, sweepCoMentionContributesTo } = await loadRunAllSyncs();
    db = await createTestDb();
    const logger = createSpyLogger();
    const err = new Error("sweep failed");
    sweepCoMentionContributesTo.mockRejectedValueOnce(err);

    await expect(runAllSyncs(db, logger)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err }, "Co-mention full sweep failed");
  });
});

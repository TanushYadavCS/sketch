import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, createTestLogger } from "../test-utils";
import { floorRetryForDomains } from "./engagement-floor";
import { runPostSyncGraphPipeline } from "./post-sync";
import { sweepDomainPromotions } from "./smart-enrichment";

vi.mock("../entities/materialize", () => ({
  materializeUnmaterializedFacts: vi.fn().mockResolvedValue({ factsRead: 0 }),
}));

vi.mock("../entities/co-mention-sweep", () => ({
  sweepCoMentionContributesTo: vi.fn().mockResolvedValue({ examined: 0, promoted: 0 }),
}));

vi.mock("./engagement-floor", () => ({
  floorRetryForDomains: vi.fn().mockResolvedValue({ processed: 0 }),
}));

vi.mock("./smart-enrichment", () => ({
  sweepDomainPromotions: vi.fn().mockResolvedValue({
    scanned: 0,
    promoted: 0,
    promotedDomains: [],
    linkedExisting: 0,
    pendingFuzzy: 0,
    worksAtCreated: 0,
  }),
}));

describe("runPostSyncGraphPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the co-mention sweep scoped to affected files and passes the configured threshold", async () => {
    const { materializeUnmaterializedFacts } = await import("../entities/materialize");
    const { sweepCoMentionContributesTo } = await import("../entities/co-mention-sweep");
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: ["file-1", "file-2"],
        coMentionContributesToThreshold: 4,
      });

      expect(materializeUnmaterializedFacts).toHaveBeenCalledTimes(1);
      expect(sweepCoMentionContributesTo).toHaveBeenCalledTimes(1);
      expect(sweepCoMentionContributesTo).toHaveBeenCalledWith(db, expect.anything(), {
        scope: { kind: "files", indexedFileIds: ["file-1", "file-2"] },
        threshold: 4,
      });
    } finally {
      await db.destroy();
    }
  });

  it("passes FLOOR_RETRY_MAX_FILES_PER_DOMAIN when domain promotion triggers floor retry", async () => {
    vi.mocked(sweepDomainPromotions).mockResolvedValueOnce({
      scanned: 1,
      promoted: 1,
      promotedDomains: ["canvasx.ai"],
      linkedExisting: 0,
      pendingFuzzy: 0,
      worksAtCreated: 0,
    });
    const db = await createTestDb();
    const logger = createTestLogger();

    try {
      await runPostSyncGraphPipeline({
        db,
        syncLogger: logger,
        affectedIndexedFileIds: [],
        floorRetryMaxFilesPerDomain: 7,
      });

      expect(floorRetryForDomains).toHaveBeenCalledTimes(1);
      expect(floorRetryForDomains).toHaveBeenCalledWith({ db, logger: expect.anything() }, ["canvasx.ai"], {
        maxFilesPerDomain: 7,
      });
    } finally {
      await db.destroy();
    }
  });
});

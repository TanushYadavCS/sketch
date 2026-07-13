import { describe, expect, it } from "vitest";
import {
  compareWhatsAppBackfillCheckpointKeys,
  encodeWhatsAppBackfillCheckpointKey,
  oldestWhatsAppBackfillCheckpointKeyForMessages,
} from "./backfill-checkpoint";

describe("WhatsApp backfill checkpoint keys", () => {
  it("encodes timestamp and provider id into a deterministic sortable key", () => {
    const earlier = encodeWhatsAppBackfillCheckpointKey({
      providerTimestamp: "2026-07-07T09:00:00.000Z",
      providerMessageId: "m/2",
    });
    const later = encodeWhatsAppBackfillCheckpointKey({
      providerTimestamp: "2026-07-07T09:00:01.000Z",
      providerMessageId: "m/1",
    });
    const tieBreak = encodeWhatsAppBackfillCheckpointKey({
      providerTimestamp: "2026-07-07T09:00:00.000Z",
      providerMessageId: "m/3",
    });

    expect(earlier).toBe("v1:1783414800000:m%2F2");
    expect(compareWhatsAppBackfillCheckpointKeys(earlier as string, later as string)).toBeLessThan(0);
    expect(compareWhatsAppBackfillCheckpointKeys(earlier as string, tieBreak as string)).toBeLessThan(0);
  });

  it("selects the oldest key in an unordered batch", () => {
    const oldest = oldestWhatsAppBackfillCheckpointKeyForMessages([
      { providerTimestamp: "2026-07-07T09:05:00.000Z", providerMessageId: "newer" },
      { providerTimestamp: "2026-07-07T09:00:00.000Z", providerMessageId: "oldest" },
      { providerTimestamp: "2026-07-07T09:02:00.000Z", providerMessageId: "middle" },
    ]);

    expect(oldest).toBe("v1:1783414800000:oldest");
  });
});

import { describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils";
import { WhatsAppGatewayHeartbeat } from "./heartbeat";

describe("WhatsAppGatewayHeartbeat", () => {
  it("treats a zero-row heartbeat as immediate ownership loss", async () => {
    const reasons: string[] = [];
    const heartbeat = new WhatsAppGatewayHeartbeat({
      heartbeat: async () => false,
      isSocketHealthy: () => true,
      onOwnershipLost: (reason) => {
        reasons.push(reason);
      },
      logger: createTestLogger(),
    });
    await heartbeat.tick();
    expect(reasons).toEqual(["lease heartbeat rejected the owner token"]);
  });

  it("requires three database failures and more than 25 monotonic seconds before self-exit", async () => {
    let now = 0n;
    const reasons: string[] = [];
    const heartbeat = new WhatsAppGatewayHeartbeat({
      heartbeat: async () => {
        throw new Error("database unavailable");
      },
      isSocketHealthy: () => true,
      onOwnershipLost: (reason) => {
        reasons.push(reason);
      },
      logger: createTestLogger(),
      now: () => now,
    });
    await heartbeat.tick();
    now = 10_000_000_000n;
    await heartbeat.tick();
    expect(reasons).toEqual([]);
    now = 26_000_000_000n;
    await heartbeat.tick();
    expect(reasons).toEqual(["heartbeat deadline exceeded after consecutive database failures"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { createTestLogger } from "../test-utils";
import { WhatsAppUserLidRefresh } from "./user-lid-refresh";

describe("WhatsAppUserLidRefresh", () => {
  it("records provider checks and appends the resolved alias", async () => {
    const attachIfPhoneUnchanged = vi.fn(async () => "attached" as const);
    const markAttempt = vi.fn(async (_userId: string, _phone: string, _at: string, _current: boolean) => true);
    const refresh = new WhatsAppUserLidRefresh({
      whatsapp: {
        health: vi.fn(async () => ({ socketState: "connected" }) as never),
        resolvePhoneToLid: vi.fn(async () => ({ lid: "12345@lid", source: "provider-current" as const })),
      },
      store: { listDue: vi.fn(async () => []), attachIfPhoneUnchanged, markAttempt },
      logger: createTestLogger(),
      now: () => new Date("2026-08-10T10:00:00.000Z"),
    });

    await refresh.capture("user-1", "+14155551234");

    expect(attachIfPhoneUnchanged).toHaveBeenCalledWith(
      "user-1",
      "+14155551234",
      "12345@lid",
      "2026-08-10T10:00:00.000Z",
    );
    expect(markAttempt).toHaveBeenCalledWith("user-1", "+14155551234", "2026-08-10T10:00:00.000Z", true);
  });

  it("marks fallback and misses as attempts without successful provider checks", async () => {
    const markAttempt = vi.fn(async () => true);
    const resolvePhoneToLid = vi
      .fn()
      .mockResolvedValueOnce({ lid: "54321@lid", source: "baileys-fallback" })
      .mockResolvedValueOnce(null);
    const refresh = new WhatsAppUserLidRefresh({
      whatsapp: { health: vi.fn() as never, resolvePhoneToLid },
      store: {
        listDue: vi.fn(async () => []),
        attachIfPhoneUnchanged: vi.fn(async () => "attached" as const),
        markAttempt,
      },
      logger: createTestLogger(),
      now: () => new Date("2026-08-10T10:00:00.000Z"),
    });

    await refresh.capture("user-1", "+14155551234");
    await refresh.capture("user-2", "+14155550000");

    expect(markAttempt).toHaveBeenNthCalledWith(1, "user-1", "+14155551234", expect.any(String), false);
    expect(markAttempt).toHaveBeenNthCalledWith(2, "user-2", "+14155550000", expect.any(String), false);
  });

  it("refreshes a bounded due batch sequentially only while connected", async () => {
    const active = { count: 0, max: 0 };
    const resolvePhoneToLid = vi.fn(async () => {
      active.count += 1;
      active.max = Math.max(active.max, active.count);
      await Promise.resolve();
      active.count -= 1;
      return null;
    });
    const listDue = vi.fn(async () => [
      { id: "user-1", whatsapp_number: "+14155551234" },
      { id: "user-2", whatsapp_number: "+14155550000" },
    ]);
    const health = vi.fn(async () => ({ socketState: "connected" }) as never);
    const refresh = new WhatsAppUserLidRefresh({
      whatsapp: { health, resolvePhoneToLid },
      store: {
        listDue,
        attachIfPhoneUnchanged: vi.fn(async () => "attached" as const),
        markAttempt: vi.fn(async () => true),
      },
      logger: createTestLogger(),
      batchSize: 2,
      retryAfterMs: 60_000,
      interRequestDelayMs: 0,
      interRequestJitterMs: 0,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
    });

    await refresh.wake();

    expect(listDue).toHaveBeenCalledWith("2026-08-10T09:59:00.000Z", 2);
    expect(resolvePhoneToLid).toHaveBeenCalledTimes(2);
    expect(active.max).toBe(1);
  });

  it("refreshes each user no more than once every 24 hours by default", async () => {
    const listDue = vi.fn(async () => []);
    const refresh = new WhatsAppUserLidRefresh({
      whatsapp: {
        health: vi.fn(async () => ({ socketState: "connected" }) as never),
        resolvePhoneToLid: vi.fn(async () => null),
      },
      store: {
        listDue,
        attachIfPhoneUnchanged: vi.fn(async () => "attached" as const),
        markAttempt: vi.fn(async () => true),
      },
      logger: createTestLogger(),
      now: () => new Date("2026-08-10T10:00:00.000Z"),
    });

    await refresh.wake();

    expect(listDue).toHaveBeenCalledWith("2026-08-09T10:00:00.000Z", 25);
  });

  it("adds jittered spacing between provider requests", async () => {
    const events: string[] = [];
    const refresh = new WhatsAppUserLidRefresh({
      whatsapp: {
        health: vi.fn(async () => ({ socketState: "connected" }) as never),
        resolvePhoneToLid: vi.fn(async (phone) => {
          events.push(`resolve:${phone}`);
          return null;
        }),
      },
      store: {
        listDue: vi.fn(async () => [
          { id: "user-1", whatsapp_number: "+14155551234" },
          { id: "user-2", whatsapp_number: null },
          { id: "user-3", whatsapp_number: "+14155550000" },
        ]),
        attachIfPhoneUnchanged: vi.fn(async () => "attached" as const),
        markAttempt: vi.fn(async () => true),
      },
      logger: createTestLogger(),
      interRequestDelayMs: 1_000,
      interRequestJitterMs: 1_000,
      random: () => 0.5,
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
    });

    await refresh.wake();

    expect(events).toEqual(["resolve:+14155551234", "sleep:1500", "resolve:+14155550000"]);
  });

  it("contains and sanitizes detached list and attempt timestamp failures", async () => {
    const warn = vi.fn();
    const logger = { warn, error: vi.fn() } as unknown as Logger;
    const markFailure = Object.assign(new Error("failed for +14155551234 and 12345@lid"), { code: "SQLITE_BUSY" });
    const refresh = new WhatsAppUserLidRefresh({
      whatsapp: {
        health: vi.fn(async () => ({ socketState: "connected" }) as never),
        resolvePhoneToLid: vi.fn(async () => null),
      },
      store: {
        listDue: vi.fn(async () => {
          throw new Error("list includes +14155551234");
        }),
        attachIfPhoneUnchanged: vi.fn(async () => "attached" as const),
        markAttempt: vi.fn(async () => {
          throw markFailure;
        }),
      },
      logger,
    });

    await expect(refresh.capture("user-1", "+14155551234")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { operation: "mark_whatsapp_lid_attempt", errorClass: "Error", errorCode: "SQLITE_BUSY" },
      "WhatsApp LID attempt timestamp failed",
    );

    refresh.start();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        { operation: "initial_whatsapp_lid_refresh", errorClass: "Error" },
        "Detached WhatsApp LID refresh failed",
      );
    });
    refresh.stop();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("+14155551234");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("12345@lid");
  });
});

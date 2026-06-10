import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { OpenRouterPriceMap } from "./openrouter-price-map";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const SAMPLE = {
  data: [
    {
      id: "xiaomi/mimo-v2.5-pro",
      canonical_slug: "xiaomi/mimo-v2.5-pro-20260422",
      pricing: { prompt: "0.000000435", completion: "0.00000087", input_cache_read: "0.0000000036" },
    },
    {
      id: "anthropic/claude-sonnet-4",
      pricing: {
        prompt: "0.000003",
        completion: "0.000015",
        input_cache_read: "0.0000003",
        input_cache_write: "0.00000375",
      },
    },
  ],
};

describe("OpenRouterPriceMap", () => {
  it("fetches on a cold lookup and returns parsed per-token prices", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE));
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    expect(await map.lookup("xiaomi/mimo-v2.5-pro")).toEqual({
      prompt: 0.000000435,
      completion: 0.00000087,
      cacheRead: 0.0000000036,
      cacheWrite: 0,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("tolerates a missing input_cache_write key (defaults to 0)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE));
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    const price = await map.lookup("xiaomi/mimo-v2.5-pro");
    expect(price?.cacheWrite).toBe(0);
  });

  it("indexes by canonical_slug as well as id", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE));
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    const price = await map.lookup("xiaomi/mimo-v2.5-pro-20260422");
    expect(price?.prompt).toBe(0.000000435);
  });

  it("strips an @preset routing suffix before lookup", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE));
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    const price = await map.lookup("anthropic/claude-sonnet-4@preset/sketch-bedrock");
    expect(price?.cacheWrite).toBe(0.00000375);
  });

  it("serves from cache within the TTL without refetching", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE));
    let clock = 0;
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => clock });

    await map.lookup("xiaomi/mimo-v2.5-pro");
    clock = 999;
    await map.lookup("xiaomi/mimo-v2.5-pro");

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("serves stale data immediately and revalidates once the TTL elapses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE));
    let clock = 0;
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => clock });

    await map.lookup("xiaomi/mimo-v2.5-pro");
    clock = 2000;
    const price = await map.lookup("xiaomi/mimo-v2.5-pro");

    expect(price?.prompt).toBe(0.000000435);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent first-callers into a single fetch", async () => {
    let release: (v: ReturnType<typeof jsonResponse>) => void = () => {};
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    const p1 = map.lookup("xiaomi/mimo-v2.5-pro");
    const p2 = map.lookup("xiaomi/mimo-v2.5-pro");
    release(jsonResponse(SAMPLE));
    const [a, b] = await Promise.all([p1, p2]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a?.prompt).toBe(0.000000435);
    expect(b?.prompt).toBe(0.000000435);
  });

  it("retains the last-known map when a refresh fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(SAMPLE))
      .mockRejectedValueOnce(new Error("network down"));
    let clock = 0;
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => clock });

    await map.lookup("xiaomi/mimo-v2.5-pro");
    clock = 2000;
    await map.lookup("xiaomi/mimo-v2.5-pro");
    await Promise.resolve();
    await Promise.resolve();

    clock = 2001;
    const price = await map.lookup("xiaomi/mimo-v2.5-pro");
    expect(price?.prompt).toBe(0.000000435);
  });

  it("omits auto-router models with -1 sentinel pricing so they fall back to the SDK figure", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          ...SAMPLE.data,
          { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
          { id: "openrouter/fusion", pricing: { prompt: "-1", completion: "-1" } },
        ],
      }),
    );
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    expect(await map.lookup("openrouter/auto")).toBeNull();
    expect(await map.lookup("openrouter/fusion")).toBeNull();
    expect((await map.lookup("xiaomi/mimo-v2.5-pro"))?.prompt).toBe(0.000000435);
  });

  it("returns null for an unknown model", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(SAMPLE));
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    expect(await map.lookup("does/not-exist")).toBeNull();
  });

  it("retains no prices and returns null when the cold fetch fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const map = new OpenRouterPriceMap({ ttlMs: 1000, logger, fetchFn, now: () => 0 });

    expect(await map.lookup("xiaomi/mimo-v2.5-pro")).toBeNull();
  });
});

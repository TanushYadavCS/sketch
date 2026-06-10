/**
 * In-process price map for OpenRouter models, sourced from the public
 * GET https://openrouter.ai/api/v1/models endpoint (no auth).
 *
 * The Claude Agent SDK only prices first-party Anthropic models; runs routed
 * through OpenRouter are repriced from captured token counts times these
 * per-token rates. The map is fetched lazily, cached with a TTL, and served
 * stale-while-revalidate so a hot agent run never blocks on the network. A
 * single in-flight refresh dedupes concurrent first-callers, and a failed
 * refresh retains the last-known prices rather than clearing them.
 */
import { z } from "zod";
import type { Logger } from "../logger";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Per-token USD prices for a model: prompt (input), completion (output),
 * cacheRead (cached input read), cacheWrite (input written to cache).
 */
export interface ModelPrice {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Minimal shape of the global fetch used here, injectable so tests can supply
 * a fake without stubbing any worker-global state.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const pricingSchema = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  input_cache_read: z.string().optional(),
  input_cache_write: z.string().optional(),
});

const modelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      canonical_slug: z.string().optional(),
      pricing: pricingSchema.optional(),
    }),
  ),
});

/**
 * Parses a per-token USD price string into a number, treating missing or
 * non-finite values as 0 (some models omit cache pricing keys entirely).
 */
function toRate(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Configured model ids may carry an OpenRouter routing-preset suffix
 * (e.g. "vendor/model@preset/alias"); the price-map keys never do, so strip it.
 */
function normalizeSlug(slug: string): string {
  const at = slug.indexOf("@");
  return at === -1 ? slug : slug.slice(0, at);
}

/**
 * Construction options. `fetchFn` and `now` are injectable for tests and
 * default to the global fetch and Date.now respectively.
 */
export interface OpenRouterPriceMapOptions {
  ttlMs: number;
  logger: Logger;
  fetchFn?: FetchLike;
  now?: () => number;
}

export class OpenRouterPriceMap {
  private prices = new Map<string, ModelPrice>();
  private loadedAt = 0;
  private hasData = false;
  private inFlight: Promise<void> | null = null;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(options: OpenRouterPriceMapOptions) {
    this.ttlMs = options.ttlMs;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns the price for a model slug, or null if unknown. A cold cache awaits
   * the first fetch; a stale cache serves the last-known value and revalidates
   * in the background.
   */
  async lookup(slug: string): Promise<ModelPrice | null> {
    if (!this.hasData) {
      await this.refresh();
    } else if (this.now() - this.loadedAt >= this.ttlMs) {
      void this.refresh();
    }
    return this.prices.get(normalizeSlug(slug)) ?? null;
  }

  private refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchAndReplace().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Fetches the models list and atomically replaces the price map. Auto-router
   * models (openrouter/auto, openrouter/fusion) report -1 for prompt/completion
   * to signal runtime-resolved pricing; per-token pricing them would be negative
   * or zero, so they are skipped and the caller falls back to the SDK figure.
   */
  private async fetchAndReplace(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(MODELS_URL, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`OpenRouter /models returned HTTP ${res.status}`);
      }
      const parsed = modelsResponseSchema.parse(await res.json());
      const next = new Map<string, ModelPrice>();
      for (const model of parsed.data) {
        const prompt = toRate(model.pricing?.prompt);
        const completion = toRate(model.pricing?.completion);
        if (prompt < 0 || completion < 0) continue;
        const price: ModelPrice = {
          prompt,
          completion,
          cacheRead: Math.max(0, toRate(model.pricing?.input_cache_read)),
          cacheWrite: Math.max(0, toRate(model.pricing?.input_cache_write)),
        };
        next.set(model.id, price);
        if (model.canonical_slug) next.set(model.canonical_slug, price);
      }
      this.prices = next;
      this.hasData = true;
      this.loadedAt = this.now();
      this.logger.info({ modelCount: parsed.data.length }, "OpenRouter price map refreshed");
    } catch (err) {
      this.logger.warn({ err }, "Failed to refresh OpenRouter price map; retaining last-known prices");
    } finally {
      clearTimeout(timeout);
    }
  }
}

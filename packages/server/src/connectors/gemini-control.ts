export type GeminiSleep = (ms: number) => Promise<void>;
export type GeminiNow = () => number;

export interface GeminiClientOptions {
  maxRpm?: number;
  maxRetries?: number;
  quotaIdentity?: string;
  sleep?: GeminiSleep;
  now?: GeminiNow;
  validateKey?: (apiKey: string) => Promise<"valid" | "invalid" | "unknown">;
  onRetry?: (event: { attempt: number; maxRetries: number; delayMs: number; reason: string }) => void;
}

export class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Gemini API error (${status}): ${body}`);
    this.name = "GeminiHttpError";
  }
}

type Limiter = {
  nextAt: number;
  tail: Promise<void>;
};

type ValidationCacheEntry = {
  apiKey: string;
  status: "valid" | "invalid" | "unknown";
  expiresAt: number;
};

const DEFAULT_MAX_RPM = 60;
const DEFAULT_MAX_RETRIES = 4;
const VALIDATION_TTL_MS = 10 * 60 * 1000;
const limiterByQuotaIdentity = new Map<string, Limiter>();
const validationByQuotaIdentity = new Map<string, ValidationCacheEntry>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptions(apiKey: string, options?: GeminiClientOptions) {
  const maxRpm = Math.max(1, Math.floor(options?.maxRpm ?? DEFAULT_MAX_RPM));
  const maxRetries = Math.max(0, Math.floor(options?.maxRetries ?? DEFAULT_MAX_RETRIES));
  const quotaIdentity = options?.quotaIdentity ?? apiKey;
  return {
    maxRpm,
    maxRetries,
    quotaIdentity,
    sleep: options?.sleep ?? defaultSleep,
    now: options?.now ?? Date.now,
    validateKey: options?.validateKey ?? validateGeminiKey,
    onRetry: options?.onRetry,
  };
}

async function acquireGeminiSlot(apiKey: string, options?: GeminiClientOptions): Promise<void> {
  const opts = normalizeOptions(apiKey, options);
  const intervalMs = Math.ceil(60000 / opts.maxRpm);
  let limiter = limiterByQuotaIdentity.get(opts.quotaIdentity);
  if (!limiter) {
    limiter = { nextAt: 0, tail: Promise.resolve() };
    limiterByQuotaIdentity.set(opts.quotaIdentity, limiter);
  }

  const run = limiter.tail.then(async () => {
    const waitMs = Math.max(0, limiter.nextAt - opts.now());
    if (waitMs > 0) await opts.sleep(waitMs);
    limiter.nextAt = opts.now() + intervalMs;
  });
  limiter.tail = run.catch(() => {});
  await run;
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 4000);
  const jitter = Math.floor(Math.random() * Math.min(250, base / 2));
  return base + jitter;
}

function errorText(err: unknown): string {
  if (err instanceof GeminiHttpError) return err.body;
  if (err instanceof Error) return err.message;
  return String(err);
}

function errorStatus(err: unknown): number | undefined {
  if (err instanceof GeminiHttpError) return err.status;
  if (err && typeof err === "object") {
    const raw = err as Record<string, unknown>;
    const status = raw.status ?? raw.statusCode ?? raw.code;
    if (typeof status === "number") return status;
    if (typeof status === "string" && /^\d+$/.test(status)) return Number(status);
  }
  return undefined;
}

function isApiKeyInvalid(err: unknown): boolean {
  return errorText(err).includes("API_KEY_INVALID");
}

async function validateGeminiKey(apiKey: string): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    );
    if (res.ok) return "valid";
    if (res.status === 400 || res.status === 403) {
      const body = await res.text();
      if (body.includes("API_KEY_INVALID")) return "invalid";
    }
    if (res.status === 429 || res.status >= 500) return "unknown";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function validationStatus(
  apiKey: string,
  options?: GeminiClientOptions,
): Promise<"valid" | "invalid" | "unknown"> {
  const opts = normalizeOptions(apiKey, options);
  const cached = validationByQuotaIdentity.get(opts.quotaIdentity);
  if (cached && cached.apiKey === apiKey && cached.expiresAt > opts.now()) return cached.status;

  const status = await opts.validateKey(apiKey);
  validationByQuotaIdentity.set(opts.quotaIdentity, {
    apiKey,
    status,
    expiresAt: opts.now() + VALIDATION_TTL_MS,
  });
  return status;
}

async function retryReason(err: unknown, apiKey: string, options?: GeminiClientOptions): Promise<string | null> {
  const status = errorStatus(err);
  if (status === 429) return "rate_limit";
  if (status !== undefined && status >= 500) return "server_error";
  if (isApiKeyInvalid(err)) {
    return (await validationStatus(apiKey, options)) === "valid" ? "api_key_invalid_throttle" : null;
  }
  return null;
}

export async function runGeminiRequest<T>(
  apiKey: string,
  operation: () => Promise<T>,
  options?: GeminiClientOptions,
): Promise<T> {
  const opts = normalizeOptions(apiKey, options);
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    await acquireGeminiSlot(apiKey, options);
    try {
      return await operation();
    } catch (err) {
      const reason = await retryReason(err, apiKey, options);
      if (!reason || attempt >= opts.maxRetries) throw err;
      const delayMs = retryDelayMs(attempt);
      opts.onRetry?.({ attempt: attempt + 1, maxRetries: opts.maxRetries, delayMs, reason });
      await opts.sleep(delayMs);
    }
  }
  throw new Error("Gemini: retries exhausted");
}

export function resetGeminiControlsForTests(): void {
  limiterByQuotaIdentity.clear();
  validationByQuotaIdentity.clear();
}

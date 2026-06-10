import type { Logger } from "pino";
import { GeminiHttpError } from "./gemini-control";

export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof GeminiHttpError) {
    const text = err.body.toLowerCase();
    if (text.includes("api_key_invalid") || text.includes("invalid api key")) return true;
    return err.status === 429 || err.status >= 500;
  }

  if (err instanceof Error) {
    const text = err.message.toLowerCase();
    return (
      err.name === "AbortError" ||
      text.includes("resource_exhausted") ||
      text.includes("prepayment credits") ||
      text.includes("quota") ||
      text.includes("rate limit") ||
      text.includes("timeout") ||
      text.includes("fetch failed") ||
      text.includes("api_key_invalid") ||
      text.includes("invalid api key")
    );
  }

  return false;
}

export async function withProviderFallback<T>(params: {
  operation: string;
  primary: () => Promise<T>;
  fallback: (() => Promise<T>) | null | undefined;
  shouldFallback?: (err: unknown) => boolean;
  logger?: Logger;
}): Promise<T> {
  try {
    return await params.primary();
  } catch (err) {
    const shouldFallback = params.shouldFallback ?? isRetryableProviderError;
    if (!params.fallback || !shouldFallback(err)) throw err;

    params.logger?.warn({ err, operation: params.operation }, "Primary enrichment provider failed, using fallback");
    return params.fallback();
  }
}

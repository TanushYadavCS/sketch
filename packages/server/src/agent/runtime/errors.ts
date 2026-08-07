import type { AgentRuntimeProviderKind } from "./contracts";

export class AgentRuntimeProviderError extends Error {
  readonly provider: AgentRuntimeProviderKind;
  readonly modelId: string;
  override readonly cause: unknown;

  constructor(params: {
    provider: AgentRuntimeProviderKind;
    modelId: string;
    message: string;
    cause: unknown;
  }) {
    super(params.message);
    this.name = "AgentRuntimeProviderError";
    this.provider = params.provider;
    this.modelId = params.modelId;
    this.cause = params.cause;
  }
}

export class ModelRequestTimeoutError extends Error {
  override readonly cause: unknown;

  constructor(cause?: unknown) {
    super("Model request exceeded its deadline");
    this.name = "ModelRequestTimeoutError";
    this.cause = cause;
  }
}

export function isRuntimeAbortError(error: unknown, signal?: AbortSignal): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && (typeof current === "object" || typeof current === "function") && !seen.has(current)) {
    if (current instanceof ModelRequestTimeoutError) return false;
    seen.add(current);
    current = current instanceof Error ? current.cause : (current as { cause?: unknown }).cause;
  }

  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

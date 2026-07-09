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

export function isRuntimeAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

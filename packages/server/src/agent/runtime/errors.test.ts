import { describe, expect, it } from "vitest";
import { AgentRuntimeProviderError, ModelRequestTimeoutError, isRuntimeAbortError } from "./errors";

describe("runtime abort errors", () => {
  it("does not classify a model request timeout as a runtime abort", () => {
    const timeout = new ModelRequestTimeoutError();
    const signal = AbortSignal.abort(timeout);

    expect(isRuntimeAbortError(timeout, signal)).toBe(false);
  });

  it("does not classify a nested model request timeout as a runtime abort", () => {
    const timeout = new ModelRequestTimeoutError();
    const wrapped = new AgentRuntimeProviderError({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      message: "provider failed",
      cause: timeout,
    });

    expect(isRuntimeAbortError(wrapped, AbortSignal.abort())).toBe(false);
  });

  it("still classifies a genuine user abort as a runtime abort", () => {
    const userAbort = new DOMException("user stopped", "AbortError");

    expect(isRuntimeAbortError(userAbort, AbortSignal.abort(userAbort))).toBe(true);
  });
});

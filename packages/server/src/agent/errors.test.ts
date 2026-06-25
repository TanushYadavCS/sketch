import { describe, expect, it } from "vitest";
import {
  PROMPT_TOO_LONG_RECOVERY_MESSAGE,
  PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE,
  agentFailureMessage,
  isPromptTooLongError,
} from "./errors";

describe("agent/errors", () => {
  it("detects prompt-too-long SDK errors", () => {
    expect(isPromptTooLongError(new Error("Claude Code returned an error result: Prompt is too long"))).toBe(true);
  });

  it("detects prompt-too-long errors through causes", () => {
    const err = new Error("wrapper", { cause: new Error("Prompt is too long") });

    expect(isPromptTooLongError(err)).toBe(true);
  });

  it("keeps unrelated failures on the fallback message", () => {
    expect(agentFailureMessage(new Error("boom"), "fallback")).toBe("fallback");
  });

  it("returns the recovery message for oversized conversations", () => {
    expect(agentFailureMessage(new Error("Prompt is too long"), "fallback")).toBe(PROMPT_TOO_LONG_RECOVERY_MESSAGE);
  });

  it("returns the supplied recovery message for oversized conversations", () => {
    expect(
      agentFailureMessage(new Error("Prompt is too long"), "fallback", PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE),
    ).toBe(PROMPT_TOO_LONG_SHARED_RECOVERY_MESSAGE);
  });
});

import { describe, expect, it } from "vitest";
import { GeminiHttpError, resetGeminiControlsForTests, runGeminiRequest } from "./gemini-control";

describe("Gemini request controls", () => {
  it("paces requests sharing the same quota identity", async () => {
    resetGeminiControlsForTests();
    let now = 0;
    const sleeps: number[] = [];
    const options = {
      maxRpm: 60,
      maxRetries: 0,
      quotaIdentity: "project-1",
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };

    await runGeminiRequest("key-a", async () => "generation", options);
    await runGeminiRequest("key-a", async () => "embedding", options);
    await runGeminiRequest("key-a", async () => "query", options);

    expect(sleeps).toEqual([1000, 1000]);
  });

  it("retries transient failures with bounded backoff", async () => {
    resetGeminiControlsForTests();
    let calls = 0;
    let retries = 0;

    const result = await runGeminiRequest(
      "key-a",
      async () => {
        calls++;
        if (calls === 1) throw new GeminiHttpError(429, "quota exceeded");
        return "ok";
      },
      {
        maxRpm: 1000,
        maxRetries: 2,
        sleep: async () => {},
        onRetry: () => {
          retries++;
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(retries).toBe(1);
  });

  it("only retries API_KEY_INVALID when the key recently validated", async () => {
    resetGeminiControlsForTests();
    let validCalls = 0;
    const validResult = await runGeminiRequest(
      "valid-key",
      async () => {
        validCalls++;
        if (validCalls === 1) throw new GeminiHttpError(400, "API_KEY_INVALID");
        return "ok";
      },
      {
        maxRpm: 1000,
        maxRetries: 1,
        sleep: async () => {},
        validateKey: async () => "valid",
      },
    );

    resetGeminiControlsForTests();
    let invalidCalls = 0;
    await expect(
      runGeminiRequest(
        "invalid-key",
        async () => {
          invalidCalls++;
          throw new GeminiHttpError(400, "API_KEY_INVALID");
        },
        {
          maxRpm: 1000,
          maxRetries: 1,
          sleep: async () => {},
          validateKey: async () => "invalid",
        },
      ),
    ).rejects.toThrow("Gemini API error (400)");

    expect(validResult).toBe("ok");
    expect(validCalls).toBe(2);
    expect(invalidCalls).toBe(1);
  });
});

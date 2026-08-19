import { describe, expect, it } from "vitest";
import type { AgentRuntimeMessageAppend } from "./contracts";
import { capPersistedRuntimeMessages } from "./persisted-content";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("capPersistedRuntimeMessages", () => {
  it("returns the same message reference when nothing exceeds a cap", () => {
    const message: AgentRuntimeMessageAppend = { role: "user", content: { role: "user", content: "hello" } };

    const result = capPersistedRuntimeMessages([message]);

    expect(result[0]).toBe(message);
  });

  it("truncates an oversized tool-result text output and notes the original size", () => {
    const big = "x".repeat(200_000);
    const message: AgentRuntimeMessageAppend = {
      role: "tool",
      content: {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t1", toolName: "Bash", output: { type: "text", value: big } }],
      },
    };

    const [out] = capPersistedRuntimeMessages([message]);
    const serialized = JSON.stringify(out);

    expect(serialized).toContain("persisted history truncated");
    expect(serialized).toContain(String(byteLength(big)));
    expect(serialized).not.toContain(big);
    expect(byteLength(serialized)).toBeLessThan(byteLength(big));
  });

  it("supports a tighter per-output cap for builder turns", () => {
    const big = "x".repeat(40_000);
    const message: AgentRuntimeMessageAppend = {
      role: "tool",
      content: {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t1", toolName: "Search", output: { type: "text", value: big } }],
      },
    };

    const [out] = capPersistedRuntimeMessages([message], 24 * 1024);
    const serialized = JSON.stringify(out);

    expect(serialized).toContain("persisted history truncated");
    expect(byteLength(serialized)).toBeLessThan(26 * 1024);
  });

  it("replaces an oversized base64 image tool result with a media-type reference", () => {
    const base64 = "A".repeat(400_000);
    const message: AgentRuntimeMessageAppend = {
      role: "tool",
      content: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "Read",
            output: {
              type: "content",
              value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: base64 } }],
            },
          },
        ],
      },
    };

    const [out] = capPersistedRuntimeMessages([message]);
    const serialized = JSON.stringify(out);

    expect(serialized).toContain("image/png attachment omitted from persisted history");
    expect(serialized).not.toContain(base64);
    expect(byteLength(serialized)).toBeLessThan(byteLength(base64));
  });

  it("replaces an oversized base64 image in a user prompt part with a reference", () => {
    const base64 = "B".repeat(400_000);
    const message: AgentRuntimeMessageAppend = {
      role: "user",
      content: {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", image: base64, mediaType: "image/jpeg" },
        ],
      },
    };

    const [out] = capPersistedRuntimeMessages([message]);
    const serialized = JSON.stringify(out);

    expect(serialized).toContain("look at this");
    expect(serialized).toContain("image/jpeg attachment omitted from persisted history");
    expect(serialized).not.toContain(base64);
  });
});

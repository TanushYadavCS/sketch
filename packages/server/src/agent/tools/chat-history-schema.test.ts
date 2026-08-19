import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { createReadChatHistoryTool, createSearchChatHistoryTool } from "./chat-history";
import type { SketchMcpDeps } from "./types";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function advertisedProperties(tool: { inputSchema: unknown }): Record<string, { maximum?: number }> {
  const schema = z.toJSONSchema(z.object(tool.inputSchema as Record<string, z.ZodType>));
  return (schema as { properties: Record<string, { maximum?: number }> }).properties;
}

describe("chat-history advertised row-id ceilings", () => {
  const deps = {} as SketchMcpDeps;

  it.each([
    ["SearchChatHistory", createSearchChatHistoryTool, ["afterMessageId", "beforeMessageId"]],
    ["ReadChatHistory", createReadChatHistoryTool, ["anchorMessageId", "afterMessageId", "beforeMessageId"]],
  ] as const)("%s caps row-id fields at the storable maximum", (_name, create, fields) => {
    const properties = advertisedProperties(create(deps));
    for (const field of fields) {
      expect(properties[field].maximum).toBe(POSTGRES_INTEGER_MAX);
    }
  });

  it("never advertises Number.MAX_SAFE_INTEGER as an acceptable value", () => {
    for (const create of [createSearchChatHistoryTool, createReadChatHistoryTool]) {
      const maxima = Object.values(advertisedProperties(create(deps))).map((property) => property.maximum);
      expect(maxima).not.toContain(Number.MAX_SAFE_INTEGER);
    }
  });
});

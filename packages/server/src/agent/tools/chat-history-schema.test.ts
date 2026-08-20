import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { createReadChatHistoryTool } from "./chat-history";
import type { SketchMcpDeps } from "./types";

function advertisedProperties(tool: { inputSchema: unknown }): Record<string, Record<string, unknown>> {
  const schema = z.toJSONSchema(z.object(tool.inputSchema as Record<string, z.ZodType>));
  return (schema as { properties: Record<string, Record<string, unknown>> }).properties;
}

describe("ReadChatHistory advertised schema", () => {
  const deps = {} as SketchMcpDeps;

  it("exposes the unified parameter set without row-id range bounds", () => {
    const properties = advertisedProperties(createReadChatHistoryTool(deps));
    expect(Object.keys(properties).sort()).toEqual(
      [
        "afterTime",
        "anchorMessageId",
        "beforeTime",
        "conversationRef",
        "includeBotMessages",
        "limit",
        "order",
        "pageToken",
        "platform",
        "scope",
      ].sort(),
    );
    expect(properties.scope.enum).toEqual(["conversation", "current_thread", "all_chats"]);
    expect(properties.platform.enum).toEqual(["slack", "whatsapp"]);
  });

  it("does not advertise obsolete search or row-id range parameters", () => {
    const properties = advertisedProperties(createReadChatHistoryTool(deps));
    expect(properties).not.toHaveProperty("query");
    expect(properties).not.toHaveProperty("afterMessageId");
    expect(properties).not.toHaveProperty("beforeMessageId");
    expect(JSON.stringify(properties)).not.toContain("9007199254740991");
  });
});

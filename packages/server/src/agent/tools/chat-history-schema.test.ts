import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { createReadChatHistoryTool } from "./chat-history";
import { createSlackChannelHistoryTool } from "./slack-channel-history";
import type { SketchMcpDeps } from "./types";
import { createWhatsAppGroupHistoryTool } from "./whatsapp-group-history";

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

describe("model-facing chat tools accept blank optional strings", () => {
  const deps = {} as SketchMcpDeps;

  /**
   * A `.min(1)` on an optional string rejects the blank placeholders models send instead of
   * omitting the field, and it fails inside zod before the handler can normalize it.
   */
  it.each([
    ["ReadChatHistory", () => createReadChatHistoryTool(deps)],
    ["SlackChannelHistory", () => createSlackChannelHistoryTool(deps)],
    ["WhatsAppGroupHistory", () => createWhatsAppGroupHistoryTool(deps)],
  ])("%s accepts a blank placeholder for every optional string parameter", (name, build) => {
    const shape = build().inputSchema as Record<string, z.ZodType>;
    const optionalStringFields = Object.entries(shape).filter(
      ([, field]) => field.safeParse(undefined).success && field.safeParse("placeholder").success,
    );
    expect(optionalStringFields.length).toBeGreaterThan(0);

    const rejected = optionalStringFields
      .filter(([, field]) => !field.safeParse("").success)
      .map(([key]) => `${name}.${key}`);
    expect(rejected).toEqual([]);

    const blankPayload = Object.fromEntries(optionalStringFields.map(([key]) => [key, ""]));
    expect(z.object(shape).safeParse(blankPayload).success).toBe(true);
  });
});

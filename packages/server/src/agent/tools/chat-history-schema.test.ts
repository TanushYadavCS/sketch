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
    const enumOf = (property: Record<string, unknown>) => {
      if (property.enum) return property.enum;
      const variants = (property.anyOf ?? []) as Array<Record<string, unknown>>;
      return variants.find((variant) => variant.enum)?.enum;
    };
    expect(enumOf(properties.scope)).toEqual(["conversation", "current_thread", "all_chats"]);
    expect(enumOf(properties.platform)).toEqual(["slack", "whatsapp"]);
  });

  it("advertises every optional parameter as nullable so models can send null instead of a placeholder", () => {
    const shape = createReadChatHistoryTool(deps).inputSchema as Record<string, z.ZodType>;
    for (const [name, field] of Object.entries(shape)) {
      expect(field.safeParse(null).success, `${name} should accept null`).toBe(true);
      expect(field.safeParse(undefined).success, `${name} should accept undefined`).toBe(true);
    }
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

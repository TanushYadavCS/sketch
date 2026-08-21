import { CHANNEL_WRITE_AGENT_TOOL_NAME } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_ALLOWED_TOOLS } from "./add-member-dialog";

describe("new agent tool defaults", () => {
  it("does not grant shared-destination posting by default", () => {
    expect(DEFAULT_AGENT_ALLOWED_TOOLS).not.toContain(CHANNEL_WRITE_AGENT_TOOL_NAME);
  });
});

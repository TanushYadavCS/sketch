import { describe, expect, it } from "vitest";
import { mapTemplateParams, sanitizeTemplateParamValue } from "./template-params";
import { buildReconnectNotificationTemplate } from "./templates";

describe("sanitizeTemplateParamValue", () => {
  it("replaces newlines and tabs with spaces", () => {
    expect(sanitizeTemplateParamValue("a\nb\rc\td")).toBe("a b c d");
  });

  it("collapses runs of three or more spaces to two spaces", () => {
    expect(sanitizeTemplateParamValue("a   b    c  d")).toBe("a  b  c  d");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeTemplateParamValue("  hello world  ")).toBe("hello world");
  });

  it("truncates to 300 characters", () => {
    expect(
      sanitizeTemplateParamValue(
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ),
    ).toHaveLength(300);
  });

  it("applies all transformations together", () => {
    const input =
      "  first\n\tsecond      xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  ";
    const result = sanitizeTemplateParamValue(input);

    expect(result).toHaveLength(300);
    expect(result.startsWith("first second  xxx")).toBe(true);
    expect(result).not.toMatch(/[\n\r\t]/u);
    expect(result).not.toMatch(/ {3,}/u);
  });
});

describe("mapTemplateParams", () => {
  it("binds the reconnect notification params to the approved provider placeholders in order", () => {
    const template = buildReconnectNotificationTemplate({
      recipientName: "Ashish",
      phoneNumber: "+91 9980470200",
      reconnectUrl: "https://goosebumps.getsketch.ai/channels",
      fallbackText: "fallback",
    });

    expect(
      mapTemplateParams({ "1": "recipientName", "2": "phoneNumber", "3": "reconnectUrl" }, template.params),
    ).toEqual([
      ["1", "Ashish"],
      ["2", "+91 9980470200"],
      ["3", "https://goosebumps.getsketch.ai/channels"],
    ]);
  });
});

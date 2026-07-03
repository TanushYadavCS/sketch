import { describe, expect, it } from "vitest";
import { sanitizeTemplateParamValue } from "./template-params";

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

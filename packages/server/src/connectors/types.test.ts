import { describe, expect, it } from "vitest";
import { normalizeAccessPrincipals } from "./types";

describe("normalizeAccessPrincipals", () => {
  it("normalizes email-typed object values", () => {
    expect(normalizeAccessPrincipals([{ type: "email", value: "  Alice@Example.COM " }])).toEqual([
      { type: "email", value: "alice@example.com" },
    ]);
  });
});

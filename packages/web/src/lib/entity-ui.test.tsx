import { describe, expect, it } from "vitest";
import { entityDisplayLabel } from "./entity-ui";

describe("entityDisplayLabel", () => {
  it("brackets the placeholder identifier behind the proposed name", () => {
    expect(entityDisplayLabel({ name: "+919891688787", proposedName: "Tanush Yadav" })).toBe(
      "Tanush Yadav (+919891688787)",
    );
  });

  it("renders the stored name alone when no proposal exists", () => {
    expect(entityDisplayLabel({ name: "+919891688787", proposedName: null })).toBe("+919891688787");
    expect(entityDisplayLabel({ name: "Tanush Yadav" })).toBe("Tanush Yadav");
  });

  it("treats a blank proposal as no proposal", () => {
    expect(entityDisplayLabel({ name: "+919891688787", proposedName: "   " })).toBe("+919891688787");
  });
});

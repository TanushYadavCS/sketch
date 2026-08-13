import { describe, expect, it } from "vitest";
import { compactEntityNameKey } from "./match-normalize";

describe("compactEntityNameKey", () => {
  it("folds separators and case so name variants share one key", () => {
    expect(compactEntityNameKey("company", "One Stop")).toBe("onestop");
    expect(compactEntityNameKey("company", "Onestop")).toBe("onestop");
    expect(compactEntityNameKey("company", "one-stop")).toBe("onestop");
    expect(compactEntityNameKey("company", "one.stop")).toBe("onestop");
  });
});

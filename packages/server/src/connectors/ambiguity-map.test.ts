import { describe, expect, it } from "vitest";
import { createAmbiguityAwareMap } from "./ambiguity-map";

describe("createAmbiguityAwareMap", () => {
  it("returns a set value for a fresh key", () => {
    const m = createAmbiguityAwareMap<string, string>();
    m.add("bob", "bob@x");
    expect(m.get("bob")).toBe("bob@x");
    expect(m.isAmbiguous("bob")).toBe(false);
    expect(m.size).toBe(1);
  });

  it("keeps the value when the same key/value is added again", () => {
    const m = createAmbiguityAwareMap<string, string>();
    m.add("bob", "bob@x");
    m.add("bob", "bob@x");
    expect(m.get("bob")).toBe("bob@x");
    expect(m.size).toBe(1);
  });

  it("drops the key and tags ambiguous on a conflicting value", () => {
    const m = createAmbiguityAwareMap<string, string>();
    m.add("bob", "bob@a");
    m.add("bob", "bob@b");
    expect(m.get("bob")).toBeUndefined();
    expect(m.isAmbiguous("bob")).toBe(true);
    expect(m.size).toBe(0);
  });

  it("refuses to re-set an ambiguous key", () => {
    const m = createAmbiguityAwareMap<string, string>();
    m.add("bob", "bob@a");
    m.add("bob", "bob@b");
    m.add("bob", "bob@c");
    m.add("bob", "bob@a");
    expect(m.get("bob")).toBeUndefined();
    expect(m.isAmbiguous("bob")).toBe(true);
  });

  it("compares values by referential equality for object values", () => {
    const m = createAmbiguityAwareMap<string, { email: string }>();
    const v1 = { email: "x@y" };
    const v2 = { email: "x@y" };
    m.add("k", v1);
    m.add("k", v2);
    expect(m.isAmbiguous("k")).toBe(true);
  });
});

import type { BrowseResult } from "@/lib/api";
import { describe, expect, it } from "vitest";
import { buildScopeFromSelection, computeSelectedFromScope } from "./scope-picker";

const groups: BrowseResult = {
  type: "flat",
  items: [
    { id: "shown-on@g.us", name: "Shown on" },
    { id: "shown-off@g.us", name: "Shown off" },
  ],
};

describe("flat scope shapes", () => {
  it("reads true entries from a map-shaped scope", () => {
    const selected = computeSelectedFromScope(
      groups,
      {
        groupIndexing: {
          "shown-on@g.us": true,
          "shown-off@g.us": false,
          "not-displayed@g.us": true,
        },
      },
      "groupIndexing",
      "map",
    );

    expect([...selected]).toEqual(["shown-on@g.us"]);
  });

  it("writes a boolean map containing only displayed items", () => {
    expect(buildScopeFromSelection(groups, new Set(["shown-on@g.us"]), "groupIndexing", "map")).toEqual({
      groupIndexing: {
        "shown-on@g.us": true,
        "shown-off@g.us": false,
      },
    });
  });

  it("sends only the boxes the user clicked", () => {
    const touched = new Set(["shown-on@g.us"]);

    expect(buildScopeFromSelection(groups, new Set(), "groupIndexing", "map", touched)).toEqual({
      groupIndexing: { "shown-on@g.us": false },
    });
  });

  it("sends nothing for an untouched picker, so a concurrent change survives", () => {
    expect(buildScopeFromSelection(groups, new Set(["shown-on@g.us"]), "groupIndexing", "map", new Set())).toEqual({
      groupIndexing: {},
    });
  });

  /**
   * The bug this replaced: the payload used to be derived by diffing the
   * current selection against the live baseline. A group that arrived in a
   * refresh after the picker opened is enabled by default, so it differs from
   * the user's stale selection and was sent as a `false` nobody asked for.
   */
  it("leaves a group that appeared mid-edit alone", () => {
    const withNewGroup: BrowseResult = {
      type: "flat",
      items: [
        ...(groups as { items: Array<{ id: string; name: string }> }).items,
        { id: "just-joined@g.us", name: "Just joined" },
      ],
    };
    const userUnticked = new Set(["shown-off@g.us"]);

    const scope = buildScopeFromSelection(withNewGroup, new Set(), "groupIndexing", "map", userUnticked);

    expect(scope).toEqual({ groupIndexing: { "shown-off@g.us": false } });
    expect(Object.keys(scope.groupIndexing as object)).not.toContain("just-joined@g.us");
  });
});

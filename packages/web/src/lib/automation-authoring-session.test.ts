import { describe, expect, it } from "vitest";
import {
  AUTOMATION_AUTHORING_SESSION_STORAGE_KEY,
  type AutomationAuthoringStorage,
  resolveAutomationAuthoringSessionId,
} from "./automation-authoring-session";

function storage(initial?: string): AutomationAuthoringStorage {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, nextValue) => {
      value = nextValue;
    },
  };
}

function uuids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `uuid-${index}`;
}

describe("automation authoring session identity", () => {
  it.each(["reload", "back_forward"] as const)("reuses storage on %s", (navigationType) => {
    const sessionStorage = storage();
    const first = resolveAutomationAuthoringSessionId({
      navigationType: "navigate",
      storage: sessionStorage,
      randomUUID: uuids("first"),
    });
    const next = resolveAutomationAuthoringSessionId({
      navigationType,
      storage: sessionStorage,
      randomUUID: uuids("unexpected"),
    });

    expect(first).toBe("first");
    expect(next).toBe(first);
  });

  it("rotates a copied session on a new navigation", () => {
    expect(
      resolveAutomationAuthoringSessionId({
        navigationType: "navigate",
        storage: storage("copied-session"),
        randomUUID: uuids("new-session"),
      }),
    ).toBe("new-session");
  });

  it("uses a fresh ID when navigation type is unavailable", () => {
    expect(
      resolveAutomationAuthoringSessionId({
        navigationType: "unknown",
        storage: storage("copied-session"),
        randomUUID: uuids("safe-fallback"),
      }),
    ).toBe("safe-fallback");
  });

  it("supports an unavailable storage without throwing", () => {
    const unavailableStorage: AutomationAuthoringStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(
      resolveAutomationAuthoringSessionId({
        navigationType: "reload",
        storage: unavailableStorage,
        randomUUID: uuids("in-memory"),
      }),
    ).toBe("in-memory");
  });

  it("writes the versioned key", () => {
    const writes: string[] = [];
    const sessionStorage: AutomationAuthoringStorage = {
      getItem: () => null,
      setItem: (key) => writes.push(key),
    };

    resolveAutomationAuthoringSessionId({
      navigationType: "navigate",
      storage: sessionStorage,
      randomUUID: uuids("session"),
    });

    expect(writes).toEqual([AUTOMATION_AUTHORING_SESSION_STORAGE_KEY]);
    expect(AUTOMATION_AUTHORING_SESSION_STORAGE_KEY).toContain(":v1");
  });
});

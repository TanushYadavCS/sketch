import { describe, expect, it } from "vitest";
import {
  AUTOMATION_AUTHORING_CLAIM_KEY_PREFIX,
  AUTOMATION_AUTHORING_SESSION_STORAGE_KEY,
  type AutomationAuthoringStorage,
  bindAutomationAuthoringSessionLifecycle,
  createAutomationAuthoringSession,
} from "./automation-authoring-session";

function storage(): AutomationAuthoringStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function uuids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `uuid-${index}`;
}

describe("automation authoring session", () => {
  it("persists one session across a same-tab reload", () => {
    const sessionStorage = storage();
    const localStorage = storage();
    const first = createAutomationAuthoringSession({
      sessionStorage,
      localStorage,
      navigationType: "navigate",
      randomUUID: uuids("session-a", "context-a", "owner-a"),
    });
    const reloaded = createAutomationAuthoringSession({
      sessionStorage,
      localStorage,
      navigationType: "reload",
      randomUUID: uuids("owner-b"),
    });

    expect(reloaded.clientSessionId).toBe(first.clientSessionId);
    expect(reloaded.contextToken).toBe(first.contextToken);
    expect(reloaded.isClaimed()).toBe(true);
  });

  it("rotates a cloned session when a duplicated tab navigates", () => {
    const sessionStorage = storage();
    const localStorage = storage();
    const first = createAutomationAuthoringSession({
      sessionStorage,
      localStorage,
      navigationType: "navigate",
      randomUUID: uuids("session-a", "context-a", "owner-a"),
    });
    const duplicate = createAutomationAuthoringSession({
      sessionStorage,
      localStorage,
      navigationType: "navigate",
      randomUUID: uuids("owner-b", "session-b", "context-b"),
    });

    expect(duplicate.clientSessionId).toBe("session-b");
    expect(duplicate.clientSessionId).not.toBe(first.clientSessionId);
    expect(first.isClaimed()).toBe(true);
    expect(duplicate.isClaimed()).toBe(true);
  });

  it("reuses an abandoned claim after its bounded TTL", () => {
    const sessionStorage = storage();
    const localStorage = storage();
    let clock = 1_000;
    const first = createAutomationAuthoringSession({
      sessionStorage,
      localStorage,
      now: () => clock,
      navigationType: "navigate",
      claimTtlMs: 100,
      randomUUID: uuids("session-a", "context-a", "owner-a"),
    });
    clock += 101;
    const recovered = createAutomationAuthoringSession({
      sessionStorage,
      localStorage,
      now: () => clock,
      navigationType: "navigate",
      claimTtlMs: 100,
      randomUUID: uuids("owner-b"),
    });

    expect(recovered.clientSessionId).toBe(first.clientSessionId);
    expect(recovered.isClaimed()).toBe(true);
  });

  it("marks a claim closing on pagehide and clears it on dispose", () => {
    const sessionStorage = storage();
    const localStorage = storage();
    let hidden = 0;
    let shown = 0;
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener(type: "pagehide" | "pageshow", listener: () => void) {
        listeners.set(type, listener);
      },
      removeEventListener(type: "pagehide" | "pageshow") {
        if (type === "pagehide") hidden += 1;
        if (type === "pageshow") shown += 1;
      },
    };
    const session = createAutomationAuthoringSession({
      sessionStorage,
      localStorage,
      randomUUID: uuids("session-a", "context-a", "owner-a"),
    });
    const unbind = bindAutomationAuthoringSessionLifecycle(session, target);
    listeners.get("pagehide")?.();
    expect(
      JSON.parse(localStorage.getItem(`${AUTOMATION_AUTHORING_CLAIM_KEY_PREFIX}${session.clientSessionId}`) ?? "null"),
    ).toMatchObject({ closingAt: expect.any(Number) });
    listeners.get("pageshow")?.();
    expect(session.isClaimed()).toBe(true);
    unbind();
    expect(hidden).toBe(1);
    expect(shown).toBe(1);
    session.dispose();
    expect(localStorage.getItem(`${AUTOMATION_AUTHORING_CLAIM_KEY_PREFIX}${session.clientSessionId}`)).toBeNull();
    expect(sessionStorage.getItem(AUTOMATION_AUTHORING_SESSION_STORAGE_KEY)).not.toBeNull();
  });
});

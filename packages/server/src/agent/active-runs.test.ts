import { describe, expect, it } from "vitest";
import {
  abortActiveRun,
  isActiveRun,
  listActiveRuns,
  registerActiveRun,
  unregisterActiveRun,
  webChatRunKey,
  withActiveRun,
} from "./active-runs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("active runs", () => {
  it("deregisters after a successful run", async () => {
    const controller = new AbortController();

    await withActiveRun("success", controller, async () => "done");

    expect(isActiveRun("success")).toBe(false);
  });

  it("deregisters after a thrown error", async () => {
    const controller = new AbortController();

    await expect(
      withActiveRun("error", controller, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(isActiveRun("error")).toBe(false);
  });

  it("deregisters after an aborted run", async () => {
    const controller = new AbortController();

    await withActiveRun("abort", controller, async () => {
      controller.abort();
    });

    expect(isActiveRun("abort")).toBe(false);
  });

  it("does not let a late finisher evict a newer run", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = deferred<void>();
    const second = deferred<void>();

    const firstRun = withActiveRun("same-key", firstController, () => first.promise);
    const secondRun = withActiveRun("same-key", secondController, () => second.promise);

    first.resolve();
    await firstRun;

    expect(isActiveRun("same-key")).toBe(true);
    expect(listActiveRuns()).toEqual([expect.objectContaining({ key: "same-key", controller: secondController })]);

    second.resolve();
    await secondRun;
    expect(isActiveRun("same-key")).toBe(false);
  });

  it("returns false when interrupting a run that is not live", () => {
    expect(abortActiveRun("missing")).toBe(false);
  });

  it("keeps the parent registered when a reentrant child is aborted", async () => {
    const parentController = new AbortController();
    const childController = new AbortController();
    const child = deferred<void>();

    registerActiveRun("parent", parentController, { platform: "slack", channelId: "C1", threadTs: "1" });
    const childRun = withActiveRun("child", childController, () => child.promise, {
      platform: "slack",
      channelId: "C1",
      threadTs: "1",
    });

    expect(webChatRunKey("user", "conversation")).toBe("user:conversation");
    expect(abortActiveRun("child")).toBe(true);
    expect(childController.signal.aborted).toBe(true);
    expect(isActiveRun("parent")).toBe(true);

    child.resolve();
    await childRun;
    unregisterActiveRun("parent", parentController);
  });
});

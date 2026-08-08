import { describe, expect, it } from "vitest";
import {
  abortActiveRun,
  abortActiveRuns,
  createChildAbortController,
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

  it("aborts only live runs selected by metadata", async () => {
    const targetController = new AbortController();
    const secondTargetController = new AbortController();
    const otherController = new AbortController();
    const waitForAbort = (controller: AbortController) =>
      new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    const targetRun = withActiveRun("target-run", targetController, () => waitForAbort(targetController), {
      platform: "slack",
      channelId: "C1",
      threadTs: "1",
    });
    const secondTargetRun = withActiveRun(
      "second-target-run",
      secondTargetController,
      () => waitForAbort(secondTargetController),
      { platform: "slack", channelId: "C1", threadTs: "1" },
    );
    const otherRun = withActiveRun("other-run", otherController, () => waitForAbort(otherController), {
      platform: "slack",
      channelId: "C1",
      threadTs: "2",
    });

    expect(
      abortActiveRuns(
        (entry) =>
          entry.metadata?.platform === "slack" && entry.metadata.channelId === "C1" && entry.metadata.threadTs === "1",
      ),
    ).toBe(2);
    expect(targetController.signal.aborted).toBe(true);
    expect(secondTargetController.signal.aborted).toBe(true);
    expect(otherController.signal.aborted).toBe(false);
    expect(
      abortActiveRuns(
        (entry) =>
          entry.metadata?.platform === "slack" && entry.metadata.channelId === "C1" && entry.metadata.threadTs === "1",
      ),
    ).toBe(0);

    otherController.abort();
    await Promise.all([targetRun, secondTargetRun, otherRun]);
  });

  it("links a child controller to its parent without sharing upward aborts", () => {
    const parentController = new AbortController();
    const childController = createChildAbortController(parentController.signal);

    childController.abort();
    expect(childController.signal.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(false);

    const secondChildController = createChildAbortController(parentController.signal);
    parentController.abort();
    expect(secondChildController.signal.aborted).toBe(true);
  });

  it("builds the web chat key from user and conversation", () => {
    expect(webChatRunKey("user", "conversation")).toBe("user:conversation");
  });

  /**
   * A reentrant child runs in its parent's channel and thread. Keying on that shared
   * context would make the child overwrite the parent, so the parent would survive the
   * child's deregistration only by accident and could never be aborted again. Keys are
   * per-run precisely so both coexist.
   */
  it("keeps a reentrant child in the same channel and thread separate from its parent", async () => {
    const sharedContext = { platform: "slack", channelId: "C1", threadTs: "1" } as const;
    const parentController = new AbortController();
    const childController = new AbortController();
    const child = deferred<void>();

    const parentKey = "slack:11111111-1111-4111-8111-111111111111";
    const childKey = "slack:22222222-2222-4222-8222-222222222222";

    registerActiveRun(parentKey, parentController, { ...sharedContext });
    const childRun = withActiveRun(childKey, childController, () => child.promise, { ...sharedContext });

    const sharedThreadRuns = listActiveRuns().filter(
      (entry) => entry.metadata?.channelId === "C1" && entry.metadata?.threadTs === "1",
    );
    expect(sharedThreadRuns).toHaveLength(2);

    expect(abortActiveRun(childKey)).toBe(true);
    expect(childController.signal.aborted).toBe(true);
    expect(parentController.signal.aborted).toBe(false);
    expect(isActiveRun(parentKey)).toBe(true);

    child.resolve();
    await childRun;

    expect(isActiveRun(childKey)).toBe(false);
    expect(isActiveRun(parentKey)).toBe(true);

    unregisterActiveRun(parentKey, parentController);
  });
});

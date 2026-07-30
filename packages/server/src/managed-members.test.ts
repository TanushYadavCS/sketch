import { describe, expect, it, vi } from "vitest";
import { reconcileManagedTenantMembers, withManagedMemberSyncLock } from "./managed-members";
import { createTestConfig, createTestLogger } from "./test-utils";

describe("managed member reconciliation", () => {
  it("loads the current member snapshot only after acquiring the synchronization lock", async () => {
    let releaseLock = () => {};
    let confirmLockAcquired = () => {};
    const lockAcquired = new Promise<void>((resolve) => {
      confirmLockAcquired = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withManagedMemberSyncLock(async () => {
      confirmLockAcquired();
      await holdLock;
    });
    await lockAcquired;

    const loadUsers = vi.fn().mockResolvedValue([]);
    const reconciliation = reconcileManagedTenantMembers(
      createTestConfig({
        MANAGED_WHATSAPP_PLATFORM_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
      }),
      loadUsers,
      createTestLogger(),
    );

    await Promise.resolve();
    expect(loadUsers).not.toHaveBeenCalled();

    releaseLock();
    await blocker;
    await expect(reconciliation).resolves.toEqual({
      skipped: false,
      total: 0,
      synced: 0,
      conflictUserIds: [],
      failedUserIds: [],
    });
    expect(loadUsers).toHaveBeenCalledOnce();
  });
});

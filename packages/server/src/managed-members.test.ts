import { afterEach, describe, expect, it, vi } from "vitest";
import { type ManagedMemberUser, reconcileManagedTenantMembers, withManagedMemberSyncLock } from "./managed-members";
import { createTestConfig, createTestLogger } from "./test-utils";

describe("managed member reconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-reads each member after acquiring that member's synchronization lock", async () => {
    const snapshotUser: ManagedMemberUser = {
      id: "user-a",
      type: "human",
      email: "member@example.com",
      whatsapp_number: "+14155550100",
      name: "Before",
    };
    let currentUser = snapshotUser;
    const users = {
      list: vi.fn(async () => [snapshotUser]),
      findById: vi.fn(async () => currentUser),
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, mappingStatus: "active", emailSent: false, whatsappSent: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let releaseLock = () => {};
    let confirmLockAcquired = () => {};
    const lockAcquired = new Promise<void>((resolve) => {
      confirmLockAcquired = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withManagedMemberSyncLock(snapshotUser.id, async () => {
      confirmLockAcquired();
      await holdLock;
    });
    await lockAcquired;

    const reconciliation = reconcileManagedTenantMembers(
      createTestConfig({
        MANAGED_WHATSAPP_PLATFORM_URL: "https://platform.test",
        MANAGED_WHATSAPP_TENANT_TOKEN: "tenant-token",
        WHATSAPP_DM_PROVIDER: "managed",
      }),
      users,
      createTestLogger(),
    );
    await Promise.resolve();
    expect(users.list).toHaveBeenCalledOnce();
    expect(users.findById).not.toHaveBeenCalled();

    currentUser = {
      ...snapshotUser,
      name: "After",
      whatsapp_number: "+14155550101",
    };
    releaseLock();
    await blocker;
    await reconciliation;

    expect(users.findById).toHaveBeenCalledWith(snapshotUser.id);
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) throw new Error("Expected managed member request options");
    expect(JSON.parse(request.body as string)).toMatchObject({
      tenantUserId: snapshotUser.id,
      name: "After",
      phoneNumber: "+14155550101",
    });
  });

  it("does not block synchronization work for a different member", async () => {
    let releaseLock = () => {};
    let confirmLockAcquired = () => {};
    const lockAcquired = new Promise<void>((resolve) => {
      confirmLockAcquired = resolve;
    });
    const holdLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withManagedMemberSyncLock("user-a", async () => {
      confirmLockAcquired();
      await holdLock;
    });
    await lockAcquired;

    const differentMemberOperation = vi.fn(async () => "completed");
    await expect(withManagedMemberSyncLock("user-b", differentMemberOperation)).resolves.toBe("completed");
    expect(differentMemberOperation).toHaveBeenCalledOnce();

    releaseLock();
    await blocker;
  });
});

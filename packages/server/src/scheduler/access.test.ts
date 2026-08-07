import { describe, expect, it } from "vitest";
import { canAccessScheduledTask, resolveScheduledTaskAccess } from "./access";

describe("scheduled task access", () => {
  it("allows the owner and denies a different member", () => {
    expect(canAccessScheduledTask("owner-1", { userId: "owner-1", role: "member" })).toBe(true);
    expect(canAccessScheduledTask("owner-1", { userId: "member-1", role: "member" })).toBe(false);
  });

  it("allows an admin to resolve a foreign-owned task", () => {
    const task = { id: "task-1", createdBy: "owner-1" };
    expect(resolveScheduledTaskAccess(task, task.createdBy, { userId: "admin-1", role: "admin" })).toEqual(task);
  });

  it("fails closed for missing identity or task", () => {
    const task = { id: "task-1", createdBy: "owner-1" };
    expect(resolveScheduledTaskAccess(task, task.createdBy, { userId: null, role: "admin" })).toBeNull();
    expect(resolveScheduledTaskAccess(null, null, { userId: "owner-1", role: "member" })).toBeNull();
  });
});

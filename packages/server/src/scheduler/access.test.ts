import { describe, expect, it } from "vitest";
import { canAccessScheduledTask, resolveScheduledTaskAccess } from "./access";

describe("scheduled task access", () => {
  it("allows the owner and denies a different member without a grant", () => {
    expect(canAccessScheduledTask("owner-1", new Set(), { userId: "owner-1" })).toBe(true);
    expect(canAccessScheduledTask("owner-1", new Set(), { userId: "member-1" })).toBe(false);
  });

  it("allows an explicitly granted member", () => {
    expect(canAccessScheduledTask("owner-1", new Set(["member-1"]), { userId: "member-1" })).toBe(true);
  });

  it("denies an admin without a grant", () => {
    expect(canAccessScheduledTask("owner-1", new Set(), { userId: "admin-1" })).toBe(false);
    expect(canAccessScheduledTask("owner-1", new Set(["member-1"]), { userId: "admin-1" })).toBe(false);
  });

  it("fails closed for missing identity or task", () => {
    const task = { id: "task-1", createdBy: "owner-1" };
    expect(canAccessScheduledTask("owner-1", new Set(["member-1"]), { userId: null })).toBe(false);
    expect(canAccessScheduledTask(null, new Set(), { userId: "owner-1" })).toBe(false);
    expect(resolveScheduledTaskAccess(task, task.createdBy, new Set(), { userId: null })).toBeNull();
    expect(resolveScheduledTaskAccess(null, null, new Set(), { userId: "owner-1" })).toBeNull();
  });

  it("resolves the task for the owner or a grantee and hides it otherwise", () => {
    const task = { id: "task-1", createdBy: "owner-1" };
    expect(resolveScheduledTaskAccess(task, task.createdBy, new Set(), { userId: "owner-1" })).toEqual(task);
    expect(resolveScheduledTaskAccess(task, task.createdBy, new Set(["member-1"]), { userId: "member-1" })).toEqual(
      task,
    );
    expect(resolveScheduledTaskAccess(task, task.createdBy, new Set(), { userId: "member-1" })).toBeNull();
    expect(resolveScheduledTaskAccess(task, task.createdBy, new Set(), { userId: "admin-1" })).toBeNull();
  });
});

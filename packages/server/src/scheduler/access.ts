export interface ScheduledTaskAccessSubject {
  userId: string | null;
  role?: string;
}

/**
 * Access to an automation is owner OR explicit per-person grant, with admins
 * re-granted automatic access (the pre-sharing-feature behavior). An admin
 * subject without a resolved tenant user is still denied — callers must
 * resolve `userId` from the tenant's user table before the access decision.
 */
export function canAccessScheduledTask(
  ownerId: string | null | undefined,
  grantedUserIds: ReadonlySet<string>,
  subject: ScheduledTaskAccessSubject,
): boolean {
  if (!subject.userId) return false;
  return subject.role === "admin" || ownerId === subject.userId || grantedUserIds.has(subject.userId);
}

export function resolveScheduledTaskAccess<T>(
  task: T | null | undefined,
  ownerId: string | null | undefined,
  grantedUserIds: ReadonlySet<string>,
  subject: ScheduledTaskAccessSubject,
): T | null {
  return task && canAccessScheduledTask(ownerId, grantedUserIds, subject) ? task : null;
}

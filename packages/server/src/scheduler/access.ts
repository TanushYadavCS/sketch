export interface ScheduledTaskAccessSubject {
  userId: string | null;
}

/**
 * Access to an automation is owner OR explicit per-person grant. Admins have
 * no automatic access — callers must preload the grant set (e.g. via
 * createAutomationSharesRepository().listTaskIdsForUser / hasGrant) and pass
 * it in; the access decision itself is a pure function.
 */
export function canAccessScheduledTask(
  ownerId: string | null | undefined,
  grantedUserIds: ReadonlySet<string>,
  subject: ScheduledTaskAccessSubject,
): boolean {
  if (!subject.userId) return false;
  return ownerId === subject.userId || grantedUserIds.has(subject.userId);
}

export function resolveScheduledTaskAccess<T>(
  task: T | null | undefined,
  ownerId: string | null | undefined,
  grantedUserIds: ReadonlySet<string>,
  subject: ScheduledTaskAccessSubject,
): T | null {
  return task && canAccessScheduledTask(ownerId, grantedUserIds, subject) ? task : null;
}

export interface ScheduledTaskAccessSubject {
  userId: string | null;
  role?: string;
}

export function canAccessScheduledTask(
  ownerId: string | null | undefined,
  subject: ScheduledTaskAccessSubject,
): boolean {
  if (!subject.userId) return false;
  return subject.role === "admin" || ownerId === subject.userId;
}

export function resolveScheduledTaskAccess<T>(
  task: T | null | undefined,
  ownerId: string | null | undefined,
  subject: ScheduledTaskAccessSubject,
): T | null {
  return task && canAccessScheduledTask(ownerId, subject) ? task : null;
}

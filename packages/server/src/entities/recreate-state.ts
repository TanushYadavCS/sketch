let recreateActive = false;

export function isRecreateActive(): boolean {
  return recreateActive;
}

export function beginRecreateLock(): void {
  if (recreateActive) {
    throw new Error("ENTITY_RECREATE_ACTIVE");
  }
  recreateActive = true;
}

export function endRecreateLock(): void {
  recreateActive = false;
}

export async function withRecreateLock<T>(fn: () => Promise<T>): Promise<T> {
  beginRecreateLock();
  try {
    return await fn();
  } finally {
    endRecreateLock();
  }
}

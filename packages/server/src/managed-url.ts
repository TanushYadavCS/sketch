export function createManagedLoginUrl(managedUrl: string): URL {
  return new URL(`${managedUrl.replace(/\/+$/, "")}/login`);
}

export function managedLoginHref(managedUrl: string | null | undefined): string {
  return managedUrl ? createManagedLoginUrl(managedUrl).toString() : "/login";
}

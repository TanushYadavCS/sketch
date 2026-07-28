import { redirect } from "@tanstack/react-router";

export function managedLoginUrl(managedUrl: string, returnTo?: string | null): string {
  const url = new URL(`${managedUrl.replace(/\/+$/, "")}/login`);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return url.toString();
}

export function managedSlackAuthorizationUrl(managedUrl: string, returnTo: string): string {
  const url = new URL(`${managedUrl.replace(/\/+$/, "")}/api/slack/connections/authorization`);
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}

export function redirectToManagedLogin(managedUrl: string, returnTo?: string | null): never {
  throw redirect({ href: managedLoginUrl(managedUrl, returnTo) });
}

import { redirect } from "@tanstack/react-router";

export function managedLoginUrl(managedUrl: string): string {
  return `${managedUrl.replace(/\/+$/, "")}/login`;
}

export function redirectToManagedLogin(managedUrl: string): never {
  throw redirect({ href: managedLoginUrl(managedUrl) });
}

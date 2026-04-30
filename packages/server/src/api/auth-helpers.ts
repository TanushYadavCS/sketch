/**
 * Authorization helpers for connector and OAuth routes.
 *
 * Pattern: each helper returns Response | null. Routes use:
 *   const denied = denyIfNotAdmin(c); if (denied) return denied;
 *
 * Forgetting the `if (denied) return denied` line silently fails open —
 * see tests/api/connectors-authz.test.ts for the route-enumeration regression
 * test that catches this.
 */
import type { Context } from "hono";

export function isAdmin(c: Context): boolean {
  return c.get("role") === "admin";
}

export function denyIfNotAdmin(c: Context): Response | null {
  if (isAdmin(c)) return null;
  return c.json({ error: { code: "FORBIDDEN", message: "Admin role required" } }, 403);
}

/** Edit semantics: admin OR the row's owner. */
export function denyIfCannotEdit(c: Context, config: { created_by: string }): Response | null {
  if (isAdmin(c) || config.created_by === c.get("sub")) return null;
  return c.json({ error: { code: "FORBIDDEN", message: "Not authorized for this connector" } }, 403);
}

/** Read semantics: org-wide rows visible to all; per-user rows visible to admin or owner. */
export function denyIfCannotRead(c: Context, config: { created_by: string }, perUserAuth: boolean): Response | null {
  if (!perUserAuth) return null;
  return denyIfCannotEdit(c, config);
}

/** File-list viewer descriptor — passed to repo helpers for RBAC. Admins bypass; others filter by email. */
export interface FileViewer {
  email: string | null;
  isAdmin: boolean;
}

/** Build a FileViewer from the request context. */
export function getFileViewer(c: Context): FileViewer {
  return { email: c.get("email") ?? null, isAdmin: isAdmin(c) };
}

/**
 * Same shape as getFileViewer but always isAdmin: false.
 * Use for content-read endpoints (file body, mention contexts) — admin role grants
 * ops access (manage connectors, see metadata) but does NOT confer read access to
 * private contents. The two named call sites make the asymmetry obvious.
 */
export function getContentViewer(c: Context): FileViewer {
  return { email: c.get("email") ?? null, isAdmin: false };
}

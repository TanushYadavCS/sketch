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

export interface ConnectorPermissions {
  isOwner: boolean;
  canView: boolean;
  canManage: boolean;
  canDisconnect: boolean;
  canSync: boolean;
  canChangeScope: boolean;
  canUpdateCredentials: boolean;
  canBrowseScope: boolean;
  canEnrich: boolean;
}

export function connectorPermissions(
  c: Context,
  config: { created_by: string; sync_status: string },
  perUserAuth: boolean,
): ConnectorPermissions {
  const isOwner = config.created_by === c.get("sub");
  const orgWide = !perUserAuth;
  const enabled = config.sync_status !== "disabled";
  const canManage = orgWide ? isAdmin(c) : isOwner;
  return {
    isOwner,
    canView: orgWide || isOwner || isAdmin(c),
    canManage,
    canDisconnect: canManage && enabled,
    canSync: canManage && enabled,
    canChangeScope: canManage && enabled,
    canUpdateCredentials: canManage && enabled,
    canBrowseScope: canManage,
    canEnrich: canManage && enabled,
  };
}

export function denyUnless(c: Context, allowed: boolean): Response | null {
  if (allowed) return null;
  return c.json({ error: { code: "FORBIDDEN", message: "Not authorized for this connector" } }, 403);
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
 * Same shape as getFileViewer but admin status is gated by the org-level
 * `admin_can_read_all_files` setting. By default admin role grants ops access
 * (manage connectors, see metadata) but does NOT confer read access to private
 * contents. Orgs that need it can flip the setting on from Settings → Access.
 * The agent file-content tool stays on email rails regardless of this setting.
 */
export function getContentViewer(c: Context): FileViewer {
  const bypass = c.get("adminCanReadAllFiles") === true;
  return { email: c.get("email") ?? null, isAdmin: isAdmin(c) && bypass };
}

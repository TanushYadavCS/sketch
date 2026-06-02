/** MCP server record as returned by the API. */
export interface McpServerRecord {
  id: string;
  type: string | null;
  slug: string;
  displayName: string;
  url: string;
  apiUrl: string | null;
  credentials: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
}

/** App from an integration provider's catalog. */
export interface IntegrationApp {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category?: string;
}

/** A user's connection to an app via an integration provider. */
export interface IntegrationConnection {
  id: string;
  providerId: string;
  source?: "canvas_user_secrets" | "pipedream" | string;
  appId: string;
  appName: string;
  app?: { name: string; nameSlug: string; imgSrc?: string };
  icon?: string;
  accountName?: string;
  authType?: "oauth" | "api_key" | string;
  healthy?: boolean;
  status: "active" | "error" | "expired";
  accessLevel?: "personal" | "organization";
  ownerUserId?: string;
  ownerName?: string;
  isOwnedByViewer?: boolean;
  canUse?: boolean;
  canManageAccess?: boolean;
  canDelete?: boolean;
  createdAt: string;
  connectedAt?: string;
}

/** Pagination info for cursor-based pagination. */
export interface PageInfo {
  endCursor: string | null;
  hasMore: boolean;
}

/**
 * Canvas integration provider adapter.
 * Canvas internally uses Pipedream for app connections. All API calls
 * are scoped to the org via the API key, and to the user via X-User-Email header.
 * Canvas resolves the email to its own user ID for Pipedream scoping.
 *
 * Constructor accepts apiUrl and apiKey directly (extracted from the mcp_servers row)
 * rather than a credentials object, since the unified table stores them separately.
 */
import { join } from "node:path";
import type { IntegrationApp, IntegrationConnection, PageInfo } from "@sketch/shared";
import type { CredentialEnvelope } from "../connectors/credential-envelope";
import type { BrokerSpec, IntegrationProvider, IntegrationUserOrgRole } from "./types";

type CanvasAccountResponse = {
  id: string;
  source?: "canvas_user_secrets" | "pipedream" | string;
  name?: string;
  accountName?: string;
  authType?: "oauth" | "api_key" | string;
  app?: { name_slug?: string; nameSlug?: string; name?: string; imgSrc?: string };
  healthy: boolean;
  dead?: boolean;
  status?: "active" | "error" | "expired";
  accessLevel?: "personal" | "organization";
  ownerUserId?: string;
  ownerName?: string;
  isOwnedByViewer?: boolean;
  canUse?: boolean;
  canManageAccess?: boolean;
  canDelete?: boolean;
  created_at?: string;
  connectedAt?: string;
};

export type CanvasSketchConnectorType = "google_drive" | "fireflies" | "clickup" | "notion" | "linear";

export interface CanvasConnectorCredentialResponse {
  connectorType: CanvasSketchConnectorType;
  provider: string;
  credentialKind: "oauth_access_token" | "api_key";
  expiresAt?: string;
  envelope: CredentialEnvelope;
}

function hasCanvasAccessMetadata(account: CanvasAccountResponse): boolean {
  return (
    account.accessLevel !== undefined ||
    account.ownerUserId !== undefined ||
    account.ownerName !== undefined ||
    account.isOwnedByViewer !== undefined ||
    account.canUse !== undefined ||
    account.canManageAccess !== undefined ||
    account.canDelete !== undefined
  );
}

function getConnectionSource(account: CanvasAccountResponse): string {
  return account.source ?? (hasCanvasAccessMetadata(account) ? "canvas_user_secrets" : "pipedream");
}

function canUseConnection(account: CanvasAccountResponse): boolean {
  if (account.canUse === false) return false;
  if (
    getConnectionSource(account) === "canvas_user_secrets" &&
    account.accessLevel === "personal" &&
    account.isOwnedByViewer === false
  ) {
    return false;
  }
  return true;
}

export class CanvasProviderRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CanvasProviderRequestError";
  }
}

export class CanvasProvider implements IntegrationProvider {
  readonly type = "canvas";

  constructor(
    private apiUrl: string,
    private apiKey: string,
    private providerId: string,
  ) {}

  isBrokerCapable(): boolean {
    return true;
  }

  getBrokerSpec({
    userEmail,
    claudeConfigDir,
  }: {
    userEmail: string | null;
    claudeConfigDir: string;
  }): BrokerSpec {
    const credentialEnv: Record<string, string> = {};
    if (this.apiKey) credentialEnv.CANVAS_API_KEY_MCP = this.apiKey;
    if (userEmail) credentialEnv.CANVAS_USER_EMAIL = userEmail;
    return {
      cliPath: join(claudeConfigDir, "skills", "canvas", "canvas-cli.js"),
      credentialEnv,
      launcherEnvName: "CANVAS_CLI",
    };
  }

  private headers(
    userEmail?: string,
    includeContentType = true,
    userName?: string,
    userOrgRole?: IntegrationUserOrgRole,
  ): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (includeContentType) h["Content-Type"] = "application/json";
    if (userEmail) h["X-User-Email"] = userEmail;
    const trimmedName = userName?.trim();
    if (trimmedName) h["X-User-Name"] = trimmedName.replace(/[\r\n]/g, " ");
    if (userOrgRole) h["X-User-Org-Role"] = userOrgRole;
    return h;
  }

  private async parseError(res: Response, fallback: string): Promise<CanvasProviderRequestError> {
    const body = (await res.json().catch(() => null)) as {
      error?: string | { code?: string; message?: string };
      message?: string;
    } | null;
    const message = (typeof body?.error === "string" ? body.error : body?.error?.message) ?? body?.message ?? fallback;
    const code =
      (typeof body?.error === "object" ? body.error.code : undefined) ??
      (res.status === 401
        ? "UNAUTHORIZED"
        : res.status === 403
          ? "FORBIDDEN"
          : res.status === 404
            ? "NOT_FOUND"
            : res.status === 400
              ? "BAD_REQUEST"
              : "UPSTREAM_ERROR");
    return new CanvasProviderRequestError(res.status, code, message);
  }

  async listApps(
    query?: string,
    limit?: number,
    after?: string,
  ): Promise<{ apps: IntegrationApp[]; pageInfo: PageInfo }> {
    const url = new URL("/api/apps", this.apiUrl);
    if (query) url.searchParams.set("q", query);
    if (limit !== undefined || after !== undefined) {
      url.searchParams.set("paginate", "true");
      if (limit !== undefined) url.searchParams.set("limit", String(limit));
      if (after) url.searchParams.set("after", after);
    }

    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Canvas listApps failed: ${res.status} ${res.statusText}`);
    }

    /**
     * Canvas API wraps responses in: { success, data: { pageInfo, data: [...] }, message }.
     * The apps array is at data.data and pagination info at data.pageInfo.
     */
    const raw = (await res.json()) as {
      success: boolean;
      data: {
        data: Array<{
          id?: string;
          nameSlug: string;
          name: string;
          description?: string;
          imgSrc?: string;
          categories?: string[];
        }>;
        pageInfo?: { endCursor: string | null; hasMore: boolean };
      };
      message?: string;
    };

    const apps: IntegrationApp[] = (raw.data?.data ?? []).map((app) => ({
      id: app.nameSlug,
      name: app.name,
      description: app.description ?? "",
      icon: app.imgSrc,
      category: app.categories?.[0],
    }));

    const pageInfo: PageInfo = raw.data?.pageInfo ?? { endCursor: null, hasMore: false };

    return { apps, pageInfo };
  }

  async initiateConnection(
    userEmail: string,
    appId: string,
    callbackUrl: string,
    userName?: string,
    userOrgRole?: IntegrationUserOrgRole,
  ): Promise<{ redirectUrl: string }> {
    const res = await fetch(`${this.apiUrl}/api/apps/connect-token`, {
      method: "POST",
      headers: this.headers(userEmail, true, userName, userOrgRole),
      body: JSON.stringify({ app_slug: appId, callback_url: callbackUrl }),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas initiateConnection failed: ${res.status} ${res.statusText}`);
    }

    const raw = (await res.json()) as {
      success: boolean;
      data: { connect_link_url?: string; token?: string; expires_at?: string };
    };
    const connectLinkUrl = raw.data?.connect_link_url;
    if (!connectLinkUrl) {
      throw new Error("Canvas did not return a connect link URL");
    }
    return { redirectUrl: connectLinkUrl };
  }

  async listConnections(userEmail: string, userName?: string): Promise<IntegrationConnection[]> {
    const res = await fetch(`${this.apiUrl}/api/pipedream/accounts`, {
      headers: this.headers(userEmail, true, userName),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas listConnections failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { accounts: CanvasAccountResponse[] };

    return (data.accounts ?? []).filter(canUseConnection).map((account): IntegrationConnection => {
      const appId = account.app?.nameSlug ?? account.app?.name_slug ?? account.id;
      const appName = account.app?.name ?? account.name ?? "Unknown";
      const connectedAt = account.connectedAt ?? account.created_at ?? new Date().toISOString();
      return {
        id: account.id,
        providerId: this.providerId,
        source: getConnectionSource(account),
        appId,
        appName,
        app: account.app
          ? {
              name: appName,
              nameSlug: appId,
              imgSrc: account.app.imgSrc,
            }
          : undefined,
        icon: account.app?.imgSrc,
        accountName: account.accountName ?? account.name,
        authType: account.authType,
        healthy: account.healthy,
        status: account.status ?? (account.dead ? "error" : account.healthy ? "active" : "error"),
        accessLevel: account.accessLevel,
        ownerUserId: account.ownerUserId,
        ownerName: account.ownerName,
        isOwnedByViewer: account.isOwnedByViewer,
        canUse: account.canUse,
        canManageAccess: account.canManageAccess,
        canDelete: account.canDelete,
        createdAt: connectedAt,
        connectedAt,
      };
    });
  }

  async removeConnection(userEmail: string, connectionId: string, userName?: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/pipedream/accounts/${connectionId}`, {
      method: "DELETE",
      headers: this.headers(userEmail, false, userName),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas removeConnection failed: ${res.status} ${res.statusText}`);
    }
  }

  async updateConnectionAccess(
    userEmail: string,
    connectionId: string,
    accessLevel: "personal" | "organization",
    userName?: string,
  ): Promise<IntegrationConnection | null> {
    const res = await fetch(`${this.apiUrl}/api/canvas-accounts/${encodeURIComponent(connectionId)}/access`, {
      method: "PATCH",
      headers: this.headers(userEmail, true, userName),
      body: JSON.stringify({ accessLevel }),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas updateConnectionAccess failed: ${res.status} ${res.statusText}`);
    }

    return null;
  }

  async mintConnectorCredential(params: {
    userEmail: string;
    connectorType: CanvasSketchConnectorType;
    publicKeyId?: string;
    userName?: string;
    userOrgRole?: IntegrationUserOrgRole;
  }): Promise<CanvasConnectorCredentialResponse> {
    const res = await fetch(`${this.apiUrl}/api/sketch/credentials/mint`, {
      method: "POST",
      headers: this.headers(params.userEmail, true, params.userName, params.userOrgRole),
      body: JSON.stringify({
        connectorType: params.connectorType,
        ...(params.publicKeyId ? { publicKeyId: params.publicKeyId } : {}),
      }),
    });

    if (!res.ok) {
      throw await this.parseError(res, `Canvas credential mint failed: ${res.status} ${res.statusText}`);
    }

    const raw = (await res.json()) as {
      success: boolean;
      data: CanvasConnectorCredentialResponse;
    };
    return raw.data;
  }
}

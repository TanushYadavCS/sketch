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
import type { IntegrationApp, PageInfo } from "@sketch/shared";
import type { BrokerSpec, IntegrationProvider, IntegrationUserOrgRole } from "./types";

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
    userOrgRole?: IntegrationUserOrgRole,
  ): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (includeContentType) h["Content-Type"] = "application/json";
    if (userEmail) h["X-User-Email"] = userEmail;
    if (userOrgRole) h["X-User-Org-Role"] = userOrgRole;
    return h;
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
    userOrgRole?: IntegrationUserOrgRole,
  ): Promise<{ redirectUrl: string }> {
    const res = await fetch(`${this.apiUrl}/api/apps/connect-token`, {
      method: "POST",
      headers: this.headers(userEmail, true, userOrgRole),
      body: JSON.stringify({ app_slug: appId, callback_url: callbackUrl }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Canvas initiateConnection failed: ${res.status} ${body}`);
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

  async listConnections(userEmail: string): Promise<
    Array<{
      id: string;
      providerId: string;
      appId: string;
      appName: string;
      status: "active" | "error" | "expired";
      createdAt: string;
    }>
  > {
    const res = await fetch(`${this.apiUrl}/api/pipedream/accounts`, {
      headers: this.headers(userEmail),
    });

    if (!res.ok) {
      throw new Error(`Canvas listConnections failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      accounts: Array<{
        id: string;
        name?: string;
        app?: { name_slug?: string; nameSlug?: string; name?: string; imgSrc?: string };
        healthy: boolean;
        dead: boolean;
        created_at?: string;
      }>;
    };

    return (data.accounts ?? []).map((account) => ({
      id: account.id,
      providerId: this.providerId,
      appId: account.app?.nameSlug ?? account.app?.name_slug ?? account.id,
      appName: account.app?.name ?? account.name ?? "Unknown",
      icon: account.app?.imgSrc,
      accountName: account.name,
      status: account.dead ? "error" : account.healthy ? "active" : "error",
      createdAt: account.created_at ?? new Date().toISOString(),
    }));
  }

  async removeConnection(userEmail: string, connectionId: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/pipedream/accounts/${connectionId}`, {
      method: "DELETE",
      headers: this.headers(userEmail, false),
    });

    if (!res.ok) {
      throw new Error(`Canvas removeConnection failed: ${res.status} ${res.statusText}`);
    }
  }
}

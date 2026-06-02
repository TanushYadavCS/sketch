import type { Connector, ConnectorCredentials, OAuthCredentials } from "./types";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

function requireOAuthCredentials(credentials: ConnectorCredentials): OAuthCredentials {
  if (credentials.type !== "oauth") {
    throw new Error("Zoho CRM connector requires OAuth credentials");
  }
  return credentials;
}

function isTokenFresh(credentials: OAuthCredentials): boolean {
  if (!credentials.expires_at) return false;
  return new Date(credentials.expires_at).getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS;
}

function zohoAuthHeader(accessToken: string): string {
  return `Zoho-oauthtoken ${accessToken}`;
}

async function zohoApiRequest<T>(credentials: OAuthCredentials, path: string): Promise<T> {
  if (!credentials.api_domain) {
    throw new Error("Zoho CRM credentials are missing api_domain");
  }
  if (!credentials.access_token) {
    throw new Error("Zoho CRM credentials are missing access_token");
  }

  const response = await fetch(`${credentials.api_domain}/crm/v6${path}`, {
    headers: { Authorization: zohoAuthHeader(credentials.access_token) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401) {
    throw new Error("Zoho CRM token is invalid or revoked; reconnect required");
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoho CRM API failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

export async function validateZohoCrmCredentials(credentials: ConnectorCredentials): Promise<void> {
  const oauth = requireOAuthCredentials(credentials);
  await zohoApiRequest<unknown>(oauth, "/users?type=CurrentUser");
}

export async function refreshZohoCrmTokens(credentials: OAuthCredentials): Promise<OAuthCredentials | null> {
  if (isTokenFresh(credentials)) {
    return null;
  }
  if (!credentials.accounts_server) {
    throw new Error("Zoho CRM credentials are missing accounts_server");
  }
  if (!credentials.refresh_token) {
    throw new Error("Zoho CRM credentials are missing refresh_token");
  }

  const response = await fetch(`${credentials.accounts_server}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401 || response.status === 400) {
    const body = await response.text();
    throw new Error(`Zoho CRM refresh token is invalid or revoked; reconnect required: ${body}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zoho CRM token refresh failed (${response.status}): ${body}`);
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
    api_domain?: string;
  };

  return {
    ...credentials,
    access_token: tokenData.access_token,
    token_type: tokenData.token_type ?? credentials.token_type,
    api_domain: tokenData.api_domain ?? credentials.api_domain,
    expires_at: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export function createZohoCrmConnector(): Connector {
  return {
    type: "zoho_crm",
    perUserAuth: false,
    requiresOAuthClientSetup: false,
    promotableFileTypes: ["crm_account", "crm_deal"],

    async validateCredentials(credentials) {
      await validateZohoCrmCredentials(credentials);
    },

    sync() {
      return (async function* (): AsyncGenerator<never> {
        if (Date.now() >= 0) {
          throw new Error("Zoho CRM sync is not implemented yet");
        }
        yield undefined as never;
      })();
    },

    async getCursor() {
      return null;
    },

    async refreshTokens(credentials) {
      return refreshZohoCrmTokens(credentials);
    },
  };
}

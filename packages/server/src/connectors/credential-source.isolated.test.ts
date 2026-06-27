import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CredentialSource from "./credential-source";
import type { ConnectorType } from "./types";

const { mcpRepoMock, decryptCredentialEnvelopeMock } = vi.hoisted(() => ({
  mcpRepoMock: {
    findByType: vi.fn(),
  },
  decryptCredentialEnvelopeMock: vi.fn(),
}));

vi.mock("../db/repositories/mcp-servers", () => ({
  createMcpServerRepository: () => mcpRepoMock,
}));

vi.mock("./credential-envelope", () => ({
  decryptCredentialEnvelope: (...args: [unknown, string]) => decryptCredentialEnvelopeMock(...args),
}));

const privateKey = ["-----BEGIN PRIVATE KEY-----", "test", "-----END PRIVATE KEY-----"].join("\n");

let credentialSource: typeof CredentialSource;

function canvasResponse() {
  return {
    version: 1,
    algorithm: "RSA-OAEP-256+A256GCM",
    keyId: "key-1",
    encryptedKey: "encrypted-key",
    iv: "iv",
    tag: "tag",
    ciphertext: "ciphertext",
  };
}

describe("Canvas credential source", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    credentialSource = await import("./credential-source");
    mcpRepoMock.findByType.mockResolvedValue({
      id: "provider-1",
      api_url: "https://canvas.example.com",
      credentials: JSON.stringify({ apiKey: "sk-test" }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                connectorType: "gmail",
                provider: "google",
                credentialKind: "oauth_access_token",
                expiresAt: "2026-01-01T01:00:00.000Z",
                envelope: canvasResponse(),
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    decryptCredentialEnvelopeMock.mockReturnValue({
      type: "oauth_access_token",
      connectorType: "gmail",
      provider: "google",
      accessToken: "minted-token",
      tokenType: "Bearer",
      expiresAt: "2026-01-01T01:00:00.000Z",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["google_drive", "google_calendar", "gmail", "outlook", "teams"] as ConnectorType[])(
    "treats %s as Canvas OAuth",
    (connectorType) => {
      expect(credentialSource.isCanvasOAuthConnector(connectorType)).toBe(true);
    },
  );

  it("decrypts Canvas OAuth credentials and preserves token metadata", async () => {
    const credentials = await credentialSource.fetchCanvasCredential({
      db: {} as never,
      appConfig: {
        CANVAS_CREDENTIAL_PRIVATE_KEY_PEM: privateKey,
        CANVAS_CREDENTIAL_PUBLIC_KEY_ID: "key-1",
      },
      connectorType: "gmail",
      userEmail: "priya@example.com",
      userName: "Priya Shah",
      userOrgRole: "member",
    });

    expect(fetch).toHaveBeenCalledWith("https://canvas.example.com/api/sketch/credentials/mint", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
        "X-User-Name": "Priya Shah",
        "X-User-Org-Role": "member",
      },
      body: JSON.stringify({ connectorType: "gmail", publicKeyId: "key-1" }),
    });
    expect(credentials).toEqual({
      type: "oauth",
      access_token: "minted-token",
      refresh_token: "",
      token_type: "Bearer",
      expires_at: "2026-01-01T01:00:00.000Z",
      client_id: "canvas",
      client_secret: "canvas",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
  });

  it("rejects envelopes encrypted to an unexpected public key id", async () => {
    await expect(
      credentialSource.fetchCanvasCredential({
        db: {} as never,
        appConfig: {
          CANVAS_CREDENTIAL_PRIVATE_KEY_PEM: privateKey,
          CANVAS_CREDENTIAL_PUBLIC_KEY_ID: "other-key",
        },
        connectorType: "gmail",
        userEmail: "priya@example.com",
      }),
    ).rejects.toThrow("Canvas credential envelope key id does not match the requested public key");
  });

  it("rejects decrypted payloads for a different connector", async () => {
    decryptCredentialEnvelopeMock.mockReturnValueOnce({
      type: "oauth_access_token",
      connectorType: "google_drive",
      provider: "google",
      accessToken: "minted-token",
      tokenType: "Bearer",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });

    await expect(
      credentialSource.fetchCanvasCredential({
        db: {} as never,
        appConfig: {
          CANVAS_CREDENTIAL_PRIVATE_KEY_PEM: privateKey,
          CANVAS_CREDENTIAL_PUBLIC_KEY_ID: "key-1",
        },
        connectorType: "gmail",
        userEmail: "priya@example.com",
      }),
    ).rejects.toThrow("Canvas credential payload connector type does not match the request");
  });

  it("returns an access-token provider for Canvas OAuth configs", async () => {
    const resolved = await credentialSource.resolveConnectorCredentials({
      db: {} as never,
      config: {
        id: "connector-1",
        connector_type: "gmail",
        credential_source: "canvas",
        credentials: JSON.stringify({
          type: "oauth",
          access_token: "",
          refresh_token: "",
          client_id: "canvas",
          client_secret: "canvas",
        }),
      },
      appConfig: {
        CANVAS_CREDENTIAL_PRIVATE_KEY_PEM: privateKey,
        CANVAS_CREDENTIAL_PUBLIC_KEY_ID: "key-1",
      },
      ownerEmail: "priya@example.com",
      logger: { debug: vi.fn() } as never,
    });

    expect(resolved.credentialSource).toBe("canvas");
    expect(resolved.credentials).toMatchObject({
      type: "oauth",
      access_token: "minted-token",
      refresh_token: "",
      client_id: "canvas",
      client_secret: "canvas",
    });
    expect(resolved.accessTokenProvider).toBeDefined();
    await resolved.accessTokenProvider?.({ forceRefresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported Canvas connector types", async () => {
    await expect(
      credentialSource.fetchCanvasCredential({
        db: {} as never,
        appConfig: { CANVAS_CREDENTIAL_PRIVATE_KEY_PEM: privateKey },
        connectorType: "zoho_crm",
        userEmail: "priya@example.com",
      }),
    ).rejects.toThrow("Unsupported Canvas connector type: zoho_crm");
  });
});

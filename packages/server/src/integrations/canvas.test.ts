import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasProvider, type CanvasProviderRequestError } from "./canvas";

describe("CanvasProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves Canvas account access metadata when listing connections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accounts: [
            {
              id: "secrets:owner-1:github:github",
              source: "canvas_user_secrets",
              name: "GitHub",
              accountName: "Engineering GitHub",
              authType: "oauth",
              healthy: true,
              status: "active",
              app: { name: "GitHub", nameSlug: "github", imgSrc: "https://img.test/github.png" },
              accessLevel: "organization",
              ownerUserId: "owner-1",
              ownerName: "Tara",
              isOwnedByViewer: false,
              canUse: true,
              canManageAccess: false,
              canDelete: false,
              connectedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(fetchMock).toHaveBeenCalledWith("https://canvas.example.com/api/pipedream/accounts", {
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
      },
      signal: expect.any(AbortSignal),
    });
    expect(connections[0]).toMatchObject({
      id: "secrets:owner-1:github:github",
      providerId: "provider-1",
      source: "canvas_user_secrets",
      appId: "github",
      appName: "GitHub",
      accountName: "Engineering GitHub",
      authType: "oauth",
      accessLevel: "organization",
      ownerUserId: "owner-1",
      ownerName: "Tara",
      isOwnedByViewer: false,
      canUse: true,
      canManageAccess: false,
      canDelete: false,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("sends the current Sketch display name to Canvas when listing connections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accounts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await provider.listConnections("priya@example.com", "Priya Shah");

    expect(fetchMock).toHaveBeenCalledWith("https://canvas.example.com/api/pipedream/accounts", {
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
        "X-User-Name": "Priya Shah",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("preserves Canvas error codes when initiating app connections", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "App not found" } }), { status: 404 }),
        ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");

    await expect(provider.initiateConnection("priya@example.com", "google-gmail-oauth", "")).rejects.toMatchObject({
      name: "CanvasProviderRequestError",
      status: 404,
      code: "NOT_FOUND",
      message: "App not found",
    } satisfies Partial<CanvasProviderRequestError>);
  });

  it("classifies legacy Canvas access rows as Canvas-owned when source is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:linear:linear",
                name: "Linear",
                healthy: true,
                app: { name: "Linear", nameSlug: "linear" },
                accessLevel: "personal",
                isOwnedByViewer: true,
                canManageAccess: true,
                canDelete: true,
                connectedAt: "2026-01-03T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections[0]).toMatchObject({
      id: "secrets:owner-1:linear:linear",
      source: "canvas_user_secrets",
      accessLevel: "personal",
      canManageAccess: true,
      canDelete: true,
    });
  });

  it("keeps plain account rows as Pipedream when no Canvas access metadata is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "apn_123",
                name: "Slack",
                healthy: true,
                app: { name: "Slack", nameSlug: "slack" },
                created_at: "2026-01-04T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections[0]).toMatchObject({
      id: "apn_123",
      source: "pipedream",
      appId: "slack",
      appName: "Slack",
    });
  });

  it("omits Canvas accounts the viewer cannot use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:github:github",
                source: "canvas_user_secrets",
                name: "GitHub",
                app: { name: "GitHub", nameSlug: "github" },
                healthy: true,
                accessLevel: "organization",
                canUse: true,
              },
              {
                id: "secrets:owner-1:linear:linear",
                source: "canvas_user_secrets",
                name: "Linear",
                app: { name: "Linear", nameSlug: "linear" },
                healthy: true,
                accessLevel: "personal",
                canUse: false,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections.map((connection) => connection.appId)).toEqual(["github"]);
  });

  it("omits non-owner personal Canvas accounts even when canUse is incorrectly true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:github:github",
                source: "canvas_user_secrets",
                name: "GitHub",
                app: { name: "GitHub", nameSlug: "github" },
                healthy: true,
                accessLevel: "personal",
                isOwnedByViewer: false,
                canUse: true,
              },
              {
                id: "secrets:owner-1:slack:slack",
                source: "canvas_user_secrets",
                name: "Slack",
                app: { name: "Slack", nameSlug: "slack" },
                healthy: true,
                accessLevel: "organization",
                isOwnedByViewer: false,
                canUse: true,
              },
              {
                id: "secrets:viewer-1:linear:linear",
                source: "canvas_user_secrets",
                name: "Linear",
                app: { name: "Linear", nameSlug: "linear" },
                healthy: true,
                accessLevel: "personal",
                isOwnedByViewer: true,
                canUse: true,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections.map((connection) => connection.appId)).toEqual(["slack", "linear"]);
  });

  it("does not infer Canvas ownership solely from canonical secret account IDs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "secrets:owner-1:fireflies:fireflies",
                name: "Fireflies",
                healthy: true,
                app: { name: "Fireflies", nameSlug: "fireflies" },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const connections = await provider.listConnections("priya@example.com");

    expect(connections[0]).toMatchObject({
      id: "secrets:owner-1:fireflies:fireflies",
      source: "pipedream",
      appId: "fireflies",
      appName: "Fireflies",
    });
    expect(connections[0].canManageAccess).toBeUndefined();
    expect(connections[0].canDelete).toBeUndefined();
  });

  it("forwards access updates with the real viewer email", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await provider.updateConnectionAccess("priya@example.com", "secrets:owner-1:github:github", "organization");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://canvas.example.com/api/canvas-accounts/secrets%3Aowner-1%3Agithub%3Agithub/access",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
          "X-User-Email": "priya@example.com",
        },
        body: JSON.stringify({ accessLevel: "organization" }),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("throws Canvas error details from access updates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: "Bad Request",
            message: "Only Canvas-owned accounts can be shared",
          }),
          { status: 400 },
        ),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");

    await expect(
      provider.updateConnectionAccess("priya@example.com", "pd-account", "organization"),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "Only Canvas-owned accounts can be shared",
    });
  });

  it("mints Sketch connector credentials with user and role headers", async () => {
    const envelope = {
      version: 1,
      algorithm: "RSA-OAEP-256+A256GCM",
      keyId: "key-1",
      encryptedKey: "encrypted-key",
      iv: "iv",
      tag: "tag",
      ciphertext: "ciphertext",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            connectorType: "teams",
            provider: "microsoft",
            credentialKind: "oauth_access_token",
            expiresAt: "2026-01-01T01:00:00.000Z",
            envelope,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    const result = await provider.mintConnectorCredential({
      userEmail: "priya@example.com",
      connectorType: "teams",
      publicKeyId: "key-1",
      accountId: "secrets:user-1:microsoft:microsoft-teams-oauth",
      userName: "Priya Shah",
      userOrgRole: "admin",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://canvas.example.com/api/sketch/credentials/mint", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "X-User-Email": "priya@example.com",
        "X-User-Name": "Priya Shah",
        "X-User-Org-Role": "admin",
      },
      body: JSON.stringify({
        connectorType: "teams",
        publicKeyId: "key-1",
        accountId: "secrets:user-1:microsoft:microsoft-teams-oauth",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(result).toMatchObject({
      connectorType: "teams",
      provider: "microsoft",
      credentialKind: "oauth_access_token",
      envelope,
    });
  });

  it("rejects malformed Sketch connector credential mint responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { connectorType: "teams" } }), {
          status: 200,
        }),
      ),
    );

    const provider = new CanvasProvider("https://canvas.example.com", "sk-test", "provider-1");
    await expect(
      provider.mintConnectorCredential({
        userEmail: "priya@example.com",
        connectorType: "teams",
      }),
    ).rejects.toThrow("Canvas credential mint returned an invalid response");
  });
});

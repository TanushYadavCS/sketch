import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasProvider } from "./canvas";

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
      },
    );
  });

  it("throws Canvas error details from access updates", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ success: false, error: "Only Canvas-owned accounts can be shared", message: "Failed" }),
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
});

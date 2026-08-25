import { afterEach, describe, expect, it, vi } from "vitest";
import { createMicrosoftGraphClient, refreshMicrosoftTokens } from "./microsoft-graph";
import type { AccessTokenProvider, OAuthCredentials } from "./types";

describe("microsoftGraphRequest with accessTokenProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries 401s with a forced provider refresh instead of local token refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "me" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const accessTokenProvider: AccessTokenProvider = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "token-1", expiresAt: "2026-01-01T01:00:00.000Z" })
      .mockResolvedValueOnce({ accessToken: "token-2", expiresAt: "2026-01-01T01:00:00.000Z" });
    const credentials: OAuthCredentials = {
      type: "oauth",
      access_token: "",
      refresh_token: "",
      client_id: "canvas",
      client_secret: "canvas",
      expires_at: "1970-01-01T00:00:00.000Z",
    };

    const graph = createMicrosoftGraphClient(credentials, { accessTokenProvider });
    await expect(graph.request("/me")).resolves.toEqual({ id: "me" });

    expect(accessTokenProvider).toHaveBeenNthCalledWith(1);
    expect(accessTokenProvider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://graph.microsoft.com/v1.0/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://graph.microsoft.com/v1.0/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-2" }),
      }),
    );
  });
});

describe("refreshMicrosoftTokens scope escalation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the granted scope when the widened scope is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS65001" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600, scope: "Calendars.Read" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await refreshMicrosoftTokens(
      {
        type: "oauth",
        access_token: "stale",
        refresh_token: "refresh",
        client_id: "client",
        client_secret: "secret",
        expires_at: "1970-01-01T00:00:00.000Z",
        scope: "Calendars.Read",
      },
      { scope: "Calendars.Read Chat.Read" },
    );

    expect(refreshed.access_token).toBe("fresh");
    expect(refreshed.scope).toBe("Calendars.Read");
    expect(scopeOf(fetchMock, 0)).toBe("Calendars.Read Chat.Read");
    expect(scopeOf(fetchMock, 1)).toBe("Calendars.Read");
  });

  it("surfaces the failure when the granted scope is the one rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshMicrosoftTokens({
        type: "oauth",
        access_token: "stale",
        refresh_token: "refresh",
        client_id: "client",
        client_secret: "secret",
        expires_at: "1970-01-01T00:00:00.000Z",
        scope: "Calendars.Read",
      }),
    ).rejects.toThrow(/Microsoft token refresh failed \(400\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function scopeOf(fetchMock: ReturnType<typeof vi.fn>, call: number): string | null {
  const init = fetchMock.mock.calls[call][1] as { body: URLSearchParams };
  return init.body.get("scope");
}

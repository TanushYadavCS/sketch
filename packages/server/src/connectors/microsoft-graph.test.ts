import { afterEach, describe, expect, it, vi } from "vitest";
import { createMicrosoftGraphClient } from "./microsoft-graph";
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

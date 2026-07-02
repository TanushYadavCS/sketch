import { afterEach, describe, expect, it, vi } from "vitest";
import { createGmailConnector } from "./gmail";
import { createGoogleCalendarConnector } from "./google-calendar";
import { createGoogleDriveConnector } from "./google-drive";
import type { AccessTokenProvider, OAuthCredentials } from "./types";

const placeholderCredentials: OAuthCredentials = {
  type: "oauth",
  access_token: "",
  refresh_token: "",
  client_id: "canvas",
  client_secret: "canvas",
  expires_at: "1970-01-01T00:00:00.000Z",
};

function accessTokenProvider(): AccessTokenProvider {
  return vi
    .fn()
    .mockResolvedValueOnce({ accessToken: "token-1", expiresAt: "2099-01-01T00:00:00.000Z" })
    .mockResolvedValueOnce({ accessToken: "token-2", expiresAt: "2099-01-01T00:00:00.000Z" });
}

describe("Canvas OAuth access token provider refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forces a new Gmail token after a 401 and retries with it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ historyId: "history-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = accessTokenProvider();

    await expect(
      createGmailConnector().getCursor({
        credentials: placeholderCredentials,
        scopeConfig: {},
        currentCursor: null,
        logger: {} as never,
        accessTokenProvider: provider,
      }),
    ).resolves.toBeTruthy();

    expect(provider).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(provider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      expect.objectContaining({ headers: { Authorization: "Bearer token-1" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      expect.objectContaining({ headers: { Authorization: "Bearer token-2" } }),
    );
  });

  it("forces a new Google Calendar token after a 401 and retries with it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = accessTokenProvider();
    const connector = createGoogleCalendarConnector();
    if (!connector.browseExisting) throw new Error("Google Calendar browseExisting is required");

    await expect(
      connector.browseExisting({
        credentials: placeholderCredentials,
        logger: {} as never,
        accessTokenProvider: provider,
      }),
    ).resolves.toEqual({ type: "flat", items: [] });

    expect(provider).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(provider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=reader&showDeleted=false&showHidden=false&fields=nextPageToken%2Citems%28id%2Csummary%2Cprimary%2CaccessRole%2Chidden%2Cdeleted%2CtimeZone%29",
      expect.objectContaining({ headers: { Authorization: "Bearer token-1" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=reader&showDeleted=false&showHidden=false&fields=nextPageToken%2Citems%28id%2Csummary%2Cprimary%2CaccessRole%2Chidden%2Cdeleted%2CtimeZone%29",
      expect.objectContaining({ headers: { Authorization: "Bearer token-2" } }),
    );
  });

  it("forces a new Google Drive token after a 401 and retries with it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startPageToken: "cursor-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = accessTokenProvider();

    await expect(
      createGoogleDriveConnector().getCursor({
        credentials: placeholderCredentials,
        scopeConfig: {},
        currentCursor: null,
        logger: { debug: vi.fn() } as never,
        accessTokenProvider: provider,
      }),
    ).resolves.toBe("cursor-1");

    expect(provider).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(provider).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true",
      expect.objectContaining({ headers: { Authorization: "Bearer token-1" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.googleapis.com/drive/v3/changes/startPageToken?supportsAllDrives=true",
      expect.objectContaining({ headers: { Authorization: "Bearer token-2" } }),
    );
  });
});

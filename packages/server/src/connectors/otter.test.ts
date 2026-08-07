import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OtterApiError,
  createOtterClient,
  createOtterConnector,
  extractOtterTranscriptSegments,
  otterSpeechToSyncedItem,
} from "./otter";
import { toEmailPrincipals } from "./types";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    status: 200,
    headers,
    ...init,
  });
}

describe("Otter client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs in with basic auth and reuses the returned cookies for speech listing", async () => {
    const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      const headers = init?.headers as Record<string, string>;
      calls.push({ url, headers });

      if (url.pathname.endsWith("/login")) {
        const headers = new Headers();
        headers.append("Set-Cookie", "csrftoken=csrf-123; Path=/");
        headers.append("Set-Cookie", "sessionid=session-456; Path=/");
        return jsonResponse({ userid: 42038968 }, { headers });
      }

      if (url.pathname.endsWith("/speeches")) {
        return jsonResponse({
          speeches: [{ otid: "speech-1", title: "Transcript one" }],
        });
      }

      return jsonResponse({});
    });

    const client = createOtterClient({
      credentials: { email: "person@example.com", password: "secret" },
      maxRetries: 0,
      timeoutMs: 0,
    });

    await client.login();
    const speeches = await client.listSpeeches({ pageSize: 10, source: "all" });

    expect(speeches).toEqual([{ otid: "speech-1", title: "Transcript one" }]);
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("person@example.com:secret").toString("base64")}`);
    expect(calls[0].url.searchParams.get("username")).toBe("person@example.com");
    expect(calls[1].url.searchParams.get("userid")).toBe("42038968");
    expect(calls[1].url.searchParams.get("page_size")).toBe("10");
    expect(calls[1].url.searchParams.get("source")).toBe("all");
    expect(calls[1].headers.Cookie).toContain("csrftoken=csrf-123");
    expect(calls[1].headers.Cookie).toContain("sessionid=session-456");
  });

  it("falls back to the user profile when login omits userid", async () => {
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      paths.push(url.pathname);

      if (url.pathname.endsWith("/login")) {
        const headers = new Headers();
        headers.append("Set-Cookie", "sessionid=session-456; Path=/");
        return jsonResponse({ status: "ok" }, { headers });
      }

      if (url.pathname.endsWith("/user")) {
        return jsonResponse({ user_id: "profile-user-123", email: "person@example.com" });
      }

      if (url.pathname.endsWith("/speeches")) {
        expect(url.searchParams.get("userid")).toBe("profile-user-123");
        return jsonResponse({ speeches: [] });
      }

      return jsonResponse({});
    });

    const client = createOtterClient({
      credentials: { email: "person@example.com", password: "secret" },
      maxRetries: 0,
      timeoutMs: 0,
    });

    await client.login();
    await client.listSpeeches();

    expect(paths.some((path) => path.endsWith("/user"))).toBe(true);
    expect(client.getUserId()).toBe("profile-user-123");
  });

  it("extracts transcripts when Otter returns them at the top level", () => {
    const segments = extractOtterTranscriptSegments({
      speech: { otid: "speech-1", title: "Transcript one" },
      transcripts: [{ speaker_name: "Alex", transcript: "Hello" }],
    });

    expect(segments).toEqual([{ speaker_name: "Alex", transcript: "Hello" }]);
  });

  it("returns a safe invalid-login message without exposing the provider body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        { status: "failed", message: "User not logged in", code: 1, email: "person@example.com" },
        { status: 401 },
      ),
    );

    const client = createOtterClient({
      credentials: { email: "person@example.com", password: "wrong" },
      maxRetries: 0,
      timeoutMs: 0,
    });

    try {
      await client.login();
      throw new Error("Expected login to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(OtterApiError);
      expect((err as Error).message).toContain("Otter rejected this email/password");
      expect((err as Error).message).not.toContain("person@example.com");
      expect((err as OtterApiError).bodySummary).toBe('{"status":"failed","code":1,"message":"User not logged in"}');
    }
  });
});

describe("Otter speech mapping", () => {
  it("maps a fetched speech into a Sketch meeting transcript item", () => {
    const item = otterSpeechToSyncedItem(
      {
        speech: {
          otid: "otid-123",
          title: "Customer sync",
          summary: "Discussed launch blockers.",
          created_at: 1_783_000_000,
          start_time: 1_783_000_100,
          transcript_updated_at: 1_783_000_900,
          duration: 125,
          speakers: [
            { id: 1, speaker_name: "Tanush" },
            { id: 2, speaker_name: "Himanshu" },
          ],
          transcripts: [
            { speaker_id: 1, transcript: "We need the transcript connector." },
            { speaker_id: 2, transcript: "The Otter endpoint returns segments." },
          ],
        },
      },
      {
        ownerEmail: "Owner@Example.com",
        resolveNameToEmail: (name) => (name === "Tanush" ? { email: "tanush@example.com", source: "users" } : null),
      },
    );

    expect(item.providerFileId).toBe("otid-123");
    expect(item.providerUrl).toBe("https://otter.ai/u/otid-123");
    expect(item.fileName).toBe("Customer sync");
    expect(item.fileType).toBe("meeting_transcript");
    expect(item.contentCategory).toBe("document");
    expect(item.sourceCreatedAt).toBe("2026-07-02T13:46:40.000Z");
    expect(item.sourceUpdatedAt).toBe("2026-07-02T14:01:40.000Z");
    expect(item.accessPrincipals).toEqual(toEmailPrincipals(["owner@example.com", "tanush@example.com"]));
    expect(item.attendees).toEqual([{ name: "Tanush", email: "tanush@example.com" }, { name: "Himanshu" }]);
    expect(item.content).toContain("## Summary\nDiscussed launch blockers.");
    expect(item.content).toContain("## Transcript");
    expect(item.content).toContain("Tanush: We need the transcript connector.");
    expect(item.contentHash).toEqual(expect.any(String));
  });
});

describe("Otter connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates email/password credentials and syncs fetched speeches", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));

      if (url.pathname.endsWith("/login")) {
        const headers = new Headers();
        headers.append("Set-Cookie", "csrftoken=csrf-123; Path=/");
        return jsonResponse({ userid: "user-123" }, { headers });
      }

      if (url.pathname.endsWith("/user")) {
        return jsonResponse({ email: "person@example.com" });
      }

      if (url.pathname.endsWith("/speeches")) {
        return jsonResponse({
          speeches: [{ otid: "otid-123", title: "Customer sync" }],
        });
      }

      if (url.pathname.endsWith("/speech")) {
        return jsonResponse({
          speech: {
            otid: "otid-123",
            title: "Customer sync",
            created_at: 1_783_000_000,
            speakers: [{ id: 1, speaker_name: "Tanush" }],
            transcripts: [{ speaker_id: 1, transcript: "Ship the Otter connector." }],
          },
        });
      }

      return jsonResponse({});
    });

    const connector = createOtterConnector({ pageSize: 10 });
    const credentials = { type: "api_key" as const, api_key: "", email: "person@example.com", password: "secret" };

    await connector.validateCredentials(credentials);
    const items = [];
    for await (const item of connector.sync({
      credentials,
      cursor: null,
      scopeConfig: {},
      ownerEmail: "owner@example.com",
      logger: pino({ level: "silent" }),
    })) {
      items.push(item);
    }

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      providerFileId: "otid-123",
      fileName: "Customer sync",
      accessPrincipals: toEmailPrincipals(["owner@example.com"]),
    });
    expect(items[0]?.content).toContain("Tanush: Ship the Otter connector.");
  });
});

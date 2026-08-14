import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeLinearApiKey, verifyLinearApiKey } from "./linear";

describe("Linear API key verification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies the key with Linear's raw Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              id: "usr_123",
              name: "Ada Lovelace",
              email: "ada@example.com",
              avatarUrl: "https://linear.app/avatar.png",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const identity = await verifyLinearApiKey("  lin_api_key  ", { fetch: fetchMock });

    expect(identity).toEqual({
      externalId: "usr_123",
      login: "Ada Lovelace",
      name: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: "https://linear.app/avatar.png",
      accountType: "User",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: "lin_api_key",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: "query Viewer { viewer { id name email avatarUrl } }" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("maps invalid keys, rate limits, and malformed responses", async () => {
    const invalid = vi.fn().mockResolvedValue(new Response("secret provider body", { status: 401 }));
    await expect(verifyLinearApiKey("lin_sensitive", { fetch: invalid })).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      status: 401,
      message: "Linear rejected this API key.",
    });
    await expect(verifyLinearApiKey("lin_sensitive", { fetch: invalid })).rejects.not.toThrow("lin_sensitive");

    const rateLimited = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    await expect(verifyLinearApiKey("lin_key", { fetch: rateLimited })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });

    const malformed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(verifyLinearApiKey("lin_key", { fetch: malformed })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 502,
    });
  });

  it("normalizes and rejects empty or oversized input", async () => {
    expect(normalizeLinearApiKey("  lin_key ")).toBe("lin_key");
    await expect(verifyLinearApiKey("   ", { fetch: vi.fn() })).rejects.toMatchObject({ status: 400 });
    await expect(verifyLinearApiKey("x".repeat(4097), { fetch: vi.fn() })).rejects.toMatchObject({ status: 400 });
  });
});

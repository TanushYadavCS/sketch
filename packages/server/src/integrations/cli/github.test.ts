import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeGithubToken, verifyGithubToken } from "./github";

describe("GitHub token verification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies the token with GitHub's expected request headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 123, login: "octocat", avatar_url: "https://github.com/octocat.png", type: "User" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const identity = await verifyGithubToken("  ghp_test  ", { fetch: fetchMock });

    expect(identity).toEqual({
      externalId: "123",
      login: "octocat",
      avatarUrl: "https://github.com/octocat.png",
      accountType: "User",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/user", {
      method: "GET",
      headers: {
        Authorization: "Bearer ghp_test",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Sketch-GitHub-Integration",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("maps invalid tokens without exposing the token or provider response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("secret provider body", { status: 401 }));

    await expect(verifyGithubToken("ghp_sensitive", { fetch: fetchMock })).rejects.toMatchObject({
      code: "INVALID_TOKEN",
      status: 401,
      message: "GitHub rejected this token.",
    });
    await expect(verifyGithubToken("ghp_sensitive", { fetch: fetchMock })).rejects.not.toThrow("ghp_sensitive");
  });

  it("distinguishes rate limits and malformed upstream responses", async () => {
    const rateLimited = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    await expect(verifyGithubToken("token", { fetch: rateLimited })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });

    const malformed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ login: "missing-id" }), { status: 200 }));
    await expect(verifyGithubToken("token", { fetch: malformed })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 502,
    });
  });

  it("normalizes and rejects empty or oversized input", async () => {
    expect(normalizeGithubToken("  token ")).toBe("token");
    await expect(verifyGithubToken("   ", { fetch: vi.fn() })).rejects.toMatchObject({ status: 400 });
    await expect(verifyGithubToken("x".repeat(4097), { fetch: vi.fn() })).rejects.toMatchObject({ status: 400 });
  });
});

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { resolveOrigin } from "./oauth";

/**
 * Exercises the origin used to build OAuth redirect URIs. The production bug:
 * behind a TLS-terminating proxy the request reaches Node as plain HTTP, so the
 * redirect URI was built with `http://`, failing the provider's exact-match
 * check (AADSTS50011). Multi-tenant hosts rule out a single configured BASE_URL,
 * so the scheme must come from `X-Forwarded-Proto`.
 */
async function originFor(headers: Record<string, string>, baseUrl?: string): Promise<string> {
  const app = new Hono();
  app.get("/probe", (c) => c.text(resolveOrigin(c, baseUrl)));
  const res = await app.request("http://capmobfinance.getsketch.ai/probe", { headers });
  return res.text();
}

describe("resolveOrigin", () => {
  it("upgrades to https from X-Forwarded-Proto behind a TLS-terminating proxy", async () => {
    expect(await originFor({ "x-forwarded-proto": "https", host: "capmobfinance.getsketch.ai" })).toBe(
      "https://capmobfinance.getsketch.ai",
    );
  });

  it("prefers an explicit BASE_URL override over the request and forwarded headers", async () => {
    expect(await originFor({ "x-forwarded-proto": "http", host: "evil.example" }, "https://override.example")).toBe(
      "https://override.example",
    );
  });

  it("falls back to the request origin when no forwarded headers are present", async () => {
    expect(await originFor({ host: "capmobfinance.getsketch.ai" })).toBe("http://capmobfinance.getsketch.ai");
  });
});

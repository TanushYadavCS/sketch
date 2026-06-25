import { describe, expect, it } from "vitest";
import {
  appendIntegrationConnectionLinks,
  formatIntegrationConnectionLinks,
  integrationConnectionCallbackUrl,
  integrationConnectionUrl,
  sanitizeIntegrationConnectionText,
} from "./connection-links";

const githubCard = {
  requestId: "req-1",
  appId: "github",
  appName: "GitHub",
  state: "connect" as const,
};

describe("integration connection links", () => {
  it("builds app-specific connection URLs", () => {
    expect(integrationConnectionUrl(githubCard, { BASE_URL: "https://sketch.example.com/", PORT: 3000 })).toBe(
      "https://sketch.example.com/integrations?connect=github",
    );
    expect(integrationConnectionCallbackUrl({ BASE_URL: "https://sketch.example.com/", PORT: 3000 })).toBe(
      "https://sketch.example.com/integrations/callback",
    );
  });

  it("formats Slack links with user-friendly setup copy and escaped labels", () => {
    const text = formatIntegrationConnectionLinks([{ ...githubCard, appName: "GitHub | CI" }], "slack", {
      BASE_URL: "https://sketch.example.com",
      PORT: 3000,
    });

    expect(text).toBe("To continue: <https://sketch.example.com/integrations?connect=github|Connect GitHub  CI>");
  });

  it("ignores provider direct connection URLs", () => {
    const text = formatIntegrationConnectionLinks(
      [{ ...githubCard, connectUrl: "https://canvas.example.com/connect/secrets?token=abc" }],
      "slack",
      { BASE_URL: "https://sketch.example.com", PORT: 3000 },
    );

    expect(text).toBe("To continue: <https://sketch.example.com/integrations?connect=github|Connect GitHub>");
  });

  it("formats WhatsApp links as inline URLs", () => {
    expect(
      formatIntegrationConnectionLinks([githubCard], "whatsapp", {
        BASE_URL: "https://sketch.example.com",
        PORT: 3000,
      }),
    ).toBe("To continue, connect GitHub: https://sketch.example.com/integrations?connect=github");
  });

  it("uses plain setup copy when BASE_URL is not configured", () => {
    expect(formatIntegrationConnectionLinks([githubCard], "slack", { PORT: 3000 })).toBe(
      "To continue, open Integrations in Sketch to connect GitHub.",
    );
  });

  it("appends link text and ignores connected cards", () => {
    expect(
      appendIntegrationConnectionLinks(
        "GitHub is not connected.",
        [githubCard, { requestId: "req-2", appId: "slack", appName: "Slack", state: "connected" }],
        "whatsapp",
        { BASE_URL: "https://sketch.example.com", PORT: 3000 },
      ),
    ).toBe(
      "GitHub is not connected.\n\nTo continue, connect GitHub: https://sketch.example.com/integrations?connect=github",
    );
  });

  it("removes manual setup instructions when app-specific connection UI is available", () => {
    const gmailCard = {
      requestId: "req-gmail",
      appId: "google-gmail-oauth",
      appName: "Gmail",
      state: "connect" as const,
    };
    const aimfoxCard = { requestId: "req-2", appId: "aimfox", appName: "Aimfox", state: "connect" as const };
    const text =
      "Neither **Gmail** nor **Aimfox** are currently connected, so I can't pull data from either yet.\n\n" +
      "You'll need to connect both in **Settings → Integrations**:\n\n" +
      '- **Gmail** — connect via "Gmail (OAuth)"\n' +
      "- **Aimfox** — connect via your Aimfox API key\n\n" +
      "Once those are connected, just ask again and I'll pull the data.";

    expect(sanitizeIntegrationConnectionText(text, [gmailCard, aimfoxCard])).toBe(
      "Neither **Gmail** nor **Aimfox** are currently connected, so I can't pull data from either yet.",
    );
    expect(
      appendIntegrationConnectionLinks(text, [gmailCard, aimfoxCard], "whatsapp", {
        BASE_URL: "https://sketch.example.com",
        PORT: 3000,
      }),
    ).not.toContain("Settings");
    expect(
      appendIntegrationConnectionLinks(text, [gmailCard, aimfoxCard], "whatsapp", {
        BASE_URL: "https://sketch.example.com",
        PORT: 3000,
      }),
    ).not.toContain("API key");
  });

  it("drops unsafe app ids", () => {
    expect(
      formatIntegrationConnectionLinks([{ ...githubCard, appId: "../github" }], "slack", {
        BASE_URL: "https://sketch.example.com",
        PORT: 3000,
      }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  appendIntegrationConnectionLinks,
  formatIntegrationConnectionLinks,
  integrationConnectionCallbackUrl,
  integrationConnectionUrl,
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

  it("drops unsafe app ids", () => {
    expect(
      formatIntegrationConnectionLinks([{ ...githubCard, appId: "../github" }], "slack", {
        BASE_URL: "https://sketch.example.com",
        PORT: 3000,
      }),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  appendIntegrationConnectionLinks,
  formatIntegrationConnectionLinks,
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
  });

  it("formats Slack links and escapes labels", () => {
    const text = formatIntegrationConnectionLinks([{ ...githubCard, appName: "GitHub | CI" }], "slack", {
      BASE_URL: "https://sketch.example.com",
      PORT: 3000,
    });

    expect(text).toBe("Connection form: <https://sketch.example.com/integrations?connect=github|Connect GitHub  CI>");
  });

  it("formats WhatsApp links as inline URLs", () => {
    expect(
      formatIntegrationConnectionLinks([githubCard], "whatsapp", {
        BASE_URL: "https://sketch.example.com",
        PORT: 3000,
      }),
    ).toBe("Connection form for GitHub: https://sketch.example.com/integrations?connect=github");
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
      "GitHub is not connected.\n\nConnection form for GitHub: https://sketch.example.com/integrations?connect=github",
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

import type { IntegrationConnection } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { getPersonallyConnectedAppIds, integrationAppConnectFromSearch } from "./connections";

describe("ConnectionsPage helpers", () => {
  it("validates direct app connect search params", () => {
    expect(integrationAppConnectFromSearch("github")).toBe("github");
    expect(integrationAppConnectFromSearch(" app-store-connect ")).toBe("app-store-connect");
    expect(integrationAppConnectFromSearch("../github")).toBeNull();
  });

  it("does not treat org-shared apps as personal connections", () => {
    const connections = [
      {
        id: "secrets:owner-1:github:github",
        providerId: "provider-1",
        source: "canvas_user_secrets",
        appId: "github",
        appName: "GitHub",
        status: "active",
        accessLevel: "organization",
        isOwnedByViewer: false,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "secrets:viewer-1:slack:slack",
        providerId: "provider-1",
        source: "canvas_user_secrets",
        appId: "slack",
        appName: "Slack",
        status: "active",
        accessLevel: "personal",
        isOwnedByViewer: true,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "pd-1",
        providerId: "provider-1",
        source: "pipedream",
        appId: "notion",
        appName: "Notion",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ] satisfies IntegrationConnection[];

    expect(getPersonallyConnectedAppIds(connections)).toEqual(new Set(["slack", "notion"]));
  });
});

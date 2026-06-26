// @vitest-environment jsdom
import type { ConnectorConfig } from "@/lib/api";
import { getIntegration } from "@/lib/integrations";
import { describe, expect, it } from "vitest";
import { getLiveManagingConnector, syncingConnectorIdsWithoutProgress } from "./index";

function connector(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: "conn-1",
    connectorType: "google_calendar",
    authType: "oauth",
    scopeConfig: {},
    syncStatus: "syncing",
    lastSyncedAt: null,
    errorMessage: null,
    createdBy: "member-1",
    createdAt: "2026-01-01T00:00:00Z",
    fileCount: 1,
    isOwner: true,
    canManage: true,
    canDisconnect: true,
    canSync: true,
    canChangeScope: true,
    canUpdateCredentials: true,
    canBrowseScope: true,
    canEnrich: true,
    ...overrides,
  };
}

describe("FilesPage sync state helpers", () => {
  it("uses the latest connector row for an open manage dialog", () => {
    const stale = connector({ syncStatus: "syncing", fileCount: 1, lastSyncedAt: null });
    const live = connector({ syncStatus: "active", fileCount: 3, lastSyncedAt: "2026-06-15T12:00:00Z" });
    const definition = getIntegration("google_calendar");

    expect(getLiveManagingConnector(definition ? { definition, connector: stale } : null, [live])).toMatchObject({
      syncStatus: "active",
      fileCount: 3,
      lastSyncedAt: "2026-06-15T12:00:00Z",
    });
  });

  it("detects connector rows that are still marked syncing after progress has ended", () => {
    expect(
      syncingConnectorIdsWithoutProgress(
        [
          connector({ id: "done-sync", syncStatus: "syncing" }),
          connector({ id: "active-sync", syncStatus: "syncing" }),
          connector({ id: "already-active", syncStatus: "active" }),
        ],
        new Set(["active-sync"]),
      ),
    ).toEqual(["done-sync"]);
  });
});

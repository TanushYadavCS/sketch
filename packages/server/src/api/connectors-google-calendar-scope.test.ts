import { describe, expect, it } from "vitest";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createTestDb, createTestLogger } from "../test-utils";
import { pruneCalendarFilesOutsideScope, pruneGoogleCalendarFilesOutsideScope } from "./connectors";

const logger = createTestLogger();

describe("Google Calendar scope pruning", () => {
  it("removes previously synced events from deselected calendars", async () => {
    const db = await createTestDb();
    try {
      const repo = createConnectorRepository(db);
      const config = await repo.createConfig({
        connectorType: "google_calendar",
        authType: "oauth",
        credentials: "{}",
        createdBy: "owner-1",
        scopeConfig: JSON.stringify({ calendarIds: ["primary"] }),
      });
      await seedCalendarFile(repo, config.id, "primary:old-event");
      await seedCalendarFile(repo, config.id, "team:new-event");

      const result = await pruneGoogleCalendarFilesOutsideScope({
        db,
        connectorConfigId: config.id,
        scopeConfig: { calendarIds: ["team"] },
        logger,
      });

      expect(result.itemsDeleted).toBe(1);
      await expectActiveProviderFileIds(db, config.id, ["team:new-event"]);
    } finally {
      await db.destroy();
    }
  });

  it("removes all previously synced events when the saved calendar selection is empty", async () => {
    const db = await createTestDb();
    try {
      const repo = createConnectorRepository(db);
      const config = await repo.createConfig({
        connectorType: "google_calendar",
        authType: "oauth",
        credentials: "{}",
        createdBy: "owner-1",
        scopeConfig: JSON.stringify({ calendarIds: ["primary"] }),
      });
      await seedCalendarFile(repo, config.id, "primary:old-event");
      await seedCalendarFile(repo, config.id, "team:new-event");

      const result = await pruneGoogleCalendarFilesOutsideScope({
        db,
        connectorConfigId: config.id,
        scopeConfig: { calendarIds: [] },
        logger,
      });

      expect(result.itemsDeleted).toBe(2);
      await expectActiveProviderFileIds(db, config.id, []);
    } finally {
      await db.destroy();
    }
  });

  it("keeps legacy all-calendar scope rows untouched when calendarIds is absent", async () => {
    const db = await createTestDb();
    try {
      const repo = createConnectorRepository(db);
      const config = await repo.createConfig({
        connectorType: "google_calendar",
        authType: "oauth",
        credentials: "{}",
        createdBy: "owner-1",
        scopeConfig: JSON.stringify({}),
      });
      await seedCalendarFile(repo, config.id, "primary:old-event");
      await seedCalendarFile(repo, config.id, "team:new-event");

      const result = await pruneGoogleCalendarFilesOutsideScope({
        db,
        connectorConfigId: config.id,
        scopeConfig: {},
        logger,
      });

      expect(result.itemsDeleted).toBe(0);
      await expectActiveProviderFileIds(db, config.id, ["primary:old-event", "team:new-event"]);
    } finally {
      await db.destroy();
    }
  });

  it("prunes Outlook Calendar events using the same calendar scope contract", async () => {
    const db = await createTestDb();
    try {
      const repo = createConnectorRepository(db);
      const config = await repo.createConfig({
        connectorType: "outlook_calendar",
        authType: "oauth",
        credentials: "{}",
        createdBy: "owner-1",
        scopeConfig: JSON.stringify({ calendarIds: ["calendar-1"] }),
      });
      await seedCalendarFile(repo, config.id, "calendar-1:old-event", "outlook_calendar");
      await seedCalendarFile(repo, config.id, "calendar-2:removed-event", "outlook_calendar");

      const result = await pruneCalendarFilesOutsideScope({
        db,
        connectorConfigId: config.id,
        connectorType: "outlook_calendar",
        scopeConfig: { calendarIds: ["calendar-1"] },
        logger,
      });

      expect(result.itemsDeleted).toBe(1);
      await expectActiveProviderFileIds(db, config.id, ["calendar-1:old-event"]);
    } finally {
      await db.destroy();
    }
  });
});

async function seedCalendarFile(
  repo: ReturnType<typeof createConnectorRepository>,
  connectorConfigId: string,
  providerFileId: string,
  source: "google_calendar" | "outlook_calendar" = "google_calendar",
) {
  const result = await repo.upsertFile({
    source,
    providerFileId,
    providerUrl: null,
    fileName: providerFileId,
    fileType: "calendar_event",
    contentCategory: "structured",
    content: providerFileId,
    sourcePath: null,
    contentHash: providerFileId,
    sourceCreatedAt: "2026-06-15T09:00:00.000Z",
    sourceUpdatedAt: "2026-06-15T09:00:00.000Z",
    connectorConfigId,
  });
  await repo.linkConnectorFile(connectorConfigId, result.id);
}

async function expectActiveProviderFileIds(
  db: Awaited<ReturnType<typeof createTestDb>>,
  connectorConfigId: string,
  expected: string[],
) {
  const rows = await db
    .selectFrom("indexed_files")
    .select("provider_file_id")
    .where("connector_config_id", "=", connectorConfigId)
    .where("is_archived", "=", 0)
    .orderBy("provider_file_id")
    .execute();
  expect(rows.map((row) => row.provider_file_id)).toEqual(expected);
}

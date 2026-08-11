import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password";
import type { GeminiGenerator, GenerateOptions } from "../connectors/gemini-generate";
import { connectorFactories } from "../connectors/registry";
import type { Connector, SyncedItem } from "../connectors/types";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";

const PASSWORD = "testpassword123";
const CONNECTOR_ID = "enrich-scope-gmail";
const COMPANY_NAME = "Acme Ventures";
const originalGmailFactory = connectorFactories.gmail;

function fakeGmailConnector(items: SyncedItem[]): Connector {
  return {
    type: "gmail",
    perUserAuth: true,
    requiresOAuthClientSetup: false,
    syncIsCompleteSnapshot: true,
    async validateCredentials() {},
    async *sync() {
      for (const item of items) yield item;
    },
    async getCursor() {
      return null;
    },
  };
}

function syncedItem(id: string, content: string): SyncedItem {
  return {
    providerFileId: id,
    providerUrl: null,
    fileName: `${id}.txt`,
    fileType: "document",
    contentCategory: "document",
    content,
    sourcePath: null,
    contentHash: `hash-${id}`,
    sourceCreatedAt: "2026-08-11T00:00:00.000Z",
    sourceUpdatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function longDocument(id: string): string {
  return Array.from(
    { length: 120 },
    (_, index) => `${COMPANY_NAME} planning note ${id} ${index} describes launch coordination and partner followup.`,
  ).join(" ");
}

function generator(): GeminiGenerator {
  return {
    async generate() {
      return `${COMPANY_NAME} appears in the document.`;
    },
    async generateJSON<T>(_prompt: string, opts?: Omit<GenerateOptions, "responseMimeType">) {
      if (opts?.label?.startsWith("extractEntities:")) {
        return {
          mentions: [{ mention: COMPANY_NAME, type: "company", variations: [], confidence: 0.95 }],
          relations: [],
        } as T;
      }
      return {} as T;
    },
  };
}

async function seedHarness(db: Kysely<DB>) {
  const users = createUserRepository(db);
  const settings = createSettingsRepository(db);
  const connectorRepo = createConnectorRepository(db);
  await settings.ensure();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const admin = await users.create({
    name: "Admin",
    email: "admin@example.com",
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  const connector = await connectorRepo.createConfig({
    connectorType: "gmail",
    authType: "system",
    credentials: JSON.stringify({ type: "system" }),
    syncStatus: "active",
    createdBy: admin.id,
  });
  await db.updateTable("connector_configs").set({ id: CONNECTOR_ID }).where("id", "=", connector.id).execute();
  const fileA = await connectorRepo.upsertFile({
    ...syncedItem("file-a", longDocument("a")),
    source: "gmail",
    connectorConfigId: CONNECTOR_ID,
  });
  const fileB = await connectorRepo.upsertFile({
    ...syncedItem("file-b", longDocument("b")),
    source: "gmail",
    connectorConfigId: CONNECTOR_ID,
  });
  await connectorRepo.linkConnectorFile(CONNECTOR_ID, fileA.id);
  await connectorRepo.linkConnectorFile(CONNECTOR_ID, fileB.id);
  const factRepo = createIndexedFileFactRepository(db);
  for (const file of [fileA, fileB]) {
    await factRepo.upsertFact({
      indexedFileId: file.id,
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: admin.id,
      contentHash: file.id === fileA.id ? "hash-file-a" : "hash-file-b",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: COMPANY_NAME,
      subjectSource: "llm_extraction",
      subjectSourceId: `seed:${file.id}:${COMPANY_NAME}`,
      raw: {
        contentHash: file.id === fileA.id ? "hash-file-a" : "hash-file-b",
        promptVersion: "llm-extraction-v13",
        model: "test",
        mention: COMPANY_NAME,
        type: "company",
        variations: [],
        confidence: 0.95,
      },
    });
  }
  return { adminId: admin.id, fileAId: fileA.id, fileBId: fileB.id };
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}

async function liveFactMaterializedAt(db: Kysely<DB>, indexedFileId: string): Promise<Array<string | null>> {
  const rows = await db
    .selectFrom("indexed_file_facts")
    .select("materialized_at")
    .where("indexed_file_id", "=", indexedFileId)
    .where("fact_type", "=", "llm_extracted")
    .where("deleted_at", "is", null)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((row) => row.materialized_at);
}

async function waitForConnectorStatus(
  app: ReturnType<typeof createApp>,
  cookie: string,
  status: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const response = await app.request(`/api/connectors/${CONNECTOR_ID}`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { connector: { syncStatus: string } };
      expect(body.connector.syncStatus).toBe(status);
    },
    { timeout: 20_000, interval: 25 },
  );
}

describe("POST /api/connectors/files/:fileId/enrichments materialization scope", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    connectorFactories.gmail = originalGmailFactory;
    if (db) await db.destroy();
    db = null;
  });

  it("materializes the enriched file and leaves other files for the post-sync drain", async () => {
    db = await createTestPgDb();
    const { fileAId, fileBId } = await seedHarness(db);
    const items = [syncedItem("file-a", longDocument("a")), syncedItem("file-b", longDocument("b"))];
    connectorFactories.gmail = () => fakeGmailConnector(items);
    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), {
      logger: createTestLogger(),
      enrichmentGenerator: generator(),
    });
    const cookie = await login(app);

    const enrich = await app.request(`/api/connectors/files/${fileAId}/enrichments`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(enrich.status).toBe(200);

    await vi.waitFor(
      async () => {
        expect((await liveFactMaterializedAt(db as Kysely<DB>, fileAId)).some(Boolean)).toBe(true);
      },
      { timeout: 20_000, interval: 25 },
    );
    expect(await liveFactMaterializedAt(db, fileBId)).toEqual([null]);

    const sync = await app.request(`/api/connectors/${CONNECTOR_ID}/syncs`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(sync.status).toBe(201);
    await waitForConnectorStatus(app, cookie, "active");

    await vi.waitFor(
      async () => {
        expect((await liveFactMaterializedAt(db as Kysely<DB>, fileBId)).every(Boolean)).toBe(true);
      },
      { timeout: 20_000, interval: 25 },
    );
  });
});

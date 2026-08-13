import { randomUUID } from "node:crypto";
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
import { configureMaterializeDefaults } from "../entities/materialize";
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

function promptDocument(core: string): string {
  return Array.from(
    { length: 120 },
    (_, index) => `${core} Followup note ${index} records customer context and delivery planning.`,
  ).join(" ");
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

function featureMentionGenerator(): GeminiGenerator {
  return {
    async generate() {
      return "Northstar Systems and CRM Analytics appear in the document.";
    },
    async generateJSON<T>(_prompt: string, opts?: Omit<GenerateOptions, "responseMimeType">) {
      if (opts?.label?.startsWith("extractEntities:")) {
        return {
          mentions: [
            { mention: "Northstar Systems", type: "company", variations: [], confidence: 0.94 },
            {
              mention: "CRM Analytics",
              type: "feature",
              parentProduct: "Canvas CRM",
              variations: ["Analytics tab"],
              confidence: 0.91,
            },
          ],
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

async function seedPerson(db: Kysely<DB>, name: string): Promise<string> {
  const id = `person-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}`;
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: "person",
      status: "confirmed",
      aliases: JSON.stringify([]),
      metadata: JSON.stringify({}),
      hotness: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

async function updateFileContent(db: Kysely<DB>, fileId: string, content: string, suffix: string): Promise<void> {
  await db
    .updateTable("indexed_files")
    .set({
      content,
      content_hash: `hash-${suffix}`,
      embedding_status: "pending",
      summary_status: "pending",
    })
    .where("id", "=", fileId)
    .execute();
}

async function addFile(db: Kysely<DB>, id: string, content: string): Promise<string> {
  const connectorRepo = createConnectorRepository(db);
  const file = await connectorRepo.upsertFile({
    ...syncedItem(id, content),
    source: "gmail",
    connectorConfigId: CONNECTOR_ID,
  });
  await connectorRepo.linkConnectorFile(CONNECTOR_ID, file.id);
  return file.id;
}

function promptCapturingGenerator(
  prompts: string[],
  mentionsForPrompt: (prompt: string) => Array<{ mention: string; variations?: string[] }>,
): GeminiGenerator {
  return {
    async generate() {
      return "Summary.";
    },
    async generateJSON<T>(prompt: string, opts?: Omit<GenerateOptions, "responseMimeType">) {
      if (opts?.label?.startsWith("extractEntities:")) {
        prompts.push(prompt);
        return {
          mentions: mentionsForPrompt(prompt).map((mention) => ({
            mention: mention.mention,
            type: "person",
            variations: mention.variations ?? [],
            confidence: 0.95,
          })),
          relations: [],
        } as T;
      }
      return {} as T;
    },
  };
}

function personCandidateLines(prompt: string): string[] {
  const match = prompt.match(
    /Known people already in the register[\s\S]*?(?=\n(?:## Meeting participants|Email thread context|File:))/,
  );
  if (!match) return [];
  return match[0]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

async function enrichFile(app: ReturnType<typeof createApp>, cookie: string, fileId: string): Promise<void> {
  const enrich = await app.request(`/api/connectors/files/${fileId}/enrichments`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  expect(enrich.status).toBe(200);
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
    configureMaterializeDefaults({ llmPromotionThreshold: 2 });
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

  it("drops extracted feature mentions without writing feature facts or generic extraction rows", async () => {
    db = await createTestPgDb();
    const { fileAId } = await seedHarness(db);
    await db
      .updateTable("indexed_files")
      .set({
        content: `${longDocument("feature-route")} Northstar Systems is evaluating CRM Analytics in Canvas CRM.`,
        content_hash: "hash-feature-route",
      })
      .where("id", "=", fileAId)
      .execute();
    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), {
      logger: createTestLogger(),
      enrichmentGenerator: featureMentionGenerator(),
    });
    const cookie = await login(app);

    const enrich = await app.request(`/api/connectors/files/${fileAId}/enrichments`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(enrich.status).toBe(200);

    await vi.waitFor(
      async () => {
        const row = await db
          ?.selectFrom("indexed_file_facts")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("indexed_file_id", "=", fileAId)
          .where("fact_type", "=", "llm_extracted")
          .where("subject_name", "=", "Northstar Systems")
          .where("deleted_at", "is", null)
          .executeTakeFirstOrThrow();
        expect(Number(row?.count ?? 0)).toBe(1);
      },
      { timeout: 20_000, interval: 25 },
    );

    const featureFacts = await db
      .selectFrom("indexed_file_facts")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("indexed_file_id", "=", fileAId)
      .where("fact_type", "=", "feature")
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(featureFacts.count)).toBe(0);

    const genericFeatureRows = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("indexed_file_id", "=", fileAId)
      .where("fact_type", "=", "llm_extracted")
      .where("deleted_at", "is", null)
      .execute();
    expect(
      genericFeatureRows.map((row) => JSON.parse(row.raw ?? "{}")).filter((raw) => raw.type === "feature"),
    ).toEqual([]);
  });

  it("offers a canonical person candidate and renders personal-domain participants in the prompt", async () => {
    configureMaterializeDefaults({ llmPromotionThreshold: 1 });
    db = await createTestPgDb();
    const { fileAId } = await seedHarness(db);
    await seedPerson(db, "Himanshu Kalra");
    await updateFileContent(
      db,
      fileAId,
      promptDocument("Kalra, Himanshu reviewed the discovery agenda with the delivery team."),
      "himanshu-kalra",
    );
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: fileAId,
      connectorConfigId: CONNECTOR_ID,
      contentHash: "hash-himanshu-kalra",
      source: "sync",
      factType: "attendee",
      relation: "attended",
      subjectName: "Priya Nair",
      subjectEmail: "priya.nair@gmail.com",
      subjectSource: "calendar",
      subjectSourceId: "attendee:priya",
      raw: { providerFileId: fileAId, attendee: { name: "Priya Nair", email: "priya.nair@gmail.com" } },
    });
    await factRepo.upsertFact({
      indexedFileId: fileAId,
      connectorConfigId: CONNECTOR_ID,
      contentHash: "hash-himanshu-kalra",
      source: "sync",
      factType: "attendee",
      relation: "attended",
      subjectName: "Support Desk",
      subjectEmail: "support@gmail.com",
      subjectSource: "calendar",
      subjectSourceId: "attendee:support",
      raw: { providerFileId: fileAId, attendee: { name: "Support Desk", email: "support@gmail.com" } },
    });

    const prompts: string[] = [];
    const generator = promptCapturingGenerator(prompts, (prompt) =>
      prompt.includes("- Himanshu Kalra (person)")
        ? [{ mention: "Himanshu Kalra", variations: ["Kalra, Himanshu"] }]
        : [],
    );
    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), {
      logger: createTestLogger(),
      enrichmentGenerator: generator,
    });
    const cookie = await login(app);

    await enrichFile(app, cookie, fileAId);

    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 20_000, interval: 25 });
    expect.soft(personCandidateLines(prompts[0])).toContain("- Himanshu Kalra (person)");
    expect.soft(prompts[0]).toContain("- Priya Nair — external (no resolved company) (priya.nair@gmail.com)");
    expect.soft(prompts[0]).not.toContain("Support Desk");
    expect.soft(prompts[0]).not.toContain("support@gmail.com");

    await vi.waitFor(
      async () => {
        const rows = await db
          ?.selectFrom("entities")
          .select(["name", "aliases"])
          .where("source_type", "=", "person")
          .where("name", "=", "Himanshu Kalra")
          .execute();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows?.[0]?.aliases ?? "[]")).toContain("Kalra, Himanshu");
      },
      { timeout: 20_000, interval: 25 },
    );

    const queued = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("entity_type", "=", "person")
      .where("proposed_name", "=", "Himanshu Kalra")
      .execute();
    expect(queued).toHaveLength(0);
  });

  it("offers common-name person candidates only on distinctive or adjacent whole-token evidence", async () => {
    db = await createTestPgDb();
    await seedHarness(db);
    for (const name of [
      "Rahul Sharma",
      "Rahul Verma",
      "Rahul Bose",
      "Rahul Mehta",
      "Rahul Kapoor",
      "Rahul Iyer",
      "Rahul Batra",
      "Rahul Kumar",
      "Anil Sharma",
      "Priya Sharma",
      "Neha Sharma",
      "Kabir Sharma",
      "Dev Sharma",
      "Rohan Sharma",
      "Anil Kumar",
      "Priya Kumar",
      "Neha Kumar",
      "Kabir Kumar",
      "Dev Kumar",
      "Rohan Kumar",
    ]) {
      await seedPerson(db, name);
    }
    for (let i = 0; i < 5; i++) await seedPerson(db, "Megha Mukherji");
    for (let i = 0; i < 3; i++) await seedPerson(db, "Megha");

    const prompts: string[] = [];
    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), {
      logger: createTestLogger(),
      enrichmentGenerator: promptCapturingGenerator(prompts, () => []),
    });
    const cookie = await login(app);

    const cases = [
      {
        id: "rahul-sharma-adjacent",
        core: "Rahul Sharma discussed the onboarding plan.",
        assert: (lines: string[]) => {
          expect(lines).toContain("- Rahul Sharma (person)");
          expect(lines).not.toContain("- Rahul Verma (person)");
          expect(lines).not.toContain("- Rahul Bose (person)");
          expect(lines).not.toContain("- Rahul Kumar (person)");
        },
      },
      {
        id: "bare-rahul",
        core: "Rahul discussed the onboarding plan.",
        assert: (lines: string[]) => {
          expect(lines.some((line) => line.includes("Rahul"))).toBe(false);
        },
      },
      {
        id: "rahul-kumar-far",
        core: "Rahul Sharma discussed onboarding.\n\nAnil Kumar reviewed implementation risks.",
        assert: (lines: string[]) => {
          expect(lines).not.toContain("- Rahul Kumar (person)");
        },
      },
      {
        id: "substring-shapes",
        core: "Rahulson Sharmaji discussed onboarding.",
        assert: (lines: string[]) => {
          expect(lines).toEqual([]);
        },
      },
      {
        id: "megha-distinct-name-holders",
        core: "Megha discussed onboarding.",
        assert: (lines: string[]) => {
          expect(lines).toContain("- Megha (person)");
          expect(lines).toContain("- Megha Mukherji (person)");
        },
      },
    ];

    for (const testCase of cases) {
      const fileId = await addFile(db, testCase.id, promptDocument(testCase.core));
      await enrichFile(app, cookie, fileId);
      await vi.waitFor(() => expect(prompts.length).toBeGreaterThan(0), { timeout: 20_000, interval: 25 });
      const prompt = prompts.shift();
      if (!prompt) throw new Error("expected captured prompt");
      testCase.assert(personCandidateLines(prompt));
    }
  });

  it("caps rendered person candidates at fifty names", async () => {
    configureMaterializeDefaults({ llmPromotionThreshold: 1 });
    db = await createTestPgDb();
    await seedHarness(db);
    const words = Array.from({ length: 55 }, (_, index) => {
      const first = String.fromCharCode(97 + Math.floor(index / 26));
      const second = String.fromCharCode(97 + (index % 26));
      return `cap${first}${second}`;
    });
    for (const word of words) await seedPerson(db, `Candidate ${word}`);

    const prompts: string[] = [];
    const app = createApp(db, createTestConfig({ DB_TYPE: "postgres" }), {
      logger: createTestLogger(),
      enrichmentGenerator: promptCapturingGenerator(prompts, () => []),
    });
    const cookie = await login(app);
    const fileId = await addFile(db, "person-cap", promptDocument(words.map((word) => `Candidate ${word}`).join(". ")));

    await enrichFile(app, cookie, fileId);

    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 20_000, interval: 25 });
    expect(personCandidateLines(prompts[0])).toHaveLength(50);
  });
});

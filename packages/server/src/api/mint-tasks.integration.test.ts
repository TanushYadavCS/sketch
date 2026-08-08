import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import { TASK_MINTING_NO_EMBEDDING_SELECTION } from "../connectors/task-minting";
import { EMBEDDING_DIMENSIONS } from "../db/index";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createTaskRepository } from "../db/repositories/tasks";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestLogger, createTestPgDb } from "../test-utils";

const PASSWORD = "testpassword123";
const PROJECT_ID = "mint-project";
const logger = createTestLogger();
const config = createTestConfig({ DB_TYPE: "postgres", TASK_MINTING_MODEL: "test/stub-model" });

describe("POST /api/connectors/files/:fileId/tasks", () => {
  let db: Kysely<DB>;
  let ownerCookie: string;
  let otherCookie: string;
  let fileId: string;
  let connectorConfigId: string;
  let ownerId: string;
  let generatorCalls: number;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    db = await createTestPgDb();
    const fixture = await seedFixture(db);
    fileId = fixture.fileId;
    connectorConfigId = fixture.connectorConfigId;
    ownerId = fixture.ownerId;
    generatorCalls = 0;
    const generator: GeminiGenerator = {
      async generate() {
        return "{}";
      },
      async generateJSON<T>() {
        generatorCalls++;
        return {
          tasks: [
            {
              title: "Send the launch plan",
              owner: { name: "Owner" },
              dueDate: "2026-08-15",
              hasOwnerVerbObject: true,
              sourceExcerpt: "Owner will send the launch plan by August 15.",
              projectId: "P1",
            },
            {
              title: "Publish release notes",
              owner: { email: "owner@example.com" },
              hasOwnerVerbObject: true,
              sourceExcerpt: "Owner will publish the release notes.",
              projectId: "P1",
            },
          ],
        } as T;
      },
    };
    app = createApp(db, config, { logger, taskMintingGenerator: generator });
    ownerCookie = await login(app, "owner@example.com");
    otherCookie = await login(app, "other@example.com");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("mints two candidates from a disabled connector and exposes both through the tasks API", async () => {
    const response = await app.request(`/api/connectors/files/${fileId}/tasks`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    const body = (await response.json()) as {
      candidates: Array<{ title: string; taskId?: string; projectName?: string | null }>;
      written: number;
      context: Array<{ key: string; via?: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.written).toBe(2);
    expect(body.candidates).toEqual([
      expect.objectContaining({
        title: "Send the launch plan",
        taskId: expect.any(String),
        projectName: "Mint Project",
      }),
      expect.objectContaining({
        title: "Publish release notes",
        taskId: expect.any(String),
        projectName: "Mint Project",
      }),
    ]);
    expect(body.context.every((block) => block.via === "prompt")).toBe(true);

    const tasksResponse = await app.request(`/api/entities/${PROJECT_ID}/tasks`, {
      headers: { Cookie: ownerCookie },
    });
    const tasksBody = (await tasksResponse.json()) as { tasks: Array<{ id: string; provenance: string }> };
    expect(tasksResponse.status).toBe(200);
    expect(tasksBody.tasks).toHaveLength(2);
    expect(tasksBody.tasks.map((task) => task.id).sort()).toEqual(
      body.candidates.flatMap((candidate) => (candidate.taskId ? [candidate.taskId] : [])).sort(),
    );
    expect(tasksBody.tasks.every((task) => task.provenance === "llm")).toBe(true);
  });

  it("keeps minted tasks visible to the caller and hidden from another user", async () => {
    const mintResponse = await app.request(`/api/connectors/files/${fileId}/tasks`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    expect(mintResponse.status).toBe(200);

    const ownerResponse = await app.request(`/api/entities/${PROJECT_ID}/tasks`, {
      headers: { Cookie: ownerCookie },
    });
    const otherResponse = await app.request(`/api/entities/${PROJECT_ID}/tasks`, {
      headers: { Cookie: otherCookie },
    });
    const ownerBody = (await ownerResponse.json()) as { tasks: unknown[] };
    const otherBody = (await otherResponse.json()) as { tasks: unknown[] };

    expect(ownerBody.tasks).toHaveLength(2);
    expect(otherBody.tasks).toHaveLength(0);
  });

  it("rejects a denied caller before generation and writes no facts or tasks", async () => {
    const response = await app.request(`/api/connectors/files/${fileId}/tasks`, {
      method: "POST",
      headers: { Cookie: otherCookie },
    });
    const llmFacts = await db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("fact_type", "=", "llm_task")
      .executeTakeFirstOrThrow();
    const tasks = await db
      .selectFrom("tasks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("provenance", "=", "llm")
      .executeTakeFirstOrThrow();

    expect(response.status).toBe(403);
    expect(generatorCalls).toBe(0);
    expect(Number(llmFacts.count)).toBe(0);
    expect(Number(tasks.count)).toBe(0);
  });

  it("selects existing tasks from the embedding neighbourhood and excludes a task outside K=20", async () => {
    const { neighbourFileId, unrelatedFileId } = await seedEmbeddingCorpus(db, fileId, connectorConfigId);
    await seedVisibleTask(db, "Neighbourhood follow-up", "neighbourhood-task", neighbourFileId, ownerId);
    await seedVisibleTask(db, "Unrelated follow-up", "unrelated-task", unrelatedFileId, ownerId);

    const response = await app.request(`/api/connectors/files/${fileId}/tasks`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    const body = (await response.json()) as {
      context: Array<{ key: string; items: string[] }>;
    };
    const existingTasks = body.context.find((block) => block.key === "existing_tasks");

    expect(response.status).toBe(200);
    expect(existingTasks?.items).toContain("Neighbourhood follow-up");
    expect(existingTasks?.items).not.toContain("Unrelated follow-up");
  });

  it("falls back to this file when it has no embedding and reports the degraded selection", async () => {
    const response = await app.request(`/api/connectors/files/${fileId}/tasks`, {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    const body = (await response.json()) as {
      context: Array<{ key: string; selection: string }>;
      similarFiles: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.context.find((block) => block.key === "existing_tasks")?.selection).toBe(
      TASK_MINTING_NO_EMBEDDING_SELECTION,
    );
    expect(body.similarFiles).toEqual([]);
  });
});

async function seedFixture(db: Kysely<DB>) {
  const users = createUserRepository(db);
  const settings = createSettingsRepository(db);
  const passwordHash = await hashPassword(PASSWORD);
  await settings.ensure();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  await users.create({
    name: "Admin",
    email: "admin@example.com",
    emailVerified: true,
    passwordHash,
    authRole: "admin",
  });
  const owner = await users.create({
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    passwordHash,
    authRole: "member",
  });
  await users.create({
    name: "Other",
    email: "other@example.com",
    emailVerified: true,
    passwordHash,
    authRole: "member",
  });
  const connectorRepo = createConnectorRepository(db);
  const connector = await connectorRepo.createConfig({
    connectorType: "fireflies",
    authType: "api_key",
    credentials: JSON.stringify({ type: "api_key", api_key: "stub" }),
    syncStatus: "disabled",
    createdBy: owner.id,
  });
  const file = await connectorRepo.upsertFile({
    source: "fireflies",
    providerFileId: "mint-transcript",
    providerUrl: null,
    fileName: "Launch meeting",
    fileType: "transcript",
    contentCategory: "document",
    content: "Owner will send the launch plan by August 15. Owner will publish the release notes.",
    sourcePath: null,
    contentHash: "mint-content-hash",
    sourceCreatedAt: "2026-08-08T09:00:00.000Z",
    sourceUpdatedAt: null,
    connectorConfigId: connector.id,
  });
  await connectorRepo.linkConnectorFile(connector.id, file.id);
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: PROJECT_ID,
      name: "Mint Project",
      source_type: "project",
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "active",
      hotness: 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
      share_with_everyone: 1,
      deleted_at: null,
      merged_into_entity_id: null,
    })
    .execute();
  return { fileId: file.id, connectorConfigId: connector.id, ownerId: owner.id };
}

async function seedEmbeddingCorpus(db: Kysely<DB>, targetFileId: string, connectorConfigId: string) {
  const connectorRepo = createConnectorRepository(db);
  await sql`INSERT INTO file_embeddings (indexed_file_id, embedding)
    VALUES (${targetFileId}, ${makeVector(EMBEDDING_DIMENSIONS, { 0: 1 })}::vector)`.execute(db);
  let neighbourFileId = "";
  for (let index = 1; index <= 19; index++) {
    const file = await connectorRepo.upsertFile({
      source: "fireflies",
      providerFileId: `mint-filler-${index}`,
      providerUrl: null,
      fileName: `Filler ${index}`,
      fileType: "transcript",
      contentCategory: "document",
      content: `Filler ${index}`,
      sourcePath: null,
      contentHash: `mint-filler-hash-${index}`,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      connectorConfigId,
    });
    const vector = makeVector(EMBEDDING_DIMENSIONS, { 0: 1, [index]: 0.1 });
    await sql`INSERT INTO file_embeddings (indexed_file_id, embedding) VALUES (${file.id}, ${vector}::vector)`.execute(
      db,
    );
    if (index === 19) neighbourFileId = file.id;
  }
  const unrelated = await connectorRepo.upsertFile({
    source: "fireflies",
    providerFileId: "mint-unrelated",
    providerUrl: null,
    fileName: "Unrelated",
    fileType: "transcript",
    contentCategory: "document",
    content: "Unrelated",
    sourcePath: null,
    contentHash: "mint-unrelated-hash",
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    connectorConfigId,
  });
  await sql`INSERT INTO file_embeddings (indexed_file_id, embedding)
    VALUES (${unrelated.id}, ${makeVector(EMBEDDING_DIMENSIONS, { 1: 1 })}::vector)`.execute(db);
  return { neighbourFileId, unrelatedFileId: unrelated.id };
}

async function seedVisibleTask(
  db: Kysely<DB>,
  title: string,
  sourceTaskId: string,
  evidenceFileId: string,
  ownerId: string,
) {
  const result = await createTaskRepository(db).upsertTask({
    parentEntityId: null,
    parentSourceRef: null,
    parentName: null,
    source: "llm",
    externalRef: null,
    title,
    status: "open",
    statusRaw: null,
    statusAuthority: "local",
    assigneeEntityId: null,
    priority: null,
    dueAt: null,
    provenance: "llm",
    sourceTaskId,
    createdByUserId: ownerId,
  });
  await db
    .insertInto("task_evidence")
    .values({ task_id: result.taskId, kind: "file", ref_id: evidenceFileId })
    .execute();
}

function makeVector(dims: number, values: Record<number, number> = {}): string {
  const vector = new Array(dims).fill(0);
  for (const [index, value] of Object.entries(values)) vector[Number(index)] = value;
  return `[${vector.join(",")}]`;
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie") ?? "";
}

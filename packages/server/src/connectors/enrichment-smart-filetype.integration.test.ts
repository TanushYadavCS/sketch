import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import { runEnrichment } from "./enrichment";
import type { GeminiGenerator } from "./gemini-generate";

async function seedConnector(db: Kysely<DB>, connectorId: string, connectorType = "linear"): Promise<void> {
  await db
    .insertInto("connector_configs")
    .values({
      id: connectorId,
      connector_type: connectorType,
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
}

async function seedIndexedFile(
  db: Kysely<DB>,
  params: {
    connectorId: string;
    fileId: string;
    fileName: string;
    fileType: string;
    source: string;
    sourcePath: string;
    content: string;
    embeddingStatus?: "pending" | "processing" | "done" | "failed";
    summaryStatus?: "pending" | "processing" | "done" | "failed" | "skipped";
  },
): Promise<void> {
  await db
    .insertInto("indexed_files")
    .values({
      id: params.fileId,
      connector_config_id: params.connectorId,
      provider_file_id: params.fileId,
      file_name: params.fileName,
      file_type: params.fileType,
      content_category: "document",
      source: params.source,
      source_path: params.sourcePath,
      content: params.content,
      content_hash: `hash-${params.fileId}`,
      embedding_status: params.embeddingStatus ?? "done",
      summary_status: params.summaryStatus ?? "pending",
      synced_at: new Date().toISOString(),
    })
    .execute();
}

describe("runEnrichment — smart enrichment file type threading", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30000);

  afterEach(async () => {
    await db.destroy();
  });

  it("threads indexed_files.file_type into the smart-enrichment proposable type set", async () => {
    const connectorId = `conn-${randomUUID()}`;
    const fileId = randomUUID();
    const content = Array.from({ length: 120 }, () => "Sarah Chen works on Project Atlas.").join(" ");
    let capturedPrompt = "";

    await seedConnector(db, connectorId);
    await seedIndexedFile(db, {
      connectorId,
      fileId,
      fileName: "SKE-106: Entity Creation Review",
      fileType: "issue",
      source: "linear",
      sourcePath: "Linear/SKE-106",
      content,
    });

    const generator = {
      generate: async () => "Sarah Chen works on Project Atlas.",
      generateJSON: async <T>(prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          capturedPrompt = prompt;
          return {
            mentions: [
              { mention: "Sarah Chen", type: "person", variations: ["Sarah"], confidence: 0.95 },
              { mention: "Project Atlas", type: "project", variations: ["Atlas"], confidence: 0.94 },
            ],
            relations: [
              {
                type: "contributes_to",
                source: { name: "Sarah Chen", type: "person", variations: ["Sarah"] },
                target: { name: "Project Atlas", type: "project", variations: ["Atlas"] },
                confidence: 0.92,
                context: "Sarah Chen works on Project Atlas.",
              },
            ],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator,
      fileIds: [fileId],
    });

    expect(capturedPrompt).toContain('Valid types: "person", "company", "product"');
    expect(capturedPrompt).not.toContain('Valid types: "person", "project", "company", "product", "team"');

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "subject_name"])
      .where("indexed_file_id", "=", fileId)
      .where("source", "=", "llm_extraction")
      .where("deleted_at", "is", null)
      .orderBy("subject_name", "asc")
      .execute();
    expect(facts).toEqual([{ fact_type: "llm_extracted", subject_name: "Sarah Chen" }]);

    const projectReviews = await db
      .selectFrom("entity_review_queue")
      .selectAll()
      .where("entity_type", "=", "project")
      .execute();
    expect(projectReviews).toHaveLength(0);
  });

  it("runs smart enrichment for a short pending WhatsApp conversation slice", async () => {
    const connectorId = `conn-${randomUUID()}`;
    const fileId = randomUUID();
    let extractCalls = 0;

    await seedConnector(db, connectorId, "whatsapp");
    await seedIndexedFile(db, {
      connectorId,
      fileId,
      fileName: "WhatsApp Slice",
      fileType: "whatsapp_conversation_slice",
      source: "whatsapp",
      sourcePath: "WhatsApp/Group/2026-01-01",
      content: "Maya asked Liam about ClickUp renewal pricing.",
      embeddingStatus: "pending",
      summaryStatus: "pending",
    });

    const generator = {
      generate: async () => "Maya asked Liam about ClickUp renewal pricing.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          extractCalls += 1;
          return {
            mentions: [{ mention: "ClickUp", type: "product", variations: [], confidence: 0.93 }],
            relations: [],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator,
      fileIds: [fileId],
    });

    const file = await db
      .selectFrom("indexed_files")
      .select(["summary_status", "summary"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(extractCalls).toBe(1);
    expect(file.summary_status).not.toBe("skipped");
    expect(file.summary).toBe("Maya asked Liam about ClickUp renewal pricing.");
  });

  it("still skips smart enrichment for a short non-WhatsApp document", async () => {
    const connectorId = `conn-${randomUUID()}`;
    const fileId = randomUUID();
    let extractCalls = 0;

    await seedConnector(db, connectorId, "google_drive");
    await seedIndexedFile(db, {
      connectorId,
      fileId,
      fileName: "Short Note",
      fileType: "document",
      source: "google_drive",
      sourcePath: "Drive/Short Note",
      content: "Short generic document about ClickUp.",
      embeddingStatus: "pending",
      summaryStatus: "pending",
    });

    const generator = {
      generate: async () => "Short generic document summary.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) extractCalls += 1;
        return { mentions: [], relations: [] } as T;
      },
    } as GeminiGenerator;

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator,
      fileIds: [fileId],
    });

    const file = await db
      .selectFrom("indexed_files")
      .select("summary_status")
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(extractCalls).toBe(0);
    expect(file.summary_status).toBe("skipped");
  });

  it("handles a one-word WhatsApp conversation slice without blank enrichment", async () => {
    const connectorId = `conn-${randomUUID()}`;
    const fileId = randomUUID();
    let extractCalls = 0;

    await seedConnector(db, connectorId, "whatsapp");
    await seedIndexedFile(db, {
      connectorId,
      fileId,
      fileName: "Tiny WhatsApp Slice",
      fileType: "whatsapp_conversation_slice",
      source: "whatsapp",
      sourcePath: "WhatsApp/Group/2026-01-02",
      content: "ClickUp",
      embeddingStatus: "pending",
      summaryStatus: "pending",
    });

    const generator = {
      generate: async () => "ClickUp.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) extractCalls += 1;
        return {
          mentions: [{ mention: "ClickUp", type: "product", variations: [], confidence: 0.9 }],
          relations: [],
        } as T;
      },
    } as GeminiGenerator;

    await expect(
      runEnrichment({
        db,
        logger: createTestLogger(),
        embeddingProvider: null,
        generator,
        fileIds: [fileId],
      }),
    ).resolves.toMatchObject({ filesProcessed: 1 });

    const file = await db
      .selectFrom("indexed_files")
      .select(["summary_status", "summary"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(extractCalls).toBe(1);
    expect(file).toEqual({ summary_status: "done", summary: "ClickUp." });
  });

  it("runs smart enrichment for a short summary-only WhatsApp conversation slice", async () => {
    const connectorId = `conn-${randomUUID()}`;
    const fileId = randomUUID();
    let extractCalls = 0;

    await seedConnector(db, connectorId, "whatsapp");
    await seedIndexedFile(db, {
      connectorId,
      fileId,
      fileName: "Embedded WhatsApp Slice",
      fileType: "whatsapp_conversation_slice",
      source: "whatsapp",
      sourcePath: "WhatsApp/Group/2026-01-03",
      content: "Priya told Omar the ClickUp rollout starts Monday.",
      embeddingStatus: "done",
      summaryStatus: "pending",
    });

    const generator = {
      generate: async () => "Priya told Omar the ClickUp rollout starts Monday.",
      generateJSON: async <T>(_prompt: string, opts?: { label?: string }) => {
        if (opts?.label?.startsWith("extractEntities")) {
          extractCalls += 1;
          return {
            mentions: [{ mention: "ClickUp", type: "product", variations: [], confidence: 0.91 }],
            relations: [],
          } as T;
        }
        return {} as T;
      },
    } as GeminiGenerator;

    await runEnrichment({
      db,
      logger: createTestLogger(),
      embeddingProvider: null,
      generator,
      fileIds: [fileId],
    });

    const file = await db
      .selectFrom("indexed_files")
      .select(["embedding_status", "summary_status", "summary"])
      .where("id", "=", fileId)
      .executeTakeFirstOrThrow();

    expect(extractCalls).toBe(1);
    expect(file).toEqual({
      embedding_status: "done",
      summary_status: "done",
      summary: "Priya told Omar the ClickUp rollout starts Monday.",
    });
  });
});

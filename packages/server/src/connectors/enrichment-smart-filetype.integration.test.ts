import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestLogger, createTestPgDb } from "../test-utils";
import { runEnrichment } from "./enrichment";
import type { GeminiGenerator } from "./gemini-generate";

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

    await db
      .insertInto("connector_configs")
      .values({
        id: connectorId,
        connector_type: "linear",
        auth_type: "oauth",
        credentials: "{}",
        created_by: "admin",
      })
      .execute();

    await db
      .insertInto("indexed_files")
      .values({
        id: fileId,
        connector_config_id: connectorId,
        provider_file_id: fileId,
        file_name: "SKE-106: Entity Creation Review",
        file_type: "issue",
        content_category: "document",
        source: "linear",
        source_path: "Linear/SKE-106",
        content,
        content_hash: "hash-threaded-file-type",
        embedding_status: "done",
        summary_status: "pending",
        synced_at: new Date().toISOString(),
      })
      .execute();

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
});

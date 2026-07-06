import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleSearch, handleSearchEntities } from "../agent/tools/search";
import { UploadCollector } from "../agent/tools/types";
import { connectorRoutes } from "../api/connectors";
import { createEntityProfileRoutes } from "../api/entities/profile-routes";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import { matchEntities, smartEnrichFile } from "../connectors/smart-enrichment";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createEntityRepository } from "../db/repositories/entities";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { coerceMentionType, normalizeMentionType } from "./graph";
import { materializeUnmaterializedFacts } from "./materialize";
import type { ProposeEntityType } from "./propose";

const USER_ID = "user-tool";
const CONNECTOR_ID = "connector-tool";
const A1_BIRTH_GATE_TYPES: Set<ProposeEntityType> = new Set(["project", "product", "team"]);

async function seedBase(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Tool User",
      email: "tool@example.com",
      email_verified_at: now,
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: USER_ID,
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string, content: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: `${id}.md`,
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      source_path: `drive/${id}.md`,
      content,
      summary: content,
      content_hash: `hash-${id}`,
      is_archived: 0,
      synced_at: now,
      source_updated_at: now,
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, id: string, name: string, sourceType: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id,
      name,
      source_type: sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: 1,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedMention(db: Kysely<DB>, id: string, entityId: string, fileId: string): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id,
      entity_id: entityId,
      indexed_file_id: fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

function fakeGenerator(): GeminiGenerator {
  return {
    async generate() {
      return "Slack and Acme were discussed.";
    },
    async generateJSON<T>(_prompt: string, opts?: { label?: string }) {
      if (opts?.label?.startsWith("extractEntities")) {
        return {
          mentions: [
            { mention: "Slack", type: "product", variations: [], confidence: 0.95 },
            { mention: "Acme Corp", type: "company", variations: ["Acme"], confidence: 0.95 },
          ],
          relations: [
            {
              type: "builds",
              source: { name: "Acme Corp", type: "company", variations: ["Acme"] },
              target: { name: "Slack", type: "product", variations: [] },
              confidence: 0.95,
              context: "Acme Corp builds Slack",
            },
          ],
        } as T;
      }
      return {} as T;
    },
  } as GeminiGenerator;
}

function adminApp(routes: Hono): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sub", USER_ID);
    c.set("email", "tool@example.com");
    c.set("role", "admin");
    c.set("adminCanReadAllFiles", true);
    await next();
  });
  app.route("/", routes);
  return app;
}

describe("tool entity type", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("coerces denylisted names to tool without a flag", () => {
    expect(coerceMentionType("Slack", "product")).toBe("tool");
    expect(coerceMentionType("Internal Portal", "product")).toBe("product");
  });

  it("classifies and materializes Slack mentions as tool while dropping tool relation endpoints", async () => {
    await seedFile(db, "file-tool-classify", "Slack and Acme Corp were discussed.");
    await seedFile(db, "file-tool-classify-2", "Slack and Acme Corp were discussed again.");

    expect(coerceMentionType("Slack", "product")).toBe("tool");
    expect(normalizeMentionType("tool")).toBe("tool");

    for (const fileId of ["file-tool-classify", "file-tool-classify-2"]) {
      await smartEnrichFile(
        {
          db,
          logger: createTestLogger(),
          generator: fakeGenerator(),
          embeddingProvider: null,
        },
        {
          id: fileId,
          fileName: `${fileId}.md`,
          content: fileId.endsWith("-2")
            ? "Slack and Acme Corp were discussed again."
            : "Slack and Acme Corp were discussed.",
          contentCategory: "document",
          source: "google_drive",
          sourcePath: `drive/${fileId}.md`,
          contentHash: `hash-${fileId}`,
          connectorConfigId: CONNECTOR_ID,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      );
    }

    const slack = await db
      .selectFrom("entities")
      .select(["id", "source_type"])
      .where("name", "=", "Slack")
      .executeTakeFirstOrThrow();
    expect(slack.source_type).toBe("tool");
    expect(
      await db
        .selectFrom("entities")
        .select("id")
        .where("name", "=", "Slack")
        .where("source_type", "=", "product")
        .execute(),
    ).toHaveLength(0);
    expect(
      await db.selectFrom("indexed_file_facts").select("id").where("fact_type", "=", "llm_relation").execute(),
    ).toHaveLength(0);
    expect(await db.selectFrom("entity_relationships").select("id").execute()).toHaveLength(0);

    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: "file-tool-classify",
      connectorConfigId: CONNECTOR_ID,
      createdByUserId: USER_ID,
      contentHash: "hash-file-tool-classify",
      source: "llm_extraction",
      factType: "llm_relation",
      relation: "builds",
      subjectName: "Acme Corp",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-tool-classify:hash-file-tool-classify:relation:Acme:Slack",
      raw: {
        contentHash: "hash-file-tool-classify",
        promptVersion: "llm-extraction-v8",
        model: "gemini",
        relationType: "builds",
        confidence: 0.95,
        sourceConfidence: 0.95,
        targetConfidence: 0.95,
        source: { name: "Acme Corp", type: "company", variations: ["Acme"] },
        target: { name: "Slack", type: "product", variations: [] },
      },
    });

    await materializeUnmaterializedFacts(db, createTestLogger(), {
      llmPromotionThreshold: 1,
      birthGateTypes: A1_BIRTH_GATE_TYPES,
      birthGateDryRun: false,
    });

    expect(await db.selectFrom("entity_relationships").select("id").execute()).toHaveLength(0);
    expect(
      await db
        .selectFrom("entities")
        .select("id")
        .where("name", "=", "Slack")
        .where("source_type", "=", "product")
        .execute(),
    ).toHaveLength(0);
  });

  it("excludes tools from default search, API, graph, file detail, and matching", async () => {
    await seedFile(db, "file-tool-hidden", "Slack and Project Apollo are in this document.");
    await seedEntity(db, "entity-tool-slack", "Slack", "tool");
    await seedEntity(db, "entity-project-apollo", "Project Apollo", "project");
    await seedMention(db, "mention-tool-slack", "entity-tool-slack", "file-tool-hidden");
    await seedMention(db, "mention-project-apollo", "entity-project-apollo", "file-tool-hidden");

    const deps = {
      uploadCollector: new UploadCollector(),
      workspaceDir: "/tmp",
      db,
    };
    const searchResult = await handleSearch({ query: "Slack" }, deps);
    expect(searchResult.content[0]?.text ?? "").not.toContain("**Matching entities**: Slack");

    const defaultEntities = await handleSearchEntities({ queries: ["Slack"] }, deps);
    expect(defaultEntities.content[0]?.text ?? "").not.toContain("Slack");
    const explicitTools = await handleSearchEntities({ queries: ["Slack"], types: ["tool"] }, deps);
    expect(explicitTools.content[0]?.text ?? "").toContain("Slack");

    const entityApp = adminApp(
      createEntityProfileRoutes(db, { logger: createTestLogger(), config: createTestConfig() }),
    );
    const listRes = await entityApp.request("/?search=Slack");
    const listBody = (await listRes.json()) as { entities: Array<{ name: string }> };
    expect(listBody.entities.map((entity) => entity.name)).not.toContain("Slack");
    const explicitListRes = await entityApp.request("/?type=tool&search=Slack");
    const explicitListBody = (await explicitListRes.json()) as { entities: Array<{ name: string }> };
    expect(explicitListBody.entities.map((entity) => entity.name)).toContain("Slack");
    const graphRes = await entityApp.request("/graph");
    const graphBody = (await graphRes.json()) as { nodes: Array<{ name: string }> };
    expect(graphBody.nodes.map((node) => node.name)).not.toContain("Slack");

    const connectorApp = adminApp(connectorRoutes(createConnectorRepository(db), db, createTestLogger()));
    const fileRes = await connectorApp.request("/files/file-tool-hidden/content");
    const fileBody = (await fileRes.json()) as { entities: Array<{ name: string }> };
    expect(fileBody.entities.map((entity) => entity.name)).not.toContain("Slack");
    expect(fileBody.entities.map((entity) => entity.name)).toContain("Project Apollo");

    const matched = await matchEntities(db, [{ mention: "Slack", type: "product", variations: [] }]);
    expect(matched.matched).toHaveLength(0);
    expect(matched.unmatched.map((mention) => mention.mention)).toContain("Slack");
  });

  it("does not reclassify an existing product named like a tool", async () => {
    const entityRepo = createEntityRepository(db);
    await entityRepo.upsertEntity({
      name: "Slack",
      sourceType: "product",
      status: "confirmed",
    });

    const product = await db
      .selectFrom("entities")
      .select(["name", "source_type"])
      .where("name", "=", "Slack")
      .where("source_type", "=", "product")
      .executeTakeFirstOrThrow();

    expect(product).toMatchObject({ name: "Slack", source_type: "product" });
  });
});

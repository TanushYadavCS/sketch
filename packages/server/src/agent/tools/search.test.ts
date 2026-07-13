import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import {
  handleGetEntityContext,
  handleGetFileContent,
  handleSearch,
  handleSearchEntities,
  searchToolSchema,
} from "./search";
import { UploadCollector } from "./types";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg-search-tools",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin",
    })
    .execute();
  await db
    .insertInto("access_scopes")
    .values([
      {
        id: "scope-alice",
        connector_config_id: "cfg-search-tools",
        scope_type: "drive",
        provider_scope_id: "drive-alice",
      },
      {
        id: "scope-bob",
        connector_config_id: "cfg-search-tools",
        scope_type: "drive",
        provider_scope_id: "drive-bob",
      },
    ])
    .execute();
  await db
    .insertInto("access_scope_members")
    .values({ access_scope_id: "scope-alice", email: "alice@example.com" })
    .execute();

  const now = new Date().toISOString();
  const baseFile = {
    connector_config_id: "cfg-search-tools",
    file_type: "doc",
    content_category: "document",
    source: "google_drive",
    synced_at: now,
    source_updated_at: now,
  };
  await db
    .insertInto("indexed_files")
    .values([
      {
        id: "file-alice",
        ...baseFile,
        provider_file_id: "file-alice",
        file_name: "Alice project",
        content: "A".repeat(120),
        access_scope_id: "scope-alice",
      },
      {
        id: "file-bob",
        ...baseFile,
        provider_file_id: "file-bob",
        file_name: "Bob project",
        content: "secret",
        access_scope_id: "scope-bob",
      },
    ])
    .execute();
  await db
    .insertInto("entities")
    .values([
      {
        id: "entity-alice",
        name: "Project Alice",
        source_type: "project",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: "entity-bob",
        name: "Project Bob",
        source_type: "project",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto("entity_mentions")
    .values([
      {
        id: "mention-alice",
        entity_id: "entity-alice",
        indexed_file_id: "file-alice",
        chunk_index: 0,
        context_snippet: "alice context",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      },
      {
        id: "mention-bob",
        entity_id: "entity-bob",
        indexed_file_id: "file-bob",
        chunk_index: 0,
        context_snippet: "bob context",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: now,
      },
    ])
    .execute();
});

afterEach(async () => {
  await db.destroy();
});

it("accepts WhatsApp as a search source filter", () => {
  expect(searchToolSchema.source.safeParse("whatsapp").success).toBe(true);
});

function deps() {
  return {
    uploadCollector: new UploadCollector(),
    workspaceDir: "/tmp",
    db,
    userRepo: createUserRepository(db),
    publicMcp: {
      userEmails: ["alice@example.com"],
      filterEntityMetadata: true,
      maxFileContentChars: 50,
    },
  };
}

function zeroEmailDeps() {
  return {
    ...deps(),
    publicMcp: {
      userEmails: [],
      filterEntityMetadata: true,
      maxFileContentChars: 50,
    },
  };
}

describe("public search handlers", () => {
  it("filters entity search results to RBAC-accessible mentions", async () => {
    const result = await handleSearchEntities({ queries: ["Project"] }, deps());
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("Project Alice");
    expect(text).not.toContain("Project Bob");
  });

  it("does not reveal inaccessible entity context", async () => {
    const result = await handleGetEntityContext({ entityId: "entity-bob" }, deps());
    expect(result.content[0]?.text).toBe("Entity entity-bob not found.");
  });

  it("caps public file content responses", async () => {
    const result = await handleGetFileContent({ fileId: "file-alice" }, deps());
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("[Content truncated to 50 characters.]");
    expect(text.length).toBeLessThan(300);
  });

  it("denies all public handlers when the caller has no verified emails", async () => {
    await createUserRepository(db).create({
      name: "Directory Alice",
      email: "directory@example.com",
      emailVerified: true,
    });

    const searchResult = await handleSearch({ query: "Alice" }, zeroEmailDeps());
    const entitiesResult = await handleSearchEntities({ queries: ["Directory"] }, zeroEmailDeps());
    const contextResult = await handleGetEntityContext({ entityId: "entity-alice" }, zeroEmailDeps());
    const contentResult = await handleGetFileContent({ fileId: "file-alice" }, zeroEmailDeps());

    expect(searchResult.content[0]?.text).toBe('No results found for "Alice".');
    expect(entitiesResult.content[0]?.text).toBe("No entities found matching those queries.");
    expect(contextResult.content[0]?.text).toBe("No mentions found for this entity.");
    expect(contentResult.content[0]?.text).toBe("File file-alice not found.");
  });
});

import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb, createTestLogger } from "../test-utils";
import { runConnectorSync } from "./sync";

const logger = createTestLogger();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Zoho CRM connector sync integration", () => {
  let db: Kysely<DB> | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  it("stores Zoho CRM records as structured indexed files without creating entities", async () => {
    db = await createTestDb();

    await db
      .insertInto("connector_configs")
      .values({
        id: "zoho-crm-pr3",
        connector_type: "zoho_crm",
        auth_type: "oauth",
        credentials: JSON.stringify({
          type: "oauth",
          access_token: "access-token",
          refresh_token: "refresh-token",
          client_id: "client-id",
          client_secret: "client-secret",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          accounts_server: "https://accounts.zoho.in",
          api_domain: "https://www.zohoapis.in",
          region: "in",
        }),
        created_by: "admin-user",
        scope_config: JSON.stringify({}),
      })
      .execute();

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/settings/modules")) {
        return Promise.resolve(
          jsonResponse({
            modules: [
              { api_name: "Accounts", plural_label: "Accounts", status: "active" },
              { api_name: "Contacts", plural_label: "Contacts", status: "active" },
              { api_name: "Deals", plural_label: "Deals", status: "active" },
            ],
          }),
        );
      }
      if (url.includes("/Accounts?page=1")) {
        expect((init?.headers as Record<string, string>)["If-Modified-Since"]).toBeUndefined();
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "a1",
                Account_Name: "Acme Corp",
                Website: "https://acme.test",
                Industry: "Manufacturing",
                Created_Time: "2026-01-01T00:00:00+05:30",
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: false },
          }),
        );
      }
      if (url.includes("/Contacts?page=1")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "c1",
                Full_Name: "Jane Buyer",
                Email: "jane@acme.test",
                Account_Name: { id: "a1", name: "Acme Corp" },
                Owner: { id: "u1", name: "Owner One", email: "owner@sketch.test" },
                Created_Time: "2026-01-01T00:00:00+05:30",
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: false },
          }),
        );
      }
      if (url.includes("/Deals?page=1")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "d1",
                Deal_Name: "Acme renewal",
                Account_Name: { id: "a1", name: "Acme Corp" },
                Contact_Name: { id: "c1", name: "Jane Buyer" },
                Stage: "Negotiation",
                Amount: 10000,
                Created_Time: "2026-01-01T00:00:00+05:30",
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: false },
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const result = await runConnectorSync(db, "zoho-crm-pr3", logger);

    expect(result).toMatchObject({
      itemsProcessed: 3,
      itemsCreated: 3,
      itemsUpdated: 0,
      itemsArchived: 0,
      errors: [],
    });

    const files = await db
      .selectFrom("indexed_files")
      .select([
        "id",
        "provider_file_id",
        "file_name",
        "file_type",
        "content_category",
        "content",
        "source",
        "source_path",
        "provider_url",
        "source_created_at",
        "source_updated_at",
      ])
      .where("source", "=", "zoho_crm")
      .orderBy("provider_file_id")
      .execute();

    expect(files).toHaveLength(3);
    expect(
      files.map((file) => ({
        providerFileId: file.provider_file_id,
        fileName: file.file_name,
        fileType: file.file_type,
        contentCategory: file.content_category,
        sourcePath: file.source_path,
        providerUrl: file.provider_url,
      })),
    ).toEqual([
      {
        providerFileId: "Accounts:a1",
        fileName: "Acme Corp",
        fileType: "crm_account",
        contentCategory: "structured",
        sourcePath: "Zoho CRM / Zoho in / Accounts",
        providerUrl: null,
      },
      {
        providerFileId: "Contacts:c1",
        fileName: "Jane Buyer",
        fileType: "crm_contact",
        contentCategory: "structured",
        sourcePath: "Zoho CRM / Zoho in / Contacts",
        providerUrl: null,
      },
      {
        providerFileId: "Deals:d1",
        fileName: "Acme renewal",
        fileType: "crm_deal",
        contentCategory: "structured",
        sourcePath: "Zoho CRM / Zoho in / Deals",
        providerUrl: null,
      },
    ]);

    expect(files[2].content).toContain("# Acme renewal (Deals)");
    expect(files[2].content).toContain("Stage: Negotiation");
    expect(files[2].source_created_at).toBe("2026-01-01T00:00:00+05:30");
    expect(files[2].source_updated_at).toBe("2026-01-02T00:00:00+05:30");

    const connectorFiles = await db
      .selectFrom("connector_files")
      .select(["connector_config_id", "indexed_file_id"])
      .where("connector_config_id", "=", "zoho-crm-pr3")
      .execute();
    expect(connectorFiles).toHaveLength(3);

    // This phase ingests CRM records as plain structured files only: no entity
    // graph, so no facts (parent_entity facts that can never resolve are not
    // emitted) and no entities.
    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "subject_source", "subject_source_id", "context_snippet"])
      .where("connector_config_id", "=", "zoho-crm-pr3")
      .execute();
    expect(facts).toEqual([]);

    const entities = await db.selectFrom("entities").select(["id", "name", "source_type"]).execute();
    expect(entities).toEqual([]);

    const config = await db
      .selectFrom("connector_configs")
      .select(["sync_status", "sync_cursor", "last_synced_at"])
      .where("id", "=", "zoho-crm-pr3")
      .executeTakeFirstOrThrow();
    expect(config.sync_status).toBe("active");
    expect(config.sync_cursor).toEqual(expect.any(String));
    expect(config.last_synced_at).toEqual(expect.any(String));
  });
});

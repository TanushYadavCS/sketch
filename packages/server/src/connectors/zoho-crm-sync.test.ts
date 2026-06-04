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

  it("stores Zoho CRM records and materializes CRM entities and relationships", async () => {
    db = await createTestDb();

    await db
      .insertInto("connector_configs")
      .values({
        id: "zoho-crm-pr4",
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
              { api_name: "Accounts", plural_label: "Accounts", status: "visible", api_supported: true },
              { api_name: "Contacts", plural_label: "Contacts", status: "visible", api_supported: true },
              { api_name: "Deals", plural_label: "Deals", status: "visible", api_supported: true },
              { api_name: "Tasks", plural_label: "Tasks", status: "visible", api_supported: true },
            ],
          }),
        );
      }
      if (url.includes("/settings/fields")) {
        return Promise.resolve(
          jsonResponse({
            fields: [
              { api_name: "Account_Name" },
              { api_name: "Deal_Name" },
              { api_name: "Full_Name" },
              { api_name: "Subject" },
              { api_name: "Description" },
              { api_name: "What_Id" },
              { api_name: "Who_Id" },
            ],
          }),
        );
      }
      if (url.includes("/Accounts?")) {
        expect((init?.headers as Record<string, string>)["If-Modified-Since"]).toBeUndefined();
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "a1",
                Account_Name: "Acme Corp",
                Website: "https://www.acme.test/path",
                Email: "billing@finance.acme.test",
                Industry: "Manufacturing",
                Created_Time: "2026-01-01T00:00:00+05:30",
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: false },
          }),
        );
      }
      if (url.includes("/Contacts?")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "c1",
                Full_Name: "Jane Buyer",
                Email: "jane@gmail.com",
                Account_Name: { id: "a1", name: "Acme Corp" },
                Owner: { id: "u1", name: "Owner One" },
                Created_Time: "2026-01-01T00:00:00+05:30",
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: false },
          }),
        );
      }
      if (url.includes("/Deals?")) {
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
      if (url.includes("/Tasks?")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "t1",
                Subject: "Follow up on renewal",
                Status: "Not Started",
                Description: "Confirm renewal paperwork and next meeting date.",
                What_Id: { id: "d1", name: "Acme renewal", $se_module: "Deals" },
                Who_Id: { id: "c1", name: "Jane Buyer", $se_module: "Contacts" },
                Owner: { id: "u1", name: "Owner One" },
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

    const result = await runConnectorSync(db, "zoho-crm-pr4", logger);

    expect(result).toMatchObject({
      itemsProcessed: 4,
      itemsCreated: 4,
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
        "rollup_group_id",
        "provider_url",
        "source_created_at",
        "source_updated_at",
      ])
      .where("source", "=", "zoho_crm")
      .orderBy("provider_file_id")
      .execute();

    expect(files).toHaveLength(4);
    expect(
      files.map((file) => ({
        providerFileId: file.provider_file_id,
        fileName: file.file_name,
        fileType: file.file_type,
        contentCategory: file.content_category,
        sourcePath: file.source_path,
        rollupGroupId: file.rollup_group_id,
        providerUrl: file.provider_url,
      })),
    ).toEqual([
      {
        providerFileId: "Accounts:a1",
        fileName: "Acme Corp",
        fileType: "crm_account",
        contentCategory: "structured",
        sourcePath: "Zoho CRM / Zoho in / Accounts",
        rollupGroupId: "Accounts:a1",
        providerUrl: null,
      },
      {
        providerFileId: "Contacts:c1",
        fileName: "Jane Buyer",
        fileType: "crm_contact",
        contentCategory: "structured",
        sourcePath: "Zoho CRM / Zoho in / Contacts",
        rollupGroupId: "Contacts:c1",
        providerUrl: null,
      },
      {
        providerFileId: "Deals:d1",
        fileName: "Acme renewal",
        fileType: "crm_deal",
        contentCategory: "structured",
        sourcePath: "Zoho CRM / Zoho in / Deals",
        rollupGroupId: "Deals:d1",
        providerUrl: null,
      },
      {
        providerFileId: "Tasks:t1",
        fileName: "Follow up on renewal - Jane Buyer",
        fileType: "crm_task",
        contentCategory: "document",
        sourcePath: "Zoho CRM / Zoho in / Tasks",
        rollupGroupId: "Deals:d1",
        providerUrl: null,
      },
    ]);

    expect(files[2].content).toContain("# Acme renewal (Deals)");
    expect(files[2].content).toContain("Stage: Negotiation");
    expect(files[2].source_created_at).toBe("2026-01-01T00:00:00+05:30");
    expect(files[2].source_updated_at).toBe("2026-01-02T00:00:00+05:30");
    expect(files[3].content).toContain("# Follow up on renewal - Jane Buyer (Tasks)");
    expect(files[3].content).toContain("Status: Not Started");
    expect(files[3].content).toContain("Confirm renewal paperwork and next meeting date.");
    expect(files[3].content).not.toContain("Additional Fields");

    const rollup = await db
      .selectFrom("crm_object_summaries")
      .select(["connector_config_id", "group_id", "summary", "activity_count", "basis_first_at", "basis_last_at"])
      .executeTakeFirstOrThrow();
    expect(rollup).toMatchObject({
      connector_config_id: "zoho-crm-pr4",
      group_id: "Deals:d1",
      activity_count: 1,
      basis_first_at: "2026-01-02T00:00:00+05:30",
      basis_last_at: "2026-01-02T00:00:00+05:30",
    });
    expect(rollup.summary).toContain("Acme renewal has 1 CRM activity");
    expect(rollup.summary).toContain("Follow up on renewal - Jane Buyer");

    const connectorFiles = await db
      .selectFrom("connector_files")
      .select(["connector_config_id", "indexed_file_id"])
      .where("connector_config_id", "=", "zoho-crm-pr4")
      .execute();
    expect(connectorFiles).toHaveLength(4);

    const facts = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "relation", "subject_source", "subject_source_id", "context_snippet"])
      .where("connector_config_id", "=", "zoho-crm-pr4")
      .orderBy("fact_type")
      .orderBy("relation")
      .orderBy("subject_source_id")
      .orderBy("context_snippet")
      .execute();
    expect(facts).toEqual([
      {
        fact_type: "assignee",
        relation: "assigned",
        subject_source: "zoho_crm",
        subject_source_id: "user:u1",
        context_snippet: "Assigned to Owner One",
      },
      {
        fact_type: "crm_relation",
        relation: "deal_for",
        subject_source: "zoho_crm",
        subject_source_id: "Accounts:a1",
        context_snippet: "Deal account",
      },
      {
        fact_type: "crm_relation",
        relation: "primary_contact",
        subject_source: "zoho_crm",
        subject_source_id: "Contacts:c1",
        context_snippet: "Deal primary contact",
      },
      {
        fact_type: "crm_relation",
        relation: "works_at",
        subject_source: "zoho_crm",
        subject_source_id: "Accounts:a1",
        context_snippet: "Contact account",
      },
      {
        fact_type: "parent_entity",
        relation: "mentioned",
        subject_source: "zoho_crm",
        subject_source_id: "Accounts:a1",
        context_snippet: "Contact account",
      },
      {
        fact_type: "parent_entity",
        relation: "mentioned",
        subject_source: "zoho_crm",
        subject_source_id: "Accounts:a1",
        context_snippet: "Deal account",
      },
      {
        fact_type: "parent_entity",
        relation: "mentioned",
        subject_source: "zoho_crm",
        subject_source_id: "Contacts:c1",
        context_snippet: "CRM activity participant",
      },
      {
        fact_type: "parent_entity",
        relation: "mentioned",
        subject_source: "zoho_crm",
        subject_source_id: "Deals:d1",
        context_snippet: "CRM activity parent",
      },
      {
        fact_type: "person_seed",
        relation: "seeded",
        subject_source: "zoho_crm",
        subject_source_id: "Contacts:c1",
        context_snippet: "Zoho CRM / Zoho in / Contacts",
      },
      {
        fact_type: "person_seed",
        relation: "seeded",
        subject_source: "zoho_crm",
        subject_source_id: "Contacts:c1",
        context_snippet: "Zoho CRM / Zoho in / Deals",
      },
      {
        fact_type: "person_seed",
        relation: "seeded",
        subject_source: "zoho_crm",
        subject_source_id: "Contacts:c1",
        context_snippet: "Zoho CRM / Zoho in / Tasks",
      },
      {
        fact_type: "person_seed",
        relation: "seeded",
        subject_source: "zoho_crm",
        subject_source_id: "user:u1",
        context_snippet: "Zoho CRM / Zoho in / Contacts",
      },
      {
        fact_type: "person_seed",
        relation: "seeded",
        subject_source: "zoho_crm",
        subject_source_id: "user:u1",
        context_snippet: "Zoho CRM / Zoho in / Tasks",
      },
      {
        fact_type: "structural_seed",
        relation: "seeded",
        subject_source: "zoho_crm",
        subject_source_id: "Accounts:a1",
        context_snippet: "Zoho CRM / Zoho in / Accounts",
      },
      {
        fact_type: "structural_seed",
        relation: "seeded",
        subject_source: "zoho_crm",
        subject_source_id: "Deals:d1",
        context_snippet: "Zoho CRM / Zoho in / Deals",
      },
    ]);

    const entities = await db
      .selectFrom("entities")
      .select(["name", "source_type", "subtype"])
      .orderBy("source_type")
      .orderBy("name")
      .execute();
    expect(entities).toEqual([
      { name: "Acme Corp", source_type: "company", subtype: null },
      { name: "Acme renewal", source_type: "deal", subtype: null },
      { name: "Jane Buyer", source_type: "person", subtype: "external" },
      { name: "Owner One", source_type: "person", subtype: "internal" },
    ]);

    const relationships = await db
      .selectFrom("entity_relationships")
      .innerJoin("entities as source", "source.id", "entity_relationships.source_entity_id")
      .innerJoin("entities as target", "target.id", "entity_relationships.target_entity_id")
      .select(["source.name as source_name", "target.name as target_name", "entity_relationships.relationship_type"])
      .orderBy("entity_relationships.relationship_type")
      .execute();
    expect(relationships).toEqual([
      { source_name: "Acme renewal", target_name: "Acme Corp", relationship_type: "deal_for" },
      { source_name: "Acme renewal", target_name: "Jane Buyer", relationship_type: "primary_contact" },
      { source_name: "Jane Buyer", target_name: "Acme Corp", relationship_type: "works_at" },
    ]);

    const domains = await db
      .selectFrom("entity_domains")
      .leftJoin("entities", "entities.id", "entity_domains.entity_id")
      .select([
        "entity_domains.domain",
        "entity_domains.kind",
        "entity_domains.source",
        "entity_domains.is_primary",
        "entities.name as entity_name",
      ])
      .where("entity_domains.domain", "in", ["acme.test", "finance.acme.test", "gmail.com"])
      .orderBy("entity_domains.domain")
      .execute();
    expect(domains).toEqual([
      { domain: "acme.test", kind: "corporate", source: "zoho_crm", is_primary: 1, entity_name: "Acme Corp" },
      {
        domain: "finance.acme.test",
        kind: "corporate",
        source: "zoho_crm",
        is_primary: 0,
        entity_name: "Acme Corp",
      },
      { domain: "gmail.com", kind: "personal", source: "manual", is_primary: 0, entity_name: null },
    ]);

    const taskMentions = await db
      .selectFrom("entity_mentions")
      .innerJoin("indexed_files", "indexed_files.id", "entity_mentions.indexed_file_id")
      .innerJoin("entities", "entities.id", "entity_mentions.entity_id")
      .select(["indexed_files.provider_file_id", "entities.name", "entity_mentions.relation", "entity_mentions.source"])
      .where("indexed_files.provider_file_id", "=", "Tasks:t1")
      .orderBy("entity_mentions.relation")
      .orderBy("entities.name")
      .execute();
    expect(taskMentions).toEqual([
      { provider_file_id: "Tasks:t1", name: "Owner One", relation: "assigned", source: "zoho_crm_assignee" },
      { provider_file_id: "Tasks:t1", name: "Acme renewal", relation: "mentioned", source: "zoho_crm_parent_entity" },
      { provider_file_id: "Tasks:t1", name: "Jane Buyer", relation: "mentioned", source: "zoho_crm_parent_entity" },
    ]);

    const config = await db
      .selectFrom("connector_configs")
      .select(["sync_status", "sync_cursor", "last_synced_at"])
      .where("id", "=", "zoho-crm-pr4")
      .executeTakeFirstOrThrow();
    expect(config.sync_status).toBe("active");
    expect(config.sync_cursor).toEqual(expect.any(String));
    expect(config.last_synced_at).toEqual(expect.any(String));
  });

  it("force-requests parent-relation fields even when Zoho field discovery omits them", async () => {
    db = await createTestDb();

    await db
      .insertInto("connector_configs")
      .values({
        id: "zoho-crm-rel",
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

    const fieldsByModule: Record<string, string> = {};

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith("/settings/modules")) {
        return Promise.resolve(
          jsonResponse({
            modules: [
              { api_name: "Contacts", plural_label: "Contacts", status: "visible", api_supported: true },
              { api_name: "Calls", plural_label: "Calls", status: "visible", api_supported: true },
              { api_name: "Notes", plural_label: "Notes", status: "visible", api_supported: true },
            ],
          }),
        );
      }
      if (path.includes("/settings/fields")) {
        // Real Zoho discovery for Calls/Notes does NOT surface What_Id/Who_Id/Parent_Id.
        return Promise.resolve(
          jsonResponse({ fields: [{ api_name: "Subject" }, { api_name: "Note_Title" }, { api_name: "Description" }] }),
        );
      }
      const moduleMatch = path.match(/\/crm\/v\d+\/(\w+)$/);
      if (moduleMatch) {
        const moduleName = moduleMatch[1];
        fieldsByModule[moduleName] = url.searchParams.get("fields") ?? "";
        const data: Record<string, unknown>[] =
          moduleName === "Contacts"
            ? [
                {
                  id: "c1",
                  Full_Name: "Jane Buyer",
                  Created_Time: "2026-01-01T00:00:00+05:30",
                  Modified_Time: "2026-01-02T00:00:00+05:30",
                },
              ]
            : moduleName === "Calls"
              ? [
                  {
                    id: "call1",
                    Subject: "Intro call",
                    Who_Id: { id: "c1", name: "Jane Buyer", $se_module: "Contacts" },
                    Created_Time: "2026-01-03T00:00:00+05:30",
                    Modified_Time: "2026-01-03T00:00:00+05:30",
                  },
                ]
              : [
                  {
                    id: "note1",
                    Note_Title: "Met at conference",
                    Description: "Discussed renewal timing and budget.",
                    Parent_Id: { id: "c1", name: "Jane Buyer", $se_module: "Contacts" },
                    Created_Time: "2026-01-04T00:00:00+05:30",
                    Modified_Time: "2026-01-04T00:00:00+05:30",
                  },
                ];
        return Promise.resolve(jsonResponse({ data, info: { more_records: false } }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    await runConnectorSync(db, "zoho-crm-rel", logger);

    // The fix: relation lookups are force-requested despite discovery omitting them.
    expect(fieldsByModule.Calls).toContain("What_Id");
    expect(fieldsByModule.Calls).toContain("Who_Id");
    expect(fieldsByModule.Notes).toContain("Parent_Id");

    // And so the activities resolve a rollup group pointing at their parent contact.
    const rows = await db
      .selectFrom("indexed_files")
      .select(["provider_file_id", "rollup_group_id"])
      .where("source", "=", "zoho_crm")
      .where("provider_file_id", "in", ["Calls:call1", "Notes:note1"])
      .orderBy("provider_file_id")
      .execute();
    expect(rows).toEqual([
      { provider_file_id: "Calls:call1", rollup_group_id: "Contacts:c1" },
      { provider_file_id: "Notes:note1", rollup_group_id: "Contacts:c1" },
    ]);
  });
});

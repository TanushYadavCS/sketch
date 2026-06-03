import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredentials } from "./types";
import {
  createZohoCrmConnector,
  discoverStandardModules,
  extractAccountDomainsFromRecord,
  extractParentEntities,
  extractPeopleFromRecord,
  formatCrmRecordContent,
  makeProviderFileId,
  moduleToFileType,
} from "./zoho-crm";

const logger = pino({ level: "silent" });

function credentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return {
    type: "oauth",
    access_token: "access-token",
    refresh_token: "refresh-token",
    client_id: "client-id",
    client_secret: "client-secret",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    accounts_server: "https://accounts.zoho.in",
    api_domain: "https://www.zohoapis.in",
    region: "in",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Zoho CRM connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses module-qualified provider file IDs and stable crm file types", () => {
    expect(makeProviderFileId("Contacts", "123")).toBe("Contacts:123");
    expect(moduleToFileType("Contacts")).toBe("crm_contact");
    expect(moduleToFileType("Custom_Module")).toBe("crm_custom_module");
  });

  it("validateCredentials succeeds on current user response and fails on revoked token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ users: [{ id: "u1" }] }));
    const connector = createZohoCrmConnector();

    await expect(connector.validateCredentials(credentials())).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.zohoapis.in/crm/v6/users?type=CurrentUser",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Zoho-oauthtoken access-token" }),
      }),
    );

    fetchSpy.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await expect(connector.validateCredentials(credentials())).rejects.toThrow(/reconnect required/i);
  });

  it("refreshTokens skips fresh tokens and refreshes expired tokens by region account server", async () => {
    const connector = createZohoCrmConnector();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(connector.refreshTokens?.(credentials())).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ access_token: "new-token", expires_in: 3600, api_domain: "https://www.zohoapis.in" }),
    );

    const result = await connector.refreshTokens?.(
      credentials({ expires_at: new Date(Date.now() - 60 * 1000).toISOString() }),
    );

    expect(result?.access_token).toBe("new-token");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://accounts.zoho.in/oauth/v2/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("discovers standard modules, skips inactive modules, and keeps parent-like order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        modules: [
          { api_name: "Deals", plural_label: "Deals", status: "visible", api_supported: true, viewable: true },
          { api_name: "Contacts", plural_label: "Contacts", status: "visible", api_supported: true, viewable: true },
          { api_name: "Accounts", plural_label: "Accounts", status: "visible", api_supported: true, viewable: true },
          // Not reachable via the records API → must be skipped.
          { api_name: "Meetings", plural_label: "Meetings", status: "visible", api_supported: false, viewable: true },
          // User-hidden standard module → must be skipped.
          { api_name: "Leads", plural_label: "Leads", status: "user_hidden", api_supported: true, viewable: true },
          { api_name: "Events", plural_label: "Meetings", status: "visible", api_supported: true, viewable: true },
          { api_name: "CustomThings", plural_label: "Custom Things", status: "visible", api_supported: true },
        ],
      }),
    );

    const modules = await discoverStandardModules(credentials(), logger);

    expect(modules.map((module) => module.apiName)).toEqual(["Accounts", "Contacts", "Deals", "Events"]);
  });

  it("formats structured content without dumping raw JSON", () => {
    const content = formatCrmRecordContent("Deals", {
      id: "d1",
      Deal_Name: "Acme renewal",
      Stage: "Negotiation",
      Amount: 10000,
      Account_Name: { id: "a1", name: "Acme Corp" },
      Owner: { id: "u1", name: "Jane Owner" },
      Description: "Renewal for Q3",
      $approval: { delegate: false },
    });

    expect(content).toContain("# Acme renewal (Deals)");
    expect(content).toContain("Stage: Negotiation");
    expect(content).toContain("Account Name: Acme Corp");
    expect(content).toContain("Renewal for Q3");
    expect(content).not.toContain("$approval");
    expect(content).not.toContain("{");
  });

  it("formats CRM activities with curated metadata and relation-aware names", () => {
    const task = formatCrmRecordContent("Tasks", {
      id: "t1",
      Subject: "Need to call",
      Status: "Completed",
      Priority: "High",
      Due_Date: "2026-01-10",
      What_Id: { id: "d1", name: "Acme renewal", $se_module: "Deals" },
      Who_Id: { id: "c1", name: "Jane Buyer", $se_module: "Contacts" },
      Owner: { id: "u1", name: "Owner One" },
      Description: "Discuss renewal timeline.",
      Send_Notification_Email: true,
      Modified_By: { id: "u2", name: "System User" },
      Last_Activity_Time: "2026-01-11T00:00:00+05:30",
    });

    expect(task).toContain("# Need to call - Jane Buyer (Tasks)");
    expect(task).toContain("Status: Completed | Priority: High | Due: 2026-01-10");
    expect(task).toContain("Related: Acme renewal | Contact: Jane Buyer");
    expect(task).toContain("Discuss renewal timeline.");
    expect(task).not.toContain("Additional Fields");
    expect(task).not.toContain("Send Notification Email");
    expect(task).not.toContain("Modified By");
    expect(task).not.toContain("Last Activity Time");

    const call = formatCrmRecordContent("Calls", {
      id: "call1",
      Subject: "Outgoing call to Jane Buyer",
      Who_Id: { id: "c1", name: "Jane Buyer", $se_module: "Contacts" },
    });
    expect(call).toContain("# Outgoing call to Jane Buyer (Calls)");
    expect(call).not.toContain("Outgoing call to Jane Buyer - Jane Buyer");
  });

  it("extracts parent entities for deals, contacts, and CRM activities", () => {
    expect(extractParentEntities("Deals", { id: "d1", Account_Name: { id: "a1", name: "Acme" } })).toEqual([
      { source: "zoho_crm", sourceId: "Accounts:a1", contextSnippet: "Deal account" },
    ]);
    expect(extractParentEntities("Contacts", { id: "c1", Account_Name: { id: "a1", name: "Acme" } })).toEqual([
      { source: "zoho_crm", sourceId: "Accounts:a1", contextSnippet: "Contact account" },
    ]);
    expect(
      extractParentEntities("Tasks", {
        id: "t1",
        What_Id: { id: "d1", name: "Acme renewal", $se_module: "Deals" },
        Who_Id: { id: "c1", name: "Jane Buyer", $se_module: "Contacts" },
      }),
    ).toEqual([
      { source: "zoho_crm", sourceId: "Deals:d1", contextSnippet: "CRM activity parent" },
      { source: "zoho_crm", sourceId: "Contacts:c1", contextSnippet: "CRM activity participant" },
    ]);
  });

  it("extracts Account domains from websites and Account email fields", () => {
    expect(
      extractAccountDomainsFromRecord({
        id: "a1",
        Account_Name: "Acme Corp",
        Website: "https://www.acme.com/path",
        Email: "billing@finance.acme.com",
      }),
    ).toEqual(["acme.com", "finance.acme.com"]);
    expect(
      extractAccountDomainsFromRecord({
        id: "a2",
        Account_Name: "Personal Account",
        Website: "gmail.com/about",
      }),
    ).toEqual(["gmail.com"]);
  });

  it("extracts owner, contact, and lead people without wiring them into PR3 sync", () => {
    expect(
      extractPeopleFromRecord("Contacts", {
        id: "c1",
        Full_Name: "Jane Buyer",
        Email: "jane@acme.test",
        Owner: { id: "u1", name: "Owner One", email: "owner@sketch.test" },
      }),
    ).toEqual([
      {
        name: "Owner One",
        email: "owner@sketch.test",
        subtype: "internal",
        source: "zoho_crm",
        sourceId: "user:u1",
      },
      {
        name: "Jane Buyer",
        email: "jane@acme.test",
        subtype: "external",
        source: "zoho_crm",
        sourceId: "Contacts:c1",
      },
    ]);
    expect(extractPeopleFromRecord("Deals", { id: "d1", Contact_Name: { id: "c1", name: "Jane Buyer" } })).toEqual([
      {
        name: "Jane Buyer",
        email: undefined,
        subtype: "external",
        source: "zoho_crm",
        sourceId: "Contacts:c1",
      },
    ]);
  });

  it("syncs paginated standard modules with If-Modified-Since and CRM graph hints", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/settings/modules")) {
        return Promise.resolve(
          jsonResponse({
            modules: [
              { api_name: "Accounts", plural_label: "Accounts", status: "visible", api_supported: true },
              { api_name: "Contacts", plural_label: "Contacts", status: "visible", api_supported: true },
              { api_name: "Deals", plural_label: "Deals", status: "visible", api_supported: true },
              { api_name: "Tasks", plural_label: "Tasks", status: "visible", api_supported: true },
              { api_name: "Notes", plural_label: "Notes", status: "visible", api_supported: true },
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
              { api_name: "Note_Content" },
              { api_name: "Parent_Id" },
              { api_name: "What_Id" },
              { api_name: "Who_Id" },
            ],
          }),
        );
      }
      if (url.includes("/Accounts?")) {
        expect(url).toContain("fields=");
        expect((init?.headers as Record<string, string>)["If-Modified-Since"]).toBe("2026-01-01T00:00:00.000Z");
        // Second page (token-based) returns empty to end pagination.
        if (url.includes("page_token=")) {
          return Promise.resolve(jsonResponse({ data: [], info: { more_records: false } }));
        }
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "a1",
                Account_Name: "Acme Corp",
                Website: "https://acme.test",
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: true, next_page_token: "accounts-page-2" },
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
                Email: "jane@acme.test",
                Account_Name: { id: "a1", name: "Acme Corp" },
                Owner: { id: "u1", name: "Owner One", email: "owner@sketch.test" },
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
                Description: "Structured deal description stays structured.",
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
                What_Id: { id: "d1", name: "Acme renewal", $se_module: "Deals" },
                Who_Id: { id: "c1", name: "Jane Buyer", $se_module: "Contacts" },
                Owner: { id: "u1", name: "Owner One", email: "owner@sketch.test" },
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: false },
          }),
        );
      }
      if (url.includes("/Notes?")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "n1",
                Note_Title: "Renewal context",
                Note_Content: "Jane prefers annual billing with quarterly reviews.",
                Parent_Id: { id: "d1", name: "Acme renewal", $se_module: "Deals" },
                Modified_Time: "2026-01-02T00:00:00+05:30",
              },
            ],
            info: { more_records: false },
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const connector = createZohoCrmConnector();
    const items = [];

    for await (const item of connector.sync({
      credentials: credentials(),
      scopeConfig: {},
      cursor: "2026-01-01T00:00:00.000Z",
      logger,
    })) {
      items.push(item);
    }

    expect(items.map((item) => item.providerFileId)).toEqual([
      "Accounts:a1",
      "Contacts:c1",
      "Deals:d1",
      "Tasks:t1",
      "Notes:n1",
    ]);
    expect(items[0]).toMatchObject({
      fileType: "crm_account",
      contentCategory: "structured",
      sourcePath: "Zoho CRM / Zoho in / Accounts",
      rollupGroupId: "Accounts:a1",
    });
    expect(items[2]).toMatchObject({ fileType: "crm_deal", contentCategory: "structured", rollupGroupId: "Deals:d1" });
    expect(items[1].parentEntities).toEqual([
      { source: "zoho_crm", sourceId: "Accounts:a1", contextSnippet: "Contact account" },
    ]);
    expect(items[2].relationships?.map((relationship) => relationship.relationType)).toEqual([
      "deal_for",
      "primary_contact",
    ]);
    expect(items[3]).toMatchObject({
      fileType: "crm_task",
      fileName: "Follow up on renewal - Jane Buyer",
      contentCategory: "structured",
      rollupGroupId: "Deals:d1",
      parentEntities: [
        { source: "zoho_crm", sourceId: "Deals:d1", contextSnippet: "CRM activity parent" },
        { source: "zoho_crm", sourceId: "Contacts:c1", contextSnippet: "CRM activity participant" },
      ],
      assignees: [{ name: "Owner One", email: "owner@sketch.test", source: "zoho_crm", sourceId: "user:u1" }],
    });
    expect(items[4]).toMatchObject({
      fileType: "crm_note",
      fileName: "Renewal context - Acme renewal",
      contentCategory: "document",
      rollupGroupId: "Deals:d1",
      parentEntities: [{ source: "zoho_crm", sourceId: "Deals:d1", contextSnippet: "CRM note parent" }],
    });
    expect(items[4].content).toContain("Jane prefers annual billing with quarterly reviews.");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("treats a 304 Not Modified module response as no records without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/settings/modules")) {
        return Promise.resolve(
          jsonResponse({
            modules: [{ api_name: "Accounts", plural_label: "Accounts", status: "visible", api_supported: true }],
          }),
        );
      }
      if (url.includes("/settings/fields")) {
        return Promise.resolve(jsonResponse({ fields: [{ api_name: "Account_Name" }] }));
      }
      if (url.includes("/Accounts?")) {
        return Promise.resolve(new Response(null, { status: 304 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const connector = createZohoCrmConnector();
    const items = [];
    for await (const item of connector.sync({
      credentials: credentials(),
      scopeConfig: {},
      cursor: "2026-01-01T00:00:00.000Z",
      logger,
    })) {
      items.push(item);
    }

    expect(items).toEqual([]);
  });
});

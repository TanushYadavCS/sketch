import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../api/auth";
import { generateApiToken, getApiTokenDisplayPrefix, hashApiToken } from "../../auth/api-token";
import { signJwt } from "../../auth/jwt";
import { createApiTokenRepository } from "../../db/repositories/api-tokens";
import { createSettingsRepository } from "../../db/repositories/settings";
import { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import { createApp } from "../../http";
import { createTestConfig, createTestDb, createTestLogger } from "../../test-utils";

let db: Kysely<DB>;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.destroy();
});

async function createPat(authRole: "admin" | "member" = "member", email = `${randomUUID()}@example.com`) {
  const settings = createSettingsRepository(db);
  await settings.ensure();
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const users = createUserRepository(db);
  const user = await users.create({ name: `MCP ${authRole}`, email, emailVerified: true, authRole });
  const plaintext = generateApiToken();
  await createApiTokenRepository(db).create({
    userId: user.id,
    name: "Claude Code",
    tokenHash: hashApiToken(plaintext),
    prefix: getApiTokenDisplayPrefix(plaintext),
  });
  const row = await settings.get();
  if (!row?.jwt_secret) throw new Error("test settings missing jwt secret");
  const cookie = `${SESSION_COOKIE}=${await signJwt(user.id, authRole, row.jwt_secret)}`;
  return { token: plaintext, user, cookie };
}

function mcpHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-03-26",
  };
}

async function toolsList(app: ReturnType<typeof createApp>, token: string, path = "/mcp/curation") {
  return app.request(path, {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

async function callTool(app: ReturnType<typeof createApp>, token: string, name: string, args: Record<string, unknown>) {
  const res = await app.request("/mcp/curation", {
    method: "POST",
    headers: mcpHeaders(token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: Array<{ type: "text"; text: string }> } };
  return JSON.parse(body.result.content[0]?.text ?? "null") as unknown;
}

function apiHeaders(cookie: string) {
  return {
    Cookie: cookie,
    "Content-Type": "application/json",
  };
}

async function apiPost(
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
  body?: Record<string, unknown>,
) {
  return app.request(path, {
    method: "POST",
    headers: apiHeaders(cookie),
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function approveGraphVerdict(app: ReturnType<typeof createApp>, cookie: string, id: string) {
  const res = await apiPost(app, cookie, `/api/graph-verdicts/${id}/approval`);
  expect(res.status).toBe(200);
  return (await res.json()) as { verdict: { id: string; status: string } };
}

async function seedConnector(id: string, createdBy: string) {
  await db
    .insertInto("connector_configs")
    .values({
      id,
      connector_type: "test",
      auth_type: "none",
      credentials: "{}",
      created_by: createdBy,
    })
    .execute();
}

async function seedFile(input: { id: string; connectorId: string; name?: string; syncedAt?: string }) {
  await db
    .insertInto("indexed_files")
    .values({
      id: input.id,
      connector_config_id: input.connectorId,
      provider_file_id: input.id,
      file_name: input.name ?? input.id,
      content_category: "message",
      source: "test",
      synced_at: input.syncedAt ?? "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedEntity(input: {
  id: string;
  name: string;
  sourceType: string;
  sourceRefId?: string | null;
  deletedAt?: string | null;
  mergedIntoEntityId?: string | null;
}) {
  await db
    .insertInto("entities")
    .values({
      id: input.id,
      name: input.name,
      source_type: input.sourceType,
      source_ref_id: input.sourceRefId ?? null,
      aliases: "[]",
      status: "active",
      hotness: 0,
      created_at: "2026-08-22T00:00:00.000Z",
      updated_at: "2026-08-22T00:00:00.000Z",
      deleted_at: input.deletedAt ?? null,
      merged_into_entity_id: input.mergedIntoEntityId ?? null,
    })
    .execute();
}

async function seedMention(entityId: string, fileId: string, snippet = `${entityId} evidence`) {
  await db
    .insertInto("entity_mentions")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      indexed_file_id: fileId,
      context_snippet: snippet,
      confidence: "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
      mentioned_at: "2026-08-22T00:00:00.000Z",
    })
    .execute();
}

async function seedContactPoint(entityId: string, value: string) {
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: entityId,
      kind: "email",
      value,
      source: "test",
    })
    .execute();
}

async function seedWorksAt(input: {
  personId: string;
  companyId: string;
  source: string;
  validTo?: string | null;
  confidence?: string;
}) {
  await db
    .insertInto("entity_relationships")
    .values({
      id: randomUUID(),
      source_entity_id: input.personId,
      target_entity_id: input.companyId,
      relationship_type: "works_at",
      confidence: input.confidence ?? "CONFIRMED",
      confidence_score: 1,
      source: input.source,
      valid_to: input.validTo ?? null,
    })
    .execute();
}

type SharedEvidenceResponse = {
  sharedFiles: { count: number; files: Array<{ id: string; name: string }> };
  pairwiseSharedFiles: Array<{ entityIds: [string, string]; sharedFileCount: number }>;
  coAttendeeFiles?: number;
  coCorrespondentFiles?: number;
  sharedContactPoints?: Array<{ kind: string; value: string; count: number }>;
  sharedCorporateDomains?: Array<{ domain: string; kind: string; count: number }>;
};

describe("curation MCP server", () => {
  it("keeps the curation mount absent when disabled and admin-only when enabled", async () => {
    const disabledApp = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: false }), {
      logger: createTestLogger(),
    });
    const disabledRes = await disabledApp.request("/mcp/curation", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(disabledRes.status).toBe(404);

    const member = await createPat("member", "member@example.com");
    const admin = await createPat("admin", "admin@example.com");
    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const memberCuration = await toolsList(app, member.token);
    expect(memberCuration.status).toBe(403);

    const memberPublic = await toolsList(app, member.token, "/mcp");
    expect(memberPublic.status).toBe(200);

    const adminList = await toolsList(app, admin.token);
    expect(adminList.status).toBe(200);
    const body = (await adminList.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "curation_company_dominance",
      "curation_entity_evidence",
      "curation_find_entities",
      "curation_graph_overview",
      "curation_list_affiliations",
      "curation_list_candidates",
      "curation_shared_evidence",
      "propose_graph_verdicts",
    ]);
  });

  it("returns unfiltered live evidence and tombstone redirect evidence", async () => {
    const admin = await createPat("admin", "curator@example.com");
    const other = await createUserRepository(db).create({
      name: "Other User",
      email: "other@example.com",
      emailVerified: true,
      authRole: "member",
    });
    await seedConnector("other-connector", other.id);
    await seedFile({ id: "cross-viewer-file", connectorId: "other-connector", name: "Other User File" });
    await seedEntity({ id: "company-live", name: "Acme", sourceType: "company" });
    await seedEntity({ id: "person-live", name: "Ada", sourceType: "person" });
    await seedEntity({
      id: "person-duplicate",
      name: "Ada Duplicate",
      sourceType: "person",
      deletedAt: "2026-08-22T01:00:00.000Z",
      mergedIntoEntityId: "person-live",
    });
    await seedMention("person-live", "cross-viewer-file", "Ada appears in another user's connector file.");
    await seedWorksAt({
      personId: "person-live",
      companyId: "company-live",
      source: "declared",
      validTo: "2026-08-21T00:00:00.000Z",
    });
    await db
      .insertInto("entity_relationships")
      .values({
        id: randomUUID(),
        source_entity_id: "person-live",
        target_entity_id: "company-live",
        relationship_type: "engaged_with",
        confidence: "EXTRACTED",
        confidence_score: 0.7,
        source: "llm_extraction",
      })
      .execute();

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const evidence = (await callTool(app, admin.token, "curation_entity_evidence", {
      entityId: "person-live",
      mentionLimit: 1,
    })) as {
      mentionStats: { returned: number; limit: number };
      mentions: Array<{ fileId: string; fileName: string; contextSnippet: string }>;
      relationships: { outgoing: Array<{ relationshipType: string; source: string; expired: boolean }> };
    };
    expect(evidence.mentionStats).toMatchObject({ returned: 1, limit: 1 });
    expect(evidence.mentions[0]).toMatchObject({ fileId: "cross-viewer-file", fileName: "Other User File" });
    expect(evidence.relationships.outgoing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationshipType: "works_at", source: "declared", expired: true }),
        expect.objectContaining({ relationshipType: "engaged_with", source: "llm_extraction", expired: false }),
      ]),
    );

    const tombstone = (await callTool(app, admin.token, "curation_entity_evidence", {
      entityId: "person-duplicate",
    })) as { entity: { id: string; tombstone: { mergedInto: { id: string; name: string } } } };
    expect(tombstone.entity).toMatchObject({
      id: "person-duplicate",
      tombstone: { mergedInto: { id: "person-live", name: "Ada" } },
    });
  });

  it("keeps sharedFiles as the all-entity intersection while pairwiseSharedFiles reports pair overlap", async () => {
    const admin = await createPat("admin", "shared-overlap@example.com");
    await seedConnector("shared-overlap-connector", admin.user.id);
    await seedEntity({ id: "shared-a", name: "Shared A", sourceType: "project" });
    await seedEntity({ id: "shared-b", name: "Shared B", sourceType: "project" });
    await seedEntity({ id: "shared-c", name: "Shared C", sourceType: "project" });
    await seedFile({ id: "shared-ab-1", connectorId: "shared-overlap-connector", name: "Shared AB 1" });
    await seedFile({ id: "shared-ab-2", connectorId: "shared-overlap-connector", name: "Shared AB 2" });
    await seedFile({ id: "shared-c-only", connectorId: "shared-overlap-connector", name: "Shared C Only" });
    await seedMention("shared-a", "shared-ab-1");
    await seedMention("shared-b", "shared-ab-1");
    await seedMention("shared-a", "shared-ab-2");
    await seedMention("shared-b", "shared-ab-2");
    await seedMention("shared-c", "shared-c-only");

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const result = (await callTool(app, admin.token, "curation_shared_evidence", {
      entityIds: ["shared-a", "shared-b", "shared-c"],
    })) as SharedEvidenceResponse;
    const abPair = result.pairwiseSharedFiles.find((pair) => pair.entityIds.join("|") === "shared-a|shared-b");

    expect(result.sharedFiles).toEqual({ count: 0, files: [] });
    expect(abPair).toMatchObject({ entityIds: ["shared-a", "shared-b"], sharedFileCount: 2 });
  });

  it("returns exactly one pairwiseSharedFiles entry per unordered pair", async () => {
    const admin = await createPat("admin", "pairwise-coverage@example.com");
    await seedEntity({ id: "pairwise-a", name: "Pairwise A", sourceType: "project" });
    await seedEntity({ id: "pairwise-b", name: "Pairwise B", sourceType: "project" });
    await seedEntity({ id: "pairwise-c", name: "Pairwise C", sourceType: "project" });

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const result = (await callTool(app, admin.token, "curation_shared_evidence", {
      entityIds: ["pairwise-a", "pairwise-b", "pairwise-c"],
    })) as SharedEvidenceResponse;
    const pairKeys = result.pairwiseSharedFiles.map((pair) => pair.entityIds.join("|")).sort();

    expect(result.pairwiseSharedFiles).toHaveLength(3);
    expect(new Set(pairKeys).size).toBe(3);
    expect(pairKeys).toEqual(["pairwise-a|pairwise-b", "pairwise-a|pairwise-c", "pairwise-b|pairwise-c"]);
  });

  it("gates shared evidence person and domain fields by homogeneous input types", async () => {
    const admin = await createPat("admin", "shared-gating@example.com");
    await seedEntity({ id: "gate-person-a", name: "Gate Person A", sourceType: "person" });
    await seedEntity({ id: "gate-person-b", name: "Gate Person B", sourceType: "person" });
    await seedEntity({ id: "gate-project-a", name: "Gate Project A", sourceType: "project" });
    await seedEntity({ id: "gate-project-b", name: "Gate Project B", sourceType: "project" });
    await seedContactPoint("gate-person-a", "shared-gate@example.com");
    await seedContactPoint("gate-person-b", "shared-gate@example.com");

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const allPerson = (await callTool(app, admin.token, "curation_shared_evidence", {
      entityIds: ["gate-person-a", "gate-person-b"],
    })) as SharedEvidenceResponse;
    const mixed = (await callTool(app, admin.token, "curation_shared_evidence", {
      entityIds: ["gate-person-a", "gate-project-a"],
    })) as SharedEvidenceResponse;
    const projectOnly = (await callTool(app, admin.token, "curation_shared_evidence", {
      entityIds: ["gate-project-a", "gate-project-b"],
    })) as SharedEvidenceResponse;

    expect(allPerson).toEqual(
      expect.objectContaining({
        coAttendeeFiles: expect.any(Number),
        coCorrespondentFiles: expect.any(Number),
        sharedContactPoints: [{ kind: "email", value: "shared-gate@example.com", count: 2 }],
      }),
    );
    expect(mixed).not.toHaveProperty("coAttendeeFiles");
    expect(mixed).not.toHaveProperty("coCorrespondentFiles");
    expect(mixed).not.toHaveProperty("sharedContactPoints");
    expect(mixed).not.toHaveProperty("sharedCorporateDomains");
    expect(projectOnly).not.toHaveProperty("coAttendeeFiles");
    expect(projectOnly).not.toHaveProperty("coCorrespondentFiles");
    expect(projectOnly).not.toHaveProperty("sharedContactPoints");
    expect(projectOnly).not.toHaveProperty("sharedCorporateDomains");
  });

  it("computes company dominance from exact mention and participant-affiliation file counts", async () => {
    const admin = await createPat("admin", "dominance@example.com");
    await seedConnector("dominance-connector", admin.user.id);
    await seedEntity({ id: "project", name: "Project X", sourceType: "project" });
    await seedEntity({ id: "company-a", name: "Company A", sourceType: "company" });
    await seedEntity({ id: "company-b", name: "Company B", sourceType: "company" });
    await seedEntity({ id: "person-a-live", name: "Person A Live", sourceType: "person" });
    await seedEntity({ id: "person-a-expired", name: "Person A Expired", sourceType: "person" });
    await seedContactPoint("person-a-live", "person-a-live@example.com");
    await seedContactPoint("person-a-expired", "person-a-expired@example.com");
    await seedWorksAt({ personId: "person-a-live", companyId: "company-a", source: "declared" });
    await seedWorksAt({
      personId: "person-a-expired",
      companyId: "company-a",
      source: "declared",
      validTo: "2026-08-21T00:00:00.000Z",
    });

    for (let i = 1; i <= 10; i += 1) {
      const fileId = `dominance-file-${i}`;
      await seedFile({ id: fileId, connectorId: "dominance-connector", name: `Dominance File ${i}` });
      await seedMention("project", fileId);
      await seedMention(i <= 8 ? "company-a" : "company-b", fileId);
      if (i <= 6) {
        const personEmail = i === 6 ? "person-a-expired@example.com" : "person-a-live@example.com";
        await db
          .insertInto("indexed_file_facts")
          .values({
            id: randomUUID(),
            indexed_file_id: fileId,
            connector_config_id: "dominance-connector",
            created_by_user_id: admin.user.id,
            source: "test",
            fact_type: i % 2 === 0 ? "correspondent" : "attendee",
            relation: i % 2 === 0 ? "corresponded" : "attended",
            subject_name: `Person ${i}`,
            subject_email: personEmail,
            fact_key: `fact-${i}`,
          })
          .execute();
      }
    }

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const result = (await callTool(app, admin.token, "curation_company_dominance", { projectId: "project" })) as {
      totalFiles: number;
      companies: Array<{ companyId: string; mentionFiles: number; affiliationFiles: number; totalFiles: number }>;
    };
    expect(result.totalFiles).toBe(10);
    expect(result.companies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ companyId: "company-a", mentionFiles: 8, affiliationFiles: 5, totalFiles: 10 }),
        expect.objectContaining({ companyId: "company-b", mentionFiles: 2, affiliationFiles: 0, totalFiles: 10 }),
      ]),
    );
  });

  it("stores a valid proposal as validated without applying graph changes", async () => {
    const admin = await createPat("admin", "proposal-valid@example.com");
    await seedEntity({ id: "project-source", name: "Project Source", sourceType: "project" });
    await seedEntity({ id: "project-target", name: "Project Target", sourceType: "project" });
    const before = await db.selectFrom("entities").selectAll().where("id", "=", "project-source").executeTakeFirst();

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const result = (await callTool(app, admin.token, "propose_graph_verdicts", {
      note: "merge duplicate project",
      verdicts: [
        {
          action: "merge_into",
          subjectEntityId: "project-source",
          targetEntityId: "project-target",
          reason: "The source duplicates the target project.",
          evidence: { fileIds: ["file-b", "file-a"], reviewIds: ["review-a"], notes: ["same project"] },
        },
      ],
    })) as {
      runId: string;
      stored: number;
      bounced: number;
      results: Array<{ verdictId: string; validationStatus: string; validationReason: string | null }>;
    };

    expect(result).toMatchObject({ stored: 1, bounced: 0 });
    expect(result.results[0]).toMatchObject({ validationStatus: "ok", validationReason: null });
    const row = await db
      .selectFrom("graph_verdicts")
      .selectAll()
      .where("id", "=", result.results[0]?.verdictId ?? "")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      run_id: result.runId,
      action: "merge_into",
      subject_entity_id: "project-source",
      target_entity_id: "project-target",
      validation_status: "ok",
      validation_reason: null,
      status: "awaiting_human",
    });
    expect(row.evidence_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(row.would_change_json ? JSON.parse(row.would_change_json) : null).toMatchObject({
      entities: 2,
      entity_merges: 1,
    });
    const after = await db.selectFrom("entities").selectAll().where("id", "=", "project-source").executeTakeFirst();
    expect(after).toEqual(before);
  });

  it("stores bad subject proposals as bounced fail-closed rows", async () => {
    const admin = await createPat("admin", "proposal-bounce@example.com");
    await seedEntity({ id: "merged-target", name: "Merged Target", sourceType: "project" });
    await seedEntity({
      id: "merged-source",
      name: "Merged Source",
      sourceType: "project",
      mergedIntoEntityId: "merged-target",
    });

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const result = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "archive",
          subjectEntityId: "merged-source",
          reason: "Merged projects should not be archived from this proposal.",
        },
        {
          action: "archive",
          subjectEntityId: "missing-project",
          reason: "This project does not exist.",
        },
      ],
    })) as {
      stored: number;
      bounced: number;
      results: Array<{ verdictId: string; validationStatus: string; validationReason: string | null }>;
    };

    expect(result).toMatchObject({ stored: 0, bounced: 2 });
    expect(result.results.map((row) => row.validationReason)).toEqual(["source_not_live_project", "subject_not_found"]);
    const rows = await db
      .selectFrom("graph_verdicts")
      .selectAll()
      .where(
        "id",
        "in",
        result.results.map((row) => row.verdictId),
      )
      .orderBy("subject_entity_id", "asc")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject_entity_id: "merged-source",
          validation_status: "failed",
          validation_reason: "source_not_live_project",
          status: "bounced",
        }),
        expect.objectContaining({
          subject_entity_id: "missing-project",
          subject_name: null,
          subject_entity_type: null,
          validation_status: "failed",
          validation_reason: "subject_not_found",
          status: "bounced",
        }),
      ]),
    );
  });

  it("supersedes awaiting verdicts only for the same subject and action pair", async () => {
    const admin = await createPat("admin", "proposal-supersede@example.com");
    await seedEntity({ id: "scope-source", name: "Scope Source", sourceType: "project" });
    await seedEntity({ id: "scope-target", name: "Scope Target", sourceType: "project" });

    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true, DEV_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });
    const first = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "merge_into",
          subjectEntityId: "scope-source",
          targetEntityId: "scope-target",
          reason: "First merge proposal.",
        },
      ],
    })) as { results: Array<{ verdictId: string }> };
    const second = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "merge_into",
          subjectEntityId: "scope-source",
          targetEntityId: "scope-target",
          reason: "Second merge proposal.",
        },
      ],
    })) as { results: Array<{ verdictId: string }> };
    const third = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "archive",
          subjectEntityId: "scope-source",
          reason: "Archive is a separate action proposal.",
        },
      ],
    })) as { results: Array<{ verdictId: string }> };
    await approveGraphVerdict(app, admin.cookie, second.results[0]?.verdictId ?? "");
    const fourth = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "merge_into",
          subjectEntityId: "scope-source",
          targetEntityId: "scope-target",
          reason: "Approved merge remains active.",
        },
      ],
    })) as { results: Array<{ verdictId: string }> };

    const rows = await db
      .selectFrom("graph_verdicts")
      .select(["id", "action", "status", "superseded_at", "validation_reason"])
      .where(
        "id",
        "in",
        [first, second, third, fourth].map((response) => response.results[0]?.verdictId ?? ""),
      )
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first.results[0]?.verdictId ?? "")).toMatchObject({
      action: "merge_into",
      status: "awaiting_human",
    });
    expect(byId.get(first.results[0]?.verdictId ?? "")?.superseded_at).toEqual(expect.any(String));
    expect(byId.get(second.results[0]?.verdictId ?? "")).toMatchObject({
      action: "merge_into",
      status: "approved",
      superseded_at: null,
    });
    expect(byId.get(third.results[0]?.verdictId ?? "")).toMatchObject({
      action: "archive",
      status: "awaiting_human",
      superseded_at: null,
    });
    expect(byId.get(fourth.results[0]?.verdictId ?? "")).toMatchObject({
      action: "merge_into",
      status: "bounced",
      validation_reason: "approved_verdict_pending",
      superseded_at: null,
    });
  });

  it("approves and applies graph verdicts with ledgered idempotent effects", async () => {
    const admin = await createPat("admin", "proposal-apply@example.com");
    await seedEntity({ id: "apply-source", name: "Apply Source", sourceType: "project" });
    await seedEntity({ id: "apply-target", name: "Apply Target", sourceType: "project" });
    await seedEntity({ id: "keep-project", name: "Keep Project", sourceType: "project" });
    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true, DEV_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });

    const proposed = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "merge_into",
          subjectEntityId: "apply-source",
          targetEntityId: "apply-target",
          reason: "Apply the merge.",
        },
      ],
    })) as { results: Array<{ verdictId: string }> };
    const verdictId = proposed.results[0]?.verdictId ?? "";
    await approveGraphVerdict(app, admin.cookie, verdictId);

    const previewRes = await apiPost(app, admin.cookie, `/api/graph-verdicts/${verdictId}/application`, {
      dryRun: true,
    });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      application: { dryRun: boolean; wouldChange: Record<string, number> };
    };
    expect(preview.application.dryRun).toBe(true);
    expect(preview.application.wouldChange).toMatchObject({ entities: 2, entity_merges: 1 });
    await expect(
      db
        .selectFrom("entities")
        .select(["deleted_at", "merged_into_entity_id"])
        .where("id", "=", "apply-source")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null, merged_into_entity_id: null });

    const applyRes = await apiPost(app, admin.cookie, `/api/graph-verdicts/${verdictId}/application`);
    expect(applyRes.status).toBe(200);
    const applied = (await applyRes.json()) as { application: { status: string; ledgerRef: string | null } };
    expect(applied.application).toMatchObject({
      status: "applied",
      ledgerRef: `merge-group:graph-verdict:${verdictId}`,
    });
    await expect(
      db
        .selectFrom("entities")
        .select(["deleted_at", "merged_into_entity_id"])
        .where("id", "=", "apply-source")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ deleted_at: expect.any(String), merged_into_entity_id: "apply-target" });
    await expect(
      db
        .selectFrom("entity_merges")
        .select(["group_id", "merged_by_user_id"])
        .where("group_id", "=", `graph-verdict:${verdictId}`)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ group_id: `graph-verdict:${verdictId}`, merged_by_user_id: admin.user.id });

    const secondApplyRes = await apiPost(app, admin.cookie, `/api/graph-verdicts/${verdictId}/application`);
    expect(secondApplyRes.status).toBe(200);
    const secondApplied = (await secondApplyRes.json()) as {
      application: { status: string; ledgerRef: string | null };
    };
    expect(secondApplied.application).toMatchObject(applied.application);
    await expect(
      db.selectFrom("entity_merges").select("id").where("group_id", "=", `graph-verdict:${verdictId}`).execute(),
    ).resolves.toHaveLength(1);

    const keep = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [{ action: "keep", subjectEntityId: "keep-project", reason: "Keep it." }],
    })) as { results: Array<{ verdictId: string }> };
    const keepId = keep.results[0]?.verdictId ?? "";
    await approveGraphVerdict(app, admin.cookie, keepId);
    const keepApply = await apiPost(app, admin.cookie, `/api/graph-verdicts/${keepId}/application`);
    expect(keepApply.status).toBe(200);
    await expect(
      db
        .selectFrom("graph_verdicts")
        .select(["status", "applied_ledger_ref"])
        .where("id", "=", keepId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "applied", applied_ledger_ref: "keep" });
  });

  it("refuses stale fingerprints and resolved-target drift while preserving approved verdicts", async () => {
    const admin = await createPat("admin", "proposal-drift@example.com");
    await seedEntity({ id: "stale-source", name: "Stale Source", sourceType: "project" });
    await seedEntity({ id: "stale-target", name: "Stale Target", sourceType: "project" });
    await seedEntity({ id: "drift-source", name: "Drift Source", sourceType: "project" });
    await seedEntity({ id: "drift-target", name: "Drift Target", sourceType: "project" });
    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true, DEV_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });

    const stale = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "merge_into",
          subjectEntityId: "stale-source",
          targetEntityId: "stale-target",
          reason: "Stale merge.",
        },
      ],
    })) as { results: Array<{ verdictId: string }> };
    const staleId = stale.results[0]?.verdictId ?? "";
    await approveGraphVerdict(app, admin.cookie, staleId);
    await db
      .updateTable("entities")
      .set({ deleted_at: "2026-08-22T01:00:00.000Z", merged_into_entity_id: "stale-target" })
      .where("id", "=", "stale-source")
      .execute();
    const staleApply = await apiPost(app, admin.cookie, `/api/graph-verdicts/${staleId}/application`);
    expect(staleApply.status).toBe(409);
    expect(await staleApply.json()).toMatchObject({ error: { code: "STALE_VERDICT" } });
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", staleId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "approved" });

    const drift = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        {
          action: "merge_into",
          subjectEntityId: "drift-source",
          targetEntityId: "drift-target",
          reason: "Drift merge.",
        },
      ],
    })) as { results: Array<{ verdictId: string }> };
    const driftId = drift.results[0]?.verdictId ?? "";
    await approveGraphVerdict(app, admin.cookie, driftId);
    await db
      .updateTable("graph_verdicts")
      .set({ resolved_target_entity_id: "other-target" })
      .where("id", "=", driftId)
      .execute();
    const driftApply = await apiPost(app, admin.cookie, `/api/graph-verdicts/${driftId}/application`);
    expect(driftApply.status).toBe(409);
    expect(await driftApply.json()).toMatchObject({ error: { code: "PLAN_DRIFT" } });
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", driftId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "approved" });
  });

  it("reverts nest and archive verdicts by ledger and fails closed for non-owned effects", async () => {
    const admin = await createPat("admin", "proposal-undo@example.com");
    await seedEntity({ id: "nest-child", name: "Nest Child", sourceType: "project" });
    await seedEntity({ id: "nest-parent", name: "Nest Parent", sourceType: "project" });
    await seedEntity({ id: "existing-child", name: "Existing Child", sourceType: "project" });
    await seedEntity({ id: "existing-parent", name: "Existing Parent", sourceType: "project" });
    await seedEntity({ id: "archive-project", name: "Archive Project", sourceType: "project" });
    await seedEntity({ id: "archive-stale", name: "Archive Stale", sourceType: "project" });
    await db
      .insertInto("entity_relationships")
      .values({
        id: "preexisting-part-of",
        source_entity_id: "existing-child",
        target_entity_id: "existing-parent",
        relationship_type: "part_of",
        confidence: "high",
        confidence_score: 1,
        source: "test",
      })
      .execute();
    const app = createApp(db, createTestConfig({ GRAPH_CURATION_TOOLS_ENABLED: true, DEV_TOOLS_ENABLED: true }), {
      logger: createTestLogger(),
    });

    const proposed = (await callTool(app, admin.token, "propose_graph_verdicts", {
      verdicts: [
        { action: "nest_under", subjectEntityId: "nest-child", targetEntityId: "nest-parent", reason: "Nest it." },
        {
          action: "nest_under",
          subjectEntityId: "existing-child",
          targetEntityId: "existing-parent",
          reason: "Already nested.",
        },
        { action: "archive", subjectEntityId: "archive-project", reason: "Archive it." },
        { action: "archive", subjectEntityId: "archive-stale", reason: "Archive then interfere." },
      ],
    })) as { results: Array<{ verdictId: string }> };
    const nestId = proposed.results[0]?.verdictId ?? "";
    const existingId = proposed.results[1]?.verdictId ?? "";
    const archiveId = proposed.results[2]?.verdictId ?? "";
    const archiveStaleId = proposed.results[3]?.verdictId ?? "";
    const verdictIds = [nestId, existingId, archiveId, archiveStaleId];
    for (const id of verdictIds) await approveGraphVerdict(app, admin.cookie, id);
    for (const id of verdictIds) {
      const res = await apiPost(app, admin.cookie, `/api/graph-verdicts/${id}/application`);
      expect(res.status).toBe(200);
    }

    const nestLedger = await db
      .selectFrom("graph_verdicts")
      .select("applied_ledger_ref")
      .where("id", "=", nestId)
      .executeTakeFirstOrThrow();
    expect(nestLedger.applied_ledger_ref).toMatch(/^relationship:/);
    const relationshipId = nestLedger.applied_ledger_ref?.slice("relationship:".length) ?? "";
    const nestRevert = await apiPost(app, admin.cookie, `/api/graph-verdicts/${nestId}/reversion`);
    expect(nestRevert.status).toBe(200);
    await expect(
      db.selectFrom("entity_relationships").select("id").where("id", "=", relationshipId).executeTakeFirst(),
    ).resolves.toBeUndefined();

    await expect(
      db
        .selectFrom("graph_verdicts")
        .select("applied_ledger_ref")
        .where("id", "=", existingId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ applied_ledger_ref: "noop:existing" });
    const existingRevert = await apiPost(app, admin.cookie, `/api/graph-verdicts/${existingId}/reversion`);
    expect(existingRevert.status).toBe(409);
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", existingId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "applied" });

    const archiveLedger = await db
      .selectFrom("graph_verdicts")
      .select("applied_ledger_ref")
      .where("id", "=", archiveId)
      .executeTakeFirstOrThrow();
    expect(archiveLedger.applied_ledger_ref).toMatch(/^archived-at:/);
    const archiveRevert = await apiPost(app, admin.cookie, `/api/graph-verdicts/${archiveId}/reversion`);
    expect(archiveRevert.status).toBe(200);
    await expect(
      db.selectFrom("entities").select("deleted_at").where("id", "=", "archive-project").executeTakeFirstOrThrow(),
    ).resolves.toEqual({ deleted_at: null });

    await db
      .updateTable("entities")
      .set({ deleted_at: "2026-08-22T02:00:00.000Z" })
      .where("id", "=", "archive-stale")
      .execute();
    const staleArchiveRevert = await apiPost(app, admin.cookie, `/api/graph-verdicts/${archiveStaleId}/reversion`);
    expect(staleArchiveRevert.status).toBe(409);
    await expect(
      db.selectFrom("graph_verdicts").select("status").where("id", "=", archiveStaleId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "applied" });
  });
});

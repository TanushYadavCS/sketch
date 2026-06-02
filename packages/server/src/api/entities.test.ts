import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { beginPendingRebuild, endRecreateLock, isRecreateActive } from "../entities/recreate-state";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { _setCurrentReenrichJobForTests, _setCurrentResetJobForTests } from "./entities";

const config = createTestConfig();
const logger = createTestLogger();

const ADMIN_EMAIL = "admin@test.com";
const PASSWORD = "testpassword123";

async function seedAdmin(db: Kysely<DB>): Promise<{ id: string }> {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  await settings.create();
  await users.create({
    name: "admin",
    email: ADMIN_EMAIL,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "admin",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
  const admin = await users.findByEmail(ADMIN_EMAIL);
  if (!admin) throw new Error("admin missing");
  return { id: admin.id };
}

async function seedMember(db: Kysely<DB>): Promise<{ id: string; email: string }> {
  const users = createUserRepository(db);
  const email = "member@test.com";
  await users.create({
    name: "member",
    email,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    authRole: "member",
  });
  const member = await users.findByEmail(email);
  if (!member) throw new Error("member missing");
  return { id: member.id, email };
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function loginAs(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function seedConnectorFile(db: Kysely<DB>, ownerId: string) {
  const now = new Date().toISOString();
  await db
    .insertInto("connector_configs")
    .values({
      id: "cfg",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: ownerId,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-1",
      connector_config_id: "cfg",
      provider_file_id: "provider-file-1",
      file_name: "File",
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      content_hash: "hash",
      is_archived: 0,
      synced_at: now,
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-2",
      connector_config_id: "cfg",
      provider_file_id: "provider-file-2",
      file_name: "File 2",
      file_type: "doc",
      content_category: "document",
      source: "google_drive",
      content_hash: "hash-2",
      is_archived: 0,
      synced_at: now,
    })
    .execute();
}

async function waitForJobDone(app: ReturnType<typeof createApp>, cookie: string, jobId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/api/entities/resets/jobs/${jobId}`, { headers: { Cookie: cookie } });
    if (res.status === 200) {
      const body = (await res.json()) as { phase: string };
      if (body.phase === "done" || body.phase === "failed") return body.phase;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job did not finish");
}

async function runResetAndWait(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; jobId?: string; phase?: string }> {
  const res = await app.request("/api/entities/resets", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 202) return { status: res.status };
  const json = (await res.json()) as { job: { id: string } };
  const phase = await waitForJobDone(app, cookie, json.job.id);
  return { status: res.status, jobId: json.job.id, phase };
}

describe("POST /api/entities/resets", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;

  beforeEach(async () => {
    if (isRecreateActive()) endRecreateLock();
    db = await createTestDb();
    const admin = await seedAdmin(db);
    adminId = admin.id;
    app = createApp(db, config, { logger });
    adminCookie = await login(app);
  });

  afterEach(async () => {
    _setCurrentReenrichJobForTests(false);
    if (isRecreateActive()) endRecreateLock();
    try {
      await db.destroy();
    } catch {}
  });

  it("clears connector facts' materialized_at when 'connectors' is selected", async () => {
    await seedConnectorFile(db, adminId);
    const factRepo = createIndexedFileFactRepository(db);

    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Alice",
      subjectEmail: "alice@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "f1:alice@example.com",
      raw: { providerFileId: "f1", attendee: { name: "Alice" } },
    });
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      contentHash: "hash",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: "Acme",
      subjectSource: "llm_extraction",
      subjectSourceId: "f1:hash:Acme",
      raw: {
        contentHash: "hash",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        mention: "Acme",
        type: "company",
        variations: [],
      },
    });

    // Mark all facts as materialized to simulate post-sync state.
    await db.updateTable("indexed_file_facts").set({ materialized_at: new Date().toISOString() }).execute();

    const result = await runResetAndWait(app, adminCookie, { categories: ["connectors"] });
    expect(result.status).toBe(202);
    expect(result.phase).toBe("done");

    const connectorFacts = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "attendee")
      .execute();
    expect(connectorFacts.every((f) => f.materialized_at === null)).toBe(true);

    const llmFacts = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("fact_type", "=", "llm_extracted")
      .execute();
    expect(llmFacts.every((f) => f.materialized_at !== null)).toBe(true);
  });

  it("preserves manual entities and never clears facts when only 'manual' is selected", async () => {
    await seedConnectorFile(db, adminId);
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: "manual-1",
        name: "Manual Co",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entities")
      .values({
        id: "connector-1",
        name: "Connector Person",
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entity_source_refs")
      .values({
        id: randomUUID(),
        entity_id: "connector-1",
        source: "fireflies",
        source_id: "user:1",
        source_url: null,
        last_seen_at: new Date().toISOString(),
      })
      .execute();
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Connector Person",
      subjectSource: "fireflies",
      subjectSourceId: "user:1",
      raw: { providerFileId: "f1", attendee: { name: "Connector Person" } },
    });
    await db.updateTable("indexed_file_facts").set({ materialized_at: now }).execute();

    const result = await runResetAndWait(app, adminCookie, { categories: ["manual"] });
    expect(result.status).toBe(202);
    expect(result.phase).toBe("done");

    const remaining = (await db.selectFrom("entities").select("id").execute()).map((r) => r.id).sort();
    expect(remaining).toEqual(["connector-1"]);
    const factsAfter = await db.selectFrom("indexed_file_facts").selectAll().execute();
    expect(factsAfter.every((f) => f.materialized_at !== null)).toBe(true);
  });

  it("ai-only reset preserves connector-owned people that picked up LLM evidence and removes their LLM refs", async () => {
    await seedConnectorFile(db, adminId);
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: "person-1",
        name: "Hari",
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entity_source_refs")
      .values({
        id: randomUUID(),
        entity_id: "person-1",
        source: "fireflies",
        source_id: "user:hari",
        source_url: null,
        last_seen_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("entity_source_refs")
      .values({
        id: randomUUID(),
        entity_id: "person-1",
        source: "llm_extraction",
        source_id: "file-1:hash:Hari",
        source_url: null,
        last_seen_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto("entity_mentions")
      .values({
        id: randomUUID(),
        entity_id: "person-1",
        indexed_file_id: "file-1",
        confidence: "INFERRED",
        source: "llm_extraction",
        relation: "mentioned",
        mentioned_at: new Date().toISOString(),
      })
      .execute();

    const result = await runResetAndWait(app, adminCookie, { categories: ["ai"] });
    expect(result.status).toBe(202);
    expect(result.phase).toBe("done");

    const person = await db.selectFrom("entities").select("id").where("id", "=", "person-1").executeTakeFirst();
    expect(person).toBeDefined();
    const llmRefs = await db
      .selectFrom("entity_source_refs")
      .selectAll()
      .where("entity_id", "=", "person-1")
      .where("source", "=", "llm_extraction")
      .execute();
    expect(llmRefs).toHaveLength(0);
    const llmMentions = await db
      .selectFrom("entity_mentions")
      .selectAll()
      .where("entity_id", "=", "person-1")
      .where("source", "=", "llm_extraction")
      .execute();
    expect(llmMentions).toHaveLength(0);
  });

  it("ai-only reset leaves connector review state alone and only scrubs LLM evidence", async () => {
    await seedConnectorFile(db, adminId);
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "review-connector",
        proposed_name: "Connector Cand",
        normalized_name: "connector cand",
        entity_type: "person",
        triggered_by_user_id: adminId,
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({ id: "ev-c", review_id: "review-connector", indexed_file_id: "file-1", source: "google_drive" })
      .execute();
    await db
      .insertInto("entity_review_queue")
      .values({
        id: "review-ai",
        proposed_name: "AI Cand",
        normalized_name: "ai cand",
        entity_type: "person",
        triggered_by_user_id: adminId,
      })
      .execute();
    await db
      .insertInto("entity_review_evidence")
      .values({ id: "ev-ai", review_id: "review-ai", indexed_file_id: "file-1", source: "llm_extraction" })
      .execute();
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: "ent-rej",
        name: "Existing",
        source_type: "person",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("entity_alias_rejections")
      .values({
        id: "rej-1",
        entity_id: "ent-rej",
        rejected_name: "Foo",
        normalized_rejected_name: "foo",
        rejected_by: adminId,
      })
      .execute();

    const result = await runResetAndWait(app, adminCookie, { categories: ["ai"] });
    expect(result.status).toBe(202);
    expect(result.phase).toBe("done");

    const queue = (await db.selectFrom("entity_review_queue").select("id").execute()).map((r) => r.id).sort();
    expect(queue).toEqual(["review-connector"]);
    const evidence = (await db.selectFrom("entity_review_evidence").select("id").execute()).map((r) => r.id);
    expect(evidence).toEqual(["ev-c"]);
    const rejections = await db.selectFrom("entity_alias_rejections").select("id").execute();
    expect(rejections).toHaveLength(1);
  });

  it("runAfter=true rebuilds entities from facts and reports a job", async () => {
    await seedConnectorFile(db, adminId);
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Alice",
      subjectEmail: "alice@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "f1:alice@example.com",
      raw: { providerFileId: "f1", attendee: { name: "Alice" } },
    });

    const res = await app.request("/api/entities/resets", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        categories: ["connectors", "ai"],
        runAfter: true,
        confirm: "RESET_AND_RECREATE",
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: { id: string; phase: string } };
    expect(body.job.id).toBeTruthy();

    const phase = await waitForJobDone(app, adminCookie, body.job.id);
    expect(phase).toBe("done");

    const entities = await db.selectFrom("entities").select("name").execute();
    expect(entities.some((e) => e.name === "Alice")).toBe(true);
  });

  it("rejects runAfter without confirm token", async () => {
    const res = await app.request("/api/entities/resets", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ categories: ["connectors"], runAfter: true }),
    });
    expect(res.status).toBe(400);
  });

  it("mixed-type LLM corpus survives reset→rebuild and stays equivalent across runs", async () => {
    // E2E equivalence test — pins three things at once:
    //   1) Threshold gate: single-file LLM mentions stay deferred, not promoted.
    //   2) Type fidelity: raw.type flows through to entities.source_type.
    //   3) materialized_at clearing on reset, then rebuild produces the
    //      same graph (idempotent across two reset+rebuild rounds).
    // Fails loudly if any of: threshold logic, non-person upsert helper,
    // person fast-path, fact-key collision, materialized_at gate.
    const now = new Date().toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg",
        connector_type: "fireflies",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .execute();
    const fileIds = ["file-1", "file-2", "file-3", "file-4", "file-5"];
    for (const fid of fileIds) {
      await db
        .insertInto("indexed_files")
        .values({
          id: fid,
          connector_config_id: "cfg",
          provider_file_id: `provider-${fid}`,
          file_name: fid,
          file_type: "transcript",
          content_category: "transcript",
          source: "fireflies",
          content_hash: `hash-${fid}`,
          is_archived: 0,
          synced_at: now,
        })
        .execute();
    }

    const factRepo = createIndexedFileFactRepository(db);

    async function seedLlmFact(fileId: string, mention: string, mentionType: string) {
      const contentHash = `hash-${fileId}`;
      await factRepo.upsertFact({
        indexedFileId: fileId,
        connectorConfigId: "cfg",
        createdByUserId: adminId,
        contentHash,
        source: "llm_extraction",
        factType: "llm_extracted",
        relation: "mentioned",
        subjectName: mention,
        subjectSource: "llm_extraction",
        subjectSourceId: `${fileId}:${contentHash}:llm-extraction-v2:${mention}`,
        raw: {
          contentHash,
          promptVersion: "llm-extraction-v2",
          model: "gemini",
          mention,
          type: mentionType,
          variations: [],
        },
      });
    }

    // "Acme Corp" company — 3 files (above threshold of 2).
    await seedLlmFact("file-1", "Acme Corp", "company");
    await seedLlmFact("file-2", "Acme Corp", "company");
    await seedLlmFact("file-3", "Acme Corp", "company");
    // "Apollo" project — 2 files (exactly at threshold).
    await seedLlmFact("file-1", "Apollo", "project");
    await seedLlmFact("file-2", "Apollo", "project");
    // "Sarah Chen" person — 4 files (well above threshold).
    for (const fid of ["file-1", "file-2", "file-3", "file-4"]) {
      await seedLlmFact(fid, "Sarah Chen", "person");
    }
    // "OneOff" company — 1 file (below threshold, must stay deferred).
    await seedLlmFact("file-5", "OneOff", "company");

    // Connector EXTRACTED evidence for Sarah Chen (attendee on file-3).
    await factRepo.upsertFact({
      indexedFileId: "file-3",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      contentHash: "hash-file-3",
      source: "fireflies",
      factType: "attendee",
      relation: "attended",
      subjectName: "Sarah Chen",
      subjectEmail: "sarah@example.com",
      subjectSource: "fireflies",
      subjectSourceId: "file-3:sarah@example.com",
      raw: { providerFileId: "file-3", attendee: { name: "Sarah Chen", email: "sarah@example.com" } },
    });

    async function runResetRebuild(): Promise<string> {
      const res = await app.request("/api/entities/resets", {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          categories: ["connectors", "ai"],
          runAfter: true,
          confirm: "RESET_AND_RECREATE",
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { job: { id: string } };
      const phase = await waitForJobDone(app, adminCookie, body.job.id);
      expect(phase).toBe("done");
      return body.job.id;
    }

    interface EntityRow {
      name: string;
      source_type: string;
    }
    interface MentionRow {
      entity_name: string;
      indexed_file_id: string;
      relation: string;
      confidence: string;
      source: string;
    }

    async function snapshot(): Promise<{ entities: EntityRow[]; mentions: MentionRow[] }> {
      const entities = await db
        .selectFrom("entities")
        .select(["name", "source_type"])
        .orderBy("source_type")
        .orderBy("name")
        .execute();
      const mentions = await db
        .selectFrom("entity_mentions as m")
        .innerJoin("entities as e", "e.id", "m.entity_id")
        .select(["e.name as entity_name", "m.indexed_file_id", "m.relation", "m.confidence", "m.source"])
        .orderBy("e.name")
        .orderBy("m.indexed_file_id")
        .orderBy("m.relation")
        .orderBy("m.source")
        .execute();
      return { entities, mentions };
    }

    // Round 1 — first reset (no entities yet, so this just materializes).
    await runResetRebuild();
    const snapshotA = await snapshot();

    // Threshold + type fidelity assertions on the initial build.
    // Ordering matches the snapshot query (source_type then name).
    expect(snapshotA.entities).toEqual([
      { name: "Acme Corp", source_type: "company" },
      { name: "Sarah Chen", source_type: "person" },
      { name: "admin", source_type: "person" },
      { name: "Apollo", source_type: "project" },
    ]);
    expect(snapshotA.entities.some((e) => e.name === "OneOff")).toBe(false);

    const acmeMentions = snapshotA.mentions.filter((m) => m.entity_name === "Acme Corp");
    expect(acmeMentions).toHaveLength(3);
    expect(acmeMentions.every((m) => m.confidence === "INFERRED" && m.source === "llm_extraction")).toBe(true);

    const apolloMentions = snapshotA.mentions.filter((m) => m.entity_name === "Apollo");
    expect(apolloMentions).toHaveLength(2);

    const sarahMentions = snapshotA.mentions.filter((m) => m.entity_name === "Sarah Chen");
    expect(sarahMentions.some((m) => m.confidence === "EXTRACTED" && m.relation === "attended")).toBe(true);
    expect(sarahMentions.some((m) => m.confidence === "INFERRED" && m.source === "llm_extraction")).toBe(true);

    // OneOff fact must remain unmaterialized (deferred), not deleted.
    const oneOffFact = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_name", "=", "OneOff")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    expect(oneOffFact).toBeDefined();
    expect(oneOffFact?.materialized_at).toBeNull();

    // Round 2 — reset and rebuild again. This exercises:
    //   - materialized_at clearing (without it the second pass is empty)
    //   - the equivalence property (rebuild from facts is deterministic)
    await runResetRebuild();
    const snapshotB = await snapshot();

    expect(snapshotB.entities).toEqual(snapshotA.entities);
    expect(snapshotB.mentions).toEqual(snapshotA.mentions);

    const oneOffAfter = await db
      .selectFrom("indexed_file_facts")
      .selectAll()
      .where("subject_name", "=", "OneOff")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    expect(oneOffAfter?.materialized_at).toBeNull();
  });

  it("AI reset unmaterializes both llm_extracted and llm_relation facts", async () => {
    await seedConnectorFile(db, adminId);
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      contentHash: "hash",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: "Acme",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash:Acme",
      raw: {
        contentHash: "hash",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        mention: "Acme",
        type: "company",
        variations: [],
      },
    });
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      contentHash: "hash",
      source: "llm_extraction",
      factType: "llm_relation",
      relation: "works_at",
      subjectName: "Alice",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash:Alice:Acme",
      raw: {
        contentHash: "hash",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        relationType: "works_at",
        confidence: 0.9,
        source: { name: "Alice", type: "person", variations: [] },
        target: { name: "Acme", type: "company", variations: [] },
      },
    });
    await db.updateTable("indexed_file_facts").set({ materialized_at: new Date().toISOString() }).execute();

    const result = await runResetAndWait(app, adminCookie, { categories: ["ai"] });
    expect(result.status).toBe(202);
    expect(result.phase).toBe("done");

    const factsAfter = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "materialized_at"])
      .where("fact_type", "in", ["llm_extracted", "llm_relation"])
      .execute();
    expect(factsAfter).toHaveLength(2);
    expect(factsAfter.every((f) => f.materialized_at === null)).toBe(true);
  });

  it("dry-run returns category-scoped counts without writing", async () => {
    await seedConnectorFile(db, adminId);
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id: "manual-co",
        name: "Manual Co",
        source_type: "company",
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const res = await app.request("/api/entities/resets", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ categories: ["manual"], dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; entitiesDeleted: number };
    expect(body.dryRun).toBe(true);
    expect(body.entitiesDeleted).toBe(1);
    const remaining = await db.selectFrom("entities").select("id").execute();
    expect(remaining).toHaveLength(1);
  });
});

describe("POST /api/entities/reenrichments", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;

  beforeEach(async () => {
    if (isRecreateActive()) endRecreateLock();
    db = await createTestDb();
    const admin = await seedAdmin(db);
    adminId = admin.id;
    app = createApp(db, config, { logger });
    adminCookie = await login(app);
  });

  afterEach(async () => {
    _setCurrentReenrichJobForTests(false);
    if (isRecreateActive()) endRecreateLock();
    try {
      await db.destroy();
    } catch {}
  });

  it("dry-run reports LLM fact types without mutating rows", async () => {
    await seedConnectorFile(db, adminId);
    const factRepo = createIndexedFileFactRepository(db);
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      contentHash: "hash",
      source: "llm_extraction",
      factType: "llm_extracted",
      relation: "mentioned",
      subjectName: "Alice",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash:Alice",
      raw: {
        contentHash: "hash",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        mention: "Alice",
        type: "person",
        variations: [],
      },
    });
    await factRepo.upsertFact({
      indexedFileId: "file-1",
      connectorConfigId: "cfg",
      createdByUserId: adminId,
      contentHash: "hash",
      source: "llm_extraction",
      factType: "llm_relation",
      relation: "contributes_to",
      subjectName: "Alice",
      subjectSource: "llm_extraction",
      subjectSourceId: "file-1:hash:Alice:Apollo",
      raw: {
        contentHash: "hash",
        promptVersion: "llm-extraction-v2",
        model: "gemini",
        relationType: "contributes_to",
        confidence: 0.8,
        source: { name: "Alice", type: "person", variations: [] },
        target: { name: "Apollo", type: "project", variations: [] },
      },
    });

    const res = await app.request("/api/entities/reenrichments", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { fileIds: ["file-1", "missing"] }, dryRun: true }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      files: number;
      missingFileIds: string[];
      factsByType: Record<string, number>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.files).toBe(1);
    expect(body.missingFileIds).toEqual(["missing"]);
    expect(body.factsByType).toEqual({ llm_extracted: 1, llm_relation: 1 });
    const factsAfter = await db.selectFrom("indexed_file_facts").select("deleted_at").execute();
    expect(factsAfter.every((fact) => fact.deleted_at === null)).toBe(true);
  });

  it("requires admin access", async () => {
    const member = await seedMember(db);
    const memberCookie = await loginAs(app, member.email);

    const res = await app.request("/api/entities/reenrichments", {
      method: "POST",
      headers: { Cookie: memberCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { fileIds: ["file-1"] }, dryRun: true }),
    });

    expect(res.status).toBe(403);
  });

  it("requires confirm token for all-scope apply", async () => {
    await seedConnectorFile(db, adminId);

    const res = await app.request("/api/entities/reenrichments", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { all: true } }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("confirm must be REENRICH");
  });

  it("allows admins to request stop for an active re-enrich job", async () => {
    const jobId = _setCurrentReenrichJobForTests(true);
    if (!jobId) throw new Error("missing job id");

    const res = await app.request(`/api/entities/reenrichments/jobs/${jobId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: { id: string; cancelRequested: boolean; error: string } };
    expect(body.job.id).toBe(jobId);
    expect(body.job.cancelRequested).toBe(true);
    expect(body.job.error).toBe("Stop requested");
  });

  it("requires admin access to stop a re-enrich job", async () => {
    const jobId = _setCurrentReenrichJobForTests(true);
    const member = await seedMember(db);
    const memberCookie = await loginAs(app, member.email);

    const res = await app.request(`/api/entities/reenrichments/jobs/${jobId}`, {
      method: "DELETE",
      headers: { Cookie: memberCookie },
    });

    expect(res.status).toBe(403);
  });
});

describe("two-step rebuild flow", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;

  beforeEach(async () => {
    _setCurrentReenrichJobForTests(false);
    if (isRecreateActive()) endRecreateLock();
    db = await createTestDb();
    const admin = await seedAdmin(db);
    adminId = admin.id;
    app = createApp(db, config, { logger });
    adminCookie = await login(app);
  });

  afterEach(async () => {
    if (isRecreateActive()) endRecreateLock();
    try {
      await db.destroy();
    } catch {}
  });

  async function step1Reset(body: Record<string, unknown>) {
    const res = await app.request("/api/entities/resets", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = res.status === 202 ? ((await res.json()) as Record<string, unknown>) : null;
    return { status: res.status, json };
  }

  async function waitForResetDone(jobId: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const res = await app.request(`/api/entities/resets/jobs/${jobId}`, { headers: { Cookie: adminCookie } });
      if (res.status === 200) {
        const body = (await res.json()) as { phase: string };
        if (body.phase === "done" || body.phase === "failed") return body.phase;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("reset job did not finish");
  }

  /**
   * Distinct failure mode 1 — lock continuity across the step-1 / step-2
   * pause. Step 1 hands out a pendingRebuildId; step 2 can only proceed by
   * presenting it, and no other recreate-class job may slip in during the
   * pending window.
   */
  it("lock continuity: step 1 → step 2 with pendingRebuildId; without id and during pending, 409", async () => {
    const reset = await step1Reset({
      categories: ["manual", "connectors", "ai"],
      runAfter: false,
      confirm: "RESET_AND_RECREATE",
    });
    expect(reset.status).toBe(202);
    const pendingRebuildId = reset.json?.pendingRebuildId as string | undefined;
    expect(typeof pendingRebuildId).toBe("string");
    expect(pendingRebuildId).toBeTruthy();
    const jobId = (reset.json?.job as { id: string }).id;

    expect(await waitForResetDone(jobId)).toBe("done");

    // A second /resets while the lock is pending must be rejected — sync,
    // enrichment, or another rebuild attempt cannot slip in here.
    const racing = await step1Reset({
      categories: ["connectors"],
    });
    expect(racing.status).toBe(409);

    // /rebuilds without an id is rejected; with a wrong id, 409.
    const noId = await app.request("/api/entities/rebuilds", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noId.status).toBe(400);
    const wrongId = await app.request("/api/entities/rebuilds", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ pendingRebuildId: "does-not-match" }),
    });
    expect(wrongId.status).toBe(409);

    // With the right id, step 2 promotes the pending lock and the rebuild starts.
    const promote = await app.request("/api/entities/rebuilds", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ pendingRebuildId }),
    });
    expect(promote.status).toBe(202);
    const body = (await promote.json()) as { job: { id: string } };
    for (let i = 0; i < 100; i++) {
      const r = await app.request(`/api/entities/rebuilds/jobs/${body.job.id}`, { headers: { Cookie: adminCookie } });
      if (r.status === 200) {
        const j = (await r.json()) as { phase: string };
        if (j.phase === "done" || j.phase === "failed") {
          expect(j.phase).toBe("done");
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // After promotion + completion, the same id can't be reused.
    const replay = await app.request("/api/entities/rebuilds", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ pendingRebuildId }),
    });
    expect(replay.status).toBe(409);
  });

  it("does not consume a pending rebuild id while a reset job is active", async () => {
    const pendingRebuildId = randomUUID();
    beginPendingRebuild({ pendingRebuildId });
    _setCurrentResetJobForTests(true);
    try {
      const earlyPromote = await app.request("/api/entities/rebuilds", {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ pendingRebuildId }),
      });
      expect(earlyPromote.status).toBe(409);
      const stillPending = await app.request("/api/entities/rebuilds/pending", { headers: { Cookie: adminCookie } });
      expect(stillPending.status).toBe(200);
      expect(((await stillPending.json()) as { pending: { pendingRebuildId: string } }).pending.pendingRebuildId).toBe(
        pendingRebuildId,
      );
    } finally {
      _setCurrentResetJobForTests(false);
      endRecreateLock();
    }
  });

  /**
   * Distinct failure mode 2 — wipeLlmFacts must control LLM-fact survival.
   * Off (default): facts keep deleted_at IS NULL. On: facts are tombstoned
   * and their dependent relation evidence is gone.
   */
  it("wipeLlmFacts: off leaves LLM facts intact; on tombstones them and clears relation evidence", async () => {
    await seedConnectorFile(db, adminId);
    async function seedLlmFactWithRelation(suffix: string) {
      const factRepo = createIndexedFileFactRepository(db);
      await factRepo.upsertFact({
        indexedFileId: "file-1",
        connectorConfigId: "cfg",
        createdByUserId: adminId,
        contentHash: `hash-${suffix}`,
        source: "llm_extraction",
        factType: "llm_extracted",
        relation: "mentioned",
        subjectName: `Alice${suffix}`,
        subjectSource: "llm_extraction",
        subjectSourceId: `file-1:hash-${suffix}:Alice`,
        raw: {
          contentHash: `hash-${suffix}`,
          promptVersion: "llm-extraction-v2",
          model: "gemini",
          mention: `Alice${suffix}`,
          type: "person",
          variations: [],
        },
      });
      await factRepo.upsertFact({
        indexedFileId: "file-1",
        connectorConfigId: "cfg",
        createdByUserId: adminId,
        contentHash: `hash-${suffix}`,
        source: "llm_extraction",
        factType: "llm_relation",
        relation: "contributes_to",
        subjectName: `Alice${suffix}`,
        subjectSource: "llm_extraction",
        subjectSourceId: `file-1:hash-${suffix}:Alice:Apollo`,
        raw: {
          contentHash: `hash-${suffix}`,
          promptVersion: "llm-extraction-v2",
          model: "gemini",
          relationType: "contributes_to",
          confidence: 0.8,
          source: { name: `Alice${suffix}`, type: "person", variations: [] },
          target: { name: "Apollo", type: "project", variations: [] },
        },
      });
      const relationFact = await db
        .selectFrom("indexed_file_facts")
        .select("id")
        .where("fact_type", "=", "llm_relation")
        .where("subject_name", "=", `Alice${suffix}`)
        .executeTakeFirstOrThrow();
      // Seed an entity_relationship + evidence that points at the llm_relation
      // fact so we can confirm cleanup happens on tombstone.
      const now = new Date().toISOString();
      await db
        .insertInto("entities")
        .values([
          {
            id: `alice${suffix}`,
            name: `Alice${suffix}`,
            source_type: "person",
            status: "confirmed",
            hotness: 0,
            created_at: now,
            updated_at: now,
          },
          {
            id: `apollo${suffix}`,
            name: "Apollo",
            source_type: "project",
            status: "confirmed",
            hotness: 0,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();
      const relId = randomUUID();
      await db
        .insertInto("entity_relationships")
        .values({
          id: relId,
          source_entity_id: `alice${suffix}`,
          target_entity_id: `apollo${suffix}`,
          relationship_type: "contributes_to",
          confidence: "INFERRED",
          confidence_score: 0.8,
          source: "llm_extraction",
        })
        .execute();
      await db
        .insertInto("entity_relationship_evidence")
        .values({
          id: randomUUID(),
          relationship_id: relId,
          indexed_file_id: "file-1",
          note: null,
          source_fact_id: relationFact.id,
        })
        .execute();
    }

    // ── wipeLlmFacts: false (default) ────────────────────────────
    await seedLlmFactWithRelation("a");
    const off = await step1Reset({
      categories: ["connectors"],
      runAfter: false,
    });
    expect(off.status).toBe(202);
    await waitForResetDone((off.json?.job as { id: string }).id);

    const factsOff = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "deleted_at"])
      .where("fact_type", "in", ["llm_extracted", "llm_relation"])
      .execute();
    expect(factsOff.length).toBeGreaterThanOrEqual(2);
    expect(factsOff.every((f) => f.deleted_at === null)).toBe(true);

    // Release the pending lock so the next test can run cleanly.
    const pendingOff = (off.json as { pendingRebuildId: string }).pendingRebuildId;
    const cancel = await app.request(`/api/entities/rebuilds/pending/${pendingOff}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(cancel.status).toBe(204);

    // ── wipeLlmFacts: true ───────────────────────────────────────
    await seedLlmFactWithRelation("b");
    const on = await step1Reset({
      categories: ["ai"],
      runAfter: false,
      wipeLlmFacts: true,
    });
    expect(on.status).toBe(202);
    await waitForResetDone((on.json?.job as { id: string }).id);

    const factsOn = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "deleted_at"])
      .where("fact_type", "in", ["llm_extracted", "llm_relation"])
      .execute();
    expect(factsOn.length).toBeGreaterThanOrEqual(2);
    expect(factsOn.every((f) => f.deleted_at !== null)).toBe(true);
    const evidence = await db.selectFrom("entity_relationship_evidence").select("id").execute();
    expect(evidence).toHaveLength(0);
  });

  /**
   * Distinct failure mode 3 — payload-shape guards stop the original silent
   * silent-discard regression: /resets must reject scope, /reenrichments
   * must reject categories. The two endpoints don't accept each other's
   * fields under any circumstances.
   */
  it("payload guards: /resets rejects scope; /reenrichments rejects categories", async () => {
    const resetWithScope = await app.request("/api/entities/resets", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ categories: ["connectors"], scope: { all: true } }),
    });
    expect(resetWithScope.status).toBe(400);

    const reenrichWithCategories = await app.request("/api/entities/reenrichments", {
      method: "POST",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { all: true }, categories: ["ai"] }),
    });
    expect(reenrichWithCategories.status).toBe(400);
  });
});

describe("Entity drawer routes", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;
  let memberCookie: string;
  let memberEmail: string;

  const flaggedConfig = createTestConfig({ EXPERIMENTAL_FLAG: true });

  beforeEach(async () => {
    if (isRecreateActive()) endRecreateLock();
    db = await createTestDb();
    const admin = await seedAdmin(db);
    adminId = admin.id;
    const member = await seedMember(db);
    memberEmail = member.email;
    app = createApp(db, flaggedConfig, { logger });
    adminCookie = await login(app);
    memberCookie = await loginAs(app, memberEmail);
  });

  afterEach(async () => {
    if (isRecreateActive()) endRecreateLock();
    try {
      await db.destroy();
    } catch {}
  });

  async function seedEntity(id: string, name: string, sourceType: string, metadata: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    await db
      .insertInto("entities")
      .values({
        id,
        name,
        source_type: sourceType,
        subtype: null,
        aliases: null,
        metadata: JSON.stringify(metadata),
        source_ref_id: null,
        status: "confirmed",
        hotness: 0,
        created_at: now,
        updated_at: now,
        ai_brief: null,
      })
      .execute();
  }

  async function seedRelation(
    id: string,
    sourceId: string,
    targetId: string,
    type: string,
    confidence: string,
    score: number,
  ) {
    const now = new Date().toISOString();
    await db
      .insertInto("entity_relationships")
      .values({
        id,
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relationship_type: type,
        confidence,
        confidence_score: score,
        source: "llm_relation",
        valid_from: now,
        valid_to: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedFile(id: string, accessScopeId: string | null = null) {
    const now = new Date().toISOString();
    await db
      .insertInto("connector_configs")
      .values({
        id: `cfg-${id}`,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("indexed_files")
      .values({
        id,
        connector_config_id: `cfg-${id}`,
        provider_file_id: `pf-${id}`,
        file_name: `file ${id}`,
        file_type: "doc",
        content_category: "document",
        source: "google_drive",
        content_hash: `hash-${id}`,
        is_archived: 0,
        synced_at: now,
        access_scope_id: accessScopeId,
        source_created_at: now,
        source_updated_at: now,
      })
      .execute();
  }

  async function seedEvidence(id: string, relationshipId: string, fileId: string, chunkIndex = -1) {
    await db
      .insertInto("entity_relationship_evidence")
      .values({
        id,
        relationship_id: relationshipId,
        indexed_file_id: fileId,
        chunk_index: chunkIndex,
        note: null,
        source_fact_id: null,
        evidence_key: `${relationshipId}:${fileId}:${chunkIndex}`,
      })
      .execute();
  }

  it("GET /api/entities/:id returns profile with deterministic summary built from relationships + activity", async () => {
    await seedEntity("e1", "Sarah Chen", "person", { role: "Engineer", email: "sarah@stripe.com" });
    await seedEntity("e2", "Stripe", "company");
    await seedEntity("e3", "Acme", "company");
    await seedRelation("r1", "e1", "e2", "works_at", "EXTRACTED", 0.95);
    await seedRelation("r2", "e1", "e3", "engaged_with", "EXTRACTED", 0.9);
    await seedFile("f1");
    await db
      .insertInto("entity_mentions")
      .values({
        id: "m1",
        entity_id: "e1",
        indexed_file_id: "f1",
        chunk_index: 0,
        context_snippet: "Sarah leads things",
        confidence: "EXTRACTED",
        source: "google_drive",
        relation: "mentioned",
        mentioned_at: new Date().toISOString(),
      })
      .execute();

    const res = await app.request("/api/entities/e1", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: {
        profile: {
          entityType: string;
          mentionCount: number;
          summary: { identity: string; activity: string };
        };
      };
    };
    expect(body.entity.profile.entityType).toBe("person");
    expect(body.entity.profile.mentionCount).toBe(1);
    expect(body.entity.profile.summary.identity).toContain("Person");
    expect(body.entity.profile.summary.identity).toContain("Engineer");
    expect(body.entity.profile.summary.identity).toContain("Stripe");
    expect(body.entity.profile.summary.identity).toContain("sarah@stripe.com");
    expect(body.entity.profile.summary.identity).toContain("Acme");
    expect(body.entity.profile.summary.activity).toContain("1 file");
    expect(body.entity.profile.summary.activity).toContain("1 mention");
  });

  it("GET /api/entities/:id filters summary activity and collaborators by visible files", async () => {
    await seedEntity("e1", "Sarah Chen", "person");
    await seedEntity("bob", "Bob Restricted", "person");
    await seedEntity("charlie", "Charlie Visible", "person");

    const scopeId = "scope-summary-restricted";
    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg-summary-scope",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("access_scopes")
      .values({
        id: scopeId,
        connector_config_id: "cfg-summary-scope",
        scope_type: "shared_drive",
        provider_scope_id: "summary-sd",
        label: "Summary Restricted",
      })
      .execute();

    await seedFile("f-public");
    await seedFile("f-restricted", scopeId);
    const now = new Date().toISOString();
    await db
      .insertInto("entity_mentions")
      .values([
        {
          id: "m-sarah-public",
          entity_id: "e1",
          indexed_file_id: "f-public",
          chunk_index: 0,
          context_snippet: "Sarah and Charlie",
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
        {
          id: "m-charlie-public",
          entity_id: "charlie",
          indexed_file_id: "f-public",
          chunk_index: 0,
          context_snippet: "Sarah and Charlie",
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
        {
          id: "m-sarah-restricted",
          entity_id: "e1",
          indexed_file_id: "f-restricted",
          chunk_index: 0,
          context_snippet: "Sarah and Bob",
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
        {
          id: "m-bob-restricted",
          entity_id: "bob",
          indexed_file_id: "f-restricted",
          chunk_index: 0,
          context_snippet: "Sarah and Bob",
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
      ])
      .execute();

    const res = await app.request("/api/entities/e1", { headers: { Cookie: memberCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: { profile: { summary: { activity: string } } };
    };
    expect(body.entity.profile.summary.activity).toContain("1 file");
    expect(body.entity.profile.summary.activity).toContain("Charlie Visible");
    expect(body.entity.profile.summary.activity).not.toContain("Bob Restricted");
  });

  it("GET /api/entities/:id/mentions gates snippets with admin_can_read_all_files", async () => {
    await seedEntity("e1", "Sarah", "person");

    const scopeId = "scope-mentions-restricted";
    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg-mentions-scope",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("access_scopes")
      .values({
        id: scopeId,
        connector_config_id: "cfg-mentions-scope",
        scope_type: "shared_drive",
        provider_scope_id: "mentions-sd",
        label: "Mentions Restricted",
      })
      .execute();

    await seedFile("f-public");
    await seedFile("f-restricted", scopeId);
    const now = new Date().toISOString();
    await db
      .insertInto("entity_mentions")
      .values([
        {
          id: "m-public",
          entity_id: "e1",
          indexed_file_id: "f-public",
          chunk_index: 0,
          context_snippet: "public snippet",
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
        {
          id: "m-restricted",
          entity_id: "e1",
          indexed_file_id: "f-restricted",
          chunk_index: 0,
          context_snippet: "restricted snippet",
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
      ])
      .execute();

    const offRes = await app.request("/api/entities/e1/mentions", { headers: { Cookie: adminCookie } });
    expect(offRes.status).toBe(200);
    const offBody = (await offRes.json()) as {
      mentions: Array<{ contextSnippet: string }>;
      hiddenCount: number;
      total: number;
    };
    expect(offBody.mentions.map((m) => m.contextSnippet)).toEqual(["public snippet"]);
    expect(offBody.total).toBe(1);
    expect(offBody.hiddenCount).toBe(1);

    await createSettingsRepository(db).update({ adminCanReadAllFiles: true });
    const onRes = await app.request("/api/entities/e1/mentions", { headers: { Cookie: adminCookie } });
    expect(onRes.status).toBe(200);
    const onBody = (await onRes.json()) as {
      mentions: Array<{ contextSnippet: string }>;
      hiddenCount: number;
      total: number;
    };
    expect(onBody.mentions.map((m) => m.contextSnippet).sort()).toEqual(["public snippet", "restricted snippet"]);
    expect(onBody.total).toBe(2);
    expect(onBody.hiddenCount).toBe(0);
  });

  it("GET /api/entities/:id/relations partitions outgoing/incoming and pins AMBIGUOUS first", async () => {
    await seedEntity("e1", "Sarah", "person");
    await seedEntity("e2", "Atlas", "project");
    await seedEntity("e3", "Helios", "project");
    await seedRelation("r-out-1", "e1", "e2", "leads", "EXTRACTED", 0.95);
    await seedRelation("r-out-2", "e1", "e3", "contributes_to", "AMBIGUOUS", 0.4);

    const res = await app.request("/api/entities/e1/relations", { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outgoing: Array<{ id: string; confidence: string }>;
      incoming: Array<{ id: string }>;
      totalCount: number;
    };
    expect(body.outgoing[0].confidence).toBe("AMBIGUOUS");
    expect(body.outgoing[1].confidence).toBe("EXTRACTED");
    expect(body.incoming).toEqual([]);
    expect(body.totalCount).toBe(2);
  });

  it("GET /api/entities/:id/relations works without EXPERIMENTAL_FLAG (Files is GA)", async () => {
    const offConfig = createTestConfig({ EXPERIMENTAL_FLAG: false });
    const offApp = createApp(db, offConfig, { logger });
    await seedEntity("e1", "Sarah", "person");
    const offCookie = await login(offApp);
    const res = await offApp.request("/api/entities/e1/relations", { headers: { Cookie: offCookie } });
    expect(res.status).toBe(200);
  });

  it("GET /api/entities/:id/relations/:rid/evidence applies file RBAC (visibleCount < totalCount)", async () => {
    await seedEntity("e1", "Sarah", "person");
    await seedEntity("e2", "Atlas", "project");
    await seedRelation("r1", "e1", "e2", "leads", "EXTRACTED", 0.95);

    const scopeId = "scope-restricted";
    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg-scope",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("access_scopes")
      .values({
        id: scopeId,
        connector_config_id: "cfg-scope",
        scope_type: "shared_drive",
        provider_scope_id: "sd-1",
        label: "Restricted",
      })
      .execute();

    await seedFile("f-public");
    await seedFile("f-restricted-1", scopeId);
    await seedFile("f-restricted-2", scopeId);
    await seedEvidence("ev-1", "r1", "f-public");
    await seedEvidence("ev-2", "r1", "f-restricted-1");
    await seedEvidence("ev-3", "r1", "f-restricted-2");
    await db
      .insertInto("entity_mentions")
      .values({
        id: "m-evidence-visible",
        entity_id: "e1",
        indexed_file_id: "f-public",
        chunk_index: 0,
        context_snippet: "Sarah in public evidence",
        confidence: "EXTRACTED",
        source: "google_drive",
        relation: "mentioned",
        mentioned_at: new Date().toISOString(),
      })
      .execute();

    const res = await app.request("/api/entities/e1/relations/r1/evidence", { headers: { Cookie: memberCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ fileId: string }>; visibleCount: number; totalCount: number };
    expect(body.totalCount).toBe(3);
    expect(body.visibleCount).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].fileId).toBe("f-public");
  });

  it("GET /api/entities respects includeSystem (default hides clickup_workspace/clickup_space)", async () => {
    await seedEntity("p1", "Alice", "person");
    await seedEntity("w1", "Workspace", "clickup_workspace");
    await seedEntity("s1", "Space", "clickup_space");

    const defaultRes = await app.request("/api/entities", { headers: { Cookie: adminCookie } });
    const defaultBody = (await defaultRes.json()) as { entities: Array<{ sourceType: string }>; total: number };
    expect(defaultBody.entities.map((e) => e.sourceType).sort()).toEqual(["person"]);
    expect(defaultBody.total).toBe(1);

    const includeRes = await app.request("/api/entities?includeSystem=true", { headers: { Cookie: adminCookie } });
    const includeBody = (await includeRes.json()) as { entities: Array<{ sourceType: string }>; total: number };
    expect(includeBody.entities.map((e) => e.sourceType).sort()).toEqual([
      "clickup_space",
      "clickup_workspace",
      "person",
    ]);
    expect(includeBody.total).toBe(3);
  });

  it("GET /api/entities hides archived features by default, including explicit type filters and relation lists", async () => {
    await seedEntity("person-arch", "Alice", "person");
    await seedEntity("feature-live", "Access Control Integration", "feature");
    await seedEntity("feature-arch", "Backend Work", "feature");
    await db.updateTable("entities").set({ status: "archived" }).where("id", "=", "feature-arch").execute();
    await seedRelation("rel-live", "person-arch", "feature-live", "contributes_to", "EXTRACTED", 0.95);
    await seedRelation("rel-arch", "person-arch", "feature-arch", "contributes_to", "EXTRACTED", 0.95);

    const defaultRes = await app.request("/api/entities", { headers: { Cookie: adminCookie } });
    const defaultBody = (await defaultRes.json()) as { entities: Array<{ id: string }>; total: number };
    expect(defaultBody.entities.map((entity) => entity.id).sort()).toEqual(["feature-live", "person-arch"]);

    const explicitRes = await app.request("/api/entities?type=feature", { headers: { Cookie: adminCookie } });
    const explicitBody = (await explicitRes.json()) as { entities: Array<{ id: string }>; total: number };
    expect(explicitBody.entities.map((entity) => entity.id)).toEqual(["feature-live"]);

    const includeRes = await app.request("/api/entities?type=feature&includeArchived=true", {
      headers: { Cookie: adminCookie },
    });
    const includeBody = (await includeRes.json()) as { entities: Array<{ id: string }>; total: number };
    expect(includeBody.entities.map((entity) => entity.id).sort()).toEqual(["feature-arch", "feature-live"]);

    const relationsRes = await app.request("/api/entities/person-arch/relations", { headers: { Cookie: adminCookie } });
    const relationsBody = (await relationsRes.json()) as { outgoing: Array<{ other: { id: string } }> };
    expect(relationsBody.outgoing.map((relation) => relation.other.id)).toEqual(["feature-live"]);
  });

  it("GET /api/entities/:id/timeline applies file RBAC, collapses per-file mentions, groups by month", async () => {
    await seedEntity("e1", "Sarah", "person");

    const scopeId = "scope-restricted-tl";
    await db
      .insertInto("connector_configs")
      .values({
        id: "cfg-scope-tl",
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: adminId,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await db
      .insertInto("access_scopes")
      .values({
        id: scopeId,
        connector_config_id: "cfg-scope-tl",
        scope_type: "shared_drive",
        provider_scope_id: "sd-tl",
        label: "Restricted",
      })
      .execute();

    // f-public mentioned twice (should collapse to one card with mentionCount=2)
    await seedFile("f-pub-may");
    await db
      .updateTable("indexed_files")
      .set({ source_updated_at: "2026-05-22T00:00:00.000Z", source_created_at: "2026-05-22T00:00:00.000Z" })
      .where("id", "=", "f-pub-may")
      .execute();
    await seedFile("f-pub-apr");
    await db
      .updateTable("indexed_files")
      .set({ source_updated_at: "2026-04-10T00:00:00.000Z", source_created_at: "2026-04-10T00:00:00.000Z" })
      .where("id", "=", "f-pub-apr")
      .execute();
    await seedFile("f-restricted", scopeId);
    await db
      .updateTable("indexed_files")
      .set({ source_updated_at: "2026-05-15T00:00:00.000Z", source_created_at: "2026-05-15T00:00:00.000Z" })
      .where("id", "=", "f-restricted")
      .execute();

    const now = new Date().toISOString();
    await db
      .insertInto("entity_mentions")
      .values([
        {
          id: "m1",
          entity_id: "e1",
          indexed_file_id: "f-pub-may",
          chunk_index: 0,
          context_snippet: "Sarah leads things",
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
        {
          id: "m1b",
          entity_id: "e1",
          indexed_file_id: "f-pub-may",
          chunk_index: 1,
          context_snippet: null,
          confidence: "INFERRED",
          source: "google_drive",
          relation: "authored",
          mentioned_at: now,
        },
        {
          id: "m2",
          entity_id: "e1",
          indexed_file_id: "f-pub-apr",
          chunk_index: 0,
          context_snippet: null,
          confidence: "INFERRED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
        {
          id: "m3",
          entity_id: "e1",
          indexed_file_id: "f-restricted",
          chunk_index: 0,
          context_snippet: null,
          confidence: "EXTRACTED",
          source: "google_drive",
          relation: "mentioned",
          mentioned_at: now,
        },
      ])
      .execute();

    const res = await app.request("/api/entities/e1/timeline", { headers: { Cookie: memberCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{
        month: string;
        items: Array<{ fileId: string; mentionCount: number; mentionConfidence: string }>;
      }>;
      totalCount: number;
    };
    // Member can't see f-restricted; expect two files across two months, newest-first.
    expect(body.groups.map((g) => g.month)).toEqual(["2026-05", "2026-04"]);
    const mayItems = body.groups[0].items;
    expect(mayItems).toHaveLength(1);
    expect(mayItems[0].fileId).toBe("f-pub-may");
    expect(mayItems[0].mentionCount).toBe(2);
    expect(mayItems[0].mentionConfidence).toBe("EXTRACTED");
    expect(body.totalCount).toBe(2);
  });
});

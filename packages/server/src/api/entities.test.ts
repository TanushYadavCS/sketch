import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { endRecreateLock, isRecreateActive } from "../entities/recreate-state";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

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
});

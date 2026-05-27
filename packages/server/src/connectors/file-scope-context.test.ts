/**
 * file-scope-context tests — three load-bearing scenarios:
 *
 * 1. Anchor resolution: corporate domain → company; personal/role-account →
 *    dropped. Without this filter, the prompt would prime on "gmail.com" or
 *    "noreply@…" and resolve to noise companies.
 * 2. Adjacency math: recency decay outranks raw count; sub-MIN_SCORE pairs
 *    drop; SYSTEM_SOURCE_TYPES (clickup_workspace/_space) never surface. If
 *    any of these slip, the prompt fills with stale or system-noise rows.
 * 3. Merge precedence + degradation: anchors + adjacency win over baseline on
 *    duplicate; an anchor-less file degrades to baseline-only (no regression).
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  HALF_LIFE_DAYS,
  MAX_ANCHORS_PER_SIDE,
  MIN_SCORE,
  PER_ANCHOR_INITIATIVE_CAP,
  PER_ANCHOR_TEAM_CAP,
  adjacencyForAnchor,
  buildFileScopedKnownEntities,
  resolveFileAnchors,
} from "./file-scope-context";

const CONNECTOR_ID = "cfg-fsc";

async function seedConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: "admin-fsc",
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: new Date().toISOString(),
      password_hash: "x",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: CONNECTOR_ID,
      connector_type: "fireflies",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "admin-fsc",
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string, sourceUpdatedAt: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: CONNECTOR_ID,
      provider_file_id: id,
      file_name: id,
      file_type: "meeting",
      content_category: "meeting",
      source: "fireflies",
      content_hash: `hash-${id}`,
      is_archived: 0,
      source_updated_at: sourceUpdatedAt,
      synced_at: now,
    })
    .execute();
}

async function seedEntity(
  db: Kysely<DB>,
  args: { id: string; name: string; sourceType: string; hotness?: number },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("entities")
    .values({
      id: args.id,
      name: args.name,
      source_type: args.sourceType,
      subtype: null,
      aliases: null,
      metadata: null,
      source_ref_id: null,
      status: "confirmed",
      hotness: args.hotness ?? 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedDomain(
  db: Kysely<DB>,
  args: { entityId: string | null; domain: string; kind: string },
): Promise<void> {
  await db
    .insertInto("entity_domains")
    .values({
      id: randomUUID(),
      entity_id: args.entityId,
      domain: args.domain,
      kind: args.kind,
      is_primary: 1,
      confidence: 1.0,
      source: "manual",
    })
    .execute();
}

async function seedAttendeeFact(db: Kysely<DB>, args: { fileId: string; name: string; email: string }): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: args.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: "admin-fsc",
    contentHash: `hash-${args.fileId}`,
    source: "fireflies",
    factType: "attendee",
    relation: "attended",
    subjectName: args.name,
    subjectEmail: args.email,
    subjectSource: "fireflies",
    subjectSourceId: `${args.fileId}:${args.email}`,
    raw: { providerFileId: args.fileId, attendee: { name: args.name, email: args.email } },
  });
}

async function seedMention(
  db: Kysely<DB>,
  args: { entityId: string; fileId: string; confidence?: string },
): Promise<void> {
  await db
    .insertInto("entity_mentions")
    .values({
      id: randomUUID(),
      entity_id: args.entityId,
      indexed_file_id: args.fileId,
      chunk_index: null,
      context_snippet: null,
      confidence: args.confidence ?? "EXTRACTED",
      source: "llm_extraction",
      relation: "mentioned",
      mentioned_at: new Date().toISOString(),
    })
    .execute();
}

describe("file-scope-context", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedConnector(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {
      // already destroyed
    }
  });

  it("resolves attendee email domains to company anchors, dropping personal and role accounts", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-ow", name: "Oliver Wyman", sourceType: "company", hotness: 0.9 });
    await seedDomain(db, { entityId: "ent-ow", domain: "oliverwyman.com", kind: "corporate" });

    await seedAttendeeFact(db, { fileId, name: "Client Rep", email: "rep@oliverwyman.com" });
    await seedAttendeeFact(db, { fileId, name: "Personal Acct", email: "alice@gmail.com" });
    await seedAttendeeFact(db, { fileId, name: "Role Mailbox", email: "noreply@oliverwyman.com" });
    await seedAttendeeFact(db, { fileId, name: "No At Sign", email: "broken" });

    const anchors = await resolveFileAnchors({ db }, fileId);
    expect(anchors.companies).toHaveLength(1);
    expect(anchors.companies[0]).toMatchObject({ id: "ent-ow", name: "Oliver Wyman" });
  });

  it("caps company anchors to the file-scope prompt budget", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);

    for (let i = 0; i < 10; i++) {
      const entityId = `ent-company-${i}`;
      const domain = `company-${i}.example`;
      await seedEntity(db, { id: entityId, name: `Company ${i}`, sourceType: "company", hotness: i });
      await seedDomain(db, { entityId, domain, kind: "corporate" });
      await seedAttendeeFact(db, { fileId, name: `Person ${i}`, email: `person@${domain}` });
    }

    const anchors = await resolveFileAnchors({ db }, fileId);
    expect(anchors.companies).toHaveLength(MAX_ANCHORS_PER_SIDE);
    expect(anchors.companies.map((company) => company.name)).toEqual(["Company 9", "Company 8", "Company 7"]);
  });

  it("recency-weighted adjacency outranks raw count, drops sub-MIN_SCORE pairs, and excludes system source types", async () => {
    await seedEntity(db, { id: "ent-anchor", name: "Anchor Co", sourceType: "company", hotness: 0.9 });
    await seedEntity(db, { id: "ent-recent", name: "Recent Project", sourceType: "project", hotness: 0.5 });
    await seedEntity(db, { id: "ent-older", name: "Older Project", sourceType: "project", hotness: 0.5 });
    await seedEntity(db, { id: "ent-ancient", name: "Ancient Project", sourceType: "project", hotness: 0.5 });
    await seedEntity(db, { id: "ent-system", name: "CU Workspace", sourceType: "clickup_workspace", hotness: 0.5 });

    const now = Date.UTC(2026, 4, 26);
    const dayMs = 24 * 60 * 60 * 1000;
    const recentDate = new Date(now - 5 * dayMs).toISOString();
    const olderDate = new Date(now - 90 * dayMs).toISOString();
    const ancientDate = new Date(now - 365 * dayMs).toISOString();

    const recentFile = "file-recent";
    const olderFile1 = "file-older-1";
    const olderFile2 = "file-older-2";
    const olderFile3 = "file-older-3";
    const ancientFile = "file-ancient";
    await seedFile(db, recentFile, recentDate);
    await seedFile(db, olderFile1, olderDate);
    await seedFile(db, olderFile2, olderDate);
    await seedFile(db, olderFile3, olderDate);
    await seedFile(db, ancientFile, ancientDate);

    await seedMention(db, { entityId: "ent-anchor", fileId: recentFile });
    await seedMention(db, { entityId: "ent-recent", fileId: recentFile });
    for (const f of [olderFile1, olderFile2, olderFile3]) {
      await seedMention(db, { entityId: "ent-anchor", fileId: f });
      await seedMention(db, { entityId: "ent-older", fileId: f });
      await seedMention(db, { entityId: "ent-system", fileId: f });
    }
    await seedMention(db, { entityId: "ent-anchor", fileId: ancientFile });
    await seedMention(db, { entityId: "ent-ancient", fileId: ancientFile });

    const adj = await adjacencyForAnchor({ db, now: () => now }, "ent-anchor");

    const ids = adj.map((a) => a.id);
    expect(ids).not.toContain("ent-system");
    expect(ids).not.toContain("ent-ancient");
    expect(ids[0]).toBe("ent-recent");

    const recent = adj.find((a) => a.id === "ent-recent");
    const older = adj.find((a) => a.id === "ent-older");
    expect(recent?.recentlyActive).toBe(true);
    expect(older?.recentlyActive).toBe(false);

    const expectedRecent = Math.exp(-5 / HALF_LIFE_DAYS);
    const expectedOlder = 3 * Math.exp(-90 / HALF_LIFE_DAYS);
    expect(recent?.score).toBeCloseTo(expectedRecent, 3);
    expect(older?.score).toBeCloseTo(expectedOlder, 3);
    expect((older?.score ?? 0) >= MIN_SCORE).toBe(true);
    expect((recent?.score ?? 0) > (older?.score ?? 0)).toBe(true);
  });

  it("merges anchors + adjacency above the baseline; degrades to baseline-only when no anchors resolve", async () => {
    await seedEntity(db, { id: "ent-ow", name: "Oliver Wyman", sourceType: "company", hotness: 0.9 });
    await seedEntity(db, { id: "ent-visa", name: "Visa Data Integration", sourceType: "project", hotness: 0.5 });
    await seedEntity(db, { id: "ent-sketch", name: "Sketch", sourceType: "product", hotness: 0.5 });
    await seedDomain(db, { entityId: "ent-ow", domain: "oliverwyman.com", kind: "corporate" });

    const now = Date.UTC(2026, 4, 26);
    const dayMs = 24 * 60 * 60 * 1000;
    const recentDate = new Date(now - 5 * dayMs).toISOString();

    const fileWithAnchor = "file-anchor";
    const fileWithoutAnchor = "file-noanchor";
    await seedFile(db, fileWithAnchor, recentDate);
    await seedFile(db, fileWithoutAnchor, recentDate);

    const coMentionFile = "file-comention";
    await seedFile(db, coMentionFile, recentDate);
    await seedMention(db, { entityId: "ent-ow", fileId: coMentionFile });
    await seedMention(db, { entityId: "ent-visa", fileId: coMentionFile });

    await seedAttendeeFact(db, { fileId: fileWithAnchor, name: "OW rep", email: "rep@oliverwyman.com" });

    const baseline = [
      { name: "Sketch", type: "product" },
      { name: "Oliver Wyman", type: "company" },
    ];

    const merged = await buildFileScopedKnownEntities({ db, now: () => now }, fileWithAnchor, baseline);
    const owEntry = merged.find((e) => e.name === "Oliver Wyman");
    const visaEntry = merged.find((e) => e.name === "Visa Data Integration");
    const sketchEntry = merged.find((e) => e.name === "Sketch");
    expect(owEntry).toBeDefined();
    expect(visaEntry).toMatchObject({ type: "project", recentlyActive: true });
    expect(visaEntry?.mentionCount).toBe(1);
    expect(sketchEntry).toBeDefined();
    expect(owEntry?.mentionCount).toBeUndefined();

    const degraded = await buildFileScopedKnownEntities({ db, now: () => now }, fileWithoutAnchor, baseline);
    expect(degraded.map((e) => e.name).sort()).toEqual(["Oliver Wyman", "Sketch"]);
  });

  it("caps per-anchor initiatives and teams while preserving baseline", async () => {
    await seedEntity(db, { id: "ent-anchor-cap", name: "Anchor Co", sourceType: "company", hotness: 0.9 });
    await seedDomain(db, { entityId: "ent-anchor-cap", domain: "anchor.example", kind: "corporate" });
    const now = Date.UTC(2026, 4, 26);
    const recentDate = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const promptFile = "file-cap-prompt";
    await seedFile(db, promptFile, recentDate);
    await seedAttendeeFact(db, { fileId: promptFile, name: "Anchor Person", email: "person@anchor.example" });

    for (let i = 0; i < 20; i++) {
      const entityId = `ent-project-${i}`;
      const fileId = `file-project-${i}`;
      await seedEntity(db, { id: entityId, name: `Project ${i}`, sourceType: "project", hotness: 0.5 });
      await seedFile(db, fileId, recentDate);
      await seedMention(db, { entityId: "ent-anchor-cap", fileId });
      await seedMention(db, { entityId, fileId });
    }
    for (let i = 0; i < 10; i++) {
      const entityId = `ent-team-${i}`;
      const fileId = `file-team-${i}`;
      await seedEntity(db, { id: entityId, name: `Team ${i}`, sourceType: "team", hotness: 0.5 });
      await seedFile(db, fileId, recentDate);
      await seedMention(db, { entityId: "ent-anchor-cap", fileId });
      await seedMention(db, { entityId, fileId });
    }

    const baseline = [{ name: "Baseline Product", type: "product" }];
    const known = await buildFileScopedKnownEntities({ db, now: () => now }, promptFile, baseline);

    expect(known.filter((entry) => entry.type === "project")).toHaveLength(PER_ANCHOR_INITIATIVE_CAP);
    expect(known.filter((entry) => entry.type === "team")).toHaveLength(PER_ANCHOR_TEAM_CAP);
    expect(known).toContainEqual({ name: "Baseline Product", type: "product" });
  });
});

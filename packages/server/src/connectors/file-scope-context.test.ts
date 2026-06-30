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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { loadBaselineKnownEntities } from "./enrichment";
import {
  BASELINE_ALWAYS_INCLUDE_CAP,
  BASELINE_RELEVANCE_CAP,
  HALF_LIFE_DAYS,
  HUB_PERSON_DEGREE_CAP,
  MAX_ANCHORS_PER_SIDE,
  MIN_SCORE,
  PENDING_PROPOSAL_MIN_OCCURRENCE,
  PER_ANCHOR_INITIATIVE_CAP,
  PER_ANCHOR_TEAM_CAP,
  adjacencyForAnchor,
  buildFileScopedKnownEntities,
  pendingProposalsForAnchor,
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
  args: {
    id: string;
    name: string;
    sourceType: string;
    hotness?: number;
    metadata?: Record<string, unknown>;
    provenanceTier?: string;
  },
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
      metadata: args.metadata ? JSON.stringify(args.metadata) : null,
      source_ref_id: null,
      status: "confirmed",
      provenance_tier: args.provenanceTier ?? "inferred",
      hotness: args.hotness ?? 0,
      created_at: now,
      updated_at: now,
      ai_brief: null,
    })
    .execute();
}

async function seedContactPoint(db: Kysely<DB>, args: { entityId: string; email: string }): Promise<void> {
  await db
    .insertInto("entity_contact_points")
    .values({
      id: randomUUID(),
      entity_id: args.entityId,
      kind: "email",
      value: args.email.toLowerCase(),
      display_value: args.email,
      label: null,
      is_primary: 1,
      source: "test",
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

async function seedReviewProposal(
  db: Kysely<DB>,
  args: {
    proposedName: string;
    entityType: string;
    evidenceFileIds: string[];
    occurrenceCount?: number;
    status?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("entity_review_queue")
    .values({
      id,
      proposed_name: args.proposedName,
      normalized_name: `${args.proposedName.toLowerCase()} ${id}`,
      entity_type: args.entityType,
      candidate_entity_id: null,
      candidate_score: null,
      candidate_reason: null,
      candidate_generated_at: now,
      first_seen_at: now,
      last_seen_at: now,
      occurrence_count: args.occurrenceCount ?? PENDING_PROPOSAL_MIN_OCCURRENCE,
      status: args.status ?? "pending",
      triggered_by_user_id: "admin-fsc",
    })
    .execute();

  for (const fileId of args.evidenceFileIds) {
    await db
      .insertInto("entity_review_evidence")
      .values({
        id: randomUUID(),
        review_id: id,
        indexed_file_id: fileId,
        source: "llm_extraction",
        note: null,
        seen_at: now,
      })
      .execute();
  }

  return id;
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

  it("returns pending proposals scoped to evidence files that mention the anchor", async () => {
    await seedEntity(db, { id: "ent-anchor-proposal", name: "Anchor Co", sourceType: "company" });
    await seedEntity(db, { id: "ent-other-proposal", name: "Other Co", sourceType: "company" });
    await seedFile(db, "file-anchor-proposal");
    await seedFile(db, "file-unrelated-proposal");
    await seedMention(db, { entityId: "ent-anchor-proposal", fileId: "file-anchor-proposal" });
    await seedMention(db, { entityId: "ent-other-proposal", fileId: "file-unrelated-proposal" });

    const matchingId = await seedReviewProposal(db, {
      proposedName: "Tourism Dashboard",
      entityType: "project",
      evidenceFileIds: ["file-anchor-proposal"],
    });
    await seedReviewProposal(db, {
      proposedName: "Unrelated Dashboard",
      entityType: "project",
      evidenceFileIds: ["file-unrelated-proposal"],
    });

    const proposals = await pendingProposalsForAnchor({ db }, "ent-anchor-proposal");

    expect(proposals).toEqual([
      {
        id: matchingId,
        name: "Tourism Dashboard",
        type: "project",
        score: PENDING_PROPOSAL_MIN_OCCURRENCE,
      },
    ]);
  });

  it("excludes below-threshold pending proposals and non-project/product proposal types", async () => {
    await seedEntity(db, { id: "ent-anchor-noise", name: "Anchor Co", sourceType: "company" });
    await seedFile(db, "file-anchor-noise");
    await seedMention(db, { entityId: "ent-anchor-noise", fileId: "file-anchor-noise" });
    await seedReviewProposal(db, {
      proposedName: "Single Mention Dashboard",
      entityType: "project",
      evidenceFileIds: ["file-anchor-noise"],
      occurrenceCount: PENDING_PROPOSAL_MIN_OCCURRENCE - 1,
    });
    await seedReviewProposal(db, {
      proposedName: "Queued Company",
      entityType: "company",
      evidenceFileIds: ["file-anchor-noise"],
      occurrenceCount: PENDING_PROPOSAL_MIN_OCCURRENCE,
    });

    const proposals = await pendingProposalsForAnchor({ db }, "ent-anchor-noise");

    expect(proposals).toEqual([]);
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

  it("adds novel pending proposals after confirmed known entities win duplicate keys", async () => {
    await seedEntity(db, { id: "ent-pending-anchor", name: "Pending Anchor Co", sourceType: "company", hotness: 1 });
    await seedDomain(db, { entityId: "ent-pending-anchor", domain: "pending-anchor.example", kind: "corporate" });
    await seedFile(db, "file-pending-build");
    await seedAttendeeFact(db, {
      fileId: "file-pending-build",
      name: "Anchor Person",
      email: "person@pending-anchor.example",
    });

    const loadAdjacencyForAnchor = vi.fn(async () => []);
    const loadPendingProposalsForAnchor = vi.fn(async () => [
      { id: "pending-tourism", name: "Tourism Dashboard", type: "project" as const, score: 4 },
      { id: "pending-maaden", name: "Maaden Dashboard", type: "project" as const, score: 3 },
    ]);

    const known = await buildFileScopedKnownEntities(
      { db, experimentalFlag: true, loadAdjacencyForAnchor, loadPendingProposalsForAnchor },
      "file-pending-build",
      [{ name: "Tourism Dashboard", type: "project", description: "confirmed" }],
    );

    const tourismEntries = known.filter((entry) => entry.name === "Tourism Dashboard" && entry.type === "project");
    expect(tourismEntries).toHaveLength(1);
    expect(tourismEntries[0]).toMatchObject({ name: "Tourism Dashboard", type: "project", description: "confirmed" });
    expect(known.find((entry) => entry.name === "Maaden Dashboard")).toMatchObject({
      name: "Maaden Dashboard",
      type: "project",
      reviewId: "pending-maaden",
    });
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

  it("caps ranked baseline entries by hotness when no other signal differentiates them", async () => {
    const fileId = "file-baseline-cap";
    await seedFile(db, fileId);
    const baseline = Array.from({ length: 200 }, (_, i) => ({
      id: `baseline-product-${i}`,
      name: `Baseline Product ${i}`,
      type: "product",
      hotness: i,
    }));

    const known = await buildFileScopedKnownEntities({ db }, fileId, baseline, "");
    const baselineEntries = known.filter((entry) => entry.type === "product");

    expect(baselineEntries).toHaveLength(BASELINE_RELEVANCE_CAP);
    expect(baselineEntries.map((entry) => entry.name)).toEqual(
      Array.from({ length: BASELINE_RELEVANCE_CAP }, (_, i) => `Baseline Product ${199 - i}`),
    );
  });

  it("ranks anchor-overlapping baseline entries above hotter unrelated entries", async () => {
    await seedEntity(db, { id: "ent-anchor-baseline", name: "Anchor Co", sourceType: "company", hotness: 0.9 });
    await seedEntity(db, { id: "baseline-overlap", name: "Relevant Product", sourceType: "product", hotness: 5 });
    await seedEntity(db, { id: "baseline-hot", name: "Hot Product", sourceType: "product", hotness: 50 });
    await seedDomain(db, { entityId: "ent-anchor-baseline", domain: "anchor-baseline.example", kind: "corporate" });

    const promptFile = "file-baseline-overlap";
    const coMentionFile = "file-baseline-comention";
    const recentDate = new Date(Date.UTC(2026, 4, 25)).toISOString();
    await seedFile(db, promptFile, recentDate);
    await seedFile(db, coMentionFile, recentDate);
    await seedAttendeeFact(db, {
      fileId: promptFile,
      name: "Anchor Person",
      email: "person@anchor-baseline.example",
    });
    await seedMention(db, { entityId: "ent-anchor-baseline", fileId: coMentionFile });
    await seedMention(db, { entityId: "baseline-overlap", fileId: coMentionFile });

    const known = await buildFileScopedKnownEntities(
      { db, now: () => Date.UTC(2026, 4, 26) },
      promptFile,
      [
        { id: "baseline-overlap", name: "Relevant Product", type: "product", hotness: 5 },
        { id: "baseline-hot", name: "Hot Product", type: "product", hotness: 50 },
      ],
      "",
      { baselineRelevanceCap: 1 },
    );

    expect(known.map((entry) => entry.name)).toContain("Relevant Product");
    expect(known.map((entry) => entry.name)).not.toContain("Hot Product");
  });

  it("always includes verbatim baseline matches even when ranked baseline cap is zero", async () => {
    const fileId = "file-baseline-verbatim";
    await seedFile(db, fileId);

    const known = await buildFileScopedKnownEntities(
      { db },
      fileId,
      [{ id: "baseline-sketch", name: "Sketch", type: "product", hotness: 0 }],
      "The team discussed Sketch and its access model.",
      { baselineRelevanceCap: 0 },
    );

    expect(known.find((entry) => entry.name === "Sketch")).toMatchObject({
      name: "Sketch",
      type: "product",
      entityId: "baseline-sketch",
      description: undefined,
      mentionCount: undefined,
      recentlyActive: undefined,
    });
  });

  it("loadBaselineKnownEntities excludes inferred products while preserving declared products and teams", async () => {
    await seedEntity(db, {
      id: "baseline-product-inferred",
      name: "Inferred Product",
      sourceType: "product",
      provenanceTier: "inferred",
    });
    await seedEntity(db, {
      id: "baseline-product-declared",
      name: "Declared Product",
      sourceType: "product",
      provenanceTier: "declared",
    });
    await seedEntity(db, {
      id: "baseline-product-confirmed",
      name: "Confirmed Product",
      sourceType: "product",
      provenanceTier: "human_confirmed",
    });
    await seedEntity(db, {
      id: "baseline-team-inferred",
      name: "Inferred Team",
      sourceType: "team",
      provenanceTier: "inferred",
    });

    const baseline = await loadBaselineKnownEntities(db);
    const names = baseline.map((entry) => entry.name);

    expect(names).not.toContain("Inferred Product");
    expect(names).toEqual(expect.arrayContaining(["Declared Product", "Confirmed Product", "Inferred Team"]));
  });

  it("uses person anchors when company anchoring fails and skips ambiguous participant emails", async () => {
    const now = Date.UTC(2026, 4, 26);
    const recentDate = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const promptFile = "file-person-anchor-prompt";
    const aliceEvidenceFile = "file-person-anchor-alice-evidence";
    const ambiguousEvidenceFile = "file-person-anchor-ambiguous-evidence";
    await seedFile(db, promptFile, recentDate);
    await seedFile(db, aliceEvidenceFile, recentDate);
    await seedFile(db, ambiguousEvidenceFile, recentDate);

    await seedEntity(db, { id: "person-alice", name: "Alice Internal", sourceType: "person", hotness: 5 });
    await seedContactPoint(db, { entityId: "person-alice", email: "alice@internal.test" });
    await seedEntity(db, { id: "project-alice", name: "Internal Atlas", sourceType: "project", hotness: 5 });
    await seedEntity(db, { id: "person-ambiguous-a", name: "Ambiguous A", sourceType: "person", hotness: 10 });
    await seedEntity(db, { id: "person-ambiguous-b", name: "Ambiguous B", sourceType: "person", hotness: 9 });
    await seedContactPoint(db, { entityId: "person-ambiguous-a", email: "shared@internal.test" });
    await seedContactPoint(db, { entityId: "person-ambiguous-b", email: "shared@internal.test" });
    await seedEntity(db, { id: "project-ambiguous", name: "Ambiguous Project", sourceType: "project", hotness: 20 });

    await seedAttendeeFact(db, { fileId: promptFile, name: "Alice", email: "alice@internal.test" });
    await seedAttendeeFact(db, { fileId: promptFile, name: "Shared", email: "shared@internal.test" });
    await seedMention(db, { entityId: "person-alice", fileId: aliceEvidenceFile });
    await seedMention(db, { entityId: "project-alice", fileId: aliceEvidenceFile });
    await seedMention(db, { entityId: "person-ambiguous-a", fileId: ambiguousEvidenceFile });
    await seedMention(db, { entityId: "project-ambiguous", fileId: ambiguousEvidenceFile });

    const companyOnly = await buildFileScopedKnownEntities({ db, now: () => now }, promptFile, [], "");
    const personAnchored = await buildFileScopedKnownEntities(
      { db, now: () => now, experimentalFlag: true },
      promptFile,
      [],
      "",
    );

    expect(companyOnly).toEqual([]);
    expect(personAnchored.find((entry) => entry.name === "Internal Atlas")).toMatchObject({
      name: "Internal Atlas",
      type: "project",
      entityId: "project-alice",
      mentionCount: 1,
      recentlyActive: true,
    });
    expect(personAnchored.map((entry) => entry.name)).not.toContain("Alice Internal");
    expect(personAnchored.map((entry) => entry.name)).not.toContain("Ambiguous Project");
  });

  it("skips hub person anchors before adjacency while retaining low-degree person adjacency", async () => {
    const now = Date.UTC(2026, 4, 26);
    const recentDate = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const promptFile = "file-hub-person-prompt";
    const lowEvidenceFile = "file-low-person-evidence";
    await seedFile(db, promptFile, recentDate);
    await seedFile(db, lowEvidenceFile, recentDate);
    await seedEntity(db, { id: "person-hub", name: "Hub Person", sourceType: "person", hotness: 100 });
    await seedEntity(db, { id: "person-low", name: "Low Degree Person", sourceType: "person", hotness: 1 });
    await seedContactPoint(db, { entityId: "person-hub", email: "hub@internal.test" });
    await seedContactPoint(db, { entityId: "person-low", email: "low@internal.test" });
    await seedEntity(db, { id: "project-low", name: "Low Degree Project", sourceType: "project", hotness: 5 });
    await seedAttendeeFact(db, { fileId: promptFile, name: "Hub", email: "hub@internal.test" });
    await seedAttendeeFact(db, { fileId: promptFile, name: "Low", email: "low@internal.test" });
    await seedMention(db, { entityId: "person-low", fileId: lowEvidenceFile });
    await seedMention(db, { entityId: "project-low", fileId: lowEvidenceFile });

    for (let i = 0; i <= HUB_PERSON_DEGREE_CAP; i++) {
      const fileId = `file-hub-evidence-${i}`;
      const projectId = `project-hub-${i}`;
      await seedFile(db, fileId, recentDate);
      await seedEntity(db, { id: projectId, name: `Hub Project ${i}`, sourceType: "project", hotness: i });
      await seedMention(db, { entityId: "person-hub", fileId });
      await seedMention(db, { entityId: projectId, fileId });
    }

    const adjacencyCalls: string[] = [];
    const loadAdjacencyForAnchor = vi.fn(async (deps, anchorId: string) => {
      adjacencyCalls.push(anchorId);
      return adjacencyForAnchor(deps, anchorId);
    });
    const known = await buildFileScopedKnownEntities(
      { db, now: () => now, experimentalFlag: true, loadAdjacencyForAnchor },
      promptFile,
      [],
      "",
    );

    expect(adjacencyCalls).not.toContain("person-hub");
    expect(adjacencyCalls).toContain("person-low");
    expect(known.map((entry) => entry.name)).toContain("Low Degree Project");
    expect(known.map((entry) => entry.name).some((name) => name.startsWith("Hub Project"))).toBe(false);
  });

  it("keeps company-only ranking unchanged with flag off and bounds project baseline expansion with flag on", async () => {
    const now = Date.UTC(2026, 4, 26);
    const recentDate = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const promptFile = "file-flag-off-parity";
    const coMentionFile = "file-flag-off-parity-evidence";
    await seedFile(db, promptFile, recentDate);
    await seedFile(db, coMentionFile, recentDate);
    await seedEntity(db, { id: "ent-parity-company", name: "Parity Co", sourceType: "company", hotness: 10 });
    await seedEntity(db, {
      id: "ent-parity-product",
      name: "Parity Product",
      sourceType: "product",
      hotness: 10,
      provenanceTier: "declared",
    });
    await seedDomain(db, { entityId: "ent-parity-company", domain: "parity.example", kind: "corporate" });
    await seedAttendeeFact(db, { fileId: promptFile, name: "Parity Person", email: "person@parity.example" });
    await seedMention(db, { entityId: "ent-parity-company", fileId: coMentionFile });
    await seedMention(db, { entityId: "ent-parity-product", fileId: coMentionFile });

    const baseline = [
      { id: "baseline-cold", name: "Cold Product", type: "product", hotness: 1 },
      { id: "ent-parity-product", name: "Parity Product", type: "product", hotness: 10 },
    ];
    const legacyFlagOmitted = await buildFileScopedKnownEntities({ db, now: () => now }, promptFile, baseline, "");
    const explicitFlagOff = await buildFileScopedKnownEntities(
      { db, now: () => now, experimentalFlag: false },
      promptFile,
      baseline,
      "",
    );
    expect(explicitFlagOff).toEqual(legacyFlagOmitted);

    for (let i = 0; i < 80; i++) {
      await seedEntity(db, {
        id: `baseline-project-${i}`,
        name: `Bounded Project ${i}`,
        sourceType: "project",
        hotness: i,
      });
    }
    const baselineFlagOff = await loadBaselineKnownEntities(db, { experimentalFlag: false });
    const baselineFlagOn = await loadBaselineKnownEntities(db, { experimentalFlag: true });
    expect(baselineFlagOff.map((entry) => entry.type)).not.toContain("project");
    expect(baselineFlagOn.map((entry) => entry.name)).toContain("Bounded Project 79");

    const content = Array.from({ length: 80 }, (_, i) => `Bounded Project ${i}`).join("\n");
    const known = await buildFileScopedKnownEntities(
      { db, now: () => now, experimentalFlag: true },
      "file-baseline-bound",
      baselineFlagOn,
      content,
    );
    expect(known.filter((entry) => entry.type === "project").length).toBeLessThanOrEqual(
      BASELINE_ALWAYS_INCLUDE_CAP + BASELINE_RELEVANCE_CAP,
    );
  });
});

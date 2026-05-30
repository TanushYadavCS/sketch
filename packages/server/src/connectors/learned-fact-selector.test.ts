import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  MAX_FACTS_CHARS_PER_ENTITY,
  buildFactSelectionContext,
  createFactSelectionCache,
  renderFactsForPrompt,
  selectRelevantFacts,
} from "./learned-fact-selector";

const CONNECTOR_ID = "cfg-lfs";

async function seedBase(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: "admin-lfs",
      name: "Admin",
      email: "admin-lfs@example.com",
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
      created_by: "admin-lfs",
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
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
      source_updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    })
    .execute();
}

async function seedAttendee(db: Kysely<DB>, fileId: string, email: string): Promise<void> {
  await db
    .insertInto("indexed_file_facts")
    .values({
      id: randomUUID(),
      fact_key: `attendee:${fileId}:${email}`,
      indexed_file_id: fileId,
      connector_config_id: CONNECTOR_ID,
      created_by_user_id: "admin-lfs",
      content_hash: `hash-${fileId}`,
      source: "fireflies",
      fact_type: "attendee",
      relation: "attended",
      subject_name: email,
      subject_email: email,
      subject_source: "fireflies",
      subject_source_id: `${fileId}:${email}`,
      context_snippet: null,
      raw: "{}",
      materialized_at: null,
      deleted_at: null,
      last_seen_sync_run_id: null,
    })
    .execute();
}

describe("learned-fact-selector", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedBase(db);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("caps selected facts and rendered prompt chars", async () => {
    const fileId = "current-cap";
    await seedFile(db, fileId);
    const context = await buildFactSelectionContext(db, fileId, []);
    const facts = Array.from({ length: 200 }, (_, i) => ({
      fact: `fact ${i} ${"x".repeat(240)}`,
      learned_at: `2026-05-${String((i % 20) + 1).padStart(2, "0")}`,
    }));

    const selected = await selectRelevantFacts(
      { db, now: () => Date.UTC(2026, 4, 27) },
      { entityId: "entity-1", learnedFacts: facts },
      context,
      createFactSelectionCache(),
    );
    const rendered = renderFactsForPrompt(selected);

    expect(selected).toHaveLength(10);
    expect(rendered.length).toBeLessThanOrEqual(MAX_FACTS_CHARS_PER_ENTITY);
  });

  it("ranks source-file overlap above slightly newer unrelated facts", async () => {
    const currentFile = "current-overlap";
    const olderSource = "source-overlap";
    const newerSource = "source-unrelated";
    await seedFile(db, currentFile);
    await seedFile(db, olderSource);
    await seedFile(db, newerSource);
    await seedAttendee(db, currentFile, "client@acme.com");
    await seedAttendee(db, olderSource, "client@acme.com");
    await seedAttendee(db, newerSource, "other@example.com");

    const context = await buildFactSelectionContext(db, currentFile, []);
    const selected = await selectRelevantFacts(
      { db, now: () => Date.UTC(2026, 4, 27) },
      {
        entityId: "entity-1",
        learnedFacts: [
          { fact: "older but same attendee", source_file_id: olderSource, learned_at: "2026-05-25" },
          { fact: "newer but unrelated", source_file_id: newerSource, learned_at: "2026-05-26" },
        ],
      },
      context,
      createFactSelectionCache(),
      { maxFacts: 1 },
    );

    expect(selected.map((fact) => fact.fact)).toEqual(["older but same attendee"]);
  });

  it("keeps legacy facts eligible with append-order fallback", async () => {
    const fileId = "current-legacy";
    await seedFile(db, fileId);
    const context = await buildFactSelectionContext(db, fileId, []);
    const facts = Array.from({ length: 50 }, (_, i) => ({ fact: `legacy fact ${i}` }));

    const selected = await selectRelevantFacts(
      { db, now: () => Date.UTC(2026, 4, 27) },
      { entityId: "entity-1", learnedFacts: facts },
      context,
      createFactSelectionCache(),
    );

    expect(selected).toHaveLength(10);
    expect(selected[0].fact).toBe("legacy fact 49");
  });
});

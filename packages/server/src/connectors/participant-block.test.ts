/**
 * participant-block tests — three load-bearing scenarios:
 *
 * 1. Block rendering on the canonical OW <> Canvas mixed-attendee shape:
 *    home-domain + external-domain attendees, action-item ownership flagged
 *    where the body's `## Action Items` section names the person, and order
 *    is deterministic. If this slips, the prompt either misses the
 *    cross-company signal or drowns it in unstable diff noise.
 * 2. Action-item owner tagging across realistic formatting variation —
 *    middle initials, extra whitespace, mixed case. Without robust
 *    normalization, real Fireflies output (where the attendee list uses
 *    "Vedant Parikh" but the action item uses "Vedant K. Parikh") loses
 *    the owner flag and silently degrades into "everyone is silent".
 * 3. Cross-domain attendee without a resolved company falls back to
 *    "external (no resolved company)" — the LLM still sees the cross-domain
 *    shape without us asserting a specific endpoint we can't back up.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { buildParticipantBlock, parseActionItemOwners } from "./participant-block";

const CONNECTOR_ID = "cfg-pb";

async function seedConnector(db: Kysely<DB>): Promise<void> {
  await db
    .insertInto("users")
    .values({
      id: "admin-pb",
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
      created_by: "admin-pb",
    })
    .execute();
}

async function seedFile(db: Kysely<DB>, id: string): Promise<void> {
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
      source_updated_at: now,
      synced_at: now,
    })
    .execute();
}

async function seedEntity(db: Kysely<DB>, args: { id: string; name: string; sourceType: string }): Promise<void> {
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
      hotness: 0,
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

async function seedAttendee(db: Kysely<DB>, args: { fileId: string; name: string; email: string }): Promise<void> {
  const repo = createIndexedFileFactRepository(db);
  await repo.upsertFact({
    indexedFileId: args.fileId,
    connectorConfigId: CONNECTOR_ID,
    createdByUserId: "admin-pb",
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

const CANVAS_OW_BODY = `# OW <> Canvas Standup
Date: 2026-05-25

## Summary
- Visa Data Integration: progressing well.
- Aviation Edge scraper: backfilling.

## Action Items
-
**Vedant Parikh**
Continue Aviation Edge scraper backfill (05:00)
Share SERP API details (12:00)

**Himanshu Kalra**
Share cost details for the paid Purpose of Travel data (14:45)

**Ohoud Zitan**
Provide updated purpose of travel data (06:16)
`;

describe("participant-block", () => {
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

  it("renders an OW <> Canvas-shape block with action-item owners flagged and deterministic ordering", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-canvas", name: "Canvas", sourceType: "company" });
    await seedEntity(db, { id: "ent-ow", name: "Oliver Wyman", sourceType: "company" });
    await seedDomain(db, { entityId: "ent-canvas", domain: "canvasx.ai", kind: "corporate" });
    await seedDomain(db, { entityId: "ent-ow", domain: "oliverwyman.com", kind: "corporate" });

    await seedAttendee(db, { fileId, name: "Vedant Parikh", email: "vedant@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Himanshu Kalra", email: "himanshu@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Apeksha Maithani", email: "apeksha@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Sukumar Sannareddy", email: "sukumar@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Ohoud Zitan", email: "ohoud.zitan@oliverwyman.com" });
    await seedAttendee(db, { fileId, name: "Shikah Alshuwaish", email: "shikah.alshuwaish@oliverwyman.com" });

    const block = await buildParticipantBlock({ db }, { fileId, fileContent: CANVAS_OW_BODY });

    expect(block).toContain("## Meeting participants");
    expect(block).toContain("Vedant Parikh — Canvas (vedant@canvasx.ai) [action-item owner]");
    expect(block).toContain("Himanshu Kalra — Canvas (himanshu@canvasx.ai) [action-item owner]");
    expect(block).toContain("Ohoud Zitan — Oliver Wyman (ohoud.zitan@oliverwyman.com) [action-item owner]");
    expect(block).toContain("Shikah Alshuwaish — Oliver Wyman (shikah.alshuwaish@oliverwyman.com)");
    expect(block).not.toContain(
      "Shikah Alshuwaish — Oliver Wyman (shikah.alshuwaish@oliverwyman.com) [action-item owner]",
    );
    expect(block).toContain("Apeksha Maithani — Canvas (apeksha@canvasx.ai)");
    expect(block).not.toContain("Apeksha Maithani — Canvas (apeksha@canvasx.ai) [action-item owner]");

    const lines = block.split("\n").filter((l) => l.startsWith("- "));
    const names = lines.map((l) => l.slice(2).split(" — ")[0]);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it("tags action-item owners robustly across middle initials, mixed case, and extra whitespace", async () => {
    const body = `## Action Items
-
**Vedant K. Parikh**
Task A (00:00)

**  HIMANSHU   KALRA  **
Task B (01:00)
`;
    const owners = parseActionItemOwners(body);
    expect(owners).toContain("Vedant K. Parikh");
    expect(owners).toContain("HIMANSHU   KALRA");

    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-canvas-2", name: "Canvas", sourceType: "company" });
    await seedDomain(db, { entityId: "ent-canvas-2", domain: "canvasx.ai", kind: "corporate" });
    await seedAttendee(db, { fileId, name: "Vedant Parikh", email: "vedant@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Himanshu Kalra", email: "himanshu@canvasx.ai" });

    const block = await buildParticipantBlock({ db }, { fileId, fileContent: body });
    expect(block).toContain("Vedant Parikh — Canvas (vedant@canvasx.ai) [action-item owner]");
    expect(block).toContain("Himanshu Kalra — Canvas (himanshu@canvasx.ai) [action-item owner]");
  });

  it("renders cross-domain attendees without a resolved company as 'external (no resolved company)' and drops role accounts", async () => {
    const fileId = randomUUID();
    await seedFile(db, fileId);
    await seedEntity(db, { id: "ent-canvas-3", name: "Canvas", sourceType: "company" });
    await seedDomain(db, { entityId: "ent-canvas-3", domain: "canvasx.ai", kind: "corporate" });

    await seedAttendee(db, { fileId, name: "Vedant Parikh", email: "vedant@canvasx.ai" });
    await seedAttendee(db, { fileId, name: "Unknown Client", email: "client@somebodyelse.com" });
    await seedAttendee(db, { fileId, name: "Role Mailbox", email: "noreply@somebodyelse.com" });
    await seedAttendee(db, { fileId, name: "Personal Acct", email: "stranger@gmail.com" });

    const block = await buildParticipantBlock({ db }, { fileId, fileContent: "no action items here" });
    expect(block).toContain("Vedant Parikh — Canvas (vedant@canvasx.ai)");
    expect(block).toContain("Unknown Client — external (no resolved company) (client@somebodyelse.com)");
    expect(block).not.toContain("Role Mailbox");
    expect(block).not.toContain("Personal Acct");
  });
});

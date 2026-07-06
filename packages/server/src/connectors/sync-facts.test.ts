import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIndexedFileFactRepository, upsertLlmTaskFact } from "../db/repositories/indexed-file-facts";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { emitFactsForSyncedItem } from "./sync-facts";
import type { Connector, ConnectorCredentials, SyncedItem } from "./types";

const testConnector: Connector = {
  type: "google_drive",
  perUserAuth: true,
  requiresOAuthClientSetup: true,
  promotableFileTypes: [],
  async validateCredentials(_credentials: ConnectorCredentials): Promise<void> {},
  async *sync(): AsyncGenerator<SyncedItem> {},
  async getCursor(): Promise<string | null> {
    return null;
  },
};

const baseItem: SyncedItem = {
  providerFileId: "email-1",
  providerUrl: "https://mail.example/email-1",
  fileName: "Email",
  fileType: "email_message",
  contentCategory: "document",
  content: "Subject: Hello",
  sourcePath: null,
  contentHash: "hash-1",
  sourceCreatedAt: null,
  sourceUpdatedAt: null,
};

describe("emitFactsForSyncedItem", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedIndexedFile(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("emits contact point facts from synced items", async () => {
    const factRepo = createIndexedFileFactRepository(db);

    await emitFactsForSyncedItem({
      factRepo,
      connector: testConnector,
      connectorType: "google_drive",
      factContext: {
        connectorConfigId: "connector-1",
        createdByUserId: "user-1",
        lastSeenSyncRunId: "run-1",
      },
      indexedFileId: "file-1",
      item: {
        ...baseItem,
        contactPoints: [
          {
            subjectName: "Simran Suri",
            subjectEmail: "simran@example.com",
            subjectSource: "google_drive",
            subjectSourceId: "email-1:simran@example.com",
            kind: "email",
            value: "simran@example.com",
            source: "google_drive",
          },
        ],
      },
    });

    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact).toMatchObject({
      indexed_file_id: "file-1",
      connector_config_id: "connector-1",
      source: "google_drive",
      fact_type: "contact_point",
      relation: "contactable",
      subject_name: "Simran Suri",
      subject_email: "simran@example.com",
      subject_source: "google_drive",
      subject_source_id: "email-1:simran@example.com",
    });
    expect(JSON.parse(fact.raw ?? "{}").contactPoint.value).toBe("simran@example.com");
  });

  it("emits email correspondents without attendee or author facts when opted in", async () => {
    const factRepo = createIndexedFileFactRepository(db);

    await emitFactsForSyncedItem({
      factRepo,
      connector: testConnector,
      connectorType: "google_drive",
      factContext: {
        connectorConfigId: "connector-1",
        createdByUserId: "user-1",
        lastSeenSyncRunId: "run-1",
      },
      item: {
        ...baseItem,
        authorEmail: "jane.doe@example.com",
        attendees: [{ email: "bob.smith@example.com" }, { name: "Alice Sender", email: "alice@example.com" }],
      },
      indexedFileId: "file-1",
      emitCorrespondentFacts: true,
    });

    const rows = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "relation", "subject_name", "subject_email", "subject_source_id"])
      .orderBy("subject_email")
      .execute();

    expect(rows).toEqual([
      {
        fact_type: "correspondent",
        relation: "corresponded",
        subject_name: "Alice Sender",
        subject_email: "alice@example.com",
        subject_source_id: "email-1:alice@example.com",
      },
      {
        fact_type: "correspondent",
        relation: "corresponded",
        subject_name: "Bob Smith",
        subject_email: "bob.smith@example.com",
        subject_source_id: "email-1:bob.smith@example.com",
      },
      {
        fact_type: "correspondent",
        relation: "corresponded",
        subject_name: "Jane Doe",
        subject_email: "jane.doe@example.com",
        subject_source_id: "email-1:jane.doe@example.com",
      },
    ]);
  });

  it("derives attendee names from email-only participants", async () => {
    const factRepo = createIndexedFileFactRepository(db);

    await emitFactsForSyncedItem({
      factRepo,
      connector: testConnector,
      connectorType: "google_drive",
      factContext: {
        connectorConfigId: "connector-1",
        createdByUserId: "user-1",
        lastSeenSyncRunId: "run-1",
      },
      item: {
        ...baseItem,
        attendees: [{ email: "email.only@example.com" }, { name: "Named Attendee", email: "named@example.com" }],
      },
      indexedFileId: "file-1",
    });

    const rows = await db
      .selectFrom("indexed_file_facts")
      .select(["fact_type", "relation", "subject_name", "subject_email"])
      .orderBy("subject_email")
      .execute();

    expect(rows).toEqual([
      {
        fact_type: "attendee",
        relation: "attended",
        subject_name: "Email Only",
        subject_email: "email.only@example.com",
      },
      {
        fact_type: "attendee",
        relation: "attended",
        subject_name: "Named Attendee",
        subject_email: "named@example.com",
      },
    ]);
  });

  it("keeps unchanged LLM task facts seen in the current sync run", async () => {
    const factRepo = createIndexedFileFactRepository(db);
    await upsertLlmTaskFact(db, {
      experimentalFlag: true,
      indexedFileId: "file-1",
      connectorConfigId: "connector-1",
      createdByUserId: "user-1",
      lastSeenSyncRunId: "run-1",
      contentHash: "hash-1",
      source: "google_drive",
      candidate: {
        title: "Ship Slack capture",
        owner: { name: "Jane Doe" },
        hasOwnerVerbObject: true,
      },
      corroborationKey: "ship-slack-capture",
      evidence: { fileIds: ["file-1"], entityIds: [] },
      promptVersion: "llm-task-v1",
    });

    await emitFactsForSyncedItem({
      db,
      factRepo,
      connector: testConnector,
      connectorType: "google_drive",
      factContext: {
        connectorConfigId: "connector-1",
        createdByUserId: "user-1",
        lastSeenSyncRunId: "run-2",
      },
      item: baseItem,
      indexedFileId: "file-1",
      experimentalFlag: true,
      contentChanged: false,
    });

    const fact = await db
      .selectFrom("indexed_file_facts")
      .select(["last_seen_sync_run_id", "deleted_at"])
      .where("fact_type", "=", "llm_task")
      .executeTakeFirstOrThrow();
    expect(fact).toEqual({ last_seen_sync_run_id: "run-2", deleted_at: null });
  });
});

async function seedIndexedFile(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: "user-1",
      name: "Admin",
      email: "admin@example.com",
      email_verified_at: now,
      password_hash: "hash",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values({
      id: "connector-1",
      connector_type: "google_drive",
      auth_type: "oauth",
      credentials: "{}",
      created_by: "user-1",
    })
    .execute();
  await db
    .insertInto("indexed_files")
    .values({
      id: "file-1",
      connector_config_id: "connector-1",
      provider_file_id: "email-1",
      file_name: "Email",
      file_type: "email_message",
      content_category: "document",
      source: "google_drive",
      content_hash: "hash-1",
      synced_at: now,
    })
    .execute();
}

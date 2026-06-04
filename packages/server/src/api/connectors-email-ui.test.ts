/**
 * Route tests for the Gmail connector UI surfaces (GMAIL_CONNECTOR_UI §U3/§U4):
 * suppressed-email transparency and thread-grouped email reads.
 */
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password";
import { createConnectorRepository } from "../db/repositories/connectors";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { createApp } from "../http";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";

const config = createTestConfig();
const logger = createTestLogger();

const ADMIN_EMAIL = "admin@test.com";
const OWNER_EMAIL = "owner@test.com";
const OTHER_EMAIL = "other@test.com";
const PASSWORD = "testpassword123";

async function seedUsers(db: Kysely<DB>) {
  const settings = createSettingsRepository(db);
  const users = createUserRepository(db);
  const hash = await hashPassword(PASSWORD);
  await settings.create();
  await users.create({ name: "admin", email: ADMIN_EMAIL, emailVerified: true, passwordHash: hash, authRole: "admin" });
  await users.create({
    name: "owner",
    email: OWNER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await users.create({
    name: "other",
    email: OTHER_EMAIL,
    emailVerified: true,
    passwordHash: hash,
    authRole: "member",
  });
  await settings.update({ onboardingCompletedAt: new Date().toISOString() });
}

async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return res.headers.get("set-cookie") ?? "";
}

async function userIdFor(db: Kysely<DB>, email: string): Promise<string> {
  const u = await createUserRepository(db).findByEmail(email);
  if (!u) throw new Error(`user ${email} missing`);
  return u.id;
}

async function insertGmailConfig(db: Kysely<DB>, createdBy: string) {
  return createConnectorRepository(db).createConfig({
    connectorType: "gmail",
    authType: "oauth",
    credentials: JSON.stringify({ type: "api_key", api_key: "stub" }),
    createdBy,
  });
}

async function insertSuppressed(
  db: Kysely<DB>,
  opts: { connectorConfigId: string; reason: string; observedAt: string; providerFileId?: string },
) {
  await db
    .insertInto("email_suppressed_messages")
    .values({
      id: randomUUID(),
      connector_config_id: opts.connectorConfigId,
      provider_file_id: opts.providerFileId ?? `pf-${randomUUID()}`,
      provider_message_id: `<${randomUUID()}@example.com>`,
      thread_id: null,
      reason: opts.reason,
      observed_at: opts.observedAt,
    })
    .execute();
}

describe("GET /:id/suppressed-emails (U3)", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let ownerCookie: string;
  let otherCookie: string;
  let ownerId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, config, { logger });
    adminCookie = await login(app, ADMIN_EMAIL);
    ownerCookie = await login(app, OWNER_EMAIL);
    otherCookie = await login(app, OTHER_EMAIL);
    ownerId = await userIdFor(db, OWNER_EMAIL);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  it("enforces connector ownership: non-owner non-admin → 403; owner and admin → 200", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    const path = `/api/connectors/${cfg.id}/suppressed-emails`;

    const denied = await app.request(path, { headers: { Cookie: otherCookie } });
    expect(denied.status).toBe(403);

    const asOwner = await app.request(path, { headers: { Cookie: ownerCookie } });
    expect(asOwner.status).toBe(200);

    const asAdmin = await app.request(path, { headers: { Cookie: adminCookie } });
    expect(asAdmin.status).toBe(200);
  });

  it("groups suppressed counts by reason with all known reasons present", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    await insertSuppressed(db, { connectorConfigId: cfg.id, reason: "bulk", observedAt: "2026-05-01T10:00:00.000Z" });
    await insertSuppressed(db, { connectorConfigId: cfg.id, reason: "bulk", observedAt: "2026-05-01T11:00:00.000Z" });
    await insertSuppressed(db, {
      connectorConfigId: cfg.id,
      reason: "operational",
      observedAt: "2026-05-01T12:00:00.000Z",
    });
    await insertSuppressed(db, {
      connectorConfigId: cfg.id,
      reason: "role_account",
      observedAt: "2026-05-01T13:00:00.000Z",
    });

    const res = await app.request(`/api/connectors/${cfg.id}/suppressed-emails`, { headers: { Cookie: ownerCookie } });
    const body = await res.json();

    expect(body.countsByReason).toMatchObject({
      bulk: 2,
      operational: 1,
      role_account: 1,
      inbound_only: 0,
      missing_counterparty: 0,
    });
    expect(body.total).toBe(4);
  });

  it("paginates recent rows newest-first and flips hasMore on the last page", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    for (let i = 0; i < 3; i++) {
      await insertSuppressed(db, {
        connectorConfigId: cfg.id,
        reason: "bulk",
        observedAt: `2026-05-0${i + 1}T10:00:00.000Z`,
        providerFileId: `pf-${i}`,
      });
    }

    const page1 = await (
      await app.request(`/api/connectors/${cfg.id}/suppressed-emails?limit=2&offset=0`, {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    expect(page1.recent).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.recent[0].observedAt).toBe("2026-05-03T10:00:00.000Z");

    const page2 = await (
      await app.request(`/api/connectors/${cfg.id}/suppressed-emails?limit=2&offset=2`, {
        headers: { Cookie: ownerCookie },
      })
    ).json();
    expect(page2.recent).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });
});

async function insertEmailMessage(
  db: Kysely<DB>,
  opts: {
    connectorConfigId: string;
    id: string;
    threadId: string | null;
    subject: string;
    sentAt: string;
    body: string;
    accessEmails: string[];
    from?: { name: string; email: string };
  },
) {
  await db
    .insertInto("indexed_files")
    .values({
      id: opts.id,
      connector_config_id: opts.connectorConfigId,
      provider_file_id: opts.id,
      provider_message_id: `<${opts.id}@example.com>`,
      thread_id: opts.threadId,
      file_name: `${opts.subject}.eml`,
      file_type: "email_message",
      content_category: "document",
      source: "gmail",
      source_path: `/mail/${opts.id}`,
      provider_url: `https://mail.example/${opts.id}`,
      content: opts.body,
      summary: `${opts.subject} summary`,
      context_note: null,
      access_scope_id: null,
      source_created_at: opts.sentAt,
      source_updated_at: opts.sentAt,
      synced_at: opts.sentAt,
    })
    .execute();

  await db
    .insertInto("email_message_envelopes")
    .values({
      indexed_file_id: opts.id,
      connector_config_id: opts.connectorConfigId,
      provider_file_id: opts.id,
      provider_message_id: `<${opts.id}@example.com>`,
      thread_id: opts.threadId,
      subject: opts.subject,
      sent_at: opts.sentAt,
      from_json: JSON.stringify(opts.from ?? { name: "Jane Doe", email: "jane@example.com" }),
      to_json: JSON.stringify([{ name: "Owner", email: OWNER_EMAIL }]),
      cc_json: JSON.stringify([]),
      owner_email: OWNER_EMAIL,
      provider_url: `https://mail.example/${opts.id}`,
    })
    .execute();

  for (const email of opts.accessEmails) {
    await db.insertInto("file_access").values({ indexed_file_id: opts.id, email }).execute();
  }
}

describe("GET /:id/email-threads (U4)", () => {
  let db: Kysely<DB>;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let ownerCookie: string;
  let otherCookie: string;
  let ownerId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await seedUsers(db);
    app = createApp(db, config, { logger });
    adminCookie = await login(app, ADMIN_EMAIL);
    ownerCookie = await login(app, OWNER_EMAIL);
    otherCookie = await login(app, OTHER_EMAIL);
    ownerId = await userIdFor(db, OWNER_EMAIL);
  });

  afterEach(async () => {
    try {
      await db.destroy();
    } catch {}
  });

  async function seedThread(connectorConfigId: string, accessEmails = [OWNER_EMAIL]) {
    await insertEmailMessage(db, {
      connectorConfigId,
      id: "msg-1",
      threadId: "thread-x",
      subject: "Kickoff",
      sentAt: "2026-05-01T10:00:00.000Z",
      body: "Let's kick off.",
      accessEmails,
    });
    await insertEmailMessage(db, {
      connectorConfigId,
      id: "msg-2",
      threadId: "thread-x",
      subject: "Re: Kickoff",
      sentAt: "2026-05-01T11:00:00.000Z",
      body: "Sounds good.",
      accessEmails,
    });
    await insertEmailMessage(db, {
      connectorConfigId,
      id: "msg-3",
      threadId: "thread-x",
      subject: "Re: Re: Kickoff — final",
      sentAt: "2026-05-01T12:00:00.000Z",
      body: "Tuesday works.",
      accessEmails,
    });
    await insertEmailMessage(db, {
      connectorConfigId,
      id: "solo",
      threadId: null,
      subject: "Standalone note",
      sentAt: "2026-05-01T09:00:00.000Z",
      body: "No thread here.",
      accessEmails,
    });
  }

  it("groups one row per conversation, newest-first, with thread + singleton handling", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    await seedThread(cfg.id);

    const body = await (
      await app.request(`/api/connectors/${cfg.id}/email-threads`, { headers: { Cookie: ownerCookie } })
    ).json();

    expect(body.total).toBe(2);
    expect(body.hasMore).toBe(false);
    expect(body.threads).toHaveLength(2);
    const [first, second] = body.threads;
    expect(first).toMatchObject({
      threadKey: "thread-x",
      messageCount: 3,
      latestSubject: "Re: Re: Kickoff — final",
      latestIndexedFileId: "msg-3",
      lastActivity: "2026-05-01T12:00:00.000Z",
    });
    expect(second).toMatchObject({ threadKey: "solo", messageCount: 1, latestSubject: "Standalone note" });
  });

  it("returns thread detail in sent order and resolves the null-thread singleton", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    await seedThread(cfg.id);

    const thread = await (
      await app.request(`/api/connectors/${cfg.id}/email-threads/thread-x`, { headers: { Cookie: ownerCookie } })
    ).json();
    expect(thread.messages.map((m: { indexedFileId: string }) => m.indexedFileId)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(thread.messages[0].from).toMatchObject({ email: "jane@example.com" });
    expect(thread.messages[0].to[0]).toMatchObject({ email: OWNER_EMAIL });

    const solo = await (
      await app.request(`/api/connectors/${cfg.id}/email-threads/solo`, { headers: { Cookie: ownerCookie } })
    ).json();
    expect(solo.messages).toHaveLength(1);
    expect(solo.messages[0].indexedFileId).toBe("solo");
  });

  it("denies a non-owner non-admin on both list and detail", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    await seedThread(cfg.id);

    const list = await app.request(`/api/connectors/${cfg.id}/email-threads`, { headers: { Cookie: otherCookie } });
    expect(list.status).toBe(403);
    const detail = await app.request(`/api/connectors/${cfg.id}/email-threads/thread-x`, {
      headers: { Cookie: otherCookie },
    });
    expect(detail.status).toBe(403);
  });

  it("lets connector managers list threads but gates bodies on file content visibility", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    await seedThread(cfg.id, [OWNER_EMAIL]);

    const adminList = await app.request(`/api/connectors/${cfg.id}/email-threads`, {
      headers: { Cookie: adminCookie },
    });
    expect(adminList.status).toBe(200);

    const adminDetail = await app.request(`/api/connectors/${cfg.id}/email-threads/thread-x`, {
      headers: { Cookie: adminCookie },
    });
    expect(adminDetail.status).toBe(403);

    const ownerDetail = await app.request(`/api/connectors/${cfg.id}/email-threads/thread-x`, {
      headers: { Cookie: ownerCookie },
    });
    expect(ownerDetail.status).toBe(200);
  });

  it("exposes emailThread metadata on file content for emails only", async () => {
    const cfg = await insertGmailConfig(db, ownerId);
    await seedThread(cfg.id);

    const email = await (
      await app.request("/api/connectors/files/msg-2/content", { headers: { Cookie: ownerCookie } })
    ).json();
    expect(email.file.emailThread).toMatchObject({ connectorId: cfg.id, threadKey: "thread-x" });

    const repo = createConnectorRepository(db);
    const doc = await repo.upsertFile({
      source: "google_drive",
      providerFileId: "doc-1",
      providerUrl: null,
      fileName: "notes.txt",
      fileType: "document",
      contentCategory: "document",
      content: "hello",
      sourcePath: null,
      contentHash: null,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      connectorConfigId: cfg.id,
    });
    await db.insertInto("file_access").values({ indexed_file_id: doc.id, email: OWNER_EMAIL }).execute();
    const docRes = await (
      await app.request(`/api/connectors/files/${doc.id}/content`, { headers: { Cookie: ownerCookie } })
    ).json();
    expect(docRes.file.emailThread).toBeUndefined();
  });
});

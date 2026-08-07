import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../../db/schema";
import { createTestDb } from "../../test-utils";
import { toEmailPrincipals } from "../types";
import { emailToSyncedItem } from "./email-to-synced-item";
import { persistEnvelopeMetadata } from "./envelope-metadata";
import { type NormalizedEmail, normalizeHeaderMap } from "./normalized-email";
import { recordSuppressedEmail, shouldSuppressEmail } from "./suppression";
import { buildEmailThreadContext } from "./thread-context";
import { ensureEmailThreadSummary, rebuildEmailThreadSummary } from "./thread-summary";

const CONNECTOR_ID = "connector-email";
const OTHER_CONNECTOR_ID = "connector-other";
const USER_ID = "user-1";

function emailFixture(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    providerMessageId: "<m-1@example.com>",
    providerFileId: "gmail-1",
    threadId: "thread-1",
    subject: "Pricing discussion",
    sentAt: "2026-05-01T10:00:00.000Z",
    from: { name: "Jane Doe", email: "jane@example.com" },
    to: [{ name: "Owner", email: "owner@canvasx.ai" }],
    cc: [],
    bcc: [],
    headers: normalizeHeaderMap([]),
    bodyHtml: null,
    bodyText: "Can we discuss pricing?\n\nOn Tue, Bob wrote:\nolder quoted text",
    providerUrl: "https://mail.example/m-1",
    ownerEmail: "owner@canvasx.ai",
    folder: "inbox",
    ...overrides,
  };
}

describe("email shared layer", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await seedDb(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("suppresses bulk, operational, role-account, and inbound-only messages while retaining reciprocal mail", async () => {
    const reciprocity = new Set(["jane@example.com"]);

    expect(
      shouldSuppressEmail(
        emailFixture({ headers: normalizeHeaderMap([["List-Unsubscribe", "<mailto:unsubscribe@example.com>"]]) }),
        reciprocity,
      ),
    ).toMatchObject({ suppressed: true, reason: "bulk" });

    expect(shouldSuppressEmail(emailFixture({ subject: "Invoice for May" }), reciprocity)).toMatchObject({
      suppressed: true,
      reason: "operational",
    });

    expect(
      shouldSuppressEmail(emailFixture({ from: { email: "noreply@example.com" }, subject: "Hello" }), reciprocity),
    ).toMatchObject({ suppressed: true, reason: "operational" });

    expect(shouldSuppressEmail(emailFixture({ from: { email: "cold@example.com" } }), reciprocity)).toMatchObject({
      suppressed: true,
      reason: "inbound_only",
    });

    const retained = shouldSuppressEmail(emailFixture(), reciprocity);
    expect(retained.suppressed).toBe(false);
    if (!retained.suppressed) {
      expect(retained.gate.seedableEmails.has("jane@example.com")).toBe(true);
    }

    await recordSuppressedEmail(db, {
      connectorConfigId: CONNECTOR_ID,
      email: emailFixture({ providerFileId: "suppressed-1" }),
      reason: "bulk",
      observedAt: "2026-05-01T11:00:00.000Z",
    });

    const marker = await db.selectFrom("email_suppressed_messages").selectAll().executeTakeFirstOrThrow();
    expect(marker).toMatchObject({
      connector_config_id: CONNECTOR_ID,
      provider_file_id: "suppressed-1",
      reason: "bulk",
      observed_at: "2026-05-01T11:00:00.000Z",
    });
  });

  it("builds synced items with subject/body content, visible ACLs, seedable participants, and no Bcc leakage", () => {
    const decision = shouldSuppressEmail(
      emailFixture({
        to: [
          { name: "Owner", email: "OWNER@canvasx.ai" },
          { name: "Bob Smith", email: "bob@example.com" },
        ],
        cc: [{ email: "jane@example.com" }],
        bcc: [{ name: "Hidden", email: "hidden@example.com" }],
        bodyHtml: "<p>Fallback HTML</p>",
      }),
      new Set(["jane@example.com", "bob@example.com"]),
    );
    expect(decision.suppressed).toBe(false);
    if (decision.suppressed) throw new Error("expected retained email");

    const item = emailToSyncedItem(
      CONNECTOR_ID,
      emailFixture({ bcc: [{ email: "hidden@example.com" }] }),
      decision.gate,
    );

    expect(item.fileType).toBe("email_message");
    expect(item.content).toBe("Pricing discussion\n\nCan we discuss pricing?");
    expect(item.content).not.toContain("From:");
    expect(item.accessPrincipals).toEqual(toEmailPrincipals(["jane@example.com", "owner@canvasx.ai"]));
    expect(item.accessPrincipals).not.toContainEqual({ type: "email", value: "hidden@example.com" });
    expect(item.authorEmail).toBe("jane@example.com");
    expect(item.attendees).toBeUndefined();
    expect(JSON.stringify(item.emailEnvelope)).not.toContain("hidden@example.com");
  });

  it("persists thread envelopes and builds isolated thread context", async () => {
    const first = emailToSyncedItem(CONNECTOR_ID, emailFixture({ providerFileId: "gmail-1" }), {
      seedableEmails: new Set(["jane@example.com"]),
    });
    const second = emailToSyncedItem(
      CONNECTOR_ID,
      emailFixture({
        providerMessageId: "<m-2@example.com>",
        providerFileId: "gmail-2",
        sentAt: "2026-05-01T11:00:00.000Z",
        from: { name: "Owner", email: "owner@canvasx.ai" },
        to: [{ name: "Jane Doe", email: "jane@example.com" }],
        bodyText: "Following up.",
        folder: "sent",
      }),
      { seedableEmails: new Set(["jane@example.com"]) },
    );
    const other = emailToSyncedItem(
      OTHER_CONNECTOR_ID,
      emailFixture({
        providerMessageId: "<m-3@example.com>",
        providerFileId: "gmail-3",
        bodyText: "Other user's same thread.",
      }),
      { seedableEmails: new Set(["jane@example.com"]) },
    );

    await insertFile(db, CONNECTOR_ID, "file-1", first);
    await insertFile(db, CONNECTOR_ID, "file-2", second);
    await insertFile(db, OTHER_CONNECTOR_ID, "file-other", other);
    await persistEnvelopeMetadata(db, "file-1", first.emailEnvelope);
    await persistEnvelopeMetadata(db, "file-2", second.emailEnvelope);
    await persistEnvelopeMetadata(db, "file-other", other.emailEnvelope);

    const context = await buildEmailThreadContext(db, {
      connectorConfigId: CONNECTOR_ID,
      threadId: "thread-1",
      targetFileId: "file-2",
    });

    expect(context.indexOf("Can we discuss pricing?")).toBeLessThan(context.indexOf("Following up."));
    expect(context).toContain("Message (current)");
    expect(context).not.toContain("Other user's same thread");
  });

  it("seeds and rebuilds thread summaries from ordered email context", async () => {
    const prompts: string[] = [];
    const generator = {
      generate: async (prompt: string) => {
        prompts.push(prompt);
        return `summary-${prompts.length}`;
      },
      generateJSON: async () => ({}),
    } as never;

    const first = emailToSyncedItem(CONNECTOR_ID, emailFixture({ providerFileId: "gmail-1" }), {
      seedableEmails: new Set(["jane@example.com"]),
    });
    const second = emailToSyncedItem(
      CONNECTOR_ID,
      emailFixture({
        providerMessageId: "<m-2@example.com>",
        providerFileId: "gmail-2",
        sentAt: "2026-05-01T11:00:00.000Z",
        from: { name: "Owner", email: "owner@canvasx.ai" },
        to: [{ name: "Jane Doe", email: "jane@example.com" }],
        bodyText: "Following up.",
        folder: "sent",
      }),
      { seedableEmails: new Set(["jane@example.com"]) },
    );

    await insertFile(db, CONNECTOR_ID, "file-1", first);
    await insertFile(db, CONNECTOR_ID, "file-2", second);
    await persistEnvelopeMetadata(db, "file-1", first.emailEnvelope);
    await persistEnvelopeMetadata(db, "file-2", second.emailEnvelope);

    await expect(ensureEmailThreadSummary(db, generator, CONNECTOR_ID, "thread-1")).resolves.toBe("summary-1");
    expect(prompts[0].indexOf("Can we discuss pricing?")).toBeLessThan(prompts[0].indexOf("Following up."));

    await db
      .updateTable("indexed_files")
      .set({ summary: "First message summary", summary_status: "done" })
      .where("id", "=", "file-1")
      .execute();
    await db
      .updateTable("indexed_files")
      .set({ summary: "Second message summary", summary_status: "done" })
      .where("id", "=", "file-2")
      .execute();

    const before = await db
      .selectFrom("email_thread_summaries")
      .select("basis_hash")
      .where("connector_config_id", "=", CONNECTOR_ID)
      .where("thread_id", "=", "thread-1")
      .executeTakeFirstOrThrow();

    await expect(rebuildEmailThreadSummary(db, generator, CONNECTOR_ID, "thread-1")).resolves.toBe("rebuilt");
    expect(prompts[1].indexOf("First message summary")).toBeLessThan(prompts[1].indexOf("Second message summary"));

    const after = await db
      .selectFrom("email_thread_summaries")
      .select("basis_hash")
      .where("connector_config_id", "=", CONNECTOR_ID)
      .where("thread_id", "=", "thread-1")
      .executeTakeFirstOrThrow();
    expect(after.basis_hash).not.toBe(before.basis_hash);

    await expect(rebuildEmailThreadSummary(db, generator, CONNECTOR_ID, "thread-1")).resolves.toBe("skipped");
    expect(prompts).toHaveLength(2);
  });
});

async function seedDb(db: Kysely<DB>): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("users")
    .values({
      id: USER_ID,
      name: "Admin",
      email: "owner@canvasx.ai",
      email_verified_at: now,
      password_hash: "hash",
      auth_role: "admin",
    })
    .execute();
  await db
    .insertInto("connector_configs")
    .values([
      {
        id: CONNECTOR_ID,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: USER_ID,
      },
      {
        id: OTHER_CONNECTOR_ID,
        connector_type: "google_drive",
        auth_type: "oauth",
        credentials: "{}",
        created_by: USER_ID,
      },
    ])
    .execute();
}

async function insertFile(
  db: Kysely<DB>,
  connectorConfigId: string,
  id: string,
  item: ReturnType<typeof emailToSyncedItem>,
) {
  await db
    .insertInto("indexed_files")
    .values({
      id,
      connector_config_id: connectorConfigId,
      provider_file_id: item.providerFileId,
      provider_message_id: item.providerMessageId,
      thread_id: item.threadId ?? null,
      provider_url: item.providerUrl,
      file_name: item.fileName,
      file_type: item.fileType,
      content_category: item.contentCategory,
      content: item.content,
      source: "google_drive",
      source_path: item.sourcePath,
      content_hash: item.contentHash,
      source_created_at: item.sourceCreatedAt,
      source_updated_at: item.sourceUpdatedAt,
      synced_at: new Date().toISOString(),
    })
    .execute();
}

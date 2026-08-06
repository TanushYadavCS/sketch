import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createUserRepository } from "./users";

let db: Kysely<DB>;
let users: ReturnType<typeof createUserRepository>;

beforeEach(async () => {
  db = await createTestDb();
  users = createUserRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("create()", () => {
  it("runs a standalone mutation through Kysely transaction()", async () => {
    const transactionSpy = vi.spyOn(db, "transaction");

    await users.create({ name: "Transactional Alice", skipEntityLinking: true });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it("returns user with generated UUID id", async () => {
    const user = await users.create({ name: "Alice", slackUserId: "U001" });
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("returned user has correct name and slack_user_id", async () => {
    const user = await users.create({ name: "Bob", slackUserId: "U002" });
    expect(user.name).toBe("Bob");
    expect(user.slack_user_id).toBe("U002");
  });

  it("created_at is populated automatically", async () => {
    const user = await users.create({ name: "Carol", slackUserId: "U003" });
    expect(user.created_at).toBeDefined();
    expect(typeof user.created_at).toBe("string");
    expect(user.created_at.length).toBeGreaterThan(0);
  });

  it("second create with different slack_user_id succeeds", async () => {
    await users.create({ name: "Dave", slackUserId: "U004" });
    const second = await users.create({ name: "Eve", slackUserId: "U005" });
    expect(second.name).toBe("Eve");
    expect(second.slack_user_id).toBe("U005");
  });

  it("duplicate slack_user_id throws", async () => {
    await users.create({ name: "Frank", slackUserId: "U006" });
    await expect(users.create({ name: "Grace", slackUserId: "U006" })).rejects.toThrow();
  });

  it("creates user with whatsappNumber only (no slackUserId)", async () => {
    const user = await users.create({ name: "Liam", whatsappNumber: "+919876543210" });
    expect(user.name).toBe("Liam");
    expect(user.whatsapp_number).toBe("+919876543210");
    expect(user.slack_user_id).toBeNull();
  });

  it("creates user with both slackUserId and whatsappNumber", async () => {
    const user = await users.create({ name: "Maya", slackUserId: "U100", whatsappNumber: "+14155551234" });
    expect(user.slack_user_id).toBe("U100");
    expect(user.whatsapp_number).toBe("+14155551234");
  });

  it("creates user with email", async () => {
    const user = await users.create({ name: "Alice Email", slackUserId: "U200", email: "alice@example.com" });
    expect(user.email).toBe("alice@example.com");
  });

  it("creates user with null email when not provided", async () => {
    const user = await users.create({ name: "Bob No Email", slackUserId: "U201" });
    expect(user.email).toBeNull();
  });

  it("creates user with email and whatsappNumber", async () => {
    const user = await users.create({
      name: "Charlie Full",
      whatsappNumber: "+14155559999",
      email: "charlie@example.com",
    });
    expect(user.whatsapp_number).toBe("+14155559999");
    expect(user.email).toBe("charlie@example.com");
  });

  it("duplicate whatsapp_number throws", async () => {
    await users.create({ name: "Noah", whatsappNumber: "+14155559999" });
    await expect(users.create({ name: "Olivia", whatsappNumber: "+14155559999" })).rejects.toThrow();
  });
});

describe("findByEmail()", () => {
  it("returns user when found", async () => {
    const created = await users.create({ name: "Zoe", email: "zoe@example.com" });
    const found = await users.findByEmail("zoe@example.com");
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
  });

  it("returns undefined when not found", async () => {
    const found = await users.findByEmail("nobody@example.com");
    expect(found).toBeUndefined();
  });
});

describe("findBySlackId()", () => {
  it("returns the user when found", async () => {
    const created = await users.create({ name: "Hank", slackUserId: "U007" });
    const found = await users.findBySlackId("U007");
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe("Hank");
    expect(found?.slack_user_id).toBe("U007");
  });

  it("returns undefined when not found", async () => {
    const found = await users.findBySlackId("U999");
    expect(found).toBeUndefined();
  });
});

describe("findByWhatsappNumber()", () => {
  it("returns user when found", async () => {
    const created = await users.create({ name: "Kim", whatsappNumber: "+14155238886" });
    const found = await users.findByWhatsappNumber("+14155238886");
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe("Kim");
    expect(found?.whatsapp_number).toBe("+14155238886");
  });

  it("returns undefined when not found", async () => {
    const found = await users.findByWhatsappNumber("+10000000000");
    expect(found).toBeUndefined();
  });
});

describe("findById()", () => {
  it("returns the user when found", async () => {
    const created = await users.create({ name: "Ivy", slackUserId: "U008" });
    const found = await users.findById(created.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe("Ivy");
    expect(found?.slack_user_id).toBe("U008");
  });

  it("returns undefined when not found", async () => {
    const found = await users.findById("nonexistent-id");
    expect(found).toBeUndefined();
  });
});

describe("list()", () => {
  it("returns all users", async () => {
    await users.create({ name: "Alice", slackUserId: "U001" });
    await users.create({ name: "Bob", whatsappNumber: "+919876543210" });
    await users.create({ name: "Carol", slackUserId: "U003" });

    const list = await users.list();
    expect(list).toHaveLength(3);
    const names = list.map((u) => u.name);
    expect(names).toContain("Alice");
    expect(names).toContain("Bob");
    expect(names).toContain("Carol");
  });

  it("returns empty array when no users", async () => {
    const list = await users.list();
    expect(list).toEqual([]);
  });
});

describe("update()", () => {
  it("updates name", async () => {
    const created = await users.create({ name: "Dave", slackUserId: "U010" });
    const updated = await users.update(created.id, { name: "David" });
    expect(updated.name).toBe("David");
    expect(updated.slack_user_id).toBe("U010");
  });

  it("updates whatsapp_number", async () => {
    const created = await users.create({ name: "Eve", slackUserId: "U011" });
    const updated = await users.update(created.id, { whatsappNumber: "+14155551234" });
    expect(updated.whatsapp_number).toBe("+14155551234");
    expect(updated.name).toBe("Eve");
  });

  it("clears whatsapp_number when set to null", async () => {
    const created = await users.create({ name: "Frank", whatsappNumber: "+14155559999" });
    const updated = await users.update(created.id, { whatsappNumber: null });
    expect(updated.whatsapp_number).toBeNull();
  });

  it("throws on duplicate whatsapp_number", async () => {
    await users.create({ name: "Grace", whatsappNumber: "+14155550001" });
    const other = await users.create({ name: "Hank", whatsappNumber: "+14155550002" });
    await expect(users.update(other.id, { whatsappNumber: "+14155550001" })).rejects.toThrow();
  });

  it("updates email", async () => {
    const created = await users.create({ name: "Dave", slackUserId: "U014" });
    const updated = await users.update(created.id, { email: "dave@example.com" });
    expect(updated.email).toBe("dave@example.com");
    expect(updated.name).toBe("Dave");
  });

  it("clears email when set to null", async () => {
    const created = await users.create({ name: "Eve", slackUserId: "U015" });
    await users.update(created.id, { email: "eve@example.com" });
    const updated = await users.update(created.id, { email: null });
    expect(updated.email).toBeNull();
  });

  it("updates email and name together", async () => {
    const created = await users.create({ name: "Frank", slackUserId: "U016" });
    const updated = await users.update(created.id, { name: "Franklin", email: "frank@example.com" });
    expect(updated.name).toBe("Franklin");
    expect(updated.email).toBe("frank@example.com");
  });

  it("updates slack_user_id", async () => {
    const created = await users.create({ name: "Wendy", email: "wendy@example.com" });
    expect(created.slack_user_id).toBeNull();
    const updated = await users.update(created.id, { slackUserId: "U999" });
    expect(updated.slack_user_id).toBe("U999");
  });

  it("returns unchanged user when no fields provided", async () => {
    const created = await users.create({ name: "Ivy", slackUserId: "U012" });
    const updated = await users.update(created.id, {});
    expect(updated.name).toBe("Ivy");
    expect(updated.slack_user_id).toBe("U012");
  });

  it("updates tool_progress and reasoning_text", async () => {
    const created = await users.create({ name: "Jules", slackUserId: "U017" });
    const updated = await users.update(created.id, { toolProgress: "technical", reasoningText: true });
    expect(updated.tool_progress).toBe("technical");
    expect(updated.reasoning_text).toBe(1);
  });
});

describe("getAllEmailsForUser()", () => {
  it("returns only users.email when no provider identities exist", async () => {
    const user = await users.create({ name: "Solo", email: "solo@example.com" });
    const emails = await users.getAllEmailsForUser(user.id);
    expect(emails).toEqual(["solo@example.com"]);
  });

  it("returns empty array when user has no email and no provider identities", async () => {
    const user = await users.create({ name: "NoEmail", slackUserId: "U300" });
    const emails = await users.getAllEmailsForUser(user.id);
    expect(emails).toEqual([]);
  });

  it("returns user email plus provider emails", async () => {
    const user = await users.create({ name: "Multi", email: "multi@example.com" });
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "pi-1",
        user_id: user.id,
        provider: "google",
        provider_user_id: "g-123",
        provider_email: "multi.google@example.com",
      })
      .execute();
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "pi-2",
        user_id: user.id,
        provider: "fireflies",
        provider_user_id: "f-123",
        provider_email: "multi.fireflies@example.com",
      })
      .execute();

    const emails = await users.getAllEmailsForUser(user.id);
    expect(emails).toEqual(
      expect.arrayContaining(["multi@example.com", "multi.google@example.com", "multi.fireflies@example.com"]),
    );
    expect(emails).toHaveLength(3);
  });

  it("deduplicates when a provider email matches users.email", async () => {
    const user = await users.create({ name: "Dup", email: "dup@example.com" });
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "pi-3",
        user_id: user.id,
        provider: "google",
        provider_user_id: "g-456",
        provider_email: "dup@example.com",
      })
      .execute();

    const emails = await users.getAllEmailsForUser(user.id);
    expect(emails).toEqual(["dup@example.com"]);
  });

  it("ignores provider identities with null provider_email", async () => {
    const user = await users.create({ name: "NullProv", email: "np@example.com" });
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "pi-4",
        user_id: user.id,
        provider: "slack",
        provider_user_id: "U-nullable",
        provider_email: null,
      })
      .execute();

    const emails = await users.getAllEmailsForUser(user.id);
    expect(emails).toEqual(["np@example.com"]);
  });

  it("returns empty array for unknown user id", async () => {
    const emails = await users.getAllEmailsForUser("nope");
    expect(emails).toEqual([]);
  });
});

describe("getVerifiedEmailsForUser()", () => {
  it("excludes unverified users.email", async () => {
    const user = await users.create({ name: "Unverified", email: "unverified@example.com" });
    const emails = await users.getVerifiedEmailsForUser(user.id);
    expect(emails).toEqual([]);
  });

  it("includes verified users.email and provider emails", async () => {
    const user = await users.create({
      name: "Verified",
      email: "verified@example.com",
      emailVerified: true,
    });
    await db
      .insertInto("user_provider_identities")
      .values({
        id: "verified-pi-1",
        user_id: user.id,
        provider: "google",
        provider_user_id: "google-verified",
        provider_email: "verified.google@example.com",
      })
      .execute();

    const emails = await users.getVerifiedEmailsForUser(user.id);
    expect(emails).toEqual(expect.arrayContaining(["verified@example.com", "verified.google@example.com"]));
    expect(emails).toHaveLength(2);
  });
});

describe("remove()", () => {
  it("deletes user", async () => {
    const created = await users.create({ name: "Jack", slackUserId: "U013" });
    await users.remove(created.id);
    const found = await users.findById(created.id);
    expect(found).toBeUndefined();
  });

  it("preserves created tasks when deleting a user", async () => {
    const created = await users.create({ name: "Task Creator", slackUserId: "U014" });
    await db
      .insertInto("tasks")
      .values({
        id: "task-created-by-user",
        parent_entity_id: null,
        parent_source_ref: null,
        parent_name: null,
        source: "summary",
        external_ref: null,
        title: "Follow up from summarizer",
        normalized_title: "follow up from summarizer",
        status: "open",
        status_raw: "Open",
        status_authority: "local",
        assignee_entity_id: null,
        assignee_name: null,
        proposed_assignee_name: null,
        priority: null,
        due_at: null,
        provenance: "summary",
        source_task_id: "summary-task-created-by-user",
        created_by_user_id: created.id,
        status_changed_at: null,
        completed_at: null,
        valid_from: null,
        valid_to: null,
        milestone_series_key: null,
      })
      .execute();

    await users.remove(created.id);

    const task = await db.selectFrom("tasks").selectAll().where("id", "=", "task-created-by-user").executeTakeFirst();
    const found = await users.findById(created.id);
    expect(found).toBeUndefined();
    expect(task).toMatchObject({ title: "Follow up from summarizer", created_by_user_id: null });
  });

  it("does not throw on non-existent id", async () => {
    await expect(users.remove("nonexistent-id")).resolves.not.toThrow();
  });
});

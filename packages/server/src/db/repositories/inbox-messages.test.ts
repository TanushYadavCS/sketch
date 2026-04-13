import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createUserRepository } from "./users";
import { createInboxMessagesRepository } from "./inbox-messages";

let db: Kysely<DB>;
let repo: ReturnType<typeof createInboxMessagesRepository>;
let senderUserId: string;
let recipientUserId: string;

beforeEach(async () => {
  db = await createTestDb();
  repo = createInboxMessagesRepository(db);

  const userRepo = createUserRepository(db);
  const sender = await userRepo.create({ name: "Alice" });
  const recipient = await userRepo.create({ name: "Bob" });
  senderUserId = sender.id;
  recipientUserId = recipient.id;
});

afterEach(async () => {
  await db.destroy();
});

describe("create()", () => {
  it("creates an inbox row with sender, recipient, message, platform, channel id, and message ref", async () => {
    const row = await repo.create({
      senderUserId,
      recipientUserId,
      message: "Please send me the latest update.",
      platform: "slack",
      channelId: "D123",
      messageRef: "1111.0001",
    });

    expect(row.sender_user_id).toBe(senderUserId);
    expect(row.recipient_user_id).toBe(recipientUserId);
    expect(row.message).toBe("Please send me the latest update.");
    expect(row.platform).toBe("slack");
    expect(row.channel_id).toBe("D123");
    expect(row.message_ref).toBe("1111.0001");
    expect(row.created_at).toBeDefined();
    expect(row.consumed_at).toBeNull();
  });
});

describe("listPendingForRecipient()", () => {
  it("lists only pending inbox rows for the requested recipient", async () => {
    const userRepo = createUserRepository(db);
    const otherRecipient = await userRepo.create({ name: "Charlie" });
    const first = await repo.create({
      senderUserId,
      recipientUserId,
      message: "First",
      platform: "slack",
    });
    const second = await repo.create({
      senderUserId,
      recipientUserId,
      message: "Second",
      platform: "slack",
    });
    await repo.create({
      senderUserId,
      recipientUserId: otherRecipient.id,
      message: "Other recipient",
      platform: "slack",
    });

    await db.updateTable("inbox_messages").set({ created_at: "2026-04-10T08:00:00.000Z" }).where("id", "=", first.id).execute();
    await db.updateTable("inbox_messages").set({ created_at: "2026-04-10T09:00:00.000Z" }).where("id", "=", second.id).execute();

    const rows = await repo.listPendingForRecipient(recipientUserId);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("excludes rows with consumed_at set", async () => {
    const pending = await repo.create({
      senderUserId,
      recipientUserId,
      message: "Pending",
      platform: "slack",
    });
    const consumed = await repo.create({
      senderUserId,
      recipientUserId,
      message: "Consumed",
      platform: "slack",
    });
    await db
      .updateTable("inbox_messages")
      .set({ consumed_at: "2026-04-10T10:00:00.000Z" })
      .where("id", "=", consumed.id)
      .execute();

    const rows = await repo.listPendingForRecipient(recipientUserId);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pending.id);
  });
});

describe("markConsumed()", () => {
  it("marks a provided set of inbox ids consumed and leaves others untouched", async () => {
    const first = await repo.create({
      senderUserId,
      recipientUserId,
      message: "First",
      platform: "slack",
    });
    const second = await repo.create({
      senderUserId,
      recipientUserId,
      message: "Second",
      platform: "slack",
    });

    await repo.markConsumed([first.id], "2026-04-10T11:00:00.000Z");

    const rows = await db.selectFrom("inbox_messages").selectAll().orderBy("created_at", "asc").execute();
    const updatedFirst = rows.find((row) => row.id === first.id);
    const untouchedSecond = rows.find((row) => row.id === second.id);

    expect(updatedFirst?.consumed_at).toBe("2026-04-10T11:00:00.000Z");
    expect(untouchedSecond?.consumed_at).toBeNull();
  });
});

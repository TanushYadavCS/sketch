import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createUserRepository } from "./users";
import { createWhatsAppWindowKeepAliveRepository } from "./whatsapp-window-keepalives";

let db: Kysely<DB>;
let repo: ReturnType<typeof createWhatsAppWindowKeepAliveRepository>;
let userId: string;

beforeEach(async () => {
  db = await createTestDb();
  repo = createWhatsAppWindowKeepAliveRepository(db);
  const users = createUserRepository(db);
  const user = await users.create({ name: "Priya", whatsappNumber: "+15551234567" });
  userId = user.id;
});

afterEach(async () => {
  await db.destroy();
});

describe("createWhatsAppWindowKeepAliveRepository", () => {
  it("returns undefined when no keep-alive has been recorded", async () => {
    await expect(repo.get(userId)).resolves.toBeUndefined();
  });

  it("records a first keep-alive attempt for a recipient", async () => {
    const row = await repo.recordAttempt(userId, "2026-07-04T10:00:00.000Z");

    expect(row.recipient_user_id).toBe(userId);
    expect(row.sent_at).toBe("2026-07-04T10:00:00.000Z");
    expect(row.created_at).toBeDefined();
    expect(row.updated_at).toBeDefined();
  });

  it("updates the existing row on later attempts", async () => {
    await repo.recordAttempt(userId, "2026-07-04T10:00:00.000Z");

    const updated = await repo.recordAttempt(userId, "2026-07-04T11:00:00.000Z");
    const rows = await db.selectFrom("whatsapp_window_keepalives").selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(updated.sent_at).toBe("2026-07-04T11:00:00.000Z");
  });
});

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import { createUserWhatsAppLidRepository } from "../repositories/user-whatsapp-lids";
import type { DB } from "../schema";
import * as migration from "./169-whatsapp-identity-observations";

describe("169 WhatsApp identity observations on Postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  }, 30_000);

  afterEach(async () => {
    await db.destroy();
  });

  it("round-trips legacy data and keeps alias attachment idempotent and globally unique", async () => {
    await db
      .insertInto("users")
      .values({ id: "pg-u1", name: "One", whatsapp_number: "+14155550100", whatsapp_lid: "one@lid" })
      .execute();
    await db.insertInto("users").values({ id: "pg-u2", name: "Two", whatsapp_number: "+14155550200" }).execute();
    await db.insertInto("whatsapp_groups").values({ jid: "pg-migration@g.us", name: "Migration" }).execute();
    await db
      .insertInto("whatsapp_group_participants")
      .values([
        {
          id: "pg-old",
          group_jid: "pg-migration@g.us",
          observation_key: "phone:+14155550100|lid:old@lid",
          participant_jid: "same@lid",
          lid: "old@lid",
          last_seen_at: "2026-08-10T01:00:00Z",
        },
        {
          id: "pg-new",
          group_jid: "pg-migration@g.us",
          observation_key: "phone:+14155550100|lid:new@lid",
          participant_jid: "same@lid",
          lid: "new@lid",
          last_seen_at: "2026-08-10T02:00:00Z",
        },
      ])
      .execute();

    await migration.down(db as unknown as Kysely<unknown>);
    await db
      .insertInto("whatsapp_group_participants")
      .values({ group_jid: "pg-migration@g.us", participant_jid: "duplicate@lid", lid: "new@lid" })
      .execute();
    await migration.up(db as unknown as Kysely<unknown>);

    await expect(db.selectFrom("whatsapp_group_participants").selectAll().execute()).resolves.toHaveLength(1);
    await expect(
      db.selectFrom("user_whatsapp_lids").select("lid").where("user_id", "=", "pg-u1").execute(),
    ).resolves.toEqual([{ lid: "one@lid" }]);
    const aliases = createUserWhatsAppLidRepository(db);
    await expect(
      aliases.attachIfPhoneUnchanged("pg-u1", "+14155550100", "new-alias@lid", "2026-08-10T03:00:00Z"),
    ).resolves.toBe("attached");
    await expect(
      aliases.attachIfPhoneUnchanged("pg-u1", "+14155550100", "new-alias@lid", "2026-08-10T04:00:00Z"),
    ).resolves.toBe("already-owned");
    await expect(
      aliases.attachIfPhoneUnchanged("pg-u2", "+14155550200", "new-alias@lid", "2026-08-10T05:00:00Z"),
    ).resolves.toBe("ownership-conflict");
    await expect(
      db.selectFrom("users").select("whatsapp_lid").where("id", "=", "pg-u2").executeTakeFirst(),
    ).resolves.toEqual({ whatsapp_lid: null });
    await aliases.attachIfPhoneUnchanged("pg-u1", "+14155550100", "older@lid", "2026-08-10T02:00:00Z");
    await aliases.attachIfPhoneUnchanged("pg-u1", "+14155550100", "new-alias@lid", "2026-08-10T01:00:00Z");
    await aliases.markAttempt("pg-u1", "+14155550100", "2026-08-10T06:00:00Z", true);
    await aliases.markAttempt("pg-u1", "+14155550100", "2026-08-10T01:00:00Z", true);
    await expect(
      db
        .selectFrom("users")
        .select(["whatsapp_lid", "whatsapp_lid_attempted_at", "whatsapp_lid_checked_at"])
        .where("id", "=", "pg-u1")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      whatsapp_lid: "new-alias@lid",
      whatsapp_lid_attempted_at: "2026-08-10T06:00:00Z",
      whatsapp_lid_checked_at: "2026-08-10T06:00:00Z",
    });
  }, 30_000);
});

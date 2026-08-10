import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import * as migration from "./169-whatsapp-identity-observations";

describe("169 WhatsApp identity observations on SQLite", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("rolls back deterministically, backfills aliases, and deduplicates legacy observation shapes", async () => {
    await db.insertInto("users").values({ id: "u1", name: "One", whatsapp_lid: "one@lid" }).execute();
    await db.insertInto("whatsapp_groups").values({ jid: "migration@g.us", name: "Migration" }).execute();
    await db
      .insertInto("whatsapp_group_participants")
      .values([
        {
          id: "old",
          group_jid: "migration@g.us",
          observation_key: "phone:+14155550100|lid:old@lid",
          participant_jid: "same@lid",
          phone_e164: "+14155550100",
          lid: "old@lid",
          last_seen_at: "2026-08-10T01:00:00Z",
        },
        {
          id: "new",
          group_jid: "migration@g.us",
          observation_key: "phone:+14155550100|lid:new@lid",
          participant_jid: "same@lid",
          phone_e164: "+14155550100",
          lid: "new@lid",
          last_seen_at: "2026-08-10T02:00:00Z",
        },
      ])
      .execute();

    await migration.down(db as unknown as Kysely<unknown>);
    await expect(
      db.selectFrom("whatsapp_group_participants").select(["participant_jid", "lid"]).execute(),
    ).resolves.toEqual([{ participant_jid: "same@lid", lid: "new@lid" }]);
    await db
      .insertInto("whatsapp_group_participants")
      .values({
        group_jid: "migration@g.us",
        participant_jid: "duplicate-provider@lid",
        phone_e164: "+14155550100",
        lid: "new@lid",
      })
      .execute();

    await migration.up(db as unknown as Kysely<unknown>);
    await expect(db.selectFrom("user_whatsapp_lids").select(["user_id", "lid"]).execute()).resolves.toEqual([
      { user_id: "u1", lid: "one@lid" },
    ]);
    const observations = await db.selectFrom("whatsapp_group_participants").selectAll().execute();
    expect(observations).toHaveLength(1);
    await expect(
      db
        .insertInto("whatsapp_group_participants")
        .values({
          id: "conflict",
          group_jid: "migration@g.us",
          observation_key: observations[0].observation_key,
          participant_jid: "another@lid",
        })
        .execute(),
    ).rejects.toThrow();
  });
});

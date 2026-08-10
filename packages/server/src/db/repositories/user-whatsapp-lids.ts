import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, UserWhatsAppLidsTable, UsersTable } from "../schema";

export type UserWhatsAppLidRow = Selectable<UserWhatsAppLidsTable>;
export type WhatsAppLidRefreshUser = Pick<
  Selectable<UsersTable>,
  "id" | "whatsapp_number" | "whatsapp_lid_attempted_at" | "whatsapp_lid_checked_at"
>;

export type AttachWhatsAppLidResult = "attached" | "already-owned" | "ownership-conflict" | "stale-phone";

export async function getWhatsAppLidsForUser(db: Kysely<DB>, userId: string): Promise<string[]> {
  return (await createUserWhatsAppLidRepository(db).listForUser(userId)).map((row) => row.lid);
}

class WhatsAppLidOwnershipConflict extends Error {}

export function createUserWhatsAppLidRepository(db: Kysely<DB>) {
  return {
    listForUser(userId: string): Promise<UserWhatsAppLidRow[]> {
      return db
        .selectFrom("user_whatsapp_lids")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("first_seen_at", "asc")
        .orderBy("lid", "asc")
        .execute();
    },

    findUserIdByLid(lid: string): Promise<{ user_id: string } | undefined> {
      return db
        .selectFrom("user_whatsapp_lids")
        .select("user_id")
        .where("lid", "=", lid.trim().toLowerCase())
        .executeTakeFirst();
    },

    async attachIfPhoneUnchanged(
      userId: string,
      phoneE164: string,
      lid: string,
      observedAt: string,
    ): Promise<AttachWhatsAppLidResult> {
      const normalizedLid = lid.trim().toLowerCase();
      try {
        return await db.transaction().execute(async (trx) => {
          const guarded = await trx
            .updateTable("users")
            .set({ whatsapp_lid_attempted_at: sql`whatsapp_lid_attempted_at` })
            .where("id", "=", userId)
            .where("whatsapp_number", "=", phoneE164)
            .executeTakeFirst();
          if (Number(guarded.numUpdatedRows) === 0) return "stale-phone";
          const previousOwner = await trx
            .selectFrom("user_whatsapp_lids")
            .select("user_id")
            .where("lid", "=", normalizedLid)
            .executeTakeFirst();
          await trx
            .insertInto("user_whatsapp_lids")
            .values({ user_id: userId, lid: normalizedLid, first_seen_at: observedAt, last_seen_at: observedAt })
            .onConflict((oc) =>
              oc.column("lid").doUpdateSet({
                last_seen_at: sql`CASE
                  WHEN excluded.last_seen_at >= user_whatsapp_lids.last_seen_at THEN excluded.last_seen_at
                  ELSE user_whatsapp_lids.last_seen_at
                END`,
              }),
            )
            .execute();
          const owner = await trx
            .selectFrom("user_whatsapp_lids")
            .select("user_id")
            .where("lid", "=", normalizedLid)
            .executeTakeFirstOrThrow();
          if (owner.user_id !== userId) throw new WhatsAppLidOwnershipConflict();
          await trx
            .updateTable("users")
            .set({
              whatsapp_lid: sql`CASE
                WHEN ${observedAt} >= (
                  SELECT MAX(last_seen_at) FROM user_whatsapp_lids WHERE user_id = ${userId}
                ) THEN ${normalizedLid}
                ELSE whatsapp_lid
              END`,
            })
            .where("id", "=", userId)
            .execute();
          return previousOwner ? "already-owned" : "attached";
        });
      } catch (error) {
        if (error instanceof WhatsAppLidOwnershipConflict) return "ownership-conflict";
        throw error;
      }
    },

    async markAttempt(
      userId: string,
      phoneE164: string,
      attemptedAt: string,
      providerCurrent: boolean,
    ): Promise<boolean> {
      const result = await db
        .updateTable("users")
        .set({
          whatsapp_lid_attempted_at: sql`CASE
            WHEN whatsapp_lid_attempted_at IS NULL OR ${attemptedAt} >= whatsapp_lid_attempted_at THEN ${attemptedAt}
            ELSE whatsapp_lid_attempted_at
          END`,
          ...(providerCurrent
            ? {
                whatsapp_lid_checked_at: sql`CASE
                  WHEN whatsapp_lid_checked_at IS NULL OR ${attemptedAt} >= whatsapp_lid_checked_at THEN ${attemptedAt}
                  ELSE whatsapp_lid_checked_at
                END`,
              }
            : {}),
        })
        .where("id", "=", userId)
        .where("whatsapp_number", "=", phoneE164)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    listDue(attemptedBefore: string, limit: number): Promise<WhatsAppLidRefreshUser[]> {
      return db
        .selectFrom("users")
        .select(["id", "whatsapp_number", "whatsapp_lid_attempted_at", "whatsapp_lid_checked_at"])
        .where("whatsapp_number", "is not", null)
        .where((eb) =>
          eb.or([eb("whatsapp_lid_attempted_at", "is", null), eb("whatsapp_lid_attempted_at", "<=", attemptedBefore)]),
        )
        .orderBy(sql`CASE WHEN whatsapp_lid_checked_at IS NULL THEN 0 ELSE 1 END`, "asc")
        .orderBy("whatsapp_lid_checked_at", "asc")
        .orderBy(sql`CASE WHEN whatsapp_lid_attempted_at IS NULL THEN 0 ELSE 1 END`, "asc")
        .orderBy("whatsapp_lid_attempted_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .execute();
    },
  };
}

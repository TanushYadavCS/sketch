/**
 * Repository for manual entity shares — `entity_share_emails` rows and the
 * `entities.share_with_everyone` flag.
 *
 * Read-time propagation only: granting a share grants visibility into the
 * entity AND into every file that mentions it, without writing any rows to
 * `file_access` / `access_scope_members`. Un-sharing is instantaneous because
 * there's no derived state to invalidate.
 */
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export interface EntityShareRow {
  email: string;
  granted_by_user_id: string;
  granted_at: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createEntitySharesRepository(db: Kysely<DB>) {
  return {
    /** List manual grants for an entity, newest first. */
    async listForEntity(entityId: string): Promise<EntityShareRow[]> {
      return db
        .selectFrom("entity_share_emails")
        .select(["email", "granted_by_user_id", "granted_at"])
        .where("entity_id", "=", entityId)
        .orderBy("granted_at", "desc")
        .execute();
    },

    /** Idempotent grant. */
    async grantToEmail(entityId: string, email: string, grantedByUserId: string): Promise<void> {
      await db
        .insertInto("entity_share_emails")
        .values({
          entity_id: entityId,
          email: normalizeEmail(email),
          granted_by_user_id: grantedByUserId,
        })
        .onConflict((oc) => oc.columns(["entity_id", "email"]).doNothing())
        .execute();
    },

    async revokeFromEmail(entityId: string, email: string): Promise<void> {
      await db
        .deleteFrom("entity_share_emails")
        .where("entity_id", "=", entityId)
        .where("email", "=", normalizeEmail(email))
        .execute();
    },

    async setOrgWide(entityId: string, value: boolean): Promise<void> {
      await db
        .updateTable("entities")
        .set({ share_with_everyone: value ? 1 : 0 })
        .where("id", "=", entityId)
        .execute();
    },

    async getOrgWide(entityId: string): Promise<boolean> {
      const row = await db
        .selectFrom("entities")
        .select(["share_with_everyone"])
        .where("id", "=", entityId)
        .executeTakeFirst();
      return row?.share_with_everyone === 1;
    },
  };
}

export type EntitySharesRepository = ReturnType<typeof createEntitySharesRepository>;

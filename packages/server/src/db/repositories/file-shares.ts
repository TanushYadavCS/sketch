/**
 * Repository for manual file shares — `file_share_emails` rows and the
 * `indexed_files.share_with_everyone` flag.
 *
 * Independent of `file_access` and `access_scope_members`: connector reconcile
 * never touches these tables, so manual grants survive resyncs.
 */
import type { Kysely } from "kysely";
import type { DB } from "../schema";

export interface FileShareRow {
  email: string;
  granted_by_user_id: string;
  granted_at: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createFileSharesRepository(db: Kysely<DB>) {
  return {
    /** List manual grants for a file, newest first. */
    async listForFile(fileId: string): Promise<FileShareRow[]> {
      return db
        .selectFrom("file_share_emails")
        .select(["email", "granted_by_user_id", "granted_at"])
        .where("indexed_file_id", "=", fileId)
        .orderBy("granted_at", "desc")
        .execute();
    },

    /** Idempotent grant — re-granting does not bump granted_at. */
    async grantToEmail(fileId: string, email: string, grantedByUserId: string): Promise<void> {
      await db
        .insertInto("file_share_emails")
        .values({
          indexed_file_id: fileId,
          email: normalizeEmail(email),
          granted_by_user_id: grantedByUserId,
        })
        .onConflict((oc) => oc.columns(["indexed_file_id", "email"]).doNothing())
        .execute();
    },

    async revokeFromEmail(fileId: string, email: string): Promise<void> {
      await db
        .deleteFrom("file_share_emails")
        .where("indexed_file_id", "=", fileId)
        .where("email", "=", normalizeEmail(email))
        .execute();
    },

    async setOrgWide(fileId: string, value: boolean): Promise<void> {
      await db
        .updateTable("indexed_files")
        .set({ share_with_everyone: value ? 1 : 0 })
        .where("id", "=", fileId)
        .execute();
    },

    async getOrgWide(fileId: string): Promise<boolean> {
      const row = await db
        .selectFrom("indexed_files")
        .select(["share_with_everyone"])
        .where("id", "=", fileId)
        .executeTakeFirst();
      return row?.share_with_everyone === 1;
    },
  };
}

export type FileSharesRepository = ReturnType<typeof createFileSharesRepository>;

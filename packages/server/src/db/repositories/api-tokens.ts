import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { ApiTokensTable, DB } from "../schema";

export type ApiTokenRow = Selectable<ApiTokensTable>;

const TOUCH_THROTTLE_MS = 60_000;

function parseDbTime(value: string | null): number {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function createApiTokenRepository(db: Kysely<DB>) {
  return {
    async create(input: { userId: string; name: string; tokenHash: string; prefix: string }): Promise<ApiTokenRow> {
      const id = randomUUID();
      await db
        .insertInto("api_tokens")
        .values({
          id,
          user_id: input.userId,
          name: input.name,
          token_hash: input.tokenHash,
          prefix: input.prefix,
        })
        .execute();
      return db.selectFrom("api_tokens").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    },

    async listForUser(userId: string): Promise<ApiTokenRow[]> {
      return db
        .selectFrom("api_tokens")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .execute();
    },

    async findByHash(tokenHash: string, now = new Date()): Promise<ApiTokenRow | undefined> {
      return db
        .selectFrom("api_tokens")
        .selectAll()
        .where("token_hash", "=", tokenHash)
        .where("revoked_at", "is", null)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now.toISOString())]))
        .executeTakeFirst();
    },

    async revoke(userId: string, tokenId: string): Promise<boolean> {
      const result = await db
        .updateTable("api_tokens")
        .set({ revoked_at: new Date().toISOString() })
        .where("id", "=", tokenId)
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async touchLastUsed(tokenId: string, now = new Date()): Promise<boolean> {
      const row = await db
        .selectFrom("api_tokens")
        .select(["last_used_at"])
        .where("id", "=", tokenId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (!row) return false;
      if (now.getTime() - parseDbTime(row.last_used_at) < TOUCH_THROTTLE_MS) return false;

      await db
        .updateTable("api_tokens")
        .set({ last_used_at: now.toISOString() })
        .where("id", "=", tokenId)
        .where("revoked_at", "is", null)
        .execute();
      return true;
    },

    async countByHash(tokenHash: string): Promise<number> {
      const row = await db
        .selectFrom("api_tokens")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("token_hash", "=", tokenHash)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
  };
}

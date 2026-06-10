import type { Kysely, Selectable } from "kysely";
import type { DB, OAuthAuthorizationCodesTable } from "../schema";

export type OAuthAuthorizationCodeRow = Selectable<OAuthAuthorizationCodesTable>;

export function createOAuthAuthorizationCodeRepository(db: Kysely<DB>) {
  return {
    async create(input: {
      codeHash: string;
      clientId: string;
      userId: string;
      redirectUri: string;
      codeChallenge: string;
      scopes: string[];
      resource: string | null;
      expiresAt: string;
    }): Promise<OAuthAuthorizationCodeRow> {
      await db
        .insertInto("oauth_authorization_codes")
        .values({
          code_hash: input.codeHash,
          client_id: input.clientId,
          user_id: input.userId,
          redirect_uri: input.redirectUri,
          code_challenge: input.codeChallenge,
          scopes: JSON.stringify(input.scopes),
          resource: input.resource,
          expires_at: input.expiresAt,
        })
        .execute();

      return db
        .selectFrom("oauth_authorization_codes")
        .selectAll()
        .where("code_hash", "=", input.codeHash)
        .executeTakeFirstOrThrow();
    },

    async consumeValid(codeHash: string, now = new Date()): Promise<OAuthAuthorizationCodeRow | null> {
      const row =
        (await db
          .selectFrom("oauth_authorization_codes")
          .selectAll()
          .where("code_hash", "=", codeHash)
          .where("consumed_at", "is", null)
          .where("expires_at", ">", now.toISOString())
          .executeTakeFirst()) ?? null;
      if (!row) return null;

      const result = await db
        .updateTable("oauth_authorization_codes")
        .set({ consumed_at: now.toISOString() })
        .where("code_hash", "=", codeHash)
        .where("consumed_at", "is", null)
        .executeTakeFirst();

      return Number(result.numUpdatedRows) > 0 ? row : null;
    },
  };
}

export function parseAuthorizationCodeScopes(row: OAuthAuthorizationCodeRow): string[] {
  return JSON.parse(row.scopes) as string[];
}

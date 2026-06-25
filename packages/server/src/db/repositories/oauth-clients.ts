import type { Kysely, Selectable } from "kysely";
import type { DB, OAuthClientsTable } from "../schema";

export type OAuthClientRow = Selectable<OAuthClientsTable>;

export function createOAuthClientRepository(db: Kysely<DB>) {
  return {
    async create(input: {
      clientId: string;
      clientSecretHash: string | null;
      clientName: string | null;
      redirectUris: string[];
      grantTypes: string[];
      scopes: string[];
      tokenEndpointAuthMethod: string;
    }): Promise<OAuthClientRow> {
      await db
        .insertInto("oauth_clients")
        .values({
          client_id: input.clientId,
          client_secret_hash: input.clientSecretHash,
          client_name: input.clientName,
          redirect_uris: JSON.stringify(input.redirectUris),
          grant_types: JSON.stringify(input.grantTypes),
          scopes: JSON.stringify(input.scopes),
          token_endpoint_auth_method: input.tokenEndpointAuthMethod,
        })
        .execute();

      return db
        .selectFrom("oauth_clients")
        .selectAll()
        .where("client_id", "=", input.clientId)
        .executeTakeFirstOrThrow();
    },

    async findByClientId(clientId: string): Promise<OAuthClientRow | null> {
      return (
        (await db.selectFrom("oauth_clients").selectAll().where("client_id", "=", clientId).executeTakeFirst()) ?? null
      );
    },
  };
}

export function parseOAuthClientJson(row: OAuthClientRow): {
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
} {
  return {
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    grantTypes: JSON.parse(row.grant_types) as string[],
    scopes: JSON.parse(row.scopes) as string[],
  };
}
